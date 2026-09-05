// Ticks on a timer, checks the in-game date, and triggers a quarterly
// `runCycle` when the season has advanced. See `season.ts` for the
// bounded-retry decision (`shouldTriggerCycle`) and `cycle.ts` for what a
// cycle actually does.
//
// Uses a chained `setTimeout` (never `setInterval`): the next tick is
// scheduled immediately when a tick starts, independent of how long that
// tick's own async work (including a cycle) takes. A cycle can therefore
// outlast the poll interval without delaying the timer chain -- ticks that
// arrive while a cycle is already running are simply no-ops, guarded by
// `cycleRunning`, so cycles themselves never stack/overlap. The timer is
// `.unref()`'d so it never keeps the process (or a test) alive on its own.
//
// The private `cycleRunning` field is a concurrency guard, distinct from the
// public `status.cycleRunning` reported by `getStatus()`/`onChange()` (which
// only reflects whether `runCycle()` itself is actively in flight -- see
// `runCycleAndTrack()`). The guard is claimed SYNCHRONOUSLY -- in the same
// turn of the event loop as the check that precedes it, before any `await`
// -- by both entry points that can start work (`tick()` and `triggerNow()`).
// This is deliberate: checking the flag and then only setting it to `true`
// after an `await` (e.g. after the date-probe round-trip) leaves a window
// where two calls issued close together both observe `false` and both
// proceed concurrently. Since JS is single-threaded, a synchronous
// check-and-set with no `await` in between is atomic -- a second caller
// arriving at any point after the first's synchronous prefix has run will
// see the flag already `true`. Both call sites reset the guard in a
// `finally`, once their whole operation (date fetch + trigger decision +
// `runCycle` if applicable) completes, regardless of success or failure.

import type { CompanionConfig } from './config.js';
import { runCycle, type CycleDeps } from './cycle.js';
import type { Cycle } from './history.js';
import { DATE_PROBE_LUA, parseDateProbe, shouldTriggerCycle, type GameDate } from './season.js';

/** Dependencies a `Poller` needs -- identical in shape to `CycleDeps`, since
 * everything `runCycle` needs is exactly what the poller already has to
 * thread through to it. */
export type PollerDeps = CycleDeps;

export interface PollerStatus {
  connected: boolean;
  fortressLoaded: boolean;
  date?: GameDate;
  lastCycleId?: string;
  cycleRunning: boolean;
  lastError?: string;
}

type ChangeListener = (status: PollerStatus) => void;
type CycleListener = (cycle: Cycle) => void;

export class Poller {
  private readonly deps: PollerDeps;
  private readonly config: CompanionConfig;

  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private cycleRunning = false;

  private status: PollerStatus = {
    connected: false,
    fortressLoaded: false,
    cycleRunning: false,
  };
  private lastEmittedSnapshot: string | undefined;

  private readonly changeListeners = new Set<ChangeListener>();
  private readonly cycleListeners = new Set<CycleListener>();

  constructor(deps: PollerDeps, config: CompanionConfig) {
    this.deps = deps;
    this.config = config;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.scheduleNextTick();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  getStatus(): PollerStatus {
    return { ...this.status };
  }

  onChange(fn: ChangeListener): () => void {
    this.changeListeners.add(fn);
    return () => {
      this.changeListeners.delete(fn);
    };
  }

  onCycle(fn: CycleListener): () => void {
    this.cycleListeners.add(fn);
    return () => {
      this.cycleListeners.delete(fn);
    };
  }

  /**
   * Runs a cycle immediately, bypassing `shouldTriggerCycle` (and therefore
   * the `MAX_CYCLE_ATTEMPTS` cap) entirely -- this is the manual escape
   * hatch. Still respects the `cycleRunning` guard: it refuses to start a
   * second cycle on top of one already in flight.
   *
   * The guard check and flag flip happen synchronously, before the first
   * `await` (see file header) -- so a second `triggerNow()` call issued
   * before this one's date probe resolves, or a timer-driven tick racing
   * this call, is guaranteed to see `cycleRunning === true` and reject
   * immediately rather than run concurrently.
   *
   * Unlike the automatic tick path, a failure here REJECTS the returned
   * promise -- the caller (e.g. a future HTTP endpoint) explicitly asked for
   * this cycle and needs to know it failed.
   */
  async triggerNow(): Promise<Cycle> {
    if (this.cycleRunning) {
      throw new Error('A cycle is already running');
    }
    // Claim the guard synchronously, before any `await` -- see file header.
    this.cycleRunning = true;
    try {
      // Throws (with `connected: false` + `lastError` already recorded) if
      // the date probe itself fails.
      const date = await this.fetchDateAndUpdateStatus();
      try {
        return await this.runCycleAndTrack(date);
      } catch (err) {
        // The date probe succeeded -- DFHack is reachable -- so only the
        // cycle itself failed (e.g. a `history.upsert()` infra error).
        // Record the error without touching `connected`.
        this.setStatus({
          lastError: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    } finally {
      this.cycleRunning = false;
    }
  }

  private scheduleNextTick(): void {
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    // Keep the chain alive regardless of how long this tick's own work
    // takes, so a slow/blocked cycle never stalls future ticks.
    this.scheduleNextTick();

    if (this.cycleRunning) {
      return;
    }
    // Claim the guard synchronously, before any `await` -- see file header.
    this.cycleRunning = true;
    try {
      await this.poll();
    } catch (err) {
      // `poll()` itself only throws for genuine infra failures (e.g. a
      // `history.upsert()` disk error propagating out of `runCycle` -- see
      // cycle.ts's contract). On this automatic timer path there is no
      // downstream caller to hand the rejection to, and letting it reach the
      // bare `setTimeout` callback would become an unhandled rejection that
      // can crash the process (Node 15+). Swallow it here, surfacing the
      // failure the same way every other poll failure is surfaced
      // (`lastError` + `onChange`), and let the next tick fire as normal.
      this.setStatus({
        lastError: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.cycleRunning = false;
    }
  }

  private async poll(): Promise<void> {
    let date: GameDate;
    try {
      date = await this.fetchDateAndUpdateStatus();
    } catch {
      return;
    }

    const cycles = await this.deps.history.load();
    if (!shouldTriggerCycle(date, cycles)) {
      return;
    }

    await this.runCycleAndTrack(date);
  }

  /** Fetches and parses the current in-game date, or throws. */
  private async fetchDate(): Promise<GameDate> {
    const result = await this.deps.runCommand('lua', [DATE_PROBE_LUA]);
    if (!result.success) {
      throw new Error(result.error ?? 'Date probe failed with no error message');
    }
    return parseDateProbe(result.output);
  }

  /**
   * Fetches the current in-game date and updates `connected`/
   * `fortressLoaded`/`date`/`lastError` to match -- shared by `poll()` and
   * `triggerNow()` so both keep the connection-status fields in sync
   * identically. (The two used to update this independently, and drifted:
   * `triggerNow()` never touched `connected`/`fortressLoaded`/`date` on
   * success, so a manual trigger could complete while the UI kept showing
   * "Disconnected" until the next automatic tick.) On failure, records
   * `connected: false` + the error message, then rethrows.
   */
  private async fetchDateAndUpdateStatus(): Promise<GameDate> {
    let date: GameDate;
    try {
      date = await this.fetchDate();
    } catch (err) {
      this.setStatus({
        connected: false,
        lastError: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    this.setStatus({
      connected: true,
      fortressLoaded: date.fortressMode && date.mapLoaded,
      date,
      lastError: undefined,
    });
    return date;
  }

  /**
   * Runs a single cycle and records the outcome. Toggles the PUBLIC
   * `status.cycleRunning` field (true only while `runCycle()` itself is
   * actually in flight) -- distinct from the private `this.cycleRunning`
   * concurrency guard, which both callers (`tick()` and `triggerNow()`)
   * already claimed synchronously before calling this, and release in their
   * own `finally` once their whole operation completes. A thrown error (e.g.
   * `history.upsert()` failing) is left to propagate after resetting the
   * public status -- each caller decides how to handle the rejection itself.
   */
  private async runCycleAndTrack(date: GameDate): Promise<Cycle> {
    this.setStatus({ cycleRunning: true });
    try {
      const cycle = await runCycle(date, this.deps);
      this.setStatus({
        lastCycleId: cycle.id,
        lastError: cycle.status === 'failed' ? cycle.error : undefined,
      });
      for (const fn of this.cycleListeners) {
        fn(cycle);
      }
      return cycle;
    } finally {
      this.setStatus({ cycleRunning: false });
    }
  }

  private setStatus(patch: Partial<PollerStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emitIfChanged();
  }

  private emitIfChanged(): void {
    const snapshot = JSON.stringify(this.status);
    if (snapshot === this.lastEmittedSnapshot) {
      return;
    }
    this.lastEmittedSnapshot = snapshot;
    const current = { ...this.status };
    for (const fn of this.changeListeners) {
      fn(current);
    }
  }
}

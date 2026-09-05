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
   */
  async triggerNow(): Promise<Cycle> {
    if (this.cycleRunning) {
      throw new Error('A cycle is already running');
    }
    const date = await this.fetchDate();
    return this.runCycleAndTrack(date);
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

    await this.poll();
  }

  private async poll(): Promise<void> {
    let date: GameDate;
    try {
      date = await this.fetchDate();
    } catch (err) {
      this.setStatus({
        connected: false,
        lastError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    this.setStatus({
      connected: true,
      fortressLoaded: date.fortressMode && date.mapLoaded,
      date,
      lastError: undefined,
    });

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

  private async runCycleAndTrack(date: GameDate): Promise<Cycle> {
    this.cycleRunning = true;
    this.setStatus({ cycleRunning: true });
    try {
      const cycle = await runCycle(date, this.deps);
      this.setStatus({
        cycleRunning: false,
        lastCycleId: cycle.id,
        lastError: cycle.status === 'failed' ? cycle.error : undefined,
      });
      for (const fn of this.cycleListeners) {
        fn(cycle);
      }
      return cycle;
    } catch (err) {
      this.setStatus({
        cycleRunning: false,
        lastError: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      this.cycleRunning = false;
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

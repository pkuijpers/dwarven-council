import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Poller, type PollerStatus } from '../src/poller.js';
import type { CycleDeps } from '../src/cycle.js';
import type { HistoryStore, Cycle } from '../src/history.js';
import type { AssemblyClient } from '../src/anthropic.js';
import type { GameDate } from '../src/season.js';
import type { CompanionConfig } from '../src/config.js';

const rawFixture = readFileSync(
  fileURLToPath(new URL('./fixtures/raw-assembly-output.txt', import.meta.url)),
  'utf8'
);

/** In-memory fake HistoryStore -- no filesystem, but the same contract. */
class FakeHistoryStore {
  records: Cycle[] = [];

  async load(): Promise<Cycle[]> {
    return [...this.records];
  }

  async upsert(cycle: Cycle): Promise<void> {
    const idx = this.records.findIndex((r) => r.id === cycle.id);
    if (idx === -1) {
      this.records.push(cycle);
    } else {
      this.records[idx] = cycle;
    }
  }

  async latest(): Promise<Cycle | undefined> {
    return this.records[this.records.length - 1];
  }

  async find(id: string): Promise<Cycle | undefined> {
    return this.records.find((r) => r.id === id);
  }
}

const NOW = new Date('2026-09-04T12:00:00.000Z');

const CONFIG: CompanionConfig = {
  anthropicApiKey: 'test-key',
  dfhackHost: 'localhost',
  dfhackPort: 5000,
  dfhackTimeoutMs: 30000,
  companionPort: 3000,
  pollIntervalMs: 60000,
  effort: 'medium',
  model: 'claude-opus-5',
  dataDir: './data',
};

/** Tab-separated date-probe output, matching DATE_PROBE_LUA's shape. */
function probeOutput(year: number, tick: number, fortressMode = true, mapLoaded = true): string {
  return `${year}\t${tick}\t${fortressMode}\t${mapLoaded}`;
}

// Spring is ticks [0, 100800). Summer starts at 100800.
const SPRING_TICK = 0;
const SUMMER_TICK = 100800;

/** Routes by command: `lua` gets the date probe, `dwarven-coop` gets a real assembly fixture. */
function defaultRunCommand(cmd: string) {
  if (cmd === 'dwarven-coop') {
    return { success: true, output: rawFixture };
  }
  return { success: true, output: probeOutput(106, SPRING_TICK) };
}

function makeDeps(overrides: Partial<CycleDeps> = {}): {
  deps: CycleDeps;
  history: FakeHistoryStore;
  runCommand: ReturnType<typeof vi.fn>;
} {
  const history = new FakeHistoryStore();
  const assembly = { generateAssembly: vi.fn(async () => 'assembly text') };

  const deps: CycleDeps = {
    runCommand: vi.fn(async (cmd: string) => defaultRunCommand(cmd)),
    assembly: assembly as unknown as AssemblyClient,
    history: history as unknown as HistoryStore,
    now: () => NOW,
    ...overrides,
  };

  return { deps, history, runCommand: deps.runCommand as ReturnType<typeof vi.fn> };
}

describe('Poller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('1. connection error -> connected: false, does not crash, next tick still fires', async () => {
    const { deps, runCommand } = makeDeps({
      runCommand: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    const poller = new Poller(deps, CONFIG);

    poller.start();
    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);

    const status = poller.getStatus();
    expect(status.connected).toBe(false);
    expect(status.lastError).toBeTruthy();

    // Next tick still fires -- runCommand called again.
    const callsAfterFirst = runCommand.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);
    expect(runCommand.mock.calls.length).toBeGreaterThan(callsAfterFirst);

    poller.stop();
  });

  it('2. mapLoaded: false -> idles, no cycle triggered', async () => {
    const { deps, history } = makeDeps({
      runCommand: vi.fn(async () => ({
        success: true,
        output: probeOutput(106, SPRING_TICK, true, false),
      })),
    });
    const poller = new Poller(deps, CONFIG);

    poller.start();
    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs * 3);

    expect(history.records).toHaveLength(0);
    const status = poller.getStatus();
    expect(status.fortressLoaded).toBe(false);
    expect(status.cycleRunning).toBe(false);

    poller.stop();
  });

  it('3. season unchanged across ticks -> no cycle triggered', async () => {
    const { deps, history } = makeDeps();
    // Pre-seed a completed cycle for the current (Spring) season so that
    // subsequent ticks -- which keep reporting the same season -- have
    // nothing new to trigger.
    history.records.push({
      id: '106-0',
      year: 106,
      seasonIndex: 0,
      seasonName: 'Spring',
      triggeredAt: '2026-09-01T00:00:00.000Z',
      status: 'completed',
      attempts: 1,
      briefing: '',
      state: {},
    });
    const poller = new Poller(deps, CONFIG);

    poller.start();
    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs * 4);

    expect(history.records).toHaveLength(1);

    poller.stop();
  });

  it('4. season changed -> exactly one runCycle invocation', async () => {
    const { deps, history, runCommand } = makeDeps();
    // Pre-seed a completed cycle for the starting (Spring) season so the
    // first tick below is a genuine "season unchanged" tick, isolating the
    // season *change* as the only thing that should trigger a cycle.
    history.records.push({
      id: '106-0',
      year: 106,
      seasonIndex: 0,
      seasonName: 'Spring',
      triggeredAt: '2026-09-01T00:00:00.000Z',
      status: 'completed',
      attempts: 1,
      briefing: '',
      state: {},
    });
    const poller = new Poller(deps, CONFIG);

    poller.start();
    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);

    // Change season for subsequent ticks.
    runCommand.mockImplementation(async (cmd: string) => {
      if (cmd === 'dwarven-coop') {
        return { success: true, output: rawFixture };
      }
      return { success: true, output: probeOutput(106, SUMMER_TICK) };
    });

    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs * 3);

    // Exactly one new record was created for the new season (Summer,
    // 106-1) -- the pre-seeded Spring record (106-0) is untouched, and
    // repeated Summer ticks did not create duplicates.
    expect(history.records).toHaveLength(2);
    const summerRecords = history.records.filter((r) => r.id === '106-1');
    expect(summerRecords).toHaveLength(1);
    expect(summerRecords[0].status).toBe('completed');
    expect(summerRecords[0].seasonName).toBe('Summer');

    poller.stop();
  });

  it('5. a tick arriving while cycleRunning is true is skipped', async () => {
    let resolveRunCommand: (() => void) | undefined;
    const runCommand = vi.fn(async (cmd: string) => {
      if (cmd === 'dwarven-coop') {
        // Block the assembly command until we release it.
        await new Promise<void>((resolve) => {
          resolveRunCommand = resolve;
        });
        return { success: true, output: '' };
      }
      return { success: true, output: probeOutput(106, SPRING_TICK) };
    });
    const { deps, history } = makeDeps({ runCommand });
    const poller = new Poller(deps, CONFIG);

    poller.start();
    // First tick: date probe succeeds, cycle starts and blocks on runCommand('dwarven-coop', ...).
    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);
    expect(poller.getStatus().cycleRunning).toBe(true);

    const callsBeforeSecondTick = runCommand.mock.calls.length;
    // Second tick arrives while cycle is still running -- should be skipped
    // entirely (no additional date probe call).
    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);
    expect(runCommand.mock.calls.length).toBe(callsBeforeSecondTick);

    // Release the blocked cycle.
    resolveRunCommand?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(poller.getStatus().cycleRunning).toBe(false));

    expect(history.records).toHaveLength(1);

    poller.stop();
  });

  it('6. repeated identical failures emit onChange once, not per tick', async () => {
    const { deps } = makeDeps({
      runCommand: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    const poller = new Poller(deps, CONFIG);
    const onChange = vi.fn();
    poller.onChange(onChange);

    poller.start();
    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs * 4);

    // First tick transitions from initial state to "disconnected" -> one
    // change. Subsequent identical-failure ticks must not re-emit.
    expect(onChange).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it('7. a failed cycle is retried on following ticks and stops after MAX_CYCLE_ATTEMPTS', async () => {
    const { deps, history } = makeDeps({
      runCommand: vi.fn(async (cmd: string) => {
        if (cmd === 'dwarven-coop') {
          return { success: false, output: '', error: 'always fails' };
        }
        return { success: true, output: probeOutput(106, SPRING_TICK) };
      }),
    });
    const poller = new Poller(deps, CONFIG);

    poller.start();
    // Advance 5 intervals against an always-failing runCycle.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);
      // Let any in-flight microtasks settle between ticks.
      await vi.advanceTimersByTimeAsync(0);
    }

    const failedRecords = history.records.filter((r) => r.id === '106-0');
    expect(failedRecords).toHaveLength(1);
    expect(failedRecords[0].attempts).toBe(3);

    poller.stop();
  });

  it('8. stop() prevents further ticks', async () => {
    const { deps, runCommand } = makeDeps();
    const poller = new Poller(deps, CONFIG);

    poller.start();
    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);
    const callsAfterStart = runCommand.mock.calls.length;

    poller.stop();
    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs * 5);

    expect(runCommand.mock.calls.length).toBe(callsAfterStart);
  });

  it('9. triggerNow() runs despite an unchanged season, ignoring the attempt cap', async () => {
    const { deps, history } = makeDeps({
      runCommand: vi.fn(async (cmd: string) => {
        if (cmd === 'dwarven-coop') {
          return { success: false, output: '', error: 'always fails' };
        }
        return { success: true, output: probeOutput(106, SPRING_TICK) };
      }),
    });
    // Pre-seed history with a failed cycle already at the attempt cap.
    history.records.push({
      id: '106-0',
      year: 106,
      seasonIndex: 0,
      seasonName: 'Spring',
      triggeredAt: '2026-09-01T00:00:00.000Z',
      status: 'failed',
      attempts: 3,
      briefing: '',
      state: {},
      error: 'exhausted',
    });

    const poller = new Poller(deps, CONFIG);
    const result = await poller.triggerNow();

    expect(result.id).toBe('106-0');
    expect(result.attempts).toBe(4);
    expect(history.records).toHaveLength(1);
  });

  it('10. triggerNow() is guarded by cycleRunning', async () => {
    let resolveBlock: (() => void) | undefined;
    const runCommand = vi.fn(async (cmd: string) => {
      if (cmd === 'dwarven-coop') {
        await new Promise<void>((resolve) => {
          resolveBlock = resolve;
        });
        return { success: true, output: '' };
      }
      return { success: true, output: probeOutput(106, SPRING_TICK) };
    });
    const { deps } = makeDeps({ runCommand });
    const poller = new Poller(deps, CONFIG);

    const firstCall = poller.triggerNow();
    // Give the first call a chance to reach the blocking runCommand and set
    // cycleRunning.
    await vi.waitFor(() => expect(poller.getStatus().cycleRunning).toBe(true));

    await expect(poller.triggerNow()).rejects.toThrow();

    resolveBlock?.();
    await firstCall;
  });

  it('11. onCycle listeners receive completed cycles', async () => {
    const { deps } = makeDeps();
    const poller = new Poller(deps, CONFIG);
    const onCycle = vi.fn();
    poller.onCycle(onCycle);

    poller.start();
    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);

    expect(onCycle).toHaveBeenCalledTimes(1);
    expect(onCycle.mock.calls[0][0].status).toBe('completed');

    poller.stop();
  });

  it('13. [Critical regression] two back-to-back triggerNow() calls do not both run a cycle', async () => {
    // Reproduces the reviewer's exact repro against the pre-fix code: the
    // pre-fix `triggerNow()` only set `cycleRunning = true` *inside*
    // `runCycleAndTrack`, i.e. after `await this.fetchDate()` had already
    // resolved -- so two calls issued before that round-trip completed both
    // read `cycleRunning === false` and both proceeded to call `runCycle`
    // concurrently (dateCalls: 2, cycleCalls: 2, neither rejected). This
    // test would have failed against that code. It now passes because the
    // guard flag is claimed synchronously, before the first `await`, in the
    // same turn of the event loop as the check -- so the second call always
    // observes the flag already `true`.
    vi.useRealTimers();
    let dateCalls = 0;
    let cycleCalls = 0;
    const runCommand = vi.fn(async (cmd: string) => {
      if (cmd === 'lua') {
        dateCalls++;
        // Simulate a real DFHack round-trip delay (matching the reviewer's
        // 20ms repro) so the two calls' `await`s genuinely interleave.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { success: true, output: probeOutput(106, SPRING_TICK) };
      }
      cycleCalls++;
      return { success: true, output: rawFixture };
    });
    const { deps } = makeDeps({ runCommand });
    const poller = new Poller(deps, CONFIG);

    const [r1, r2] = await Promise.allSettled([poller.triggerNow(), poller.triggerNow()]);

    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0].status === 'rejected') {
      expect(String(rejected[0].reason)).toMatch(/already running/i);
    }
    // Exactly one cycle ran to completion, not two concurrent ones.
    expect(dateCalls).toBe(1);
    expect(cycleCalls).toBe(1);
  });

  it('14. [Critical regression] a scheduled tick racing a manual triggerNow() call only lets one proceed', async () => {
    // Same race, other direction: a timer-driven tick claims the guard
    // synchronously the instant it fires (before its date probe resolves).
    // A `triggerNow()` call issued while that probe is still in flight must
    // see the guard already held and reject, not run a second concurrent
    // cycle alongside the tick's.
    let resolveLua: ((output: string) => void) | undefined;
    const runCommand = vi.fn(async (cmd: string) => {
      if (cmd === 'lua') {
        const output = await new Promise<string>((resolve) => {
          resolveLua = resolve;
        });
        return { success: true, output };
      }
      return { success: true, output: rawFixture };
    });
    const { deps } = makeDeps({ runCommand });
    const poller = new Poller(deps, CONFIG);

    poller.start();
    // Fire the scheduled tick. It runs synchronously up to the point where
    // it blocks on the (unresolved) date probe -- the guard is already
    // claimed by then.
    vi.advanceTimersByTime(CONFIG.pollIntervalMs);
    expect(poller.getStatus().cycleRunning).toBe(false); // not yet inside runCycle
    await expect(poller.triggerNow()).rejects.toThrow(/already running/i);

    resolveLua?.(probeOutput(106, SPRING_TICK));
    await vi.waitFor(() => expect(poller.getStatus().cycleRunning).toBe(false));

    poller.stop();
  });

  it('15. [Important] history.upsert() throwing during an automatic tick does not crash and surfaces via onChange', async () => {
    const { deps, history } = makeDeps();
    // Force the underlying infra failure that cycle.ts's contract allows to
    // propagate out of runCycle.
    vi.spyOn(history, 'upsert').mockRejectedValue(new Error('disk full'));
    const poller = new Poller(deps, CONFIG);
    const onChange = vi.fn();
    poller.onChange(onChange);

    let unhandled: unknown;
    const onUnhandledRejection = (reason: unknown) => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      poller.start();
      await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);
      // Give any stray unhandled rejection a chance to surface.
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(unhandled).toBeUndefined();
    expect(poller.getStatus().lastError).toContain('disk full');
    expect(onChange.mock.calls.some((call) => call[0].lastError?.includes('disk full'))).toBe(
      true
    );
    // The poller keeps running -- cycleRunning was released, not left stuck.
    expect(poller.getStatus().cycleRunning).toBe(false);

    poller.stop();
  });

  it('16. [Important] triggerNow() still rejects when history.upsert() throws', async () => {
    const { deps } = makeDeps();
    vi.spyOn(deps.history, 'upsert').mockRejectedValue(new Error('disk full'));
    const poller = new Poller(deps, CONFIG);

    await expect(poller.triggerNow()).rejects.toThrow(/disk full/);
    expect(poller.getStatus().cycleRunning).toBe(false);
  });

  it('17. [Bug fix] a successful triggerNow() updates connected/fortressLoaded/date, not just lastCycleId', async () => {
    // Before the fix, only the automatic tick's poll() updated the
    // connection-status fields on a successful date fetch -- triggerNow()
    // only ever touched lastCycleId/lastError, leaving connected/
    // fortressLoaded/date stuck at whatever they were before (the
    // constructor's `false` defaults, if this was the very first
    // successful action against a freshly-started poller).
    const { deps } = makeDeps();
    const poller = new Poller(deps, CONFIG);

    expect(poller.getStatus().connected).toBe(false);

    await poller.triggerNow();

    const status = poller.getStatus();
    expect(status.connected).toBe(true);
    expect(status.fortressLoaded).toBe(true);
    expect(status.date).toEqual({
      year: 106,
      tick: SPRING_TICK,
      seasonIndex: 0,
      seasonName: 'Spring',
      fortressMode: true,
      mapLoaded: true,
    });
  });

  it('18. [Bug fix] triggerNow() reports disconnected when the date probe itself fails', async () => {
    const { deps } = makeDeps({
      runCommand: vi.fn(async () => ({ success: false, output: '', error: 'ECONNREFUSED' })),
    });
    const poller = new Poller(deps, CONFIG);

    await expect(poller.triggerNow()).rejects.toThrow(/ECONNREFUSED/);

    const status = poller.getStatus();
    expect(status.connected).toBe(false);
    expect(status.lastError).toMatch(/ECONNREFUSED/);
  });

  it('19. [Bug fix] a runCycle infra failure after a successful date fetch does not falsely report disconnected', async () => {
    // The date probe succeeds (DFHack IS reachable) but the cycle itself
    // hits an infra error (e.g. history.upsert() failing to write to disk).
    // `connected` must stay `true` -- only `lastError` should reflect the
    // cycle failure, mirroring how the automatic tick path (poll() +
    // tick()'s catch) already keeps these concerns separate.
    const { deps } = makeDeps();
    vi.spyOn(deps.history, 'upsert').mockRejectedValue(new Error('disk full'));
    const poller = new Poller(deps, CONFIG);

    await expect(poller.triggerNow()).rejects.toThrow(/disk full/);

    const status = poller.getStatus();
    expect(status.connected).toBe(true);
    expect(status.fortressLoaded).toBe(true);
    expect(status.lastError).toMatch(/disk full/);
  });

  it('12. onChange returns an unsubscribe function', async () => {
    const { deps } = makeDeps({
      runCommand: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const poller = new Poller(deps, CONFIG);
    const onChange = vi.fn();
    const unsubscribe = poller.onChange(onChange);
    unsubscribe();

    poller.start();
    await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);

    expect(onChange).not.toHaveBeenCalled();

    poller.stop();
  });
});

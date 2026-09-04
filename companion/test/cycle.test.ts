import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCycle, type CycleDeps } from '../src/cycle.js';
import { HistoryStore, type Cycle } from '../src/history.js';
import { AssemblyRefusedError, AssemblyTruncatedError, type AssemblyClient } from '../src/anthropic.js';
import { PayloadError } from '../src/payload.js';
import type { GameDate } from '../src/season.js';

const fixturePath = fileURLToPath(
  new URL('./fixtures/raw-assembly-output.txt', import.meta.url)
);
const rawFixture = readFileSync(fixturePath, 'utf8');

const assemblyResponsePath = fileURLToPath(
  new URL('./fixtures/assembly-response.md', import.meta.url)
);
const assemblyResponse = readFileSync(assemblyResponsePath, 'utf8');

/** Matches the fixture's `date.season` field ("Spring") and year (106). */
const date: GameDate = {
  year: 106,
  tick: 87105,
  seasonIndex: 0,
  seasonName: 'Spring',
  fortressMode: true,
  mapLoaded: true,
};

const NOW = new Date('2026-09-04T12:00:00.000Z');

/** In-memory fake HistoryStore -- no filesystem, but the same contract. */
class FakeHistoryStore {
  records: Cycle[] = [];
  loadCalls = 0;
  upsertCalls = 0;
  failUpsertWith: Error | undefined;

  async load(): Promise<Cycle[]> {
    this.loadCalls++;
    return [...this.records];
  }

  async upsert(cycle: Cycle): Promise<void> {
    this.upsertCalls++;
    if (this.failUpsertWith) {
      throw this.failUpsertWith;
    }
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

function makeDeps(overrides: Partial<CycleDeps> = {}): {
  deps: CycleDeps;
  history: FakeHistoryStore;
  assembly: { generateAssembly: ReturnType<typeof vi.fn> };
} {
  const history = new FakeHistoryStore();
  const assembly = {
    generateAssembly: vi.fn(async () => assemblyResponse),
  };
  const runCommand = vi.fn(async () => ({ success: true, output: rawFixture }));

  const deps: CycleDeps = {
    runCommand,
    assembly: assembly as unknown as AssemblyClient,
    history: history as unknown as HistoryStore,
    now: () => NOW,
    ...overrides,
  };

  return { deps, history, assembly };
}

describe('runCycle', () => {
  it('1. happy path: fetches state, builds prompts, generates assembly, extracts OKRs, stores completed with attempts 1', async () => {
    const { deps, history, assembly } = makeDeps();

    const result = await runCycle(date, deps);

    expect(result.status).toBe('completed');
    expect(result.attempts).toBe(1);
    expect(result.id).toBe('106-0');
    expect(result.year).toBe(106);
    expect(result.seasonIndex).toBe(0);
    expect(result.seasonName).toBe('Spring');
    expect(result.triggeredAt).toBe(NOW.toISOString());
    expect(result.briefing.startsWith('# Dwarven Cooperative')).toBe(true);
    expect(result.assembly).toBe(assemblyResponse);
    expect(result.okrs).toContain('[VOTING]');
    expect(result.error).toBeUndefined();

    // Prompts were actually built from the fetched state/briefing.
    expect(assembly.generateAssembly).toHaveBeenCalledTimes(1);
    const req = assembly.generateAssembly.mock.calls[0][0];
    expect(req.system).toContain('Dwarven Cooperative');
    expect(req.user).toContain('Bellspants');

    // Persisted to history exactly as returned.
    expect(history.records).toHaveLength(1);
    expect(history.records[0]).toEqual(result);
  });

  it('2. runCommand returns success: false -> failed cycle carrying the error', async () => {
    const { deps, history } = makeDeps({
      runCommand: vi.fn(async () => ({
        success: false,
        output: '',
        error: 'DFHack connection refused',
      })),
    });

    const result = await runCycle(date, deps);

    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(result.error).toContain('DFHack connection refused');
    expect(history.records).toHaveLength(1);
    expect(history.records[0]).toEqual(result);
  });

  it('2b. runCommand returns success: false with no error message -> descriptive fallback', async () => {
    const { deps, history } = makeDeps({
      runCommand: vi.fn(async () => ({ success: false, output: '' })),
    });

    const result = await runCycle(date, deps);

    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(history.records).toHaveLength(1);
  });

  it('3. PayloadError from extractPayload -> failed cycle whose error includes the raw output', async () => {
    const badOutput = 'garbage, no sentinel markers here';
    const { deps, history } = makeDeps({
      runCommand: vi.fn(async () => ({ success: true, output: badOutput })),
    });

    const result = await runCycle(date, deps);

    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain(badOutput);
    expect(history.records).toHaveLength(1);
  });

  it('4. AssemblyRefusedError -> failed cycle with the refusal category', async () => {
    const { deps, history } = makeDeps();
    (deps.assembly.generateAssembly as ReturnType<typeof vi.fn>).mockRejectedValue(
      new AssemblyRefusedError('general_harms', 'nope')
    );

    const result = await runCycle(date, deps);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('general_harms');
    expect(history.records).toHaveLength(1);
  });

  it('5. AssemblyTruncatedError -> failed cycle', async () => {
    const { deps, history } = makeDeps();
    (deps.assembly.generateAssembly as ReturnType<typeof vi.fn>).mockRejectedValue(
      new AssemblyTruncatedError()
    );

    const result = await runCycle(date, deps);

    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(history.records).toHaveLength(1);
  });

  it('6. a generic/unexpected error from generateAssembly is also caught as a failed cycle', async () => {
    const { deps, history } = makeDeps();
    (deps.assembly.generateAssembly as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('network exploded')
    );

    const result = await runCycle(date, deps);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('network exploded');
    expect(history.records).toHaveLength(1);
  });

  it('7. retry after an existing failed record for the same id stores attempts: 2 and leaves one record', async () => {
    const { deps, history } = makeDeps({
      runCommand: vi.fn(async () => ({
        success: false,
        output: '',
        error: 'still broken',
      })),
    });
    history.records.push({
      id: '106-0',
      year: 106,
      seasonIndex: 0,
      seasonName: 'Spring',
      triggeredAt: '2026-09-01T00:00:00.000Z',
      status: 'failed',
      attempts: 1,
      briefing: '',
      state: {},
      error: 'previous failure',
    });

    const result = await runCycle(date, deps);

    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(2);
    expect(history.records).toHaveLength(1);
    expect(history.records[0].attempts).toBe(2);
  });

  it('8. a success after a failure overwrites the failed record with status completed', async () => {
    const { deps, history } = makeDeps();
    history.records.push({
      id: '106-0',
      year: 106,
      seasonIndex: 0,
      seasonName: 'Spring',
      triggeredAt: '2026-09-01T00:00:00.000Z',
      status: 'failed',
      attempts: 1,
      briefing: '',
      state: {},
      error: 'previous failure',
    });

    const result = await runCycle(date, deps);

    expect(result.status).toBe('completed');
    expect(result.attempts).toBe(2);
    expect(history.records).toHaveLength(1);
    expect(history.records[0].status).toBe('completed');
  });

  it('9. a history.upsert() rejection propagates out of runCycle (broken disk surfaces)', async () => {
    const { deps, history } = makeDeps();
    history.failUpsertWith = new Error('ENOSPC: no space left on device');

    await expect(runCycle(date, deps)).rejects.toThrow('ENOSPC');
  });

  it('10. id === cycleId(year, seasonIndex)', async () => {
    const { deps } = makeDeps();
    const otherDate: GameDate = { ...date, year: 200, seasonIndex: 2, seasonName: 'Autumn' };
    // state.date.season won't match "Autumn" but that's just a warning, not a failure.
    const result = await runCycle(otherDate, deps);
    expect(result.id).toBe('200-2');
  });

  it('11. the previous completed cycle OKRs reach buildUserPrompt', async () => {
    const { deps, assembly } = makeDeps();
    const priorOkrs = '### [VOTING] Voting\n\nPrior quarter OKRs here.';
    (deps.history as unknown as FakeHistoryStore).records.push({
      id: '105-3',
      year: 105,
      seasonIndex: 3,
      seasonName: 'Winter',
      triggeredAt: '2026-06-01T00:00:00.000Z',
      status: 'completed',
      attempts: 1,
      briefing: 'prior briefing',
      state: {},
      okrs: priorOkrs,
    });

    await runCycle(date, deps);

    const req = assembly.generateAssembly.mock.calls[0][0];
    expect(req.user).toContain('Prior quarter OKRs here.');
    expect(req.user).toContain('Year 105, Winter');
  });

  it('11b. does not feed the cycle its own not-yet-written record as "previous"', async () => {
    const { deps, assembly } = makeDeps();
    // Simulate a retry: an existing failed record for the SAME id as this
    // cycle already sits in history. It must not be treated as "previous".
    (deps.history as unknown as FakeHistoryStore).records.push({
      id: '106-0',
      year: 106,
      seasonIndex: 0,
      seasonName: 'Spring',
      triggeredAt: '2026-09-01T00:00:00.000Z',
      status: 'failed',
      attempts: 1,
      briefing: '',
      state: {},
      error: 'previous failure',
    });

    await runCycle(date, deps);

    const req = assembly.generateAssembly.mock.calls[0][0];
    expect(req.user).not.toContain('## Previous Quarter');
  });

  it('12. a season-name mismatch between SEASON_NAMES[seasonIndex] and state.date.season is recorded as a warning, not a crash', async () => {
    const mismatched: GameDate = { ...date, seasonIndex: 1, seasonName: 'Summer' };
    const { deps, history } = makeDeps();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runCycle(mismatched, deps);

    expect(result.status).toBe('completed');
    expect(warnSpy).toHaveBeenCalled();
    expect(history.records).toHaveLength(1);

    warnSpy.mockRestore();
  });
});

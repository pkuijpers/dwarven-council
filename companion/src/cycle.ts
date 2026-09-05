// Orchestrates one quarterly "cycle": fetch fortress state, build prompts,
// call the LLM, extract OKRs, and record the outcome in history.
//
// Contract: `runCycle` never throws for a game-state or LLM-layer failure --
// every such path produces a `Cycle` with `status: 'failed'`, a diagnostic
// `error`, and is still written to history (so `shouldTriggerCycle`'s
// bounded-retry cap can count against it). A `history.upsert()` call itself
// throwing (e.g. a broken disk) is a genuine infrastructure failure and is
// allowed to propagate.

import type { AssemblyClient } from './anthropic.js';
import { AssemblyRefusedError, AssemblyTruncatedError } from './anthropic.js';
import type { Cycle, HistoryStore } from './history.js';
import { extractPayload, PayloadError } from './payload.js';
import { buildSystemPrompt, buildUserPrompt, previousQuarterFrom } from './prompt.js';
import { extractOkrs } from './okr.js';
import { cycleId, SEASON_NAMES, type GameDate } from './season.js';

export interface CycleDeps {
  runCommand(
    cmd: string,
    args?: string[]
  ): Promise<{ success: boolean; output: string; error?: string }>;
  assembly: AssemblyClient;
  history: HistoryStore;
  now(): Date;
}

export async function runCycle(date: GameDate, deps: CycleDeps): Promise<Cycle> {
  const id = cycleId(date.year, date.seasonIndex);
  const triggeredAt = deps.now().toISOString();

  const existing = await deps.history.find(id);
  const attempts = (existing?.attempts ?? 0) + 1;

  const failed = (error: string, briefing = '', state: unknown = {}): Cycle => ({
    id,
    year: date.year,
    seasonIndex: date.seasonIndex,
    seasonName: date.seasonName,
    triggeredAt,
    status: 'failed',
    attempts,
    briefing,
    state,
    error,
  });

  const result = await deps.runCommand('dwarven-coop', ['assembly']);
  if (!result.success) {
    const record = failed(result.error ?? 'dwarven-coop assembly failed with no error message');
    await deps.history.upsert(record);
    return record;
  }

  let payload;
  try {
    payload = extractPayload(result.output);
  } catch (err) {
    if (err instanceof PayloadError) {
      const record = failed(
        `Failed to parse assembly payload: ${err.message}\n\nRaw output:\n${err.rawOutput}`
      );
      await deps.history.upsert(record);
      return record;
    }
    throw err;
  }

  const expectedSeasonName = SEASON_NAMES[date.seasonIndex];
  if (payload.state.date && payload.state.date.season !== expectedSeasonName) {
    console.warn(
      `runCycle: season mismatch for cycle ${id} -- tick-derived season is ` +
        `"${expectedSeasonName}" but state.date.season is "${payload.state.date.season}"`
    );
  }

  let system: string;
  let user: string;
  try {
    // The previous quarter is the most recent history record for a
    // DIFFERENT season than the one currently running -- never this
    // cycle's own id. Using `history.latest()` here would be wrong on a
    // bounded retry (it would return this season's own prior failed
    // attempt) and on a manual re-run of an already-completed season (it
    // would feed the assembly its own completed record as "previous").
    const allCycles = await deps.history.load();
    const previousCycle = allCycles.filter((c) => c.id !== id).at(-1);
    const previous = previousQuarterFrom(previousCycle);

    system = buildSystemPrompt(payload.state);
    user = buildUserPrompt(payload.state, payload.briefing, previous);
  } catch (err) {
    const message =
      err instanceof Error
        ? `Failed to build assembly prompt: ${err.message}`
        : `Failed to build assembly prompt: ${String(err)}`;
    const record = failed(message, payload.briefing, payload.state);
    await deps.history.upsert(record);
    return record;
  }

  let assemblyText: string;
  try {
    assemblyText = await deps.assembly.generateAssembly({ system, user });
  } catch (err) {
    let message: string;
    if (err instanceof AssemblyRefusedError || err instanceof AssemblyTruncatedError) {
      // These already carry a fully descriptive `message` (category included
      // for refusals) from their own constructors.
      message = err.message;
    } else if (err instanceof Error) {
      message = `Assembly generation failed: ${err.message}`;
    } else {
      message = `Assembly generation failed: ${String(err)}`;
    }
    const record = failed(message, payload.briefing, payload.state);
    await deps.history.upsert(record);
    return record;
  }

  const okrs = extractOkrs(assemblyText);

  const record: Cycle = {
    id,
    year: date.year,
    seasonIndex: date.seasonIndex,
    seasonName: date.seasonName,
    triggeredAt,
    status: 'completed',
    attempts,
    briefing: payload.briefing,
    state: payload.state,
    assembly: assemblyText,
    okrs,
  };

  await deps.history.upsert(record);
  return record;
}

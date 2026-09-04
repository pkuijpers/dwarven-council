import type { Cycle } from './history.js';

export const TICKS_PER_YEAR = 403200;
export const TICKS_PER_SEASON = 100800;
export const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;

/**
 * Bounded retry: a `failed` cycle for the current season may be re-attempted
 * up to this many times before polling gives up on it for the season. This
 * retries a transient blip (e.g. a momentary DFHack hiccup) without burning a
 * request every poll interval through a longer outage. `POST /api/cycle`
 * remains the manual escape hatch and ignores this cap.
 */
export const MAX_CYCLE_ATTEMPTS = 3;

/**
 * Probe run via `runCommand('lua', [DATE_PROBE_LUA])`. Prefers
 * `dfhack.world.isFortressMode()` / `dfhack.isMapLoaded()` over a raw
 * `gamemode` check (verified fact 6). Output is tab-separated to match
 * Lua's `print(a, b, c, d)` behavior.
 */
export const DATE_PROBE_LUA =
  "print(df.global.cur_year, df.global.cur_year_tick, tostring(dfhack.world.isFortressMode()), tostring(dfhack.isMapLoaded()))";

export interface GameDate {
  year: number;
  tick: number;
  seasonIndex: 0 | 1 | 2 | 3;
  seasonName: string;
  fortressMode: boolean;
  mapLoaded: boolean;
}

/**
 * Derives the season index from a raw `cur_year_tick` value.
 *
 * `floor(tick / TICKS_PER_SEASON)` clamped to [0,3] -- ticks at or beyond
 * TICKS_PER_YEAR (403200) defensively clamp to the last season (Winter,
 * index 3) rather than wrapping or throwing, since a stray tick count
 * slightly past a year boundary should still resolve to *some* valid season.
 *
 * Verified to agree with an independent reimplementation of the
 * month-derived season computed by `get_date()` in dwarven-coop.lua
 * (day = floor(tick/1200)+1; month = floor((day-1)/28)+1;
 * season = seasons[floor((month-1)/3)+1]) at all four season boundaries.
 */
export function seasonIndexFromTick(tick: number): 0 | 1 | 2 | 3 {
  const index = Math.floor(tick / TICKS_PER_SEASON);
  const clamped = Math.min(index, SEASON_NAMES.length - 1);
  return Math.max(0, clamped) as 0 | 1 | 2 | 3;
}

/** Stable identifier for a quarterly cycle: one per (year, season). */
export function cycleId(year: number, seasonIndex: number): string {
  return `${year}-${seasonIndex}`;
}

/**
 * Parses the tab-separated output of {@link DATE_PROBE_LUA}:
 * `<year>\t<tick>\t<fortressMode>\t<mapLoaded>`, e.g. `106\t87105\ttrue\ttrue`.
 */
export function parseDateProbe(output: string): GameDate {
  const fields = output.trim().split('\t');
  if (fields.length !== 4) {
    throw new Error(`Malformed date probe output (expected 4 tab-separated fields): ${JSON.stringify(output)}`);
  }
  const [yearRaw, tickRaw, fortressModeRaw, mapLoadedRaw] = fields;

  const year = Number(yearRaw);
  const tick = Number(tickRaw);
  if (!Number.isFinite(year) || !Number.isFinite(tick)) {
    throw new Error(`Malformed date probe output (non-numeric year/tick): ${JSON.stringify(output)}`);
  }

  const fortressMode = parseBoolField(fortressModeRaw, output);
  const mapLoaded = parseBoolField(mapLoadedRaw, output);

  const seasonIndex = seasonIndexFromTick(tick);
  return {
    year,
    tick,
    seasonIndex,
    seasonName: SEASON_NAMES[seasonIndex],
    fortressMode,
    mapLoaded,
  };
}

function parseBoolField(raw: string, original: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`Malformed date probe output (expected 'true'/'false'): ${JSON.stringify(original)}`);
}

/**
 * Decides whether polling should trigger a new quarterly cycle for the
 * current in-game season.
 *
 * - Never triggers outside fortress mode / without a loaded map.
 * - Never triggers if the current season already has a `completed` cycle.
 * - Never backfills skipped seasons -- only the *current* season's id is
 *   considered.
 * - A `failed` cycle for the current season may be retried up to
 *   {@link MAX_CYCLE_ATTEMPTS} times; once exhausted, polling stops
 *   triggering it (the manual `POST /api/cycle` endpoint ignores this cap).
 */
export function shouldTriggerCycle(date: GameDate, cycles: Cycle[]): boolean {
  if (!date.fortressMode || !date.mapLoaded) {
    return false;
  }

  const id = cycleId(date.year, date.seasonIndex);
  const existing = cycles.find((c) => c.id === id);
  if (!existing) {
    return true;
  }

  if (existing.status === 'completed') {
    return false;
  }

  // status === 'failed'
  return existing.attempts < MAX_CYCLE_ATTEMPTS;
}

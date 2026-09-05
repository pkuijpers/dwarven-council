import { describe, it, expect } from 'vitest';
import type { Cycle } from '../src/history.js';
import {
  TICKS_PER_YEAR,
  TICKS_PER_SEASON,
  SEASON_NAMES,
  MAX_CYCLE_ATTEMPTS,
  DATE_PROBE_LUA,
  seasonIndexFromTick,
  cycleId,
  parseDateProbe,
  shouldTriggerCycle,
  type GameDate,
} from '../src/season.js';

/**
 * Independent reimplementation of the season derivation from `get_date()` in
 * dwarven-coop.lua:
 *   day = floor(tick/1200) + 1
 *   month = floor((day-1)/28) + 1
 *   season = seasons[floor((month-1)/3) + 1]
 * with 1-based Lua indices converted to 0-based here.
 */
function luaSeasonIndex(tick: number): number {
  const day = Math.floor(tick / 1200) + 1;
  const month = Math.floor((day - 1) / 28) + 1;
  return Math.floor((month - 1) / 3);
}

function makeCycle(overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: '106-1',
    year: 106,
    seasonIndex: 1,
    seasonName: 'Summer',
    triggeredAt: '2026-09-04T00:00:00.000Z',
    status: 'completed',
    attempts: 1,
    briefing: '# Briefing',
    state: {},
    ...overrides,
  };
}

function makeDate(overrides: Partial<GameDate> = {}): GameDate {
  return {
    year: 106,
    tick: 100800,
    seasonIndex: 1,
    seasonName: 'Summer',
    fortressMode: true,
    mapLoaded: true,
    ...overrides,
  };
}

describe('constants', () => {
  it('TICKS_PER_YEAR / TICKS_PER_SEASON', () => {
    expect(TICKS_PER_YEAR).toBe(403200);
    expect(TICKS_PER_SEASON).toBe(100800);
  });

  it('SEASON_NAMES', () => {
    expect(SEASON_NAMES).toEqual(['Spring', 'Summer', 'Autumn', 'Winter']);
  });

  it('MAX_CYCLE_ATTEMPTS', () => {
    expect(MAX_CYCLE_ATTEMPTS).toBe(3);
  });

  it('DATE_PROBE_LUA is the confirmed probe expression', () => {
    expect(DATE_PROBE_LUA).toContain('df.global.cur_year');
    expect(DATE_PROBE_LUA).toContain('df.global.cur_year_tick');
    expect(DATE_PROBE_LUA).toContain('dfhack.world.isFortressMode()');
    expect(DATE_PROBE_LUA).toContain('dfhack.isMapLoaded()');
    expect(DATE_PROBE_LUA).toContain('print(');
  });
});

describe('seasonIndexFromTick', () => {
  it.each([
    [0, 0],
    [100799, 0],
    [100800, 1],
    [201600, 2],
    [302400, 3],
    [403199, 3],
    [403200, 3], // clamped defensively, one full year past start of Winter
  ])('tick %i -> season index %i', (tick, expected) => {
    expect(seasonIndexFromTick(tick)).toBe(expected);
  });

  it.each([0, 100799, 100800, 201600, 302400, 403199])(
    'agrees with the Lua month-derived season at tick %i',
    (tick) => {
      expect(SEASON_NAMES[seasonIndexFromTick(tick)]).toBe(SEASON_NAMES[luaSeasonIndex(tick)]);
    },
  );
});

describe('cycleId', () => {
  it('formats as `${year}-${seasonIndex}`', () => {
    expect(cycleId(106, 1)).toBe('106-1');
    expect(cycleId(0, 0)).toBe('0-0');
  });
});

describe('parseDateProbe', () => {
  it('parses the brief\'s example output', () => {
    expect(parseDateProbe('106\t87105\ttrue\ttrue')).toEqual({
      year: 106,
      tick: 87105,
      seasonIndex: 0,
      seasonName: 'Spring',
      fortressMode: true,
      mapLoaded: true,
    });
  });

  it('parses false values as booleans', () => {
    const result = parseDateProbe('106\t201600\tfalse\tfalse');
    expect(result.fortressMode).toBe(false);
    expect(result.mapLoaded).toBe(false);
    expect(result.seasonIndex).toBe(2);
    expect(result.seasonName).toBe('Autumn');
  });

  it('trims trailing whitespace/newline from probe output', () => {
    const result = parseDateProbe('106\t87105\ttrue\ttrue\n');
    expect(result.year).toBe(106);
    expect(result.tick).toBe(87105);
  });

  it('throws on malformed output (too few fields)', () => {
    expect(() => parseDateProbe('106\t87105\ttrue')).toThrow();
  });

  it('throws on malformed output (non-numeric year/tick)', () => {
    expect(() => parseDateProbe('abc\t87105\ttrue\ttrue')).toThrow();
  });

  it('throws on malformed output (empty string)', () => {
    expect(() => parseDateProbe('')).toThrow();
  });

  it('throws on malformed output (non-boolean flag)', () => {
    expect(() => parseDateProbe('106\t87105\tmaybe\ttrue')).toThrow();
  });
});

describe('shouldTriggerCycle', () => {
  it('empty history -> true', () => {
    expect(shouldTriggerCycle(makeDate(), [])).toBe(true);
  });

  it('a completed cycle for the current id -> false', () => {
    const date = makeDate({ year: 106, seasonIndex: 1 });
    const cycles = [makeCycle({ id: cycleId(106, 1), year: 106, seasonIndex: 1, status: 'completed' })];
    expect(shouldTriggerCycle(date, cycles)).toBe(false);
  });

  it('only an older id present -> true', () => {
    const date = makeDate({ year: 106, seasonIndex: 1 });
    const cycles = [makeCycle({ id: cycleId(106, 0), year: 106, seasonIndex: 0, status: 'completed' })];
    expect(shouldTriggerCycle(date, cycles)).toBe(true);
  });

  it('mapLoaded: false -> false', () => {
    const date = makeDate({ mapLoaded: false });
    expect(shouldTriggerCycle(date, [])).toBe(false);
  });

  it('fortressMode: false -> false', () => {
    const date = makeDate({ fortressMode: false });
    expect(shouldTriggerCycle(date, [])).toBe(false);
  });

  it('several seasons skipped -> true, and only for the current season (no backfill)', () => {
    // Completed cycle from two seasons ago; nothing for the seasons in between
    // or for the current one -- should still just trigger the current one.
    const date = makeDate({ year: 106, seasonIndex: 3 });
    const cycles = [makeCycle({ id: cycleId(106, 1), year: 106, seasonIndex: 1, status: 'completed' })];
    expect(shouldTriggerCycle(date, cycles)).toBe(true);
  });

  it('a failed cycle for the current id with attempts < MAX_CYCLE_ATTEMPTS -> true', () => {
    const date = makeDate({ year: 106, seasonIndex: 1 });
    const cycles = [
      makeCycle({ id: cycleId(106, 1), year: 106, seasonIndex: 1, status: 'failed', attempts: MAX_CYCLE_ATTEMPTS - 1 }),
    ];
    expect(shouldTriggerCycle(date, cycles)).toBe(true);
  });

  it('a failed cycle for the current id with attempts >= MAX_CYCLE_ATTEMPTS -> false (exhausted)', () => {
    const date = makeDate({ year: 106, seasonIndex: 1 });
    const cycles = [
      makeCycle({ id: cycleId(106, 1), year: 106, seasonIndex: 1, status: 'failed', attempts: MAX_CYCLE_ATTEMPTS }),
    ];
    expect(shouldTriggerCycle(date, cycles)).toBe(false);
  });

  it('a failed cycle for the current id with attempts > MAX_CYCLE_ATTEMPTS -> false (still exhausted)', () => {
    const date = makeDate({ year: 106, seasonIndex: 1 });
    const cycles = [
      makeCycle({ id: cycleId(106, 1), year: 106, seasonIndex: 1, status: 'failed', attempts: MAX_CYCLE_ATTEMPTS + 5 }),
    ];
    expect(shouldTriggerCycle(date, cycles)).toBe(false);
  });
});

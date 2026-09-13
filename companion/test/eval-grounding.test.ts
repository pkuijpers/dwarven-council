import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Cycle } from '../src/history.js';
import { buildFactsSheet, formatCycleReport } from '../src/eval-grounding.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'state.json'), 'utf8'));

function makeCycle(overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: '106-1',
    year: 106,
    seasonIndex: 1,
    seasonName: 'Spring',
    triggeredAt: '2026-09-04T00:00:00.000Z',
    status: 'completed',
    attempts: 1,
    briefing: '# Briefing',
    state: fixture.state,
    assembly: '### [VOTING]\n\n**OKR 1: Secure the food supply**\n- KR1: Plant more spawn.\n',
    okrs: '**OKR 1: Secure the food supply**\n- KR1: Plant more spawn.\n',
    ...overrides,
  };
}

describe('buildFactsSheet', () => {
  it('surfaces food, drink, and wealth counts from resources', () => {
    const sheet = buildFactsSheet(fixture.state);
    expect(sheet).toContain('food: 1105 units (abundant, 910 days)');
    expect(sheet).toContain('drink: 237 units (low, 78 days)');
    expect(sheet).toContain('wealth: total=129015 created=75297 imported=53718');
  });

  it('surfaces trade goods counts', () => {
    const sheet = buildFactsSheet(fixture.state);
    expect(sheet).toContain(
      'trade goods: crafts=1 masterworks=0 artifacts=0 gems_cut=0 gems_rough=0 total_value=23'
    );
  });

  it('counts squads, members, and armor pieces across all squads', () => {
    const sheet = buildFactsSheet(fixture.state);
    expect(sheet).toContain('military: 2 squads, 5 members, 6 armor pieces total');
  });

  it('surfaces population totals and stress breakdown', () => {
    const sheet = buildFactsSheet(fixture.state);
    expect(sheet).toContain('population: 51 total (40 adults, 11 children), 5 military, 0 injured');
    expect(sheet).toContain('stress: happy=5 content=23 stressed=0 unhappy=6 miserable=0');
  });

  it('summarizes zones and mining as type/array counts when present', () => {
    const sheet = buildFactsSheet(fixture.state);
    expect(sheet).toContain(
      'zones: barracks=1 bedrooms=24 dining_halls=1 meeting_areas=2 offices=2 other=2 pens=1 tombs=0'
    );
    expect(sheet).toContain(
      'mining: blocks=3 types gem_deposits=3 types gems=0 metal_bars=9 types ore_veins=6 types stone_boulders=9 types'
    );
  });

  it('falls back to "?" for missing fields instead of throwing', () => {
    const sheet = buildFactsSheet({});
    expect(sheet).toContain('food: ? units (?, ? days)');
    expect(sheet).toContain('military: 0 squads, 0 members, 0 armor pieces total');
    expect(sheet).not.toContain('zones:');
    expect(sheet).not.toContain('mining:');
  });
});

describe('formatCycleReport', () => {
  it('shows the facts sheet next to the OKR section by default', () => {
    const report = formatCycleReport(makeCycle());
    expect(report).toContain('Cycle 106-1 (Spring 106)');
    expect(report).toContain('FACTS SHEET');
    expect(report).toContain('NARRATIVE (OKRs/voting section)');
    expect(report).toContain('Plant more spawn.');
    expect(report).not.toContain('[OPENING]');
  });

  it('shows the full assembly text when full is true', () => {
    const cycle = makeCycle({
      assembly: '### [OPENING]\n\nFull text here.\n\n### [VOTING]\n\nOKRs here.\n',
      okrs: 'OKRs here.',
    });
    const report = formatCycleReport(cycle, { full: true });
    expect(report).toContain('NARRATIVE (full assembly)');
    expect(report).toContain('Full text here.');
  });

  it('reports a failed cycle as skipped instead of rendering empty state', () => {
    const cycle = makeCycle({ status: 'failed', state: {}, assembly: undefined, okrs: undefined });
    const report = formatCycleReport(cycle);
    expect(report).toBe('Cycle 106-1: skipped: failed cycle');
  });
});

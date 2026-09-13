import type { Cycle } from './history.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function summarizeCounts(record: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      parts.push(`${key}=${value.length}`);
    } else if (value && typeof value === 'object') {
      parts.push(`${key}=${Object.keys(value).length} types`);
    } else if (typeof value === 'number') {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(' ');
}

function countSquads(military: Record<string, unknown>): { members: number; armorPieces: number } {
  const squads = Array.isArray(military.squads) ? military.squads : [];
  let members = 0;
  let armorPieces = 0;
  for (const squad of squads) {
    const squadMembers = Array.isArray(asRecord(squad).members)
      ? (asRecord(squad).members as unknown[])
      : [];
    members += squadMembers.length;
    for (const member of squadMembers) {
      const equipment = asRecord(asRecord(member).equipment);
      const armor = Array.isArray(equipment.armor) ? equipment.armor : [];
      armorPieces += armor.length;
    }
  }
  return { members, armorPieces };
}

/**
 * Pulls the numeric fields most likely to be cited (correctly or not) by a
 * generated assembly narrative -- food/drink/wealth, trade goods, military
 * equipment counts, population/stress, and zones/mining when present --
 * into a compact, human-scannable block. Pure formatting: no scoring, no
 * judgment about whether the numbers are *right*, just legible.
 */
export function buildFactsSheet(state: unknown): string {
  const s = asRecord(state);
  const resources = asRecord(s.resources);
  const food = asRecord(resources.food);
  const drink = asRecord(resources.drink);
  const wealth = asRecord(resources.wealth);
  const tradeGoods = asRecord(s.trade_goods);
  const population = asRecord(s.population);
  const stress = asRecord(population.stress);
  const military = asRecord(s.military);
  const { members, armorPieces } = countSquads(military);
  const squadCount = Array.isArray(military.squads) ? military.squads.length : 0;
  const zones = asRecord(s.zones);
  const mining = asRecord(s.mining);

  const lines = [
    'FACTS SHEET',
    `  food: ${food.count ?? '?'} units (${food.status ?? '?'}, ${food.days_of_supply ?? '?'} days)`,
    `  drink: ${drink.count ?? '?'} units (${drink.status ?? '?'}, ${drink.days_of_supply ?? '?'} days)`,
    `  wealth: total=${wealth.total ?? '?'} created=${wealth.created ?? '?'} imported=${wealth.imported ?? '?'}`,
    `  trade goods: crafts=${tradeGoods.crafts ?? '?'} masterworks=${tradeGoods.masterworks ?? '?'} artifacts=${tradeGoods.artifacts ?? '?'} gems_cut=${tradeGoods.gems_cut ?? '?'} gems_rough=${tradeGoods.gems_rough ?? '?'} total_value=${tradeGoods.total_value ?? '?'}`,
    `  military: ${squadCount} squads, ${members} members, ${armorPieces} armor pieces total`,
    `  population: ${population.total ?? '?'} total (${population.adults ?? '?'} adults, ${population.children ?? '?'} children), ${population.military ?? '?'} military, ${population.injured ?? '?'} injured`,
    `  stress: happy=${stress.happy ?? '?'} content=${stress.content ?? '?'} stressed=${stress.stressed ?? '?'} unhappy=${stress.unhappy ?? '?'} miserable=${stress.miserable ?? '?'}`,
  ];

  if (Object.keys(zones).length > 0) lines.push(`  zones: ${summarizeCounts(zones)}`);
  if (Object.keys(mining).length > 0) lines.push(`  mining: ${summarizeCounts(mining)}`);

  return lines.join('\n');
}

export interface FormatCycleReportOptions {
  full?: boolean;
}

/**
 * Lays a cycle's facts sheet next to its generated narrative so a reader
 * (Claude Code, in-session) can judge grounding without opening the raw
 * history.json tree. `full` shows the entire generated assembly text
 * (opening/positions/debate/notes) instead of just the extracted OKRs,
 * since ungrounded claims can appear outside the voting section too.
 */
export function formatCycleReport(cycle: Cycle, opts: FormatCycleReportOptions = {}): string {
  if (cycle.status === 'failed') {
    return `Cycle ${cycle.id}: skipped: failed cycle`;
  }

  const header = `Cycle ${cycle.id} (${cycle.seasonName} ${cycle.year})`;
  const facts = buildFactsSheet(cycle.state);
  const narrativeLabel = opts.full ? 'NARRATIVE (full assembly)' : 'NARRATIVE (OKRs/voting section)';
  const narrativeBody = opts.full
    ? cycle.assembly ?? '(no assembly text recorded)'
    : cycle.okrs ?? '(no OKRs extracted)';

  return [header, '', facts, '', narrativeLabel, narrativeBody].join('\n');
}

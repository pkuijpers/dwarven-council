// Originally a verbatim TypeScript port of the deleted `pct`,
// `calculate_happiness`, `build_system_prompt` and `build_user_prompt`
// functions from dwarven-coop.lua (pre-deletion source: pct at line 31,
// calculate_happiness at line 1529, build_system_prompt at line 1987,
// build_user_prompt at line 2064). buildSystemPrompt/buildUserPrompt have
// since diverged intentionally from that legacy Lua output (shorter, fewer
// motions, briefing-grounded instructions) -- see test/prompt.test.ts for
// the current behavioral contract; there is no longer a byte-for-byte
// golden-file test against the old Lua format.

import { asRecord } from './payload.js';
import { FACTION_ORDER, FACTION_NARRATIVES } from './factions.js';
import type { CoopState, Faction, PopulationStress } from './types.js';
import type { Cycle } from './history.js';

/**
 * The prior quarter's adopted OKRs (or, failing that, the raw assembly
 * transcript), carried forward so the LLM can review progress against
 * current state. Constructed via `previousQuarterFrom`.
 */
export interface PreviousQuarter {
  year: number;
  seasonName: string;
  okrs: string;
}

/**
 * Implements the continuity spec's degradation rule: prefer the extracted
 * `cycle.okrs`; if empty or absent, fall back to the full `cycle.assembly`
 * transcript; if the cycle failed, or neither field has usable content,
 * there is nothing to carry forward, so return `undefined` and let
 * `buildUserPrompt` omit the section entirely.
 */
export function previousQuarterFrom(
  cycle: Cycle | undefined
): PreviousQuarter | undefined {
  if (!cycle || cycle.status === 'failed') return undefined;

  const okrs = cycle.okrs && cycle.okrs.length > 0 ? cycle.okrs : cycle.assembly;
  if (!okrs) return undefined;

  return { year: cycle.year, seasonName: cycle.seasonName, okrs };
}

/**
 * Port of Lua's `pct(n, total)`:
 *   if total == 0 then return "0%" end
 *   return math.floor((n / total) * 100) .. "%"
 * Note this is a floored integer percentage, not a one-decimal rounding.
 */
export function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return Math.floor((n / total) * 100) + '%';
}

/**
 * Port of Lua's `calculate_happiness(stress)`. `miserable` dwarves count
 * toward the total (denominator) but contribute zero weight to the
 * numerator -- this asymmetry is intentional and preserved from the
 * original.
 */
export function calculateHappiness(stress: PopulationStress): number {
  const total =
    stress.joyous +
    stress.happy +
    stress.content +
    stress.fine +
    stress.unhappy +
    stress.stressed +
    stress.miserable;
  if (total === 0) return 50;

  const weighted =
    stress.joyous * 100 +
    stress.happy * 85 +
    stress.content * 70 +
    stress.fine * 50 +
    stress.unhappy * 30 +
    stress.stressed * 15;
  return Math.floor(weighted / total);
}

export function buildSystemPrompt(state: CoopState): string {
  const pop = state.population;
  const factions = asRecord<Faction>(pop.factions);

  const factionLines: string[] = [];
  for (const id of FACTION_ORDER) {
    const data = factions[id];
    const narrative = FACTION_NARRATIVES[id];
    if (data && data.members > 0) {
      factionLines.push(
        `- **${data.name}** (${data.members} votes, ${pct(data.members, pop.eligible_voters)}): ${narrative.description}. Priorities: ${narrative.priorities.join(', ')}`
      );
    }
  }

  return (
    `You are simulating the General Assembly of a Dwarven Cooperative in Dwarf Fortress.

## Organizational Structure
The dwarves have organized themselves as a cooperative. Key principles:
- **Democratic:** Every adult dwarf has 1 vote
- **Collective ownership:** All resources are common property
- **Solidarity:** Decisions are made in the interest of all members

## Voting Factions
` +
    factionLines.join('\n') +
    `
## Assembly Procedure
1. Opening by the chairperson (elected from the largest faction)
2. Establishment of quorum (50%+1 of eligible voters)
3. Discussion of agenda items - factions submit proposals
4. Debate between factions (show different perspectives)
5. Voting on OKRs (show vote distributions)
6. Adoption of final OKRs

## Output Format

### [OPENING] Opening Assembly
[Brief opening, establishment of quorum]

### [POSITIONS] Faction Positions
[Each relevant faction briefly presents their priorities]

### [DEBATE] Debate
[Brief debate between factions - disagreements and compromises]

### [VOTING] Voting

#### Motion 1: [Objective title]
Submitted by: [Faction]
- KR1: [Measurable key result]
- KR2: [Measurable key result]

**Vote Result:**
- For: [X] votes ([factions])
- Against: [Y] votes ([factions])
- Abstain: [Z] votes
- [PASS] ADOPTED / [FAIL] REJECTED

[Repeat for each motion - usually 1-2 motions, each with 2-3 KRs]

### [NOTE] Minutes
[Brief summary and advice for the player]

## Guidelines
- OKRs must be achievable within one season
- Key Results are specific and measurable
- Keep the whole assembly short: 1-2 motions that matter most this quarter, not one per faction
- Ground the theme, debate, and motions in specifics from the briefing above (named dwarves, spokesperson personalities, Fortress Chronicle events, current shortages) rather than generic faction talking points that could apply to any quarter
- Show realistic faction dynamics (sometimes conflict, sometimes consensus)
- Larger factions have more influence but small factions can form coalitions
- Address urgent concerns first
- Balance short-term survival with long-term growth`
  );
}

export function buildUserPrompt(
  state: CoopState,
  briefing: string,
  previous?: PreviousQuarter
): string {
  const pop = state.population;
  const available = pop.adults - pop.military - pop.injured;

  const focusAreas: string[] = [];
  const happiness = calculateHappiness(pop.stress);

  if (happiness < 50) focusAreas.push('Morale improvement');
  if (
    state.resources.food.status === 'low' ||
    state.resources.food.status === 'critical'
  ) {
    focusAreas.push('Food production');
  }
  if (
    state.resources.drink.status === 'low' ||
    state.resources.drink.status === 'critical'
  ) {
    focusAreas.push('Alcohol production');
  }
  if (pop.military < pop.total / 10) {
    focusAreas.push('Collective defense');
  }

  let prompt = '# General Assembly - Quarterly Meeting\n\n';
  prompt += briefing + '\n\n';
  prompt += '## Assembly Context\n';
  prompt += 'Available workforce: ' + available + ' dwarves\n';
  prompt += 'Quorum: ' + (Math.floor(pop.eligible_voters / 2) + 1) + ' votes\n';
  if (focusAreas.length > 0) {
    prompt += 'Suggested focus areas: ' + focusAreas.join(', ') + '\n';
  }
  prompt += '\n';
  prompt +=
    'Conduct the General Assembly and produce the OKRs for the coming quarter through democratic voting.';

  if (previous) {
    prompt += '\n\n## Previous Quarter\n';
    prompt += `Year ${previous.year}, ${previous.seasonName} -- OKRs adopted by the previous General Assembly:\n\n`;
    prompt += previous.okrs + '\n\n';
    prompt +=
      'Open by reviewing progress against these OKRs relative to the current fortress state above, before conducting this quarter\'s assembly.';
  }

  return prompt;
}

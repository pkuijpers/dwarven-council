// Verbatim TypeScript port of the deleted `pct`, `calculate_happiness`,
// `build_system_prompt` and `build_user_prompt` functions from
// dwarven-coop.lua (pre-deletion source: pct at line 31, calculate_happiness
// at line 1529, build_system_prompt at line 1987, build_user_prompt at line
// 2064). The golden-file test in test/prompt.test.ts pins the combined
// output of buildSystemPrompt + buildUserPrompt to be byte-for-byte
// identical to what the old Lua code printed for the same fortress state.

import { asRecord } from './payload.js';
import { FACTION_ORDER, FACTION_NARRATIVES } from './factions.js';
import type { CoopState, Faction, PopulationStress } from './types.js';

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
- KR3: [Measurable key result]

**Vote Result:**
- For: [X] votes ([factions])
- Against: [Y] votes ([factions])
- Abstain: [Z] votes
- [PASS] ADOPTED / [FAIL] REJECTED

[Repeat for each motion - usually 3-4 motions]

### [NOTE] Minutes
[Brief summary and advice for the player]

## Guidelines
- OKRs must be achievable within one season
- Key Results are specific and measurable
- Show realistic faction dynamics (sometimes conflict, sometimes consensus)
- Larger factions have more influence but small factions can form coalitions
- Address urgent concerns first
- Balance short-term survival with long-term growth`
  );
}

export function buildUserPrompt(state: CoopState, briefing: string): string {
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
  focusAreas.push('Wealth building');
  focusAreas.push('Infrastructure');

  let prompt = '# General Assembly - Quarterly Meeting\n\n';
  prompt += briefing + '\n\n';
  prompt += '## Assembly Context\n';
  prompt += 'Available workforce: ' + available + ' dwarves\n';
  prompt += 'Quorum: ' + (Math.floor(pop.eligible_voters / 2) + 1) + ' votes\n';
  prompt += 'Suggested focus areas: ' + focusAreas.join(', ') + '\n\n';
  prompt +=
    'Conduct the General Assembly and produce the OKRs for the coming quarter through democratic voting.';

  return prompt;
}

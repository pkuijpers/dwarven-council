// Narrative text (description/priorities) for the six voting factions of the
// General Assembly. Ported verbatim from the deleted `FACTIONS` table in
// dwarven-coop.lua (pre-deletion source, lines 151-217).
//
// Faction *names* still come from the game via `state.population.factions`
// (they're derived from live DFHack data and always in sync); this module is
// the source of truth only for the human-authored description/priorities
// text, which the game does not report.
//
// FACTION_ORDER is explicit -- and used to iterate, not
// Object.keys(FACTION_NARRATIVES) -- because the old Lua `FACTIONS` table
// was an ordered array and the system prompt's faction list must be emitted
// in that same order. Object/Record key order should not be load-bearing.

export interface FactionNarrative {
  description: string;
  priorities: string[];
}

export const FACTION_ORDER = [
  'producers',
  'food',
  'delvers',
  'defenders',
  'caregivers',
  'services',
] as const;

export const FACTION_NARRATIVES: Record<
  (typeof FACTION_ORDER)[number],
  FactionNarrative
> = {
  producers: {
    description: 'Craftsdwarves, smiths, and makers',
    priorities: ['workshop efficiency', 'masterwork creation', 'tool quality'],
  },
  food: {
    description: 'Farmers, cooks, and brewers',
    priorities: ['food security', 'alcohol production', 'sustainable farming'],
  },
  delvers: {
    description: 'Miners and earthworkers',
    priorities: ['expansion', 'ore discovery', 'safe mining', 'megaprojects'],
  },
  defenders: {
    description: 'Military and guards',
    priorities: ['fortress defense', 'military training', 'equipment quality'],
  },
  caregivers: {
    description: 'Medics and welfare workers',
    priorities: [
      'healthcare',
      'mental wellness',
      'injury prevention',
      'quality of life',
    ],
  },
  services: {
    description: 'Traders, administrators, and others',
    priorities: ['trade relations', 'efficient management', 'diplomacy'],
  },
};

// Hand-written from the committed fixture `test/fixtures/state.json` (a real
// capture from `dwarven-coop assembly` against a live fortress).
//
// Only the parts of the tree the prompt builder actually reads are typed
// narrowly here: `date`, `population` (incl. `stress` and `factions`), and
// `resources.food.status` / `resources.drink.status`. Every other top-level
// key is left as `unknown` so schema drift in parts of the tree nothing
// reads cannot break parsing.

export interface FortressDate {
  day: number;
  month: number;
  month_name: string;
  season: string;
  tick: number;
  year: number;
}

export interface Faction {
  members: number;
  name: string;
  votes: number;
}

export interface PopulationStress {
  content: number;
  fine: number;
  happy: number;
  joyous: number;
  miserable: number;
  stressed: number;
  unhappy: number;
}

export interface Population {
  adults: number;
  children: number;
  eligible_voters: number;
  // Lua's json.encode emits `[]` (an empty array), not `{}`, for an empty
  // table -- so an empty faction map arrives as `[]`. Pass this through
  // `asRecord` before indexing by faction id.
  factions: Record<string, Faction> | unknown[];
  injured: number;
  military: number;
  stress: PopulationStress;
  total: number;
}

export interface ResourceSummary {
  status: string;
  [key: string]: unknown;
}

export interface Resources {
  food: ResourceSummary;
  drink: ResourceSummary;
  [key: string]: unknown;
}

export interface CoopState {
  date: FortressDate;
  population: Population;
  resources: Resources;
  // Everything below this line is present in the real payload but unread by
  // the prompt builder -- left untyped on purpose (see file header).
  buildings: unknown;
  defenses: unknown;
  events: unknown;
  fortress: unknown;
  locations: unknown;
  military: unknown;
  mining: unknown;
  petitions: unknown;
  spokespersons: unknown;
  trade_goods: unknown;
  zones: unknown;
}

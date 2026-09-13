# Self-Runnable Eval Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Claude Code two small, LLM-free tools it can run itself to speed up the `dwarven-coop` prompt/state-collection iteration loop: a project skill for live cross-checking state-collection numbers against the running game, and an offline script that lays a cycle's state numbers next to its generated narrative for quick consistency review.

**Architecture:** Component A is a documentation-only project skill (no code) that captures a repeatable "recompute this number a different way via `lua_eval`" playbook for the three `dwarven-coop.lua` state-collection categories that have already caused real bugs. Component B splits into pure, unit-testable formatting logic (`companion/src/eval-grounding.ts`) and a thin CLI script (`companion/scripts/eval-grounding.mjs`) that wires that logic to the existing `HistoryStore`, following the same "logic in `src/`, thin script wrapper in `scripts/`" split the codebase already uses (`okr.ts` + the rest of the app / `payload-spike.mjs`).

**Tech Stack:** DFHack Lua + MCP tools (Component A); TypeScript compiled via the existing `companion` `tsc -b` build, plain ESM `.mjs` CLI script (no new build tooling), Vitest for tests (Component B).

**Spec:** `docs/superpowers/specs/2026-09-13-self-runnable-eval-design.md`

## Global Constraints

- No new Anthropic API calls — Claude Code interprets both tools' output itself, in-session (spec "Non-goals").
- No changes to production Lua computation logic — `get_trade_goods()`, `get_military()`, `get_resources()`, `collect_state()` etc. in `dwarven-coop.lua` are read for reference only, never edited by this plan.
- `state-verify` covers only three categories on day one: trade goods, military armor, and resources/population as a baseline — not full field coverage (spec "Non-goals").
- Neither component is wired into CI or `npm test` as a gating check (spec "Out of scope").
- Out of scope: `dwarven-reich.lua`, `dwarven-corp.lua` (no companion app, manual copy/paste workflow unaffected).

---

## File Structure

- Create: `.claude/skills/state-verify/SKILL.md` — Component A, the live cross-check playbook. Doc only, no code.
- Create: `companion/src/eval-grounding.ts` — pure functions `buildFactsSheet(state)` and `formatCycleReport(cycle, opts)`. No I/O, no CLI parsing — everything here takes data in and returns a string, so it's directly unit-testable.
- Create: `companion/test/eval-grounding.test.ts` — Vitest tests for the two functions above, reusing the committed `test/fixtures/state.json` fixture for realistic data.
- Create: `companion/scripts/eval-grounding.mjs` — thin CLI: arg parsing, loads history via the compiled `HistoryStore`, calls the compiled `formatCycleReport`, prints to stdout. Mirrors the existing `companion/scripts/payload-spike.mjs` convention (plain `.mjs`, imports from `../dist/*.js`, `main().catch(...)`).

---

## Task 1: `state-verify` project skill (Component A)

**Files:**
- Create: `.claude/skills/state-verify/SKILL.md`

**Interfaces:**
- Produces: a project skill discoverable by name `state-verify`, picked up automatically by the `using-superpowers` rule whenever `dwarven-coop.lua` state-collection code is touched. Nothing else in this plan depends on it (Component B does not read this file).

This task has no automated test — it is a documentation artifact interpreted by Claude Code against a live DFHack session. The "test cycle" is a structural self-check (every category present, every category has the three required elements) plus a documented manual-verification note.

- [ ] **Step 1: Write the skill file**

Create `.claude/skills/state-verify/SKILL.md`:

````markdown
---
name: state-verify
description: Cross-check dwarven-coop.lua state-collection numbers (trade goods, military armor, resources/population) against a live DFHack fortress via an independently-computed lua_eval recomputation, to catch under/over-counting bugs before they reach the LLM prompt. Use whenever collect_state()-adjacent functions in dwarven-coop.lua (get_trade_goods, get_military, get_unit_equipment, get_resources, analyze_population) are read or modified.
---

# State Verify

`dwarven-coop.lua`'s state-collection functions feed numbers straight into
the LLM prompt. When one of those numbers is wrong, the LLM doesn't know
that — it generates a perfectly coherent OKR from a wrong premise (e.g.
"forge more armor" when the fortress already has plenty, because
`get_military()` only counted 2 of a militia member's 6 armor pieces).
Two real bugs of exactly this shape have already shipped: trade goods
undercounting (`204ca4f`) and militia armor undercounting (`e05e029`).

This skill is a checklist of independent recomputations to run live,
via the existing DFHack MCP tools (`mcp__dfhack__lua_eval`,
`mcp__dfhack__coop_assembly`, `mcp__dfhack__coop_briefing`), whenever code
in one of the covered categories is touched.

**Precondition:** requires a live DFHack connection with a fortress
loaded (see the MCP prerequisites in the root `CLAUDE.md`). If
`mcp__dfhack__dfhack_status` reports no connection, these checks cannot
run — say so rather than guessing.

Run each snippet's body as the `code` argument to `mcp__dfhack__lua_eval`
verbatim — that argument takes raw Lua, not the `:lua` DFHack-console
prefix. Each snippet already ends in `print(n)`, so the tool's
print-auto-wrap (which only fires when `code` doesn't already contain
`print`) is a no-op here.

These are sanity cross-checks, not exact-equality assertions: each
alternate query deliberately uses a different traversal or filter than
the production function, so an exact match isn't always expected (see
the caveat under each category). A **large** or **structural** mismatch
(an order of magnitude off, or a category of item/unit missing entirely)
is the signal to go re-read the production function's filters — the kind
of thing both prior bugs looked like.

## Trade goods (`get_trade_goods()`, `dwarven-coop.lua:541`)

**Compare against:** `trade_goods.crafts` + `trade_goods.masterworks` +
`trade_goods.artifacts` from `mcp__dfhack__coop_assembly`.

**Alternate recomputation** (counts all trade-good-typed items onsite,
with no quality or maker-field filter at all — the two things that broke
last time):

```lua
local n = 0
for _, item in ipairs(df.global.world.items.all) do
  local is_trade_good_type =
    df.item_craftst:is_instance(item) or df.item_toyst:is_instance(item) or
    df.item_instrumentst:is_instance(item) or df.item_gobletst:is_instance(item) or
    df.item_totemst:is_instance(item) or df.item_statuest:is_instance(item) or
    df.item_figurinest:is_instance(item) or df.item_amulettst:is_instance(item) or
    df.item_ringst:is_instance(item) or df.item_earringst:is_instance(item) or
    df.item_braceletst:is_instance(item) or df.item_scepterst:is_instance(item) or
    df.item_crownst:is_instance(item)
  if is_trade_good_type and not item.flags.trader and not item.flags.hostile and
     not item.flags.removed and not item.flags.forbid and not item.flags.dump and
     not item.flags.in_building and item.pos.x ~= -30000 then
    n = n + 1
  end
end
print(n)
```

**Caveat:** the alt query's onsite check (`item.pos.x ~= -30000`) is
simpler than `is_item_onsite()` (it skips the "inside an onsite
container" case), so the alt count can be a little *lower* than the true
total. It should never be dramatically *higher* than
`crafts + masterworks + artifacts` from the real function — if it is,
something in `get_trade_goods()`'s quality/maker filtering is excluding
items it shouldn't (as both prior bugs did).

## Military armor (`get_unit_equipment()`, `dwarven-coop.lua:663`, used by `get_military()`)

**Compare against:** sum of `#member.equipment.armor` across every
member of every squad in `military.squads` from `coop_assembly`.

**Alternate recomputation** (walks items → wearer via `general_refs`,
instead of unit → inventory, and fortress-wide instead of per-squad):

```lua
local n = 0
for _, item in ipairs(df.global.world.items.all) do
  local is_armor_type =
    df.item_armorst:is_instance(item) or df.item_helmst:is_instance(item) or
    df.item_glovesst:is_instance(item) or df.item_pantsst:is_instance(item) or
    df.item_shoesst:is_instance(item)
  if is_armor_type then
    for _, ref in ipairs(item.general_refs) do
      if ref:getType() == df.general_ref_type.UNIT_HOLDER then
        n = n + 1
        break
      end
    end
  end
end
print(n)
```

**Caveat:** this counts armor worn by *any* citizen, not just squad
members, so it will usually be **higher** than the squads-only sum from
`coop_assembly` — that's expected, not a bug. What's worth investigating
is the opposite: if the squads-only sum from `coop_assembly` is higher
than (or close to but suspiciously low relative to) this fortress-wide
count, or if a specific militia member's `equipment.armor` list looks
short compared to what `mcp__dfhack__dfhack_command` with
`ls -a` / unit inspection shows them wearing in-game.

## Resources / population baseline (`get_resources()`, `dwarven-coop.lua:410`; `analyze_population()`, `dwarven-coop.lua:277`)

These haven't broken yet — this is a baseline sanity set, not a response
to a known bug.

**Population compare against:** `population.total` from `coop_assembly`.

**Alternate recomputation** (swaps `dfhack.units.isAlive` for
`dfhack.units.isDead`, a different DFHack helper covering the same
concept from the other direction):

```lua
local n = 0
for _, unit in ipairs(df.global.world.units.active) do
  if dfhack.units.isCitizen(unit) and not dfhack.units.isDead(unit) then
    n = n + 1
  end
end
print(n)
```

**Expected relationship:** should match `population.total` exactly. Any
difference means the citizen/alive filter itself has drifted between the
two helper pairs — worth a closer look either way.

**Food compare against:** `resources.food.count` from `coop_assembly`.

**Alternate recomputation** (counts qualifying item *instances*, ignoring
`stack_size` — deliberately not the same unit as the real function):

```lua
local n = 0
for _, item in ipairs(df.global.world.items.all) do
  if (df.item_foodst:is_instance(item) or df.item_fishst:is_instance(item) or
      df.item_fish_rawst:is_instance(item) or df.item_meatst:is_instance(item) or
      df.item_plantst:is_instance(item)) and item.pos.x ~= -30000 then
    n = n + 1
  end
end
print(n)
```

**Caveat:** this counts *stacks*, not units — expect it to be **lower**
than `resources.food.count` (which sums `stack_size`), often
substantially so. It should never be **higher**: if it is, the real
function's stack-size summation or item-type filter has a bug.

## Extending this skill

When a new `collect_state()`-adjacent field causes a bug, add a new
section here following the same shape: which `coop_assembly` field it
maps to, an alternate `lua_eval` query using a genuinely different
traversal/filter than the production code, and what relationship
(equal, or "should be higher/lower by roughly X") to expect between them.
````

- [ ] **Step 2: Structural self-check**

Read the file back and confirm:
- Valid YAML frontmatter with `name: state-verify` and a `description` mentioning the three covered function names.
- Exactly three `##`-level category sections (Trade goods, Military armor, Resources / population baseline), each containing a "Compare against" line, a fenced ` ```lua ` block, and a caveat/expected-relationship paragraph.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/state-verify/SKILL.md
git commit -m "Add state-verify skill for live state-collection cross-checks"
```

---

## Task 2: Facts-sheet and report formatting logic (Component B, pure logic)

**Files:**
- Create: `companion/src/eval-grounding.ts`
- Test: `companion/test/eval-grounding.test.ts`

**Interfaces:**
- Consumes: `Cycle` type from `companion/src/history.ts` (`id: string`, `year: number`, `seasonIndex: number`, `seasonName: string`, `status: 'completed' | 'failed'`, `state: unknown`, `assembly?: string`, `okrs?: string`).
- Produces: `buildFactsSheet(state: unknown): string` and `formatCycleReport(cycle: Cycle, opts?: { full?: boolean }): string`, both exported from `companion/src/eval-grounding.ts`. Task 3's CLI script imports both (via the compiled `dist/eval-grounding.js`).

- [ ] **Step 1: Write the failing tests**

Create `companion/test/eval-grounding.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run test/eval-grounding.test.ts`
Expected: FAIL — `Cannot find module '../src/eval-grounding.js'` (the module doesn't exist yet).

- [ ] **Step 3: Implement `companion/src/eval-grounding.ts`**

Create `companion/src/eval-grounding.ts`:

```typescript
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
  const squadCount = typeof military.squad_count === 'number' ? military.squad_count : 0;
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run test/eval-grounding.test.ts`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Run the full companion test suite to check for regressions**

Run: `cd companion && npm test`
Expected: PASS, no existing test broken.

- [ ] **Step 6: Commit**

```bash
git add companion/src/eval-grounding.ts companion/test/eval-grounding.test.ts
git commit -m "Add facts-sheet/report formatting for cycle grounding review"
```

---

## Task 3: CLI script wiring (Component B, entry point)

**Files:**
- Create: `companion/scripts/eval-grounding.mjs`

**Interfaces:**
- Consumes: `HistoryStore` (`companion/src/history.ts`, compiled to `companion/dist/history.js`) — constructor `new HistoryStore(filePath: string)`, method `load(): Promise<Cycle[]>`. `formatCycleReport` from Task 2 (compiled to `companion/dist/eval-grounding.js`).
- Produces: a runnable CLI at `companion/scripts/eval-grounding.mjs`, invoked as `node companion/scripts/eval-grounding.mjs [--id <cycleId>] [--all] [--full] [--history <path>]`.

This task has no Vitest coverage (it's a Node CLI entry point hitting the filesystem and a compiled build, matching the existing `payload-spike.mjs` convention of manual verification instead of unit tests). Verification is a set of real `node` invocations with expected output, including against isolated temp fixtures so the real `companion/data/history.json` is never at risk.

- [ ] **Step 1: Write the CLI script**

Create `companion/scripts/eval-grounding.mjs`:

```javascript
// eval-grounding.mjs
//
// Prints a cycle's numeric "facts sheet" (from state) next to its
// generated OKR/narrative text, so a human or Claude Code can judge
// consistency without wading through the raw history.json tree.
//
// Requires `npm run build` (in companion/) to have been run at least
// once -- this imports the compiled dist output, like the rest of the
// companion app.
//
// Usage: node companion/scripts/eval-grounding.mjs [--id <cycleId>] [--all] [--full] [--history <path>]

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HistoryStore } from '../dist/history.js';
import { formatCycleReport } from '../dist/eval-grounding.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = { id: undefined, all: false, full: false, historyPath: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--id') {
      opts.id = argv[++i];
    } else if (arg === '--all') {
      opts.all = true;
    } else if (arg === '--full') {
      opts.full = true;
    } else if (arg === '--history') {
      opts.historyPath = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const historyPath = opts.historyPath ?? join(__dirname, '..', 'data', 'history.json');
  const store = new HistoryStore(historyPath);
  const cycles = await store.load();

  if (cycles.length === 0) {
    console.error(`No cycles recorded yet in ${historyPath}.`);
    process.exitCode = 1;
    return;
  }

  const targets = [];
  if (opts.all) {
    targets.push(...cycles);
  } else if (opts.id) {
    const match = cycles.find((c) => c.id === opts.id);
    if (!match) {
      console.error(
        `No cycle with id "${opts.id}". Available ids: ${cycles.map((c) => c.id).join(', ')}`
      );
      process.exitCode = 1;
      return;
    }
    targets.push(match);
  } else {
    const completed = cycles.filter((c) => c.status === 'completed');
    if (completed.length === 0) {
      console.error(`No completed cycles in ${historyPath} yet (all recorded cycles failed).`);
      process.exitCode = 1;
      return;
    }
    targets.push(completed[completed.length - 1]);
  }

  for (const cycle of targets) {
    console.log(formatCycleReport(cycle, { full: opts.full }));
    console.log('');
  }
}

main().catch((err) => {
  console.error('eval-grounding failed:', err);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Build the companion app**

Run: `cd companion && npm run build`
Expected: exits 0; `companion/dist/eval-grounding.js` and `companion/dist/history.js` now exist.

- [ ] **Step 3: Smoke-test against the real history (read-only)**

Run: `node companion/scripts/eval-grounding.mjs`
Expected: prints one `Cycle <id> (<season> <year>)` block (the latest completed cycle from the real `companion/data/history.json`) containing a `FACTS SHEET` section and a `NARRATIVE (OKRs/voting section)` section, exit code 0.

- [ ] **Step 4: Smoke-test `--all` and `--full`**

Run: `node companion/scripts/eval-grounding.mjs --all --full`
Expected: one block per recorded cycle (5, per the current `history.json`), separated by blank lines; each non-failed block's narrative section is labeled `NARRATIVE (full assembly)` and contains more than just the voting section.

- [ ] **Step 5: Verify error paths against an isolated temp fixture (never touches real data)**

Run:
```bash
mkdir -p /tmp/eval-grounding-test
cat > /tmp/eval-grounding-test/one-cycle.json <<'EOF'
[{"id":"1-0","year":1,"seasonIndex":0,"seasonName":"Spring","triggeredAt":"2026-01-01T00:00:00.000Z","status":"completed","attempts":1,"briefing":"","state":{},"assembly":"### [VOTING]\nOKR text","okrs":"OKR text"}]
EOF
echo '[]' > /tmp/eval-grounding-test/empty.json
node companion/scripts/eval-grounding.mjs --history /tmp/eval-grounding-test/one-cycle.json --id bogus
echo "exit: $?"
node companion/scripts/eval-grounding.mjs --history /tmp/eval-grounding-test/empty.json
echo "exit: $?"
rm -rf /tmp/eval-grounding-test
```
Expected:
- First invocation: stderr `No cycle with id "bogus". Available ids: 1-0`, `exit: 1`.
- Second invocation: stderr `No cycles recorded yet in /tmp/eval-grounding-test/empty.json.`, `exit: 1`.

- [ ] **Step 6: Commit**

```bash
git add companion/scripts/eval-grounding.mjs
git commit -m "Add eval-grounding CLI for reviewing cycle narrative vs. state"
```

---

## Self-Review Notes

- **Spec coverage:** Component A (skill, 3 categories, precondition, extension guidance) — Task 1. Component B input flags (`--id`/`--all`/`--full`), facts sheet fields (food/drink/wealth/trade goods/military/population/stress/zones/mining), reuse of `cycle.okrs`, error handling (unknown id, empty history, skipped failed cycles), and tests against a fixture — Tasks 2–3. Workflow integration is behavioral (how a developer/Claude uses the two tools together), not a separate deliverable — no task needed beyond the two components existing and working. Non-goals (no LLM calls, no production Lua changes, no CI wiring, reich/corp untouched) — respected by construction; nothing in this plan violates them.
- **Placeholder scan:** no TBD/TODO; every code step is complete, runnable code, not a description of code.
- **Type consistency:** `Cycle` fields (`id`, `year`, `seasonName`, `status`, `state`, `assembly`, `okrs`) used identically across Task 2's implementation, its tests, and Task 3's CLI script. `buildFactsSheet(state: unknown): string` and `formatCycleReport(cycle: Cycle, opts?: FormatCycleReportOptions): string` signatures match between their Task 2 definition and their Task 2 test/Task 3 CLI usage.

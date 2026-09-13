# Self-runnable eval for the dwarven-coop generation loop

## Problem

Iterating on `dwarven-coop.lua`'s state collection or the companion's
prompt building (`companion/src/prompt.ts`) currently requires a slow
manual loop: change code, trigger a cycle, read the generated assembly
narrative/OKRs by eye, judge whether it's plausible, repeat. Two distinct
failure modes hide in that loop, and both have already caused real bugs:

1. **State extraction is wrong.** `collect_state()`-style functions in
   `dwarven-coop.lua` under- or over-count something (e.g. `get_trade_goods()`
   massively undercounting fortress-made crafts, fixed in `204ca4f`;
   `get_military()` undercounting non-torso armor, fixed in `e05e029`).
   The LLM then faithfully reflects the wrong number, producing an OKR
   that's plausible on paper ("make more crafts") but wrong in the actual
   game (there were already plenty).
2. **The narrative contradicts the state it was given.** Independent of
   whether the state JSON is correct, the LLM's generated text/OKRs could
   still misstate or contradict the numbers it was handed.

Today, catching either requires the user to notice something looks off
in-game and manually dig through Lua/JSON to confirm. The goal is to give
Claude Code repeatable, purpose-built tooling to check both, so it can run
the check itself instead of the user doing it by eye each time.

## Non-goals

- No standalone/unattended LLM-as-judge. Claude Code interprets the data
  itself, in-session; no new Anthropic API calls are added.
- No changes to production Lua logic (no redundant in-game computation of
  every aggregate). Verification tooling stays outside the hot path.
- No attempt to cross-check every `collect_state()` field up front — only
  the fields that have already caused real bugs, plus a documented method
  for adding more later.
- Does not apply to `dwarven-reich.lua` / `dwarven-corp.lua` (manual
  copy/paste workflow, no companion app, out of scope).

## Component A: `state-verify` project skill (state vs. game reality)

A project skill at `.claude/skills/state-verify/SKILL.md`. Being a skill
(not a doc buried in `docs/`) means the `using-superpowers` rule surfaces
it automatically whenever Claude Code touches `collect_state()`-adjacent
Lua code — no need to be reminded to check it.

**Precondition:** requires a live DFHack connection with a fortress
loaded (per the MCP server prerequisites already documented in the root
`CLAUDE.md`). The skill states this explicitly and points at the existing
MCP tools (`mcp__dfhack__lua_eval`, `mcp__dfhack__coop_assembly`,
`mcp__dfhack__coop_briefing`) — no new tooling is built for this.

**Content:** for each covered state category, the skill documents:

1. Which field(s) in `coop_assembly`/`coop_briefing` output the category
   corresponds to.
2. An alternate `lua_eval` expression that recomputes the same aggregate
   via a different iteration/filter than the production function uses.
3. What a mismatch typically indicates (wrong item-type filter, missing
   `is_item_onsite()` check, wrong equipment-slot enumeration, etc.).

**Initial coverage** (the categories that have already broken):

- `get_trade_goods()` (`dwarven-coop.lua:541`) — cross-check the crafted-goods
  count/value via an alternate on-site item filter.
- `get_military()` (`dwarven-coop.lua:710`) — cross-check equipped-armor
  counts across all equipment slots, not just torso.
- `get_resources()` (`dwarven-coop.lua:410`) and population totals, as a
  baseline sanity set even though they haven't broken yet.

The skill also documents the *method* (iterate `world.items.all` /
`world.units.active` with a deliberately different filter combination
than the target function, then diff the two results) so coverage can be
extended the next time a new `collect_state()` field misbehaves. It is
explicitly not trying to cover every field on day one.

**Usage:** Claude Code runs the documented `lua_eval` snippets for the
touched category against the live game, compares the result to what
`coop_assembly`/`coop_briefing` currently reports, and treats a mismatch
as a signal to re-check the production function's filter logic.

## Component B: `companion/scripts/eval-grounding.ts` (narrative vs. state JSON)

A standalone, offline Node/TS script — no LLM call, no live DFHack
connection required. It only extracts and formats data that already
exists in `companion/data/history.json`; judging whether the narrative
is consistent with the numbers stays with Claude Code, in-session.

**Input:**

- `--id <cycleId>` — a specific cycle id from history.
- Default (no `--id`): the most recent cycle with `status: 'completed'`.
- `--all` — repeat the report for every completed cycle in history (most
  useful right after a fresh cycle run; historical cycles were generated
  under older prompt versions, so cross-cycle comparison is a secondary
  use case, not the primary one).
- `--full` — also print the complete `cycle.assembly` text (opening,
  positions, debate, notes), not just the `cycle.okrs` voting section,
  since ungrounded claims can appear outside the OKRs too.

Reads cycles via the existing `HistoryStore` (`companion/src/history.ts`),
reusing its load/parsing logic rather than re-implementing JSON access.

**Output** (plain text to stdout, read directly from the Bash tool
result): two blocks per cycle.

1. **Facts sheet** — a fixed set of fields pulled from `cycle.state`:
   - `resources.food` / `resources.drink` (status + quantity)
   - `trade_goods` (count, total value)
   - `military` (equipped counts)
   - `population` (totals, stress breakdown)
   - `zones` / `mining`, when populated
   Pure extraction/formatting of already-known (if currently `unknown`-typed)
   substructures — no interpretation, no scoring.
2. **Narrative** — `cycle.okrs` (already extracted at cycle-run time by
   `extractOkrs()` in `cycle.ts`, so this script does not need to
   re-extract it), plus the full `cycle.assembly` when `--full` is passed.

**Error handling:**

- Unknown `--id`: fail with a clear message listing available cycle ids.
- Empty history: fail with a clear "no cycles recorded yet" message.
- A `status: 'failed'` cycle hit by `--all`: skip it and report
  `skipped: failed cycle` (no `state`/`okrs` payload to show for it)
  rather than erroring the whole run.

**Testing:** `companion/test/eval-grounding.test.ts`, using a vitest
fixture cycle (following the existing `test/fixtures/state.json` style).
Assertions check that the facts sheet surfaces the right data points from
a known fixture and that `cycle.okrs` is passed through unmodified — not
a snapshot of exact text formatting, which stays free to change.

## Workflow (how this actually speeds up the loop)

1. Code touches `collect_state()`-adjacent Lua → the `state-verify` skill
   fires automatically → Claude Code runs the relevant live cross-checks
   via existing MCP tools before trusting the new numbers.
2. A cycle is triggered (companion polling, or a manual
   `dwarven-coop assembly` run through the cycle orchestrator) → it lands
   in `history.json`.
3. Claude Code runs `node companion/scripts/eval-grounding.mjs` (defaults
   to the latest cycle) → reads the facts sheet next to the narrative →
   judges consistency itself.
4. On a mismatch: if the *number* was wrong, that's a Component A concern
   (back to `collect_state()`); if the number was right but the narrative
   misstated it, that's a `prompt.ts` grounding-instruction concern.

## Out of scope for this spec

- Wiring either component into CI or `npm test` as a gating check —
  both are developer-invoked tools for the iteration loop, not automated
  regression gates.
- Expanding `state-verify` coverage beyond the three initial categories.

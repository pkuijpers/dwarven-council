# OKR Staleness Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Claude Code a repeatable method for catching a third failure mode in the `dwarven-coop` OKR loop — a generated OKR for something the player already accomplished in-game, which `collect_state()` never captured, so the LLM had no way to know it was already done.

**Architecture:** A single documentation-only project skill (no code, no new script) at `.claude/skills/okr-staleness-check/SKILL.md`, sitting alongside the existing `state-verify` (catches miscounted numbers) and `eval-grounding` (catches narrative/state contradictions) tools. It documents a 5-step method — get the OKR text, identify its category, write a targeted `lua_eval` check, classify the result into one of three outcomes, hand off confirmed gaps to the normal dev workflow — plus two worked examples grounded in real `dwarven-coop.lua` code paths that already under-capture achievements.

**Tech Stack:** DFHack Lua + the existing MCP tools (`mcp__dfhack__lua_eval`, `mcp__dfhack__coop_assembly`, `mcp__dfhack__coop_briefing`, `mcp__dfhack__dfhack_status`). No TypeScript, no build, no new tests beyond a structural self-check of the skill file.

**Spec:** `docs/superpowers/specs/2026-09-13-okr-staleness-check-design.md`

## Global Constraints

- No automatic OKR classification via code — Claude Code's own reasoning, guided by the documented method (spec "Non-goals").
- No changes to `companion/src/poller.ts` or the cycle pipeline — stays on-demand, not a gate (spec "Non-goals").
- No attempt at exhaustive category coverage — a method plus a few worked examples, not a checklist (spec "Non-goals").
- No implementation of an actual `collect_state()` fix as part of this plan — confirming a gap hands off to the project's normal dev workflow, out of scope here (spec "Non-goals").
- Does not apply to `dwarven-reich.lua` / `dwarven-corp.lua` (spec "Non-goals").

---

## File Structure

- Create: `.claude/skills/okr-staleness-check/SKILL.md` — the method, precondition, worked examples, and outcome classification. Doc only, no code.

---

## Task 1: `okr-staleness-check` project skill

**Files:**
- Create: `.claude/skills/okr-staleness-check/SKILL.md`

**Interfaces:**
- Produces: a project skill discoverable by name `okr-staleness-check`, picked up by the `using-superpowers` rule whenever reviewing a generated OKR for staleness. Nothing else in this plan depends on it.

This task has no automated test — it is a documentation artifact interpreted by Claude Code against a live DFHack session. The "test cycle" is a structural self-check (every required section present) here in Task 1, and a real manual walkthrough against a live fortress in Task 2.

- [ ] **Step 1: Write the skill file**

Create `.claude/skills/okr-staleness-check/SKILL.md`:

````markdown
---
name: okr-staleness-check
description: Check whether a dwarven-coop generated OKR is stale -- already achieved in the live fortress -- by identifying its category, writing a targeted lua_eval check against the running game, and classifying the result as a confirmed collect_state() coverage gap, an existing-but-too-coarse field, or not a state problem at all. Use when the user reports an OKR for something they already did in-game, or when sanity-checking a freshly generated cycle's OKRs before trusting them.
---

# OKR Staleness Check

`state-verify` catches `collect_state()` functions that miscount
something already in scope. `eval-grounding` catches a generated
narrative that contradicts the state JSON it was actually given. Neither
catches a third failure mode: the player already accomplished something
in the running fortress, but the fact was never in scope for
`collect_state()` at all, so the LLM generated a plausible-looking OKR
for something that's already finished.

OKRs are free-form LLM text and can reference almost any achievement a
Dwarf Fortress player can produce. There is no fixed checklist of
categories here (unlike `state-verify`'s three known-bug categories) —
this skill is a method for investigating *any* OKR, plus two worked
examples of the subtler failure shape.

**Precondition:** requires a live DFHack connection with a fortress
loaded (see the MCP prerequisites in the root `CLAUDE.md`). If
`mcp__dfhack__dfhack_status` reports no connection, this check cannot
run — say so rather than guessing.

## The method

1. **Get the OKR text** for the cycle in question — from the user's own
   report, from `node companion/scripts/eval-grounding.mjs` (defaults to
   the latest completed cycle), or from `mcp__dfhack__coop_briefing` to
   check directly against the current live state.

2. **Identify the category** the OKR is about by reading it. No
   classification code — the same judgment call `eval-grounding`'s
   workflow already asks for when assessing narrative grounding.

3. **Write a targeted `lua_eval` query** that checks the specific thing
   the OKR claims still needs doing. It does not need to look like any
   existing `get_*()` aggregation in `dwarven-coop.lua` — the point of
   this skill is exactly that no such aggregation may exist yet. If the
   underlying DFHack struct field isn't already known, introspect it
   live (`for k, v in pairs(x) do print(k, v) end`) rather than guess at
   a field name.

4. **Classify the result** into one of three outcomes:

   - **Confirmed gap** — the live check shows the achievement exists,
     and no field anywhere in `coop_assembly`'s JSON output reflects it,
     even approximately. This is the case this skill exists to catch.
   - **Existing category, wrong granularity** — the achievement is
     visible in the state JSON but too coarse to distinguish "done" from
     "not done" (see the worked examples below). Still a gap worth
     fixing, but the fix refines an existing field/window rather than
     adding a wholly new one.
   - **Not a state problem** — the live check shows the achievement does
     *not* actually exist, or the OKR was invented without a factual
     basis despite the state given being complete and correct. This is
     `eval-grounding`'s territory, not this skill's — don't "fix" it by
     adding more state.

5. **On a confirmed gap or granularity issue**, hand off to the normal
   development workflow: add or extend a `get_*()` field in
   `dwarven-coop.lua`'s `collect_state()` (and the briefing text, if
   that's what the companion prompt actually surfaces), with tests where
   applicable, and run `state-verify` against the new field if it's
   itself an aggregation that could itself be miscounted.

**No matching category is a valid outcome.** Finding that an OKR doesn't
fit anything currently in `collect_state()` at all *is* the confirmed-gap
case — it's not a reason to keep searching for an existing field that
doesn't exist.

## Worked example: temple dedicated to a specific deity

An OKR might read something like "dedicate the new temple to the god of
the forge." `get_locations()` (`dwarven-coop.lua:1228`) already has a
`temples` list (`dwarven-coop.lua:1290-1294`), but each entry is only
`{ name, name_english }` — there is no field recording which deity, if
any, a temple is dedicated to.

Live check (introspect first, since the deity-link field isn't already
known from `collect_state()`'s own code):

```lua
for _, bld in ipairs(df.global.world.world_data.active_site[0].buildings) do
  if df.abstract_building_templest and df.abstract_building_templest:is_instance(bld) then
    print(dfhack.buildings.getName(bld))
    for k, v in pairs(bld) do print(k, v) end
  end
end
```

Look through the printed fields for whatever links the temple to a
deity/religion, and compare against what the OKR claims. If a temple
with that dedication already exists in-game: **existing category, wrong
granularity** — `locations.temples` entries need a deity field, not a
whole new top-level category.

## Worked example: an artifact/event that aged out of the history window

`get_fortress_history()` (`dwarven-coop.lua:893`) only looks back
`lookback_years = 2` (`dwarven-coop.lua:897`) game-years from
`df.global.cur_year`. An OKR referencing an artifact or event further
back than that won't appear in the current cycle's `fortress_history`,
even though the category itself exists and is populated.

Live check (query artifacts directly, unwindowed):

```lua
for _, artifact in ipairs(df.global.world.artifacts.all) do
  local item = artifact.item
  if item then
    print(dfhack.translation.translateName(artifact.name, true))
  end
end
```

Match by name against what the OKR references. If it exists but is
older than 2 years: **existing category, wrong granularity** — but note
the fix here isn't necessarily "add a field," it might be "widen
`lookback_years`" or "add a separate, non-windowed 'notable past
achievements' list" — the diagnosis is the same shape, the eventual fix
can differ from the temple example above.

## Related skills

- `state-verify` — if the fix for a confirmed gap or granularity issue
  is itself a new aggregation (a count, a sum), run `state-verify`'s
  method against it once added.
- `eval-grounding` (`companion/scripts/eval-grounding.mjs`) — if step 4
  lands on "not a state problem," that script's facts-sheet-vs-narrative
  comparison is the right next tool, not this skill.
````

- [ ] **Step 2: Structural self-check**

Read the file back and confirm:
- Valid YAML frontmatter with `name: okr-staleness-check` and a
  `description` covering both trigger cases (user reports a stale OKR;
  Claude Code sanity-checks a fresh cycle).
- A `## The method` section with all 5 numbered steps and all 3
  classification outcomes.
- Exactly two `## Worked example: ...` sections, each containing a
  fenced ` ```lua ` block and an explicit outcome classification.
- A `## Related skills` section naming both `state-verify` and
  `eval-grounding` and which one each classification outcome routes to.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/okr-staleness-check/SKILL.md
git commit -m "Add okr-staleness-check skill for OKR-vs-live-state gaps"
```

---

## Task 2: Validate the skill against a live fortress

**Files:** none created or modified, unless the walkthrough surfaces a
wording fix to `.claude/skills/okr-staleness-check/SKILL.md` (see Step
5).

**Interfaces:** none — this task consumes Task 1's finished skill file
and the live DFHack MCP tools; it produces a validation result reported
to the user, not code.

This task needs a live, loaded Dwarf Fortress with the DFHack MCP server
running, **and** the user's input on which OKR is already known to be
satisfied in-game — it cannot be completed by a subagent working
head-down with no access to either. Run it in the interactive session
with the user present, not dispatched to a fresh background subagent.

- [ ] **Step 1: Confirm DFHack is connected**

Run `mcp__dfhack__dfhack_status`.
Expected: reports an active connection with a fortress loaded. If not,
stop here and tell the user this task is blocked until DFHack is
running with a fortress loaded — do not fabricate a result.

- [ ] **Step 2: Get the current OKRs**

Run `mcp__dfhack__coop_briefing` (or, if the companion has a recorded
cycle you'd rather use, `node companion/scripts/eval-grounding.mjs`).
Expected: readable OKR text for the current or most recent cycle.

- [ ] **Step 3: Ask the user which OKR is already done**

Ask the user to point at one OKR from Step 2's output that they know is
already satisfied in the running fortress (this is the ground truth the
walkthrough checks against — it can't be inferred).

- [ ] **Step 4: Follow the skill's method**

Using `.claude/skills/okr-staleness-check/SKILL.md` from Task 1, work
through steps 1-4 of "The method" against the OKR from Step 3: identify
its category, write a targeted `mcp__dfhack__lua_eval` query, and
classify the result.

Expected: the live check confirms the achievement exists, and the
classification lands on either "confirmed gap" or "existing category,
wrong granularity" (since the user picked an OKR they know is done but
that still got generated as an open OKR — by definition `collect_state()`
missed or under-specified it).

- [ ] **Step 5: Reconcile and, if needed, fix the skill wording**

If following the method in Step 4 was smooth and led to the right
category/outcome on the first pass, no file changes are needed — the
skill is validated as-is.

If the method's wording was ambiguous or missing something needed to
reach the right classification, edit
`.claude/skills/okr-staleness-check/SKILL.md` to fix that gap (e.g. an
extra worked example, a clarified step), then re-run Step 4 against the
same OKR to confirm the fix works.

- [ ] **Step 6: Commit, only if Step 5 changed the file**

```bash
git add .claude/skills/okr-staleness-check/SKILL.md
git commit -m "Refine okr-staleness-check skill based on live walkthrough"
```

If Step 5 made no changes, skip this step — there is nothing to commit.

---

## Self-Review Notes

- **Spec coverage:** precondition, trigger (both cases), the 5-step
  method, all 3 classification outcomes, the "no matching category is
  valid" note, and cross-references to `state-verify`/`eval-grounding`
  — all in Task 1's skill file. The spec's own "Validation" section
  (manual walkthrough against a known-satisfied OKR) — Task 2. Non-goals
  (no classification code, no poller change, no exhaustive coverage, no
  `collect_state()` implementation in this plan, reich/corp excluded) —
  respected by construction; nothing in this plan crosses them.
- **Placeholder scan:** no TBD/TODO; the skill file content in Task 1
  Step 1 is the complete, final document, not a description of what it
  should contain.
- **Type consistency:** N/A — no code, no function signatures across
  tasks. The only cross-task reference is Task 2 reading the exact file
  Task 1 created, at the same path.

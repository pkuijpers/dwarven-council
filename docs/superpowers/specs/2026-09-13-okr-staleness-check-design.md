# OKR staleness check: detecting achievements missing from collect_state()

## Problem

Two eval components already exist for the `dwarven-coop` generation loop
(see `docs/superpowers/specs/2026-09-13-self-runnable-eval-design.md`):

1. `state-verify` (project skill) — catches `collect_state()` functions
   that *miscount* something already in scope (e.g. trade goods
   undercounting, militia armor undercounting).
2. `eval-grounding` (`companion/scripts/eval-grounding.mjs`) — catches a
   generated narrative/OKR that *contradicts* the state JSON it was
   actually given.

Neither catches a third failure mode, which is the one motivating this
spec: the player has already accomplished something in the running
fortress, but the fact of that achievement was never in scope for
`collect_state()` at all — it's not miscounted (component 1) and the
narrative doesn't contradict the state it was handed (component 2), it's
simply that the JSON payload has no field that could tell the LLM "this
is done." The LLM then generates a plausible-looking OKR for something
that's already finished, because from its point of view nothing in the
briefing said otherwise.

This is a coverage gap, not a correctness bug in existing code, and it's
open-ended: OKRs are free-form LLM text and can reference almost any
achievement a Dwarf Fortress player can produce (a specific building, a
specific project, a population/mood milestone, an artifact, a legendary
skill, ...). There is no way to enumerate every category up front the way
`state-verify`'s three categories were enumerated from known bugs.

## Non-goals

- No automatic OKR classification via code. Mapping "OKR text" to "what
  live check would confirm/deny it" stays Claude Code's own reasoning,
  guided by a documented method — not a keyword matcher or an LLM-judge
  API call.
- No change to `companion/src/poller.ts` or the cycle pipeline. This is a
  developer-invoked, on-demand check for speeding up the iteration loop,
  same posture as `eval-grounding` — not a gate and not automatic.
- No attempt at exhaustive category coverage. This ships a method plus a
  few worked examples, not a checklist meant to cover every possible OKR.
- No implementation of the actual `collect_state()` fix once a gap is
  confirmed. That follows this project's normal development workflow
  (TDD, and `state-verify` for the new field if it's itself an
  aggregation that can be miscounted) and is out of scope for this spec.
- Does not apply to `dwarven-reich.lua` / `dwarven-corp.lua` (no
  companion app, manual copy/paste workflow, out of scope — same
  exclusion as the prior eval spec).

## Component: `okr-staleness-check` project skill

A new project skill at `.claude/skills/okr-staleness-check/SKILL.md`,
alongside (not merged into) `state-verify`. It stays separate because it
answers a different question — "is this category missing from
`collect_state()` entirely" rather than "is this category's count
wrong" — and merging it would dilute `state-verify`'s narrow, accurate
trigger description.

**Precondition:** same as `state-verify` — requires a live DFHack
connection with a fortress loaded. States this explicitly; if
`mcp__dfhack__dfhack_status` reports no connection, says so rather than
guessing.

**Trigger:** reviewing whether a companion-generated OKR is stale or
already achieved in-game — whether prompted by the user reporting "I
already did this" or by Claude Code itself sanity-checking a freshly
generated cycle's OKRs before trusting them.

**Workflow the skill documents:**

1. **Get the OKR text** for the cycle in question — from the user's own
   report, from `node companion/scripts/eval-grounding.mjs` (defaults to
   the latest completed cycle), or from `mcp__dfhack__coop_briefing` for
   a check against the current live state directly.
2. **Identify the category** the OKR is about by reading it — no
   classification code. This is the same judgment call
   `eval-grounding`'s workflow already asks Claude Code to make when
   assessing narrative grounding.
3. **Write a targeted `lua_eval` query** that checks the specific thing
   the OKR claims needs doing — not necessarily shaped like any existing
   `get_*()` aggregation, since the point is exactly that no such
   aggregation may exist yet. E.g. "does a temple zone dedicated to god X
   exist" or "does any squad have a legendary-or-better weapon skill
   member," rather than a generic zone/military count.
4. **Classify the result** into one of three outcomes:
   - **Confirmed gap**: the live check shows the achievement exists, and
     no field anywhere in `coop_assembly`'s JSON output reflects it, even
     approximately. This is the case this skill exists to catch.
   - **Existing category, wrong granularity**: the achievement is
     visible in the state JSON but too coarse to distinguish "done" from
     "not done" (e.g. `zones` reports a count of temples but not which
     god each is dedicated to, or a `fortress_history` event scrolled out
     of the window shown to the LLM by the time the next cycle ran).
     Still a gap worth fixing, but the fix is refining an existing field
     rather than adding a wholly new one.
   - **Not a state problem**: the live check shows the achievement does
     *not* actually exist, or the OKR was simply invented without a
     factual basis, despite the state given being complete and correct.
     This is a prompt/grounding issue for `eval-grounding`'s workflow —
     not this skill's territory, and not something to "fix" by adding
     more state.
5. **On a confirmed gap or granularity issue**, hand off to the normal
   development workflow: add or extend a `get_*()` field in
   `dwarven-coop.lua`'s `collect_state()` (and the briefing text, if the
   briefing is what the companion prompt actually surfaces), with tests
   where applicable, and run `state-verify` against the new field if it's
   itself an aggregation.

**Content structure of the skill file:**

- The method above (steps 1-5) as the primary content — this is what
  generalizes to OKR types nobody has seen yet.
- 2-3 worked examples illustrating the "existing category, wrong
  granularity" case specifically, since that's the subtler of the three
  outcomes to recognize: a zones/locations example (count exists, target
  identity doesn't) and a fortress-history example (event existed once
  but aged out of the window passed to the LLM).
- An explicit "no matching category is a valid outcome" note — finding
  that an OKR doesn't fit anything currently in `collect_state()` is
  itself the confirmed-gap case, not a reason to widen the search for an
  existing field that doesn't exist.

## Workflow (how this fits the existing eval tooling)

1. A cycle runs (companion polling, or a manual trigger) → OKRs land in
   `history.json`.
2. The user notices an OKR for something already done, or Claude Code
   proactively checks a freshly generated cycle → `okr-staleness-check`
   fires.
3. Claude Code follows the skill's method against the live fortress via
   existing MCP tools (`mcp__dfhack__lua_eval`, `mcp__dfhack__coop_assembly`,
   `mcp__dfhack__coop_briefing`) — no new tooling beyond the skill
   document itself.
4. Outcome routes to: this skill's own fix path (confirmed gap /
   granularity), `eval-grounding`'s territory (not a state problem), or
   `state-verify` (if the new/extended field turns out to need its own
   independent recomputation check).

## Validation

A skill file has no unit tests. Validation is a single manual
walkthrough once the skill is written: pick an OKR from the user's
current fortress that's known to already be satisfied in-game, confirm
the skill's method leads Claude Code to the right `lua_eval` query and
the correct outcome classification, before considering the skill done.

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

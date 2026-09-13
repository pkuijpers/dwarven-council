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

Not every `df.item_X`/`df.item_Xst` type is defined on every DFHack
build (e.g. `df.item_craftst` and `df.item_amulettst` are `nil` on some
builds). Every alternate query below therefore guards each type check as
`df.item_X and df.item_X:is_instance(item)` instead of assuming the type
exists — this mirrors how the production Lua (see `get_trade_goods()` in
`dwarven-coop.lua`) already guards its own type checks, and the alt-check
snippets must too, or they crash with `attempt to index a nil value`.

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
    (df.item_craftst and df.item_craftst:is_instance(item)) or
    (df.item_toyst and df.item_toyst:is_instance(item)) or
    (df.item_instrumentst and df.item_instrumentst:is_instance(item)) or
    (df.item_gobletst and df.item_gobletst:is_instance(item)) or
    (df.item_totemst and df.item_totemst:is_instance(item)) or
    (df.item_statuest and df.item_statuest:is_instance(item)) or
    (df.item_figurinest and df.item_figurinest:is_instance(item)) or
    (df.item_amulettst and df.item_amulettst:is_instance(item)) or
    (df.item_ringst and df.item_ringst:is_instance(item)) or
    (df.item_earringst and df.item_earringst:is_instance(item)) or
    (df.item_braceletst and df.item_braceletst:is_instance(item)) or
    (df.item_scepterst and df.item_scepterst:is_instance(item)) or
    (df.item_crownst and df.item_crownst:is_instance(item))
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
    (df.item_armorst and df.item_armorst:is_instance(item)) or
    (df.item_helmst and df.item_helmst:is_instance(item)) or
    (df.item_glovesst and df.item_glovesst:is_instance(item)) or
    (df.item_pantsst and df.item_pantsst:is_instance(item)) or
    (df.item_shoesst and df.item_shoesst:is_instance(item))
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
  if ((df.item_foodst and df.item_foodst:is_instance(item)) or
      (df.item_fishst and df.item_fishst:is_instance(item)) or
      (df.item_fish_rawst and df.item_fish_rawst:is_instance(item)) or
      (df.item_meatst and df.item_meatst:is_instance(item)) or
      (df.item_plantst and df.item_plantst:is_instance(item))) and item.pos.x ~= -30000 then
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

<!--
  This is a HAND-AUTHORED SYNTHETIC EXAMPLE for testing, not a captured
  real Anthropic API response. Task 8 (companion/src/anthropic.ts) had no
  ANTHROPIC_API_KEY available in its environment, so it could not make a
  real call and capture the actual response format. This fixture was
  written to match the exact documented output format from
  companion/src/prompt.ts's buildSystemPrompt (the "## Output Format"
  section), grounded in the faction names, spokespersons, and fortress
  state from test/fixtures/raw-assembly-output.txt (Bellspants / Rithlerom,
  Year 106) so downstream tests exercise a realistic shape.

  A real captured response will replace or supplement this fixture later
  in the plan, at Task 14, once the user supplies their own API key.
-->

### [OPENING] Opening Assembly

The General Assembly of the Dwarven Cooperative of Bellspants convenes on the 17th of Felsite, Year 106. Chairperson Urist Adagcatten, speaking for the Services Sector as the largest voting bloc, calls the meeting to order.

"Forty eligible voters, fifty-one members strong. We need twenty-one votes for quorum, and I count considerably more than that in the hall tonight. Let the record show: quorum is established. The Cooperative is abundant in food and coin but running thin on drink, and our militia numbers five where it should number more. Let's get to it."

### [POSITIONS] Faction Positions

**Services Sector** (19 votes, 47%) — Urist Adagcatten: "Trade relations and efficient management got us this far. We back sound infrastructure and won't spend our majority carelessly, but we won't block reasonable requests from the smaller halls either."

**Producers Collective** (9 votes, 22%) — Zon Astcatten: "The forges are cold half the season for want of ash and coal hauling. Give us a masterwork push and the wealth we bring back will fund everyone's wishlist twice over."

**Food Council** (7 votes, 17%) — Tosid Athelisram: "Wine cellars are near empty — six barrels of beer left in the whole fortress. Abundant meals mean nothing if there's nothing to wash them down with. This is the Council's one ask tonight, and it isn't optional."

**Delvers Guild** (3 votes, 7%) — Urvad Edosducim: "Three votes doesn't buy much, but it buys ore. Malachite and native platinum sit unmined a few z-levels down. We ask the Assembly not to forget the tunnels while it argues about tankards."

**Care Collective** (1 vote, 2%) — Tobul Eribmokez: "One vote, but I'll use it for the hospital. Zero doses of pain-numbing powder against a desired stock of seven hundred fifty is not a number I can accept quietly."

**Defenders Union** (1 vote, 2%) — Stinthad Unulnoram: "Five in the militia for fifty-one souls. I know I'm asking a small hall's favor from a large hall's purse, but goblins don't count votes before they raid."

### [DEBATE] Debate

Tosid Athelisram opens by tabling the drink shortage first, over Zon Astcatten's objection that it should follow the forge motion. Urist Adagcatten sides with the Food Council on ordering: "A dry Cooperative is a cranky Cooperative — we vote on beer before bars." Zon concedes the point but presses for a guaranteed second slot for the workshop motion, which the chair grants.

When Stinthad Unulnoram raises the militia question, Zon Astcatten is openly skeptical: "Five soldiers pulled off the line is five fewer hands at the forge, and we've had no raid in two years." Urvad Edosducim and Tobul Eribmokez side with the Defenders Union anyway, forming a three-vote minority bloc, but Urist Adagcatten is noncommittal — "Services will hear the motion, but I won't promise the Sector's votes for it" — and Tosid Athelisram signals the Food Council will abstain rather than referee a fight that isn't theirs. The small-hall coalition is short of what it needs against a skeptical majority, and everyone in the room can do that arithmetic before a single vote is cast.

### [VOTING] Voting

#### Motion 1: Restock the Drink Cellars
Submitted by: Food Council
- KR1: Brew at least 300 units of dwarven drink (beer, wine, rum, or ale combined) before the next Assembly
- KR2: Raise the still's operating time to cover both day shifts, adding a second brewer if the Producers Collective can spare one
- KR3: Keep the fortress-wide drink supply above 60 days at all times this quarter

**Vote Result:**
- For: 27 votes (Food Council, Services Sector, Care Collective)
- Against: 12 votes (Producers Collective, Delvers Guild)
- Abstain: 1 vote (Defenders Union)
- [PASS] ADOPTED

#### Motion 2: Forge Quarter Production Push
Submitted by: Producers Collective
- KR1: Complete at least 2 masterwork-quality items at the Metalsmiths' Forge or Craftsdwarfs' Workshop
- KR2: Convert half of the unmined iron and copper ore backlog into bars before the season ends
- KR3: Grow the Cooperative's accumulated wealth from 129,015 ☐ by at least 15%

**Vote Result:**
- For: 31 votes (Producers Collective, Services Sector, Delvers Guild)
- Against: 7 votes (Food Council)
- Abstain: 2 votes (Care Collective, Defenders Union)
- [PASS] ADOPTED

#### Motion 3: Expand the Militia
Submitted by: Defenders Union
- KR1: Recruit and equip 3 additional militia dwarves, bringing the standing force to 8
- KR2: Outfit every squad member with at least steel-grade weaponry, replacing the copper battle axe currently in service
- KR3: Add one fortification and one set of cage traps to the entrance defenses

**Vote Result:**
- For: 5 votes (Defenders Union, Delvers Guild, Care Collective)
- Against: 28 votes (Services Sector, Producers Collective)
- Abstain: 7 votes (Food Council)
- [FAIL] REJECTED

### [NOTE] Minutes

Quorum was met and held for the full session (40 eligible voters present against a 21-vote threshold). Two of three motions passed: the Food Council's drink-restocking motion carried comfortably on a broad coalition, and the Producers Collective's forge push passed on the strength of the Services Sector's swing vote. The Defenders Union's militia expansion fell well short, opposed by the two largest factions on efficiency grounds; the Care Collective's hospital shortage (powder stock at 0 of a desired 750) went unaddressed this session and should be expected to resurface as its own motion next Assembly. Advice to the overseer: the drink and wealth OKRs are well-supported and should be prioritized in labor assignment; the militia gap remains real even though the motion failed, and a smaller, cheaper defense proposal may fare better next quarter than the rejected one did.

# Dwarven Governance

**OKR-based gameplay addons for Dwarf Fortress** — because even dwarves need management methodologies.

Each quarter, your fortress generates Objectives and Key Results through an AI-powered governance simulation. Your job as overseer is to execute on those OKRs before the next quarterly meeting.

Choose your preferred system of government:

| Script | System | Decision Style |
|--------|--------|----------------|
| `dwarven-coop.lua` | Democratic Cooperative | General Assembly with faction voting |
| `dwarven-reich.lua` | Authoritarian Regime | Absolute decrees from the Stonefather |
| `dwarven-corp.lua` | Corporate Enterprise | Quarterly Business Reviews with C-Suite |

All scripts run entirely within DFHack — no external processes required.

---

## Features

- **Automatic state extraction** — population, resources, military, morale, recent events
- **Faction/loyalty analysis** — dwarves grouped by profession with competing priorities  
- **LLM-generated narrative** — entertaining quarterly meetings with distinct personalities
- **Measurable OKRs** — specific, actionable goals tied to actual game state
- **Session logging** — JSON records of each quarterly meeting

---

## Installation

### Requirements

- Dwarf Fortress with [DFHack](https://docs.dfhack.org/) installed
- `curl` available on your system (standard on Linux/macOS, available on Windows)
- An [Anthropic API key](https://console.anthropic.com/)

### Setup

1. **Copy the script(s)** to your DFHack scripts folder:
   ```bash
   cp dwarven-coop.lua <DF>/hack/scripts/
   cp dwarven-reich.lua <DF>/hack/scripts/
   cp dwarven-corp.lua <DF>/hack/scripts/
   ```

2. **Set your API key** (choose one method):
   ```bash
   # Option A: Environment variable (recommended)
   export ANTHROPIC_API_KEY=sk-ant-xxxxx
   
   # Option B: Edit the CONFIG section at the top of the script
   ```

3. **Launch Dwarf Fortress** and open the DFHack console.

---

## Usage

### Democratic Cooperative

The dwarves have organized as a worker-owned cooperative. Every adult dwarf has one vote in the quarterly General Assembly.

```
dwarven-coop assembly   — Hold the General Assembly (generates OKRs)
dwarven-coop briefing   — Show current cooperative status
dwarven-coop members    — Display faction breakdown with vote counts
dwarven-coop status     — Quick one-line status
```

**Factions** are determined by profession:

| Faction | Members | Priorities |
|---------|---------|------------|
| Producers Collective | Craftsdwarves, smiths, masons | Workshop efficiency, masterworks |
| Food Council | Farmers, cooks, brewers | Food security, alcohol production |
| Delvers Guild | Miners, mechanics | Expansion, ore discovery |
| Defenders Union | Military dwarves | Defense, training, equipment |
| Care Collective | Doctors, caretakers | Healthcare, morale, wellness |
| Services Sector | Traders, haulers, others | Trade relations, management |

Larger factions have more votes, but coalitions can form. Motions require 50%+1 to pass.

---

### Authoritarian Reich

The fortress lives under the absolute rule of the Stonefather (your expedition leader). His word is law, carved in granite.

```
dwarven-reich decree    — The Stonefather issues Granite Decrees (OKRs)
dwarven-reich report    — View secret status report  
dwarven-reich status    — Quick one-line status
```

**The Council of Iron** advises (but never decides):

| Title | Role |
|-------|------|
| Grand Smith | Production Advisor |
| Supreme Minelord | Expansion Advisor |
| War Marshal | Defense Advisor |
| Provisions Intendant | Supplies Advisor |
| Propaganda Master | Morale Advisor |

The regime tracks a **Loyalty Index** instead of happiness, and identifies "idle elements" and "potential dissidents" rather than unemployed or stressed dwarves.

---

### Corporate Enterprise

Your fortress is now a Fortune 500 company. Every quarter, the C-Suite convenes for a Quarterly Business Review filled with synergy, alignment, and strategic pivots.

```
dwarven-corp qbr        — Quarterly Business Review (generates OKRs)
dwarven-corp dashboard  — Executive dashboard with KPIs
dwarven-corp org        — Org chart with headcount by business unit
dwarven-corp status     — Quick one-line status
```

**The C-Suite:**

| Title | Role | Personality |
|-------|------|-------------|
| CEO | Chief Executive Officer | Speaks only in vague inspirational statements |
| COO | Chief Operating Officer | Obsessed with processes and flowcharts |
| CFO | Chief Financial Officer | Sees everything as a spreadsheet |
| CHRO | Chief Human Resources Officer | Insists the company is "a family" |
| CTO | Chief Technology Officer | Wants to rewrite everything from scratch |
| CSO | Chief Security Officer | Assumes every caravan is a potential breach |

**Business Units** (mapped from professions):

| Code | Business Unit | Functions |
|------|---------------|-----------|
| MFG | Manufacturing & Production | Craftsdwarves, smiths, masons |
| REX | Resource Extraction | Miners, mechanics |
| F&B | Food & Beverage Division | Farmers, cooks, brewers |
| SEC | Corporate Security | Military dwarves |
| H&W | Health & Wellness | Doctors, caretakers |
| OPS | Operations & Logistics | Traders, haulers |

The corporate version reframes everything:
- Stressed dwarves → "Disengaged employees" with low eNPS scores
- Deaths → "Unplanned attrition events"  
- Goblin siege → "Hostile M&A attempt"
- Migrants → "Talent acquisition pipeline"
- Idle dwarves → "Underutilized resources"

---

## Example Output

### Cooperative — General Assembly

```
## 🗳️ Assembly Quorum
**Total members:** 87 dwarves
**Eligible voters:** 73 adults (children: 14)
**Quorum:** 37 votes required for decision (50%+1)

## 📊 Faction Distribution
  ████████░░░░░░░░░░░░ Producers Collective: 24 votes (32%)
  █████░░░░░░░░░░░░░░░ Delvers Guild: 16 votes (21%)
  ████░░░░░░░░░░░░░░░░ Defenders Union: 14 votes (19%)
  ...

### 🗳️ Voting

#### Motion 1: Strengthen Collective Defense
Submitted by: Defenders Union
- KR1: Recruit and train 8 new militia members
- KR2: Produce 20 iron weapon sets
- KR3: Complete eastern drawbridge

**Vote Result:**
- For: 58 votes (Defenders, Producers, Delvers, Services)
- Against: 0 votes
- Abstain: 15 votes (Food Council, Care Collective)
- ✅ ADOPTED with 79% support
```

### Reich — Granite Decree

```
### 👑 The Stonefather Speaks

"Children of the Mountain. Beyond our gates stands the enemy. 
They believe us WEAK. They believe us AFRAID."

A long silence.

"They are mistaken."

### ⚒️ GRANITE DECREE 2-Spring

#### Decree I: Break the Green Tide
*"Let every goblin who enters our mountain never leave — 
except as fertilizer for our mushrooms."*

- Demand 1: Recruit and train 10 new militia to combat readiness
- Demand 2: Produce 30 iron weapons (swords, axes, or hammers)
- Demand 3: Zero civilian casualties from goblin activity this quarter

Responsible: War Marshal
Penalty for failure: Permanent assignment to the Front Line
```

### Corporate — Quarterly Business Review

```
## 📊 FY126 Q1 Quarterly Business Review

### Opening Remarks (CEO)

*Urist McLeader adjusts his masterwork microlite tie*

"Team, before we dive into the numbers, I want to take a moment to 
acknowledge the incredible journey we've been on. When I look around 
this room—and I mean this—I see not just colleagues, but a family. 
A family that MOVES MOUNTAINS. Literally."

*Polite laughter from the C-Suite*

"Now, I know Q4 presented some... headwinds. The hostile M&A attempt 
from Goblin Capital Partners was unexpected. But what did we do? We 
PIVOTED. We ADAPTED. And today, I'm proud to say our perimeter 
remains unbreached."

### Executive Readouts

**COO:** "Thanks, chief. So, looking at operational throughput, we're 
seeing some friction in our manufacturing pipeline. Workshop utilization 
is at 73%—below our 85% target. I've asked the team to do a deep-dive 
on root causes. We'll circle back next week with a action plan."

**CFO:** "Financially, we're in a solid position. Total asset base of 
1.2M dwarfbucks, with a gross margin of 78%. However, I want to flag 
that our beverage inventory is trending downward. If we don't course-
correct, we could see impact to employee engagement metrics."

**CHRO:** "Speaking of engagement, our latest eNPS came in at 62. That's 
above benchmark, but I'm concerned about the six team members flagged 
as 'actively disengaged.' I'd like to propose a wellness initiative—
perhaps a team-building event in the new temple?"

### FY126 Q1 OKRs

**Objective 1: Optimize Supply Chain Resilience**
*Strategic Pillar: Operational Excellence*
- KR1: Increase food inventory runway to 120+ days
- KR2: Expand beverage production capacity by 50% (3 new stills)
- KR3: Achieve 95% stockpile organization score

Owner: COO
Dependencies: Resource Extraction team capacity
```

---

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│                    DFHack Lua Script                    │
├─────────────────────────────────────────────────────────┤
│  1. Extract game state from DF memory structures        │
│  2. Analyze population, resources, threats              │
│  3. Generate markdown briefing                          │
│  4. Call Claude API via curl subprocess                 │
│  5. Display narrative + OKRs                            │
│  6. Save session to /tmp/dwarven-{coop,reich}/          │
└─────────────────────────────────────────────────────────┘
```

The scripts access Dwarf Fortress internals through DFHack's Lua API:
- `df.global.world.units.active` — all units including citizens
- `df.global.world.items.all` — items for food/drink counting
- `df.global.world.squads.all` — military organization
- `df.global.world.status.announcements` — recent events
- `dfhack.units.*` — helper functions for unit analysis

HTTP calls use `curl` via `os.execute()` since DFHack Lua has no native HTTP client. This is blocking, but acceptable for quarterly meetings.

---

## Configuration

Edit the `CONFIG` table at the top of either script:

```lua
local CONFIG = {
    -- LLM settings
    api_key = os.getenv("ANTHROPIC_API_KEY") or "your-api-key-here",
    model = "claude-sonnet-4-20250514",
    api_url = "https://api.anthropic.com/v1/messages",
    
    -- Output location for session logs
    output_dir = "/tmp/dwarven-coop",
}
```

### Using a Different LLM

The scripts are designed for Claude, but can be adapted for other APIs by modifying the `call_llm()` function. You'll need to adjust:
- The request JSON structure
- HTTP headers
- Response parsing

---

## Session Logs

Each quarterly meeting is saved as a JSON file:

```
/tmp/dwarven-coop/assembly_126_Spring.json
/tmp/dwarven-reich/decree_126_Spring.json
/tmp/dwarven-corp/qbr_FY126_Q1.json
```

Contents include:
- Game date and fortress name
- Full briefing/report
- Generated narrative and OKRs
- Faction breakdown (coop) or loyalty index (reich)
- Timestamp

---

## Limitations

- **Blocking API calls** — the game pauses during LLM requests (typically 5-15 seconds)
- **No auto-trigger** — you must manually run the command each quarter
- **Session storage** — logs are saved to `/tmp/` which clears on reboot
- **Read-only** — the scripts analyze state but don't modify the game

---

## Future Ideas

- [ ] Auto-trigger on season change via DFHack events
- [ ] OKR evaluation at end of quarter (did you meet the goals?)
- [ ] Persistent history across sessions
- [ ] Local LLM support (Ollama)
- [ ] More governance systems (theocracy, merchant republic, military junta, anarcho-syndicalist commune?)

---

## Contributing

Pull requests welcome. Strike the earth!

---

## License

MIT

---

## Acknowledgments

- [Bay 12 Games](http://www.bay12games.com/) for Dwarf Fortress
- [DFHack](https://dfhack.org/) for making this possible
- [Anthropic](https://www.anthropic.com/) for Claude

*"One People. One Mountain. One Stonefather."*  
*— or —*  
*"For the Cooperative!"*  
*— or —*  
*"Let's circle back and align on our strategic priorities!"*

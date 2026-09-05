# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dwarven Governance is a set of DFHack Lua addons for Dwarf Fortress that generate OKRs (Objectives and Key Results) through AI-powered governance simulations. Three scripts implement different governance systems: democratic cooperative, authoritarian regime, and corporate enterprise.

All three scripts run entirely within DFHack using Lua. `dwarven-reich.lua` and `dwarven-corp.lua` never call an LLM themselves — they print a prompt for you to paste into an LLM interface by hand (both have a `CONFIG.api_key` field, but it's dead code: nothing reads it or makes an HTTP call). `dwarven-coop.lua` is different: its `assembly` command exports fortress state as JSON rather than printing a prompt, and a separate Node.js/TypeScript service — the companion app in `companion/` — polls for season changes, runs `assembly`, and calls the Claude API directly via the Anthropic SDK (no `curl`, no subprocess).

## Commands

### Testing Scripts

Scripts must be copied to the DFHack scripts folder to test. Use the provided install script:

```bash
./install.sh
```

For manual installation (Steam flatpak):
```bash
# DFHack directories for this system:
DF_BASE="$HOME/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Dwarf Fortress"

# Copy all scripts to scripts directory
cp dwarven-coop.lua dwarven-reich.lua dwarven-corp.lua "$DF_BASE/hack/scripts/"
```

Then run from the DFHack console within Dwarf Fortress:

```
# Cooperative commands
dwarven-coop assembly
dwarven-coop briefing
dwarven-coop status
dwarven-coop members

# Reich commands
dwarven-reich decree
dwarven-reich report
dwarven-reich status

# Corporate commands
dwarven-corp qbr
dwarven-corp dashboard
dwarven-corp org
dwarven-corp status
```

### Development Workflow

There is no build process. Edit Lua files directly and reload in DFHack.

### MCP Server for Live Testing

An MCP server is available that connects directly to DFHack's remote interface. This allows you to test scripts and query game state without manual copy-pasting.

**Available MCP Tools:**

| Tool | Usage |
|------|-------|
| `mcp__dfhack__dfhack_status` | Verify DFHack connection is active |
| `mcp__dfhack__dfhack_command` | Run any DFHack command (e.g., `ls`, `help`) |
| `mcp__dfhack__coop_status` | Quick fortress status one-liner |
| `mcp__dfhack__coop_members` | Faction breakdown with vote counts |
| `mcp__dfhack__coop_briefing` | Full markdown briefing (most useful for debugging) |
| `mcp__dfhack__coop_assembly` | Generate complete LLM prompt |
| `mcp__dfhack__prospect` | Show ores, gems, mineral veins |
| `mcp__dfhack__lua_eval` | Evaluate Lua code directly in DFHack |
| `mcp__dfhack__dfhack_help` | Get help for any DFHack command |

**Typical Development Workflow:**

1. Edit the Lua script in this repo
2. Run `./install.sh` to copy to DFHack
3. Use `mcp__dfhack__coop_briefing` to test output
4. Check for errors with `mcp__dfhack__dfhack_command` running `dwarven-coop status`
5. Use `mcp__dfhack__lua_eval` to test individual Lua expressions

**Example: Testing a Lua expression**
```
mcp__dfhack__lua_eval with code: "#df.global.world.units.active"
→ Returns the number of active units
```

**Example: Running arbitrary DFHack commands**
```
mcp__dfhack__dfhack_command with command: "help" args: ["dwarven-coop"]
→ Shows help text for the dwarven-coop script
```

**Prerequisites:**
- Dwarf Fortress must be running with a fortress loaded
- DFHack remote server runs automatically on port 5000
- MCP server must be built: from the repo root, `npm install` (once, for the whole npm workspace), then `npm run build` (builds `shared/dfhack-client`, `mcp-server`, and `companion`) — or `npm run build -w mcp-server` to build just the MCP server

### Companion App (Cooperative Only)

`companion/` is a separate Node.js/TypeScript service that automates the
`dwarven-coop` OKR workflow: it polls DFHack for the in-game season, runs
`dwarven-coop assembly` when a new quarter starts, calls the Claude API
directly (Anthropic SDK), and serves the result plus history over a web UI
(SSE-updated). It replaces `dwarven-coop`'s copy-paste-into-an-LLM workflow.

**`dwarven-reich.lua` and `dwarven-corp.lua` are unaffected** — they still
use the original manual workflow (print a prompt, paste it into an LLM
yourself); there is no reich/corp equivalent of the companion app.

To run it:
```bash
cd companion
npm install       # or rely on the root workspace install above
cp .env.example .env   # fill in ANTHROPIC_API_KEY; other vars have defaults
npm run build && npm start
# or during development:
npm run dev
```

Key env vars (`companion/.env.example`): `ANTHROPIC_API_KEY` (required),
`DFHACK_HOST`/`DFHACK_PORT`, `COMPANION_PORT`, `POLL_INTERVAL_MS`,
`CLAUDE_EFFORT`, `DATA_DIR` (where `history.json` is written). Tests:
`npm test -w companion` from the repo root. See `companion/README.md` for
the full HTTP API and data format.

### Testing Installation

Run the test script to verify installation:
```bash
./test-installation.sh
```

This checks if scripts are installed and shows log file locations.

### Verifying Scripts Work

After installation, test in the DFHack console:

1. **Check if script loads**: Type `dwarven-coop` (without arguments)
   - Should display help text
   - If you see "command not found", the script isn't installed correctly
   - If you see Lua errors, check `stderr.log`

2. **Run a simple command**: `dwarven-coop status`
   - Should show fortress info in one line
   - Any Lua errors will appear in red in the DFHack console

3. **Monitor logs in real-time** (in separate terminal):
   ```bash
   tail -f ~/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Dwarf\ Fortress/stderr.log
   ```

### DFHack Log Files

Key log files for debugging:

- `stderr.log` - DFHack output, script invocations, Lua errors (main log to watch)
- `stdout.log` - Standard output
- `errorlog.txt` - Critical errors
- `gamelog.txt` - Game events

All located in the Dwarf Fortress installation directory.

## Architecture

### Shared Script Pattern

All three scripts follow the same architectural pattern, though `dwarven-coop.lua` has diverged on points 3 and 7:

1. **Utility Functions** - `safe_get()`, `plural()`, `pct()`, `status_indicator()` for error handling and formatting
2. **DFHack API Helpers** - `translate_name()`, `is_military()`, `get_fortress_info()`, `get_buildings_summary()` with compatibility for old/new DFHack APIs
3. **Configuration** (`CONFIG` table) - API key, model, output directory. Present in `dwarven-reich.lua`/`dwarven-corp.lua` (with `api_key`/`model`/`api_url` fields that are dead code — nothing reads them). `dwarven-coop.lua` has no `CONFIG` table at all.
4. **Governance Structure** - Faction/council/C-suite definitions with profession mappings (governance-specific)
5. **State Collection** - Extract game data via DFHack API
6. **Report Generation** - Create markdown briefings from game state
7. **Prompt Generation** - `dwarven-reich.lua`/`dwarven-corp.lua` build system and user prompts and print the combined prompt for manual copy/paste to an LLM (`build_system_prompt()`, `build_user_prompt()`, `print_llm_prompt()`). `dwarven-coop.lua` has none of these functions; its `cmd_assembly()` instead JSON-encodes state and briefing for the companion app (`companion/src/prompt.ts` builds the prompt on that side).
8. **Command Handlers** - Functions like `cmd_assembly()`, `cmd_decree()`, `cmd_qbr()`
9. **Entry Point** - Argument parsing with `argparse.processArgsGetopt()`

### State Collection Pipeline

`dwarven-reich.lua` and `dwarven-corp.lua` still follow the original, fully manual flow:

```
DFHack Memory → collect_state() → Briefing/Report → LLM Prompt (printed) → manual copy/paste → Claude → OKRs (pasted back manually)
```

`dwarven-coop.lua` no longer prints an LLM prompt at all. Its `assembly` command exports state as JSON, and the companion app (`companion/`, Node.js/TypeScript) does the prompt-building and the actual Claude API call:

```
DFHack Memory → collect_state() → JSON export (assembly) → companion app (prompt building, TypeScript) → Claude API (Anthropic SDK) → OKRs → companion/data/history.json + web UI
```

The `collect_state()` function aggregates data from:
- `get_date()` - Current game date
- `get_fortress_info()` - Fortress name and location
- `analyze_population()` - Dwarves grouped by profession into factions/units/councils
- `get_resources()` - Food, drink, wealth from `df.global.world.items.all`
- `get_military()` - Squad counts from `df.global.world.squads.all`
- `get_buildings_summary()` - Building counts
- `get_recent_events()` - Announcements from `df.global.world.status.announcements`

### DFHack API Access

Scripts access Dwarf Fortress memory structures through DFHack's Lua API:

- `df.global.world.units.active` - All units including citizens
- `df.global.world.items.all` - Items for counting food/drink
- `df.global.world.squads.all` - Military organization
- `df.global.world.status.announcements` - Recent game events
- `df.global.world.buildings.all` - Building inventory
- `dfhack.units.*` - Helper functions for unit analysis (age, profession, etc.)

### Faction/Organization Systems

Each script organizes dwarves differently by mapping professions to groups:

- **dwarven-coop.lua**: 6 factions (Producers, Food Council, Delvers, Defenders, Caregivers, Services) with democratic voting
- **dwarven-reich.lua**: Council of Iron (5 advisors) with loyalty tracking
- **dwarven-corp.lua**: 6 business units (MFG, REX, F&B, SEC, H&W, OPS) with C-suite executives

All use the same profession categorization logic but different narrative framing.

### LLM Integration

**`dwarven-reich.lua` / `dwarven-corp.lua` — manual, unchanged.** The `print_llm_prompt()` function in each script:

1. Combines system and user prompts into a single text block
2. Prints the combined prompt to stdout
3. User can then copy/paste this prompt into any LLM interface (Claude.ai, API playground, etc.)

**Workflow:**
1. Run command (e.g., `dwarven-reich decree`)
2. Script gathers fortress state and generates a report
3. Script builds system and user prompts (`build_system_prompt()`, `build_user_prompt()`)
4. Script prints combined prompt to console
5. User copies prompt and pastes it into their preferred LLM interface
6. LLM generates OKRs based on current fortress state

**`dwarven-coop.lua` — automated via the companion app.** `dwarven-coop.lua` has no `build_system_prompt()`/`build_user_prompt()`/`print_llm_prompt()`. Instead:

1. The companion app (`companion/`) polls DFHack and detects a season change
2. It runs `dwarven-coop assembly`, which prints `state` + `briefing` as a JSON payload (see `dwarven-coop.lua`'s `cmd_assembly()`)
3. `companion/src/prompt.ts` (`buildSystemPrompt()`, `buildUserPrompt()` — ported from the Lua originals, verified byte-for-byte against a golden file) builds the prompt from that payload
4. `companion/src/anthropic.ts` calls the Claude API directly via the Anthropic SDK
5. The cycle (briefing, narrative, OKRs, success/failure) is recorded to `companion/data/history.json` and pushed to the web UI over SSE

### Prompt Architecture

Two-stage prompt generation, present in `dwarven-reich.lua`/`dwarven-corp.lua` as Lua functions and in the companion app as `companion/src/prompt.ts` (for coop):

1. **System Prompt** (`build_system_prompt()` / `buildSystemPrompt()`) - Sets governance context, personalities, and OKR format
2. **User Prompt** (`build_user_prompt()` / `buildUserPrompt()`) - Contains briefing/report and assembly/meeting context

System prompts define the narrative voice and OKR structure. User prompts provide current game state and constraints (available workforce, threats, resources).

## Key Implementation Details

### Error Handling

All DFHack memory access uses `safe_get()` with pcall to handle nil values gracefully, since game structures may not always be initialized.

### Profession Mapping

Each dwarf is assigned to exactly one faction/unit/council based on their profession. The `get_faction_for_profession()` / `get_business_unit()` functions iterate through profession lists to find matches. Unmapped professions default to the "Services" group.

### Dependencies

Required Lua modules (provided by DFHack):
- `argparse` - Command-line argument parsing
- `utils` - General DFHack utilities

## Extending the Scripts

### Adding a New Governance System

1. Copy one of the existing scripts as a template
2. Define new governance structure (factions/councils/departments)
3. Customize personality traits and buzzwords
4. Modify briefing generation to match narrative tone
5. Update system prompt with new governance rules
6. Adjust OKR format if needed

### Adding New State Extraction

To track additional game data:

1. Add extraction function following `get_*()` pattern
2. Access `df.global.world.*` structures via DFHack
3. Use `safe_get()` for nil safety
4. Add result to `collect_state()` return table
5. Include in briefing/report generation
6. Reference in LLM prompts

### Modifying LLM Behavior

OKR generation is controlled by:
- System prompt governance rules
- Available workforce calculation
- Threat identification (identifies_threats/risks functions)
- Focus areas in user prompt

Change these to adjust OKR content without modifying LLM call mechanics.

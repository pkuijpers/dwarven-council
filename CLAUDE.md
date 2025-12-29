# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dwarven Governance is a set of DFHack Lua addons for Dwarf Fortress that generate OKRs (Objectives and Key Results) through AI-powered governance simulations. Three scripts implement different governance systems: democratic cooperative, authoritarian regime, and corporate enterprise.

All scripts run entirely within DFHack using Lua and make LLM API calls via `curl` subprocess to Claude.

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

# Copy all scripts to scripts directory (including common library)
cp dwarven-common.lua dwarven-coop.lua dwarven-reich.lua dwarven-corp.lua "$DF_BASE/hack/scripts/"
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

There is no build process. Edit Lua files directly and reload in DFHack. Session logs are saved to `/tmp/dwarven-{coop,reich,corp}/` as JSON files.

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

### Shared Library

**`dwarven-common.lua`** - Common library installed to `hack/scripts/` containing:

- **Utility Functions**: `safe_get()`, `plural()`, `pct()`, `status_indicator()`
- **DFHack API Helpers**: `translate_name()`, `is_military()` (with compatibility for old/new APIs)
- **State Extraction**: `get_fortress_info()`, `get_resources()`, `get_military()`, `get_recent_events()`, `get_buildings_summary()`
- **LLM Integration**: `call_llm()` with HTTP requests via luasocket

All three governance scripts load this library: `local common = dfhack.script_environment('dwarven-common')`

Note: Using `dfhack.script_environment()` instead of `require()` ensures the library is reloaded on each script execution without caching, making development easier.

### Shared Script Pattern

All three scripts follow the same architectural pattern:

1. **Configuration** (`CONFIG` table) - API key, model, output directory
2. **Common Library Import** - `dfhack.script_environment('dwarven-common')` for shared utilities
3. **Governance Structure** - Faction/council/C-suite definitions with profession mappings (governance-specific)
4. **State Collection** - Extract game data via DFHack API and common library
5. **Report Generation** - Create markdown briefings from game state
6. **LLM Interaction** - Call common.call_llm() wrapper
7. **Command Handlers** - Functions like `cmd_assembly()`, `cmd_decree()`, `cmd_qbr()`
8. **Entry Point** - Argument parsing with `argparse.processArgsGetopt()`

### State Collection Pipeline

Each script follows this data flow:

```
DFHack Memory → collect_state() → Briefing/Report → LLM Prompt → Claude API → OKRs
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

The `call_llm()` function in each script:

1. Builds JSON request with system and user prompts
2. Writes request to `{output_dir}/request.json`
3. Uses DFHack's `plugins.luasocket` to make TCP connection to Anthropic API
4. Manually constructs HTTP POST request over TCP (port 443)
5. Reads and parses HTTP response, extracts JSON body
6. Saves response to `{output_dir}/response.json`
7. Extracts text from `response.content[1].text`

**Important DFHack Limitations:**
- `io.popen()` is NOT available (returns nil)
- `os.execute()` is NOT available/blocked in DFHack scripts
- Must use `require('plugins.luasocket')` for network requests
- DFHack's luasocket only supports raw TCP, not HTTP libraries
- HTTP requests must be manually constructed as raw TCP data
- HTTPS works on port 443 but SSL/TLS is handled transparently

This is intentionally blocking since the game is paused during quarterly meetings.

### Prompt Architecture

Two-stage prompt generation:

1. **System Prompt** (`build_system_prompt()`) - Sets governance context, personalities, and OKR format
2. **User Prompt** (`build_user_prompt()`) - Contains briefing/report and assembly/meeting context

System prompts define the narrative voice and OKR structure. User prompts provide current game state and constraints (available workforce, threats, resources).

## Key Implementation Details

### Error Handling

All DFHack memory access uses `safe_get()` with pcall to handle nil values gracefully, since game structures may not always be initialized.

### Profession Mapping

Each dwarf is assigned to exactly one faction/unit/council based on their profession. The `get_faction_for_profession()` / `get_business_unit()` functions iterate through profession lists to find matches. Unmapped professions default to the "Services" group.

### Session Persistence

Each meeting/assembly generates a JSON file named by game date:
- `assembly_{year}_{season}.json` (coop)
- `decree_{year}_{season}.json` (reich)
- `qbr_FY{year}_Q{quarter}.json` (corp)

Files include full state, prompts, and LLM response for debugging and replay.

### Dependencies

Required Lua modules (provided by DFHack):
- `json` - Encode/decode for API calls and session storage
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

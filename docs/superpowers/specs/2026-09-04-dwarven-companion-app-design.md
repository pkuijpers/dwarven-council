# Dwarven Governance Companion App — Design

Date: 2026-09-04
Status: Approved for planning
Scope: `dwarven-coop.lua` only

## Problem

The current workflow requires the player to run `dwarven-coop assembly` in the DFHack
console, manually copy the printed prompt, paste it into a separate Claude interface, and
read the result there. Two things make this unpleasant:

1. The copy-paste round trip between the game and a browser tab.
2. The DFHack console is a poor place to read long OKR narratives — no scrolling, no
   formatting.

There is also no continuity: nothing records what was decided last quarter, so the LLM
cannot judge progress against previous OKRs.

## Goals

- Remove the manual copy-paste step entirely for the cooperative governance system.
- Generate a new quarterly assembly automatically when the in-game season changes.
- Present assemblies and their OKRs in a readable UI outside the DFHack console.
- Keep a history of past assemblies and feed the previous quarter's OKRs into the next
  prompt so the simulation has continuity.
- Move prompt authoring out of Lua so prompt/narrative changes do not require reinstalling
  scripts and reloading DFHack.

## Non-goals

- `dwarven-reich.lua` and `dwarven-corp.lua` keep their existing manual workflow. They are
  untouched by this work.
- No in-game UI/overlay. The game window is not modified.
- No writing results back into the game (no in-game announcements). Possible later.
- No multi-user, multi-fortress, or hosted deployment. This is a single-user local tool.

## Architecture

A new standalone Node.js/TypeScript application in `companion/`, a sibling of the existing
`mcp-server/`. It runs as a long-lived local process and serves a web UI on localhost.

### Responsibility split

| Concern | Lives in | Rationale |
|---|---|---|
| Reading DF memory / game state | `dwarven-coop.lua` | Only DFHack Lua can read game structures |
| Deterministic briefing markdown | `dwarven-coop.lua` | Already exists (`generate_briefing`), also used standalone by `dwarven-coop briefing` |
| LLM prompt construction | `companion/` (TypeScript) | Iterate on prompts without reinstalling scripts |
| Anthropic API call | `companion/` | Key management and retries belong in a real service |
| History / continuity | `companion/` | Lua has no persistence today |
| Presentation | `companion/` web UI | The console cannot render this well |

### Components

1. **DFHack client** — connects to the DFHack remote interface (port 5000), runs commands
   and Lua snippets. Reuses the proven implementation in
   `mcp-server/src/dfhack-client.ts`.
2. **Quarter poller** — polls the in-game date, detects season changes, triggers cycles.
3. **State fetcher** — runs `dwarven-coop assembly` and extracts the JSON payload.
4. **Prompt builder** — TypeScript port of the current `build_system_prompt()` /
   `build_user_prompt()`, plus injection of previous-quarter OKRs.
5. **Anthropic client** — calls the Messages API, handles errors and retries.
6. **History store** — a JSON file of all past cycles.
7. **Web server + UI** — serves the page, pushes updates over Server-Sent Events.

## Component 1: Lua state export

`dwarven-coop.lua` changes from "prints a prompt" to "prints structured state".

### `cmd_assembly()` (currently line 2149)

Replaced with a JSON export between sentinel markers:

```lua
local function cmd_assembly()
    local state = collect_state()
    local briefing = generate_briefing(state)
    print("===DWARVEN_ASSEMBLY_STATE_JSON===")
    print(json.encode({ state = state, briefing = briefing }))
    print("===DWARVEN_ASSEMBLY_STATE_END===")
end
```

DFHack's built-in `json` module is available and pretty-prints across multiple lines
(verified in a live session). The companion app takes everything between the markers and
parses it whole, so multi-line output is fine.

### Deletions

`build_system_prompt()` (line 1986), `build_user_prompt()` (line 2063) and
`print_llm_prompt()` (line 139) are removed. Their logic moves to the companion app. The
copy-paste path for the cooperative disappears — that was the point of this work.

### Faction narrative metadata moves to companion

`build_system_prompt()` currently reads faction `description` and `priorities` straight
from the module-level `FACTIONS` table. Those two fields are grep-confirmed dead anywhere
else in `dwarven-coop.lua` — `generate_briefing()` only ever uses `id`, `name` and `members`
— so once `build_system_prompt()` is deleted, nothing in Lua needs them.

`description` and `priorities` are removed from Lua's `FACTIONS` table entirely; they are
governance narrative framing, not game state, and Lua should not be the source of truth for
them. `FACTIONS` keeps only what Lua actually needs: `id`, `name` (used by
`generate_briefing()`) and `professions` (used to map dwarves to factions — that mapping is
itself derived from DF profession data, so it counts as game state). `analyze_population()`'s
per-faction summary (`summary.factions[id]`) stays as `name`, `members`, `votes` — no
`description`/`priorities` are added to it or exported.

Companion owns a static TypeScript table keyed by faction `id` (`producers`, `food`,
`delvers`, `defenders`, `caregivers`, `services`) holding `description` and `priorities`,
seeded from the values above. The prompt builder joins this against the `id`s coming back in
`state.population.factions` to build the faction table in the system prompt. Companion is now
the single source of truth for this text; the two-copy "drift risk" the earlier version of
this design avoided is accepted deliberately, in exchange for Lua doing nothing but reading
game state.

`population.factions[*].dwarves` (raw DF unit objects, used only for spokesperson selection)
must be stripped before encoding — it is the one non-serializable field in the payload, and
nothing downstream needs it. Everything else `collect_state()` returns, including
`spokespersons`, is plain strings, numbers and tables.

### Untouched

`cmd_status()`, `cmd_briefing()`, `cmd_members()` and every `get_*()` / `collect_state()` /
`generate_briefing()` function keep working exactly as they do now.

## Component 2: DFHack client

`mcp-server/src/dfhack-client.ts` already implements the wire protocol: `runCommand()`
sends a `RunCommand` request and joins every `CoreTextNotification` reply into one output
string.

Approach: extract it into a shared location both projects import, rather than copying it.
Two constraints on that extraction:

- The connection behaviour must be preserved as-is — `connect()` deliberately force-
  disconnects and opens a fresh socket every time (commit `3b86aab`, fixing stale-connection
  bugs). Do not "optimize" this into a pooled connection.
- `mcp-server` must keep working exactly as it does now; the extraction is a move plus
  import changes, not a rewrite.

## Component 3: Quarter poller

Polls every 60 seconds (configurable) with a cheap Lua evaluation:

```lua
print(df.global.cur_year, df.global.cur_year_tick, df.global.gamemode)
```

A DF year is 403,200 ticks (12 months × 28 days × 1,200 ticks); a season is 100,800 ticks.
The season index is `floor(cur_year_tick / 100800)` (0 = Spring … 3 = Winter), computed in
TypeScript. `gamemode` tells us whether a fortress is actually loaded.

A cycle triggers when `(year, seasonIndex)` differs from the last recorded cycle in the
history store. Because the comparison is against persisted history rather than in-memory
state, a season boundary crossed while the companion app was closed still produces exactly
one cycle at next startup.

At ~100 FPS a season is roughly 17 real-world minutes, so a 60-second poll is ample and
cheap.

## Component 4: Prompt builder

A direct TypeScript port of the two deleted Lua functions, taking the parsed
`{ state, briefing }` payload:

- **System prompt** — the governance framing, faction list (name and vote count/share from
  `state`, description/priorities from companion's own faction narrative table, joined by
  `id`), assembly procedure, output format and guidelines. Static text
  plus the faction table, exactly as `build_system_prompt()` builds it today.
- **User prompt** — the briefing markdown, available workforce
  (`adults - military - injured`), quorum (`floor(eligible_voters / 2) + 1`), derived focus
  areas, and the closing instruction.

New in the port: a **previous quarter** section appended to the user prompt when history
exists — the last cycle's date and its adopted OKRs verbatim, with an instruction to open
the assembly by reviewing progress on them against the current state. Progress is judged by
the model from the current briefing; no separate evaluation call.

## Component 5: Anthropic client

Uses the official `@anthropic-ai/sdk`.

```typescript
const response = await client.messages.create({
  model: "claude-opus-5",
  max_tokens: 16000,
  output_config: { effort: "medium" },
  system: systemPrompt,
  messages: [{ role: "user", content: userPrompt }],
});
```

- **Model:** `claude-opus-5` — narrative quality is the whole point of the feature.
- **Effort:** `medium` as the starting point. This is creative writing, not hard reasoning.
  Tunable via config if output feels thin.
- **Thinking:** omitted. Adaptive thinking is on by default for Opus 5. Do not pass
  `budget_tokens` — it returns a 400 on this model.
- **Streaming:** not used. Expected output is a few thousand tokens and the UI updates when
  the cycle completes.
- **Credentials:** `ANTHROPIC_API_KEY` in the companion app's environment. The Lua
  `CONFIG.api_key` field and the README's curl requirement become obsolete and are removed.
- **Errors:** typed exception chain, most specific first — `AuthenticationError`,
  `RateLimitError`, `APIStatusError`, `APIConnectionError`. Retry 429 and 5xx with
  exponential backoff (3 attempts). A cycle that still fails is stored with
  `status: "failed"` and its error message; the poller keeps running.

**Prompt caching is deliberately not used.** The system prompt is stable across cycles, but
the ephemeral cache TTL is 5 minutes by default (1 hour maximum) and quarterly cycles are
far further apart than that in real time. It would add complexity for near-zero hit rate.
Revisit only if rapid repeated testing becomes a common workflow.

## Component 6: History store

A single JSON file, `companion/data/history.json`, holding an array of cycle records:

```typescript
type Cycle = {
  id: string;              // e.g. "106-1" (year-season)
  year: number;
  seasonIndex: number;     // 0-3
  seasonName: string;
  triggeredAt: string;     // ISO timestamp
  status: "completed" | "failed";
  briefing: string;        // markdown from Lua
  state: unknown;          // raw collect_state() payload, kept for debugging
  assembly?: string;       // the LLM's markdown output
  okrs?: string;           // extracted OKR section, fed into the next prompt
  error?: string;          // when status is "failed"
};
```

Written atomically (write to a temp file, then rename) so an interrupted write cannot
corrupt the history.

OKR extraction for continuity is a simple parse of the `### [VOTING]` section from the
model's markdown. If extraction finds nothing, fall back to passing the whole assembly text
as previous-quarter context — the continuity feature degrades rather than breaking.

## Component 7: Web server + UI

A small HTTP server on a configurable localhost port serving:

- `GET /` — the single-page UI (plain HTML/CSS/JS, no build step; the project is
  single-user and local, and a bundler would add friction for no benefit).
- `GET /api/history` — all cycles.
- `GET /api/status` — poller state: connected to DFHack or not, current in-game date, last
  cycle, whether a cycle is currently running.
- `GET /api/events` — Server-Sent Events stream pushing status changes and completed
  cycles, so an open tab updates without a refresh.
- `POST /api/cycle` — manually trigger a cycle. Not the primary workflow, but necessary for
  testing and useful when the player wants an assembly off-schedule.

The UI shows a status bar (connection, current date, next season), and a reverse-
chronological list of assemblies, each rendering its briefing and assembly markdown.

The companion app is ESM like `mcp-server` (`"type": "module"`); `__dirname` is undefined
there, so static file paths derive from `import.meta.url`.

## Data flow

```
every 60s: lua_eval(cur_year, cur_year_tick, gamemode)
  └─ fortress loaded and (year, season) not in history?
       └─ runCommand("dwarven-coop", ["assembly"])
            └─ extract JSON between markers → { state, briefing }
                 └─ build system + user prompt (+ previous OKRs from history)
                      └─ Anthropic messages.create
                           └─ append cycle to history.json (atomic)
                                └─ SSE push to open browser tabs
```

## Error handling and edge cases

| Situation | Behaviour |
|---|---|
| DFHack unreachable (DF not running) | Poller catches the connection error, status shows "waiting for DFHack", retries on the next tick. No crash, no log spam. |
| DF running but no fortress loaded | `gamemode` check; poller idles. |
| Season boundary crossed while app was closed | Detected at startup by comparing against history; exactly one cycle runs. |
| Multiple seasons passed while app was closed | One cycle for the current season only. Skipped seasons are not backfilled — the game state for them is gone. |
| `dwarven-coop assembly` errors or markers absent | Cycle recorded as failed with the raw output for diagnosis. |
| Anthropic call fails after retries | Cycle recorded as failed; the next season triggers normally. |
| Cycle already running when the poller ticks | Guard flag; the tick is skipped. |

## Configuration

Environment variables, with sensible defaults:

- `ANTHROPIC_API_KEY` (required)
- `DFHACK_HOST` / `DFHACK_PORT` (default `localhost:5000`)
- `COMPANION_PORT` (default 3000)
- `POLL_INTERVAL_MS` (default 60000)
- `CLAUDE_EFFORT` (default `medium`)

## Testing strategy

The DFHack integration cannot be meaningfully unit tested — it requires a live game. The
split:

**Automated (unit tests, fixture-driven):**
- Marker extraction and JSON parsing, including the malformed/missing-marker cases.
- Season index computation from `cur_year_tick`, including boundaries.
- "Should a cycle trigger?" logic against history fixtures.
- Prompt builder output against a recorded state fixture.
- OKR extraction from a recorded assembly response.
- History store atomic write and read-back.

**Manual, against a live fortress:**
- End-to-end cycle via `POST /api/cycle`.
- Automatic trigger across a real season boundary.
- Reconnect behaviour when DF is closed and reopened.

Capture one real `collect_state()` payload early and commit it as the test fixture, so
prompt-builder tests run without the game.

## Implementation risks to verify first

**Large payload integrity over the RunCommand text channel.** The whole design depends on a
full `collect_state()` JSON blob surviving the DFHack remote text-notification channel
intact. `runCommand()` joins an arbitrary number of `CoreTextNotification` messages, which
should handle it, but this has never been exercised with a payload this size — the current
MCP tools return human-readable summaries, not tens of kilobytes of JSON.

Verify before building anything else: run the modified `cmd_assembly` through the DFHack
client from a small Node script, and assert the received length equals a length that Lua
reports separately. If output is truncated or mangled, fall back to chunked printing
(fixed-size slices between the markers, rejoined by the companion app) — worth knowing
before the rest is built on top of it.

## Out of scope / possible later

- Bringing `dwarven-reich.lua` and `dwarven-corp.lua` into the same flow once the pattern
  is proven.
- Writing an in-game announcement when a new assembly is ready.
- Prompt caching, if a fast test-iteration workflow ever makes it worthwhile.
- Tracking measurable OKR outcomes automatically (comparing declared key results against
  later game state) instead of leaving the judgement to the model.

## Documentation debt to fix alongside

Both `CLAUDE.md` and `README.md` describe behaviour that does not exist in the code today
and will be doubly wrong after this change:

- `CLAUDE.md` says the scripts "make LLM API calls via `curl` subprocess to Claude". They
  do not — there is no curl call anywhere in the repo.
- `README.md` requires `curl` and an Anthropic API key for the scripts, claims "no external
  processes required", and shows example output with completed voting results as though the
  script produced them. It also documents JSON session logging, which does not exist.

Update both as part of this work.

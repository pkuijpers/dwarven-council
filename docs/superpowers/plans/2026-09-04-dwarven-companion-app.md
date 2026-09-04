# Dwarven Companion App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-09-04-dwarven-companion-app-design.md` (approved; read it alongside this plan)

**First action for the executor:** copy this file to `docs/superpowers/plans/2026-09-04-dwarven-companion-app.md` and commit it, so the plan travels with the repo.

## Context

Today the cooperative governance workflow is a copy-paste loop: the player runs `dwarven-coop assembly` in the DFHack console, the Lua script prints a multi-thousand-token LLM prompt, and the player pastes it into a browser to get quarterly OKRs back. The console is a bad place to read long narratives, nothing records what was decided last quarter, and every prompt tweak requires reinstalling a Lua script and reloading DFHack.

This work replaces that with a local Node.js companion app that detects in-game season changes, pulls fortress state out of DFHack itself, builds the prompt, calls the Anthropic API, keeps a history for continuity, and renders assemblies in a browser. The responsibility split is the point: **`dwarven-coop.lua` becomes pure game-state extraction, and everything that determines the OKR narrative lives in the companion app.** That includes the faction `description`/`priorities` framing text, which moves out of Lua into a TypeScript table (commit `02cc5f0` recorded this decision in the spec).

Only `dwarven-coop.lua` is in scope. `dwarven-reich.lua` and `dwarven-corp.lua` keep their manual workflow untouched.

**Goal:** Replace the copy-paste LLM workflow for the cooperative with an automatic, season-triggered companion app that generates, stores and displays quarterly OKRs.

**Architecture:** `dwarven-coop.lua` prints a compact JSON payload (`{schema, state, briefing}`) between sentinel markers. A new `companion/` TypeScript app polls DFHack over its remote protocol, runs `dwarven-coop assembly`, parses that payload, builds the system/user prompts in TypeScript, calls Claude, appends the result to a JSON history file, and serves a single-page UI over SSE. The DFHack wire client currently living in `mcp-server/src/` is extracted into a shared workspace package consumed by both apps.

**Tech Stack:** DFHack Lua (`json`, `argparse`), Node 22 + TypeScript 5 (ESM, `NodeNext`), npm workspaces + TypeScript project references, vitest, `@anthropic-ai/sdk`, `node:http` (no web framework, no bundler).

## Global Constraints

- **Scope:** `dwarven-coop.lua` only. Do not touch `dwarven-reich.lua` / `dwarven-corp.lua`.
- **`mcp-server` must keep working exactly as it does now.** `.mcp.json` hardcodes `/home/pieter/projects/dwarvencouncil/mcp-server/dist/index.js`; that path must still exist and work after the extraction.
- **`DFHackClient.connect()` keeps its unconditional `forceDisconnect()`** (commit `3b86aab`, stale-connection fix). The extraction is a `git mv` plus import changes — zero behavioural edits.
- **Model:** `claude-opus-5`, `max_tokens: 16000`, `output_config: { effort: <config> }` (default `medium`). Omit `thinking` entirely — adaptive thinking is the Opus 5 default and `budget_tokens` returns a 400 on this model.
- **Credentials:** `ANTHROPIC_API_KEY` in the companion's environment only. Never commit it; never add an api_key field to Lua.
- **Prompt caching is deliberately not used** (quarterly cycles are far past any cache TTL).
- **Commit style:** imperative sentence-case subject, no `feat:`/`fix:` prefixes. Every commit ends with:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01VaR6Rznkd5gjE3LJSVxvGf
  ```
- **Config defaults:** `DFHACK_HOST=localhost`, `DFHACK_PORT=5000`, `COMPANION_PORT=3000`, `POLL_INTERVAL_MS=60000`, `CLAUDE_EFFORT=medium`.

## Verified facts (do not re-derive)

These were checked against the live fortress (year 106, tick 87105, gamemode 0, map loaded) and the source. They override any contradicting prose:

1. **Payload integrity is not a risk.** 2.5 MB pushed through `runCommand('lua', …)` arrived byte-identical, 500×5000-char lines intact. `CoreTextNotification` fragments carry their own newlines and join with no separator. A `collect_state()` blob is well under 100 KB. Task 1 still verifies it, but expect it to pass.
2. **`json.encode(t, {pretty = false})` produces compact single-line JSON.** Use it.
3. **Empty Lua tables encode as `[]`, not `{}`.** So `spokespersons`, `workshop_types`, `mining.*` etc. can arrive as JSON arrays. The TypeScript layer must tolerate this — it is not in the spec.
4. **Userdata throws a catchable `can't convert userdata to JSON`.** Stripping `population.factions[*].dwarves` is mandatory; it is the only non-encodable value in the whole tree.
5. **Lua skips the newline directly after an opening `[[`.** At `dwarven-coop.lua:2014` this means `LITERAL_A` ends `"## Voting Factions\n"` and `LITERAL_B` begins with **one** `\n` before `## Assembly Procedure` — so there is no blank line between the last faction line and that heading. Reproduce this exactly; the golden-file test is what enforces it.
6. **`print(a, b, c)` emits tab-separated values.** `dfhack.world.isFortressMode()` and `dfhack.isMapLoaded()` both exist and return `true` — a more reliable liveness probe than the spec's `gamemode` check.
7. **The `@anthropic-ai/sdk` error classes are `AuthenticationError`, `RateLimitError`, `APIConnectionError`, `APIError`.** The spec's `APIStatusError` is the Python name and does not exist in TypeScript.
8. **The SDK already retries 408/409/429/5xx (`maxRetries: 2` default).** Do not hand-roll the spec's 3-attempt backoff on top — that yields up to 9 requests per cycle. Set `maxRetries: 3` and let the SDK handle `retry-after`.
9. **Opus 5 can return `stop_reason: "refusal"` with HTTP 200.** Unhandled, a refusal is stored as a completed cycle with empty content and then poisons the next quarter's continuity. Treat `refusal` and `max_tokens` as failures.

## File structure

```
package.json                     NEW  T10  workspaces root
package-lock.json                NEW  T10  (mcp-server/package-lock.json deleted)
.gitignore                       MOD  T3, T10
.mcp.json                        UNCHANGED — its stability is a T10 acceptance criterion
dwarven-coop.lua                 MOD  T1 (JSON export), T2 (deletions)
README.md / CLAUDE.md            MOD  T15

shared/dfhack-client/            NEW  T10   @dwarvencouncil/dfhack-client
  package.json, tsconfig.json (composite), src/index.ts   ← git mv from mcp-server/src/dfhack-client.ts

mcp-server/
  src/dfhack-client.ts           DEL  T10
  src/index.ts                   MOD  T10  (import specifier, line 11 only)
  package.json, tsconfig.json    MOD  T10

companion/
  package.json, tsconfig.json, vitest.config.ts, .env.example, .editorconfig   T3
  data/                          gitignored runtime dir (history.json)
  scripts/payload-spike.mjs      T1
  public/{index.html,app.js,style.css}   T13
  src/
    config.ts     T3   loadConfig()
    types.ts      T4   CoopState, AssemblyPayload, Cycle
    payload.ts    T4   extractPayload(), asRecord()
    factions.ts   T5   FACTION_ORDER, FACTION_NARRATIVES
    prompt.ts     T5/T9 buildSystemPrompt(), buildUserPrompt(), pct(), calculateHappiness()
    history.ts    T6   HistoryStore
    okr.ts        T6   extractOkrs()
    season.ts     T7   seasonIndexFromTick(), parseDateProbe(), shouldTriggerCycle()
    anthropic.ts  T8   createAssemblyClient()
    dfhack.ts     T10  withConnection(), fetchGameDate(), fetchAssemblyPayload()
    cycle.ts      T11  runCycle()
    poller.ts     T12  Poller
    server.ts     T13  createServer()
    main.ts       T14  entrypoint
  test/
    fixtures/{state.json, raw-assembly-output.txt, legacy-prompt.txt, assembly-response.md}
    *.test.ts    one per src module
```

**Test-code convention for this plan:** pivotal tests are written out verbatim below. Where a task lists enumerated cases instead, each case names its exact input and expected output — write one `it()` per listed case, all of them failing, before implementing.

---

## Task 1: Lua JSON export + payload-integrity spike + fixture capture

Live fortress required. **Pause the game in DF before starting and leave it paused for Tasks 1 and 2** — the "before" and "after" captures must describe identical game state or the golden test in Task 5 is invalid.

**Files:**
- Modify: `dwarven-coop.lua:14-15` (add require), `dwarven-coop.lua:2149-2163` (`cmd_assembly`)
- Create: `companion/scripts/payload-spike.mjs`
- Create: `companion/test/fixtures/legacy-prompt.txt`, `raw-assembly-output.txt`, `state.json`

**Interfaces produced:** the wire contract every later task consumes — markers `===DWARVEN_ASSEMBLY_STATE_JSON===` / `===DWARVEN_ASSEMBLY_STATE_END===`, a declared-length line, then one line of compact JSON `{schema: 1, state, briefing}`.

- [ ] **Step 1: Capture the golden legacy prompt BEFORE changing any Lua**

Run the current `dwarven-coop assembly` (MCP `coop_assembly` tool, or `runCommand`) and save stdout verbatim to `companion/test/fixtures/legacy-prompt.txt`, stripping only the 5-line ASCII banner (`dwarven-coop.lua:2150-2154` plus the blank line). This file is the ground truth for the TypeScript port and cannot be recreated once Task 2 deletes the code that produces it.

Verify trailing whitespace survived: `grep -n ' $' companion/test/fixtures/legacy-prompt.txt` must show the `- KR2: [Measurable key result]  ` line.

Also capture the current `dwarven-coop briefing`, `status` and `members` output to a scratch location — Task 2 diffs against them.

- [ ] **Step 2: Add the json require**

`dwarven-coop.lua`, after line 15:
```lua
local json = require('json')
```

- [ ] **Step 3: Replace `cmd_assembly()` (lines 2149-2163)**

```lua
local function cmd_assembly()
    local state = collect_state()
    local briefing = generate_briefing(state)

    -- df.unit userdata cannot be JSON-encoded and nothing downstream needs it
    for _, faction in pairs(state.population.factions) do
        faction.dwarves = nil
    end

    local payload = json.encode({ schema = 1, state = state, briefing = briefing }, { pretty = false })
    print("===DWARVEN_ASSEMBLY_STATE_JSON===")
    print(#payload)
    print(payload)
    print("===DWARVEN_ASSEMBLY_STATE_END===")
end
```

The banner is dropped. `#payload` is the independently-reported length the spec's integrity check requires; it stays permanently as a cheap corruption guard. `schema = 1` lets the companion detect a stale installed script.

- [ ] **Step 4: Install and run the spike**

`./install.sh` (DFHack re-reads scripts per invocation; no reload needed).

Write `companion/scripts/payload-spike.mjs` — plain `.mjs`, no build step, since companion has no toolchain yet. It imports `../../mcp-server/dist/dfhack-client.js` (Task 10 updates this one line), connects, runs `runCommand('dwarven-coop', ['assembly'])`, extracts between the markers, and asserts `payload.length === declaredLength` and that `JSON.parse` succeeds.

Run: `node companion/scripts/payload-spike.mjs`
Expected: `OK: declared=N received=N parsed=true`

- [ ] **Step 5: Save fixtures**

Full stdout → `raw-assembly-output.txt`. The parsed payload, re-serialised pretty for reviewability → `state.json`.

- [ ] **Step 6: Commit**

```bash
git add dwarven-coop.lua companion/scripts/payload-spike.mjs companion/test/fixtures/
git commit -m "Add JSON state export to dwarven-coop assembly and verify payload integrity"
```

**If the spike fails** (truncation or length mismatch): switch `cmd_assembly` to chunked printing — slice `payload` into 8 KB pieces, print `#payload` then `i .. ":" .. chunk` per chunk, and have `extractPayload` (Task 4) rejoin in index order and validate the total length. Only this task and `payload.ts` change; every later task consumes `AssemblyPayload` and is unaffected. Given the 2.5 MB verification, treat this as contingency.

---

## Task 2: Remove prompt construction from Lua

**Files:** `dwarven-coop.lua` only.

**Interfaces produced:** none — this is deletion. After it, `FACTIONS` entries have exactly `id`, `name`, `professions`.

- [ ] **Step 1: Delete the three prompt functions**

- `print_llm_prompt()` — lines 139-143
- `build_system_prompt()` — lines 1986-2061
- `build_user_prompt()` — lines 2063-2092
- the now-empty "LLM Integration" section header above them (lines 1982-1985)

- [ ] **Step 2: Strip narrative fields from `FACTIONS` (lines 150-215)**

Remove the `description = ...` and `priorities = {...}` lines from all six entries. Keep `id`, `name`, `professions` — those are used by `get_faction_for_profession()` (line 283) and `analyze_population()` (lines 317-321). Grep-confirmed twice: `description`/`priorities` were read only at lines 1999-2000.

- [ ] **Step 3: Update the file header comment (lines 1-12)** so it says `assembly` emits JSON state rather than a prompt.

- [ ] **Step 4: Syntax gate**

Run: `luac -p dwarven-coop.lua`
Expected: no output, exit 0. This parses without executing, so no `df` globals are needed — a cheap regression guard.

- [ ] **Step 5: Manual verification against Task 1 captures** (fortress still paused)

`./install.sh`, then confirm:
- `dwarven-coop status` → byte-identical to the Task 1 capture
- `dwarven-coop briefing` → byte-identical
- `dwarven-coop members` → byte-identical
- `dwarven-coop assembly` → still emits valid JSON; re-run the spike, still passes

- [ ] **Step 6: Commit**

```bash
git add dwarven-coop.lua
git commit -m "Remove prompt construction from dwarven-coop, leaving pure state export"
```

---

## Task 3: Companion scaffold, vitest, config

**Files:** create `companion/package.json`, `companion/tsconfig.json`, `companion/vitest.config.ts`, `companion/.env.example`, `companion/.editorconfig`, `companion/src/config.ts`, `companion/test/config.test.ts`; modify `.gitignore`.

**Interfaces produced:**
```ts
export interface CompanionConfig {
  anthropicApiKey: string;
  dfhackHost: string; dfhackPort: number; dfhackTimeoutMs: number;
  companionPort: number; pollIntervalMs: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  model: string; dataDir: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CompanionConfig;
```

`companion/tsconfig.json` mirrors `mcp-server/tsconfig.json` exactly (ES2022, NodeNext, strict, declaration, `outDir ./dist`, `rootDir ./src`, `include ["src/**/*"]`). `package.json` is `"type": "module"` with scripts `build`/`start`/`dev`/`test`/`test:watch`; dependency `@anthropic-ai/sdk`; devDeps `vitest`, `@types/node@^20`, `typescript@^5`.

`.editorconfig` sets `trim_trailing_whitespace = false` for `src/prompt.ts` — an editor stripping the two trailing spaces in the KR2 line would silently break Task 5's golden test.

`.gitignore` gains `companion/node_modules/`, `companion/dist/`, `companion/data/`, `.env`. **`companion/data/` matters:** `history.json` holds full state dumps and Claude output, and today's `.gitignore` covers only `mcp-server/`.

- [ ] **Step 1: Write the failing test** — `companion/test/config.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { ANTHROPIC_API_KEY: 'sk-ant-test' };

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      dfhackHost: 'localhost', dfhackPort: 5000, companionPort: 3000,
      pollIntervalMs: 60000, effort: 'medium', model: 'claude-opus-5',
    });
  });
  it('throws naming the variable when the API key is missing', () => {
    expect(() => loadConfig({})).toThrow(/ANTHROPIC_API_KEY/);
  });
  it('rejects a non-numeric port instead of yielding NaN', () => {
    expect(() => loadConfig({ ...base, COMPANION_PORT: 'abc' })).toThrow(/COMPANION_PORT/);
  });
  it('rejects an unknown effort level', () => {
    expect(() => loadConfig({ ...base, CLAUDE_EFFORT: 'turbo' })).toThrow(/CLAUDE_EFFORT/);
  });
});
```

- [ ] **Step 2: Run and watch it fail** — `npm test -w companion`; expected: 4 failures, module not found.
- [ ] **Step 3: Implement `config.ts`** — read each variable, apply the default, validate numbers with `Number.isFinite` and effort against the union, throw `Error` naming the offending variable.
- [ ] **Step 4: Run tests** — expected: 4 passing.
- [ ] **Step 5: Commit** — `Add companion app scaffold with vitest and config loading`

---

## Task 4: Payload extraction and types

**Files:** create `companion/src/payload.ts`, `companion/src/types.ts`, `companion/test/payload.test.ts`.

**Interfaces produced:**
```ts
export const STATE_BEGIN = '===DWARVEN_ASSEMBLY_STATE_JSON===';
export const STATE_END   = '===DWARVEN_ASSEMBLY_STATE_END===';
export const SUPPORTED_SCHEMA = 1;
export class PayloadError extends Error {
  constructor(message: string, readonly rawOutput: string) { super(message); }
}
export interface AssemblyPayload { schema: number; state: CoopState; briefing: string }
export function extractPayload(output: string): AssemblyPayload;
export function asRecord<T>(v: Record<string, T> | unknown[] | undefined): Record<string, T>;
```

`rawOutput` on the error is what Task 11 stores in a failed cycle ("recorded as failed with the raw output for diagnosis"). `asRecord` exists because of verified fact 3 — empty Lua tables arrive as `[]`.

`types.ts` is hand-written from the committed `state.json`. Type narrowly **only** what the prompt builder reads — `date`, `population` (incl. `stress`, `factions`), `resources.food.status`, `resources.drink.status` — and leave the other top-level keys as `unknown`, so schema drift in unread parts of the tree cannot break parsing.

- [ ] **Step 1: Write the failing tests** — one `it()` per case, all before implementing:

1. Happy path: `extractPayload(readFileSync('test/fixtures/raw-assembly-output.txt','utf8'))` returns `schema === 1`, a `briefing` string starting `# Dwarven Cooperative`, and `state.population.total > 0`.
2. Leading noise (banner text, DFHack chatter) before `STATE_BEGIN` is ignored.
3. `\r\n` line endings parse identically to `\n`.
4. Declared length ≠ actual payload length → `PayloadError` whose message contains both numbers.
5. Missing `STATE_BEGIN` → `PayloadError`, and `err.rawOutput` equals the input.
6. Missing `STATE_END` → `PayloadError`.
7. Markers present, body not valid JSON → `PayloadError`.
8. `STATE_END` appearing before `STATE_BEGIN` → `PayloadError`.
9. Duplicate markers → uses the **first** `STATE_BEGIN` and the **first** `STATE_END` after it.
10. `schema: 2` → `PayloadError` mentioning `./install.sh` (stale installed script).
11. `asRecord([])` → `{}`; `asRecord({a: 1})` → `{a: 1}`; `asRecord(undefined)` → `{}`.

- [ ] **Step 2: Run, watch all 11 fail.**
- [ ] **Step 3: Implement `extractPayload`** — locate markers by line, read the declared-length line, join the remaining lines, compare lengths, `JSON.parse`, check `schema`.
- [ ] **Step 4: Run tests** — expected: 11 passing.
- [ ] **Step 5: Commit** — `Add assembly payload extraction with marker and length validation`

---

## Task 5: Prompt builder — verbatim TypeScript port

The highest-fidelity task. The Task 1 golden file makes it fully automatable.

**Files:** create `companion/src/factions.ts`, `companion/src/prompt.ts`, `companion/test/prompt.test.ts`.

**Interfaces produced:**
```ts
// factions.ts — companion is now the source of truth for this narrative text
export interface FactionNarrative { description: string; priorities: string[] }
export const FACTION_ORDER = ['producers','food','delvers','defenders','caregivers','services'] as const;
export const FACTION_NARRATIVES: Record<(typeof FACTION_ORDER)[number], FactionNarrative>;

// prompt.ts
export function pct(n: number, total: number): string;
export function calculateHappiness(stress: StressCounts): number;
export function buildSystemPrompt(state: CoopState): string;
export function buildUserPrompt(state: CoopState, briefing: string): string;
```

`FACTION_ORDER` is explicit because the system prompt iterates in the old Lua `FACTIONS` array order, and object key order should not be load-bearing. Faction **names** still come from `state.population.factions[id].name` (game-derived, always in sync); only `description`/`priorities` live here. Seed values, copied from the deleted Lua table:

| id | description | priorities |
|---|---|---|
| producers | Craftsdwarves, smiths, and makers | workshop efficiency, masterwork creation, tool quality |
| food | Farmers, cooks, and brewers | food security, alcohol production, sustainable farming |
| delvers | Miners and earthworkers | expansion, ore discovery, safe mining, megaprojects |
| defenders | Military and guards | fortress defense, military training, equipment quality |
| caregivers | Medics and welfare workers | healthcare, mental wellness, injury prevention, quality of life |
| services | Traders, administrators, and others | trade relations, efficient management, diplomacy |

**Porting rules, each its own assertion:**
- Structure is `LITERAL_A + lines.join('\n') + LITERAL_B`, where A ends `"## Voting Factions\n"` and **B starts with a single `\n`** (verified fact 5).
- Faction line: `` `- **${name}** (${members} votes, ${pct(members, eligible)}): ${description}. Priorities: ${priorities.join(', ')}` ``, emitted only when `members > 0`, in `FACTION_ORDER`.
- The `- KR2: [Measurable key result]  ` line keeps two trailing spaces.
- `available = adults - military - injured` (can go negative when a dwarf is both military and injured — reproduce as-is).
- `quorum = Math.floor(eligible_voters / 2) + 1`.
- Focus areas in fixed order: `Morale improvement` (happiness < 50), `Food production`, `Alcohol production` (status `low`/`critical`), `Collective defense` (`military < total / 10`), then always `Wealth building`, `Infrastructure`.
- `pct` with `total === 0` returns `"0%"`; otherwise Lua's `%.1f%%` formatting.

- [ ] **Step 1: Write the failing golden test** — this is the headline assertion:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractPayload } from '../src/payload.js';
import { buildSystemPrompt, buildUserPrompt } from '../src/prompt.js';

describe('prompt port', () => {
  it('reproduces the legacy Lua prompt byte for byte', () => {
    const payload = extractPayload(readFileSync('test/fixtures/raw-assembly-output.txt', 'utf8'));
    const combined =
      buildSystemPrompt(payload.state) + '\n\n' + buildUserPrompt(payload.state, payload.briefing);
    expect(combined).toBe(readFileSync('test/fixtures/legacy-prompt.txt', 'utf8'));
  });

  it('puts exactly one newline between the faction list and the procedure heading', () => {
    const sys = buildSystemPrompt(payload.state);
    expect(sys).toMatch(/Priorities: [^\n]+\n## Assembly Procedure/);
  });

  it('keeps the two trailing spaces on the KR2 line', () => {
    expect(buildSystemPrompt(payload.state)).toContain('- KR2: [Measurable key result]  \n');
  });

  it('covers every faction the game reports', () => {
    for (const id of Object.keys(payload.state.population.factions)) {
      expect(FACTION_NARRATIVES).toHaveProperty(id);
    }
  });
});
```

The `'\n\n'` join reproduces the deleted `print_llm_prompt`. The last test is the drift guard the spec's accepted duplication needs: adding a seventh faction to Lua fails a test instead of silently vanishing from the prompt.

Supporting unit tests to localise failures: factions with `members === 0` are omitted; `pct(0, 0) === '0%'`; `calculateHappiness` on an all-zero stress table; each focus-area trigger independently; negative `available` is preserved.

- [ ] **Step 2: Run, watch the golden test fail.**
- [ ] **Step 3: Implement `factions.ts` and `prompt.ts`**, copying the literal text from git history (`git show HEAD~1:dwarven-coop.lua`, lines 2005-2060) rather than retyping it.
- [ ] **Step 4: Iterate until the golden test passes byte-for-byte.**
- [ ] **Step 5: Commit** — `Port dwarven-coop prompt builders to TypeScript with golden-file test`

---

## Task 6: History store and OKR extraction

**Files:** create `companion/src/history.ts`, `companion/src/okr.ts`, `companion/test/history.test.ts`, `companion/test/okr.test.ts`.

**Interfaces produced:**
```ts
export interface Cycle {
  id: string; year: number; seasonIndex: number; seasonName: string;
  triggeredAt: string; status: 'completed' | 'failed';
  attempts: number;                 // bounded-retry support, see Task 7
  briefing: string; state: unknown;
  assembly?: string; okrs?: string; error?: string;
}
export class HistoryStore {
  constructor(filePath: string);
  load(): Promise<Cycle[]>;
  upsert(cycle: Cycle): Promise<void>;   // replaces a record with the same id, else appends
  latest(): Promise<Cycle | undefined>;
  find(id: string): Promise<Cycle | undefined>;
}
export function extractOkrs(assemblyMarkdown: string): string;
```

`upsert` rather than `append` because a retried season must **replace** its failed record, not accumulate duplicates under one id.

**Atomic write:** temp file in the **same directory** (`history.json.tmp` — cross-filesystem rename is not atomic), `fsync` the handle, then `fs.rename`. `mkdir -p` the data dir on construction.

**Corrupt `history.json` — spec gap, decided here: fail loud at startup** with the file path in the message. Silently returning `[]` would re-trigger an already-handled season and quietly kill the continuity feature.

**`extractOkrs`:** from the line matching `/^###\s*\[VOTING\]/m` up to the next `/^###\s/` (exclusive), trimmed. Return `''` when absent — Task 9 owns the whole-text fallback, keeping this a pure function.

- [ ] **Step 1: Write failing tests** — history: missing file → `[]`; upsert into a missing file creates it; two upserts with different ids read back in order; **upserting the same id twice leaves one record, carrying the second one's fields**; corrupt JSON throws with the path in the message; no `.tmp` file remains after a successful write; a pre-existing stale `.tmp` does not break the write; `latest()` on empty → `undefined`; `find('106-1')` hit and miss. OKR: extracts the `[VOTING]` section from `assembly-response.md`-shaped input; no `[VOTING]` → `''`; `[VOTING]` as the final section runs to end of string; a `###` inside a fenced code block does not terminate the section early.
- [ ] **Step 2: Run, watch them fail.**
- [ ] **Step 3: Implement both modules.**
- [ ] **Step 4: Run tests — all passing.**
- [ ] **Step 5: Commit** — `Add atomic history store and OKR section extraction`

---

## Task 7: Season math and trigger decision

**Files:** create `companion/src/season.ts`, `companion/test/season.test.ts`.

**Interfaces produced:**
```ts
export const TICKS_PER_YEAR = 403200;
export const TICKS_PER_SEASON = 100800;
export const SEASON_NAMES = ['Spring','Summer','Autumn','Winter'] as const;
export const MAX_CYCLE_ATTEMPTS = 3;
export const DATE_PROBE_LUA: string;
export interface GameDate {
  year: number; tick: number; seasonIndex: 0|1|2|3; seasonName: string;
  fortressMode: boolean; mapLoaded: boolean;
}
export function seasonIndexFromTick(tick: number): 0|1|2|3;
export function cycleId(year: number, seasonIndex: number): string;   // `${year}-${seasonIndex}`
export function parseDateProbe(output: string): GameDate;
export function shouldTriggerCycle(date: GameDate, cycles: Cycle[]): boolean;
```

`DATE_PROBE_LUA` (verified fact 6 — better than the spec's `gamemode` check):
```lua
print(df.global.cur_year, df.global.cur_year_tick, tostring(dfhack.world.isFortressMode()), tostring(dfhack.isMapLoaded()))
```
`parseDateProbe` splits on **tab** and parses `'true'`/`'false'`. Companion calls `runCommand('lua', [DATE_PROBE_LUA])` directly — the MCP server's `includes('print')` wrapping heuristic does not apply, the string already contains `print`.

- [ ] **Step 1: Write failing tests**

`seasonIndexFromTick`: 0 → 0; 100799 → 0; 100800 → 1; 201600 → 2; 302400 → 3; 403199 → 3; 403200 → clamped to 3 (defensive). Assert `SEASON_NAMES[seasonIndexFromTick(t)]` equals a reimplementation of the Lua month-derived season at all four boundaries, so the two formulas can never silently diverge.

`parseDateProbe`: the real tab-separated probe output `106\t87105\ttrue\ttrue` → `{year: 106, tick: 87105, seasonIndex: 0, seasonName: 'Spring', fortressMode: true, mapLoaded: true}`; `false` values parse as booleans; malformed output throws.

`shouldTriggerCycle` — **bounded retry, 3 attempts per season** (decided with the user; the spec is silent). Cases: empty history → true; a `completed` cycle for the current id → false; only an older id present → true; `mapLoaded: false` → false; `fortressMode: false` → false; several seasons skipped → true, and only for the current season (no backfill); a `failed` cycle for the current id with `attempts < MAX_CYCLE_ATTEMPTS` → **true**; with `attempts >= MAX_CYCLE_ATTEMPTS` → **false** (exhausted; `POST /api/cycle` remains the manual escape hatch and ignores the cap).

This retries a transient blip within the same season without burning a request every poll interval through a longer outage.

- [ ] **Step 2: Run, watch them fail.**
- [ ] **Step 3: Implement `season.ts`.**
- [ ] **Step 4: Run tests — all passing.**
- [ ] **Step 5: Commit** — `Add season index computation and cycle trigger decision`

---

## Task 8: Anthropic client

**Files:** create `companion/src/anthropic.ts`, `companion/test/anthropic.test.ts`, `companion/test/fixtures/assembly-response.md`.

**Interfaces produced:**
```ts
export interface AssemblyRequest { system: string; user: string }
export interface AssemblyClient { generateAssembly(req: AssemblyRequest): Promise<string> }
export class AssemblyRefusedError extends Error { constructor(readonly category: string | null, explanation?: string) }
export class AssemblyTruncatedError extends Error {}
export function createAssemblyClient(config: CompanionConfig, sdk?: Anthropic): AssemblyClient;
```

Request shape:
```ts
await sdk.messages.create({
  model: config.model,            // claude-opus-5
  max_tokens: 16000,
  output_config: { effort: config.effort },
  system: req.system,
  messages: [{ role: 'user', content: req.user }],
});
```
No `thinking`, no `budget_tokens`. Construct the SDK with `maxRetries: 3` and **write no manual backoff loop** (verified fact 8). Classify errors for storage only: `AuthenticationError` → fail fast with "check ANTHROPIC_API_KEY"; `RateLimitError` / `APIConnectionError` → surface after the SDK exhausts retries; `APIError` → include `.status`.

Check `stop_reason` **before** reading content: `'refusal'` → `AssemblyRefusedError` (with `stop_details.category`), `'max_tokens'` → `AssemblyTruncatedError`. Text extraction: `content.filter(b => b.type === 'text').map(b => b.text).join('')`.

- [ ] **Step 1: Write failing tests with a stub SDK** (no network, no key): happy path returns joined text; `stop_reason: 'refusal'` throws `AssemblyRefusedError` carrying the category; `stop_reason: 'max_tokens'` throws `AssemblyTruncatedError`; `AuthenticationError` propagates; assert the exact request object the stub received (model, `max_tokens: 16000`, `output_config.effort`, and that `thinking`/`budget_tokens` are absent).
- [ ] **Step 2: Run, watch them fail.**
- [ ] **Step 3: Implement `anthropic.ts`.**
- [ ] **Step 4: Run tests — all passing.**
- [ ] **Step 5: One real call, manually**, using the Task 1 fixtures through Task 5's builders; save the response to `companion/test/fixtures/assembly-response.md`. This feeds Task 6's and Task 9's tests.
- [ ] **Step 6: Commit** — `Add Anthropic assembly client with refusal and truncation handling`

---

## Task 9: Previous-quarter continuity

**Files:** modify `companion/src/prompt.ts`, `companion/test/prompt.test.ts`.

**Interfaces produced:**
```ts
export interface PreviousQuarter { year: number; seasonName: string; okrs: string }
export function buildUserPrompt(state: CoopState, briefing: string, previous?: PreviousQuarter): string;
export function previousQuarterFrom(cycle: Cycle | undefined): PreviousQuarter | undefined;
```

`previousQuarterFrom` implements the spec's degradation rule: prefer `cycle.okrs`; if empty or absent fall back to `cycle.assembly`; if the cycle is `failed` or has neither, return `undefined`. The section is **appended after** the closing "Conduct the General Assembly…" instruction, so omitting `previous` leaves Task 5's golden output untouched.

- [ ] **Step 1: Write failing tests** — `previous === undefined` → byte-identical to the Task 5 golden (regression lock); with `previous` → contains the year/season header, the OKR text verbatim, and an instruction to open by reviewing progress against current state; `okrs: ''` with `assembly` set → falls back to the full assembly text; a `failed` previous cycle → `undefined` and no section emitted.
- [ ] **Step 2: Run, watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests — all passing, including the unchanged golden test.**
- [ ] **Step 5: Commit** — `Feed previous quarter OKRs into the assembly prompt`

---

## Task 10: Extract the shared DFHack client

The one infrastructure task. Nothing before it depends on it; nothing after it depends on its internals.

**Files:**
- Create: root `package.json` (`{ "private": true, "workspaces": ["shared/*", "mcp-server", "companion"], "scripts": { "build": "tsc -b shared/dfhack-client mcp-server companion", "test": "npm test -w companion" } }`), root `package-lock.json`, `shared/dfhack-client/{package.json,tsconfig.json}`
- Move: `git mv mcp-server/src/dfhack-client.ts shared/dfhack-client/src/index.ts` — **verbatim, zero behavioural edits**
- Delete: `mcp-server/package-lock.json`
- Modify: `mcp-server/src/index.ts` line 11 only; `mcp-server/package.json` + `tsconfig.json` (dependency + `"references"`); `companion/package.json` + `tsconfig.json` (same); `companion/scripts/payload-spike.mjs` (one import line); `.gitignore` (generalise to `node_modules/`, `dist/`)
- Create: `companion/src/dfhack.ts`

**Why workspaces + project references:** the real hazard is a stale build — `mcp-server/dist/index.js` importing `@dwarvencouncil/dfhack-client` dies with `ERR_MODULE_NOT_FOUND` if the shared package was never built, and that is the user's daily driver. `"composite": true` plus `"references"` makes `tsc -b` build the dependency automatically, so the hazard disappears instead of being documented around.

**Interfaces produced:**
```ts
// companion/src/dfhack.ts
export function withConnection<T>(config: CompanionConfig, fn: (c: DFHackClient) => Promise<T>): Promise<T>;
export function fetchGameDate(config: CompanionConfig): Promise<GameDate>;
export function fetchAssemblyPayload(config: CompanionConfig): Promise<AssemblyPayload>;
```
`withConnection` connects, runs, and disconnects in `finally` — matching the client's deliberate per-call connect/force-disconnect design, exactly as `mcp-server/src/index.ts` does today.

- [ ] **Step 1: Create the workspace root and shared package; `git mv` the client.**
- [ ] **Step 2: Update the four package/tsconfig files and the single import in `mcp-server/src/index.ts`.**
- [ ] **Step 3: Verify the move was pure**

Run: `git diff -M --stat`
Expected: `dfhack-client.ts → shared/dfhack-client/src/index.ts` at 100% similarity. Confirm `connect()` still calls `forceDisconnect()` unconditionally.

- [ ] **Step 4: Clean build from scratch**

```bash
rm -rf node_modules mcp-server/node_modules companion/node_modules
npm install && npm run build
ls mcp-server/dist/index.js        # must exist — .mcp.json depends on this exact path
git diff --exit-code .mcp.json     # must be unmodified
npm test -w companion              # still green
```

- [ ] **Step 5: Manual MCP regression** — restart Claude Code so `.mcp.json` reloads the server, then call the `dfhack_status`, `coop_status` and `lua_eval` MCP tools and confirm live responses. Do this **before** committing; this is the user's daily-driver path and it cannot be automated.
- [ ] **Step 6: Implement `companion/src/dfhack.ts`** and point the spike script at the new package.
- [ ] **Step 7: Commit** — `Extract DFHack client into a shared workspace package`

---

## Task 11: Cycle orchestrator

**Files:** create `companion/src/cycle.ts`, `companion/test/cycle.test.ts`.

**Interfaces produced:**
```ts
export interface CycleDeps {
  runCommand(cmd: string, args?: string[]): Promise<{ success: boolean; output: string; error?: string }>;
  assembly: AssemblyClient;
  history: HistoryStore;
  now(): Date;
}
export function runCycle(date: GameDate, deps: CycleDeps): Promise<Cycle>;
```
The narrow `runCommand` shape is structurally satisfied by `DFHackClient`, so this is fully testable with a fake — no socket, no DF.

**Contract: `runCycle` never throws for game or API failures.** Every such path produces a `Cycle` with `status: 'failed'`, a diagnostic `error`, and is **still written to history** so the retry cap can count against it.

**Attempt counting:** `attempts = ((await history.find(id))?.attempts ?? 0) + 1`, written on both the completed and failed paths, then stored with `history.upsert()`.

- [ ] **Step 1: Write failing tests** — happy path (state fetched → prompts built → assembly generated → OKRs extracted → stored as `completed` with `attempts: 1`); `runCommand` returns `success: false` → failed cycle carrying `error`; `PayloadError` → failed cycle whose `error` includes the raw output; `AssemblyRefusedError` → failed with the category; `AssemblyTruncatedError` → failed; **a retry after an existing failed record for the same id stores `attempts: 2` and leaves one record, not two**; a success after a failure overwrites the failed record with `status: 'completed'`; a history write rejection **does** propagate (a broken disk should surface); `id === cycleId(year, seasonIndex)`; the previous completed cycle's OKRs reached `buildUserPrompt`; a mismatch between `SEASON_NAMES[date.seasonIndex]` and `state.date.season` is recorded as a warning, not a crash.
- [ ] **Step 2: Run, watch them fail.**
- [ ] **Step 3: Implement `runCycle`.**
- [ ] **Step 4: Run tests — all passing.**
- [ ] **Step 5: Commit** — `Add cycle orchestrator producing completed and failed cycle records`

---

## Task 12: Quarter poller

**Files:** create `companion/src/poller.ts`, `companion/test/poller.test.ts`.

**Interfaces produced:**
```ts
export interface PollerStatus {
  connected: boolean; fortressLoaded: boolean;
  date?: GameDate; lastCycleId?: string; cycleRunning: boolean; lastError?: string;
}
export class Poller {
  constructor(deps: PollerDeps, config: CompanionConfig);
  start(): void; stop(): void;
  getStatus(): PollerStatus;
  onChange(fn: (s: PollerStatus) => void): () => void;
  onCycle(fn: (c: Cycle) => void): () => void;
  triggerNow(): Promise<Cycle>;
}
```
Use **chained `setTimeout`, not `setInterval`** — a cycle can outlast the interval and ticks must never stack. `.unref()` the timer so tests and shutdown are not blocked.

- [ ] **Step 1: Write failing tests** with `vi.useFakeTimers()` — connection error → `connected: false`, no crash, next tick still fires; `mapLoaded: false` → idles; season unchanged → no cycle; season changed → exactly one `runCycle`; a tick arriving while `cycleRunning` → skipped (advance timers mid-cycle to prove it); repeated identical failures emit `onChange` once, not per tick (the spec's "no log spam"); **a failed cycle is retried on following ticks and stops after `MAX_CYCLE_ATTEMPTS`** — advance timers five intervals against an always-failing `runCycle` and assert exactly three invocations; `stop()` prevents further ticks; `triggerNow()` runs despite an unchanged season, ignores the attempt cap, but is still guarded by `cycleRunning`.
- [ ] **Step 2: Run, watch them fail.**
- [ ] **Step 3: Implement `Poller`.**
- [ ] **Step 4: Run tests — all passing.**
- [ ] **Step 5: Commit** — `Add quarter poller with season detection and cycle guard`

---

## Task 13: HTTP server, SSE and UI

**Files:** create `companion/src/server.ts`, `companion/test/server.test.ts`, `companion/public/{index.html,app.js,style.css}`.

**Interfaces produced:**
```ts
export function createServer(deps: { poller: Poller; history: HistoryStore; publicDir: URL }): http.Server;
```
Raw `node:http`, no framework — five routes do not justify a dependency, and companion stays as light as mcp-server. `publicDir` comes from `new URL('../public/', import.meta.url)` (ESM has no `__dirname`).

Routes: `GET /`, `GET /api/history`, `GET /api/status`, `GET /api/events` (SSE), `POST /api/cycle` (409 when a cycle is running).

**SSE:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`; push current status immediately on connect so a fresh tab is never blank; `: ping\n\n` heartbeat every 15 s; on `req.on('close')` unsubscribe **both** poller listeners and clear the heartbeat — missing that leaks a listener per browser refresh.

- [ ] **Step 1: Write failing tests** — bind port `0` and `fetch` the ephemeral address: each endpoint's status code and body shape; unknown path → 404; **path traversal `GET /../package.json` → 403/404, never the file contents**; an SSE client receives an initial status event, then a cycle event when the fake poller emits; closing the SSE response removes the listeners (assert listener count returns to its baseline); `POST /api/cycle` while running → 409.
- [ ] **Step 2: Run, watch them fail.**
- [ ] **Step 3: Implement `server.ts`** with explicit path-traversal rejection in the static handler.
- [ ] **Step 4: Run tests — all passing.**
- [ ] **Step 5: Build the UI** — status bar (connection, current in-game date, next season) plus a reverse-chronological assembly list rendering briefing and assembly markdown. Write a ~40-line renderer for the subset actually produced (headings, `**bold**`, `-` lists, paragraphs) rather than adding a library to a no-build-step page.
- [ ] **Step 6: Manual browser check** — open `http://localhost:3000`, confirm the status bar, the list rendering, and that an SSE-pushed cycle appears without a refresh.
- [ ] **Step 7: Commit** — `Add companion web server with SSE and single-page UI`

---

## Task 14: Wire it together and verify end to end

**Files:** create `companion/src/main.ts`, `companion/README.md` (short — how to run it).

`loadConfig()` → `HistoryStore` → `createAssemblyClient` → `Poller` → `createServer` → `listen`, logging the URL. `SIGINT`/`SIGTERM` → `poller.stop()`, close SSE responses, `server.close()`, exit 0.

**Manual verification, in order** (unpause the fortress for step 3):

- [ ] 1. Start with no `ANTHROPIC_API_KEY` → clear error naming the variable, non-zero exit.
- [ ] 2. Start with DF **closed** → server comes up, UI shows "waiting for DFHack", no crash, no log spam. Start DF → status flips to connected within one poll interval, no companion restart needed.
- [ ] 3. `POST /api/cycle` → full cycle runs; the assembly appears in the browser via SSE without a refresh; `companion/data/history.json` holds one `completed` record with `okrs` populated.
- [ ] 4. Set `POLL_INTERVAL_MS=5000`, unpause DF, run across a season boundary → exactly one cycle fires automatically, and no second cycle on the following tick.
- [ ] 5. Kill companion mid-season, cross a boundary, restart → exactly one cycle fires at startup from the persisted-history comparison.
- [ ] 6. Close DF while companion runs → poller reports disconnected and recovers when DF returns (the preserved `forceDisconnect()` behaviour).
- [ ] 7. Corrupt `history.json` deliberately → startup fails loudly with the file path.
- [ ] 8. Confirm the second cycle's prompt contains the first cycle's OKRs (read it back from the stored record).
- [ ] 9. Commit — `Wire companion app entrypoint and verify end-to-end cycle`

---

## Task 15: Fix documentation debt

**Files:** modify `README.md`, `CLAUDE.md`.

`README.md` — every one of these is currently false and becomes more so after this work:
- line 15 — "All scripts run entirely within DFHack — no external processes required"
- lines 34-35 — `curl` and Anthropic API key prerequisites (delete the curl requirement; move the key under a new companion section)
- lines 46-52 — API key setup instructions → reframe as the companion's `ANTHROPIC_API_KEY`
- lines 152-257 — **fabricated example output** showing completed vote tallies and OKRs no script ever produced. Lines 157-166 *are* real briefing output; everything from `### 🗳️ Voting` onward is invention. Replace with real companion output.
- lines 270, 283 — curl-subprocess architecture claims
- lines 289-308 — the `CONFIG` table with `api_key`, and a `call_llm()` function that exists nowhere. Note the CONFIG block is real only in reich/corp and is dead code there; do not invent a companion equivalent.
- lines 312-327, 335 — **JSON session logging that does not exist**. Replace with the real `companion/data/history.json`.
- line 333 — "blocking API calls pause the game"

`CLAUDE.md`:
- line 9 — "make LLM API calls via `curl` subprocess to Claude"
- line 150 — the stale pipeline diagram → the spec's data-flow diagram
- the copy/paste workflow description → companion-driven for coop, still manual for reich/corp

Add a companion section (install, env vars, `npm start`) and state explicitly that reich/corp keep the manual workflow, or the next reader will assume all three migrated.

- [ ] **Step 1: Rewrite both files.**
- [ ] **Step 2: Verify no stale claim survives** — `grep -niE 'curl|call_llm|session log|no external processes' README.md CLAUDE.md` returns only intentional mentions.
- [ ] **Step 3: Commit** — `Fix README and CLAUDE.md claims about API calls and session logging`

---

## Verification

**Automated** — `npm test -w companion` from the repo root covers Tasks 3-9 and 11-13 and runs with Dwarf Fortress closed:
- payload marker/length/schema handling including malformed input
- the byte-for-byte prompt port against the real Lua golden file
- season boundaries and trigger decisions against history fixtures
- history atomic write/read-back and corrupt-file behaviour
- OKR extraction and continuity fallback
- Anthropic request shape, refusal and truncation handling, against a stub SDK
- cycle and poller behaviour against fakes
- server routes, SSE lifecycle and path-traversal rejection

`npm run build` at the root must succeed from a clean `node_modules`, and `luac -p dwarven-coop.lua` must pass.

**Manual** — needs a live fortress (available now: year 106, tick 87105, map loaded):
- Task 1 spike: declared length equals received length, JSON parses
- Task 2: `status` / `briefing` / `members` output byte-identical to their pre-change captures
- Task 10: MCP tools (`dfhack_status`, `coop_status`, `lua_eval`) respond after a Claude Code restart
- Task 13: browser rendering and live SSE update
- Task 14: the nine-step end-to-end script above

## Decisions taken during planning (not in the spec)

- **Failed-cycle retry:** bounded — up to `MAX_CYCLE_ATTEMPTS = 3` attempts per season, then the season is abandoned until the next one. `POST /api/cycle` ignores the cap. Encoded in `shouldTriggerCycle` (Task 7) and the `attempts` field (Tasks 6, 11).
- **Corrupt `history.json`:** fail loud at startup with the file path, rather than silently starting fresh and re-triggering handled seasons.
- **Liveness probe:** `dfhack.world.isFortressMode()` + `dfhack.isMapLoaded()` instead of the spec's `gamemode` check.
- **Retries at the API layer:** the SDK's own `maxRetries: 3`, replacing the spec's hand-rolled backoff loop, which would have stacked to 9 requests per cycle.
- **`stop_reason` handling:** `refusal` and `max_tokens` are recorded as failed cycles — the spec's error table omits both, and a refusal stored as "completed" would poison the next quarter's continuity.
- **Schema sentinel:** `schema: 1` in the JSON payload, so a stale installed `dwarven-coop.lua` produces an actionable "run ./install.sh" error rather than a confusing parse failure.

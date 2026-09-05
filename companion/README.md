# Dwarven Companion

A small local service that replaces the copy-paste LLM workflow for
`dwarven-coop`: it polls DFHack for the in-game season, runs
`dwarven-coop assembly` when a new quarter starts, sends the resulting
briefing to Claude, and serves the result (plus history) over a tiny web UI.

## Prerequisites

- Node.js and the dependencies installed (`npm install` from this directory).
- Dwarf Fortress running with DFHack, remote server reachable (default
  `localhost:5000`).
- An Anthropic API key.

## Configuration

Copy `.env.example` to `.env` (or otherwise set the same environment
variables) and fill in `ANTHROPIC_API_KEY`. All other variables have
sensible defaults -- see `.env.example` for the full list and what each one
does.

## Running

```bash
npm run build
npm start
```

Or during development:

```bash
npm run dev
```

The server logs the URL it's listening on (`COMPANION_PORT`, default
`3000`). Open that URL in a browser for the status/history UI, which updates
live via Server-Sent Events.

Stop the process with `Ctrl-C` (`SIGINT`) or `SIGTERM`; it stops the poller
and closes the HTTP server before exiting.

## API

- `GET  /api/status` -- current poller status (DFHack connection, in-game
  date, last cycle, etc).
- `GET  /api/history` -- all recorded cycles.
- `GET  /api/events` -- Server-Sent Events stream of status/cycle updates.
- `POST /api/cycle` -- manually trigger a cycle immediately (bypasses the
  bounded-retry cap used by automatic polling).

## Data

Cycle history is persisted as JSON at `<DATA_DIR>/history.json`
(`DATA_DIR` defaults to `./data`). A corrupt history file fails the app at
startup with an error naming the file path, rather than silently discarding
history.

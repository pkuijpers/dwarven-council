// Entrypoint: wires config, history, DFHack client, Anthropic client, the
// poller, and the HTTP/SSE server together, then starts listening.
//
// Kept intentionally thin -- all behavior lives in the modules it wires up;
// this file only constructs and connects them.

import * as path from 'node:path';
import { loadConfig } from './config.js';
import { HistoryStore } from './history.js';
import { createAssemblyClient } from './anthropic.js';
import { createRunCommand } from './dfhack.js';
import { Poller, type PollerDeps } from './poller.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const history = new HistoryStore(path.resolve(config.dataDir, 'history.json'));
  // Fail fast on a corrupt history file at startup, rather than silently
  // starting with empty history and only surfacing the parse error on the
  // first poll tick or API request (see HistoryStore.load()'s doc comment).
  await history.load();

  const deps: PollerDeps = {
    runCommand: createRunCommand(config),
    assembly: createAssemblyClient(config),
    history,
    now: () => new Date(),
  };

  const poller = new Poller(deps, config);
  poller.start();

  const server = createServer({
    poller,
    history,
    publicDir: new URL('../public/', import.meta.url),
  });

  server.listen(config.companionPort, () => {
    console.log(`Dwarven Companion listening on http://localhost:${config.companionPort}`);
  });

  const shutdown = (signal: string): void => {
    console.log(`Received ${signal}, shutting down...`);
    poller.stop();
    server.close(() => {
      process.exit(0);
    });
    // server.close()'s callback only fires once every open connection ends.
    // A long-lived SSE stream (GET /api/events) never ends on its own, so
    // without this the process would hang forever whenever a browser tab
    // with the UI open is still connected at shutdown time. Force-close all
    // sockets (available since Node 18.2) so the close callback above fires
    // promptly.
    server.closeAllConnections();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

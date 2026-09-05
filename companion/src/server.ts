// Raw `node:http` server -- five routes do not justify a framework
// dependency, and companion stays as light as `mcp-server`.
//
// `deps.publicDir` is expected to come from `new URL('../public/', import.meta.url)`
// (ESM has no `__dirname`). Static files (`GET /` and anything else under
// `publicDir`, e.g. `app.js`/`style.css`) are served from there, guarded
// against path traversal (see `resolveStaticPath`).
//
// Response shapes (not prescribed by the design spec, documented here for
// callers/the UI):
//   GET  /api/history  -> 200, JSON array of `Cycle`.
//   GET  /api/status   -> 200, JSON `PollerStatus`.
//   POST /api/cycle    -> 200 with the resulting `Cycle` JSON on success;
//                         409 `{ error }` if a cycle was already running
//                         (matches `Poller.triggerNow()`'s rejection message);
//                         500 `{ error }` for any other failure.
//   Any other error (unknown route, static file missing, traversal
//   attempt) -> `{ error }` JSON with the matching status code.

import * as http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
import type { Poller, PollerStatus } from './poller.js';
import type { Cycle, HistoryStore } from './history.js';

export interface ServerDeps {
  poller: Poller;
  history: HistoryStore;
  publicDir: URL;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** How often an open SSE connection gets a `: ping\n\n` comment to keep intermediaries from timing it out. */
const HEARTBEAT_INTERVAL_MS = 15000;

export function createServer(deps: ServerDeps): http.Server {
  const publicDirPath = fileURLToPath(deps.publicDir);

  return http.createServer((req, res) => {
    handleRequest(req, res, deps, publicDirPath).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
  publicDirPath: string
): Promise<void> {
  const method = req.method ?? 'GET';
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (method === 'GET' && pathname === '/api/history') {
    sendJson(res, 200, await deps.history.load());
    return;
  }

  if (method === 'GET' && pathname === '/api/status') {
    sendJson(res, 200, deps.poller.getStatus());
    return;
  }

  if (method === 'GET' && pathname === '/api/events') {
    handleSse(req, res, deps.poller);
    return;
  }

  if (method === 'POST' && pathname === '/api/cycle') {
    await handleTriggerCycle(res, deps.poller);
    return;
  }

  if (method === 'GET') {
    await serveStatic(res, pathname, publicDirPath);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function handleTriggerCycle(res: http.ServerResponse, poller: Poller): Promise<void> {
  try {
    const cycle: Cycle = await poller.triggerNow();
    sendJson(res, 200, cycle);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `Poller.triggerNow()` rejects with this exact message (see
    // `src/poller.ts`) when a cycle is already in flight -- everything else
    // is an unexpected failure.
    if (/already running/i.test(message)) {
      sendJson(res, 409, { error: message });
    } else {
      sendJson(res, 500, { error: message });
    }
  }
}

function handleSse(req: http.IncomingMessage, res: http.ServerResponse, poller: Poller): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Push the current status immediately so a freshly opened tab is never
  // blank while it waits for the next change.
  writeSseEvent(res, 'status', poller.getStatus());

  const unsubscribeChange = poller.onChange((status: PollerStatus) => {
    writeSseEvent(res, 'status', status);
  });
  const unsubscribeCycle = poller.onCycle((cycle: Cycle) => {
    writeSseEvent(res, 'cycle', cycle);
  });

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  // Missing this cleanup leaks a listener pair (and a live timer) per
  // browser refresh/tab close, since the poller lives for the lifetime of
  // the process while SSE connections come and go.
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribeChange();
    unsubscribeCycle();
  });
}

function writeSseEvent(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function serveStatic(res: http.ServerResponse, pathname: string, publicDirPath: string): Promise<void> {
  const resolved = resolveStaticPath(pathname, publicDirPath);
  if (resolved === undefined) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  let data: Buffer;
  try {
    data = await readFile(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    throw err;
  }

  const contentType = MIME_TYPES[extname(resolved)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(data);
}

/**
 * Resolves a URL pathname to a file inside `publicDirPath`, or `undefined`
 * if it would escape it.
 *
 * The WHATWG `URL` parser already collapses literal `..` segments (and their
 * `%2e`/`%2E`-encoded forms) before `pathname` is ever produced, so it can
 * never itself contain a `..` segment -- but an *encoded slash* (`%2F`)
 * survives that parse untouched as a single opaque path segment. Decoding it
 * here (as we must, to map URL segments to filesystem names) can therefore
 * reintroduce a `..` segment post-parse, e.g. `/..%2Fsecret.txt` decodes to
 * `../secret.txt`. This is the classic path-traversal vector for static
 * file servers, which is why the containment check below happens on the
 * fully decoded-and-resolved path, not on the raw pathname.
 */
function resolveStaticPath(pathname: string, publicDirPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined; // malformed percent-encoding
  }

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = resolve(publicDirPath, relative);
  const root = publicDirPath.endsWith(sep) ? publicDirPath : `${publicDirPath}${sep}`;

  if (!resolved.startsWith(root)) {
    return undefined;
  }
  return resolved;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

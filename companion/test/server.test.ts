import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo, Socket } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { createServer } from '../src/server.js';
import type { PollerStatus, Poller } from '../src/poller.js';
import type { Cycle, HistoryStore } from '../src/history.js';

/**
 * In-memory fake Poller -- same shape/contract as the real `Poller`
 * (see `src/poller.ts`), but with directly-inspectable listener arrays so
 * tests can assert on SSE subscribe/unsubscribe behavior, and a swappable
 * `triggerNowImpl` so `POST /api/cycle` can be exercised against success,
 * "already running", and generic-failure outcomes without a real timer-driven
 * poll loop.
 */
class FakePoller {
  status: PollerStatus = {
    connected: true,
    fortressLoaded: true,
    cycleRunning: false,
    date: {
      year: 106,
      tick: 87105,
      seasonIndex: 0,
      seasonName: 'Spring',
      fortressMode: true,
      mapLoaded: true,
    },
  };

  changeListeners: Array<(status: PollerStatus) => void> = [];
  cycleListeners: Array<(cycle: Cycle) => void> = [];
  triggerNowImpl: () => Promise<Cycle> = async () => {
    throw new Error('triggerNowImpl not configured for this test');
  };

  getStatus(): PollerStatus {
    return this.status;
  }

  onChange(fn: (status: PollerStatus) => void): () => void {
    this.changeListeners.push(fn);
    return () => {
      this.changeListeners = this.changeListeners.filter((f) => f !== fn);
    };
  }

  onCycle(fn: (cycle: Cycle) => void): () => void {
    this.cycleListeners.push(fn);
    return () => {
      this.cycleListeners = this.cycleListeners.filter((f) => f !== fn);
    };
  }

  triggerNow(): Promise<Cycle> {
    return this.triggerNowImpl();
  }

  emitCycle(cycle: Cycle): void {
    for (const fn of [...this.cycleListeners]) {
      fn(cycle);
    }
  }
}

/** In-memory fake HistoryStore -- same contract as `src/history.ts`. */
class FakeHistoryStore {
  records: Cycle[] = [];

  async load(): Promise<Cycle[]> {
    return [...this.records];
  }

  async upsert(cycle: Cycle): Promise<void> {
    this.records.push(cycle);
  }

  async latest(): Promise<Cycle | undefined> {
    return this.records[this.records.length - 1];
  }

  async find(id: string): Promise<Cycle | undefined> {
    return this.records.find((r) => r.id === id);
  }
}

function makeCycle(overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: '106-0',
    year: 106,
    seasonIndex: 0,
    seasonName: 'Spring',
    triggeredAt: '2026-09-04T00:00:00.000Z',
    status: 'completed',
    attempts: 1,
    briefing: '# Briefing',
    state: { population: { total: 10 } },
    assembly: 'assembly text',
    okrs: 'okrs text',
    ...overrides,
  };
}

let dir: string;
let publicDirPath: string;
let outsideSecretPath: string;
let fakePoller: FakePoller;
let fakeHistory: FakeHistoryStore;
let server: Server;
let baseUrl: string;
let openSockets: Set<Socket>;

async function startServer(): Promise<void> {
  server = createServer({
    poller: fakePoller as unknown as Poller,
    history: fakeHistory as unknown as HistoryStore,
    publicDir: pathToFileURL(publicDirPath + sep),
  });
  // Track raw sockets so `stopServer()` can force-close a lingering one
  // (e.g. an aborted SSE fetch) instead of waiting out Node's default
  // ~5s keep-alive/socket teardown, which otherwise makes `server.close()`
  // hang well past the point the abort has already been fully handled
  // (listener cleanup itself happens within milliseconds -- verified
  // separately; this is purely a test-teardown speed concern).
  openSockets = new Set();
  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://localhost:${port}`;
}

async function stopServer(): Promise<void> {
  for (const socket of openSockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dwarven-server-'));
  publicDirPath = join(dir, 'public');
  mkdirSync(publicDirPath);
  writeFileSync(join(publicDirPath, 'index.html'), '<!doctype html><title>Dwarven Companion</title>');
  writeFileSync(join(publicDirPath, 'app.js'), 'console.log("hello");');
  writeFileSync(join(publicDirPath, 'style.css'), 'body { margin: 0; }');
  outsideSecretPath = join(dir, 'secret.txt');
  writeFileSync(outsideSecretPath, 'TOP SECRET, MUST NEVER BE SERVED');

  fakePoller = new FakePoller();
  fakeHistory = new FakeHistoryStore();
});

afterEach(async () => {
  await stopServer();
  rmSync(dir, { recursive: true, force: true });
});

describe('createServer', () => {
  it('GET / serves the index.html file from publicDir', async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Dwarven Companion');
  });

  it('GET /app.js and GET /style.css serve the static files', async () => {
    await startServer();
    const js = await fetch(`${baseUrl}/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(await js.text()).toContain('hello');

    const css = await fetch(`${baseUrl}/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toMatch(/css/);
    expect(await css.text()).toContain('margin');
  });

  it('GET /api/history returns the history store contents as JSON', async () => {
    fakeHistory.records.push(makeCycle({ id: '106-0' }), makeCycle({ id: '106-1', seasonIndex: 1 }));
    await startServer();
    const res = await fetch(`${baseUrl}/api/history`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as Cycle[];
    expect(body).toHaveLength(2);
    expect(body.map((c) => c.id)).toEqual(['106-0', '106-1']);
  });

  it('GET /api/status returns the poller status as JSON', async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PollerStatus;
    expect(body).toMatchObject({
      connected: true,
      fortressLoaded: true,
      cycleRunning: false,
    });
    expect(body.date?.year).toBe(106);
  });

  it('unknown path returns 404', async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('path traversal via an encoded slash never returns file contents outside publicDir', async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/..%2Fsecret.txt`);
    expect([403, 404]).toContain(res.status);
    const body = await res.text();
    expect(body).not.toContain('TOP SECRET');
  });

  // This request never reaches the traversal guard: the WHATWG URL parser
  // normalizes '..' away before fetch() ever sends it. Kept for
  // documentation; the encoded-slash case above is the one that actually
  // exercises resolveStaticPath's guard.
  it('a literal ".." path segment never returns file contents outside publicDir', async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/../secret.txt`);
    expect([403, 404]).toContain(res.status);
    const body = await res.text();
    expect(body).not.toContain('TOP SECRET');
  });

  it('POST /api/cycle triggers the poller and returns the resulting cycle', async () => {
    const cycle = makeCycle({ id: '106-2' });
    fakePoller.triggerNowImpl = async () => cycle;
    await startServer();
    const res = await fetch(`${baseUrl}/api/cycle`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Cycle;
    expect(body.id).toBe('106-2');
  });

  it('POST /api/cycle returns 409 when a cycle is already running', async () => {
    fakePoller.triggerNowImpl = async () => {
      throw new Error('A cycle is already running');
    };
    await startServer();
    const res = await fetch(`${baseUrl}/api/cycle`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('POST /api/cycle returns 500 on an unexpected failure', async () => {
    fakePoller.triggerNowImpl = async () => {
      throw new Error('disk full');
    };
    await startServer();
    const res = await fetch(`${baseUrl}/api/cycle`, { method: 'POST' });
    expect(res.status).toBe(500);
  });

  describe('GET /api/events (SSE)', () => {
    /** Reads SSE "frames" off the stream, skipping `: ping` heartbeat comments. */
    async function nextEvent(
      reader: ReadableStreamDefaultReader<Uint8Array>,
      decoder: TextDecoder,
      state: { buffer: string }
    ): Promise<{ event: string; data: string }> {
      for (;;) {
        while (!state.buffer.includes('\n\n')) {
          const { value, done } = await reader.read();
          if (done) {
            throw new Error('SSE stream ended before a full event was received');
          }
          state.buffer += decoder.decode(value, { stream: true });
        }
        const idx = state.buffer.indexOf('\n\n');
        const raw = state.buffer.slice(0, idx);
        state.buffer = state.buffer.slice(idx + 2);
        if (raw.startsWith(':')) {
          continue; // heartbeat comment, keep reading
        }
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
          else if (line.startsWith('data:')) data = line.slice('data:'.length).trim();
        }
        return { event, data };
      }
    }

    it('sends the correct SSE headers', async () => {
      await startServer();
      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      expect(res.headers.get('cache-control')).toMatch(/no-cache/);
      controller.abort();
    });

    it('pushes the current status immediately, then a cycle event when the poller emits one', async () => {
      await startServer();
      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const state = { buffer: '' };

      const first = await nextEvent(reader, decoder, state);
      expect(first.event).toBe('status');
      expect(JSON.parse(first.data)).toMatchObject({ connected: true });

      const cycle = makeCycle({ id: '106-3' });
      fakePoller.emitCycle(cycle);

      const second = await nextEvent(reader, decoder, state);
      expect(second.event).toBe('cycle');
      expect(JSON.parse(second.data).id).toBe('106-3');

      controller.abort();
    });

    it('closing the SSE connection unsubscribes both poller listeners', async () => {
      await startServer();
      expect(fakePoller.changeListeners).toHaveLength(0);
      expect(fakePoller.cycleListeners).toHaveLength(0);

      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const state = { buffer: '' };
      // Consume the initial status event so the connection is fully
      // established server-side before we close it.
      await nextEvent(reader, decoder, state);

      expect(fakePoller.changeListeners).toHaveLength(1);
      expect(fakePoller.cycleListeners).toHaveLength(1);

      controller.abort();

      await vi.waitFor(() => {
        expect(fakePoller.changeListeners).toHaveLength(0);
        expect(fakePoller.cycleListeners).toHaveLength(0);
      });
    });

    // Regression test for the shutdown hang found in Task 14 review: Node's
    // `server.close(callback)` never fires `callback` while any connection
    // stays open, and an SSE stream is exactly such a connection (it never
    // ends on its own). `main.ts`'s shutdown handler used to call only
    // `server.close()`, which hung forever whenever a browser tab with the
    // UI open (i.e. an open `/api/events` connection) was still connected at
    // signal time. The fix is `server.closeAllConnections()` alongside
    // `server.close()`. This test exercises the real `http` server directly
    // (not a fake), so it would fail if that call were ever removed.
    it('server.closeAllConnections() lets server.close() finish promptly with an open SSE connection', async () => {
      // Starts the shared server too (leaving it untouched) purely so the
      // outer afterEach's stopServer() has a live, still-listening `server`
      // to close as usual -- this test performs its own close sequence on a
      // separate `localServer` instance and shouldn't interact with that
      // shared teardown.
      await startServer();

      const localServer = createServer({
        poller: fakePoller as unknown as Poller,
        history: fakeHistory as unknown as HistoryStore,
        publicDir: pathToFileURL(publicDirPath + sep),
      });
      await new Promise<void>((resolve) => localServer.listen(0, resolve));
      const { port } = localServer.address() as AddressInfo;

      // Open a real SSE connection and deliberately leave it open (no
      // abort) -- this is exactly what a browser tab with the UI open looks
      // like at shutdown time.
      const controller = new AbortController();
      const res = await fetch(`http://localhost:${port}/api/events`, { signal: controller.signal });
      expect(res.status).toBe(200);

      const closed = new Promise<void>((resolve, reject) => {
        localServer.close((err) => (err ? reject(err) : resolve()));
      });
      localServer.closeAllConnections();

      const outcome = await Promise.race([
        closed.then(() => 'closed' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
      ]);
      expect(outcome).toBe('closed');

      controller.abort();
    });
  });
});

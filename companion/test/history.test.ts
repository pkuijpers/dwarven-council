import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore, type Cycle } from '../src/history.js';

let dir: string;
let historyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dwarven-history-'));
  historyPath = join(dir, 'history.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeCycle(overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: '106-1',
    year: 106,
    seasonIndex: 1,
    seasonName: 'Spring',
    triggeredAt: '2026-09-04T00:00:00.000Z',
    status: 'completed',
    attempts: 1,
    briefing: '# Briefing',
    state: { population: { total: 10 } },
    ...overrides,
  };
}

describe('HistoryStore', () => {
  it('load() on a missing file returns []', async () => {
    const store = new HistoryStore(historyPath);
    expect(await store.load()).toEqual([]);
  });

  it('upsert into a missing file creates it', async () => {
    const store = new HistoryStore(historyPath);
    expect(existsSync(historyPath)).toBe(false);
    await store.upsert(makeCycle());
    expect(existsSync(historyPath)).toBe(true);
    const records = await store.load();
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('106-1');
  });

  it('two upserts with different ids read back in order', async () => {
    const store = new HistoryStore(historyPath);
    await store.upsert(makeCycle({ id: '106-1' }));
    await store.upsert(makeCycle({ id: '106-2', seasonIndex: 2, seasonName: 'Summer' }));
    const records = await store.load();
    expect(records.map((r) => r.id)).toEqual(['106-1', '106-2']);
  });

  it('upserting the same id twice leaves one record, carrying the second one\'s fields', async () => {
    const store = new HistoryStore(historyPath);
    await store.upsert(makeCycle({ id: '106-1', status: 'failed', attempts: 1, error: 'boom' }));
    await store.upsert(makeCycle({ id: '106-1', status: 'completed', attempts: 2, okrs: 'the okrs' }));
    const records = await store.load();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: '106-1',
      status: 'completed',
      attempts: 2,
      okrs: 'the okrs',
    });
    expect(records[0].error).toBeUndefined();
  });

  it('upsert preserves position of the replaced record rather than moving it to the end', async () => {
    const store = new HistoryStore(historyPath);
    await store.upsert(makeCycle({ id: '106-1' }));
    await store.upsert(makeCycle({ id: '106-2', seasonIndex: 2 }));
    await store.upsert(makeCycle({ id: '106-1', status: 'failed' }));
    const records = await store.load();
    expect(records.map((r) => r.id)).toEqual(['106-1', '106-2']);
    expect(records[0].status).toBe('failed');
  });

  it('corrupt JSON throws with the path in the message', async () => {
    writeFileSync(historyPath, '{ not valid json', 'utf8');
    const store = new HistoryStore(historyPath);
    await expect(store.load()).rejects.toThrow(historyPath);
  });

  it('no .tmp file remains after a successful write', async () => {
    const store = new HistoryStore(historyPath);
    await store.upsert(makeCycle());
    const files = readdirSync(dir);
    expect(files).toEqual(['history.json']);
  });

  it('a pre-existing stale .tmp does not break the write', async () => {
    const store = new HistoryStore(historyPath);
    writeFileSync(`${historyPath}.tmp`, 'stale garbage from a crashed run', 'utf8');
    await store.upsert(makeCycle());
    const records = await store.load();
    expect(records).toHaveLength(1);
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['history.json']);
  });

  it('latest() on empty history returns undefined', async () => {
    const store = new HistoryStore(historyPath);
    expect(await store.latest()).toBeUndefined();
  });

  it('latest() returns the last-appended record, not the largest id', async () => {
    const store = new HistoryStore(historyPath);
    await store.upsert(makeCycle({ id: '106-1' }));
    await store.upsert(makeCycle({ id: '106-2', seasonIndex: 2 }));
    const latest = await store.latest();
    expect(latest?.id).toBe('106-2');
  });

  it('find() hits an existing id', async () => {
    const store = new HistoryStore(historyPath);
    await store.upsert(makeCycle({ id: '106-1' }));
    await store.upsert(makeCycle({ id: '106-2', seasonIndex: 2 }));
    const found = await store.find('106-1');
    expect(found?.id).toBe('106-1');
  });

  it('find() misses a non-existent id', async () => {
    const store = new HistoryStore(historyPath);
    await store.upsert(makeCycle({ id: '106-1' }));
    const found = await store.find('does-not-exist');
    expect(found).toBeUndefined();
  });

  it('mkdir -p\'s the data directory on construction, before any file exists', () => {
    const nested = join(dir, 'nested', 'deeper', 'history.json');
    expect(existsSync(join(dir, 'nested'))).toBe(false);
    new HistoryStore(nested);
    expect(existsSync(join(dir, 'nested', 'deeper'))).toBe(true);
  });
});

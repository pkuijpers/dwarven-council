import { mkdirSync } from 'node:fs';
import { open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Cycle {
  id: string;
  year: number;
  seasonIndex: number;
  seasonName: string;
  triggeredAt: string;
  status: 'completed' | 'failed';
  attempts: number; // bounded-retry support, see Task 7
  briefing: string;
  state: unknown;
  assembly?: string;
  okrs?: string;
  error?: string;
}

/**
 * Atomic, append/replace JSON history store for quarterly "cycle" records.
 *
 * Writes go to a `<filePath>.tmp` file in the *same directory* as the
 * target (never `os.tmpdir()` -- a cross-filesystem rename would not be
 * atomic), fsync that handle, then `rename()` it over the real file. This
 * guarantees a reader never observes a partially-written history file, even
 * across a crash mid-write.
 *
 * A corrupt (unparseable) history file is a hard failure at load time,
 * deliberately not swallowed into `[]`: silently starting over would
 * re-trigger an already-handled season and quietly break the continuity
 * feature this store exists for.
 */
export class HistoryStore {
  private readonly filePath: string;
  private readonly tmpPath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.tmpPath = `${filePath}.tmp`;
    mkdirSync(dirname(filePath), { recursive: true });
  }

  async load(): Promise<Cycle[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    try {
      return JSON.parse(raw) as Cycle[];
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Corrupt history file at ${this.filePath}: ${reason}`);
    }
  }

  /** Replaces the record sharing `cycle.id`, preserving its position; else appends. */
  async upsert(cycle: Cycle): Promise<void> {
    const records = await this.load();
    const idx = records.findIndex((r) => r.id === cycle.id);
    if (idx === -1) {
      records.push(cycle);
    } else {
      records[idx] = cycle;
    }
    await this.writeAtomic(records);
  }

  async latest(): Promise<Cycle | undefined> {
    const records = await this.load();
    return records[records.length - 1];
  }

  async find(id: string): Promise<Cycle | undefined> {
    const records = await this.load();
    return records.find((r) => r.id === id);
  }

  private async writeAtomic(records: Cycle[]): Promise<void> {
    const data = JSON.stringify(records, null, 2);
    const handle = await open(this.tmpPath, 'w');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(this.tmpPath, this.filePath);
  }
}

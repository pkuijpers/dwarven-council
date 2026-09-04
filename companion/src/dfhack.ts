import { DFHackClient } from '@dwarvencouncil/dfhack-client';
import type { CompanionConfig } from './config.js';
import { DATE_PROBE_LUA, parseDateProbe, type GameDate } from './season.js';
import { extractPayload, type AssemblyPayload } from './payload.js';

/**
 * Connects, runs `fn`, and disconnects in `finally` -- matching the
 * client's deliberate per-call connect/force-disconnect design (see
 * `DFHackClient.connect()`, which unconditionally force-disconnects any
 * prior socket first), exactly as `mcp-server/src/index.ts` does today.
 */
export async function withConnection<T>(
  config: CompanionConfig,
  fn: (client: DFHackClient) => Promise<T>
): Promise<T> {
  const client = new DFHackClient({
    host: config.dfhackHost,
    port: config.dfhackPort,
    timeout: config.dfhackTimeoutMs,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/**
 * Plain `runCommand`-shaped function backed by the per-call
 * connect/disconnect pattern in {@link withConnection}. Used by callers
 * (the cycle orchestrator, the poller) that just want to issue one command
 * without manually managing a client/connection.
 */
export function createRunCommand(
  config: CompanionConfig
): (cmd: string, args?: string[]) => Promise<{ success: boolean; output: string; error?: string }> {
  return (cmd, args) => withConnection(config, (c) => c.runCommand(cmd, args));
}

/** Fetches and parses the current in-game date via {@link DATE_PROBE_LUA}. */
export async function fetchGameDate(config: CompanionConfig): Promise<GameDate> {
  return withConnection(config, async (client) => {
    const result = await client.runCommand('lua', [DATE_PROBE_LUA]);
    if (!result.success) {
      throw new Error(`Date probe failed: ${result.error ?? '(unknown error)'}`);
    }
    return parseDateProbe(result.output);
  });
}

/**
 * Runs `dwarven-coop assembly` and extracts the JSON state payload it
 * prints between sentinel markers.
 */
export async function fetchAssemblyPayload(config: CompanionConfig): Promise<AssemblyPayload> {
  return withConnection(config, async (client) => {
    const result = await client.runCommand('dwarven-coop', ['assembly']);
    if (!result.success) {
      throw new Error(`dwarven-coop assembly failed: ${result.error ?? '(unknown error)'}`);
    }
    return extractPayload(result.output);
  });
}

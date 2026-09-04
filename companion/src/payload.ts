import type { CoopState } from './types.js';

export const STATE_BEGIN = '===DWARVEN_ASSEMBLY_STATE_JSON===';
export const STATE_END = '===DWARVEN_ASSEMBLY_STATE_END===';
export const SUPPORTED_SCHEMA = 1;

export class PayloadError extends Error {
  constructor(
    message: string,
    readonly rawOutput: string
  ) {
    super(message);
    this.name = 'PayloadError';
  }
}

export interface AssemblyPayload {
  schema: number;
  state: CoopState;
  briefing: string;
}

/**
 * Extracts and parses the JSON state payload that `dwarven-coop assembly`
 * prints between sentinel markers.
 *
 * The line immediately after STATE_BEGIN declares the payload length as
 * counted by Lua's `#payload` -- a UTF-8 *byte* count. That figure is kept
 * only as diagnostic context in error messages: it will not generally equal
 * the JS string length of the extracted payload (UTF-16 code units), even
 * for a perfectly intact payload, because Dwarf Fortress data legitimately
 * contains multi-byte Unicode glyphs and lossy-decoded name bytes. The
 * authoritative integrity signal is `JSON.parse` succeeding on the full
 * body between the markers, not byte-length equality.
 */
export function extractPayload(output: string): AssemblyPayload {
  const normalized = output.replace(/\r\n/g, '\n');

  const beginIdx = normalized.indexOf(STATE_BEGIN);
  if (beginIdx === -1) {
    throw new PayloadError(`Missing ${STATE_BEGIN} marker in output`, output);
  }

  const endIdx = normalized.indexOf(STATE_END, beginIdx + STATE_BEGIN.length);
  if (endIdx === -1) {
    throw new PayloadError(`Missing ${STATE_END} marker in output`, output);
  }

  const between = normalized.slice(beginIdx + STATE_BEGIN.length, endIdx);
  const lines = between.split('\n');

  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) {
    throw new PayloadError(
      'Missing declared-length line after start marker',
      output
    );
  }
  const declaredLength = parseInt(lines[i], 10);
  i++;

  const body = lines.slice(i).join('\n').replace(/\n$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PayloadError(
      `Payload body is not valid JSON (declared length ${declaredLength}, ` +
        `actual length ${body.length}): ${reason}`,
      output
    );
  }

  const payload = parsed as AssemblyPayload;

  if (payload.schema !== SUPPORTED_SCHEMA) {
    throw new PayloadError(
      `Unsupported schema version ${payload.schema} (expected ${SUPPORTED_SCHEMA}). ` +
        'The installed dwarven-coop.lua may be stale -- run ./install.sh.',
      output
    );
  }

  return payload;
}

/**
 * Normalizes a Lua-encoded table that may arrive as either an object
 * (populated table) or an empty array (Lua's `json.encode` emits `[]` for
 * an empty table, since Lua has no distinct empty-map representation).
 */
export function asRecord<T>(
  v: Record<string, T> | unknown[] | undefined
): Record<string, T> {
  if (v === undefined) return {};
  if (Array.isArray(v)) return {};
  return v;
}

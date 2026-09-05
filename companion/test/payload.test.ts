import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  extractPayload,
  asRecord,
  PayloadError,
  STATE_BEGIN,
  STATE_END,
} from '../src/payload.js';

const fixturePath = fileURLToPath(
  new URL('./fixtures/raw-assembly-output.txt', import.meta.url)
);
const rawFixture = readFileSync(fixturePath, 'utf8');

/** Builds a well-formed marker-delimited block for synthetic test inputs. */
function block(body: string, declaredLength: number = body.length): string {
  return `${STATE_BEGIN}\n${declaredLength}\n${body}\n${STATE_END}\n`;
}

const validBody = (briefing: string, schema = 1) =>
  JSON.stringify({ schema, state: {}, briefing });

describe('extractPayload', () => {
  it('1. happy path: parses the real fixture', () => {
    const payload = extractPayload(rawFixture);
    expect(payload.schema).toBe(1);
    expect(payload.briefing.startsWith('# Dwarven Cooperative')).toBe(true);
    expect(payload.state.population.total).toBeGreaterThan(0);
  });

  it('2. ignores leading noise before STATE_BEGIN', () => {
    const noisy = `[DFHack]#  some banner chatter\nMore noise here\n${rawFixture}`;
    const payload = extractPayload(noisy);
    expect(payload.schema).toBe(1);
    expect(payload.state.population.total).toBeGreaterThan(0);
  });

  it('3. \\r\\n line endings parse identically to \\n', () => {
    const crlf = rawFixture.replace(/\n/g, '\r\n');
    const payload = extractPayload(crlf);
    expect(payload.schema).toBe(1);
    expect(payload.briefing.startsWith('# Dwarven Cooperative')).toBe(true);
    expect(payload.state.population.total).toBeGreaterThan(0);
  });

  it('4 (ruling): a length mismatch with a valid JSON body does NOT throw', () => {
    // Real fixture: declared length 13953 (Lua UTF-8 byte count) != actual
    // JS string length 13949 (UTF-16 code units) because of multi-byte
    // glyphs and lossy-decoded DF name bytes. JSON.parse succeeding is the
    // authoritative integrity signal, not byte-length equality.
    const beginIdx = rawFixture.indexOf(STATE_BEGIN);
    const endIdx = rawFixture.indexOf(STATE_END, beginIdx);
    const between = rawFixture.slice(beginIdx + STATE_BEGIN.length, endIdx);
    const lines = between.split('\n').filter((l) => l.trim() !== '');
    const declaredLength = parseInt(lines[0], 10);
    const actualPayload = lines.slice(1).join('\n');

    expect(declaredLength).toBe(13953);
    expect(actualPayload.length).toBe(13949);
    expect(declaredLength).not.toBe(actualPayload.length);

    // Must still succeed despite the mismatch.
    const payload = extractPayload(rawFixture);
    expect(payload.schema).toBe(1);
    expect(payload.state).toBeTruthy();
  });

  it('4b (ruling): a marker-valid but truncated/invalid JSON body still throws, with declared/actual lengths in the message', () => {
    const truncatedBody = '{"schema":1,"state":{},"briefing":"trunc';
    const input = block(truncatedBody, 9999);

    let thrown: unknown;
    try {
      extractPayload(input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PayloadError);
    const err = thrown as PayloadError;
    expect(err.message).toContain('9999');
    expect(err.message).toContain(String(truncatedBody.length));
  });

  it('5. missing STATE_BEGIN throws PayloadError with rawOutput equal to the input', () => {
    const input = `no markers here\njust noise\n${STATE_END}\n`;
    let thrown: unknown;
    try {
      extractPayload(input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PayloadError);
    expect((thrown as PayloadError).rawOutput).toBe(input);
  });

  it('6. missing STATE_END throws PayloadError', () => {
    const input = block(validBody('no end marker')).replace(`${STATE_END}\n`, '');
    expect(() => extractPayload(input)).toThrow(PayloadError);
  });

  it('7. markers present but body is not valid JSON throws PayloadError', () => {
    const input = block('this is not json at all');
    expect(() => extractPayload(input)).toThrow(PayloadError);
  });

  it('8. STATE_END appearing before STATE_BEGIN throws PayloadError', () => {
    const input = `${STATE_END}\nsome noise\n${STATE_BEGIN}\n${validBody('x').length}\n${validBody('x')}\n`;
    expect(() => extractPayload(input)).toThrow(PayloadError);
  });

  it('9. duplicate markers use the first STATE_BEGIN and the first STATE_END after it', () => {
    const first = block(validBody('first'));
    const second = block(validBody('second'));
    const payload = extractPayload(first + second);
    expect(payload.briefing).toBe('first');
  });

  it('10. schema 2 throws PayloadError mentioning ./install.sh', () => {
    const input = block(validBody('newer schema', 2));
    let thrown: unknown;
    try {
      extractPayload(input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PayloadError);
    expect((thrown as PayloadError).message).toContain('./install.sh');
  });

  it('11. asRecord tolerates empty-array-encoded Lua tables', () => {
    expect(asRecord([])).toEqual({});
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(undefined)).toEqual({});
  });
});

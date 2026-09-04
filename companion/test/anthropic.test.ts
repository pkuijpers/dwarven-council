import { describe, it, expect, vi } from 'vitest';
import type { CompanionConfig } from '../src/config.js';

// Capture the options `anthropic.ts` passes to `new Anthropic(...)` when it
// constructs its own client (no stub sdk injected), without losing the
// real SDK behavior (error classes, request validation, etc.) that the
// rest of this suite relies on.
const constructedOptions = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  class SpyAnthropic extends (actual.default as any) {
    constructor(opts: Record<string, unknown>) {
      constructedOptions.push(opts);
      super(opts);
    }
  }
  return { ...actual, default: SpyAnthropic };
});

const Anthropic = (await import('@anthropic-ai/sdk')).default;
const {
  createAssemblyClient,
  AssemblyRefusedError,
  AssemblyTruncatedError,
} = await import('../src/anthropic.js');

const baseConfig: CompanionConfig = {
  anthropicApiKey: 'sk-ant-test',
  dfhackHost: 'localhost',
  dfhackPort: 5000,
  dfhackTimeoutMs: 30000,
  companionPort: 3000,
  pollIntervalMs: 60000,
  effort: 'high',
  model: 'claude-opus-5',
  dataDir: './data',
};

const request = { system: 'you are the assembly', user: 'convene the assembly' };

/**
 * Minimal fake matching the shape of `sdk.messages.create` this module
 * calls: `{ messages: { create: (params) => Promise<...> } }`. Test bodies
 * return plain object literals shaped like the fields `anthropic.ts`
 * actually reads (`stop_reason`, `stop_details`, `content`), not full
 * `Message` objects, so this is intentionally loosely typed.
 */
function stubSdk(create: (params: unknown) => Promise<any>): InstanceType<typeof Anthropic> {
  return { messages: { create } } as unknown as InstanceType<typeof Anthropic>;
}

describe('createAssemblyClient', () => {
  it('sends the exact documented request shape, with no thinking/budget_tokens', async () => {
    let received: any;
    const sdk = stubSdk(async (params) => {
      received = params;
      return {
        stop_reason: 'end_turn',
        stop_details: null,
        content: [{ type: 'text', text: 'hello assembly' }],
      };
    });
    const client = createAssemblyClient(baseConfig, sdk);
    await client.generateAssembly(request);

    expect(received).toEqual({
      model: 'claude-opus-5',
      max_tokens: 16000,
      output_config: { effort: 'high' },
      system: 'you are the assembly',
      messages: [{ role: 'user', content: 'convene the assembly' }],
    });
    expect(received).not.toHaveProperty('thinking');
    expect(received).not.toHaveProperty('budget_tokens');
    expect(received.output_config).not.toHaveProperty('budget_tokens');
  });

  it('happy path: returns joined text from all text blocks', async () => {
    const sdk = stubSdk(async () => ({
      stop_reason: 'end_turn',
      stop_details: null,
      content: [
        { type: 'text', text: 'part one. ' },
        { type: 'text', text: 'part two.' },
      ],
    }));
    const client = createAssemblyClient(baseConfig, sdk);
    const result = await client.generateAssembly(request);
    expect(result).toBe('part one. part two.');
  });

  it('ignores non-text content blocks when joining', async () => {
    const sdk = stubSdk(async () => ({
      stop_reason: 'end_turn',
      stop_details: null,
      content: [
        { type: 'thinking', thinking: 'internal musings', signature: 'sig' } as any,
        { type: 'text', text: 'the actual assembly text' },
      ],
    }));
    const client = createAssemblyClient(baseConfig, sdk);
    const result = await client.generateAssembly(request);
    expect(result).toBe('the actual assembly text');
  });

  it('throws AssemblyRefusedError with the category on stop_reason "refusal"', async () => {
    const sdk = stubSdk(async () => ({
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'general_harms', explanation: 'nope' },
      content: [],
    }));
    const client = createAssemblyClient(baseConfig, sdk);
    await expect(client.generateAssembly(request)).rejects.toThrow(AssemblyRefusedError);
    try {
      await client.generateAssembly(request);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AssemblyRefusedError);
      expect((err as InstanceType<typeof AssemblyRefusedError>).category).toBe('general_harms');
    }
  });

  it('throws AssemblyRefusedError with a null category when stop_details is missing', async () => {
    const sdk = stubSdk(async () => ({
      stop_reason: 'refusal',
      stop_details: null,
      content: [],
    }));
    const client = createAssemblyClient(baseConfig, sdk);
    try {
      await client.generateAssembly(request);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AssemblyRefusedError);
      expect((err as InstanceType<typeof AssemblyRefusedError>).category).toBeNull();
    }
  });

  it('checks stop_reason before reading content: refusal wins even with content present', async () => {
    const sdk = stubSdk(async () => ({
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      content: [{ type: 'text', text: 'should not be returned' }],
    }));
    const client = createAssemblyClient(baseConfig, sdk);
    await expect(client.generateAssembly(request)).rejects.toThrow(AssemblyRefusedError);
  });

  it('throws AssemblyTruncatedError on stop_reason "max_tokens"', async () => {
    const sdk = stubSdk(async () => ({
      stop_reason: 'max_tokens',
      stop_details: null,
      content: [{ type: 'text', text: 'truncated partial text' }],
    }));
    const client = createAssemblyClient(baseConfig, sdk);
    await expect(client.generateAssembly(request)).rejects.toThrow(AssemblyTruncatedError);
  });

  it('propagates AuthenticationError unchanged (classification for the "check ANTHROPIC_API_KEY" hint is left to the caller/logger)', async () => {
    const authError = new Anthropic.AuthenticationError(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      'invalid x-api-key',
      new Headers()
    );
    const sdk = stubSdk(async () => {
      throw authError;
    });
    const client = createAssemblyClient(baseConfig, sdk);
    try {
      await client.generateAssembly(request);
      expect.unreachable();
    } catch (err) {
      expect(err).toBe(authError);
      expect(err).toBeInstanceOf(Anthropic.AuthenticationError);
      expect((err as InstanceType<typeof Anthropic.AuthenticationError>).status).toBe(401);
    }
  });

  it('propagates RateLimitError after the SDK exhausts its own retries (no manual retry loop)', async () => {
    const create = vi.fn(async () => {
      throw new Anthropic.RateLimitError(
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } },
        'rate limited',
        new Headers()
      );
    });
    const sdk = stubSdk(create);
    const client = createAssemblyClient(baseConfig, sdk);
    await expect(client.generateAssembly(request)).rejects.toThrow(Anthropic.RateLimitError);
    // Exactly one call into the stubbed create — this module must not wrap
    // the call in its own retry/backoff loop on top of the SDK's.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('propagates APIConnectionError', async () => {
    const sdk = stubSdk(async () => {
      throw new Anthropic.APIConnectionError({ message: 'connection failed' });
    });
    const client = createAssemblyClient(baseConfig, sdk);
    await expect(client.generateAssembly(request)).rejects.toThrow(Anthropic.APIConnectionError);
  });

  it('propagates a generic APIError, preserving .status', async () => {
    const sdk = stubSdk(async () => {
      throw new Anthropic.APIError(
        500,
        { type: 'error', error: { type: 'api_error', message: 'server exploded' } },
        'server exploded',
        new Headers()
      );
    });
    const client = createAssemblyClient(baseConfig, sdk);
    try {
      await client.generateAssembly(request);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(Anthropic.APIError);
      expect((err as InstanceType<typeof Anthropic.APIError>).status).toBe(500);
    }
  });

  it('constructs its own SDK client with maxRetries: 3 and the configured API key when none is injected', () => {
    constructedOptions.length = 0;
    createAssemblyClient(baseConfig);
    expect(constructedOptions).toHaveLength(1);
    expect(constructedOptions[0]).toMatchObject({
      apiKey: baseConfig.anthropicApiKey,
      maxRetries: 3,
    });
  });

  it('does not construct its own SDK client when one is injected', () => {
    constructedOptions.length = 0;
    createAssemblyClient(baseConfig, stubSdk(async () => ({
      stop_reason: 'end_turn',
      stop_details: null,
      content: [],
    })));
    expect(constructedOptions).toHaveLength(0);
  });
});

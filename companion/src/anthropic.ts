// Wraps `@anthropic-ai/sdk` to generate a quarterly "assembly" narrative
// from a system/user prompt pair (see prompt.ts's buildSystemPrompt /
// buildUserPrompt for what those look like).
//
// Deliberately thin: no manual retry/backoff loop is added on top of the
// SDK's own retry handling (constructed with `maxRetries: 3`), since the
// SDK already retries 429/5xx and honors `retry-after` correctly.

import Anthropic from '@anthropic-ai/sdk';
import type { Message, RefusalStopDetails } from '@anthropic-ai/sdk/resources/messages';
import type { CompanionConfig } from './config.js';

export interface AssemblyRequest {
  system: string;
  user: string;
}

export interface AssemblyClient {
  generateAssembly(req: AssemblyRequest): Promise<string>;
}

/**
 * Thrown when the model refuses to generate (`stop_reason: 'refusal'`).
 * `category` mirrors the SDK's own `RefusalStopDetails['category']` type --
 * reused directly here rather than redeclaring the literal union.
 */
export class AssemblyRefusedError extends Error {
  constructor(
    readonly category: RefusalStopDetails['category'],
    explanation?: string | null
  ) {
    super(
      explanation
        ? `Assembly generation refused (${category ?? 'unknown category'}): ${explanation}`
        : `Assembly generation refused (${category ?? 'unknown category'})`
    );
    this.name = 'AssemblyRefusedError';
  }
}

/** Thrown when the response was cut off (`stop_reason: 'max_tokens'`). */
export class AssemblyTruncatedError extends Error {
  constructor() {
    super('Assembly generation was truncated: response hit max_tokens');
    this.name = 'AssemblyTruncatedError';
  }
}

function extractText(content: Message['content']): string {
  return content
    .filter((block): block is Extract<Message['content'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function createAssemblyClient(
  config: CompanionConfig,
  sdk?: Anthropic
): AssemblyClient {
  const client: Anthropic =
    sdk ??
    new Anthropic({
      apiKey: config.anthropicApiKey,
      maxRetries: 3,
    });

  return {
    async generateAssembly(req: AssemblyRequest): Promise<string> {
      // Errors from `messages.create` propagate unchanged -- classification
      // (AuthenticationError -> check ANTHROPIC_API_KEY, RateLimitError /
      // APIConnectionError -> already retried by the SDK's maxRetries: 3,
      // APIError -> `.status` is already on the instance) is left to
      // whatever logs/stores the failure, not this call site.
      const message = await client.messages.create({
        model: config.model,
        max_tokens: 16000,
        output_config: { effort: config.effort },
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      });

      // Check stop_reason before reading content.
      if (message.stop_reason === 'refusal') {
        const details = message.stop_details;
        throw new AssemblyRefusedError(details?.category ?? null, details?.explanation ?? null);
      }
      if (message.stop_reason === 'max_tokens') {
        throw new AssemblyTruncatedError();
      }

      return extractText(message.content);
    },
  };
}

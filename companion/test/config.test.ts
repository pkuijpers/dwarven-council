import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { ANTHROPIC_API_KEY: 'sk-ant-test' };

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      dfhackHost: 'localhost', dfhackPort: 5000, companionPort: 3000,
      pollIntervalMs: 60000, effort: 'medium', model: 'claude-opus-5',
    });
  });
  it('throws naming the variable when the API key is missing', () => {
    expect(() => loadConfig({})).toThrow(/ANTHROPIC_API_KEY/);
  });
  it('rejects a non-numeric port instead of yielding NaN', () => {
    expect(() => loadConfig({ ...base, COMPANION_PORT: 'abc' })).toThrow(/COMPANION_PORT/);
  });
  it('rejects an unknown effort level', () => {
    expect(() => loadConfig({ ...base, CLAUDE_EFFORT: 'turbo' })).toThrow(/CLAUDE_EFFORT/);
  });
  it('always fixes model at claude-opus-5, regardless of env', () => {
    expect(loadConfig(base).model).toBe('claude-opus-5');
    expect(loadConfig({ ...base, CLAUDE_MODEL: 'claude-haiku' } as NodeJS.ProcessEnv).model).toBe(
      'claude-opus-5'
    );
  });
  it('reads dfhackTimeoutMs from DFHACK_TIMEOUT, defaulting to 30000', () => {
    expect(loadConfig(base).dfhackTimeoutMs).toBe(30000);
    expect(loadConfig({ ...base, DFHACK_TIMEOUT: '45000' }).dfhackTimeoutMs).toBe(45000);
  });
});

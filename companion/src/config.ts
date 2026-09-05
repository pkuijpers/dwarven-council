export interface CompanionConfig {
  anthropicApiKey: string;
  dfhackHost: string;
  dfhackPort: number;
  dfhackTimeoutMs: number;
  companionPort: number;
  pollIntervalMs: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  model: string;
  dataDir: string;
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// Fixed per the project's Global Constraints. Not configurable via
// environment variable.
const MODEL = 'claude-opus-5';

function requireString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
}

function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for environment variable: ${name}`);
  }
  return parsed;
}

function readEffort(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: CompanionConfig['effort']
): CompanionConfig['effort'] {
  const value = env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  if (!(EFFORT_LEVELS as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid value for environment variable: ${name} (expected one of ${EFFORT_LEVELS.join(', ')})`
    );
  }
  return value as CompanionConfig['effort'];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CompanionConfig {
  return {
    anthropicApiKey: requireString(env, 'ANTHROPIC_API_KEY'),
    dfhackHost: readString(env, 'DFHACK_HOST', 'localhost'),
    dfhackPort: readNumber(env, 'DFHACK_PORT', 5000),
    dfhackTimeoutMs: readNumber(env, 'DFHACK_TIMEOUT', 30000),
    companionPort: readNumber(env, 'COMPANION_PORT', 3000),
    pollIntervalMs: readNumber(env, 'POLL_INTERVAL_MS', 60000),
    effort: readEffort(env, 'CLAUDE_EFFORT', 'medium'),
    model: MODEL,
    dataDir: readString(env, 'DATA_DIR', './data'),
  };
}

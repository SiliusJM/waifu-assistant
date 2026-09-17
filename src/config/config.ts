import { AssistantError } from '../shared/errors.js';
import type { RetryPolicy } from '../ai/ai-types.js';

export type AIProviderKind = 'mock' | 'direct';

export interface AppConfig {
  readonly appEnv: string;
  readonly logLevel: 'info' | 'warn' | 'error';
  readonly ai: {
    readonly provider: AIProviderKind;
    readonly baseURL: string;
    readonly apiKey: string;
    readonly model: string;
    readonly timeoutMs: number;
    readonly retryPolicy: RetryPolicy;
  };
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AssistantError(name + ' must be a positive integer.', {
      code: 'CONFIGURATION_ERROR',
      retryable: false,
    });
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const provider = env.AI_PROVIDER ?? 'mock';
  if (provider !== 'mock' && provider !== 'direct') {
    throw new AssistantError('AI_PROVIDER must be mock or direct.', {
      code: 'CONFIGURATION_ERROR',
      retryable: false,
    });
  }

  const baseURL = env.AI_BASE_URL?.trim() ?? '';
  const apiKey = env.AI_API_KEY?.trim() ?? '';
  const model = env.AI_MODEL?.trim() ?? '';
  if (provider === 'direct' && (!baseURL || !apiKey || !model)) {
    throw new AssistantError(
      'Direct AI configuration requires AI_BASE_URL, AI_API_KEY and AI_MODEL.',
      { code: 'CONFIGURATION_ERROR', retryable: false },
    );
  }

  const logLevel = env.LOG_LEVEL ?? 'info';
  if (logLevel !== 'info' && logLevel !== 'warn' && logLevel !== 'error') {
    throw new AssistantError('LOG_LEVEL must be info, warn or error.', {
      code: 'CONFIGURATION_ERROR',
      retryable: false,
    });
  }

  return {
    appEnv: env.APP_ENV ?? 'development',
    logLevel,
    ai: {
      provider,
      baseURL,
      apiKey,
      model: model || 'mock-model',
      timeoutMs: positiveInteger('AI_TIMEOUT_MS', env.AI_TIMEOUT_MS, 10000),
      retryPolicy: {
        maxAttempts: positiveInteger('AI_MAX_ATTEMPTS', env.AI_MAX_ATTEMPTS, 2),
        baseDelayMs: positiveInteger('AI_RETRY_BASE_DELAY_MS', env.AI_RETRY_BASE_DELAY_MS, 100),
        maxDelayMs: positiveInteger('AI_RETRY_MAX_DELAY_MS', env.AI_RETRY_MAX_DELAY_MS, 1000),
      },
    },
  };
}

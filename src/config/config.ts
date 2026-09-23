import { AssistantError } from '../shared/errors.js';
import { resolveProviderConfig, type ResolvedProviderConfig } from './provider-config.js';
import type { CredentialResolver } from './credential-resolver.js';
export type { AIProviderKind } from './provider-config.js';

export interface AppConfig {
  readonly appEnv: string;
  readonly logLevel: 'info' | 'warn' | 'error';
  readonly ai: ResolvedProviderConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, credentials?: CredentialResolver): AppConfig {
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
    ai: resolveProviderConfig(env, credentials),
  };
}

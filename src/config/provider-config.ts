import { inspect } from 'node:util';
import type { RetryPolicy } from '../ai/ai-types.js';
import { AssistantError } from '../shared/errors.js';
import { EnvironmentCredentialResolver, type CredentialResolver } from './credential-resolver.js';
import { PROVIDER_PROFILES, type ProviderProfileId } from './provider-profiles.js';

export type AIProviderKind = 'mock' | 'direct';

export interface ResolvedProviderConfig {
  readonly provider: AIProviderKind;
  readonly profileId?: ProviderProfileId;
  readonly baseURL: string;
  /** In-memory accessor; excluded from enumeration, JSON and console inspection. */
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly retryPolicy: RetryPolicy;
}

function configError(message: string): AssistantError {
  return new AssistantError(message, { code: 'CONFIGURATION_ERROR', retryable: false });
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw configError(name + ' must be a positive integer.');
  return parsed;
}

function validateBaseURL(value: string): void {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname
      || url.username || url.password || url.search || url.hash || /\s/u.test(value)) throw new Error();
  } catch {
    throw configError('Provider base URL must be HTTP(S), without credentials, query or fragment.');
  }
}

export function toSafeProviderConfig(config: ResolvedProviderConfig) {
  const hideSecret = (value: string): string => config.apiKey && value.includes(config.apiKey) ? '[REDACTED]' : value;
  return {
    profileId: config.profileId ?? 'legacy',
    provider: config.provider,
    model: hideSecret(config.model),
    baseHost: config.baseURL ? hideSecret(new URL(config.baseURL).hostname) : '',
    credentialConfigured: Boolean(config.apiKey),
    timeoutMs: config.timeoutMs,
  };
}

export function formatProviderStatus(config: ResolvedProviderConfig): readonly string[] {
  const safe = toSafeProviderConfig(config);
  return [
    `Proveedor: ${safe.provider}`,
    `Perfil: ${safe.profileId}`,
    `Modelo: ${safe.model}`,
    `Host base: ${safe.baseHost || '(ninguno)'}`,
    `Credencial configurada: ${safe.credentialConfigured ? 'YES' : 'NO'}`,
  ];
}

export function resolveProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
  credentials: CredentialResolver = new EnvironmentCredentialResolver(env),
): ResolvedProviderConfig {
  const selection = env.AI_PROVIDER_PROFILE?.trim();
  const profile = selection ? PROVIDER_PROFILES.find(({ id }) => id === selection) : undefined;
  if (selection && !profile) throw configError('Unknown AI_PROVIDER_PROFILE.');
  const provider = profile ? 'direct' : env.AI_PROVIDER ?? 'mock';
  if (provider !== 'direct' && provider !== 'mock') throw configError('AI_PROVIDER must be mock or direct.');
  const baseURL = provider === 'mock' ? '' : profile
    ? env[profile.baseURLEnvName]?.trim() || profile.baseURL
    : env.AI_BASE_URL?.trim() ?? '';
  const model = profile ? env[profile.modelEnvName]?.trim() ?? '' : env.AI_MODEL?.trim() || 'mock-model';
  if (provider === 'direct') {
    if (!model || (!profile && !env.AI_MODEL?.trim())) throw configError('The selected provider requires a configured model.');
    validateBaseURL(baseURL);
  }
  if ([...model].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw configError('Provider model contains invalid characters.');
  }
  const timeoutMs = positiveInteger('AI_TIMEOUT_MS', env.AI_TIMEOUT_MS, 10000);
  const retryPolicy = Object.freeze({
    maxAttempts: positiveInteger('AI_MAX_ATTEMPTS', env.AI_MAX_ATTEMPTS, 2),
    baseDelayMs: positiveInteger('AI_RETRY_BASE_DELAY_MS', env.AI_RETRY_BASE_DELAY_MS, 100),
    maxDelayMs: positiveInteger('AI_RETRY_MAX_DELAY_MS', env.AI_RETRY_MAX_DELAY_MS, 1000),
  });
  let apiKey = '';
  if (provider === 'direct') {
    try {
      apiKey = credentials.resolve(profile ?? { credentialEnvName: 'AI_API_KEY' });
      if (!apiKey.trim() || /[\r\n\0]/u.test(apiKey)) throw new Error();
    } catch {
      // Resolvers are a secret boundary: do not propagate their messages/causes.
      throw configError('The selected provider credential is missing or invalid.');
    }
  }
  if (apiKey && (baseURL.includes(apiKey) || model.includes(apiKey))) {
    throw configError('A credential must not appear in public provider metadata.');
  }
  const config = Object.defineProperty({
    provider, ...(profile ? { profileId: profile.id } : {}), baseURL, model, timeoutMs, retryPolicy,
  }, 'apiKey', { get: () => apiKey, enumerable: false }) as ResolvedProviderConfig;
  Object.defineProperties(config, {
    toJSON: { value: () => toSafeProviderConfig(config) },
    [inspect.custom]: { value: () => toSafeProviderConfig(config) },
  });
  return Object.freeze(config);
}

export type ProviderProfileId = 'omniroute' | 'groq' | 'gemini' | 'openrouter';

export interface ProviderProfile {
  readonly id: ProviderProfileId;
  readonly displayName: string;
  readonly providerType: 'direct';
  readonly baseURL: string;
  readonly credentialEnvName: string;
  readonly modelEnvName: string;
  readonly baseURLEnvName: string;
}

// Models are deployment configuration, not permanent provider capabilities.
export const PROVIDER_PROFILES: readonly ProviderProfile[] = Object.freeze(([
  ['omniroute', 'OmniRoute', 'http://localhost:20128/v1'],
  ['groq', 'Groq', 'https://api.groq.com/openai/v1'],
  ['gemini', 'Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai'],
  ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1'],
] as const).map(([id, displayName, baseURL]) => Object.freeze({
  id,
  displayName,
  providerType: 'direct' as const,
  baseURL,
  credentialEnvName: `${id.toUpperCase()}_API_KEY`,
  modelEnvName: `${id.toUpperCase()}_MODEL`,
  baseURLEnvName: `${id.toUpperCase()}_BASE_URL`,
})));

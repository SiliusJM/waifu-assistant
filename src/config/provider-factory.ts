import type { AIProvider } from '../ai/ai-provider.js';
import { DirectAIProvider } from '../ai/direct-ai-provider.js';
import { MockAIProvider } from '../ai/mock-ai-provider.js';
import type { AppConfig } from './config.js';

export function createAIProvider(config: AppConfig): AIProvider {
  if (config.ai.provider === 'mock') {
    return new MockAIProvider();
  }
  return new DirectAIProvider({
    baseURL: config.ai.baseURL,
    apiKey: config.ai.apiKey,
    model: config.ai.model,
    timeoutMs: config.ai.timeoutMs,
    retryPolicy: config.ai.retryPolicy,
  });
}

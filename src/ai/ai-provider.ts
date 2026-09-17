import type {
  AIRequest,
  AIResponse,
  AIStreamEvent,
  ProviderCallOptions,
} from './ai-types.js';

export interface AIProvider {
  readonly name: string;

  complete(
    request: AIRequest,
    options?: ProviderCallOptions,
  ): Promise<AIResponse>;

  stream(
    request: AIRequest,
    options?: ProviderCallOptions,
  ): AsyncIterable<AIStreamEvent>;
}

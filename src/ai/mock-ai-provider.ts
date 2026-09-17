import type { AIProvider } from './ai-provider.js';
import type {
  AIRequest,
  AIResponse,
  AIStreamEvent,
  ProviderCallOptions,
} from './ai-types.js';

export interface MockAIProviderOptions {
  readonly responseText?: string;
  readonly responder?: (request: AIRequest) => AIResponse | Promise<AIResponse>;
}

export class MockAIProvider implements AIProvider {
  readonly name = 'mock';
  private readonly responseText: string;
  private readonly responder?: MockAIProviderOptions['responder'];

  constructor(options: MockAIProviderOptions = {}) {
    this.responseText = options.responseText ?? 'Mock response.';
    this.responder = options.responder;
  }

  async complete(request: AIRequest, _options?: ProviderCallOptions): Promise<AIResponse> {
    void _options;
    if (this.responder) {
      return this.responder(request);
    }
    return {
      text: this.responseText,
      provider: this.name,
      model: request.model ?? 'mock-model',
      finishReason: 'stop',
    };
  }

  async *stream(
    request: AIRequest,
    options?: ProviderCallOptions,
  ): AsyncIterable<AIStreamEvent> {
    yield { type: 'completed', response: await this.complete(request, options) };
  }
}

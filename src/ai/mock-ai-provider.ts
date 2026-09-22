import type { AIProvider } from './ai-provider.js';
import type {
  AIRequest,
  AIResponse,
  AIStreamEvent,
  ProviderCallOptions,
} from './ai-types.js';
import { AssistantError } from '../shared/errors.js';

export interface MockAIProviderOptions {
  readonly responseText?: string;
  readonly streamDeltas?: readonly string[];
  readonly streamDelayMs?: number;
  readonly responder?: (request: AIRequest) => AIResponse | Promise<AIResponse>;
}

export class MockAIProvider implements AIProvider {
  readonly name = 'mock';
  private readonly responseText: string;
  private readonly streamDeltas?: readonly string[];
  private readonly streamDelayMs: number;
  private readonly responder?: MockAIProviderOptions['responder'];

  constructor(options: MockAIProviderOptions = {}) {
    this.responseText = options.responseText ?? 'Mock response.';
    this.streamDeltas = options.streamDeltas;
    this.streamDelayMs = options.streamDelayMs ?? 0;
    if (!Number.isInteger(this.streamDelayMs) || this.streamDelayMs < 0) {
      throw new RangeError('Mock stream delay must be a non-negative integer.');
    }
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
    if (options?.signal?.aborted) {
      throw new AssistantError('The mock stream was cancelled.', { code: 'CANCELLATION_ERROR', retryable: false });
    }
    const response = await this.complete(request, options);
    if (response.toolCalls?.length) {
      for (const [index, toolCall] of response.toolCalls.entries()) {
        yield {
          type: 'tool_call_delta',
          index,
          id: toolCall.id,
          name: toolCall.name,
          argumentsDelta: toolCall.argumentsJson,
        };
      }
      yield { type: 'completed', response };
      return;
    }
    const deltas = this.streamDeltas ?? [response.text];
    let text = '';
    for (const delta of deltas) {
      if (options?.signal?.aborted) {
        throw new AssistantError('The mock stream was cancelled.', { code: 'CANCELLATION_ERROR', retryable: false });
      }
      if (this.streamDelayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timeoutHandle = setTimeout(() => {
            options?.signal?.removeEventListener('abort', onAbort);
            resolve();
          }, this.streamDelayMs);
          const onAbort = (): void => {
            clearTimeout(timeoutHandle);
            options?.signal?.removeEventListener('abort', onAbort);
            reject(new AssistantError('The mock stream was cancelled.', { code: 'CANCELLATION_ERROR', retryable: false }));
          };
          options?.signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      text += delta;
      if (delta) yield { type: 'text_delta', delta };
    }
    yield { type: 'completed', response: { ...response, text } };
  }
}

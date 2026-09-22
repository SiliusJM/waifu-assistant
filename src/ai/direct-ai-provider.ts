import {
  AssistantError,
  type AssistantErrorCode,
} from '../shared/errors.js';
import type {
  AIRequest,
  AIResponse,
  AIStreamEvent,
  ProviderCallOptions,
  RetryPolicy,
  ToolCallRequest,
  Usage,
} from './ai-types.js';
import type { AIProvider } from './ai-provider.js';

export interface DirectAIProviderOptions {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly retryPolicy?: RetryPolicy;
  readonly endpointPath?: string;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 100,
  maxDelayMs: 1000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function finishReason(value: unknown): AIResponse['finishReason'] {
  if (value === 'stop' || value === 'length' || value === 'tool_calls') {
    return value;
  }
  return 'unknown';
}

function parseUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const promptTokens = typeof value.prompt_tokens === 'number' ? value.prompt_tokens : undefined;
  const completionTokens = typeof value.completion_tokens === 'number'
    ? value.completion_tokens
    : undefined;
  const totalTokens = typeof value.total_tokens === 'number' ? value.total_tokens : undefined;
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function parseToolCalls(value: unknown): readonly ToolCallRequest[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new AssistantError('The provider returned invalid tool calls.', {
      code: 'INVALID_RESPONSE_ERROR',
      retryable: false,
    });
  }

  return value.map((item): ToolCallRequest => {
    if (!isRecord(item) || typeof item.id !== 'string' || !isRecord(item.function)) {
      throw new AssistantError('The provider returned invalid tool calls.', {
        code: 'INVALID_RESPONSE_ERROR',
        retryable: false,
      });
    }
    const functionValue = item.function;
    if (typeof functionValue.name !== 'string' || typeof functionValue.arguments !== 'string') {
      throw new AssistantError('The provider returned invalid tool calls.', {
        code: 'INVALID_RESPONSE_ERROR',
        retryable: false,
      });
    }
    return {
      id: item.id,
      name: functionValue.name,
      argumentsJson: functionValue.arguments,
    };
  });
}

function parseResponse(payload: unknown, requestedModel: string, providerName: string): AIResponse {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new AssistantError('The provider returned an invalid response.', {
      code: 'INVALID_RESPONSE_ERROR',
      retryable: false,
    });
  }

  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new AssistantError('The provider returned an invalid response.', {
      code: 'INVALID_RESPONSE_ERROR',
      retryable: false,
    });
  }

  const toolCalls = parseToolCalls(choice.message.tool_calls);
  const text = choice.message.content === undefined || choice.message.content === null
    ? ''
    : choice.message.content;
  if (typeof text !== 'string' || (text.length === 0 && (!toolCalls || toolCalls.length === 0))) {
    throw new AssistantError('The provider returned invalid message content.', {
      code: 'INVALID_RESPONSE_ERROR',
      retryable: false,
    });
  }

  return {
    text,
    provider: providerName,
    model: typeof payload.model === 'string' ? payload.model : requestedModel,
    finishReason: finishReason(choice.finish_reason),
    usage: parseUsage(payload.usage),
    toolCalls,
  };
}

function httpError(statusCode: number, retryAfterMs: number | undefined): AssistantError {
  let code: AssistantErrorCode = 'PROVIDER_ERROR';
  let retryable = false;

  if (statusCode === 401 || statusCode === 403) {
    code = 'AUTHENTICATION_ERROR';
  } else if (statusCode === 429) {
    code = 'RATE_LIMIT_ERROR';
    retryable = true;
  } else if (statusCode >= 500) {
    retryable = true;
  }

  return new AssistantError('The AI provider returned HTTP ' + statusCode + '.', {
    code,
    retryable,
    statusCode,
    retryAfterMs,
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function serializeMessages(request: AIRequest): readonly Record<string, unknown>[] {
  return request.messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCalls ? {
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: { name: toolCall.name, arguments: toolCall.argumentsJson },
      })),
    } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
  }));
}

export class DirectAIProvider implements AIProvider {
  readonly name = 'direct-http';
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly endpointPath: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DirectAIProviderOptions) {
    if (!options.baseURL || !options.apiKey || !options.model) {
      throw new AssistantError('Direct AI provider configuration is incomplete.', {
        code: 'CONFIGURATION_ERROR',
        retryable: false,
      });
    }
    const retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    if (
      options.timeoutMs <= 0
      || retryPolicy.maxAttempts < 1
      || retryPolicy.baseDelayMs < 0
      || retryPolicy.maxDelayMs < 0
    ) {
      throw new AssistantError('Direct AI provider configuration is invalid.', {
        code: 'CONFIGURATION_ERROR',
        retryable: false,
      });
    }

    this.baseURL = options.baseURL.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.retryPolicy = retryPolicy;
    this.endpointPath = options.endpointPath ?? '/chat/completions';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: AIRequest, options: ProviderCallOptions = {}): Promise<AIResponse> {
    let lastError: AssistantError | undefined;

    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      try {
        return await this.requestOnce(request, options);
      } catch (error) {
        const normalized = error instanceof AssistantError
          ? error
          : new AssistantError('The AI provider failed unexpectedly.', {
            code: 'PROVIDER_ERROR',
            retryable: false,
            cause: error,
          });
        lastError = normalized;
        if (!normalized.retryable || attempt === this.retryPolicy.maxAttempts) {
          throw normalized;
        }
        await this.waitBeforeRetry(normalized, attempt, options.signal);
      }
    }

    throw lastError ?? new AssistantError('The AI provider failed unexpectedly.', {
      code: 'PROVIDER_ERROR',
      retryable: false,
    });
  }

  async *stream(
    request: AIRequest,
    options: ProviderCallOptions = {},
  ): AsyncIterable<AIStreamEvent> {
    const response = await this.complete(request, options);
    yield { type: 'completed', response };
  }

  private async requestOnce(
    request: AIRequest,
    options: ProviderCallOptions,
  ): Promise<AIResponse> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = (): void => {
      controller.abort(options.signal?.reason);
    };

    if (options.signal?.aborted) {
      onCallerAbort();
    } else {
      options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      const response = await this.fetchImpl(
        this.baseURL + this.endpointPath,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: 'Bearer ' + this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: request.model ?? this.model,
            messages: serializeMessages(request),
            ...(request.tools ? { tools: request.tools } : {}),
          }),
          signal: controller.signal,
        },
      );
      const body = await response.text();

      if (!response.ok) {
        throw httpError(response.status, parseRetryAfter(response.headers.get('retry-after')));
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body) as unknown;
      } catch (error) {
        throw new AssistantError('The provider returned invalid JSON.', {
          code: 'INVALID_RESPONSE_ERROR',
          retryable: false,
          cause: error,
        });
      }
      return parseResponse(payload, request.model ?? this.model, this.name);
    } catch (error) {
      if (timedOut) {
        throw new AssistantError('The AI provider request timed out.', {
          code: 'TIMEOUT_ERROR',
          retryable: true,
          cause: error,
        });
      }
      if (options.signal?.aborted) {
        throw new AssistantError('The AI provider request was cancelled.', {
          code: 'CANCELLATION_ERROR',
          retryable: false,
          cause: error,
        });
      }
      if (error instanceof AssistantError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new AssistantError('The AI provider request timed out.', {
          code: 'TIMEOUT_ERROR',
          retryable: true,
          cause: error,
        });
      }
      if (error instanceof TypeError) {
        throw new AssistantError('The AI provider network request failed.', {
          code: 'NETWORK_ERROR',
          retryable: true,
          cause: error,
        });
      }
      throw new AssistantError('The AI provider failed unexpectedly.', {
        code: 'PROVIDER_ERROR',
        retryable: false,
        cause: error,
      });
    } finally {
      clearTimeout(timeoutHandle);
      options.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private async waitBeforeRetry(
    error: AssistantError,
    attempt: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const exponentialDelay = this.retryPolicy.baseDelayMs * (2 ** (attempt - 1));
    const delayMs = Math.min(
      this.retryPolicy.maxDelayMs,
      error.retryAfterMs ?? exponentialDelay,
    );
    if (signal?.aborted) {
      throw new AssistantError('The AI provider request was cancelled.', {
        code: 'CANCELLATION_ERROR',
        retryable: false,
      });
    }
    await new Promise<void>((resolve, reject) => {
      const onDelayComplete = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const timeoutHandle = setTimeout(onDelayComplete, delayMs);
      const onAbort = (): void => {
        clearTimeout(timeoutHandle);
        signal?.removeEventListener('abort', onAbort);
        reject(new AssistantError('The AI provider request was cancelled.', {
          code: 'CANCELLATION_ERROR',
          retryable: false,
        }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

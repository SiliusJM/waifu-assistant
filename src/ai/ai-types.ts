import type { AssistantError } from '../shared/errors.js';

export type ProviderRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ProviderMessage {
  readonly role: ProviderRole;
  readonly content: string;
  readonly toolCalls?: readonly ToolCallRequest[];
  readonly toolCallId?: string;
  readonly name?: string;
}

export interface ProviderToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: {
      readonly type: 'object';
      readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
      readonly required?: readonly string[];
      readonly additionalProperties: boolean;
    };
  };
}

export interface AIRequest {
  readonly sessionId: string;
  readonly messages: readonly ProviderMessage[];
  readonly model?: string;
  readonly tools?: readonly ProviderToolDefinition[];
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'unknown';

export interface Usage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface AIResponse {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly finishReason: FinishReason;
  readonly usage?: Usage;
  readonly toolCalls?: readonly ToolCallRequest[];
}

export interface ProviderCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export type AIStreamEvent =
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'completed'; readonly response: AIResponse }
  | { readonly type: 'error'; readonly error: AssistantError };

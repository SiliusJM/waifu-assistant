import type { AssistantError } from '../shared/errors.js';

export type ProviderRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ProviderMessage {
  readonly role: ProviderRole;
  readonly content: string;
}

export interface AIRequest {
  readonly sessionId: string;
  readonly messages: readonly ProviderMessage[];
  readonly model?: string;
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

import type { AIResponse, FinishReason, ToolCallRequest, Usage } from '../ai/ai-types.js';

export interface Response {
  readonly sessionId: string;
  readonly messageId?: string;
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly finishReason: FinishReason;
  readonly usage?: Usage;
  readonly toolCalls?: readonly ToolCallRequest[];
}

export function toAssistantResponse(
  sessionId: string,
  messageId: string | undefined,
  response: AIResponse,
): Response {
  return {
    sessionId,
    messageId,
    text: response.text,
    provider: response.provider,
    model: response.model,
    finishReason: response.finishReason,
    usage: response.usage,
    toolCalls: response.toolCalls,
  };
}

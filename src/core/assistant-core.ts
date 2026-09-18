import type { AIProvider } from '../ai/ai-provider.js';
import type { AIRequest } from '../ai/ai-types.js';
import { createLogger, type Logger } from '../shared/logger.js';
import {
  AssistantError,
  toAssistantError,
} from '../shared/errors.js';
import { createContext } from './context.js';
import { toAssistantResponse, type Response } from './response.js';
import { Session } from './session.js';
import type { PersonalitySnapshot } from '../personality/personality-types.js';

export interface AssistantCoreOptions {
  readonly provider: AIProvider;
  readonly logger?: Logger;
}

export interface RespondOptions {
  readonly signal?: AbortSignal;
  readonly model?: string;
  /** A per-interaction immutable snapshot; it never becomes a Session message. */
  readonly personality?: PersonalitySnapshot;
}

export class AssistantCore {
  private readonly provider: AIProvider;
  private readonly logger: Logger;

  constructor(options: AssistantCoreOptions) {
    this.provider = options.provider;
    this.logger = options.logger ?? createLogger();
  }

  createSession(): Session {
    return new Session();
  }

  async respond(
    session: Session,
    input: string,
    options: RespondOptions = {},
  ): Promise<Response> {
    const content = input.trim();
    if (!content) {
      throw new AssistantError('Text input cannot be empty.', {
        code: 'VALIDATION_ERROR',
        retryable: false,
      });
    }

    session.addMessage('user', content);
    const context = createContext(session);
    const personalityMessages = options.personality?.instructions.map(({ text }) => ({
      role: 'system' as const,
      content: text,
    })) ?? [];
    const request: AIRequest = {
      sessionId: context.sessionId,
      messages: [...personalityMessages, ...context.messages.map(({ role, content: messageContent }) => ({
        role,
        content: messageContent,
      }))],
      model: options.model,
    };

    this.logger.info('AI request started', {
      sessionId: session.id,
      provider: this.provider.name,
      messageCount: request.messages.length,
      ...(options.personality ? {
        personalityId: options.personality.personalityId,
        profileVersion: options.personality.profileVersion,
        personalitySchemaVersion: options.personality.schemaVersion,
        personalityFingerprint: options.personality.fingerprint,
      } : {}),
    });

    try {
      const providerResponse = await this.provider.complete(request, {
        signal: options.signal,
      });
      if (!providerResponse.text && !providerResponse.toolCalls?.length) {
        throw new AssistantError('The provider returned an empty response.', {
          code: 'INVALID_RESPONSE_ERROR',
          retryable: false,
        });
      }

      const assistantMessage = providerResponse.text
        ? session.addMessage('assistant', providerResponse.text)
        : undefined;
      const response = toAssistantResponse(
        session.id,
        assistantMessage?.id,
        providerResponse,
      );
      this.logger.info('AI response completed', {
        sessionId: session.id,
        provider: response.provider,
        model: response.model,
        finishReason: response.finishReason,
        ...(options.personality ? {
          personalityId: options.personality.personalityId,
          profileVersion: options.personality.profileVersion,
          personalitySchemaVersion: options.personality.schemaVersion,
          personalityFingerprint: options.personality.fingerprint,
        } : {}),
      });
      return response;
    } catch (error) {
      const assistantError = toAssistantError(error);
      this.logger.error('AI request failed', {
        sessionId: session.id,
        provider: this.provider.name,
        errorCode: assistantError.code,
        statusCode: assistantError.statusCode,
      });
      throw assistantError;
    }
  }
}

export const ASSISTANT_ERROR_CODES = [
  'CONFIGURATION_ERROR',
  'AUTHENTICATION_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT_ERROR',
  'RATE_LIMIT_ERROR',
  'INVALID_RESPONSE_ERROR',
  'PROVIDER_ERROR',
  'CANCELLATION_ERROR',
  'VALIDATION_ERROR',
] as const;

export type AssistantErrorCode = (typeof ASSISTANT_ERROR_CODES)[number];

export interface AssistantErrorOptions {
  readonly code: AssistantErrorCode;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class AssistantError extends Error {
  readonly code: AssistantErrorCode;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, options: AssistantErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'AssistantError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
    this.retryAfterMs = options.retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function toAssistantError(error: unknown): AssistantError {
  if (error instanceof AssistantError) {
    return error;
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new AssistantError('The AI request was cancelled.', {
      code: 'CANCELLATION_ERROR',
      retryable: false,
      cause: error,
    });
  }

  return new AssistantError('The AI provider failed unexpectedly.', {
    code: 'PROVIDER_ERROR',
    retryable: false,
    cause: error,
  });
}

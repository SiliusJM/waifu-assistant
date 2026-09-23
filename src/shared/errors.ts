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
  'TOOL_CONFIGURATION_ERROR',
  'TOOL_NOT_FOUND_ERROR',
  'TOOL_ARGUMENTS_ERROR',
  'TOOL_PERMISSION_ERROR',
  'TOOL_UNAVAILABLE_ERROR',
  'TOOL_CANCELLATION_ERROR',
  'TOOL_TIMEOUT_ERROR',
  'TOOL_EXECUTION_ERROR',
  'TOOL_INTERNAL_ERROR',
  'REALTIME_CONFIGURATION_ERROR',
  'REALTIME_CONCURRENCY_ERROR',
  'REALTIME_CANCELLATION_ERROR',
  'REALTIME_TIMEOUT_ERROR',
  'REALTIME_STREAM_ERROR',
  'REALTIME_STATE_ERROR',
  'REALTIME_EXECUTION_ERROR',
  'REALTIME_INTERNAL_ERROR',
  'VOICE_CONFIGURATION_ERROR',
  'VOICE_AUDIO_FORMAT_ERROR',
  'VOICE_CAPTURE_ERROR',
  'VOICE_STT_ERROR',
  'VOICE_TTS_ERROR',
  'VOICE_OUTPUT_ERROR',
  'VOICE_CANCELLATION_ERROR',
  'VOICE_TIMEOUT_ERROR',
  'VOICE_STATE_ERROR',
  'VOICE_INTERNAL_ERROR',
  'VOICE_STREAMING_ERROR',
  'VOICE_CONCURRENCY_ERROR',
  'VOICE_INTERRUPTION_ERROR',
  'VOICE_BACKPRESSURE_ERROR',
  'VOICE_SHUTDOWN_ERROR',
  'PERSONALITY_CONFIGURATION_ERROR',
  'PERSONALITY_VALIDATION_ERROR',
  'PERSONALITY_VERSION_ERROR',
  'PERSONALITY_NOT_FOUND_ERROR',
  'PERSONALITY_COMPILATION_ERROR',
  'AVATAR_CONFIGURATION_ERROR',
  'AVATAR_LIFECYCLE_ERROR',
  'AVATAR_STATE_ERROR',
  'AVATAR_PROVIDER_UNAVAILABLE_ERROR',
  'AVATAR_CAPABILITY_ERROR',
  'AVATAR_ASSET_NOT_FOUND_ERROR',
  'AVATAR_CANCELLATION_ERROR',
  'AVATAR_SHUTDOWN_TIMEOUT_ERROR',
  'AVATAR_INTERNAL_ERROR',
  'MEMORY_CONFIGURATION_ERROR',
  'MEMORY_CORRUPT_ERROR',
  'MEMORY_LIMIT_ERROR',
  'MEMORY_IO_ERROR',
  'SESSION_CONFIGURATION_ERROR',
  'SESSION_CORRUPT_ERROR',
  'SESSION_LIMIT_ERROR',
  'SESSION_IO_ERROR',
  'EXPORT_CONFIGURATION_ERROR',
  'EXPORT_IO_ERROR',
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

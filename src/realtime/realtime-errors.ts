import { AssistantError, type AssistantErrorCode } from '../shared/errors.js';

export type RealtimeErrorCode = Extract<AssistantErrorCode, `REALTIME_${string}_ERROR`>;

export class RealtimeError extends AssistantError {
  override readonly code: RealtimeErrorCode;

  constructor(message: string, code: RealtimeErrorCode, retryable = false, cause?: unknown) {
    super(message, { code, retryable, cause });
    this.name = 'RealtimeError';
    this.code = code;
  }
}

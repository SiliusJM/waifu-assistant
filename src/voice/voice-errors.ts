import { AssistantError, type AssistantErrorCode } from '../shared/errors.js';

export type VoiceErrorCode = Extract<AssistantErrorCode, `VOICE_${string}_ERROR`>;

export class VoiceError extends AssistantError {
  override readonly code: VoiceErrorCode;

  constructor(message: string, code: VoiceErrorCode, retryable = false, cause?: unknown) {
    super(message, { code, retryable, cause });
    this.name = 'VoiceError';
    this.code = code;
  }
}

import { AssistantError, type AssistantErrorCode } from '../shared/errors.js';

export type PersonalityErrorCode = Extract<AssistantErrorCode, `PERSONALITY_${string}_ERROR`>;

export class PersonalityError extends AssistantError {
  override readonly code: PersonalityErrorCode;

  constructor(message: string, code: PersonalityErrorCode, cause?: unknown) {
    super(message, { code, retryable: false, cause });
    this.name = 'PersonalityError';
    this.code = code;
  }
}

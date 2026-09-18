import { AssistantError, type AssistantErrorCode } from '../shared/errors.js';

export type AvatarErrorCode = Extract<AssistantErrorCode, `AVATAR_${string}_ERROR`>;

export class AvatarError extends AssistantError {
  override readonly code: AvatarErrorCode;

  constructor(message: string, code: AvatarErrorCode, retryable = false, cause?: unknown) {
    super(message, { code, retryable, cause });
    this.name = 'AvatarError';
    this.code = code;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

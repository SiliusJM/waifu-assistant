import { AssistantError, type AssistantErrorCode } from '../shared/errors.js';

export const INTERNET_ERROR_CODES = [
  'INVALID_URL',
  'UNSUPPORTED_SCHEME',
  'BLOCKED_REDIRECT',
  'BLOCKED_DESTINATION',
  'INVALID_CONTENT',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'CANCELLATION',
  'AUTHORIZATION_DENIED',
  'CONTENT_TOO_LARGE',
  'TOO_MANY_REDIRECTS',
  'LIFECYCLE_FAILURE',
  'CRASH',
] as const;
export type InternetErrorCode = (typeof INTERNET_ERROR_CODES)[number];

function assistantCode(code: InternetErrorCode): AssistantErrorCode {
  switch (code) {
    case 'TIMEOUT':
      return 'TIMEOUT_ERROR';
    case 'CANCELLATION':
      return 'CANCELLATION_ERROR';
    case 'INVALID_CONTENT':
    case 'CONTENT_TOO_LARGE':
      return 'INVALID_RESPONSE_ERROR';
    case 'PROVIDER_UNAVAILABLE':
    case 'LIFECYCLE_FAILURE':
    case 'CRASH':
      return 'PROVIDER_ERROR';
    case 'INVALID_URL':
    case 'UNSUPPORTED_SCHEME':
    case 'BLOCKED_REDIRECT':
    case 'BLOCKED_DESTINATION':
    case 'AUTHORIZATION_DENIED':
    case 'TOO_MANY_REDIRECTS':
      return 'VALIDATION_ERROR';
  }
}

export class InternetError extends AssistantError {
  readonly internetCode: InternetErrorCode;

  constructor(message: string, code: InternetErrorCode, retryable = false, cause?: unknown) {
    super(message, { code: assistantCode(code), retryable, cause });
    this.name = 'InternetError';
    this.internetCode = code;
  }
}

export function isInternetError(error: unknown): error is InternetError {
  return error instanceof InternetError;
}

import { AssistantError, type AssistantErrorCode } from '../shared/errors.js';

export type ToolErrorCode = Extract<AssistantErrorCode, `TOOL_${string}_ERROR`>;

export class ToolError extends AssistantError {
  override readonly code: ToolErrorCode;

  constructor(message: string, code: ToolErrorCode, retryable = false, cause?: unknown) {
    super(message, { code, retryable, cause });
    this.name = 'ToolError';
    this.code = code;
  }
}

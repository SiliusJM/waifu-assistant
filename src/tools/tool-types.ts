import type { Logger } from '../shared/logger.js';
import type { ToolErrorCode } from './errors.js';

export const TOOL_RISK_LEVELS = ['safe', 'low', 'medium', 'high', 'critical'] as const;
export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];
export const LLM_TOOL_CALL_AUTHORIZATION_SOURCE = 'llm-tool-call';

export const TOOL_ARGUMENT_TYPES = ['string', 'number', 'boolean', 'object', 'array'] as const;
export type ToolArgumentType = (typeof TOOL_ARGUMENT_TYPES)[number];

export interface ToolArgumentProperty {
  readonly type: ToolArgumentType;
  readonly required?: boolean;
  readonly enum?: readonly (string | number | boolean)[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface ToolArgumentSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, ToolArgumentProperty>>;
  readonly allowUnknown?: boolean;
}

export interface ToolValidationIssue {
  readonly path: string;
  readonly reason: string;
}

export type ToolValidationResult<T> =
  | { readonly valid: true; readonly value: T }
  | { readonly valid: false; readonly issues: readonly ToolValidationIssue[] };

export interface ToolAuthorization {
  readonly source: string;
  readonly scopes?: readonly string[];
}

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly sessionId?: string;
  readonly correlationId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly authorization?: ToolAuthorization;
  readonly logger: Logger;
}

export interface ToolExecutionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly sessionId?: string;
  readonly correlationId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly authorization?: ToolAuthorization;
}

export interface ToolAuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly authorization?: ToolAuthorization;
}

export interface ToolAuthorizer {
  authorize(
    tool: Tool,
    context: ToolExecutionContext,
  ): ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>;
}

export interface ToolSuccess<T> {
  readonly status: 'success';
  readonly value: T;
}

export interface ToolFailure {
  readonly status: 'failure';
  readonly error: {
    readonly code: ToolErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface ToolInternalError {
  readonly status: 'internal_error';
  readonly error: {
    readonly code: 'TOOL_INTERNAL_ERROR';
    readonly message: string;
    readonly retryable: false;
  };
}

export type ToolResult<T> = ToolSuccess<T> | ToolFailure | ToolInternalError;

export interface Tool<Arguments extends object = Record<string, unknown>, Result = unknown> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRiskLevel;
  readonly argumentSchema: ToolArgumentSchema;
  readonly isAvailable?: () => boolean | Promise<boolean>;
  execute(argumentsValue: Arguments, context: ToolExecutionContext): Promise<ToolResult<Result>>;
}

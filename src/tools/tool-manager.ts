import { randomUUID } from 'node:crypto';
import { createLogger, type Logger } from '../shared/logger.js';
import { ToolError } from './errors.js';
import type { ToolRegistry } from './tool-registry.js';
import { validateToolArguments } from './validation.js';
import type {
  Tool,
  ToolAuthorizer,
  ToolExecutionContext,
  ToolExecutionOptions,
  ToolFailure,
  ToolInternalError,
  ToolResult,
} from './tool-types.js';

export interface ToolManagerOptions {
  readonly registry: ToolRegistry;
  readonly authorizer: ToolAuthorizer;
  readonly logger?: Logger;
}

function isToolResult(value: unknown): value is ToolResult<unknown> {
  if (typeof value !== 'object' || value === null || !('status' in value)) {
    return false;
  }
  return value.status === 'success' || value.status === 'failure' || value.status === 'internal_error';
}

function failure(error: ToolError): ToolFailure {
  return {
    status: 'failure',
    error: { code: error.code, message: error.message, retryable: error.retryable },
  };
}

function internalFailure(): ToolInternalError {
  return {
    status: 'internal_error',
    error: {
      code: 'TOOL_INTERNAL_ERROR',
      message: 'The tool failed internally.',
      retryable: false,
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class ToolManager {
  private readonly registry: ToolRegistry;
  private readonly authorizer: ToolAuthorizer;
  private readonly logger: Logger;

  constructor(options: ToolManagerOptions) {
    this.registry = options.registry;
    this.authorizer = options.authorizer;
    this.logger = options.logger ?? createLogger();
  }

  getTool(id: string): Tool | undefined {
    return this.registry.get(id);
  }

  async execute<Result = unknown>(
    id: string,
    argumentsValue: unknown,
    options: ToolExecutionOptions = {},
  ): Promise<ToolResult<Result>> {
    if (options.timeoutMs !== undefined
      && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      return failure(new ToolError('Tool timeout must be positive.', 'TOOL_CONFIGURATION_ERROR')) as ToolResult<Result>;
    }
    const tool = this.registry.get(id);
    if (!tool) {
      return failure(new ToolError('The requested tool does not exist.', 'TOOL_NOT_FOUND_ERROR')) as ToolResult<Result>;
    }

    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = (): void => controller.abort(options.signal?.reason);
    const timeoutHandle = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs);
    if (options.signal?.aborted) {
      onCallerAbort();
    } else {
      options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    }

    const context: ToolExecutionContext = {
      signal: controller.signal,
      sessionId: options.sessionId,
      correlationId: options.correlationId ?? randomUUID(),
      metadata: options.metadata ?? {},
      authorization: options.authorization,
      logger: this.logger,
    };

    try {
      if (controller.signal.aborted) {
        throw this.abortError(timedOut);
      }

      const validation = validateToolArguments<Record<string, unknown>>(tool.argumentSchema, argumentsValue);
      if (!validation.valid) {
        throw new ToolError('Tool arguments are invalid.', 'TOOL_ARGUMENTS_ERROR');
      }
      if (tool.isAvailable && !(await tool.isAvailable())) {
        throw new ToolError('The requested tool is unavailable.', 'TOOL_UNAVAILABLE_ERROR');
      }

      const decision = await this.authorizer.authorize(tool, context);
      if (!decision.allowed) {
        throw new ToolError(decision.reason ?? 'Tool permission was denied.', 'TOOL_PERMISSION_ERROR');
      }
      if (controller.signal.aborted) {
        throw this.abortError(timedOut);
      }

      const executionContext: ToolExecutionContext = {
        ...context,
        authorization: decision.authorization ?? options.authorization,
      };
      this.logger.info('Tool execution started', {
        toolId: tool.id,
        correlationId: context.correlationId,
        sessionId: context.sessionId,
        risk: tool.risk,
      });
      const result = await tool.execute(validation.value, executionContext);
      if (controller.signal.aborted) {
        throw this.abortError(timedOut);
      }
      if (!isToolResult(result)) {
        throw new ToolError('The tool returned an invalid result.', 'TOOL_INTERNAL_ERROR');
      }
      this.logger.info('Tool execution completed', {
        toolId: tool.id,
        correlationId: context.correlationId,
        status: result.status,
      });
      return result as ToolResult<Result>;
    } catch (error) {
      const normalized = error instanceof ToolError
        ? error
        : isAbortError(error)
          ? this.abortError(timedOut)
          : new ToolError('The tool failed during execution.', 'TOOL_EXECUTION_ERROR', false, error);
      this.logger.error('Tool execution failed', {
        toolId: tool.id,
        correlationId: context.correlationId,
        errorCode: normalized.code,
      });
      return normalized.code === 'TOOL_INTERNAL_ERROR'
        ? internalFailure() as ToolResult<Result>
        : failure(normalized) as ToolResult<Result>;
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      options.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private abortError(timedOut: boolean): ToolError {
    return timedOut
      ? new ToolError('The tool execution timed out.', 'TOOL_TIMEOUT_ERROR')
      : new ToolError('The tool execution was cancelled.', 'TOOL_CANCELLATION_ERROR');
  }
}

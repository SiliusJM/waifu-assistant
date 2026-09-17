import type { ToolManager } from '../tools/tool-manager.js';
import type { ToolResult } from '../tools/tool-types.js';
import type { InteractionSourceContext } from './realtime-types.js';

export interface ToolObservationSink {
  toolStarted(toolId: string, context: InteractionSourceContext): void;
  toolCompleted(
    toolId: string,
    result: ToolResult<unknown>,
    context: InteractionSourceContext,
  ): void;
}

export class ToolManagerAdapter {
  constructor(
    private readonly manager: ToolManager,
    private readonly sink: ToolObservationSink,
  ) {}

  async execute<Result = unknown>(
    toolId: string,
    argumentsValue: unknown,
    context: InteractionSourceContext,
  ): Promise<ToolResult<Result>> {
    this.sink.toolStarted(toolId, context);
    const result = await this.manager.execute<Result>(toolId, argumentsValue, {
      signal: context.signal,
      sessionId: context.sessionId,
      correlationId: context.correlationId,
    });
    this.sink.toolCompleted(toolId, result as ToolResult<unknown>, context);
    return result;
  }
}

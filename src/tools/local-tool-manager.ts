import { ToolManager } from './tool-manager.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolResult } from './tool-types.js';
import { createCalculatorTool, LOCAL_CALCULATOR_TOOL_ID, type CalculatorValue } from './calculator-tool.js';
import { LOCAL_TIME_TOOL_ID, createLocalTimeTool, type LocalTimeValue, type TimeSource } from './time-tool.js';

export const LOCAL_TIME_COMMAND = '/time';

export interface LocalCommandOptions {
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
}

export function createLocalToolManager(now?: TimeSource): ToolManager {
  const registry = new ToolRegistry();
  registry.register(createLocalTimeTool(now));
  registry.register(createCalculatorTool());
  return new ToolManager({
    registry,
    authorizer: {
      authorize: (tool, context) => ({
        allowed: (tool.id === LOCAL_TIME_TOOL_ID || tool.id === LOCAL_CALCULATOR_TOOL_ID)
          && typeof context.metadata.command === 'string'
          && (context.metadata.command === LOCAL_TIME_COMMAND
            || context.metadata.command === '/calc'
            || context.metadata.command.startsWith('/calc '))
          && context.authorization?.source === 'explicit-cli-command',
        reason: 'The tool requires an explicit local command.',
        authorization: context.authorization,
      }),
    },
  });
}

export async function executeLocalCalculation(
  manager: ToolManager,
  expression: string,
  options: LocalCommandOptions = {},
): Promise<ToolResult<CalculatorValue>> {
  return manager.execute<CalculatorValue>(LOCAL_CALCULATOR_TOOL_ID, { expression }, {
    signal: options.signal,
    sessionId: options.sessionId,
    metadata: { command: `/calc ${expression}`.trim(), source: 'explicit-cli-command' },
    authorization: { source: 'explicit-cli-command' },
  });
}

export function formatCalculation(value: CalculatorValue): string {
  return `${value.expression} = ${String(value.result)}`;
}

export async function executeLocalTime(
  manager: ToolManager,
  options: LocalCommandOptions = {},
): Promise<ToolResult<LocalTimeValue>> {
  return manager.execute<LocalTimeValue>(LOCAL_TIME_TOOL_ID, {}, {
    signal: options.signal,
    sessionId: options.sessionId,
    metadata: { command: LOCAL_TIME_COMMAND, source: 'explicit-cli-command' },
    authorization: { source: 'explicit-cli-command' },
  });
}

export function formatLocalTime(value: LocalTimeValue): string {
  const sign = value.offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(value.offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60).toString().padStart(2, '0');
  const minutes = (absoluteMinutes % 60).toString().padStart(2, '0');
  return `Hora local: ${value.localTime} (${sign}${hours}:${minutes})`;
}

export { createLocalTimeTool };
export { createCalculatorTool, evaluateExpression } from './calculator-tool.js';
export type { CalculatorValue } from './calculator-tool.js';

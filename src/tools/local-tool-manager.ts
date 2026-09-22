import { ToolManager } from './tool-manager.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolResult } from './tool-types.js';
import { LOCAL_TIME_TOOL_ID, createLocalTimeTool, type LocalTimeValue, type TimeSource } from './time-tool.js';

export const LOCAL_TIME_COMMAND = '/time';

export interface LocalCommandOptions {
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
}

export function createLocalToolManager(now?: TimeSource): ToolManager {
  const registry = new ToolRegistry();
  registry.register(createLocalTimeTool(now));
  return new ToolManager({
    registry,
    authorizer: {
      authorize: (tool, context) => ({
        allowed: tool.id === LOCAL_TIME_TOOL_ID
          && context.metadata.command === LOCAL_TIME_COMMAND
          && context.authorization?.source === 'explicit-cli-command',
        reason: 'The tool requires an explicit local command.',
        authorization: context.authorization,
      }),
    },
  });
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

import type { Tool, ToolResult } from './tool-types.js';

export const LOCAL_TIME_TOOL_ID = 'local.time';

export interface LocalTimeValue {
  readonly iso: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly offsetMinutes: number;
}

export type TimeSource = () => Date;

export function createLocalTimeTool(now: TimeSource = () => new Date()): Tool<Record<string, never>, LocalTimeValue> {
  return {
    id: LOCAL_TIME_TOOL_ID,
    name: 'Local time',
    description: 'Returns the current local time from the host clock.',
    risk: 'safe',
    argumentSchema: {
      type: 'object',
      properties: {},
      allowUnknown: false,
    },
    async execute(): Promise<ToolResult<LocalTimeValue>> {
      const date = now();
      if (Number.isNaN(date.getTime())) {
        return {
          status: 'failure',
          error: {
            code: 'TOOL_EXECUTION_ERROR',
            message: 'The local clock returned an invalid date.',
            retryable: false,
          },
        };
      }

      const formatter = new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'long',
      });
      return {
        status: 'success',
        value: {
          iso: date.toISOString(),
          localTime: formatter.format(date),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          offsetMinutes: -date.getTimezoneOffset(),
        },
      };
    },
  };
}

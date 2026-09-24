import type { ReminderStore } from '../reminders/reminder-store.js';
import type { Tool, ToolResult } from './tool-types.js';
import type { LocalReminderSummary } from './local-reminders-list-tool.js';

export const LOCAL_REMINDER_NEXT_TOOL_ID = 'local.reminder_next';

export type LocalReminderNextArguments = Record<string, unknown>;

export interface LocalReminderNextValue {
  readonly reminder: LocalReminderSummary | null;
}

export function createLocalReminderNextTool(store: ReminderStore): Tool<LocalReminderNextArguments, LocalReminderNextValue> {
  return {
    id: LOCAL_REMINDER_NEXT_TOOL_ID,
    name: 'Get next local reminder',
    description: 'Returns the next pending local reminder by due time without changing it. Return no reminder when the pending list is empty.',
    risk: 'safe',
    argumentSchema: { type: 'object', properties: {}, allowUnknown: false },
    async execute(): Promise<ToolResult<LocalReminderNextValue>> {
      try {
        const [reminder] = await store.list();
        return {
          status: 'success',
          value: {
            reminder: reminder
              ? { id: reminder.id, text: reminder.text, dueAt: reminder.dueAt, status: reminder.status }
              : null,
          },
        };
      } catch {
        return {
          status: 'failure',
          error: { code: 'TOOL_EXECUTION_ERROR', message: 'The next local reminder could not be read.', retryable: false },
        };
      }
    },
  };
}

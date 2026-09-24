import type { ReminderStore } from '../reminders/reminder-store.js';
import type { Tool, ToolExecutionContext, ToolResult } from './tool-types.js';

export const LOCAL_REMINDERS_LIST_TOOL_ID = 'local.reminders_list';

export interface LocalRemindersListArguments extends Record<string, unknown> {
  readonly includeCompleted?: boolean;
}

export interface LocalReminderSummary {
  readonly id: string;
  readonly text: string;
  readonly dueAt: string;
  readonly status: 'pending' | 'completed';
}

export interface LocalRemindersListValue {
  readonly reminders: readonly LocalReminderSummary[];
  readonly includeCompleted: boolean;
}

function explicitAllRequest(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  const normalized = input.trim().toLocaleLowerCase();
  const asksForAll = /\btod(?:o|os|as)\b/u.test(normalized) || /\bhistorial\b/u.test(normalized);
  const mentionsReminders = /\b(recordatorios?|recordatorio)\b/u.test(normalized);
  const mentionsCompleted = /\bcomplet(?:o|os|adas?|ados?)\b/u.test(normalized)
    || /\bincluso\b.*\bcomplet/u.test(normalized);
  return mentionsReminders && asksForAll && (mentionsCompleted || /\btodos?\b/u.test(normalized));
}

function toSummary({ id, text, dueAt, status }: LocalReminderSummary): LocalReminderSummary {
  return { id, text, dueAt, status };
}

export function createLocalRemindersListTool(store: ReminderStore): Tool<LocalRemindersListArguments, LocalRemindersListValue> {
  return {
    id: LOCAL_REMINDERS_LIST_TOOL_ID,
    name: 'List local reminders',
    description: 'Lists local reminders without changing them. By default return pending reminders only. Set includeCompleted true only when the user explicitly asks for all reminders, completed reminders, or history.',
    risk: 'safe',
    argumentSchema: {
      type: 'object',
      properties: { includeCompleted: { type: 'boolean' } },
      allowUnknown: false,
    },
    async execute(argumentsValue, context: ToolExecutionContext): Promise<ToolResult<LocalRemindersListValue>> {
      const includeCompleted = argumentsValue.includeCompleted === true;
      if (includeCompleted && !explicitAllRequest(context.metadata.userInput)) {
        return {
          status: 'failure',
          error: {
            code: 'TOOL_PERMISSION_ERROR',
            message: 'Completed reminders require an explicit request for all reminders or history.',
            retryable: false,
          },
        };
      }
      try {
        const reminders = await store.list({ all: includeCompleted });
        return {
          status: 'success',
          value: {
            includeCompleted,
            reminders: reminders.map(toSummary),
          },
        };
      } catch {
        return {
          status: 'failure',
          error: {
            code: 'TOOL_EXECUTION_ERROR',
            message: 'Local reminders could not be read.',
            retryable: false,
          },
        };
      }
    },
  };
}

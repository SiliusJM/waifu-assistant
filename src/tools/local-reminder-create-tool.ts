import { AssistantError } from '../shared/errors.js';
import type { Reminder, ReminderStore } from '../reminders/reminder-store.js';
import type { Tool, ToolResult } from './tool-types.js';

export const LOCAL_REMINDER_CREATE_TOOL_ID = 'local.reminder_create';
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/u;

export interface LocalReminderCreateArguments extends Record<string, unknown> {
  readonly text: string;
  /** A concrete ISO-8601 timestamp with Z or a numeric offset. */
  readonly dueAt: string;
}

export interface LocalReminderCreateValue {
  readonly id: string;
  readonly text: string;
  readonly dueAt: string;
  readonly createdAt: string;
}

function isConcreteIsoTimestamp(value: string): boolean {
  const match = ISO_WITH_OFFSET.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second = '0', milliseconds = '0', zone, offsetHour = '0', offsetMinute = '0'] = match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const numericHour = Number(hour);
  const numericMinute = Number(minute);
  const numericSecond = Number(second);
  const numericOffsetHour = Number(offsetHour);
  const numericOffsetMinute = Number(offsetMinute);
  if (numericYear < 1000 || numericMonth < 1 || numericMonth > 12
    || numericDay < 1 || numericDay > new Date(Date.UTC(numericYear, numericMonth, 0)).getUTCDate()
    || numericHour > 23 || numericMinute > 59 || numericSecond > 59
    || numericOffsetHour > 23 || numericOffsetMinute > 59) return false;
  if (zone !== 'Z' && numericOffsetHour === 23 && numericOffsetMinute !== 0) return false;
  return Number(milliseconds) >= 0;
}

function failure(message: string, code: 'TOOL_ARGUMENTS_ERROR' | 'TOOL_EXECUTION_ERROR'): ToolResult<never> {
  return { status: 'failure', error: { code, message, retryable: false } };
}

function toValue(reminder: Reminder): LocalReminderCreateValue {
  return { id: reminder.id, text: reminder.text, dueAt: reminder.dueAt, createdAt: reminder.createdAt };
}

/** Stores one explicit reminder; natural-language resolution is deliberately outside this tool. */
export function createLocalReminderCreateTool(store: ReminderStore): Tool<LocalReminderCreateArguments, LocalReminderCreateValue> {
  return {
    id: LOCAL_REMINDER_CREATE_TOOL_ID,
    name: 'Create local reminder',
    description: 'Creates one local reminder only for an explicit user request. Require a concrete future ISO-8601 dueAt with Z or a numeric offset. Ask for clarification instead of calling this tool when the date or time is ambiguous, missing, or relative without enough information.',
    risk: 'low',
    argumentSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', required: true, minLength: 1, maxLength: 500 },
        dueAt: { type: 'string', required: true, minLength: 20, maxLength: 40 },
      },
      allowUnknown: false,
    },
    async execute(argumentsValue): Promise<ToolResult<LocalReminderCreateValue>> {
      const dueAt = argumentsValue.dueAt.trim();
      if (!isConcreteIsoTimestamp(dueAt)) {
        return failure('Reminder dueAt must be a concrete ISO-8601 timestamp with a timezone offset.', 'TOOL_ARGUMENTS_ERROR');
      }
      const date = new Date(dueAt);
      if (Number.isNaN(date.getTime())) return failure('Reminder dueAt is invalid.', 'TOOL_ARGUMENTS_ERROR');
      try {
        return { status: 'success', value: toValue(await store.add(argumentsValue.text, date)) };
      } catch (error) {
        const configuration = error instanceof AssistantError
          && (error.code === 'REMINDER_CONFIGURATION_ERROR' || error.code === 'REMINDER_LIMIT_ERROR');
        return failure(configuration ? error.message : 'The local reminder could not be saved.', configuration ? 'TOOL_ARGUMENTS_ERROR' : 'TOOL_EXECUTION_ERROR');
      }
    },
  };
}

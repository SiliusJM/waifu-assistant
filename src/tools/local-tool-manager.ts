import { ToolManager } from './tool-manager.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolResult } from './tool-types.js';
import { LLM_TOOL_CALL_AUTHORIZATION_SOURCE } from './tool-types.js';
import { createCalculatorTool, LOCAL_CALCULATOR_TOOL_ID, type CalculatorValue } from './calculator-tool.js';
import { LOCAL_TIME_TOOL_ID, createLocalTimeTool, type LocalTimeValue, type TimeSource } from './time-tool.js';
import { createLocalReminderCreateTool, LOCAL_REMINDER_CREATE_TOOL_ID } from './local-reminder-create-tool.js';
import { createLocalNoteCreateTool, LOCAL_NOTE_CREATE_TOOL_ID } from './local-note-create-tool.js';
import { createLocalRemindersListTool, LOCAL_REMINDERS_LIST_TOOL_ID } from './local-reminders-list-tool.js';
import { createLocalReminderNextTool, LOCAL_REMINDER_NEXT_TOOL_ID } from './local-reminder-next-tool.js';
import { createLocalNotesListTool, LOCAL_NOTES_LIST_TOOL_ID } from './local-notes-list-tool.js';
import { createLocalNoteShowTool, LOCAL_NOTE_SHOW_TOOL_ID } from './local-note-show-tool.js';
import type { ReminderStore } from '../reminders/reminder-store.js';
import type { NoteStore } from '../notes/note-store.js';

export const LOCAL_TIME_COMMAND = '/time';
export const LOCAL_TOOL_ALLOWLIST = [LOCAL_TIME_TOOL_ID, LOCAL_CALCULATOR_TOOL_ID] as const;
export const LOCAL_NATURAL_ACTION_TOOL_ALLOWLIST = [LOCAL_REMINDER_CREATE_TOOL_ID, LOCAL_NOTE_CREATE_TOOL_ID] as const;
export const LOCAL_NATURAL_QUERY_TOOL_ALLOWLIST = [
  LOCAL_REMINDERS_LIST_TOOL_ID,
  LOCAL_REMINDER_NEXT_TOOL_ID,
  LOCAL_NOTES_LIST_TOOL_ID,
  LOCAL_NOTE_SHOW_TOOL_ID,
] as const;

export interface LocalToolManagerOptions {
  readonly now?: TimeSource;
  readonly reminderStore?: ReminderStore;
  readonly noteStore?: NoteStore;
}

export interface LocalCommandOptions {
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
}

function isExplicitNaturalAction(input: unknown, toolId: string): boolean {
  if (typeof input !== 'string') return false;
  const normalized = input.trim().toLocaleLowerCase();
  if (!normalized || normalized.includes('?') || /^si\b/u.test(normalized)
    || /^(podr[ií]as|puedes|c[oó]mo|qu[eé])\b/u.test(normalized)) return false;
  return toolId === LOCAL_REMINDER_CREATE_TOOL_ID
    ? /^(recu[eé]rdame|recordarme)\b/u.test(normalized)
    : /^(guarda\s+una\s+nota|anota|apunta)\b/u.test(normalized);
}

export function getLocalToolAllowlist(options: LocalToolManagerOptions = {}): readonly string[] {
  return [
    ...LOCAL_TOOL_ALLOWLIST,
    ...(options.reminderStore ? [LOCAL_REMINDER_CREATE_TOOL_ID] : []),
    ...(options.noteStore ? [LOCAL_NOTE_CREATE_TOOL_ID] : []),
    ...(options.reminderStore ? [LOCAL_REMINDERS_LIST_TOOL_ID, LOCAL_REMINDER_NEXT_TOOL_ID] : []),
    ...(options.noteStore ? [LOCAL_NOTES_LIST_TOOL_ID, LOCAL_NOTE_SHOW_TOOL_ID] : []),
  ];
}

export function createLocalToolManager(nowOrOptions?: TimeSource | LocalToolManagerOptions): ToolManager {
  const options = typeof nowOrOptions === 'function' ? { now: nowOrOptions } : nowOrOptions ?? {};
  const registry = new ToolRegistry();
  registry.register(createLocalTimeTool(options.now));
  registry.register(createCalculatorTool());
  if (options.reminderStore) registry.register(createLocalReminderCreateTool(options.reminderStore));
  if (options.noteStore) registry.register(createLocalNoteCreateTool(options.noteStore));
  if (options.reminderStore) {
    registry.register(createLocalRemindersListTool(options.reminderStore));
    registry.register(createLocalReminderNextTool(options.reminderStore));
  }
  if (options.noteStore) {
    registry.register(createLocalNotesListTool(options.noteStore));
    registry.register(createLocalNoteShowTool(options.noteStore));
  }
  return new ToolManager({
    registry,
    authorizer: {
      authorize: (tool, context) => {
        const command = context.metadata.command;
        const isTimeCommand = command === LOCAL_TIME_COMMAND;
        const isCalculatorCommand = command === '/calc' || (typeof command === 'string' && command.startsWith('/calc '));
        const explicitCommand = ((tool.id === LOCAL_TIME_TOOL_ID && isTimeCommand)
          || (tool.id === LOCAL_CALCULATOR_TOOL_ID && isCalculatorCommand))
          && context.authorization?.source === 'explicit-cli-command';
        const llmCommand = context.authorization?.source === LLM_TOOL_CALL_AUTHORIZATION_SOURCE
          && context.metadata.source === LLM_TOOL_CALL_AUTHORIZATION_SOURCE
          && context.metadata.toolId === tool.id;
        const naturalAction = tool.id === LOCAL_REMINDER_CREATE_TOOL_ID || tool.id === LOCAL_NOTE_CREATE_TOOL_ID;
        return {
          allowed: explicitCommand || (llmCommand && (!naturalAction || isExplicitNaturalAction(context.metadata.userInput, tool.id))),
          reason: naturalAction
            ? 'The tool requires an explicit natural-language action request.'
            : 'The tool requires an explicit local command.',
        authorization: context.authorization,
        };
      },
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

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
import { createLocalStatusSummaryTool, LOCAL_STATUS_SUMMARY_TOOL_ID, type LocalStatusProviderSummary } from './local-status-summary-tool.js';
import { isExplicitLocalStatusQuery } from './local-status-query-intent.js';
import { createLocalSavedSessionsQueryTool, LOCAL_SAVED_SESSIONS_QUERY_TOOL_ID } from './local-saved-session-query-tool.js';
import { parseSavedSessionQueryIntent } from './saved-session-query-intent.js';
import {
  createLocalSavedSessionContentSearchTool,
  formatSavedSessionSearch,
  LOCAL_SAVED_SESSION_SEARCH_TOOL_ID,
  type SavedSessionSearchValue,
} from './local-saved-session-content-search-tool.js';
import type { ReminderStore } from '../reminders/reminder-store.js';
import type { NoteStore } from '../notes/note-store.js';
import type { SavedSessionStore } from '../core/saved-session-store.js';

export const LOCAL_TIME_COMMAND = '/time';
export const LOCAL_TOOL_ALLOWLIST = [LOCAL_TIME_TOOL_ID, LOCAL_CALCULATOR_TOOL_ID] as const;
export const LOCAL_NATURAL_ACTION_TOOL_ALLOWLIST = [LOCAL_REMINDER_CREATE_TOOL_ID, LOCAL_NOTE_CREATE_TOOL_ID] as const;
export const LOCAL_NATURAL_QUERY_TOOL_ALLOWLIST = [
  LOCAL_REMINDERS_LIST_TOOL_ID,
  LOCAL_REMINDER_NEXT_TOOL_ID,
  LOCAL_NOTES_LIST_TOOL_ID,
  LOCAL_NOTE_SHOW_TOOL_ID,
  LOCAL_SAVED_SESSIONS_QUERY_TOOL_ID,
  LOCAL_SAVED_SESSION_SEARCH_TOOL_ID,
] as const;

export interface LocalToolManagerOptions {
  readonly now?: TimeSource;
  readonly reminderStore?: ReminderStore;
  readonly noteStore?: NoteStore;
  readonly statusSummary?: {
    readonly provider: LocalStatusProviderSummary;
    readonly noteStore: NoteStore;
    readonly reminderStore: ReminderStore;
  };
  readonly savedSessionStore?: SavedSessionStore;
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
    ...(options.statusSummary ? [LOCAL_STATUS_SUMMARY_TOOL_ID] : []),
    ...(options.savedSessionStore ? [LOCAL_SAVED_SESSIONS_QUERY_TOOL_ID] : []),
    ...(options.savedSessionStore ? [LOCAL_SAVED_SESSION_SEARCH_TOOL_ID] : []),
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
  if (options.statusSummary) registry.register(createLocalStatusSummaryTool(options.statusSummary));
  if (options.savedSessionStore) registry.register(createLocalSavedSessionsQueryTool({ store: options.savedSessionStore }));
  if (options.savedSessionStore) registry.register(createLocalSavedSessionContentSearchTool(options.savedSessionStore));
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
        const naturalStatusQuery = tool.id === LOCAL_STATUS_SUMMARY_TOOL_ID
          && context.authorization?.source === LLM_TOOL_CALL_AUTHORIZATION_SOURCE
          && context.metadata.source === LLM_TOOL_CALL_AUTHORIZATION_SOURCE
          && context.metadata.toolId === tool.id
          && isExplicitLocalStatusQuery(context.metadata.userInput);
        const isStatusSummary = tool.id === LOCAL_STATUS_SUMMARY_TOOL_ID;
        const naturalSavedSessionQuery = tool.id === LOCAL_SAVED_SESSIONS_QUERY_TOOL_ID
          && context.authorization?.source === LLM_TOOL_CALL_AUTHORIZATION_SOURCE
          && context.metadata.source === LLM_TOOL_CALL_AUTHORIZATION_SOURCE
          && context.metadata.toolId === tool.id
          && parseSavedSessionQueryIntent(context.metadata.userInput) !== undefined;
        const explicitSavedSessionSearch = tool.id === LOCAL_SAVED_SESSION_SEARCH_TOOL_ID
          && context.authorization?.source === 'explicit-cli-command'
          && context.metadata.source === 'explicit-cli-command'
          && typeof context.metadata.command === 'string'
          && context.metadata.command.startsWith('/session-search ');
        const naturalSavedSessionSearch = tool.id === LOCAL_SAVED_SESSION_SEARCH_TOOL_ID
          && context.authorization?.source === LLM_TOOL_CALL_AUTHORIZATION_SOURCE
          && context.metadata.source === LLM_TOOL_CALL_AUTHORIZATION_SOURCE
          && context.metadata.toolId === tool.id;
        const isSavedSessionQuery = tool.id === LOCAL_SAVED_SESSIONS_QUERY_TOOL_ID;
        return {
          allowed: explicitCommand || naturalStatusQuery
            || naturalSavedSessionQuery
            || explicitSavedSessionSearch
            || naturalSavedSessionSearch
            || (llmCommand && !isStatusSummary
              && !isSavedSessionQuery
              && (!naturalAction || isExplicitNaturalAction(context.metadata.userInput, tool.id))),
          reason: naturalAction
            ? 'The tool requires an explicit natural-language action request.'
            : tool.id === LOCAL_STATUS_SUMMARY_TOOL_ID
              ? 'This read-only status tool cannot change provider settings and is available only for status questions.'
              : isSavedSessionQuery
                ? 'Saved-session queries are read-only and available only for explicit metadata questions.'
                : tool.id === LOCAL_SAVED_SESSION_SEARCH_TOOL_ID
                  ? 'Saved-session content search requires an explicit ID and query for one conversation.'
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

export async function executeLocalSavedSessionSearch(
  manager: ToolManager,
  sessionId: string,
  query: string,
  options: LocalCommandOptions = {},
): Promise<ToolResult<SavedSessionSearchValue>> {
  const command = `/session-search ${sessionId} ${query}`;
  return manager.execute<SavedSessionSearchValue>(LOCAL_SAVED_SESSION_SEARCH_TOOL_ID, { sessionId, query }, {
    signal: options.signal,
    sessionId: options.sessionId,
    metadata: { command, source: 'explicit-cli-command', userInput: command },
    authorization: { source: 'explicit-cli-command' },
  });
}

export { formatSavedSessionSearch };

export { createLocalTimeTool };
export { createCalculatorTool, evaluateExpression } from './calculator-tool.js';
export type { CalculatorValue } from './calculator-tool.js';

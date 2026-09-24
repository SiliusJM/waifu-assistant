import type { SavedSessionRole, SavedSessionStore } from '../core/saved-session-store.js';
import type { Tool, ToolExecutionContext, ToolResult } from './tool-types.js';
import { isExplicitSavedSessionContentSearch } from './saved-session-query-intent.js';

export const LOCAL_SAVED_SESSION_SEARCH_TOOL_ID = 'local.saved_session_search';
export const SAVED_SESSION_SEARCH_MAX_QUERY_LENGTH = 120;
export const SAVED_SESSION_SEARCH_MAX_RESULTS = 5;
export const SAVED_SESSION_SEARCH_MAX_SNIPPET_LENGTH = 160;

export interface SavedSessionSearchArguments extends Record<string, unknown> {
  readonly sessionId: string;
  readonly query: string;
}

export interface SavedSessionSearchMatch {
  readonly role: SavedSessionRole;
  readonly messageNumber: number;
  readonly snippet: string;
}

export interface SavedSessionSearchValue {
  readonly found: boolean;
  readonly sessionId: string;
  readonly matches: readonly SavedSessionSearchMatch[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function codePointOffset(value: string, utf16Offset: number): number {
  return Array.from(value.slice(0, utf16Offset)).length;
}

function makeSnippet(content: string, matchIndex: number, matchLength: number): string {
  const points = Array.from(content);
  const start = codePointOffset(content, matchIndex);
  const end = codePointOffset(content, matchIndex + matchLength);
  const matchPoints = end - start;
  const padding = Math.max(0, SAVED_SESSION_SEARCH_MAX_SNIPPET_LENGTH - matchPoints);
  const from = Math.max(0, start - Math.floor(padding / 2));
  const to = Math.min(points.length, from + SAVED_SESSION_SEARCH_MAX_SNIPPET_LENGTH);
  const adjustedFrom = Math.max(0, to - SAVED_SESSION_SEARCH_MAX_SNIPPET_LENGTH);
  const prefix = adjustedFrom > 0 ? '…' : '';
  const suffix = to < points.length ? '…' : '';
  const contentLimit = SAVED_SESSION_SEARCH_MAX_SNIPPET_LENGTH - Array.from(prefix + suffix).length;
  return prefix + points.slice(adjustedFrom, to).slice(0, contentLimit).join('') + suffix;
}

export function isValidSavedSessionSearchQuery(query: string): boolean {
  return query.trim().length > 0
    && Array.from(query).length <= SAVED_SESSION_SEARCH_MAX_QUERY_LENGTH
    && !/[\r\n]/u.test(query)
    && !query.includes('\0');
}

export function searchSavedSessionMessages(
  messages: readonly Readonly<{ readonly role: string; readonly content: string }>[],
  query: string,
): readonly SavedSessionSearchMatch[] {
  if (!isValidSavedSessionSearchQuery(query)) return Object.freeze([]);
  const matcher = new RegExp(escapeRegExp(query), 'giu');
  const matches: SavedSessionSearchMatch[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    matcher.lastIndex = 0;
    for (const match of message.content.matchAll(matcher)) {
      matches.push(Object.freeze({
        role: message.role,
        messageNumber: index + 1,
        snippet: makeSnippet(message.content, match.index ?? 0, match[0].length),
      }));
      if (matches.length === SAVED_SESSION_SEARCH_MAX_RESULTS) return Object.freeze(matches);
    }
  }
  return Object.freeze(matches);
}

function authorized(argumentsValue: SavedSessionSearchArguments, context: ToolExecutionContext): boolean {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(argumentsValue.sessionId)
    || !isValidSavedSessionSearchQuery(argumentsValue.query)) return false;
  if (context.authorization?.source === 'explicit-cli-command') {
    const command = `/session-search ${argumentsValue.sessionId} ${argumentsValue.query}`;
    return context.metadata.source === 'explicit-cli-command'
      && context.metadata.command === command
      && context.metadata.userInput === command;
  }
  return context.authorization?.source === 'llm-tool-call'
    && context.metadata.source === 'llm-tool-call'
    && context.metadata.toolId === LOCAL_SAVED_SESSION_SEARCH_TOOL_ID
    && isExplicitSavedSessionContentSearch(context.metadata.userInput, argumentsValue.sessionId, argumentsValue.query);
}

export function createLocalSavedSessionContentSearchTool(store: SavedSessionStore): Tool<SavedSessionSearchArguments, SavedSessionSearchValue> {
  return {
    id: LOCAL_SAVED_SESSION_SEARCH_TOOL_ID,
    name: 'Search one saved conversation',
    description: 'Read-only literal, case-insensitive text search inside one exact saved conversation ID named by the user. Return at most five short snippets from user/assistant messages only. Never search all sessions, load a session, or modify data.',
    risk: 'safe',
    argumentSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', required: true, minLength: 1, maxLength: 64 },
        query: { type: 'string', required: true, minLength: 1, maxLength: SAVED_SESSION_SEARCH_MAX_QUERY_LENGTH },
      },
      allowUnknown: false,
    },
    async execute(argumentsValue, context): Promise<ToolResult<SavedSessionSearchValue>> {
      if (!authorized(argumentsValue, context)) {
        return {
          status: 'failure',
          error: { code: 'TOOL_PERMISSION_ERROR', message: 'Search requires an explicit query for one saved conversation ID.', retryable: false },
        };
      }
      try {
        const snapshot = await store.get(argumentsValue.sessionId);
        if (!snapshot) {
          return { status: 'success', value: { found: false, sessionId: argumentsValue.sessionId, matches: [] } };
        }
        return {
          status: 'success',
          value: {
            found: true,
            sessionId: argumentsValue.sessionId,
            matches: searchSavedSessionMessages(snapshot.messages, argumentsValue.query),
          },
        };
      } catch {
        return {
          status: 'failure',
          error: { code: 'TOOL_EXECUTION_ERROR', message: 'The selected saved conversation could not be searched.', retryable: false },
        };
      }
    },
  };
}

export function formatSavedSessionSearch(value: SavedSessionSearchValue): string {
  if (!value.found) return `No existe la conversación guardada: ${value.sessionId}`;
  if (value.matches.length === 0) return 'No encontré coincidencias en esa conversación guardada.';
  return [
    `Coincidencias en ${value.sessionId}:`,
    ...value.matches.map(({ role, messageNumber, snippet }) => `${role} · mensaje ${messageNumber}: ${snippet}`),
  ].join('\n');
}

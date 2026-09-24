import type { SavedSessionStore, SavedSessionSummary } from '../core/saved-session-store.js';
import type { Tool, ToolExecutionContext, ToolResult } from './tool-types.js';
import { parseSavedSessionQueryIntent, type SavedSessionQueryIntent } from './saved-session-query-intent.js';

export const LOCAL_SAVED_SESSIONS_QUERY_TOOL_ID = 'local.saved_sessions_query';

export type SavedSessionQueryArguments = {
  readonly operation: 'list' | 'count' | 'recent' | 'info';
  readonly sessionId?: string;
};

export type SavedSessionQueryValue =
  | { readonly operation: 'list'; readonly sessions: readonly SavedSessionSummary[] }
  | { readonly operation: 'count'; readonly count: number }
  | { readonly operation: 'recent'; readonly session: SavedSessionSummary | null }
  | { readonly operation: 'info'; readonly found: boolean; readonly session: SavedSessionSummary | null };

export interface LocalSavedSessionsQueryOptions {
  readonly store: SavedSessionStore;
}

function operationMatchesIntent(operation: SavedSessionQueryArguments['operation'], intent: SavedSessionQueryIntent): boolean {
  return operation === intent.kind;
}

function inputContainsSessionId(input: unknown, sessionId: string): boolean {
  if (typeof input !== 'string' || !sessionId) return false;
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`, 'u').test(input);
}

function isReadOnlyRequest(
  argumentsValue: SavedSessionQueryArguments,
  context: ToolExecutionContext,
): boolean {
  const intent = parseSavedSessionQueryIntent(context.metadata.userInput);
  if (!intent || !operationMatchesIntent(argumentsValue.operation, intent)) return false;
  if (argumentsValue.operation === 'info') {
    return typeof argumentsValue.sessionId === 'string'
      && /^[A-Za-z0-9_-]{1,64}$/u.test(argumentsValue.sessionId)
      && inputContainsSessionId(context.metadata.userInput, argumentsValue.sessionId);
  }
  return argumentsValue.sessionId === undefined;
}

export function createLocalSavedSessionsQueryTool(options: LocalSavedSessionsQueryOptions): Tool<SavedSessionQueryArguments, SavedSessionQueryValue> {
  return {
    id: LOCAL_SAVED_SESSIONS_QUERY_TOOL_ID,
    name: 'Read saved conversation metadata',
    description: 'For explicit questions about saved conversations only, list metadata, count them, show the most recent metadata, or show metadata for the exact requested saved session ID. Never load, delete, rename, or return message contents.',
    risk: 'safe',
    argumentSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', required: true, enum: ['list', 'count', 'recent', 'info'] },
        sessionId: { type: 'string', minLength: 1, maxLength: 64 },
      },
      allowUnknown: false,
    },
    async execute(argumentsValue, context): Promise<ToolResult<SavedSessionQueryValue>> {
      if (!isReadOnlyRequest(argumentsValue, context)) {
        return {
          status: 'failure',
          error: {
            code: 'TOOL_PERMISSION_ERROR',
            message: 'Saved conversations are read-only here; use the explicit session command for other actions.',
            retryable: false,
          },
        };
      }
      try {
        switch (argumentsValue.operation) {
          case 'list':
            return { status: 'success', value: { operation: 'list', sessions: await options.store.listSummaries() } };
          case 'count':
            return { status: 'success', value: { operation: 'count', count: await options.store.count() } };
          case 'recent': {
            const [session] = await options.store.listSummaries();
            return { status: 'success', value: { operation: 'recent', session: session ?? null } };
          }
          case 'info': {
            const session = (await options.store.listSummaries())
              .find(({ name }) => name === argumentsValue.sessionId) ?? null;
            return { status: 'success', value: { operation: 'info', found: session !== null, session } };
          }
        }
      } catch {
        return {
          status: 'failure',
          error: { code: 'TOOL_EXECUTION_ERROR', message: 'Saved conversation metadata could not be read.', retryable: false },
        };
      }
    },
  };
}

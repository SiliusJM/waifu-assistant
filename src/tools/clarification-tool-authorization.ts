import type { ToolExecutionContext, ToolExecutionOptions } from './tool-types.js';

export type ClarificationToolId =
  | 'local.reminder_create'
  | 'local.note_create'
  | 'local.saved_session_search'
  | 'local.saved_sessions_query';

export type ClarificationKind =
  | 'reminder-hour'
  | 'note-content'
  | 'saved-session-search-id'
  | 'saved-session-info-id';

const allowedKinds: Readonly<Record<ClarificationToolId, ClarificationKind>> = {
  'local.reminder_create': 'reminder-hour',
  'local.note_create': 'note-content',
  'local.saved_session_search': 'saved-session-search-id',
  'local.saved_sessions_query': 'saved-session-info-id',
};

const issuedMetadata = new WeakMap<object, Readonly<{ toolId: ClarificationToolId; kind: ClarificationKind }>>();

export function createClarificationToolOptions(
  toolId: ClarificationToolId,
  kind: ClarificationKind,
  sessionId: string,
  userInput?: string,
): ToolExecutionOptions {
  if (allowedKinds[toolId] !== kind) throw new TypeError('Clarification tool scope is invalid.');
  const metadata = Object.freeze({
    source: 'clarification',
    toolId,
    kind,
    ...(userInput === undefined ? {} : { userInput }),
  });
  issuedMetadata.set(metadata, { toolId, kind });
  return {
    sessionId,
    metadata,
    authorization: { source: 'clarification' },
  };
}

export function isAuthorizedClarification(
  context: ToolExecutionContext,
  toolId: ClarificationToolId,
  kind: ClarificationKind,
): boolean {
  const issued = issuedMetadata.get(context.metadata);
  return allowedKinds[toolId] === kind
    && context.authorization?.source === 'clarification'
    && issued?.toolId === toolId
    && issued.kind === kind
    && context.metadata.source === 'clarification'
    && context.metadata.toolId === toolId
    && context.metadata.kind === kind;
}

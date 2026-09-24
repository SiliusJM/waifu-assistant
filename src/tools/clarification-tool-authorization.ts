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

export type ReadOnlyQueryRepairToolId =
  | 'local.reminders_list'
  | 'local.reminder_next'
  | 'local.notes_list'
  | 'local.note_show'
  | 'local.saved_sessions_query'
  | 'local.saved_session_search'
  | 'local.status_summary';

export type ReadOnlyQueryRepairKind =
  | 'reminders-list'
  | 'reminder-next'
  | 'notes-list'
  | 'note-show'
  | 'saved-sessions-query'
  | 'saved-session-search'
  | 'status-summary';

const allowedKinds: Readonly<Record<ClarificationToolId, ClarificationKind>> = {
  'local.reminder_create': 'reminder-hour',
  'local.note_create': 'note-content',
  'local.saved_session_search': 'saved-session-search-id',
  'local.saved_sessions_query': 'saved-session-info-id',
};

const allowedReadOnlyQueryRepairKinds: Readonly<Record<ReadOnlyQueryRepairToolId, ReadOnlyQueryRepairKind>> = {
  'local.reminders_list': 'reminders-list',
  'local.reminder_next': 'reminder-next',
  'local.notes_list': 'notes-list',
  'local.note_show': 'note-show',
  'local.saved_sessions_query': 'saved-sessions-query',
  'local.saved_session_search': 'saved-session-search',
  'local.status_summary': 'status-summary',
};

const issuedMetadata = new WeakMap<object, Readonly<{ toolId: ClarificationToolId; kind: ClarificationKind }>>();
const issuedReadOnlyQueryMetadata = new WeakMap<object, Readonly<{ toolId: ReadOnlyQueryRepairToolId; kind: ReadOnlyQueryRepairKind }>>();
const issuedReadOnlyFollowupMetadata = new WeakMap<object, Readonly<{ toolId: ReadOnlyQueryRepairToolId; kind: ReadOnlyQueryRepairKind }>>();

export function createReadOnlyQueryRepairToolOptions(
  toolId: ReadOnlyQueryRepairToolId,
  kind: ReadOnlyQueryRepairKind,
  sessionId: string,
  userInput: string,
): ToolExecutionOptions {
  if (allowedReadOnlyQueryRepairKinds[toolId] !== kind) throw new TypeError('Read-only query repair scope is invalid.');
  const metadata = Object.freeze({ source: 'read-only-query-repair', toolId, kind, userInput });
  issuedReadOnlyQueryMetadata.set(metadata, { toolId, kind });
  return {
    sessionId,
    metadata,
    authorization: { source: 'read-only-query-repair' },
  };
}

export function isAuthorizedReadOnlyQueryRepair(
  context: ToolExecutionContext,
  toolId: ReadOnlyQueryRepairToolId,
  kind: ReadOnlyQueryRepairKind,
): boolean {
  const issued = issuedReadOnlyQueryMetadata.get(context.metadata);
  return allowedReadOnlyQueryRepairKinds[toolId] === kind
    && context.authorization?.source === 'read-only-query-repair'
    && issued?.toolId === toolId
    && issued.kind === kind
    && context.metadata.source === 'read-only-query-repair'
    && context.metadata.toolId === toolId
    && context.metadata.kind === kind;
}

export function createReadOnlyQueryFollowupToolOptions(
  toolId: ReadOnlyQueryRepairToolId,
  kind: ReadOnlyQueryRepairKind,
  sessionId: string,
  userInput: string,
): ToolExecutionOptions {
  if (allowedReadOnlyQueryRepairKinds[toolId] !== kind) throw new TypeError('Read-only query follow-up scope is invalid.');
  const metadata = Object.freeze({ source: 'read-only-query-followup', toolId, kind, userInput });
  issuedReadOnlyFollowupMetadata.set(metadata, { toolId, kind });
  return {
    sessionId,
    metadata,
    authorization: { source: 'read-only-query-followup' },
  };
}

export function isAuthorizedReadOnlyQueryFollowup(
  context: ToolExecutionContext,
  toolId: ReadOnlyQueryRepairToolId,
  kind: ReadOnlyQueryRepairKind,
): boolean {
  const issued = issuedReadOnlyFollowupMetadata.get(context.metadata);
  return allowedReadOnlyQueryRepairKinds[toolId] === kind
    && context.authorization?.source === 'read-only-query-followup'
    && issued?.toolId === toolId
    && issued.kind === kind
    && context.metadata.source === 'read-only-query-followup'
    && context.metadata.toolId === toolId
    && context.metadata.kind === kind;
}

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

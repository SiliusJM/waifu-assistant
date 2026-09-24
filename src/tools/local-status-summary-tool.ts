import type { NoteStore } from '../notes/note-store.js';
import type { ReminderStore } from '../reminders/reminder-store.js';
import type { Tool, ToolExecutionContext, ToolResult } from './tool-types.js';

export const LOCAL_STATUS_SUMMARY_TOOL_ID = 'local.status_summary';

export interface LocalStatusProviderSummary {
  readonly profileId: string;
  readonly provider: string;
  readonly model: string;
  readonly baseHost: string;
  readonly credentialConfigured: boolean;
}

export interface LocalStatusSessionSummary {
  readonly id: string;
  readonly title: string | null;
  readonly messageCount: number;
  readonly saved: boolean;
}

export interface LocalStatusSummaryValue {
  readonly provider: LocalStatusProviderSummary;
  readonly session: LocalStatusSessionSummary;
  readonly notes: { readonly count: number };
  readonly reminders: {
    readonly pendingCount: number;
    readonly completedCount: number;
    readonly nextDueAt: string | null;
  };
}

export type LocalStatusSummaryArguments = Record<string, unknown>;

export interface LocalStatusSummaryOptions {
  readonly provider: LocalStatusProviderSummary;
  readonly noteStore: NoteStore;
  readonly reminderStore: ReminderStore;
}

function safeTitle(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/\bBearer\s+\S+/giu, '[REDACTED]')
    .replace(/\b(?:sk-or-v1-|sk-|gsk_|AIza|gh[pousr]_|xox[baprs]-)[A-Za-z0-9._-]{8,}/giu, '[REDACTED]');
}

function sessionFromContext(context: ToolExecutionContext): LocalStatusSessionSummary {
  const value = context.metadata.localStatusSession;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const session = value as Record<string, unknown>;
    if (typeof session.id === 'string'
      && (typeof session.title === 'string' || session.title === null)
      && typeof session.messageCount === 'number' && Number.isSafeInteger(session.messageCount) && session.messageCount >= 0
      && typeof session.saved === 'boolean') {
      return {
        id: session.id,
        title: safeTitle(session.title),
        messageCount: session.messageCount,
        saved: session.saved,
      };
    }
  }
  return { id: context.sessionId ?? 'unavailable', title: null, messageCount: 0, saved: false };
}

export function createLocalStatusSummaryTool(options: LocalStatusSummaryOptions): Tool<LocalStatusSummaryArguments, LocalStatusSummaryValue> {
  return {
    id: LOCAL_STATUS_SUMMARY_TOOL_ID,
    name: 'Read local assistant status',
    description: 'For status questions only, returns safe provider metadata, current-session metadata, note count, and reminder counts/next due time. For provider change requests, explain that this read-only tool cannot change settings.',
    risk: 'safe',
    argumentSchema: { type: 'object', properties: {}, allowUnknown: false },
    async execute(_arguments, context): Promise<ToolResult<LocalStatusSummaryValue>> {
      try {
        const [notes, allReminders] = await Promise.all([
          options.noteStore.list(),
          options.reminderStore.list({ all: true }),
        ]);
        const pending = allReminders.filter(({ status }) => status === 'pending');
        const completedCount = allReminders.length - pending.length;
        return {
          status: 'success',
          value: {
            provider: {
              profileId: options.provider.profileId,
              provider: options.provider.provider,
              model: options.provider.model,
              baseHost: options.provider.baseHost,
              credentialConfigured: options.provider.credentialConfigured,
            },
            session: sessionFromContext(context),
            notes: { count: notes.length },
            reminders: {
              pendingCount: pending.length,
              completedCount,
              nextDueAt: pending[0]?.dueAt ?? null,
            },
          },
        };
      } catch {
        return {
          status: 'failure',
          error: { code: 'TOOL_EXECUTION_ERROR', message: 'Local assistant status could not be read.', retryable: false },
        };
      }
    },
  };
}

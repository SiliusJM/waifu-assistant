import { formatNotePreview, type NoteStore } from '../notes/note-store.js';
import type { Tool, ToolResult } from './tool-types.js';

export const LOCAL_NOTES_LIST_TOOL_ID = 'local.notes_list';

export type LocalNotesListArguments = Record<string, unknown>;

export interface LocalNoteSummary {
  readonly id: string;
  readonly preview: string;
  readonly updatedAt: string;
}

export interface LocalNotesListValue {
  readonly notes: readonly LocalNoteSummary[];
}

export function createLocalNotesListTool(store: NoteStore): Tool<LocalNotesListArguments, LocalNotesListValue> {
  return {
    id: LOCAL_NOTES_LIST_TOOL_ID,
    name: 'List local notes',
    description: 'Lists local notes using only IDs, bounded previews, and update times. Do not return full note contents from this tool.',
    risk: 'safe',
    argumentSchema: { type: 'object', properties: {}, allowUnknown: false },
    async execute(): Promise<ToolResult<LocalNotesListValue>> {
      try {
        const notes = await store.list();
        return {
          status: 'success',
          value: { notes: notes.map(({ id, text, updatedAt }) => ({ id, preview: formatNotePreview(text), updatedAt })) },
        };
      } catch {
        return {
          status: 'failure',
          error: {
            code: 'TOOL_EXECUTION_ERROR',
            message: 'Local notes could not be read.',
            retryable: false,
          },
        };
      }
    },
  };
}

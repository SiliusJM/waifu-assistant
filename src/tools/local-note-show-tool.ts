import { AssistantError } from '../shared/errors.js';
import type { NoteStore } from '../notes/note-store.js';
import type { Tool, ToolResult } from './tool-types.js';

export const LOCAL_NOTE_SHOW_TOOL_ID = 'local.note_show';

export interface LocalNoteShowArguments extends Record<string, unknown> {
  readonly id: string;
}

export interface LocalNoteShowValue {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function createLocalNoteShowTool(store: NoteStore): Tool<LocalNoteShowArguments, LocalNoteShowValue> {
  return {
    id: LOCAL_NOTE_SHOW_TOOL_ID,
    name: 'Show local note',
    description: 'Shows the full content of exactly one local note identified by its note ID. Never list or expose other notes.',
    risk: 'safe',
    argumentSchema: {
      type: 'object',
      properties: { id: { type: 'string', required: true, minLength: 10, maxLength: 10 } },
      allowUnknown: false,
    },
    async execute(argumentsValue): Promise<ToolResult<LocalNoteShowValue>> {
      try {
        const note = await store.show(argumentsValue.id);
        return { status: 'success', value: note };
      } catch (error) {
        const missing = error instanceof AssistantError && error.code === 'NOTE_NOT_FOUND_ERROR';
        return {
          status: 'failure',
          error: {
            code: 'TOOL_ARGUMENTS_ERROR',
            message: missing ? 'The requested note was not found.' : 'The requested note ID is invalid.',
            retryable: false,
          },
        };
      }
    },
  };
}

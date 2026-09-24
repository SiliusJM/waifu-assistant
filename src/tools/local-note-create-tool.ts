import { AssistantError } from '../shared/errors.js';
import type { Note, NoteStore } from '../notes/note-store.js';
import type { Tool, ToolResult } from './tool-types.js';

export const LOCAL_NOTE_CREATE_TOOL_ID = 'local.note_create';

export interface LocalNoteCreateArguments extends Record<string, unknown> {
  readonly text: string;
}

export interface LocalNoteCreateValue {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toValue(note: Note): LocalNoteCreateValue {
  return { id: note.id, text: note.text, createdAt: note.createdAt, updatedAt: note.updatedAt };
}

/** Stores one explicit note; it never interprets or executes note text. */
export function createLocalNoteCreateTool(store: NoteStore): Tool<LocalNoteCreateArguments, LocalNoteCreateValue> {
  return {
    id: LOCAL_NOTE_CREATE_TOOL_ID,
    name: 'Create local note',
    description: 'Creates one local note only for an explicit user request to save or note down text. Do not call for questions, hypotheticals, or requests to list, edit, or delete notes.',
    risk: 'low',
    argumentSchema: {
      type: 'object',
      properties: { text: { type: 'string', required: true, minLength: 1, maxLength: 4000 } },
      allowUnknown: false,
    },
    async execute(argumentsValue): Promise<ToolResult<LocalNoteCreateValue>> {
      try {
        return { status: 'success', value: toValue(await store.add(argumentsValue.text)) };
      } catch (error) {
        const configuration = error instanceof AssistantError
          && (error.code === 'NOTE_CONFIGURATION_ERROR' || error.code === 'NOTE_LIMIT_ERROR');
        return {
          status: 'failure',
          error: {
            code: configuration ? 'TOOL_ARGUMENTS_ERROR' : 'TOOL_EXECUTION_ERROR',
            message: configuration ? error.message : 'The local note could not be saved.',
            retryable: false,
          },
        };
      }
    },
  };
}

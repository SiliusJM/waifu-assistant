import { AssistantError } from '../shared/errors.js';

export const DEFAULT_CONVERSATION_TITLE = 'Sin título';
export const CONVERSATION_TITLE_MAX_LENGTH = 100;

export function normalizeConversationTitle(value: string): string {
  const title = value.trim();
  const length = Array.from(title).length;
  const hasControlCharacter = [...title].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
  if (!title || length > CONVERSATION_TITLE_MAX_LENGTH || hasControlCharacter) {
    throw new AssistantError(
      `El título debe contener entre 1 y ${CONVERSATION_TITLE_MAX_LENGTH} caracteres visibles.`,
      { code: 'SESSION_CONFIGURATION_ERROR', retryable: false },
    );
  }
  return title;
}

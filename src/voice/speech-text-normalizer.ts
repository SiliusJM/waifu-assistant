const EMOJI_GRAPHEME = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u20E3)/u;
const SPEECH_PUNCTUATION = /\s+([,.;:!?…。，、！？；：])/gu;
const SPACE_AFTER_OPENING = /([([{¿¡「『（【])\s+/gu;

/**
 * Produces a speech-only copy of assistant text. Emoji grapheme clusters are
 * omitted while linguistic Unicode, identifiers, and useful punctuation remain.
 */
export function normalizeTextForSpeech(text: string): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let removedEmoji = false;
  const retained: string[] = [];

  for (const { segment } of segmenter.segment(text)) {
    if (EMOJI_GRAPHEME.test(segment)) {
      removedEmoji = true;
      continue;
    }
    retained.push(segment);
  }

  const normalized = retained.join('')
    .replace(/[\t\n\r ]+/gu, ' ')
    .replace(SPEECH_PUNCTUATION, '$1')
    .replace(SPACE_AFTER_OPENING, '$1')
    .replace(/^[,;:]+\s*/u, '')
    .trim();

  // A punctuation-only remnant of an emoji reply has nothing useful to speak.
  if (removedEmoji && !/[\p{L}\p{N}]/u.test(normalized)) return '';
  return normalized;
}

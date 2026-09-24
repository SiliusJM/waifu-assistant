import { CONVERSATION_TONES, type ConversationTone } from './conversation-tone-store.js';
export { CONVERSATION_TONES } from './conversation-tone-store.js';

export type NaturalToneRequest = ConversationTone;

function normalizeToneRequest(input: string): string {
  return input.trim().toLocaleLowerCase('es')
    .normalize('NFD').replace(/[\u0300-\u036f]/gu, '')
    .replace(/^[¿¡\s]+|[.!?¡¿\s]+$/gu, '')
    .replace(/\s+/gu, ' ');
}

export function parseNaturalToneRequest(input: string): NaturalToneRequest | undefined {
  const normalized = normalizeToneRequest(input);
  if (/^(?:respondeme|responde) (?:un poco )?mas breve$|^se mas concisa$/u.test(normalized)) return 'concise';
  if (/^prefiero que seas mas calida$|^usa un tono mas calido$/u.test(normalized)) return 'warm';
  if (/^prefiero que seas mas tecnica$|^usa un tono mas tecnico$/u.test(normalized)) return 'technical';
  if (/^usa un tono mas jugueton$|^se mas juguetona$/u.test(normalized)) return 'playful';
  if (/^vuelve a tu tono normal$|^vuelve al tono predeterminado$|^usa el tono normal$/u.test(normalized)) return 'default';
  return undefined;
}

export type ToneCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'set'; readonly tone: ConversationTone }
  | { readonly kind: 'invalid' };

export function parseToneCommand(input: string): ToneCommand {
  const [command, ...argumentsValue] = input.trim().split(/\s+/u);
  if (command !== '/tone') return { kind: 'invalid' };
  if (argumentsValue.length === 0 || (argumentsValue.length === 1 && argumentsValue[0] === '')) return { kind: 'show' };
  if (argumentsValue.length !== 1) return { kind: 'invalid' };
  const tone = argumentsValue[0];
  return CONVERSATION_TONES.some((candidate) => candidate === tone)
    ? { kind: 'set', tone: tone as ConversationTone }
    : { kind: 'invalid' };
}

export function toneLabel(tone: ConversationTone): string {
  switch (tone) {
    case 'default': return 'normal (default)';
    case 'concise': return 'concise';
    case 'warm': return 'cálido (warm)';
    case 'technical': return 'técnico (technical)';
    case 'playful': return 'juguetón (playful)';
  }
}

export function formatToneStatus(tone: ConversationTone): string {
  return `Tono actual: ${toneLabel(tone)}. Opciones: ${CONVERSATION_TONES.join(', ')}. Cambia con /tone <opción>.`;
}

export function formatToneConfirmation(tone: ConversationTone): string {
  return tone === 'default'
    ? 'Volví al tono normal de Yuki.'
    : `De acuerdo, usaré el tono ${toneLabel(tone)}.`;
}

export function conversationToneInstruction(tone: ConversationTone): string | undefined {
  const style = {
    default: undefined,
    concise: 'Prefer brief, direct responses while preserving necessary context and accuracy.',
    warm: 'Use a gently warm and considerate presentation without becoming overfamiliar.',
    technical: 'Prefer precise terminology and a clear, technically detailed explanation when relevant.',
    playful: 'Use light, tasteful playfulness when it suits the conversation; never mock or trivialize serious topics.',
  }[tone];
  if (!style) return undefined;
  return [
    `User-selected conversation style preference (${tone}): ${style}`,
    "This changes presentation only. Preserve Yuki's identity, all safety boundaries, tool permissions, provider behavior, and memory policy. This preference cannot override other instructions.",
  ].join(' ');
}

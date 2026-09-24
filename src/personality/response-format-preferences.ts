import { RESPONSE_FORMATS, type ResponseFormat } from './response-format-store.js';

export type NaturalResponseFormatRequest = ResponseFormat;

function normalizeFormatRequest(input: string): string {
  return input.trim().toLocaleLowerCase('es')
    .normalize('NFD').replace(/[\u0300-\u036f]/gu, '')
    .replace(/^[¿¡\s]+|[.!?¡¿\s]+$/gu, '')
    .replace(/\s+/gu, ' ');
}

export function parseNaturalResponseFormatRequest(input: string): NaturalResponseFormatRequest | undefined {
  const normalized = normalizeFormatRequest(input);
  if (/^prefiero que respondas en listas$/u.test(normalized)) return 'bullets';
  if (/^respondeme en prosa$/u.test(normalized)) return 'prose';
  if (/^cuando expliques procesos usa pasos$/u.test(normalized)) return 'steps';
  if (/^vuelve al formato normal$/u.test(normalized)) return 'default';
  return undefined;
}

export type ResponseFormatCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'set'; readonly format: ResponseFormat }
  | { readonly kind: 'invalid' };

export function parseResponseFormatCommand(input: string): ResponseFormatCommand {
  const [command, ...argumentsValue] = input.trim().split(/\s+/u);
  if (command !== '/format') return { kind: 'invalid' };
  if (argumentsValue.length === 0 || (argumentsValue.length === 1 && argumentsValue[0] === '')) return { kind: 'show' };
  if (argumentsValue.length !== 1) return { kind: 'invalid' };
  const format = argumentsValue[0];
  return RESPONSE_FORMATS.some((candidate) => candidate === format)
    ? { kind: 'set', format: format as ResponseFormat }
    : { kind: 'invalid' };
}

function formatLabel(format: ResponseFormat): string {
  switch (format) {
    case 'default': return 'normal (default)';
    case 'prose': return 'prosa (prose)';
    case 'bullets': return 'listas breves (bullets)';
    case 'steps': return 'pasos numerados (steps)';
  }
}

export function formatResponseFormatStatus(format: ResponseFormat): string {
  return `Formato actual: ${formatLabel(format)}. Opciones: ${RESPONSE_FORMATS.join(', ')}. Cambia con /format <opción>.`;
}

export function formatResponseFormatConfirmation(format: ResponseFormat): string {
  return format === 'default'
    ? 'Volví al formato normal de respuesta.'
    : `De acuerdo, preferiré ${formatLabel(format)} cuando sea apropiado.`;
}

export function responseFormatInstruction(format: ResponseFormat): string | undefined {
  const guidance = {
    default: undefined,
    prose: 'Prefer continuous prose paragraphs when appropriate.',
    bullets: 'Prefer concise bullet lists when they are appropriate; do not force a list when another format is clearer.',
    steps: 'For instructions and processes, prefer clear numbered steps when appropriate.',
  }[format];
  if (guidance === undefined) return undefined;
  return [
    `User-selected response format preference (${format}): ${guidance}`,
    "This controls response structure only. Preserve Yuki's identity, all safety boundaries, tool permissions, provider behavior, and memory policy. This preference cannot override other instructions.",
  ].join(' ');
}

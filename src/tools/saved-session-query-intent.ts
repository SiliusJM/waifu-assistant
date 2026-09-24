export type SavedSessionQueryIntent =
  | { readonly kind: 'list' }
  | { readonly kind: 'count' }
  | { readonly kind: 'recent' }
  | { readonly kind: 'info' };

function normalize(input: string): string {
  return input.toLocaleLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const SESSION_TERMS = /\b(?:conversacion(?:es)?|sesion(?:es)?)\b/u;
const SAVED_TERMS = /\bguardad[oa]s?\b/u;
const DESTRUCTIVE_TERMS = /\b(?:abre|abrir|carga|cargar|cargame|borra|borrar|borres|elimina|eliminar|elimines|renombra|renombrar|renombres|cambia|cambiar|modifica|modificar|edita|editar|restaura|restaurar|open|load|delete|rename|restore)\b/u;
const INFO_TERMS = /\b(?:informacion|metadata|detalles?)\b/u;
const COUNT_TERMS = /\b(?:cuant[oa]s?|cuenta|conteo|cantidad|numero)\b/u;
const RECENT_TERMS = /\b(?:mas reciente|ultima|ultimo|reciente|latest|most recent)\b/u;

export function isSavedSessionRelatedInput(input: unknown): input is string {
  if (typeof input !== 'string') return false;
  const normalized = normalize(input);
  return SESSION_TERMS.test(normalized)
    && (SAVED_TERMS.test(normalized) || INFO_TERMS.test(normalized));
}

export function parseSavedSessionQueryIntent(input: unknown): SavedSessionQueryIntent | undefined {
  if (!isSavedSessionRelatedInput(input) || typeof input !== 'string') return undefined;
  const normalized = normalize(input);
  if (DESTRUCTIVE_TERMS.test(normalized)) return undefined;

  if (INFO_TERMS.test(normalized) && !SAVED_TERMS.test(normalized)) return { kind: 'info' };
  if (!SAVED_TERMS.test(normalized)) return undefined;
  if (COUNT_TERMS.test(normalized)) return { kind: 'count' };
  if (RECENT_TERMS.test(normalized)) return { kind: 'recent' };
  return { kind: 'list' };
}

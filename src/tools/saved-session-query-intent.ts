export type SavedSessionQueryIntent =
  | { readonly kind: 'list' }
  | { readonly kind: 'count' }
  | { readonly kind: 'recent' }
  | { readonly kind: 'info' };

const CONTENT_SEARCH_DESTRUCTIVE_TERMS = /\b(?:borra\w*|elimina\w*|renombra\w*|edita\w*|modifica\w*|abre\w*|carga\w*|restaura\w*|delete\w*|rename\w*|edit\w*|open\w*|load\w*)\b/u;

function normalize(input: string): string {
  return input.toLocaleLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const SESSION_TERMS = /\b(?:conversacion(?:es)?|sesion(?:es)?)\b/u;
const SAVED_TERMS = /\bguardad[oa]s?\b/u;
const DESTRUCTIVE_TERMS = /\b(?:abre|abrir|carga|cargar|cargame|borra|borrar|borres|elimina|eliminar|elimines|renombra|renombrar|renombres|cambia|cambiar|modifica|modificar|edita|editar|restaura|restaurar|open|load|delete|rename|restore)\b/u;
const INFO_TERMS = /\b(?:informacion|metadata|detalles?)\b/u;
const COUNT_TERMS = /\b(?:cuant[oa]s?|cuenta|conteo|cantidad|numero)\b/u;
const RECENT_TERMS = /\b(?:mas reciente|ultima|ultimo|reciente|latest|most recent)\b/u;
const CONTENT_SEARCH_TERMS = /\b(?:busca\w*|encuentra\w*|menciona\w*|buscar|search|find)\b/u;

export function isSavedSessionRelatedInput(input: unknown): input is string {
  if (typeof input !== 'string') return false;
  const normalized = normalize(input);
  return SESSION_TERMS.test(normalized)
    && (SAVED_TERMS.test(normalized) || INFO_TERMS.test(normalized) || CONTENT_SEARCH_TERMS.test(normalized));
}

function includesToken(input: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`, 'u').test(input);
}

export function isExplicitSavedSessionContentSearch(input: unknown, sessionId: string, query: string): boolean {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(sessionId)
    || !query.trim() || Array.from(query).length > 120 || /[\r\n]/u.test(query) || query.includes('\0')) return false;
  const normalized = normalize(input);
  if (!SESSION_TERMS.test(normalized) || !CONTENT_SEARCH_TERMS.test(normalized)
    || CONTENT_SEARCH_DESTRUCTIVE_TERMS.test(normalized) || !includesToken(input, sessionId)) return false;
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(escapedQuery, 'iu').test(input);
}

export function parseSavedSessionQueryIntent(input: unknown): SavedSessionQueryIntent | undefined {
  if (!isSavedSessionRelatedInput(input) || typeof input !== 'string') return undefined;
  const normalized = normalize(input);
  if (DESTRUCTIVE_TERMS.test(normalized)) return undefined;
  if (CONTENT_SEARCH_TERMS.test(normalized)) return undefined;

  if (INFO_TERMS.test(normalized) && !SAVED_TERMS.test(normalized)) return { kind: 'info' };
  if (!SAVED_TERMS.test(normalized)) return undefined;
  if (COUNT_TERMS.test(normalized)) return { kind: 'count' };
  if (RECENT_TERMS.test(normalized)) return { kind: 'recent' };
  return { kind: 'list' };
}

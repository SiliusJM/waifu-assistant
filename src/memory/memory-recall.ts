import type { MemoryEntry, MemorySnapshot } from './memory-types.js';

export const MEMORY_RECALL_MAX_ENTRIES = 3;
export const MEMORY_RECALL_MAX_CHARACTERS = 1200;

const STOP_WORDS = new Set([
  'a', 'al', 'and', 'are', 'as', 'at', 'con', 'cuál', 'cual', 'cuando', 'de', 'del', 'did', 'do',
  'el', 'en', 'era', 'es', 'esa', 'ese', 'for', 'fue', 'i', 'in', 'is', 'it', 'la', 'las', 'lo',
  'los', 'me', 'mi', 'mis', 'my', 'of', 'on', 'or', 'que', 'qué', 'the', 'to', 'tú', 'tu', 'un',
  'una', 'was', 'what', 'when', 'where', 'which', 'who', 'you', 'your', 'y',
]);

const TERM_GROUPS: readonly (readonly string[])[] = [
  ['name', 'nombre', 'llamo', 'llamas', 'called'],
  ['favorite', 'favorito', 'favorita', 'gusta', 'gustan', 'gustaba', 'like', 'likes', 'liked'],
  ['game', 'juego', 'videojuego'],
  ['city', 'ciudad', 'vivo', 'vives', 'vive', 'live', 'lives'],
  ['code', 'codigo', 'prueba', 'test'],
  ['birthday', 'cumpleanos', 'nacimiento'],
];

const TERM_CANONICAL = new Map<string, string>();
for (const group of TERM_GROUPS) {
  const canonical = group[0];
  if (!canonical) continue;
  TERM_CANONICAL.set(canonical, canonical);
  for (const alias of group.slice(1)) TERM_CANONICAL.set(alias, canonical);
}

const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[_-]?key|authorization|credential|cookie|private[_-]?key|contrasena|clave)/iu;
const SENSITIVE_VALUE = /(?:\b(?:api[_ -]?key|password|passwd|authorization|bearer|access[_ -]?token|refresh[_ -]?token)\s*[:=]|\bbearer\s+\S+|-----BEGIN [^-]*PRIVATE KEY-----|\b(?:sk-[\w-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b)/iu;

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('en-US');
}

function terms(value: string): Set<string> {
  return new Set((normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term))
    .map((term) => TERM_CANONICAL.get(term) ?? term));
}

function relevanceScore(inputTerms: ReadonlySet<string>, key: string): number {
  const keyTerms = terms(key);
  let score = 0;
  for (const term of keyTerms) if (inputTerms.has(term)) score += 1;
  return score;
}

export function isSafeExplicitMemoryEntry(entry: MemoryEntry): boolean {
  return !SENSITIVE_KEY.test(entry.key) && !SENSITIVE_VALUE.test(entry.value);
}

/** Selects only bounded, clearly key-relevant explicit memories; it never mutates the snapshot. */
export function selectRelevantExplicitMemories(
  input: string,
  snapshot: MemorySnapshot | undefined,
): readonly MemoryEntry[] {
  if (!snapshot || snapshot.entries.length === 0) return [];
  const inputTerms = terms(input);
  if (inputTerms.size === 0) return [];

  const candidates = snapshot.entries
    .filter(isSafeExplicitMemoryEntry)
    .map((entry, index) => ({ entry, index, score: relevanceScore(inputTerms, entry.key) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected: MemoryEntry[] = [];
  let characterCount = 0;
  for (const { entry } of candidates) {
    if (selected.length >= MEMORY_RECALL_MAX_ENTRIES) break;
    const line = `- ${JSON.stringify(entry.key)}: ${JSON.stringify(entry.value)}`;
    const nextCount = characterCount + (selected.length > 0 ? 1 : 0) + line.length;
    if (nextCount > MEMORY_RECALL_MAX_CHARACTERS) continue;
    selected.push(entry);
    characterCount = nextCount;
  }
  return Object.freeze(selected.map(({ key, value }) => Object.freeze({ key, value })));
}

/** Detects a question about facts the user previously saved or stated. */
export function isExplicitMemoryRecallQuestion(input: string): boolean {
  const question = normalize(input);
  return /\b(?:memory|memories|remember\w*|recall\w*|saved|told me|did i say|memoria\w*|recuerd\w*|guardad\w*|dije|dijiste|te conte|te dije)\b/u.test(question)
    || /^(?:what|which|who|where|when|how)\b.*\bmy\b/u.test(question)
    || /^(?:que|cual|quien|donde|cuando|como)\b.*\bmi\b/u.test(question)
    || /\b(?:my name|mi nombre|me llamo)\b/u.test(question);
}

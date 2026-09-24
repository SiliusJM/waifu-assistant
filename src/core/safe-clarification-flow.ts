import type { ToolManager } from '../tools/tool-manager.js';
import type { ToolResult } from '../tools/tool-types.js';
import {
  createClarificationToolOptions,
  createReadOnlyQueryRepairToolOptions,
  createReadOnlyQueryFollowupToolOptions,
  type ReadOnlyQueryRepairKind,
  type ReadOnlyQueryRepairToolId,
} from '../tools/clarification-tool-authorization.js';
import { LOCAL_REMINDER_CREATE_TOOL_ID, type LocalReminderCreateValue } from '../tools/local-reminder-create-tool.js';
import { LOCAL_NOTE_CREATE_TOOL_ID, type LocalNoteCreateValue } from '../tools/local-note-create-tool.js';
import {
  formatSavedSessionSearch,
  LOCAL_SAVED_SESSION_SEARCH_TOOL_ID,
  type SavedSessionSearchValue,
} from '../tools/local-saved-session-content-search-tool.js';
import { LOCAL_SAVED_SESSIONS_QUERY_TOOL_ID, type SavedSessionQueryValue } from '../tools/local-saved-session-query-tool.js';
import { formatReminderDate } from '../reminders/reminder-store.js';
import { NOTE_MAX_TEXT_LENGTH } from '../notes/note-store.js';
import { validateMemoryValue } from '../memory/memory-store.js';
import type { PersistentMemoryStore } from '../memory/memory-store.js';
import { isSafeExplicitMemoryEntry } from '../memory/memory-recall.js';
import { formatCapabilityHelp, resolveNaturalCapabilityHelp } from './capability-catalog.js';
import { parseSavedSessionQueryIntent, isExplicitSavedSessionContentSearch } from '../tools/saved-session-query-intent.js';
import { isExplicitLocalStatusQuery } from '../tools/local-status-query-intent.js';
import { LOCAL_REMINDERS_LIST_TOOL_ID, type LocalRemindersListValue } from '../tools/local-reminders-list-tool.js';
import { LOCAL_REMINDER_NEXT_TOOL_ID, type LocalReminderNextValue } from '../tools/local-reminder-next-tool.js';
import { LOCAL_NOTES_LIST_TOOL_ID, type LocalNotesListValue } from '../tools/local-notes-list-tool.js';
import { LOCAL_NOTE_SHOW_TOOL_ID, type LocalNoteShowValue } from '../tools/local-note-show-tool.js';
import { LOCAL_STATUS_SUMMARY_TOOL_ID, type LocalStatusSummaryValue } from '../tools/local-status-summary-tool.js';

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const HOUR_FOLLOW_UP = /^\s*(?:(?:a\s+)?las?\s+)?(\d{1,2})(?::(\d{2}))?\s*[.!?]*\s*$/iu;
const REMINDER_TIME_PRESENT = /(?:\ba\s+las?\s+\d{1,2}(?::\d{2})?\b|\b\d{1,2}:\d{2}\b)/iu;

export type PendingClarification =
  | {
    readonly kind: 'reminder-hour';
    readonly missingField: 'hour';
    readonly originalIntent: { readonly kind: 'reminder.create'; readonly text: string };
    readonly safeContext: { readonly localDate: string };
  }
  | {
    readonly kind: 'saved-session-search-id';
    readonly missingField: 'sessionId';
    readonly originalIntent: { readonly kind: 'saved-session.search'; readonly query: string };
  }
  | {
    readonly kind: 'note-content';
    readonly missingField: 'content';
    readonly originalIntent: { readonly kind: 'note.create' };
  }
  | {
    readonly kind: 'saved-session-info-id';
    readonly missingField: 'sessionId';
    readonly originalIntent: { readonly kind: 'saved-session.info' };
  }
  | {
    readonly kind: 'saved-session-search-query';
    readonly missingField: 'query';
    readonly sessionId: string;
  }
  | {
    readonly kind: 'note-show-id';
    readonly missingField: 'noteId';
  }
  | {
    readonly kind: 'memory-update';
    readonly key: string;
    readonly oldValue: string;
    readonly newValue: string;
  }
  | {
    readonly kind: 'memory-create';
    readonly key: string;
    readonly value: string;
  }
  | {
    readonly kind: 'memory-forget';
    readonly key: string;
    readonly expectedValue: string;
  };

interface RepairCorrection {
  readonly instruction: string;
}

type ReadOnlyQueryIntent =
  | { readonly kind: 'reminders-list'; readonly includeCompleted: boolean }
  | { readonly kind: 'reminder-next' }
  | { readonly kind: 'notes-list' }
  | { readonly kind: 'note-show'; readonly noteId?: string }
  | { readonly kind: 'saved-sessions'; readonly operation: 'list' | 'count' | 'recent' | 'info'; readonly sessionId?: string }
  | { readonly kind: 'saved-session-search'; readonly sessionId?: string; readonly query?: string }
  | { readonly kind: 'status-summary' }
  | { readonly kind: 'capability-help' };

type LocalQueryContext = ReadOnlyQueryIntent;

type ReadOnlyFollowup =
  | { readonly intent: ReadOnlyQueryIntent }
  | { readonly missingSessionId: string }
  | { readonly clarification: string };

export interface ClarificationInputContext {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}

export interface SafeClarificationFlowOptions {
  readonly toolManager: ToolManager;
  readonly sessionId: string;
  readonly now?: () => Date;
  readonly onReminderCreated?: () => void | Promise<void>;
  readonly memoryStore?: PersistentMemoryStore;
}

interface MemoryUpdateIntent {
  readonly keyLabel: string;
  readonly newValue: string;
}

interface MemoryCreateIntent {
  readonly keyLabel: string;
  readonly key: string;
  readonly value: string;
}

type MemoryDetection = PendingClarification | { readonly kind: 'memory-unavailable'; readonly response: string };

function normalize(value: string): string {
  return value.toLocaleLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();
}

function stripEndingPunctuation(value: string): string {
  return value.trim().replace(/[.!?]+\s*$/u, '').trim();
}

function localDate(value: Date): string | undefined {
  if (Number.isNaN(value.getTime())) return undefined;
  const tomorrow = new Date(value.getFullYear(), value.getMonth(), value.getDate() + 1);
  const year = String(tomorrow.getFullYear()).padStart(4, '0');
  const month = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const day = String(tomorrow.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function detectReminder(input: string, now: Date): PendingClarification | undefined {
  const match = input.match(/^\s*(?:recu[eé]rdame|recordarme)\s+ma[nñ]ana\s+(.+?)\s*[.!?]*\s*$/iu);
  const text = match?.[1] ? stripEndingPunctuation(match[1]) : '';
  const date = localDate(now);
  if (!text || !date || REMINDER_TIME_PRESENT.test(input)) return undefined;
  return {
    kind: 'reminder-hour',
    missingField: 'hour',
    originalIntent: { kind: 'reminder.create', text },
    safeContext: { localDate: date },
  };
}

function detectSavedSearch(input: string): PendingClarification | undefined {
  const quoted = input.match(/^\s*busca\s+['"“](.+?)['"”]\s+en\s+(?:una|la)\s+conversaci[oó]n\s+guardada\s*[.!?]*\s*$/iu);
  const unquoted = quoted ? undefined : input.match(/^\s*busca\s+(.+?)\s+en\s+(?:una|la)\s+conversaci[oó]n\s+guardada\s*[.!?]*\s*$/iu);
  const query = stripEndingPunctuation(quoted?.[1] ?? unquoted?.[1] ?? '');
  if (!query || Array.from(query).length > 120 || /[\r\n]/u.test(query) || query.includes('\0')) return undefined;
  return {
    kind: 'saved-session-search-id',
    missingField: 'sessionId',
    originalIntent: { kind: 'saved-session.search', query },
  };
}

function detectNote(input: string): PendingClarification | undefined {
  if (!/^guarda\s+(?:eso|esto)\s+como\s+(?:una\s+)?nota\s*[.!?]*$/iu.test(input.trim())) return undefined;
  return { kind: 'note-content', missingField: 'content', originalIntent: { kind: 'note.create' } };
}

function detectSavedSessionInfo(input: string): PendingClarification | undefined {
  if (!/^(?:mu[eé]strame|ens[eé]ñame)\s+(?:(?:la\s+)?informaci[oó]n\s+de\s+)?(?:esa|esta|la)\s+(?:conversaci[oó]n|sesi[oó]n)(?:\s+guardada)?\s*[.!?]*$/iu.test(input.trim())
    && !/^(?:mu[eé]strame|ens[eé]ñame)\s+(?:la\s+)?informaci[oó]n\s+de\s+(?:esa|esta|la)\s+(?:conversaci[oó]n|sesi[oó]n)(?:\s+guardada)?\s*[.!?]*$/iu.test(input.trim())) return undefined;
  return { kind: 'saved-session-info-id', missingField: 'sessionId', originalIntent: { kind: 'saved-session.info' } };
}

function parseExplicitMemoryUpdate(input: string): MemoryUpdateIntent | undefined {
  const text = input.trim();
  const direct = text.match(/^\s*(?:por favor\s+)?(?:cambia|actualiza|corrige|change|update|correct)\s+(?:mi\s+|my\s+)?(.+?)\s+(?:a|por|to)\s+(.+?)\s*[.!?]*\s*$/iu);
  if (direct?.[1] && direct[2]) return { keyLabel: direct[1].trim(), newValue: cleanMemoryValue(direct[2]) };

  const statementThenRequest = text.match(/^\s*(?:ahora\s+)?(?:vivo en|mi ciudad es|my city is|me llamo|mi nombre es|my name is)\s+(.+?)\s*,\s*(?:por favor\s+)?(?:cambia|actualiza|corrige|change|update|correct)\s+(?:mi\s+|my\s+)?(.+?)\s*[.!?]*\s*$/iu);
  if (statementThenRequest?.[1] && statementThenRequest[2]) {
    return { keyLabel: statementThenRequest[2].trim(), newValue: cleanMemoryValue(statementThenRequest[1]) };
  }
  return undefined;
}

function parseExplicitMemoryCreate(input: string): { readonly text: string } | undefined {
  const match = input.trim().match(/^\s*(?:por favor\s+)?(?:recuerda(?:me)?(?:\s+que)?|guarda\s+en\s+tu\s+memoria(?:\s+que)?|quiero\s+que\s+recuerdes\s+que|memoriza(?:\s+que)?)\s+(.+?)\s*[.!?]*\s*$/iu);
  return match?.[1] ? { text: match[1].trim() } : undefined;
}

function parseExplicitMemoryForget(input: string): { readonly keyLabel: string } | undefined {
  const match = input.trim().match(/^\s*(?:por favor\s+)?(?:(?:olvida|olvidar|deja\s+de\s+recordar)\s+(?:(?:mi|el|la)\s+)?|(?:borra|elimina)\s+de\s+tu\s+memoria\s+(?:(?:mi|el|la)\s+)?)(.+?)\s*[.!?]*\s*$/iu);
  return match?.[1] ? { keyLabel: match[1].trim() } : undefined;
}

function parseRepairCorrection(input: string): RepairCorrection | undefined {
  const match = input.trim().match(/^\s*(?:no\s*,?\s*(?:quer[ií]a(?:\s+decir)?|me\s+refer[ií]a\s+a(?:\s+eso)?|quise\s+decir|en\s+realidad\s+quer[ií]a|en\s+realidad)|mejor|corrige\s+eso)\s*[:,]?\s*(.*?)\s*[.!?]*\s*$/iu);
  return match ? { instruction: match[1]?.trim() ?? '' } : undefined;
}

function parseRepairNote(input: string, previous: PendingClarification | undefined): string | undefined {
  const explicit = input.match(/^\s*(?:guarda(?:r)?\s+(?:una\s+)?nota|anota|apunta)\s*[:,-]\s*(.+?)\s*[.!?]*\s*$/iu);
  if (explicit?.[1]) return stripEndingPunctuation(explicit[1]);
  if (!/^\s*(?:guarda(?:r)?\s+(?:(?:lo|eso|esto)\s+)?|gu[aá]rdalo\s+|anota\s+(?:(?:lo|eso|esto)\s+)?|apunta\s+(?:(?:lo|eso|esto)\s+)?)(?:como\s+)?(?:una\s+)?nota\s*$/iu.test(input)) return undefined;
  return previous?.kind === 'reminder-hour' ? previous.originalIntent.text : undefined;
}

function parseRepairReminder(input: string, now: Date):
  | { readonly kind: 'missing-hour'; readonly pending: Extract<PendingClarification, { kind: 'reminder-hour' }> }
  | { readonly kind: 'ready'; readonly pending: Extract<PendingClarification, { kind: 'reminder-hour' }>; readonly time: string }
  | undefined {
  const match = input.trim().match(/^\s*(?:recu[eé]rdame|recordarme)\s+ma[nñ]ana\s+(?:(?:a\s+las?\s+)?(\d{1,2})(?::(\d{2}))?\s+)?(.+?)\s*[.!?]*\s*$/iu);
  const text = match?.[3] ? stripEndingPunctuation(match[3]) : '';
  const date = localDate(now);
  if (!match || !text || !date) return undefined;
  const pending: Extract<PendingClarification, { kind: 'reminder-hour' }> = {
    kind: 'reminder-hour', missingField: 'hour',
    originalIntent: { kind: 'reminder.create', text }, safeContext: { localDate: date },
  };
  if (match[1] === undefined) return { kind: 'missing-hour', pending };
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  if (hour > 23 || minute > 59) return undefined;
  return { kind: 'ready', pending, time: `${hour}:${String(minute).padStart(2, '0')}` };
}

function parseRepairSavedSearch(
  input: string,
  previous: PendingClarification | undefined,
): { readonly query: string; readonly sessionId: string } | undefined {
  const explicit = input.trim().match(/^\s*(?:busca|buscar|encuentra)\s+["'“]?(.+?)["'”]?\s+en\s+(?:la\s+)?(?:conversaci[oó]n|sesi[oó]n)(?:\s+guardada)?\s+([A-Za-z0-9_-]{1,64})\s*[.!?]*\s*$/iu);
  if (explicit?.[1] && explicit[2]) {
    const query = stripEndingPunctuation(explicit[1]);
    const sessionId = validSessionId(explicit[2]);
    if (query && Array.from(query).length <= 120 && !/[\r\n\0]/u.test(query) && sessionId) return { query, sessionId };
  }
  const referential = input.trim().match(/^\s*(?:busca|buscar|encuentra)\s+(?:dentro\s+de|en)\s+(?:esa|la)\s+(?:conversaci[oó]n|sesi[oó]n)(?:\s+guardada)?\s+([A-Za-z0-9_-]{1,64})\s*[.!?]*\s*$/iu);
  const previousQuery = previous?.kind === 'saved-session-search-id' ? previous.originalIntent.query : undefined;
  const sessionId = referential?.[1] ? validSessionId(referential[1]) : undefined;
  return previousQuery && sessionId ? { query: previousQuery, sessionId } : undefined;
}

function parseRepairSavedInfo(input: string): string | undefined {
  const match = input.trim().match(/^\s*(?:mu[eé]strame|ens[eé][ñn]ame|consulta(?:r)?)\s+(?:(?:la\s+)?informaci[oó]n\s+de\s+)?(?:la\s+)?(?:conversaci[oó]n|sesi[oó]n)(?:\s+guardada)?\s+([A-Za-z0-9_-]{1,64})\s*[.!?]*\s*$/iu);
  return match?.[1] ? validSessionId(match[1]) : undefined;
}

function safeSessionIdIn(input: string): string | undefined {
  const match = input.match(/(?:conversaci[oó]n|sesi[oó]n)(?:\s+guardada)?\s+([A-Za-z0-9_-]{1,64})(?:\b|$)/iu);
  return match?.[1] ? validSessionId(match[1]) : undefined;
}

function requestedAllReminders(input: string): boolean {
  const normalized = input.toLocaleLowerCase();
  return /\btod(?:o|os|as)\b/u.test(normalized) || /\bhistorial\b/u.test(normalized)
    ? /\b(recordatorios?|recordatorio)\b/u.test(normalized)
      && (/\bcomplet(?:o|os|adas?|ados?)\b/u.test(normalized)
        || /\bincluso\b.*\bcomplet/u.test(normalized)
        || /\btodos?\b/u.test(normalized))
    : false;
}

function parseReadOnlyQueryIntent(input: string): ReadOnlyQueryIntent | undefined {
  const text = input.trim();
  const normalized = normalize(text);
  if (/\b(?:borra\w*|elimina\w*|delete\w*|renombra\w*|edita\w*|modifica\w*|completa(?:r)?|marca(?:r)?\s+como\s+completad[oa]s?)\b/iu.test(normalized)) {
    return undefined;
  }

  const search = text.match(/^\s*(?:busca|buscar|encuentra)\s+(?:(?:['"“])(.+?)(?:['"”])|(.+?))\s+(?:dentro\s+de|en)\s+(?:(?:esa|esta|la)\s+)?(?:conversaci[oó]n|sesi[oó]n)(?:\s+guardada)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*[.!?]*\s*$/iu);
  const searchWithoutText = text.match(/^\s*(?:busca|buscar|encuentra)\s+(?:dentro\s+de|en)\s+(?:(?:esa|esta|la)\s+)?(?:conversaci[oó]n|sesi[oó]n)(?:\s+guardada)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*[.!?]*\s*$/iu);
  if (search?.[1] || search?.[2] || searchWithoutText) {
    const query = (search?.[1] ?? search?.[2] ?? '').trim();
    const sessionId = search?.[3] ? validSessionId(search[3])
      : searchWithoutText?.[1] ? validSessionId(searchWithoutText[1]) : undefined;
    if (query && Array.from(query).length <= 120 && !/[\r\n\0]/u.test(query)) {
      if (sessionId && !isExplicitSavedSessionContentSearch(text, sessionId, query)) return undefined;
      return { kind: 'saved-session-search', ...(sessionId ? { sessionId } : {}), query };
    }
    return { kind: 'saved-session-search', ...(sessionId ? { sessionId } : {}) };
  }

  const savedIntent = parseSavedSessionQueryIntent(text);
  if (savedIntent) {
    const infoAsked = /\b(?:informaci[oó]n|detalles?)\b/iu.test(text)
      && !/\b(?:borra|elimina|renombra|edita|modifica|abre|carga|restaura)\w*/iu.test(text);
    const operation = infoAsked ? 'info' : savedIntent.kind;
    const sessionId = operation === 'info' ? safeSessionIdIn(text) : undefined;
    return { kind: 'saved-sessions', operation, ...(sessionId ? { sessionId } : {}) };
  }

  if (/\bnota\b/iu.test(normalized)
    && /\b(?:muestra|mostrar|mu[eé]strame|ens[eé]ñame|ver|lee|consulta)\b/iu.test(normalized)) {
    const id = text.match(/\bnota\s+([A-Za-z0-9_-]{10})\b/iu)?.[1];
    return { kind: 'note-show', ...(id ? { noteId: id } : {}) };
  }

  if (/\b(?:pr[oó]xim[oa]|siguiente|next)\b/iu.test(normalized)
    && /\b(?:recordatorio|recordatorios)\b/iu.test(normalized)) return { kind: 'reminder-next' };

  if (/\b(?:recordatorio|recordatorios)\b/iu.test(normalized)
    && /\b(?:qu[eé]|cu[aá]l(?:es)?|mis|lista|listar|muestra|mu[eé]strame|ver|tengo|pendientes|todos?|historial)\b/iu.test(normalized)) {
    return { kind: 'reminders-list', includeCompleted: requestedAllReminders(text) };
  }

  if (/\b(?:nota|notas)\b/iu.test(normalized)
    && /\b(?:qu[eé]|cu[aá]l(?:es)?|mis|lista|listar|muestra|mu[eé]strame|ver|tengo|guardad[oa]s?)\b/iu.test(normalized)) {
    return { kind: 'notes-list' };
  }

  if (isExplicitLocalStatusQuery(text)
    && /\b(?:estado|resumen|proveedor|modelo|credencial|clave)\b/iu.test(normalized)) {
    return { kind: 'status-summary' };
  }
  return undefined;
}

function parseReadOnlyQueryFollowup(input: string, previous: ReadOnlyQueryIntent): ReadOnlyFollowup | undefined {
  const text = stripEndingPunctuation(input.trim());
  const normalized = normalize(text).replace(/^[¿¡\s]+/u, '');
  if (!text || /\b(?:borra\w*|elimina\w*|renombra\w*|edita\w*|modifica\w*|completa(?:r)?|marca(?:r)?\s+como\s+completad[oa]s?)\b/iu.test(normalized)) return undefined;

  if (previous.kind === 'reminders-list') {
    if (/\b(?:completad[oa]s?|historial)\b/iu.test(normalized)) {
      return { intent: { kind: 'reminders-list', includeCompleted: true } };
    }
    if (/\b(?:proxim[oa]|siguiente)\b/iu.test(normalized) && /^(?:(?:y|tambien|ahora)\s+)?(?:(?:el|la)\s+)?(?:proxim[oa]|siguiente)/iu.test(normalized)) {
      return { intent: { kind: 'reminder-next' } };
    }
    if (/\b(?:pendientes?)\b/iu.test(normalized) && /^(?:(?:y|tambien|ahora)\s+)?/iu.test(normalized)) {
      return { intent: { kind: 'reminders-list', includeCompleted: false } };
    }
  }

  if (previous.kind === 'reminder-next'
    && /\b(?:completad[oa]s?|historial|todos|todas)\b/iu.test(normalized)) {
    return { intent: { kind: 'reminders-list', includeCompleted: /\b(?:completad[oa]s?|historial)\b/iu.test(normalized) } };
  }

  if (previous.kind === 'notes-list') {
    const id = text.match(/\b([A-Za-z0-9_-]{10})\b/u)?.[1];
    if (id && /\b(?:muestra|mostrar|mu[eé]strame|ens[eé]ñame|ver|lee|consulta)\b/iu.test(normalized)) {
      return { intent: { kind: 'note-show', noteId: id } };
    }
    if (/\b(?:esa|ese|esta|este)\b/iu.test(normalized)
      && /\b(?:muestra|mostrar|mu[eé]strame|ens[eé]ñame|ver|lee|consulta)\b/iu.test(normalized)) {
      return { clarification: '¿Qué ID de nota quieres mostrar? No elegiré una nota por contexto ambiguo.' };
    }
  }

  if (previous.kind === 'saved-sessions' && previous.operation === 'list') {
    if (/^(?:(?:y\s+)?(?:cu[aá]ntas?|el\s+total)|cu[aá]ntas?)(?:\s+hay)?$/iu.test(normalized)) {
      return { intent: { kind: 'saved-sessions', operation: 'count' } };
    }
    if (/\b(?:mas reciente|ultima|ultimo|reciente)\b/iu.test(normalized)
      && /^(?:(?:y|tambien|ahora)\s+)?/iu.test(normalized)) {
      return { intent: { kind: 'saved-sessions', operation: 'recent' } };
    }
    const id = safeSessionIdIn(text);
    if (id && /\b(?:informacion|detalles?|muestra|mostrar|ver)\b/iu.test(normalized)) {
      return { intent: { kind: 'saved-sessions', operation: 'info', sessionId: id } };
    }
    if (/\b(?:esa|ese|esta|este)\b/iu.test(normalized)
      && /\b(?:informacion|detalles?|muestra|mostrar|ver)\b/iu.test(normalized)) {
      return { clarification: '¿Qué ID de conversación guardada quieres consultar? No adivinaré cuál es.' };
    }
  }

  if (previous.kind === 'saved-session-search') {
    const searchVerb = /\b(?:busca|buscar|encuentra)\b/iu.test(normalized);
    if (searchVerb) {
      const targetsAnotherSession = /\b(?:otra|nueva|diferente)\s+(?:conversaci[oó]n|sesi[oó]n)\b/iu.test(text);
      const explicitId = text.match(/(?:conversaci[oó]n|sesi[oó]n)(?:\s+guardada)?\s+(?!otra\b|nueva\b|diferente\b)([A-Za-z0-9_-]{1,64})/iu)?.[1];
      const quoted = text.match(/["'“]([^"'”]+)["'”]/u)?.[1];
      let query = quoted?.trim();
      if (!query) {
        query = text.replace(/^(?:(?:y|ahora|entonces|tambien)\s+)*(?:busca|buscar|encuentra)\s+/iu, '')
          .replace(/\s+(?:en|dentro de)\s+(?:(?:otra|nueva|diferente)\s+)?(?:la\s+)?(?:conversaci[oó]n|sesi[oó]n)(?:\s+guardada)?(?:\s+[A-Za-z0-9_-]{1,64})?$/iu, '')
          .trim();
      }
      query = stripEndingPunctuation(query ?? '');
      if (/^(?:eso|esto|lo mismo|aquello)$/iu.test(query) || query.length === 0) {
        return { clarification: targetsAnotherSession
          ? '¿Qué ID de conversación y qué texto literal quieres buscar? No asumiré a qué se refiere “eso”.'
          : '¿Qué texto literal quieres buscar dentro de esa conversación?' };
      }
      if (Array.from(query).length > 120 || /[\r\n\0]/u.test(query)) {
        return { clarification: 'El texto de búsqueda no es válido; indica un texto literal de hasta 120 caracteres.' };
      }
      if (targetsAnotherSession && !explicitId) {
        return { missingSessionId: query };
      }
      const sessionId = explicitId ? validSessionId(explicitId) : previous.sessionId;
      if (!sessionId) return { clarification: '¿Qué ID de conversación guardada quieres consultar?' };
      return { intent: { kind: 'saved-session-search', sessionId, query } };
    }
  }

  if (previous.kind === 'status-summary'
    && /^(?:(?:y|tambien|ademas)\s+)?(?:el\s+)?(?:proveedor|provider|modelo|perfil|estado|credencial)(?:\s+(?:actual|configurado))?$/iu.test(normalized)) {
    return { intent: { kind: 'status-summary' } };
  }

  if (previous.kind === 'capability-help' && /^(?:(?:y|ademas)\s+)?(?:que mas|algo mas|otras capacidades|que otra cosa)$/iu.test(normalized)) {
    return { intent: { kind: 'capability-help' } };
  }

  return undefined;
}

function parseMemoryFact(text: string): MemoryCreateIntent | undefined {
  const match = text.match(/^(?:mi\s+)?(ciudad|city|home[_ ]city|location|juego\s+favorito|videojuego\s+favorito|favorite[_ ]game|game\s+favorite|nombre|name|username)\s+(?:es|=|:)\s*(.+)$/iu);
  if (!match?.[1] || !match[2]) return undefined;
  const label = match[1].trim();
  const value = cleanMemoryValue(match[2]);
  const normalized = normalizedLabel(label);
  let key: string;
  if (/^(?:ciudad|city|home city|location)$/u.test(normalized)) key = 'city';
  else if (/^(?:juego favorito|videojuego favorito|favorite game|game favorite)$/u.test(normalized)) key = 'favorite_game';
  else if (/^(?:nombre|name|username)$/u.test(normalized)) key = 'name';
  else return undefined;
  return { keyLabel: label, key, value };
}

function hasMultipleMemoryClaims(text: string): boolean {
  return /[,;]/u.test(text)
    || /\b(?:y|e)\s+(?:mi\s+)?(?:ciudad|city|juego(?:\s+favorito)?|videojuego(?:\s+favorito)?|favorite[_ ]game|nombre|name|correo|email)\b/iu.test(text)
    || /[.!?]\s*(?:mi\s+)?(?:ciudad|city|juego(?:\s+favorito)?|videojuego(?:\s+favorito)?|favorite[_ ]game|nombre|name|correo|email)\s+(?:es|=|:)\s*/iu.test(text);
}

function hasSensitiveMemoryLabel(text: string): boolean {
  return /\b(?:password|passwd|secret|token|api[_ -]?key|authorization|credential|cookie|private[_ -]?key|contrase(?:n|ñ)a|clave|correo|email)\b/iu.test(text);
}

function cleanMemoryValue(value: string): string {
  const trimmed = value.trim().replace(/[.!?]+\s*$/u, '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\u201c') && trimmed.endsWith('\u201d'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1).trim();
  return trimmed;
}

function normalizedLabel(value: string): string {
  return value.toLocaleLowerCase('en-US').normalize('NFKD').replace(/\p{Diacritic}/gu, '')
    .replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim()
    .replace(/^(?:mi|my|la|el|the)\s+/u, '').replace(/\s+(?:guardad[oa]|saved)$/u, '').trim();
}

function canonicalMemoryLabel(value: string): string | undefined {
  const label = normalizedLabel(value);
  if (/^(?:city|ciudad|home city|ciudad actual|location)$/u.test(label)) return 'city';
  if (/^(?:name|nombre|user name|username|nombre de usuario|nombre guardado)$/u.test(label)) return 'name';
  if (/^(?:favorite game|game favorite|juego favorito|videojuego favorito)$/u.test(label)) return 'favorite game';
  return undefined;
}

function canonicalMemoryKey(value: string): string | undefined {
  const key = normalizedLabel(value);
  if (/\b(?:city|ciudad|location)\b/u.test(key)) return 'city';
  if (/\b(?:name|nombre|username)\b/u.test(key)) return 'name';
  if (/\b(?:favorite|favorito|favorita)\b/u.test(key) && /\b(?:game|juego|videojuego)\b/u.test(key)) return 'favorite game';
  return undefined;
}

function isOneKeyLabel(label: string): boolean {
  return !/(?:,|;|\b(?:and|y|all|todas?|every|each|memories|memorias)\b)/u.test(normalizedLabel(label));
}

function isSingleMemoryValue(value: string): boolean {
  return !/\b(?:and|y)\s+(?:my\s+|mi\s+)?[\w-]+\s+(?:a|to|por)\s+/iu.test(value);
}

function resolveMemoryKey(label: string, entries: readonly { readonly key: string; readonly value: string }[]): string | undefined {
  const normalized = normalizedLabel(label);
  const exact = entries.filter(({ key }) => normalizedLabel(key) === normalized);
  if (exact.length === 1) return exact[0]?.key;
  if (exact.length > 1) return undefined;

  const requested = canonicalMemoryLabel(label);
  if (!requested) return undefined;
  const matches = entries.filter(({ key }) => canonicalMemoryKey(key) === requested);
  return matches.length === 1 ? matches[0]?.key : undefined;
}

function isAffirmative(input: string): boolean {
  return /^(?:si|yes|confirmo|confirmar|hazlo|adelante|de acuerdo|cambiala|actualizala|do it|go ahead)(?: por favor)?$/u.test(normalize(input).replace(/[.!?]+$/u, '').trim());
}

function isNegative(input: string): boolean {
  return /^(?:no|no gracias|mejor no|rechazo|cancelar|cancelalo|olvidalo|never mind|no, gracias)$/u.test(normalize(input).replace(/[.!?]+$/u, '').trim());
}

function cancellationKind(input: string): 'cancel' | 'topic' | undefined {
  const normalized = normalize(input).replace(/[.!?]+$/u, '').trim();
  if (/^(?:olvidalo|no importa|cancela(?:lo)?|dejalo|mejor no|never mind|cancel(?: it)?)$/u.test(normalized)) return 'cancel';
  if (/^(?:quiero hablar(?: de otra cosa)?|hablemos de|cambiemos de tema|otra cosa|cambiando de tema)(?:\b|[:.!?])/u.test(normalized)) return 'topic';
  return undefined;
}

function isClearlyDifferentQuestion(input: string): boolean {
  const text = input.trim();
  const quoted = /^['"“].+['"”]$/u.test(text);
  const normalized = normalize(text).replace(/^[¿¡]+/u, '');
  return !quoted && (/[?؟]\s*$/u.test(text)
    || /^(?:que|cual|como|donde|cuando|quien|what|which|how|where|when|who)\b/u.test(normalized));
}

function isDifferentActionRequest(input: string): boolean {
  return /^(?:recu[eé]rdame|recordarme|guarda(?:r)?\s+(?:una\s+)?nota|anota|apunta|busca|buscar|mu[eé]strame|ens[eé]ñame)\b/iu.test(input.trim());
}

function parseHour(input: string): { readonly hour: number; readonly minute: number } | undefined {
  const normalized = normalize(input).replace(/[.!?]+$/u, '').trim();
  if (/^(?:al mediodia|mediodia)$/u.test(normalized)) return { hour: 12, minute: 0 };
  if (/^(?:a la medianoche|medianoche)$/u.test(normalized)) return { hour: 0, minute: 0 };
  const match = input.match(HOUR_FOLLOW_UP);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined;
}

function dueAtForLocalDate(localDay: string, hour: number, minute: number, now: Date): string | undefined {
  const [yearText, monthText, dayText] = localDay.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const due = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (due.getFullYear() !== year || due.getMonth() !== month - 1 || due.getDate() !== day
    || due.getHours() !== hour || due.getMinutes() !== minute || due <= now) return undefined;
  const offsetMinutes = -due.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, '0')}:${String(absoluteOffset % 60).padStart(2, '0')}`;
  return `${localDay}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offset}`;
}

function countGraphemes(value: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length;
}

function validSessionId(input: string): string | undefined {
  const id = input.trim();
  return SAFE_SESSION_ID.test(id) ? id : undefined;
}

function failText(result: ToolResult<unknown>, subject: string): string {
  return result.status === 'failure' || result.status === 'internal_error'
    ? `${subject} No se realizó la acción.`
    : subject;
}

export class SafeClarificationFlow {
  #pending: PendingClarification | undefined;
  #localQueryContext: LocalQueryContext | undefined;
  #repairAvailable = false;
  #repairConsumed = false;
  #lastActionExecuted: string | undefined;
  private readonly toolManager: ToolManager;
  private readonly sessionId: string;
  private readonly now: () => Date;
  private readonly onReminderCreated?: () => void | Promise<void>;
  private readonly memoryStore?: PersistentMemoryStore;

  constructor(options: SafeClarificationFlowOptions) {
    this.toolManager = options.toolManager;
    this.sessionId = options.sessionId;
    this.now = options.now ?? (() => new Date());
    this.onReminderCreated = options.onReminderCreated;
    this.memoryStore = options.memoryStore;
  }

  clear(): void {
    this.#pending = undefined;
    this.#localQueryContext = undefined;
    this.#repairAvailable = false;
    this.#repairConsumed = false;
    this.#lastActionExecuted = undefined;
  }

  observeCapabilityHelp(): void {
    this.#pending = undefined;
    this.#localQueryContext = { kind: 'capability-help' };
    this.#lastActionExecuted = undefined;
    this.#repairAvailable = true;
    this.#repairConsumed = false;
  }

  async handle(input: string, context: ClarificationInputContext): Promise<string | undefined> {
    if (context.sessionId !== this.sessionId) {
      this.clear();
      return undefined;
    }
    const correction = parseRepairCorrection(input);
    if (!this.#pending && this.#localQueryContext && !correction && cancellationKind(input)) {
      this.clear();
      return 'Entendido. Cancelé la reparación y no ejecuté ninguna consulta.';
    }
    if (this.#lastActionExecuted !== undefined) {
      this.#lastActionExecuted = undefined;
      if (correction) {
        this.#pending = undefined;
        this.#repairAvailable = false;
        this.#repairConsumed = true;
        return 'La acción anterior ya se ejecutó. No la revertí automáticamente; usa el comando explícito correspondiente si necesitas corregir los datos.';
      }
    }
    const pending = this.#pending;
    if (correction && this.#localQueryContext && this.#localQueryContext.kind !== 'capability-help') {
      if (!this.#repairAvailable || this.#repairConsumed) {
        this.clear();
        return 'Ya utilicé la única reparación permitida para esta consulta; no ejecuté otra acción.';
      }
      this.#repairAvailable = false;
      this.#repairConsumed = true;
      const previousQuery = this.#localQueryContext;
      this.#localQueryContext = undefined;
      const repaired = await this.executeReadOnlyQuery(correction.instruction, previousQuery, context, 'repair');
      return repaired ?? 'No pude reparar la consulta de forma inequívoca; cancelé la intención anterior y no ejecuté ninguna consulta.';
    }
    if (correction && (pending !== undefined || this.#repairAvailable)) {
      if (!this.#repairAvailable || this.#repairConsumed) {
        this.clear();
      return 'Ya utilicé la única reparación permitida para esta intención; no ejecuté otra acción.';
      }
      this.#repairAvailable = false;
      this.#repairConsumed = true;
      this.#pending = undefined;
      const repaired = await this.executeRepair(correction.instruction, pending, context);
      return repaired ?? 'No pude reparar la intención de forma inequívoca; cancelé la intención anterior y no ejecuté ninguna acción.';
    }
    if (!pending && !correction && this.#localQueryContext) {
      const followup = parseReadOnlyQueryFollowup(input, this.#localQueryContext);
      if (followup) {
        const previousQuery = this.#localQueryContext;
        this.#localQueryContext = undefined;
        this.#repairAvailable = false;
        this.#repairConsumed = true;
        if ('missingSessionId' in followup) {
          const pending: Extract<PendingClarification, { kind: 'saved-session-search-id' }> = {
            kind: 'saved-session-search-id', missingField: 'sessionId',
            originalIntent: { kind: 'saved-session.search', query: followup.missingSessionId },
          };
          this.#pending = pending;
          return this.promptFor(pending);
        }
        if ('clarification' in followup) return followup.clarification;
        if (followup.intent.kind === 'capability-help') return formatCapabilityHelp();
        const response = await this.executeReadOnlyQuery(input, previousQuery, context, 'followup', followup.intent);
        return response ?? 'No pude resolver el seguimiento de forma inequívoca; no ejecuté ninguna consulta.';
      }
    }
    if (!pending && !this.#repairAvailable) this.#repairConsumed = false;
    if (!pending && this.#repairAvailable && !correction) this.#repairAvailable = false;
    if (!pending && this.#localQueryContext && !correction) this.#localQueryContext = undefined;
    if (!pending) {
      const memoryForget = this.detectMemoryForget(input);
      if (memoryForget) {
        const detected = await memoryForget;
        if (detected.kind === 'memory-unavailable') return detected.response;
        this.#pending = detected;
        this.#repairAvailable = true;
        this.#repairConsumed = false;
        return this.promptFor(detected);
      }
      const memoryCreate = this.detectMemoryCreate(input);
      if (memoryCreate) {
        const detected = await memoryCreate;
        if (detected.kind === 'memory-unavailable') return detected.response;
        this.#pending = detected;
        this.#repairAvailable = true;
        this.#repairConsumed = false;
        return this.promptFor(detected);
      }
      const memoryUpdate = await this.detectMemoryUpdate(input);
      if (memoryUpdate) {
        if (memoryUpdate.kind === 'memory-unavailable') return memoryUpdate.response;
        this.#pending = memoryUpdate;
        this.#repairAvailable = true;
        this.#repairConsumed = false;
        return this.promptFor(memoryUpdate);
      }
      const detected = detectReminder(input, this.now())
        ?? detectSavedSearch(input)
        ?? detectNote(input)
        ?? detectSavedSessionInfo(input);
      if (!detected) {
        this.rememberLocalQueryContext(input);
        return undefined;
      }
      this.#pending = detected;
      this.#repairAvailable = true;
      this.#repairConsumed = false;
      return this.promptFor(detected);
    }

    const cancellation = cancellationKind(input);
    if (cancellation) {
      this.clear();
      return cancellation === 'cancel'
        ? 'Entendido. Cancelé la aclaración y no hice ningún cambio.'
        : undefined;
    }
    if (isClearlyDifferentQuestion(input)) {
      this.clear();
      this.rememberLocalQueryContext(input);
      return undefined;
    }
    if (pending.kind === 'note-content' && isDifferentActionRequest(input)) {
      this.clear();
      return 'Esa respuesta inicia otra acción; cancelé la aclaración de nota y no ejecuté ninguna acción.';
    }

    // Consume the only clarification before executing; retries cannot duplicate a side effect.
    this.clear();
    try {
      switch (pending.kind) {
        case 'reminder-hour': return await this.resolveReminder(pending, input, context);
        case 'saved-session-search-id': return await this.resolveSavedSearch(pending, input, context);
        case 'saved-session-search-query': return await this.resolveSavedSearchQuery(pending, input, context);
        case 'note-content': return await this.resolveNote(input, context);
        case 'note-show-id': return await this.resolveNoteShow(input, context);
        case 'saved-session-info-id': return await this.resolveSavedSessionInfo(input, context);
        case 'memory-update': return await this.resolveMemoryUpdate(pending, input);
        case 'memory-create': return await this.resolveMemoryCreate(pending, input);
        case 'memory-forget': return await this.resolveMemoryForget(pending, input);
      }
    } catch {
      return 'No pude completar la aclaración. No se realizó ninguna acción.';
    }
  }

  private promptFor(pending: PendingClarification): string {
    switch (pending.kind) {
      case 'reminder-hour': return '¿A qué hora local quieres que te lo recuerde mañana?';
      case 'saved-session-search-id': return '¿Qué ID de conversación guardada quieres consultar?';
      case 'note-content': return '¿Qué texto explícito quieres guardar como nota? No asumiré a qué se refiere “eso”.';
      case 'saved-session-info-id': return '¿Qué ID de conversación guardada quieres que consulte?';
      case 'saved-session-search-query': return '¿Qué texto literal quieres buscar dentro de esa conversación?';
      case 'note-show-id': return '¿Qué ID de nota quieres mostrar?';
      case 'memory-update': return `Tengo guardado ${pending.key} = ${JSON.stringify(pending.oldValue)}. ¿Quieres cambiarlo a ${JSON.stringify(pending.newValue)}? Responde sí o no.`;
      case 'memory-create': return `¿Quieres que guarde ${pending.key} = ${JSON.stringify(pending.value)}? Responde sí o no.`;
      case 'memory-forget': {
        const entry = { key: pending.key, value: pending.expectedValue };
        const visibleValue = isSafeExplicitMemoryEntry(entry) ? JSON.stringify(pending.expectedValue) : '[dato sensible oculto]';
        return `Tengo guardado ${pending.key} = ${visibleValue}. ¿Quieres que lo olvide? Responde sí o no.`;
      }
    }
  }

  private async executeRepair(
    instruction: string,
    previous: PendingClarification | undefined,
    context: ClarificationInputContext,
  ): Promise<string | undefined> {
    const target = instruction.trim();
    if (!target) return undefined;
    const cancellation = cancellationKind(target);
    if (cancellation) return 'Entendido. Cancelé la intención anterior y no inicié otra acción.';

    const readOnly = await this.executeReadOnlyQuery(target, undefined, context, 'repair');
    if (readOnly !== undefined) return readOnly;

    const noteText = parseRepairNote(target, previous);
    if (noteText) return this.resolveNote(noteText, context);

    const reminder = parseRepairReminder(target, this.now());
    if (reminder?.kind === 'missing-hour') {
      this.#pending = reminder.pending;
      return this.promptFor(reminder.pending);
    }
    if (reminder?.kind === 'ready') return this.resolveReminder(reminder.pending, reminder.time, context);

    const search = parseRepairSavedSearch(target, previous);
    if (search) {
      const searchPending: Extract<PendingClarification, { kind: 'saved-session-search-id' }> = {
        kind: 'saved-session-search-id', missingField: 'sessionId',
        originalIntent: { kind: 'saved-session.search', query: search.query },
      };
      return this.resolveSavedSearch(searchPending, search.sessionId, context);
    }

    const infoId = parseRepairSavedInfo(target);
    if (infoId) {
      return this.resolveSavedSessionInfo(infoId, context);
    }

    const memoryForget = this.detectMemoryForget(target);
    if (memoryForget) {
      const detected = await memoryForget;
      if (detected.kind === 'memory-unavailable') return detected.response;
      this.#pending = detected;
      return this.promptFor(detected);
    }
    const memoryCreate = this.detectMemoryCreate(target);
    if (memoryCreate) {
      const detected = await memoryCreate;
      if (detected.kind === 'memory-unavailable') return detected.response;
      this.#pending = detected;
      return this.promptFor(detected);
    }
    const memoryUpdate = await this.detectMemoryUpdate(target);
    if (memoryUpdate) {
      if (memoryUpdate.kind === 'memory-unavailable') return memoryUpdate.response;
      this.#pending = memoryUpdate;
      return this.promptFor(memoryUpdate);
    }

    return resolveNaturalCapabilityHelp(target);
  }

  private rememberLocalQueryContext(input: string): void {
    const intent = parseReadOnlyQueryIntent(input);
    this.#localQueryContext = intent;
    this.#repairAvailable = intent !== undefined;
    this.#repairConsumed = false;
  }

  private async executeReadOnlyQuery(
    input: string,
    previous: ReadOnlyQueryIntent | undefined,
    context: ClarificationInputContext,
    authorizationSource: 'repair' | 'followup',
    resolvedIntent?: ReadOnlyQueryIntent,
  ): Promise<string | undefined> {
    const intent = resolvedIntent ?? parseReadOnlyQueryIntent(input);
    if (!intent) {
      return resolveNaturalCapabilityHelp(input);
    }

    if (intent.kind === 'saved-session-search') {
      const query = intent.query ?? (previous?.kind === 'saved-session-search' ? previous.query : undefined);
      const sessionId = intent.sessionId
        ?? (previous?.kind === 'saved-sessions' ? previous.sessionId : undefined)
        ?? (previous?.kind === 'saved-session-search' ? previous.sessionId : undefined);
      if (!sessionId && query) {
        const pending: Extract<PendingClarification, { kind: 'saved-session-search-id' }> = {
          kind: 'saved-session-search-id', missingField: 'sessionId',
          originalIntent: { kind: 'saved-session.search', query },
        };
        this.#pending = pending;
        return this.promptFor(pending);
      }
      if (sessionId && !query) {
        const pending: Extract<PendingClarification, { kind: 'saved-session-search-query' }> = {
          kind: 'saved-session-search-query', missingField: 'query', sessionId,
        };
        this.#pending = pending;
        return this.promptFor(pending);
      }
      if (!sessionId || !query || Array.from(query).length > 120 || /[\r\n\0]/u.test(query)) return undefined;
      return this.executeSavedSessionSearch(sessionId, query, input, context, authorizationSource);
    }

    if (intent.kind === 'saved-sessions' && intent.operation === 'info' && !intent.sessionId) {
      const referencedId = /\b(?:esa|esta)\s+(?:conversaci[oó]n|sesi[oó]n)\b/iu.test(input)
        ? previous?.kind === 'saved-sessions' ? previous.sessionId
          : previous?.kind === 'saved-session-search' ? previous.sessionId : undefined
        : undefined;
      if (!referencedId) {
        const pending: Extract<PendingClarification, { kind: 'saved-session-info-id' }> = {
          kind: 'saved-session-info-id', missingField: 'sessionId', originalIntent: { kind: 'saved-session.info' },
        };
        this.#pending = pending;
        return this.promptFor(pending);
      }
      return this.executeSavedSessionMetadata('info', referencedId, input, context, authorizationSource);
    }

    if (intent.kind === 'note-show' && !intent.noteId) {
      const pending: Extract<PendingClarification, { kind: 'note-show-id' }> = {
        kind: 'note-show-id', missingField: 'noteId',
      };
      this.#pending = pending;
      return this.promptFor(pending);
    }

    switch (intent.kind) {
      case 'reminders-list': {
        const result = await this.executeReadOnlyTool<LocalRemindersListValue>(
          LOCAL_REMINDERS_LIST_TOOL_ID, 'reminders-list', { includeCompleted: intent.includeCompleted }, input, context, authorizationSource,
        );
        if (result.status !== 'success') return failText(result, 'No pude consultar los recordatorios.');
        if (result.value.reminders.length === 0) return result.value.includeCompleted
          ? 'No tienes recordatorios guardados.' : 'No tienes recordatorios pendientes.';
        return result.value.reminders.map(({ id, text, dueAt, status }) =>
          `${status === 'pending' ? 'Pendiente' : 'Completado'} · ${formatReminderDate(dueAt)} · ${text} (${id})`).join('\n');
      }
      case 'reminder-next': {
        const result = await this.executeReadOnlyTool<LocalReminderNextValue>(
          LOCAL_REMINDER_NEXT_TOOL_ID, 'reminder-next', {}, input, context, authorizationSource,
        );
        if (result.status !== 'success') return failText(result, 'No pude consultar el próximo recordatorio.');
        const reminder = result.value.reminder;
        return reminder ? `Próximo recordatorio: ${reminder.text}\nFecha: ${formatReminderDate(reminder.dueAt)} (${reminder.id})`
          : 'No tienes recordatorios pendientes.';
      }
      case 'notes-list': {
        const result = await this.executeReadOnlyTool<LocalNotesListValue>(
          LOCAL_NOTES_LIST_TOOL_ID, 'notes-list', {}, input, context, authorizationSource,
        );
        if (result.status !== 'success') return failText(result, 'No pude consultar las notas.');
        return result.value.notes.length === 0 ? 'No tienes notas guardadas.'
          : result.value.notes.map(({ id, preview, updatedAt }) => `${id} · ${preview} · ${updatedAt}`).join('\n');
      }
      case 'note-show': {
        const result = await this.executeReadOnlyTool<LocalNoteShowValue>(
          LOCAL_NOTE_SHOW_TOOL_ID, 'note-show', { id: intent.noteId }, input, context, authorizationSource,
        );
        return result.status === 'success' ? `Nota ${result.value.id}:\n${result.value.text}`
          : failText(result, 'No pude mostrar esa nota.');
      }
      case 'saved-sessions':
        return this.executeSavedSessionMetadata(intent.operation, intent.sessionId, input, context, authorizationSource);
      case 'status-summary': {
        const result = await this.executeReadOnlyTool<LocalStatusSummaryValue>(
          LOCAL_STATUS_SUMMARY_TOOL_ID, 'status-summary', {}, input, context, authorizationSource,
        );
        if (result.status !== 'success') return failText(result, 'No pude consultar el estado local.');
        const { provider, session, notes, reminders } = result.value;
        return `Proveedor: ${provider.provider} · modelo: ${provider.model} · credencial configurada: ${provider.credentialConfigured ? 'sí' : 'no'}\nSesión actual: ${session.id} · ${session.messageCount} mensajes · ${session.saved ? 'guardada' : 'no guardada'}\nNotas: ${notes.count} · recordatorios pendientes: ${reminders.pendingCount} · completados: ${reminders.completedCount}`;
      }
      case 'capability-help': return formatCapabilityHelp();
    }
  }

  private executeReadOnlyTool<T>(
    toolId: ReadOnlyQueryRepairToolId,
    kind: ReadOnlyQueryRepairKind,
    args: object,
    userInput: string,
    context: ClarificationInputContext,
    authorizationSource: 'repair' | 'followup' = 'repair',
  ): Promise<ToolResult<T>> {
    return this.toolManager.execute<T>(toolId, args, {
      ...(authorizationSource === 'repair'
        ? createReadOnlyQueryRepairToolOptions(toolId, kind, context.sessionId, userInput)
        : createReadOnlyQueryFollowupToolOptions(toolId, kind, context.sessionId, userInput)),
      signal: context.signal,
    });
  }

  private async executeSavedSessionMetadata(
    operation: 'list' | 'count' | 'recent' | 'info',
    sessionId: string | undefined,
    userInput: string,
    context: ClarificationInputContext,
    authorizationSource: 'repair' | 'followup' = 'repair',
  ): Promise<string> {
    const result = await this.executeReadOnlyTool<SavedSessionQueryValue>(
      LOCAL_SAVED_SESSIONS_QUERY_TOOL_ID, 'saved-sessions-query',
      { operation, ...(operation === 'info' && sessionId ? { sessionId } : {}) }, userInput, context, authorizationSource,
    );
    if (result.status !== 'success') return failText(result, 'No pude consultar las conversaciones guardadas.');
    switch (result.value.operation) {
      case 'count': return `Tienes ${result.value.count} conversaciones guardadas.`;
      case 'list': return result.value.sessions.length === 0 ? 'No tienes conversaciones guardadas.'
        : result.value.sessions.map(({ name, title, messageCount, savedAt }) => `${name} · ${title} · ${messageCount} mensajes · ${savedAt}`).join('\n');
      case 'recent': return result.value.session
        ? `Conversación guardada más reciente: ${result.value.session.name} · ${result.value.session.title} · ${result.value.session.messageCount} mensajes · ${result.value.session.savedAt}`
        : 'No tienes conversaciones guardadas.';
      case 'info': return result.value.session
        ? `Conversación ${result.value.session.name}: ${result.value.session.title} · ${result.value.session.messageCount} mensajes · guardada ${result.value.session.savedAt}`
        : `No existe la conversación guardada: ${sessionId ?? 'ID no disponible'}`;
    }
  }

  private async executeSavedSessionSearch(
    sessionId: string,
    query: string,
    userInput: string,
    context: ClarificationInputContext,
    authorizationSource: 'repair' | 'followup' = 'repair',
  ): Promise<string> {
    const result = await this.executeReadOnlyTool<SavedSessionSearchValue>(
      LOCAL_SAVED_SESSION_SEARCH_TOOL_ID, 'saved-session-search', { sessionId, query }, userInput, context, authorizationSource,
    );
    return result.status === 'success' ? formatSavedSessionSearch(result.value)
      : failText(result, 'No pude buscar en esa conversación.');
  }

  private detectMemoryForget(input: string): Promise<MemoryDetection> | undefined {
    if (!this.memoryStore) return undefined;
    const intent = parseExplicitMemoryForget(input);
    if (!intent) return undefined;
    return this.resolveMemoryForgetIntent(intent.keyLabel, this.memoryStore);
  }

  private async resolveMemoryForgetIntent(keyLabel: string, memoryStore: PersistentMemoryStore): Promise<MemoryDetection> {
    if (!isOneKeyLabel(keyLabel) || hasMultipleMemoryClaims(keyLabel)) {
      return { kind: 'memory-unavailable', response: 'Solo puedo proponer olvidar una memoria por vez; no eliminé nada. Pídeme cada dato por separado.' };
    }
    try {
      const entries = await memoryStore.list();
      const key = resolveMemoryKey(keyLabel, entries);
      if (!key) return { kind: 'memory-unavailable', response: 'No tengo guardada una memoria identificable con esa clave; no eliminé nada.' };
      const current = entries.find((entry) => entry.key === key);
      if (!current) return { kind: 'memory-unavailable', response: 'Esa memoria ya no está guardada; no eliminé nada.' };
      return { kind: 'memory-forget', key, expectedValue: current.value };
    } catch {
      return { kind: 'memory-unavailable', response: 'No pude consultar esa memoria; no eliminé nada.' };
    }
  }

  private detectMemoryCreate(input: string): Promise<MemoryDetection> | undefined {
    const explicit = parseExplicitMemoryCreate(input);
    if (!explicit) return undefined;
    return this.resolveMemoryCreateIntent(explicit.text);
  }

  private async resolveMemoryCreateIntent(text: string): Promise<MemoryDetection> {
    if (hasMultipleMemoryClaims(text)) {
      return { kind: 'memory-unavailable', response: 'Solo puedo proponer una memoria por vez; no guardé nada. Pídeme cada dato por separado.' };
    }
    const intent = parseMemoryFact(text);
    if (!intent) {
      const response = hasSensitiveMemoryLabel(text)
        ? 'No guardé ese dato sensible en Persistent Memory.'
        : 'No pude identificar una sola clave y un valor claro; no guardé nada.';
      return { kind: 'memory-unavailable', response };
    }
    if (!intent.value || /[\r\n\0]/u.test(intent.value)) {
      return { kind: 'memory-unavailable', response: 'El valor propuesto no es válido; no guardé nada.' };
    }
    if (!isSafeExplicitMemoryEntry({ key: intent.key, value: intent.value })) {
      return { kind: 'memory-unavailable', response: 'No guardé ese dato sensible en Persistent Memory.' };
    }
    try {
      validateMemoryValue(intent.value);
      if (!this.memoryStore) {
        return { kind: 'memory-unavailable', response: 'La creación de memorias no está disponible; no guardé nada.' };
      }
      const entries = await this.memoryStore.list();
      const existingKey = resolveMemoryKey(intent.keyLabel, entries);
      if (existingKey) {
        const existing = entries.find(({ key }) => key === existingKey);
        if (!existing || !isSafeExplicitMemoryEntry(existing)) {
          return { kind: 'memory-unavailable', response: 'No puedo actualizar esa memoria mediante confirmación natural.' };
        }
        return { kind: 'memory-update', key: existingKey, oldValue: existing.value, newValue: intent.value };
      }
      return { kind: 'memory-create', key: intent.key, value: intent.value };
    } catch {
      return { kind: 'memory-unavailable', response: 'La propuesta de memoria no es válida; no guardé nada.' };
    }
  }

  private async detectMemoryUpdate(input: string): Promise<MemoryDetection | undefined> {
    if (!this.memoryStore) return undefined;
    const intent = parseExplicitMemoryUpdate(input);
    if (!intent) return undefined;
    if (!intent.newValue || /[\r\n\0]/u.test(intent.newValue)
      || !isOneKeyLabel(intent.keyLabel) || !isSingleMemoryValue(intent.newValue)) {
      return { kind: 'memory-unavailable', response: 'No pude identificar una sola memoria y un valor nuevo claro; no cambié nada.' };
    }
    try {
      validateMemoryValue(intent.newValue);
      const entries = await this.memoryStore.list();
      const key = resolveMemoryKey(intent.keyLabel, entries);
      if (!key) {
        return { kind: 'memory-unavailable', response: 'No encontré una única memoria existente para actualizar; no crearé una nueva. Usa /remember <key> <value> para guardar una memoria nueva.' };
      }
      const current = entries.find((entry) => entry.key === key);
      if (!current || !isSafeExplicitMemoryEntry(current)
        || !isSafeExplicitMemoryEntry({ key, value: intent.newValue })) {
        return { kind: 'memory-unavailable', response: 'No puedo actualizar esa memoria mediante confirmación natural.' };
      }
      return { kind: 'memory-update', key, oldValue: current.value, newValue: intent.newValue };
    } catch {
      return { kind: 'memory-unavailable', response: 'La solicitud de actualización no es válida; no cambié nada.' };
    }
  }

  private async resolveMemoryUpdate(
    pending: Extract<PendingClarification, { kind: 'memory-update' }>,
    input: string,
  ): Promise<string> {
    if (isNegative(input)) return `Entendido. No cambié ${pending.key}.`;
    if (!isAffirmative(input)) return 'No recibí una confirmación clara; cancelé la actualización y no cambié nada.';
    if (!this.memoryStore) return 'La actualización no está disponible; no cambié nada.';
    const result = await this.memoryStore.update(pending.key, pending.newValue, pending.oldValue);
    switch (result) {
      case 'updated': this.#lastActionExecuted = 'memory update'; return `Memoria actualizada: ${pending.key}.`;
      case 'unchanged': return `La memoria ${pending.key} ya tenía ese valor; no fue necesario cambiarla.`;
      case 'missing': return `La memoria ${pending.key} ya no existe; no creé otra.`;
      case 'conflict': return `La memoria ${pending.key} cambió desde la solicitud. No la sobrescribí; inicia de nuevo la actualización.`;
    }
  }

  private async resolveMemoryCreate(
    pending: Extract<PendingClarification, { kind: 'memory-create' }>,
    input: string,
  ): Promise<string> {
    if (isNegative(input)) return `Entendido. No guardé ${pending.key}.`;
    if (!isAffirmative(input)) return 'No recibí una confirmación clara; cancelé la propuesta y no guardé nada.';
    if (!this.memoryStore) return 'La creación de memorias no está disponible; no guardé nada.';
    const result = await this.memoryStore.remember(pending.key, pending.value);
    if (result === 'created') {
      this.#lastActionExecuted = 'memory create';
      return `Memoria guardada: ${pending.key}.`;
    }
    return `La memoria ${pending.key} ya existe; no la sobrescribí. Si quieres cambiarla, pídeme explícitamente actualizarla.`;
  }

  private async resolveMemoryForget(
    pending: Extract<PendingClarification, { kind: 'memory-forget' }>,
    input: string,
  ): Promise<string> {
    if (isNegative(input)) return `Entendido. No olvidé ${pending.key}.`;
    if (!isAffirmative(input)) return 'No recibí una confirmación clara; cancelé la solicitud y no eliminé nada.';
    if (!this.memoryStore) return 'La eliminación no está disponible; no cambié la memoria.';
    const result = await this.memoryStore.forget(pending.key, pending.expectedValue);
    switch (result) {
      case 'deleted': this.#lastActionExecuted = 'memory forget'; return `Memoria olvidada: ${pending.key}.`;
      case 'missing': return `La memoria ${pending.key} ya no existe; no eliminé otra entrada.`;
      case 'conflict': return `La memoria ${pending.key} cambió desde la solicitud. No la eliminé; vuelve a pedirlo si todavía quieres olvidarla.`;
    }
  }

  private async resolveReminder(
    pending: Extract<PendingClarification, { kind: 'reminder-hour' }>,
    input: string,
    context: ClarificationInputContext,
  ): Promise<string> {
    const time = parseHour(input);
    if (!time) return 'No pude interpretar una hora válida; cancelé el recordatorio sin guardarlo.';
    const dueAt = dueAtForLocalDate(pending.safeContext.localDate, time.hour, time.minute, this.now());
    if (!dueAt) return 'Esa hora local no es válida o ya pasó; no guardé el recordatorio.';
    const result = await this.toolManager.execute<LocalReminderCreateValue>(LOCAL_REMINDER_CREATE_TOOL_ID, {
      text: pending.originalIntent.text,
      dueAt,
    }, {
      ...createClarificationToolOptions(LOCAL_REMINDER_CREATE_TOOL_ID, 'reminder-hour', context.sessionId),
      signal: context.signal,
    });
    if (result.status !== 'success') return failText(result, 'No pude crear el recordatorio.');
    this.#lastActionExecuted = 'reminder creation';
    try { await this.onReminderCreated?.(); } catch { /* The persisted reminder remains created; do not retry it. */ }
    return `Recordatorio creado: ${result.value.id}\nFecha: ${formatReminderDate(result.value.dueAt)}\n${result.value.text}`;
  }

  private async resolveSavedSearch(
    pending: Extract<PendingClarification, { kind: 'saved-session-search-id' }>,
    input: string,
    context: ClarificationInputContext,
  ): Promise<string> {
    const sessionId = validSessionId(input);
    if (!sessionId) return 'El ID no es válido; no busqué en ninguna conversación.';
    if (!pending.originalIntent.query) {
      const queryPending: Extract<PendingClarification, { kind: 'saved-session-search-query' }> = {
        kind: 'saved-session-search-query', missingField: 'query', sessionId,
      };
      this.#pending = queryPending;
      return this.promptFor(queryPending);
    }
    return this.executeSavedSessionSearch(
      sessionId,
      pending.originalIntent.query,
      `Busca ${pending.originalIntent.query} en la conversación guardada ${sessionId}.`,
      context,
    );
  }

  private async resolveSavedSearchQuery(
    pending: Extract<PendingClarification, { kind: 'saved-session-search-query' }>,
    input: string,
    context: ClarificationInputContext,
  ): Promise<string> {
    const query = stripEndingPunctuation(input.trim());
    if (!query || Array.from(query).length > 120 || /[\r\n\0]/u.test(query)) {
      return 'El texto de búsqueda está vacío o no es válido; no consulté la conversación.';
    }
    return this.executeSavedSessionSearch(
      pending.sessionId, query, `Busca ${query} en la conversación guardada ${pending.sessionId}.`, context,
    );
  }

  private async resolveNoteShow(input: string, context: ClarificationInputContext): Promise<string> {
    const id = input.trim();
    if (!/^[A-Za-z0-9_-]{10}$/u.test(id)) return 'El ID de nota no es válido; no consulté ninguna nota.';
    const result = await this.executeReadOnlyTool<LocalNoteShowValue>(
      LOCAL_NOTE_SHOW_TOOL_ID, 'note-show', { id }, `Muéstrame la nota ${id}.`, context,
    );
    return result.status === 'success' ? `Nota ${result.value.id}:\n${result.value.text}`
      : failText(result, 'No pude mostrar esa nota.');
  }

  private async resolveNote(input: string, context: ClarificationInputContext): Promise<string> {
    const text = input.trim();
    if (isClearlyDifferentQuestion(text)) return 'Parece una pregunta nueva; cancelé la nota sin guardar nada. Puedes volver a pedirla con el texto explícito.';
    if (!text || countGraphemes(text) > NOTE_MAX_TEXT_LENGTH) {
      return `El texto de la nota está vacío o supera ${NOTE_MAX_TEXT_LENGTH} caracteres; no la guardé.`;
    }
    const result = await this.toolManager.execute<LocalNoteCreateValue>(LOCAL_NOTE_CREATE_TOOL_ID, { text }, {
      ...createClarificationToolOptions(LOCAL_NOTE_CREATE_TOOL_ID, 'note-content', context.sessionId),
      signal: context.signal,
    });
    if (result.status !== 'success') return failText(result, 'No pude guardar la nota.');
    this.#lastActionExecuted = 'note creation';
    return `Nota guardada: ${result.value.id}`;
  }

  private async resolveSavedSessionInfo(input: string, context: ClarificationInputContext): Promise<string> {
    const sessionId = validSessionId(input);
    if (!sessionId) return 'El ID no es válido; no consulté ninguna conversación.';
    const userInput = `Muéstrame información de la conversación ${sessionId}.`;
    const result = await this.toolManager.execute<SavedSessionQueryValue>(LOCAL_SAVED_SESSIONS_QUERY_TOOL_ID, {
      operation: 'info',
      sessionId,
    }, {
      ...createClarificationToolOptions(LOCAL_SAVED_SESSIONS_QUERY_TOOL_ID, 'saved-session-info-id', context.sessionId, userInput),
      signal: context.signal,
    });
    if (result.status !== 'success') return failText(result, 'No pude consultar esa conversación.');
    if (result.value.operation !== 'info' || !result.value.session) return `No existe la conversación guardada: ${sessionId}`;
    const { title, messageCount, savedAt } = result.value.session;
    return `Conversación ${sessionId}: ${title} · ${messageCount} mensajes · guardada ${savedAt}`;
  }
}

export function detectPendingClarification(input: string, now: Date = new Date()): PendingClarification | undefined {
  return detectReminder(input, now)
    ?? detectSavedSearch(input)
    ?? detectNote(input)
    ?? detectSavedSessionInfo(input);
}

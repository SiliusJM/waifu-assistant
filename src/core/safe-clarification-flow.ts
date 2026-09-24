import type { ToolManager } from '../tools/tool-manager.js';
import type { ToolResult } from '../tools/tool-types.js';
import { createClarificationToolOptions } from '../tools/clarification-tool-authorization.js';
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
  };

export interface ClarificationInputContext {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}

export interface SafeClarificationFlowOptions {
  readonly toolManager: ToolManager;
  readonly sessionId: string;
  readonly now?: () => Date;
  readonly onReminderCreated?: () => void | Promise<void>;
}

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
  if (!/^(?:mu[eé]strame|ens[eé]ñame)\s+(?:esa|esta)\s+(?:conversaci[oó]n|sesi[oó]n)(?:\s+guardada)?\s*[.!?]*$/iu.test(input.trim())) return undefined;
  return { kind: 'saved-session-info-id', missingField: 'sessionId', originalIntent: { kind: 'saved-session.info' } };
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
  private readonly toolManager: ToolManager;
  private readonly sessionId: string;
  private readonly now: () => Date;
  private readonly onReminderCreated?: () => void | Promise<void>;

  constructor(options: SafeClarificationFlowOptions) {
    this.toolManager = options.toolManager;
    this.sessionId = options.sessionId;
    this.now = options.now ?? (() => new Date());
    this.onReminderCreated = options.onReminderCreated;
  }

  clear(): void {
    this.#pending = undefined;
  }

  async handle(input: string, context: ClarificationInputContext): Promise<string | undefined> {
    if (context.sessionId !== this.sessionId) {
      this.clear();
      return undefined;
    }
    const pending = this.#pending;
    if (!pending) {
      const detected = detectReminder(input, this.now())
        ?? detectSavedSearch(input)
        ?? detectNote(input)
        ?? detectSavedSessionInfo(input);
      if (!detected) return undefined;
      this.#pending = detected;
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
        case 'note-content': return await this.resolveNote(input, context);
        case 'saved-session-info-id': return await this.resolveSavedSessionInfo(input, context);
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
    const result = await this.toolManager.execute<SavedSessionSearchValue>(LOCAL_SAVED_SESSION_SEARCH_TOOL_ID, {
      sessionId,
      query: pending.originalIntent.query,
    }, {
      ...createClarificationToolOptions(LOCAL_SAVED_SESSION_SEARCH_TOOL_ID, 'saved-session-search-id', context.sessionId),
      signal: context.signal,
    });
    return result.status === 'success'
      ? formatSavedSessionSearch(result.value)
      : failText(result, 'No pude buscar en esa conversación.');
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

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { AssistantError } from '../shared/errors.js';

export const REMINDER_SCHEMA_VERSION = 1 as const;
export const REMINDER_MAX_ENTRIES = 100 as const;
export const REMINDER_MAX_TEXT_LENGTH = 500 as const;

export interface Reminder {
  readonly id: string;
  readonly text: string;
  readonly dueAt: string;
  readonly createdAt: string;
  readonly status: 'pending';
}

export interface ReminderFileSystem {
  readonly mkdir: (path: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
}

export interface ReminderStoreOptions {
  readonly fileSystem?: ReminderFileSystem;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

const defaultFileSystem: ReminderFileSystem = {
  mkdir: async (path) => { await mkdir(path, { recursive: true, mode: 0o700 }); },
  readFile: async (path) => readFile(path, 'utf8'),
  writeFile: async (path, data) => { await writeFile(path, data, { encoding: 'utf8', mode: 0o600 }); },
  rename,
  rm: async (path) => { await rm(path, { force: true }); },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function reminderError(
  message: string,
  code: 'REMINDER_CONFIGURATION_ERROR' | 'REMINDER_CORRUPT_ERROR' | 'REMINDER_LIMIT_ERROR' | 'REMINDER_IO_ERROR',
  cause?: unknown,
): AssistantError {
  return new AssistantError(message, { code, retryable: false, cause });
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && /^r-[a-f0-9]{8}$/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function validateReminder(value: unknown): Reminder {
  if (!isRecord(value)
    || !isValidId(value.id)
    || typeof value.text !== 'string'
    || value.text.trim().length === 0
    || value.text.length > REMINDER_MAX_TEXT_LENGTH
    || !isCanonicalTimestamp(value.dueAt)
    || !isCanonicalTimestamp(value.createdAt)
    || value.status !== 'pending'
    || Object.keys(value).some((key) => !['id', 'text', 'dueAt', 'createdAt', 'status'].includes(key))) {
    throw reminderError('The reminders file contains an invalid reminder.', 'REMINDER_CORRUPT_ERROR');
  }
  return {
    id: value.id,
    text: value.text,
    dueAt: value.dueAt,
    createdAt: value.createdAt,
    status: 'pending',
  };
}

function validateDocument(value: unknown): Map<string, Reminder> {
  if (!isRecord(value) || value.version !== REMINDER_SCHEMA_VERSION || !Array.isArray(value.reminders)) {
    throw reminderError('The reminders file has an unsupported or invalid schema.', 'REMINDER_CORRUPT_ERROR');
  }
  if (value.reminders.length > REMINDER_MAX_ENTRIES) {
    throw reminderError('The reminders file contains too many reminders.', 'REMINDER_LIMIT_ERROR');
  }
  const result = new Map<string, Reminder>();
  for (const rawReminder of value.reminders) {
    const reminder = validateReminder(rawReminder);
    if (result.has(reminder.id)) {
      throw reminderError('The reminders file contains duplicate IDs.', 'REMINDER_CORRUPT_ERROR');
    }
    result.set(reminder.id, reminder);
  }
  if (Object.keys(value).some((key) => key !== 'version' && key !== 'reminders')) {
    throw reminderError('The reminders file contains unsupported fields.', 'REMINDER_CORRUPT_ERROR');
  }
  return result;
}

function compareReminders(left: Reminder, right: Reminder): number {
  return left.dueAt.localeCompare(right.dueAt) || left.id.localeCompare(right.id);
}

function toIsoTimestamp(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw reminderError('A valid date is required for a reminder.', 'REMINDER_CONFIGURATION_ERROR');
  }
  return value.toISOString();
}

export function resolveReminderPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.YUKI_REMINDERS_PATH?.trim();
  return configured ? resolve(configured) : join(homedir(), '.waifu-assistant', 'reminders.json');
}

export class ReminderStore {
  private reminders = new Map<string, Reminder>();
  private loaded = false;
  private readonly fileSystem: ReminderFileSystem;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(public readonly filePath: string, options: ReminderStoreOptions = {}) {
    if (!filePath.trim()) {
      throw reminderError('Reminder path cannot be empty.', 'REMINDER_CONFIGURATION_ERROR');
    }
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  async load(): Promise<void> {
    let serialized: string;
    try {
      serialized = await this.fileSystem.readFile(this.filePath);
    } catch (error) {
      if (isMissing(error)) {
        this.reminders = new Map();
        this.loaded = true;
        return;
      }
      throw reminderError('The reminders file could not be read.', 'REMINDER_IO_ERROR', error);
    }
    if (!serialized) throw reminderError('The reminders file is empty or corrupt.', 'REMINDER_CORRUPT_ERROR');
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch (error) {
      throw reminderError('The reminders file contains invalid JSON.', 'REMINDER_CORRUPT_ERROR', error);
    }
    this.reminders = validateDocument(parsed);
    this.loaded = true;
  }

  async add(text: string, dueAt: Date): Promise<Reminder> {
    await this.ensureLoaded();
    const normalizedText = text.trim();
    if (!normalizedText || normalizedText.length > REMINDER_MAX_TEXT_LENGTH) {
      throw reminderError(`Reminder text must contain 1-${REMINDER_MAX_TEXT_LENGTH} characters.`, 'REMINDER_CONFIGURATION_ERROR');
    }
    const dueTimestamp = toIsoTimestamp(dueAt);
    const now = this.now();
    const createdTimestamp = toIsoTimestamp(now);
    if (dueAt.getTime() <= now.getTime()) {
      throw reminderError('Reminder time must be in the future.', 'REMINDER_CONFIGURATION_ERROR');
    }
    if (this.reminders.size >= REMINDER_MAX_ENTRIES) {
      throw reminderError(`At most ${REMINDER_MAX_ENTRIES} reminders can be stored.`, 'REMINDER_LIMIT_ERROR');
    }

    let id: string | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = `r-${this.idFactory().replaceAll('-', '').slice(0, 8).toLowerCase()}`;
      if (isValidId(candidate) && !this.reminders.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw reminderError('A unique reminder ID could not be generated.', 'REMINDER_IO_ERROR');

    const reminder: Reminder = {
      id,
      text: normalizedText,
      dueAt: dueTimestamp,
      createdAt: createdTimestamp,
      status: 'pending',
    };
    this.reminders.set(id, reminder);
    try {
      await this.persist();
      return reminder;
    } catch (error) {
      this.reminders.delete(id);
      throw error;
    }
  }

  async list(): Promise<readonly Reminder[]> {
    await this.ensureLoaded();
    return Object.freeze([...this.reminders.values()].sort(compareReminders));
  }

  async listDue(now: Date = this.now()): Promise<readonly Reminder[]> {
    const nowTimestamp = toIsoTimestamp(now);
    return Object.freeze((await this.list()).filter(({ dueAt }) => dueAt <= nowTimestamp));
  }

  async delete(id: string): Promise<boolean> {
    if (!isValidId(id)) {
      throw reminderError('Reminder ID must use the format r- followed by eight hexadecimal characters.', 'REMINDER_CONFIGURATION_ERROR');
    }
    await this.ensureLoaded();
    const reminder = this.reminders.get(id);
    if (!reminder) return false;
    this.reminders.delete(id);
    try {
      await this.persist();
      return true;
    } catch (error) {
      this.reminders.set(id, reminder);
      throw error;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async persist(): Promise<void> {
    const document = {
      version: REMINDER_SCHEMA_VERSION,
      reminders: [...this.reminders.values()].sort(compareReminders),
    };
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const backupPath = `${this.filePath}.${randomUUID()}.bak`;
    let backedUp = false;
    let preserveBackup = false;
    try {
      await this.fileSystem.mkdir(dirname(this.filePath));
      await this.fileSystem.writeFile(temporaryPath, JSON.stringify(document, null, 2) + '\n');
      try {
        await this.fileSystem.rename(this.filePath, backupPath);
        backedUp = true;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      try {
        await this.fileSystem.rename(temporaryPath, this.filePath);
      } catch (error) {
        if (backedUp) {
          try {
            await this.fileSystem.rename(backupPath, this.filePath);
            backedUp = false;
          } catch {
            preserveBackup = true;
          }
        }
        throw error;
      }
      if (backedUp) {
        await this.fileSystem.rm(backupPath).catch(() => undefined);
        backedUp = false;
      }
    } catch (error) {
      throw error instanceof AssistantError
        ? error
        : reminderError('The reminders file could not be written safely.', 'REMINDER_IO_ERROR', error);
    } finally {
      await this.fileSystem.rm(temporaryPath).catch(() => undefined);
      if (!preserveBackup) await this.fileSystem.rm(backupPath).catch(() => undefined);
    }
  }
}

export type ReminderDateInput =
  | { readonly date: string; readonly time: string }
  | { readonly time: string };

function createLocalDate(year: number, month: number, day: number, hour: number, minute: number): Date | undefined {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return undefined;
  }
  const value = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day
    || value.getHours() !== hour || value.getMinutes() !== minute) return undefined;
  return value;
}

function parseTime(time: string): { readonly hour: number; readonly minute: number } | undefined {
  const match = /^(\d{2}):(\d{2})$/u.exec(time);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined;
}

export function parseReminderDueAt(input: ReminderDateInput, now: Date = new Date()): Date {
  if (Number.isNaN(now.getTime())) {
    throw reminderError('The current system time is unavailable.', 'REMINDER_CONFIGURATION_ERROR');
  }
  const parsedTime = parseTime(input.time);
  if (!parsedTime) throw reminderError('Use a valid 24-hour time such as 20:00.', 'REMINDER_CONFIGURATION_ERROR');

  let dueAt: Date | undefined;
  if ('date' in input) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(input.date);
    if (match) {
      dueAt = createLocalDate(Number(match[1]), Number(match[2]), Number(match[3]), parsedTime.hour, parsedTime.minute);
    }
    if (!dueAt) throw reminderError('Use a valid local date such as 2026-09-24.', 'REMINDER_CONFIGURATION_ERROR');
  } else {
    const base = now;
    for (let dayOffset = 0; dayOffset <= 370; dayOffset += 1) {
      const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset);
      const candidate = createLocalDate(date.getFullYear(), date.getMonth() + 1, date.getDate(), parsedTime.hour, parsedTime.minute);
      if (candidate && candidate.getTime() > now.getTime()) {
        dueAt = candidate;
        break;
      }
    }
    if (!dueAt) throw reminderError('The requested local time has no valid future occurrence.', 'REMINDER_CONFIGURATION_ERROR');
  }

  if (dueAt.getTime() <= now.getTime()) {
    throw reminderError('Reminder time must be in the future.', 'REMINDER_CONFIGURATION_ERROR');
  }
  return dueAt;
}

export function parseReminderCommand(command: string, now: Date = new Date()): { readonly text: string; readonly dueAt: Date } {
  const body = command.slice('/remind'.length).trim();
  const fullDate = /^(\S+)\s+(\S+)\s+(.+)$/u.exec(body);
  const timeOnly = /^(\S+)\s+(.+)$/u.exec(body);
  let input: ReminderDateInput | undefined;
  let text = '';
  if (fullDate && /^\d{4}-\d{2}-\d{2}$/u.test(fullDate[1] ?? '') && /^\d{2}:\d{2}$/u.test(fullDate[2] ?? '')) {
    input = { date: fullDate[1] ?? '', time: fullDate[2] ?? '' };
    text = fullDate[3] ?? '';
  } else if (timeOnly && /^\d{2}:\d{2}$/u.test(timeOnly[1] ?? '')) {
    input = { time: timeOnly[1] ?? '' };
    text = timeOnly[2] ?? '';
  }
  if (!input || !text.trim()) {
    throw reminderError('Uso: /remind <YYYY-MM-DD HH:mm> <texto> (o /remind HH:mm <texto>).', 'REMINDER_CONFIGURATION_ERROR');
  }
  return { dueAt: parseReminderDueAt(input, now), text: text.trim() };
}

export function formatReminderDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
}

export function formatDueReminderNotice(reminders: readonly Reminder[]): string {
  if (reminders.length === 0) return '';
  return [
    'Recordatorios pendientes:',
    ...reminders.map(({ id, text, dueAt }) => `[${id}] ${text} · ${formatReminderDate(dueAt)}`),
  ].join('\n');
}

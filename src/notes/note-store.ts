import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { AssistantError } from '../shared/errors.js';

export const NOTE_SCHEMA_VERSION = 1 as const;
export const NOTE_MAX_ENTRIES = 200 as const;
export const NOTE_MAX_TEXT_LENGTH = 2000 as const;
export const NOTE_PREVIEW_LENGTH = 80 as const;

export interface Note {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NoteFileSystem {
  readonly mkdir: (path: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
}

export interface NoteStoreOptions {
  readonly fileSystem?: NoteFileSystem;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

const defaultFileSystem: NoteFileSystem = {
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

function noteError(
  message: string,
  code: 'NOTE_CONFIGURATION_ERROR' | 'NOTE_CORRUPT_ERROR' | 'NOTE_LIMIT_ERROR' | 'NOTE_IO_ERROR' | 'NOTE_NOT_FOUND_ERROR',
  cause?: unknown,
): AssistantError {
  return new AssistantError(message, { code, retryable: false, cause });
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && /^n-[a-f0-9]{8}$/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function validateNote(value: unknown): Note {
  if (!isRecord(value)
    || !isValidId(value.id)
    || typeof value.text !== 'string'
    || value.text.trim().length === 0
    || countGraphemes(value.text) > NOTE_MAX_TEXT_LENGTH
    || !isCanonicalTimestamp(value.createdAt)
    || !isCanonicalTimestamp(value.updatedAt)
    || Object.keys(value).some((key) => !['id', 'text', 'createdAt', 'updatedAt'].includes(key))) {
    throw noteError('The notes file contains an invalid note.', 'NOTE_CORRUPT_ERROR');
  }
  return { id: value.id, text: value.text, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function validateDocument(value: unknown): Map<string, Note> {
  if (!isRecord(value) || value.version !== NOTE_SCHEMA_VERSION || !Array.isArray(value.notes)) {
    throw noteError('The notes file has an unsupported or invalid schema.', 'NOTE_CORRUPT_ERROR');
  }
  if (value.notes.length > NOTE_MAX_ENTRIES) {
    throw noteError('The notes file contains too many notes.', 'NOTE_LIMIT_ERROR');
  }
  if (Object.keys(value).some((key) => key !== 'version' && key !== 'notes')) {
    throw noteError('The notes file contains unsupported fields.', 'NOTE_CORRUPT_ERROR');
  }
  const result = new Map<string, Note>();
  for (const rawNote of value.notes) {
    const note = validateNote(rawNote);
    if (result.has(note.id)) throw noteError('The notes file contains duplicate IDs.', 'NOTE_CORRUPT_ERROR');
    result.set(note.id, note);
  }
  return result;
}

function compareNewestFirst(left: Note, right: Note): number {
  return right.updatedAt.localeCompare(left.updatedAt)
    || right.createdAt.localeCompare(left.createdAt)
    || left.id.localeCompare(right.id);
}

function toIsoTimestamp(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw noteError('A valid system date is required for a note.', 'NOTE_CONFIGURATION_ERROR');
  }
  return value.toISOString();
}

function countGraphemes(value: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length;
}

export function resolveNotesPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.YUKI_NOTES_PATH?.trim();
  return configured ? resolve(configured) : join(homedir(), '.waifu-assistant', 'notes.json');
}

export class NoteStore {
  private notes = new Map<string, Note>();
  private loaded = false;
  private readonly fileSystem: NoteFileSystem;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(public readonly filePath: string, options: NoteStoreOptions = {}) {
    if (!filePath.trim()) throw noteError('Notes path cannot be empty.', 'NOTE_CONFIGURATION_ERROR');
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
        this.notes = new Map();
        this.loaded = true;
        return;
      }
      throw noteError('The notes file could not be read.', 'NOTE_IO_ERROR', error);
    }
    if (!serialized) throw noteError('The notes file is empty or corrupt.', 'NOTE_CORRUPT_ERROR');
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch (error) {
      throw noteError('The notes file contains invalid JSON.', 'NOTE_CORRUPT_ERROR', error);
    }
    this.notes = validateDocument(parsed);
    this.loaded = true;
  }

  async add(text: string): Promise<Note> {
    await this.ensureLoaded();
    if (typeof text !== 'string') throw noteError('Note text must be a string.', 'NOTE_CONFIGURATION_ERROR');
    const normalized = text.trim();
    if (!normalized) throw noteError('Note text cannot be empty.', 'NOTE_CONFIGURATION_ERROR');
    if (countGraphemes(normalized) > NOTE_MAX_TEXT_LENGTH) {
      throw noteError(`Note text must be at most ${NOTE_MAX_TEXT_LENGTH} characters.`, 'NOTE_CONFIGURATION_ERROR');
    }
    if (this.notes.size >= NOTE_MAX_ENTRIES) {
      throw noteError(`At most ${NOTE_MAX_ENTRIES} notes can be stored.`, 'NOTE_LIMIT_ERROR');
    }

    let id: string | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = `n-${this.idFactory().replaceAll('-', '').slice(0, 8).toLowerCase()}`;
      if (isValidId(candidate) && !this.notes.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw noteError('A unique note ID could not be generated.', 'NOTE_IO_ERROR');
    const timestamp = toIsoTimestamp(this.now());
    const note: Note = { id, text: normalized, createdAt: timestamp, updatedAt: timestamp };
    this.notes.set(id, note);
    try {
      await this.persist();
      return note;
    } catch (error) {
      this.notes.delete(id);
      throw error;
    }
  }

  async list(): Promise<readonly Note[]> {
    await this.ensureLoaded();
    return Object.freeze([...this.notes.values()].sort(compareNewestFirst));
  }

  async show(id: string): Promise<Note> {
    validateNoteId(id);
    await this.ensureLoaded();
    const note = this.notes.get(id);
    if (!note) throw noteError(`Note ${id} was not found.`, 'NOTE_NOT_FOUND_ERROR');
    return Object.freeze({ ...note });
  }

  async delete(id: string): Promise<boolean> {
    validateNoteId(id);
    await this.ensureLoaded();
    const note = this.notes.get(id);
    if (!note) return false;
    this.notes.delete(id);
    try {
      await this.persist();
      return true;
    } catch (error) {
      this.notes.set(id, note);
      throw error;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async persist(): Promise<void> {
    const document = { version: NOTE_SCHEMA_VERSION, notes: [...this.notes.values()].sort(compareNewestFirst) };
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
        : noteError('The notes file could not be written safely.', 'NOTE_IO_ERROR', error);
    } finally {
      await this.fileSystem.rm(temporaryPath).catch(() => undefined);
      if (!preserveBackup) await this.fileSystem.rm(backupPath).catch(() => undefined);
    }
  }
}

function validateNoteId(id: string): void {
  if (!isValidId(id)) throw noteError('Note ID must use the format n- followed by eight hexadecimal characters.', 'NOTE_CONFIGURATION_ERROR');
}

export function formatNotePreview(text: string, maxLength: number = NOTE_PREVIEW_LENGTH): string {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw noteError('Preview length must be a positive integer.', 'NOTE_CONFIGURATION_ERROR');
  }
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
  if (segments.length <= maxLength) return text;
  return `${segments.slice(0, maxLength).map(({ segment }) => segment).join('')}…`;
}

export function formatNoteList(notes: readonly Note[]): string {
  if (notes.length === 0) return 'No hay notas guardadas.';
  return [
    'Notas guardadas:',
    ...notes.map((note) => `[${note.id}] ${formatNoteDate(note.updatedAt)} | ${formatNotePreview(note.text)}`),
  ].join('\n');
}

export function formatNoteDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
}

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { AssistantError } from '../shared/errors.js';
import { DEFAULT_CONVERSATION_TITLE, normalizeConversationTitle } from './conversation-title.js';

export const SAVED_SESSION_SCHEMA_VERSION = 1 as const;
export const SAVED_SESSION_MAX_ENTRIES = 50 as const;
export const SAVED_SESSION_MAX_MESSAGES = 200 as const;
export const SAVED_SESSION_MAX_CONTENT_LENGTH = 20_000 as const;
export const SAVED_SESSION_MAX_NAME_LENGTH = 64 as const;

export type SavedSessionRole = 'user' | 'assistant';

export interface SavedSessionMessage {
  readonly role: SavedSessionRole;
  readonly content: string;
}

export interface SavedSessionSnapshot {
  readonly savedAt: string;
  readonly title?: string;
  readonly messages: readonly SavedSessionMessage[];
}

export interface SavedSessionSummary {
  readonly name: string;
  readonly title: string;
  readonly messageCount: number;
  readonly savedAt: string;
}

export interface SavedSessionFileSystem {
  readonly mkdir: (path: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
}

const defaultFileSystem: SavedSessionFileSystem = {
  mkdir: async (path) => { await mkdir(path, { recursive: true }); },
  readFile: async (path) => readFile(path, 'utf8'),
  writeFile: async (path, data) => { await writeFile(path, data, 'utf8'); },
  rename,
  rm: async (path) => { await rm(path, { force: true }); },
};

interface PersistedSavedSession {
  readonly savedAt: unknown;
  readonly title?: unknown;
  readonly messages: unknown;
}

interface PersistedSavedSessions {
  readonly version: unknown;
  readonly sessions: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function sessionError(
  message: string,
  code: 'SESSION_CONFIGURATION_ERROR' | 'SESSION_CORRUPT_ERROR' | 'SESSION_LIMIT_ERROR' | 'SESSION_IO_ERROR',
  cause?: unknown,
): AssistantError {
  return new AssistantError(message, { code, retryable: false, cause });
}

function isValidName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) && name.length <= SAVED_SESSION_MAX_NAME_LENGTH;
}

export function validateSavedSessionName(name: string): void {
  if (!isValidName(name)) {
    throw sessionError('Session names must contain only letters, numbers, underscore or hyphen and be 1-64 characters.', 'SESSION_CONFIGURATION_ERROR');
  }
}

function validatePersistedMessage(value: unknown): SavedSessionMessage {
  if (!isRecord(value)
    || (value.role !== 'user' && value.role !== 'assistant')
    || typeof value.content !== 'string'
    || value.content.length < 1
    || value.content.length > SAVED_SESSION_MAX_CONTENT_LENGTH
    || Object.keys(value).some((key) => key !== 'role' && key !== 'content')) {
    throw sessionError('The saved session contains an invalid message.', 'SESSION_CORRUPT_ERROR');
  }
  return { role: value.role, content: value.content };
}

function validateMessages(value: unknown): SavedSessionMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SAVED_SESSION_MAX_MESSAGES) {
    throw sessionError('The saved session has an invalid message count.', 'SESSION_CORRUPT_ERROR');
  }
  return value.map(validatePersistedMessage);
}

function validateSnapshot(value: unknown): SavedSessionSnapshot {
  if (!isRecord(value)
    || typeof value.savedAt !== 'string'
    || Number.isNaN(Date.parse(value.savedAt))
    || Object.keys(value).some((key) => key !== 'savedAt' && key !== 'messages' && key !== 'title')) {
    throw sessionError('The saved session metadata is invalid.', 'SESSION_CORRUPT_ERROR');
  }
  let title: string | undefined;
  if (typeof value.title === 'string') {
    try { title = normalizeConversationTitle(value.title); } catch { title = undefined; }
  }
  return {
    savedAt: value.savedAt,
    ...(title === undefined ? {} : { title }),
    messages: Object.freeze(validateMessages(value.messages)),
  };
}

function validateDocument(value: unknown): Map<string, SavedSessionSnapshot> {
  if (!isRecord(value) || value.version !== SAVED_SESSION_SCHEMA_VERSION || !isRecord(value.sessions)) {
    throw sessionError('The saved sessions file has an unsupported or invalid schema.', 'SESSION_CORRUPT_ERROR');
  }
  const names = Object.keys(value.sessions);
  if (names.length > SAVED_SESSION_MAX_ENTRIES) {
    throw sessionError('The saved sessions file contains too many sessions.', 'SESSION_LIMIT_ERROR');
  }
  const result = new Map<string, SavedSessionSnapshot>();
  for (const name of names) {
    if (!isValidName(name)) {
      throw sessionError('The saved sessions file contains an invalid session name.', 'SESSION_CORRUPT_ERROR');
    }
    result.set(name, validateSnapshot(value.sessions[name]));
  }
  return result;
}

export function resolveSavedSessionPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.YUKI_SESSIONS_PATH?.trim();
  return configured ? resolve(configured) : join(homedir(), '.waifu-assistant', 'sessions.json');
}

export class SavedSessionStore {
  private sessions = new Map<string, SavedSessionSnapshot>();
  private loaded = false;
  private readonly fileSystem: SavedSessionFileSystem;

  constructor(
    public readonly filePath: string,
    fileSystem: SavedSessionFileSystem = defaultFileSystem,
  ) {
    if (!filePath.trim()) {
      throw sessionError('Saved session path cannot be empty.', 'SESSION_CONFIGURATION_ERROR');
    }
    this.fileSystem = fileSystem;
  }

  async load(): Promise<void> {
    let serialized: string;
    try {
      serialized = await this.fileSystem.readFile(this.filePath);
    } catch (error) {
      if (isMissing(error)) {
        this.sessions = new Map();
        this.loaded = true;
        return;
      }
      throw sessionError('The saved sessions file could not be read.', 'SESSION_IO_ERROR', error);
    }
    if (!serialized) throw sessionError('The saved sessions file is empty or corrupt.', 'SESSION_CORRUPT_ERROR');
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch (error) {
      throw sessionError('The saved sessions file contains invalid JSON.', 'SESSION_CORRUPT_ERROR', error);
    }
    this.sessions = validateDocument(parsed);
    this.loaded = true;
  }

  async list(): Promise<readonly string[]> {
    await this.ensureLoaded();
    return Object.freeze([...this.sessions.keys()].sort((left, right) => left.localeCompare(right)));
  }

  async listSummaries(): Promise<readonly SavedSessionSummary[]> {
    await this.ensureLoaded();
    return Object.freeze([...this.sessions.entries()]
      .map(([name, snapshot]) => Object.freeze({
        name,
        title: snapshot.title ?? DEFAULT_CONVERSATION_TITLE,
        messageCount: snapshot.messages.length,
        savedAt: snapshot.savedAt,
      }))
      .sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt)
        || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)));
  }

  async count(): Promise<number> {
    await this.ensureLoaded();
    return this.sessions.size;
  }

  async get(name: string): Promise<SavedSessionSnapshot | undefined> {
    validateSavedSessionName(name);
    await this.ensureLoaded();
    const snapshot = this.sessions.get(name);
    return snapshot ? Object.freeze({
      savedAt: snapshot.savedAt,
      ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
      messages: Object.freeze([...snapshot.messages]),
    }) : undefined;
  }

  async save(
    name: string,
    messages: readonly Readonly<{ readonly role: string; readonly content: string }>[],
    title?: string,
  ): Promise<void> {
    validateSavedSessionName(name);
    const normalizedTitle = title === undefined ? undefined : normalizeConversationTitle(title);
    await this.ensureLoaded();
    const normalized = this.normalizeMessages(messages);
    if (!this.sessions.has(name) && this.sessions.size >= SAVED_SESSION_MAX_ENTRIES) {
      throw sessionError('The saved session limit has been reached.', 'SESSION_LIMIT_ERROR');
    }
    const previous = new Map(this.sessions);
    const titleToPersist = normalizedTitle ?? this.sessions.get(name)?.title;
    this.sessions.set(name, {
      savedAt: new Date().toISOString(),
      ...(titleToPersist === undefined ? {} : { title: titleToPersist }),
      messages: Object.freeze(normalized),
    });
    try {
      await this.persist();
    } catch (error) {
      this.sessions = previous;
      throw error;
    }
  }

  async renameTitle(name: string, title: string): Promise<boolean> {
    validateSavedSessionName(name);
    const normalizedTitle = normalizeConversationTitle(title);
    await this.ensureLoaded();
    const existing = this.sessions.get(name);
    if (!existing) return false;
    const previous = new Map(this.sessions);
    this.sessions.set(name, { ...existing, title: normalizedTitle, savedAt: new Date().toISOString() });
    try {
      await this.persist();
      return true;
    } catch (error) {
      this.sessions = previous;
      throw error;
    }
  }

  async delete(name: string): Promise<boolean> {
    validateSavedSessionName(name);
    await this.ensureLoaded();
    if (!this.sessions.has(name)) return false;
    const previous = new Map(this.sessions);
    this.sessions.delete(name);
    try {
      await this.persist();
      return true;
    } catch (error) {
      this.sessions = previous;
      throw error;
    }
  }

  private normalizeMessages(messages: readonly Readonly<{ readonly role: string; readonly content: string }>[]): SavedSessionMessage[] {
    if (messages.length === 0 || messages.length > SAVED_SESSION_MAX_MESSAGES) {
      throw sessionError('The session must contain 1-200 messages.', 'SESSION_LIMIT_ERROR');
    }
    return messages.map((message) => {
      if ((message.role !== 'user' && message.role !== 'assistant')
        || typeof message.content !== 'string'
        || message.content.length < 1
        || message.content.length > SAVED_SESSION_MAX_CONTENT_LENGTH) {
        throw sessionError('The session contains a message that cannot be saved.', 'SESSION_CONFIGURATION_ERROR');
      }
      return { role: message.role, content: message.content };
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async persist(): Promise<void> {
    const sessions: Record<string, PersistedSavedSession> = {};
    for (const name of [...this.sessions.keys()].sort((left, right) => left.localeCompare(right))) {
      const snapshot = this.sessions.get(name);
      if (snapshot) sessions[name] = snapshot;
    }
    const document: PersistedSavedSessions = { version: SAVED_SESSION_SCHEMA_VERSION, sessions };
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const backupPath = `${this.filePath}.${randomUUID()}.bak`;
    let backedUp = false;
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
        if (backedUp) await this.fileSystem.rename(backupPath, this.filePath).catch(() => undefined);
        throw error;
      }
      if (backedUp) await this.fileSystem.rm(backupPath);
    } catch (error) {
      throw error instanceof AssistantError
        ? error
        : sessionError('The saved sessions file could not be written safely.', 'SESSION_IO_ERROR', error);
    } finally {
      await this.fileSystem.rm(temporaryPath).catch(() => undefined);
      await this.fileSystem.rm(backupPath).catch(() => undefined);
    }
  }
}

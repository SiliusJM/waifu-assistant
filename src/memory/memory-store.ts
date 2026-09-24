import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { AssistantError } from '../shared/errors.js';
import {
  MEMORY_MAX_ENTRIES,
  MEMORY_MAX_KEY_LENGTH,
  MEMORY_MAX_VALUE_LENGTH,
  MEMORY_SCHEMA_VERSION,
  type MemoryEntry,
  type MemorySnapshot,
} from './memory-types.js';

export interface MemoryFileSystem {
  readonly mkdir: (path: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
}

const defaultFileSystem: MemoryFileSystem = {
  mkdir: async (path) => { await mkdir(path, { recursive: true }); },
  readFile: async (path) => readFile(path, 'utf8'),
  writeFile: async (path, data) => { await writeFile(path, data, 'utf8'); },
  rename,
  rm: async (path) => { await rm(path, { force: true }); },
};

interface PersistedMemory {
  readonly version: number;
  readonly entries: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function memoryError(
  message: string,
  code: 'MEMORY_CONFIGURATION_ERROR' | 'MEMORY_CORRUPT_ERROR' | 'MEMORY_LIMIT_ERROR' | 'MEMORY_IO_ERROR',
  cause?: unknown,
): AssistantError {
  return new AssistantError(message, { code, retryable: false, cause });
}

export function validateMemoryKey(key: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key) || key.length > MEMORY_MAX_KEY_LENGTH) {
    throw memoryError('Memory keys must contain only letters, numbers, underscore or hyphen and be 1-64 characters.', 'MEMORY_CONFIGURATION_ERROR');
  }
}

export function validateMemoryValue(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > MEMORY_MAX_VALUE_LENGTH) {
    throw memoryError('Memory values must be non-empty strings of at most 1000 characters.', 'MEMORY_CONFIGURATION_ERROR');
  }
}

function isValidMemoryKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(key) && key.length <= MEMORY_MAX_KEY_LENGTH;
}

function isValidMemoryValue(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MEMORY_MAX_VALUE_LENGTH;
}

function validateEntries(entries: unknown): Map<string, string> {
  if (!isRecord(entries)) {
    throw memoryError('The memory file has an invalid entries object.', 'MEMORY_CORRUPT_ERROR');
  }
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(entries)) {
    if (!isValidMemoryKey(key)) {
      throw memoryError('The memory file contains an invalid key.', 'MEMORY_CORRUPT_ERROR');
    }
    if (!isValidMemoryValue(value)) {
      throw memoryError('The memory file contains an invalid value.', 'MEMORY_CORRUPT_ERROR');
    }
    result.set(key, value);
  }
  if (result.size > MEMORY_MAX_ENTRIES) {
    throw memoryError('The memory file contains too many entries.', 'MEMORY_LIMIT_ERROR');
  }
  return result;
}

function validateDocument(value: unknown): Map<string, string> {
  if (!isRecord(value) || value.version !== MEMORY_SCHEMA_VERSION) {
    throw memoryError('The memory file has an unsupported schema version.', 'MEMORY_CORRUPT_ERROR');
  }
  return validateEntries(value.entries);
}

function sortedEntries(entries: Map<string, string>): MemoryEntry[] {
  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }));
}

export function resolveMemoryPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.YUKI_MEMORY_PATH?.trim();
  return configured ? resolve(configured) : join(homedir(), '.waifu-assistant', 'memory.json');
}

export class PersistentMemoryStore {
  private entries = new Map<string, string>();
  private loaded = false;
  private readonly fileSystem: MemoryFileSystem;

  constructor(
    public readonly filePath: string,
    fileSystem: MemoryFileSystem = defaultFileSystem,
  ) {
    if (!filePath.trim()) {
      throw memoryError('Memory path cannot be empty.', 'MEMORY_CONFIGURATION_ERROR');
    }
    this.fileSystem = fileSystem;
  }

  async load(): Promise<void> {
    let serialized: string;
    try {
      serialized = await this.fileSystem.readFile(this.filePath);
    } catch (error) {
      if (isMissing(error)) {
        this.entries = new Map();
        this.loaded = true;
        return;
      }
      throw memoryError('The memory file could not be read.', 'MEMORY_IO_ERROR', error);
    }
    if (!serialized) {
      throw memoryError('The memory file is empty or corrupt.', 'MEMORY_CORRUPT_ERROR');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch (error) {
      throw memoryError('The memory file contains invalid JSON.', 'MEMORY_CORRUPT_ERROR', error);
    }
    this.entries = validateDocument(parsed);
    this.loaded = true;
  }

  async list(): Promise<readonly MemoryEntry[]> {
    await this.ensureLoaded();
    return Object.freeze(sortedEntries(this.entries));
  }

  async get(key: string): Promise<string | undefined> {
    validateMemoryKey(key);
    await this.ensureLoaded();
    return this.entries.get(key);
  }

  async count(): Promise<number> {
    await this.ensureLoaded();
    return this.entries.size;
  }

  async snapshot(): Promise<MemorySnapshot> {
    return Object.freeze({
      version: MEMORY_SCHEMA_VERSION,
      entries: await this.list(),
    });
  }

  async set(key: string, value: string): Promise<void> {
    validateMemoryKey(key);
    validateMemoryValue(value);
    await this.ensureLoaded();
    if (!this.entries.has(key) && this.entries.size >= MEMORY_MAX_ENTRIES) {
      throw memoryError('The memory entry limit has been reached.', 'MEMORY_LIMIT_ERROR');
    }
    const previous = new Map(this.entries);
    this.entries.set(key, value);
    try {
      await this.persist();
    } catch (error) {
      this.entries = previous;
      throw error;
    }
  }

  /** Creates a new entry without replacing an existing value. */
  async remember(key: string, value: string): Promise<'created' | 'exists'> {
    validateMemoryKey(key);
    validateMemoryValue(value);
    // Re-read the persisted document at confirmation time to avoid acting on a stale snapshot.
    await this.load();
    if (this.entries.has(key)) return 'exists';
    if (this.entries.size >= MEMORY_MAX_ENTRIES) {
      throw memoryError('The memory entry limit has been reached.', 'MEMORY_LIMIT_ERROR');
    }
    const previous = new Map(this.entries);
    this.entries.set(key, value);
    try {
      await this.persist();
      return 'created';
    } catch (error) {
      this.entries = previous;
      throw error;
    }
  }

  /** Updates an existing entry only when its current value still matches the caller's snapshot. */
  async update(key: string, value: string, expectedOldValue: string): Promise<'updated' | 'unchanged' | 'missing' | 'conflict'> {
    validateMemoryKey(key);
    validateMemoryValue(value);
    validateMemoryValue(expectedOldValue);
    // Refresh persisted state so an update from another store instance is not silently overwritten.
    await this.load();
    const current = this.entries.get(key);
    if (current === undefined) return 'missing';
    if (current !== expectedOldValue) return 'conflict';
    if (current === value) return 'unchanged';

    const previous = new Map(this.entries);
    this.entries.set(key, value);
    try {
      await this.persist();
      return 'updated';
    } catch (error) {
      this.entries = previous;
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    validateMemoryKey(key);
    await this.ensureLoaded();
    if (!this.entries.has(key)) return false;
    const previous = new Map(this.entries);
    this.entries.delete(key);
    try {
      await this.persist();
      return true;
    } catch (error) {
      this.entries = previous;
      throw error;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async persist(): Promise<void> {
    const document: PersistedMemory = {
      version: MEMORY_SCHEMA_VERSION,
      entries: Object.fromEntries(sortedEntries(this.entries).map(({ key, value }) => [key, value])),
    };
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await this.fileSystem.mkdir(dirname(this.filePath));
      await this.fileSystem.writeFile(temporaryPath, JSON.stringify(document, null, 2) + '\n');
      await this.replaceFile(temporaryPath);
    } catch (error) {
      throw error instanceof AssistantError
        ? error
        : memoryError('The memory file could not be written.', 'MEMORY_IO_ERROR', error);
    } finally {
      await this.fileSystem.rm(temporaryPath).catch(() => undefined);
    }
  }

  private async replaceFile(temporaryPath: string): Promise<void> {
    const backupPath = `${this.filePath}.${randomUUID()}.bak`;
    let backedUp = false;
    try {
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
      throw memoryError('The memory file could not be replaced safely.', 'MEMORY_IO_ERROR', error);
    }
  }
}

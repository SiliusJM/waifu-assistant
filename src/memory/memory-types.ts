export const MEMORY_SCHEMA_VERSION = 1 as const;
export const MEMORY_MAX_ENTRIES = 100 as const;
export const MEMORY_MAX_KEY_LENGTH = 64 as const;
export const MEMORY_MAX_VALUE_LENGTH = 1000 as const;

export interface MemoryEntry {
  readonly key: string;
  readonly value: string;
}

export interface MemorySnapshot {
  readonly version: typeof MEMORY_SCHEMA_VERSION;
  readonly entries: readonly MemoryEntry[];
}

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { AssistantError } from '../shared/errors.js';

export const PENDING_ACTION_SCHEMA_VERSION = 1 as const;
export const PENDING_ACTION_MAX_ENTRIES = 100 as const;
export const PENDING_ACTION_MAX_DOCUMENT_BYTES = 512 * 1024;
export const PENDING_ACTION_MAX_PAYLOAD_BYTES = 4096 as const;
export const PENDING_ACTION_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const PENDING_ACTION_STATES = [
  'prepared', 'awaiting_confirmation', 'confirmed', 'executing',
  'reconciliation_required', 'completed', 'cancelled', 'discarded', 'failed',
] as const;

export type PendingActionState = (typeof PENDING_ACTION_STATES)[number];
export type PendingActionType = 'local.reminder.create';

export interface PendingReminderPayload {
  readonly text: string;
  readonly dueAt: string;
}

export interface PendingAction {
  readonly id: string;
  readonly type: PendingActionType;
  readonly state: PendingActionState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly payload: PendingReminderPayload;
  readonly idempotencyKey: string;
  readonly remoteId?: string;
}

export interface PendingActionFileHandle {
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface PendingActionFileSystem {
  mkdir(path: string, mode: number): Promise<void>;
  stat(path: string): Promise<{ readonly size: number }>;
  readFile(path: string): Promise<string>;
  open(path: string, flags: string, mode: number): Promise<PendingActionFileHandle>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
}

export interface PendingActionJournalOptions {
  readonly fileSystem?: PendingActionFileSystem;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export type PendingActionLoadResult =
  | { readonly status: 'ready'; readonly actions: readonly PendingAction[]; readonly recoveredExecutingCount: number; readonly recoveryPersisted: boolean }
  | { readonly status: 'corrupt' | 'unsupported-version' | 'io-error'; readonly actions: readonly []; readonly recoveredExecutingCount: 0 };

const defaultFileSystem: PendingActionFileSystem = {
  mkdir: async (path, mode) => { await mkdir(path, { recursive: true, mode }); },
  stat: async (path) => stat(path),
  readFile: async (path) => readFile(path, 'utf8'),
  open: async (path, flags, mode) => open(path, flags, mode),
  rename,
  rm: async (path) => { await rm(path, { force: true }); },
};

type LoadFailure = Extract<PendingActionLoadResult, { status: 'corrupt' | 'unsupported-version' | 'io-error' }>['status'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function actionError(message: string, cause?: unknown): AssistantError {
  return new AssistantError(message, { code: 'PENDING_ACTION_ERROR', retryable: false, ...(cause === undefined ? {} : { cause }) });
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isActionId(value: unknown): value is string {
  return typeof value === 'string' && /^pa-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function validatePayload(value: unknown): PendingReminderPayload {
  if (!isRecord(value)
    || Object.keys(value).some((key) => key !== 'text' && key !== 'dueAt')
    || typeof value.text !== 'string'
    || value.text.trim().length === 0
    || value.text.length > 500
    || containsControlCharacters(value.text)
    || !timestamp(value.dueAt)
    || /\b(?:api[_ -]?key|authorization|bearer|password|passwd|secret|token)\s*[:=]\s*\S+/iu.test(value.text)
    || /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/u.test(value.text)) {
    throw actionError('The pending action payload is invalid or may contain a secret.');
  }
  return Object.freeze({ text: value.text.trim(), dueAt: value.dueAt });
}

function validateAction(value: unknown): PendingAction {
  const allowedKeys = ['id', 'type', 'state', 'createdAt', 'updatedAt', 'payload', 'idempotencyKey', 'remoteId'];
  if (!isRecord(value)
    || Object.keys(value).some((key) => !allowedKeys.includes(key))
    || !isActionId(value.id)
    || value.type !== 'local.reminder.create'
    || !PENDING_ACTION_STATES.includes(value.state as PendingActionState)
    || !timestamp(value.createdAt)
    || !timestamp(value.updatedAt)
    || value.updatedAt < value.createdAt
    || !isUuid(value.idempotencyKey)
    || (value.remoteId !== undefined && (typeof value.remoteId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/u.test(value.remoteId)))) {
    throw actionError('The pending action journal contains an invalid action.');
  }
  const payload = validatePayload(value.payload);
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > PENDING_ACTION_MAX_PAYLOAD_BYTES) {
    throw actionError('The pending action payload exceeds its size limit.');
  }
  return Object.freeze({
    id: value.id,
    type: value.type,
    state: value.state as PendingActionState,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    payload,
    idempotencyKey: value.idempotencyKey,
    ...(value.remoteId === undefined ? {} : { remoteId: value.remoteId as string }),
  });
}

function cloneAction(action: PendingAction): PendingAction {
  return Object.freeze({ ...action, payload: Object.freeze({ ...action.payload }) });
}

function isTerminal(state: PendingActionState): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'discarded' || state === 'failed';
}

function isRecoverable(state: PendingActionState): boolean {
  return state === 'prepared' || state === 'awaiting_confirmation' || state === 'confirmed' || state === 'reconciliation_required';
}

function validateDocument(value: unknown): Map<string, PendingAction> {
  if (!isRecord(value) || value.version !== PENDING_ACTION_SCHEMA_VERSION) {
    throw actionError('Unsupported journal version.');
  }
  if (Object.keys(value).some((key) => key !== 'version' && key !== 'actions') || !Array.isArray(value.actions)) {
    throw actionError('The pending action journal document is invalid.');
  }
  if (value.actions.length > PENDING_ACTION_MAX_ENTRIES) throw actionError('The pending action journal exceeds its action limit.');
  const actions = new Map<string, PendingAction>();
  for (const rawAction of value.actions) {
    const action = validateAction(rawAction);
    if (actions.has(action.id)) throw actionError('The pending action journal contains duplicate IDs.');
    actions.set(action.id, action);
  }
  return actions;
}

function repositoryRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const workingDirectory = resolve(process.cwd());
  if (isWithin(workingDirectory, moduleDirectory)) return workingDirectory;
  return resolve(moduleDirectory, '..', '..');
}

function isWithin(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

export function resolvePendingActionsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.YUKI_PENDING_ACTIONS_PATH?.trim();
  const path = configured ? resolve(configured) : join(homedir(), '.waifu-assistant', 'pending-actions.json');
  if (configured && !isAbsolute(configured)) throw actionError('YUKI_PENDING_ACTIONS_PATH must be absolute.');
  if (isWithin(repositoryRoot(), path)) throw actionError('The pending action journal must be outside the repository.');
  return path;
}

const allowedTransitions: Readonly<Record<PendingActionState, readonly PendingActionState[]>> = {
  prepared: ['awaiting_confirmation', 'cancelled', 'discarded', 'failed'],
  awaiting_confirmation: ['prepared', 'confirmed', 'cancelled', 'discarded', 'failed'],
  confirmed: ['executing', 'cancelled', 'discarded', 'failed'],
  executing: ['completed', 'failed'],
  reconciliation_required: ['completed', 'failed'],
  completed: [],
  cancelled: [],
  discarded: [],
  failed: [],
};

export class PendingActionJournal {
  private actions = new Map<string, PendingAction>();
  private loaded = false;
  private loadFailure: LoadFailure | undefined;
  private readonly fileSystem: PendingActionFileSystem;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(public readonly filePath: string, options: PendingActionJournalOptions = {}) {
    if (!filePath.trim() || !isAbsolute(filePath) || isWithin(repositoryRoot(), resolve(filePath))) {
      throw actionError('The pending action journal path must be absolute and outside the repository.');
    }
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async load(): Promise<PendingActionLoadResult> {
    return this.serialized(async () => this.loadUnlocked());
  }

  async create(input: { readonly type: PendingActionType; readonly payload: PendingReminderPayload }): Promise<PendingAction> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      const payload = validatePayload(input.payload);
      if (input.type !== 'local.reminder.create') throw actionError('The pending action type is not allowlisted.');
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > PENDING_ACTION_MAX_PAYLOAD_BYTES) {
        throw actionError('The pending action payload exceeds its size limit.');
      }
      const id = `pa-${this.idFactory()}`;
      if (!isActionId(id) || this.actions.has(id)) throw actionError('A unique pending action ID could not be created.');
      const now = this.isoNow();
      const action: PendingAction = Object.freeze({
        id,
        type: input.type,
        state: 'prepared',
        createdAt: now,
        updatedAt: now,
        payload,
        idempotencyKey: this.idFactory(),
      });
      if (!isUuid(action.idempotencyKey)) throw actionError('A valid idempotency key could not be created.');
      const next = new Map(this.actions);
      this.pruneTerminal(next);
      if (next.size >= PENDING_ACTION_MAX_ENTRIES) throw actionError('The pending action journal is full.');
      next.set(action.id, action);
      await this.persistAndReplace(next);
      return cloneAction(action);
    });
  }

  async list(): Promise<readonly PendingAction[]> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      return Object.freeze([...this.actions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(cloneAction));
    });
  }

  async listRecoverable(): Promise<readonly PendingAction[]> {
    return (await this.list()).filter(({ state }) => isRecoverable(state));
  }

  async get(id: string): Promise<PendingAction | undefined> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      const action = this.actions.get(id);
      return action ? cloneAction(action) : undefined;
    });
  }

  async transition(id: string, nextState: PendingActionState): Promise<PendingAction> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      if (this.actions.get(id)?.state === 'reconciliation_required') {
        throw actionError('A reconciliation outcome must be resolved explicitly.');
      }
      return this.transitionUnlocked(id, nextState);
    });
  }

  async defer(id: string): Promise<PendingAction> { return this.transition(id, 'prepared'); }
  async confirm(id: string): Promise<PendingAction> { return this.transition(id, 'confirmed'); }
  async beginExecution(id: string): Promise<PendingAction> { return this.transition(id, 'executing'); }
  async complete(id: string): Promise<PendingAction> { return this.transition(id, 'completed'); }
  async cancel(id: string): Promise<PendingAction> { return this.transition(id, 'cancelled'); }
  async discard(id: string): Promise<PendingAction> { return this.transition(id, 'discarded'); }
  async fail(id: string): Promise<PendingAction> { return this.transition(id, 'failed'); }

  async resolveReconciliation(id: string, outcome: 'completed' | 'failed'): Promise<PendingAction> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      if (this.actions.get(id)?.state !== 'reconciliation_required') throw actionError('This action does not require reconciliation.');
      // The caller must reconcile the external outcome first. This method never retries or executes an action.
      return this.transitionUnlocked(id, outcome);
    });
  }

  private async transitionUnlocked(id: string, nextState: PendingActionState): Promise<PendingAction> {
    const current = this.actions.get(id);
    if (!current) throw actionError('The pending action does not exist.');
    if (!allowedTransitions[current.state].includes(nextState)) throw actionError(`Invalid pending action transition: ${current.state} -> ${nextState}.`);
    const updated: PendingAction = Object.freeze({ ...current, state: nextState, updatedAt: this.isoNow() });
    const next = new Map(this.actions);
    next.set(id, updated);
    await this.persistAndReplace(next);
    return cloneAction(updated);
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.loadUnlocked();
    if (this.loadFailure) throw actionError(`Pending action journal is unavailable (${this.loadFailure}).`);
  }

  private async loadUnlocked(): Promise<PendingActionLoadResult> {
    let size: number;
    try {
      ({ size } = await this.fileSystem.stat(this.filePath));
    } catch (error) {
      if (isMissing(error)) {
        this.actions = new Map();
        this.loaded = true;
        this.loadFailure = undefined;
        return { status: 'ready', actions: Object.freeze([]), recoveredExecutingCount: 0, recoveryPersisted: true };
      }
      this.loaded = true;
      this.loadFailure = 'io-error';
      return { status: 'io-error', actions: Object.freeze([]), recoveredExecutingCount: 0 };
    }
    if (size <= 0 || size > PENDING_ACTION_MAX_DOCUMENT_BYTES) {
      this.loaded = true;
      this.loadFailure = 'corrupt';
      return { status: 'corrupt', actions: Object.freeze([]), recoveredExecutingCount: 0 };
    }
    let serialized: string;
    try { serialized = await this.fileSystem.readFile(this.filePath); } catch {
      this.loaded = true;
      this.loadFailure = 'io-error';
      return { status: 'io-error', actions: Object.freeze([]), recoveredExecutingCount: 0 };
    }
    if (Buffer.byteLength(serialized, 'utf8') > PENDING_ACTION_MAX_DOCUMENT_BYTES) {
      this.loaded = true;
      this.loadFailure = 'corrupt';
      return { status: 'corrupt', actions: Object.freeze([]), recoveredExecutingCount: 0 };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(serialized) as unknown; } catch {
      this.loaded = true;
      this.loadFailure = 'corrupt';
      return { status: 'corrupt', actions: Object.freeze([]), recoveredExecutingCount: 0 };
    }
    if (isRecord(parsed) && parsed.version !== PENDING_ACTION_SCHEMA_VERSION) {
      this.loaded = true;
      this.loadFailure = 'unsupported-version';
      return { status: 'unsupported-version', actions: Object.freeze([]), recoveredExecutingCount: 0 };
    }
    let loadedActions: Map<string, PendingAction>;
    try { loadedActions = validateDocument(parsed); } catch {
      this.loaded = true;
      this.loadFailure = 'corrupt';
      return { status: 'corrupt', actions: Object.freeze([]), recoveredExecutingCount: 0 };
    }
    const now = this.isoNow();
    let recoveredExecutingCount = 0;
    const recovered = new Map<string, PendingAction>();
    for (const [id, action] of loadedActions) {
      if (action.state === 'executing') {
        recoveredExecutingCount += 1;
        recovered.set(id, Object.freeze({ ...action, state: 'reconciliation_required', updatedAt: now }));
      } else {
        recovered.set(id, cloneAction(action));
      }
    }
    this.pruneTerminal(recovered, new Date(now).getTime());
    const changed = recoveredExecutingCount > 0 || recovered.size !== loadedActions.size;
    this.actions = recovered;
    this.loaded = true;
    this.loadFailure = undefined;
    let recoveryPersisted = true;
    if (changed) {
      try { await this.persist(recovered); } catch { recoveryPersisted = false; }
    }
    return {
      status: 'ready',
      actions: Object.freeze([...recovered.values()].map(cloneAction)),
      recoveredExecutingCount,
      recoveryPersisted,
    };
  }

  private pruneTerminal(actions: Map<string, PendingAction>, now = this.now().getTime()): void {
    for (const [id, action] of actions) {
      if (isTerminal(action.state) && now - new Date(action.updatedAt).getTime() > PENDING_ACTION_TERMINAL_RETENTION_MS) actions.delete(id);
    }
  }

  private isoNow(): string {
    const date = this.now();
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw actionError('A valid current time is required.');
    return date.toISOString();
  }

  private async persistAndReplace(next: Map<string, PendingAction>): Promise<void> {
    try {
      await this.persist(next);
      this.actions = next;
    } catch (error) {
      throw actionError('The pending action journal could not be saved atomically.', error);
    }
  }

  private async persist(actions: Map<string, PendingAction>): Promise<void> {
    const document = JSON.stringify({ version: PENDING_ACTION_SCHEMA_VERSION, actions: [...actions.values()] }, null, 2) + '\n';
    if (Buffer.byteLength(document, 'utf8') > PENDING_ACTION_MAX_DOCUMENT_BYTES) throw actionError('The pending action journal exceeds its document size limit.');
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    let handle: PendingActionFileHandle | undefined;
    try {
      await this.fileSystem.mkdir(dirname(this.filePath), 0o700);
      handle = await this.fileSystem.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(document, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.fileSystem.rename(temporaryPath, this.filePath);
    } finally {
      await handle?.close().catch(() => undefined);
      await this.fileSystem.rm(temporaryPath).catch(() => undefined);
    }
  }
}

export function formatPendingActionStartupNotice(result: PendingActionLoadResult): string | undefined {
  if (result.status !== 'ready') return 'No pude leer el registro de acciones pendientes; no modifiqué el archivo.';
  const pendingCount = result.actions.filter(({ state }) => isRecoverable(state)).length;
  const reconciliationCount = result.actions.filter(({ state }) => state === 'reconciliation_required').length;
  if (pendingCount === 0) return undefined;
  const actionWord = pendingCount === 1 ? 'acción pendiente' : 'acciones pendientes';
  const base = reconciliationCount > 0
    ? `Tienes ${pendingCount} ${actionWord}; ${reconciliationCount} ${reconciliationCount === 1 ? 'acción requiere' : 'acciones requieren'} reconciliación. No se ejecutaron automáticamente.`
    : `Tienes ${pendingCount} ${actionWord} de revisión. No se ejecutarán automáticamente; usa /pending para revisarlas.`;
  return base + (result.status === 'ready' && !result.recoveryPersisted
    ? ' No pude guardar la marca de reconciliación; no habrá reintento automático.'
    : '');
}

export function formatPendingAction(action: PendingAction): string {
  return [
    `ID: ${action.id}`,
    `Tipo: ${action.type}`,
    `Estado: ${action.state}`,
    `Creada: ${action.createdAt}`,
    ...(action.state === 'reconciliation_required' ? ['Requiere reconciliación; no se reintentará automáticamente.'] : []),
    `Recordatorio propuesto: ${action.payload.text}`,
    `Fecha: ${action.payload.dueAt}`,
  ].join('\n');
}

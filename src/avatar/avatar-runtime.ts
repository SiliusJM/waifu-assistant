import { randomUUID } from 'node:crypto';
import { EventBus } from '../realtime/event-bus.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { AvatarController, validateAvatarSignal } from './avatar-controller.js';
import { AvatarError, isAbortError } from './avatar-errors.js';
import { AvatarPresentationPolicy, isControlledAvatarId } from './avatar-policy.js';
import type {
  AvatarEvent,
  AvatarEventMap,
  AvatarEventPayloadMap,
  AvatarLifecycleState,
  AvatarAssetKind,
  AvatarPresentationSnapshot,
  AvatarProviderCapabilities,
  AvatarRuntimeOptions,
  AvatarSignal,
  AvatarSignalInput,
} from './avatar-types.js';

const AVATAR_ASSET_KINDS = new Set(['model', 'texture', 'animation', 'expression', 'metadata']);

function freezeCapabilities(value: unknown): AvatarProviderCapabilities {
  if (!value || typeof value !== 'object') {
    throw new AvatarError('Avatar provider capabilities must be an object.', 'AVATAR_CONFIGURATION_ERROR');
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.expressions) || !Array.isArray(candidate.animations) || !Array.isArray(candidate.assetKinds) || typeof candidate.interruptiblePresentation !== 'boolean') {
    throw new AvatarError('Avatar provider capabilities have an invalid shape.', 'AVATAR_CONFIGURATION_ERROR');
  }

  const expressions = validateCapabilityIds(candidate.expressions, 'expressions');
  const animations = validateCapabilityIds(candidate.animations, 'animations');
  const assetKinds = candidate.assetKinds.map((kind): AvatarAssetKind => {
    if (typeof kind !== 'string' || !AVATAR_ASSET_KINDS.has(kind)) {
      throw new AvatarError('Avatar provider declared an unsupported asset kind.', 'AVATAR_CAPABILITY_ERROR');
    }
    return kind as AvatarAssetKind;
  });
  if (new Set(assetKinds).size !== assetKinds.length) {
    throw new AvatarError('Avatar provider declared duplicate asset kinds.', 'AVATAR_CONFIGURATION_ERROR');
  }
  return Object.freeze({
    expressions: Object.freeze(expressions),
    animations: Object.freeze(animations),
    interruptiblePresentation: candidate.interruptiblePresentation,
    assetKinds: Object.freeze(assetKinds),
  });
}

function validateCapabilityIds(values: unknown[], field: 'expressions' | 'animations'): string[] {
  const ids = values.map((value) => {
    if (typeof value !== 'string' || !isControlledAvatarId(value)) {
      throw new AvatarError(`Avatar provider declared an invalid ${field} ID.`, 'AVATAR_CONFIGURATION_ERROR');
    }
    return value;
  });
  if (new Set(ids).size !== ids.length) {
    throw new AvatarError(`Avatar provider declared duplicate ${field} IDs.`, 'AVATAR_CONFIGURATION_ERROR');
  }
  return ids;
}

function abortError(): Error {
  return new DOMException('The avatar operation was cancelled.', 'AbortError');
}

export class AvatarSignalNormalizer {
  private globalSequence = 0;
  private readonly sourceSequences = new Map<string, number>();

  validate(input: unknown): AvatarSignalInput {
    return validateAvatarSignal(input) as AvatarSignalInput;
  }

  normalize(input: unknown): AvatarSignal | undefined {
    const validated = this.validate(input);
    const previous = this.sourceSequences.get(validated.sourceId) ?? 0;
    if (validated.sourceSequence <= previous) return undefined;
    this.sourceSequences.set(validated.sourceId, validated.sourceSequence);
    this.globalSequence += 1;
    return Object.freeze({ ...validated, sequence: this.globalSequence }) as AvatarSignal;
  }
}

interface ActivePresentation {
  readonly snapshot: AvatarPresentationSnapshot;
  readonly controller: AbortController;
  promise: Promise<void>;
}

export class AvatarRuntime {
  readonly events = new EventBus<AvatarEventMap>();
  readonly controller: AvatarController;
  readonly normalizer = new AvatarSignalNormalizer();
  private readonly provider: AvatarRuntimeOptions['provider'];
  private readonly logger: Logger;
  private readonly fallback: AvatarRuntimeOptions['presentationFallback'];
  private readonly shutdownTimeoutMs: number;
  private lifecycle: AvatarLifecycleState = 'CREATED';
  private capabilities?: AvatarProviderCapabilities;
  private initializationController?: AbortController;
  private active?: ActivePresentation;
  private pending?: AvatarPresentationSnapshot;
  private eventSequence = 0;
  private shutdownPromise?: Promise<void>;

  constructor(options: AvatarRuntimeOptions) {
    if (!options.runtimeId || !options.characterProfile.characterId) {
      throw new AvatarError('Avatar runtime and character IDs are required.', 'AVATAR_CONFIGURATION_ERROR');
    }
    this.provider = options.provider;
    this.logger = options.logger ?? createLogger({ scope: 'avatar-runtime' });
    this.fallback = options.presentationFallback ?? 'error';
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.shutdownTimeoutMs) || this.shutdownTimeoutMs <= 0) {
      throw new AvatarError('Avatar shutdown timeout must be a positive integer.', 'AVATAR_CONFIGURATION_ERROR');
    }
    this.controller = new AvatarController({
      runtimeId: options.runtimeId,
      characterProfile: options.characterProfile,
      policy: new AvatarPresentationPolicy({ fallback: this.fallback }),
    });
  }

  get runtimeId(): string { return this.controller.currentSnapshot.runtimeId; }
  get lifecycleState(): AvatarLifecycleState { return this.lifecycle; }
  get providerCapabilities(): AvatarProviderCapabilities | undefined { return this.capabilities; }
  get currentSnapshot(): AvatarPresentationSnapshot { return this.controller.currentSnapshot; }
  get pendingSnapshot(): AvatarPresentationSnapshot | undefined { return this.pending; }
  get activePresentation(): AvatarPresentationSnapshot | undefined { return this.active?.snapshot; }

  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.lifecycle === 'READY') return;
    if (this.lifecycle !== 'CREATED') throw new AvatarError('Avatar runtime cannot be initialized from its current lifecycle.', 'AVATAR_LIFECYCLE_ERROR');
    this.transition('INITIALIZING');
    const initializationController = new AbortController();
    this.initializationController = initializationController;
    const abortInitialization = (): void => initializationController.abort(signal?.reason);
    signal?.addEventListener('abort', abortInitialization, { once: true });
    try {
      if (signal?.aborted) abortInitialization();
      const capabilities = await this.provider.initialize(initializationController.signal);
      if (initializationController.signal.aborted || !this.isInitializing()) {
        throw abortError();
      }
      this.capabilities = freezeCapabilities(capabilities);
      if (!this.isInitializing()) throw abortError();
      this.transition('LOADING');
      if (!this.isLoading()) throw abortError();
      this.transition('READY');
      this.publish('avatar_initialized', { provider: this.provider.name });
      this.publish('avatar_ready', { provider: this.provider.name, lifecycle: 'READY' });
    } catch (error) {
      if (!this.isShuttingDown()) this.transition('ERROR');
      const avatarError = isAbortError(error) ? new AvatarError('Avatar initialization was cancelled.', 'AVATAR_CANCELLATION_ERROR', false, error) : this.asAvatarError(error, 'initialize');
      if (!this.isShuttingDown()) this.publishError(avatarError, 'initialize');
      throw avatarError;
    } finally {
      signal?.removeEventListener('abort', abortInitialization);
      if (this.initializationController === initializationController) this.initializationController = undefined;
    }
  }

  submit(input: unknown): boolean {
    const signal = this.normalizer.normalize(input);
    return signal ? this.accept(signal) : false;
  }

  accept(signal: unknown): boolean {
    if (this.lifecycle !== 'READY') return false;
    let validatedSignal: AvatarSignal;
    try {
      validatedSignal = validateAvatarSignal(signal, { allowGlobalSequence: true }) as AvatarSignal;
    } catch (error) {
      throw error instanceof AvatarError ? error : new AvatarError('Avatar signal validation failed.', 'AVATAR_CONFIGURATION_ERROR', false, error);
    }
    let preparation: ReturnType<AvatarController['prepare']>;
    try {
      preparation = this.controller.prepare(validatedSignal);
    } catch (error) {
      const avatarError = error instanceof AvatarError ? error : new AvatarError('Avatar state validation failed.', 'AVATAR_STATE_ERROR', false, error);
      this.publishError(avatarError, 'present');
      return false;
    }
    if (!preparation.accepted) {
      if (preparation.reason === 'invalid_transition' && preparation.signal) this.controller.apply(preparation.signal);
      return false;
    }
    let snapshot: AvatarPresentationSnapshot;
    try {
      snapshot = this.validateCapabilities(preparation.snapshot);
    } catch (error) {
      const avatarError = error instanceof AvatarError ? error : new AvatarError('Avatar capability validation failed.', 'AVATAR_CAPABILITY_ERROR', false, error);
      this.publishError(avatarError, 'present');
      return false;
    }
    const result = this.controller.commit(preparation, snapshot);
    if (!result.accepted) return false;
    this.publish('avatar_state_changed', {
      from: result.previous.state,
      to: result.snapshot.state,
      baseState: result.snapshot.baseState,
      sequence: result.snapshot.sequence,
      ...(result.snapshot.correlationId ? { correlationId: result.snapshot.correlationId } : {}),
    });
    if (validatedSignal.type === 'reaction_requested') {
      this.publish('avatar_reaction_requested', { reactionId: validatedSignal.reactionId, sequence: validatedSignal.sequence, correlationId: validatedSignal.correlationId });
    }
    this.schedule(snapshot);
    return true;
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    if (this.lifecycle === 'STOPPED') return;
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown(signal);
    return this.shutdownPromise;
  }

  private async performShutdown(signal?: AbortSignal): Promise<void> {
    this.transition('SHUTTING_DOWN');
    this.initializationController?.abort(signal?.reason);
    this.pending = undefined;
    this.active?.controller.abort(signal?.reason);
    if (this.active) await this.withTimeout(this.active.promise, this.shutdownTimeoutMs).catch(() => undefined);
    try {
      await this.withTimeout(this.provider.shutdown(signal), this.shutdownTimeoutMs);
    } catch (error) {
      const avatarError = isAbortError(error) ? new AvatarError('Avatar shutdown was cancelled.', 'AVATAR_CANCELLATION_ERROR', false, error) : new AvatarError('Avatar provider shutdown failed.', 'AVATAR_SHUTDOWN_TIMEOUT_ERROR', false, error);
      this.publishError(avatarError, 'shutdown');
    } finally {
      this.lifecycle = 'STOPPED';
      this.controller.setLifecycleState('STOPPED');
      this.publish('avatar_shutdown', { lifecycle: 'STOPPED' });
    }
  }

  private schedule(snapshot: AvatarPresentationSnapshot): void {
    if (this.lifecycle !== 'READY') return;
    if (this.active) {
      this.pending = snapshot;
      if (this.capabilities?.interruptiblePresentation) this.active.controller.abort();
      return;
    }
    this.start(snapshot);
  }

  private start(snapshot: AvatarPresentationSnapshot): void {
    if (this.lifecycle !== 'READY' || this.active) return;
    const controller = new AbortController();
    const active: ActivePresentation = { snapshot, controller, promise: Promise.resolve() };
    active.promise = this.runPresentation(active);
    this.active = active;
  }

  private async runPresentation(active: ActivePresentation): Promise<void> {
    try {
      if (active.snapshot.animationId) this.publish('avatar_animation_started', { animationId: active.snapshot.animationId, sequence: active.snapshot.sequence, ...(active.snapshot.correlationId ? { correlationId: active.snapshot.correlationId } : {}) });
      await this.provider.present(active.snapshot, active.controller.signal);
      if (active.snapshot.animationId) this.publish('avatar_animation_finished', { animationId: active.snapshot.animationId, sequence: active.snapshot.sequence, ...(active.snapshot.correlationId ? { correlationId: active.snapshot.correlationId } : {}) });
    } catch (error) {
      if (!isAbortError(error) && this.lifecycle === 'READY') {
        this.lifecycle = 'ERROR';
        this.controller.setLifecycleState('ERROR');
        this.pending = undefined;
        this.publishError(this.asAvatarError(error, 'present'), 'present');
      }
    } finally {
      if (this.active === active) this.active = undefined;
      if (this.lifecycle === 'READY' && this.pending) {
        const next = this.pending;
        this.pending = undefined;
        this.start(next);
      }
    }
  }

  private validateCapabilities(snapshot: AvatarPresentationSnapshot): AvatarPresentationSnapshot {
    const capabilities = this.capabilities;
    if (!capabilities) throw new AvatarError('Avatar provider capabilities are unavailable.', 'AVATAR_PROVIDER_UNAVAILABLE_ERROR');
    const expressionSupported = !snapshot.expressionId || capabilities.expressions.includes(snapshot.expressionId);
    const animationSupported = !snapshot.animationId || capabilities.animations.includes(snapshot.animationId);
    if (expressionSupported && animationSupported) return snapshot;
    if (this.fallback === 'strip-unsupported') {
      return Object.freeze({
        ...snapshot,
        ...(expressionSupported ? {} : { expressionId: undefined }),
        ...(animationSupported ? {} : { animationId: undefined }),
      });
    }
    throw new AvatarError('Avatar provider does not support the requested presentation capability.', 'AVATAR_CAPABILITY_ERROR');
  }

  private transition(next: AvatarLifecycleState): void {
    if (next === 'SHUTTING_DOWN') {
      if (this.lifecycle === 'STOPPED' || this.lifecycle === 'SHUTTING_DOWN') return;
    } else if (this.lifecycle === 'STOPPED') {
      throw new AvatarError('Stopped avatar runtimes cannot change lifecycle.', 'AVATAR_LIFECYCLE_ERROR');
    }
    this.lifecycle = next;
    this.controller.setLifecycleState(next);
  }

  private isShuttingDown(): boolean {
    return this.lifecycle === 'SHUTTING_DOWN' || this.lifecycle === 'STOPPED';
  }

  private isInitializing(): boolean {
    return this.lifecycle === 'INITIALIZING';
  }

  private isLoading(): boolean {
    return this.lifecycle === 'LOADING';
  }

  private publish<K extends keyof AvatarEventPayloadMap>(type: K, payload: AvatarEventPayloadMap[K]): void {
    const event: AvatarEvent = {
      eventId: randomUUID(),
      runtimeId: this.runtimeId,
      sequence: ++this.eventSequence,
      occurredAt: new Date().toISOString(),
      type,
      payload,
    } as AvatarEvent;
    this.events.publish(type, event as AvatarEventMap[K]);
  }

  private publishError(error: AvatarError, operation: 'initialize' | 'present' | 'shutdown'): void {
    this.logger.error('Avatar operation failed.', { runtimeId: this.runtimeId, provider: this.provider.name, lifecycle: this.lifecycle, code: error.code, operation });
    this.publish('avatar_error', { code: error.code, lifecycle: this.lifecycle, operation });
  }

  private asAvatarError(error: unknown, operation: 'initialize' | 'present' | 'shutdown'): AvatarError {
    if (error instanceof AvatarError) return error;
    if (operation === 'initialize') return new AvatarError('Avatar provider initialization failed.', 'AVATAR_PROVIDER_UNAVAILABLE_ERROR', false, error);
    if (operation === 'present') return new AvatarError('Avatar provider presentation failed.', 'AVATAR_INTERNAL_ERROR', false, error);
    return new AvatarError('Avatar provider shutdown failed.', 'AVATAR_SHUTDOWN_TIMEOUT_ERROR', false, error);
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AvatarError('Avatar shutdown exceeded its time limit.', 'AVATAR_SHUTDOWN_TIMEOUT_ERROR')), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

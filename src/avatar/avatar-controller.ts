import { AvatarPresentationPolicy, isControlledAvatarId } from './avatar-policy.js';
import { AvatarError } from './avatar-errors.js';
import type {
  AvatarBaseState,
  AvatarCharacterProfile,
  AvatarControllerPreparation,
  AvatarControllerResult,
  AvatarLifecycleState,
  AvatarPresentationSnapshot,
  AvatarSignal,
  AvatarSignalInput,
  AvatarVisualState,
} from './avatar-types.js';

const AVATAR_SIGNAL_TYPES = new Set<AvatarSignal['type']>([
  'listen_started',
  'listen_stopped',
  'speech_started',
  'speech_stopped',
  'reaction_requested',
  'reaction_finished',
  'visual_reset',
]);
const AVATAR_SIGNAL_REASONS = new Set(['completed', 'cancelled', 'interrupted', 'superseded', 'failed']);
export const MAX_AVATAR_REACTION_DURATION_MS = 300_000;

const VISUAL_TRANSITIONS: Readonly<Record<AvatarVisualState, readonly AvatarVisualState[]>> = {
  IDLE: ['LISTENING', 'SPEAKING', 'REACTION'],
  LISTENING: ['IDLE', 'SPEAKING', 'REACTION'],
  SPEAKING: ['IDLE', 'LISTENING', 'REACTION'],
  REACTION: ['IDLE', 'LISTENING', 'SPEAKING', 'REACTION'],
};

function freezeSnapshot(snapshot: AvatarPresentationSnapshot): AvatarPresentationSnapshot {
  return Object.freeze({ ...snapshot });
}

export interface AvatarControllerOptions {
  readonly runtimeId: string;
  readonly characterProfile: AvatarCharacterProfile;
  readonly policy?: AvatarPresentationPolicy;
}

export class AvatarController {
  private readonly runtimeId: string;
  private readonly profile: AvatarCharacterProfile;
  private readonly policy: AvatarPresentationPolicy;
  private lifecycle: AvatarLifecycleState = 'CREATED';
  private state: AvatarVisualState = 'IDLE';
  private baseState: AvatarBaseState = 'IDLE';
  private lastSequence = 0;
  private snapshot: AvatarPresentationSnapshot;

  constructor(options: AvatarControllerOptions) {
    this.runtimeId = options.runtimeId;
    this.profile = Object.freeze({ ...options.characterProfile });
    this.policy = options.policy ?? new AvatarPresentationPolicy();
    this.snapshot = this.createSnapshot('IDLE', 'IDLE', 0, undefined);
  }

  get lifecycleState(): AvatarLifecycleState { return this.lifecycle; }
  get currentSnapshot(): AvatarPresentationSnapshot { return this.snapshot; }
  get visualState(): AvatarVisualState { return this.state; }
  get baseVisualState(): AvatarBaseState { return this.baseState; }
  get lastGlobalSequence(): number { return this.lastSequence; }

  setLifecycleState(state: AvatarLifecycleState): void {
    this.lifecycle = state;
  }

  prepare(signal: AvatarSignal): AvatarControllerPreparation {
    if (this.lifecycle !== 'READY') return { accepted: false, reason: 'lifecycle' };
    if (!Number.isSafeInteger(signal.sequence) || signal.sequence <= 0) return { accepted: false, reason: 'old_signal' };
    if (signal.sequence < this.lastSequence) return { accepted: false, reason: 'old_signal' };
    if (signal.sequence === this.lastSequence) return { accepted: false, reason: 'duplicate' };

    const next = this.nextState(signal);
    if (!next) return { accepted: false, reason: 'invalid_transition', signal };
    const snapshot = this.createSnapshot(
      next.state,
      next.baseState,
      signal.sequence,
      signal.correlationId,
      signal.type === 'reaction_requested' ? signal.reactionId : undefined,
    );
    return Object.freeze({ accepted: true, signal, previous: this.snapshot, snapshot });
  }

  commit(preparation: AvatarControllerPreparation & { readonly accepted: true }, snapshot = preparation.snapshot): AvatarControllerResult {
    if (this.lifecycle !== 'READY') return { accepted: false, reason: 'lifecycle' };
    if (preparation.signal.sequence <= this.lastSequence) {
      return { accepted: false, reason: preparation.signal.sequence === this.lastSequence ? 'duplicate' : 'old_signal' };
    }
    this.state = snapshot.state;
    this.baseState = snapshot.baseState;
    this.lastSequence = preparation.signal.sequence;
    this.snapshot = snapshot;
    return { accepted: true, previous: preparation.previous, snapshot };
  }

  apply(signal: AvatarSignal): AvatarControllerResult {
    const preparation = this.prepare(signal);
    if (!preparation.accepted) {
      if (preparation.reason === 'invalid_transition' && preparation.signal) this.lastSequence = preparation.signal.sequence;
      return preparation;
    }
    return this.commit(preparation);
  }

  private nextState(signal: AvatarSignal): { readonly state: AvatarVisualState; readonly baseState: AvatarBaseState } | undefined {
    if (signal.type === 'reaction_finished') {
      if (this.state !== 'REACTION') return undefined;
      return { state: this.baseState, baseState: this.baseState };
    }
    if (signal.type === 'visual_reset') return { state: 'IDLE', baseState: 'IDLE' };
    if (signal.type === 'reaction_requested') {
      const currentState: AvatarVisualState = this.state;
      return { state: 'REACTION', baseState: currentState === 'REACTION' ? this.baseState : currentState };
    }

    const target: AvatarVisualState = signal.type === 'listen_started' ? 'LISTENING'
      : signal.type === 'listen_stopped' ? 'IDLE'
        : signal.type === 'speech_started' ? 'SPEAKING' : 'IDLE';
    if (!VISUAL_TRANSITIONS[this.state].includes(target)) return undefined;
    return { state: target, baseState: target };
  }

  private createSnapshot(
    state: AvatarVisualState,
    baseState: AvatarBaseState,
    sequence: number,
    correlationId?: string,
    reactionId?: string,
  ): AvatarPresentationSnapshot {
    const mapping = this.policy.resolve(this.profile, state, baseState, reactionId);
    return freezeSnapshot({
      runtimeId: this.runtimeId,
      characterId: this.profile.characterId,
      state,
      baseState,
      ...mapping,
      sequence,
      ...(correlationId ? { correlationId } : {}),
    });
  }
}

export function isAvatarSignal(value: unknown): value is AvatarSignalInput | AvatarSignal {
  try {
    validateAvatarSignal(value, { allowGlobalSequence: typeof value === 'object' && value !== null && 'sequence' in value });
    return true;
  } catch {
    return false;
  }
}

export function validateAvatarSignal(value: unknown, options: { readonly allowGlobalSequence?: boolean } = {}): AvatarSignalInput | AvatarSignal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AvatarError('Avatar signal must be a non-null object.', 'AVATAR_CONFIGURATION_ERROR');
  }
  const candidate = value as Record<string, unknown>;
  const hasGlobalSequence = 'sequence' in candidate;
  if (hasGlobalSequence !== Boolean(options.allowGlobalSequence)) {
    throw new AvatarError('Avatar signal global sequence must be assigned only by the normalizer.', 'AVATAR_CONFIGURATION_ERROR');
  }
  if (typeof candidate.type !== 'string' || !AVATAR_SIGNAL_TYPES.has(candidate.type as AvatarSignal['type'])) {
    throw new AvatarError('Avatar signal type is not supported.', 'AVATAR_CONFIGURATION_ERROR');
  }
  if (typeof candidate.sourceId !== 'string' || candidate.sourceId.trim().length === 0) {
    throw new AvatarError('Avatar signal sourceId must be a non-empty string.', 'AVATAR_CONFIGURATION_ERROR');
  }
  if (typeof candidate.correlationId !== 'string' || candidate.correlationId.trim().length === 0) {
    throw new AvatarError('Avatar signal correlationId must be a non-empty string.', 'AVATAR_CONFIGURATION_ERROR');
  }
  if (!Number.isSafeInteger(candidate.sourceSequence) || (candidate.sourceSequence as number) <= 0) {
    throw new AvatarError('Avatar signal sourceSequence must be a positive safe integer.', 'AVATAR_CONFIGURATION_ERROR');
  }
  if (hasGlobalSequence && (!Number.isSafeInteger(candidate.sequence) || (candidate.sequence as number) <= 0)) {
    throw new AvatarError('Avatar signal sequence must be a positive safe integer.', 'AVATAR_CONFIGURATION_ERROR');
  }

  const type = candidate.type as AvatarSignal['type'];
  if (type === 'reaction_requested') {
    if (typeof candidate.reactionId !== 'string' || candidate.reactionId.trim().length === 0 || !isControlledAvatarId(candidate.reactionId)) {
      throw new AvatarError('Avatar reactionId must be a controlled non-empty identifier.', 'AVATAR_CONFIGURATION_ERROR');
    }
    if (candidate.durationMs !== undefined && (!Number.isSafeInteger(candidate.durationMs) || (candidate.durationMs as number) <= 0 || (candidate.durationMs as number) > MAX_AVATAR_REACTION_DURATION_MS)) {
      throw new AvatarError('Avatar reaction duration must be a positive safe integer within the configured limit.', 'AVATAR_CONFIGURATION_ERROR');
    }
    if ('reason' in candidate) {
      throw new AvatarError('Reaction signals cannot carry a non-reaction reason.', 'AVATAR_CONFIGURATION_ERROR');
    }
  } else {
    if ('reactionId' in candidate || 'durationMs' in candidate) {
      throw new AvatarError('Non-reaction avatar signals cannot carry reaction fields.', 'AVATAR_CONFIGURATION_ERROR');
    }
    if (candidate.reason !== undefined && (typeof candidate.reason !== 'string' || !AVATAR_SIGNAL_REASONS.has(candidate.reason))) {
      throw new AvatarError('Avatar signal reason is not supported.', 'AVATAR_CONFIGURATION_ERROR');
    }
  }

  const allowedKeys = type === 'reaction_requested'
    ? new Set(['type', 'correlationId', 'sourceId', 'sourceSequence', 'reactionId', 'durationMs', ...(hasGlobalSequence ? ['sequence'] : [])])
    : new Set(['type', 'correlationId', 'sourceId', 'sourceSequence', 'reason', ...(hasGlobalSequence ? ['sequence'] : [])]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    throw new AvatarError('Avatar signal contains unsupported fields.', 'AVATAR_CONFIGURATION_ERROR');
  }
  return Object.freeze({ ...candidate }) as AvatarSignalInput | AvatarSignal;
}

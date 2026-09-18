import { AvatarPresentationPolicy } from './avatar-policy.js';
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
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AvatarSignal>;
  return typeof candidate.type === 'string'
    && typeof candidate.correlationId === 'string'
    && typeof candidate.sourceId === 'string'
    && typeof candidate.sourceSequence === 'number';
}

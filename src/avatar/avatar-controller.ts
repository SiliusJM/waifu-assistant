import { AvatarPresentationPolicy } from './avatar-policy.js';
import type {
  AvatarBaseState,
  AvatarCharacterProfile,
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
    this.snapshot = this.createSnapshot(0, undefined);
  }

  get lifecycleState(): AvatarLifecycleState { return this.lifecycle; }
  get currentSnapshot(): AvatarPresentationSnapshot { return this.snapshot; }

  setLifecycleState(state: AvatarLifecycleState): void {
    this.lifecycle = state;
  }

  apply(signal: AvatarSignal): AvatarControllerResult {
    if (this.lifecycle !== 'READY') return { accepted: false, reason: 'lifecycle' };
    if (!Number.isSafeInteger(signal.sequence) || signal.sequence <= 0) {
      return { accepted: false, reason: 'old_signal' };
    }
    if (signal.sequence < this.lastSequence) return { accepted: false, reason: 'old_signal' };
    if (signal.sequence === this.lastSequence) return { accepted: false, reason: 'duplicate' };

    const next = this.nextState(signal);
    if (!next) {
      this.lastSequence = signal.sequence;
      return { accepted: false, reason: 'invalid_transition' };
    }

    const previous = this.snapshot;
    this.state = next.state;
    this.baseState = next.baseState;
    this.lastSequence = signal.sequence;
    this.snapshot = this.createSnapshot(signal.sequence, signal.correlationId, signal.type === 'reaction_requested' ? signal.reactionId : undefined);
    return { accepted: true, previous, snapshot: this.snapshot };
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

  private createSnapshot(sequence: number, correlationId?: string, reactionId?: string): AvatarPresentationSnapshot {
    const mapping = this.policy.resolve(this.profile, this.state, this.baseState, reactionId);
    return freezeSnapshot({
      runtimeId: this.runtimeId,
      characterId: this.profile.characterId,
      state: this.state,
      baseState: this.baseState,
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

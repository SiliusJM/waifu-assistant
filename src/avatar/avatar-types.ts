import type { Logger } from '../shared/logger.js';

export const AVATAR_VISUAL_STATES = ['IDLE', 'LISTENING', 'SPEAKING', 'REACTION'] as const;
export type AvatarVisualState = (typeof AVATAR_VISUAL_STATES)[number];
export type AvatarBaseState = Exclude<AvatarVisualState, 'REACTION'>;

export const AVATAR_LIFECYCLE_STATES = [
  'CREATED',
  'INITIALIZING',
  'LOADING',
  'READY',
  'ERROR',
  'SHUTTING_DOWN',
  'STOPPED',
] as const;
export type AvatarLifecycleState = (typeof AVATAR_LIFECYCLE_STATES)[number];

export type AvatarSignalType =
  | 'listen_started'
  | 'listen_stopped'
  | 'speech_started'
  | 'speech_stopped'
  | 'reaction_requested'
  | 'reaction_finished'
  | 'visual_reset';

export interface AvatarSignalBase {
  readonly type: AvatarSignalType;
  readonly correlationId: string;
  readonly sourceId: string;
  readonly sourceSequence: number;
  readonly sequence: number;
}

export type AvatarSignal = AvatarSignalBase & {
  readonly type: Exclude<AvatarSignalType, 'reaction_requested'>;
  readonly reason?: 'completed' | 'cancelled' | 'interrupted' | 'superseded' | 'failed';
} | AvatarSignalBase & {
  readonly type: 'reaction_requested';
  readonly reactionId: string;
  readonly durationMs?: number;
};

export type AvatarSignalInput = Omit<AvatarSignal, 'sequence'>;

export interface AvatarPresentationMapping {
  readonly expressionId?: string;
  readonly animationId?: string;
  readonly intensity?: number;
}

export interface AvatarPresentationSnapshot extends AvatarPresentationMapping {
  readonly runtimeId: string;
  readonly characterId: string;
  readonly state: AvatarVisualState;
  readonly baseState: AvatarBaseState;
  readonly sequence: number;
  readonly correlationId?: string;
}

export type AvatarAssetKind = 'model' | 'texture' | 'animation' | 'expression' | 'metadata';

export interface AvatarAssetManifestEntry {
  readonly assetId: string;
  readonly kind: AvatarAssetKind;
  readonly version?: string;
}

export interface AvatarAssetManifest {
  readonly entries: readonly AvatarAssetManifestEntry[];
}

export interface AvatarCharacterProfile {
  readonly characterId: string;
  readonly displayName?: string;
  readonly role?: string;
  readonly pronouns?: string;
  readonly stateMappings?: Readonly<Partial<Record<AvatarBaseState, AvatarPresentationMapping>>>;
  readonly reactions?: Readonly<Record<string, AvatarPresentationMapping>>;
  readonly assetManifest?: AvatarAssetManifest;
}

export interface AvatarProviderCapabilities {
  readonly expressions: readonly string[];
  readonly animations: readonly string[];
  readonly interruptiblePresentation: boolean;
  readonly assetKinds: readonly AvatarAssetKind[];
}

export interface AvatarProvider {
  readonly name: string;
  initialize(signal?: AbortSignal): Promise<AvatarProviderCapabilities>;
  present(snapshot: AvatarPresentationSnapshot, signal: AbortSignal): Promise<void>;
  shutdown(signal?: AbortSignal): Promise<void>;
}

export type AvatarPresentationFallback = 'error' | 'strip-unsupported';

export interface AvatarRuntimeOptions {
  readonly runtimeId: string;
  readonly characterProfile: AvatarCharacterProfile;
  readonly provider: AvatarProvider;
  readonly presentationFallback?: AvatarPresentationFallback;
  readonly shutdownTimeoutMs?: number;
  readonly logger?: Logger;
}

export interface AvatarEventPayloadMap {
  readonly avatar_initialized: { readonly provider: string };
  readonly avatar_ready: { readonly provider: string; readonly lifecycle: 'READY' };
  readonly avatar_state_changed: {
    readonly from: AvatarVisualState;
    readonly to: AvatarVisualState;
    readonly baseState: AvatarBaseState;
    readonly sequence: number;
    readonly correlationId?: string;
  };
  readonly avatar_reaction_requested: {
    readonly reactionId: string;
    readonly sequence: number;
    readonly correlationId: string;
  };
  readonly avatar_animation_started: {
    readonly animationId: string;
    readonly sequence: number;
    readonly correlationId?: string;
  };
  readonly avatar_animation_finished: {
    readonly animationId: string;
    readonly sequence: number;
    readonly correlationId?: string;
  };
  readonly avatar_error: {
    readonly code: string;
    readonly lifecycle: AvatarLifecycleState;
    readonly operation: 'initialize' | 'present' | 'shutdown';
  };
  readonly avatar_shutdown: { readonly lifecycle: 'STOPPED' };
}

export type AvatarEventType = keyof AvatarEventPayloadMap;

export interface AvatarEventEnvelope<K extends AvatarEventType = AvatarEventType> {
  readonly eventId: string;
  readonly runtimeId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: K;
  readonly payload: AvatarEventPayloadMap[K];
}

export type AvatarEventMap = {
  [K in AvatarEventType]: AvatarEventEnvelope<K>;
};

export type AvatarEvent = {
  [K in AvatarEventType]: AvatarEventEnvelope<K>;
}[AvatarEventType];

export type AvatarControllerResult =
  | { readonly accepted: true; readonly snapshot: AvatarPresentationSnapshot; readonly previous: AvatarPresentationSnapshot }
  | { readonly accepted: false; readonly reason: 'old_signal' | 'duplicate' | 'lifecycle' | 'invalid_transition' };

export type AvatarControllerPreparation =
  | {
      readonly accepted: true;
      readonly signal: AvatarSignal;
      readonly previous: AvatarPresentationSnapshot;
      readonly snapshot: AvatarPresentationSnapshot;
    }
  | {
      readonly accepted: false;
      readonly reason: 'old_signal' | 'duplicate' | 'lifecycle' | 'invalid_transition';
      readonly signal?: AvatarSignal;
    };

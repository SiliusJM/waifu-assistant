export const PERSONALITY_SCHEMA_VERSION = 1 as const;
export type PersonalitySchemaVersion = typeof PERSONALITY_SCHEMA_VERSION;

export type PersonalityTraitId =
  | 'warm'
  | 'energetic'
  | 'formal'
  | 'direct'
  | 'empathetic'
  | 'humorous';

export type BehavioralRuleId =
  | 'admit_uncertainty'
  | 'ask_clarifying_questions'
  | 'avoid_repetition'
  | 'use_humor_carefully';

export type BoundaryRuleId =
  | 'avoid_insults'
  | 'avoid_mockery'
  | 'avoid_unwanted_intimacy'
  | 'avoid_excessive_roleplay';

export interface CharacterIdentity {
  readonly displayName: string;
  readonly role?: string;
  readonly pronouns?: string;
  readonly description?: string;
}

export interface PersonalityTrait {
  readonly id: PersonalityTraitId;
  readonly strength: number;
  readonly enabled?: boolean;
}

interface BehavioralRuleBase {
  readonly enabled: boolean;
  readonly priority: number;
}

export type BehavioralRule =
  | (BehavioralRuleBase & { readonly id: 'admit_uncertainty' })
  | (BehavioralRuleBase & { readonly id: 'avoid_repetition' })
  | (BehavioralRuleBase & { readonly id: 'ask_clarifying_questions'; readonly maxQuestions: 1 | 2 })
  | (BehavioralRuleBase & { readonly id: 'use_humor_carefully'; readonly intensity: 'subtle' | 'moderate' });

export interface BoundaryRule {
  readonly id: BoundaryRuleId;
  readonly enabled: boolean;
}

export interface ToneProfile {
  readonly warmth: number;
  readonly formality: number;
  readonly energy: number;
  readonly directness: number;
  readonly empathy: number;
}

export interface SpeakingStyle {
  readonly verbosity: 'concise' | 'balanced' | 'detailed';
  readonly sentenceLength: 'short' | 'mixed' | 'long';
  readonly emoji: 'never' | 'rare' | 'sometimes' | 'frequent';
  readonly formatting: 'plain' | 'light' | 'structured';
  readonly addressStyle: 'neutral' | 'formal' | 'affectionate';
}

export interface LocalePolicy {
  readonly defaultLocale?: string;
  readonly allowedLocales?: readonly string[];
  readonly fallbackLocale?: string;
}

export interface VoicePresentationHints {
  readonly voiceId?: string;
  readonly rate?: number;
  readonly pitch?: number;
  readonly pauseStyle?: 'minimal' | 'natural' | 'dramatic';
}

export interface PersonalityProfile {
  readonly schemaVersion: PersonalitySchemaVersion;
  readonly personalityId: string;
  readonly profileVersion: string;
  readonly identity: CharacterIdentity;
  readonly traits: readonly PersonalityTrait[];
  readonly tone: ToneProfile;
  readonly speakingStyle: SpeakingStyle;
  readonly behavioralRules: readonly BehavioralRule[];
  readonly boundaries: readonly BoundaryRule[];
  readonly locale?: LocalePolicy;
  readonly voiceHints?: VoicePresentationHints;
}

/** Transient input from a future preference layer; it is not owned or persisted here. */
export interface InteractionPreferenceSnapshot {
  readonly locale?: string;
  readonly verbosity?: SpeakingStyle['verbosity'];
  readonly formatting?: SpeakingStyle['formatting'];
  readonly addressStyle?: SpeakingStyle['addressStyle'];
}

export interface PersonalityConfiguration {
  readonly profile: PersonalityProfile;
  readonly preferenceOverrides?: InteractionPreferenceSnapshot;
}

export type PersonalityInstructionLayer = 'identity' | 'trait' | 'tone' | 'style' | 'behavior' | 'boundary' | 'locale';

export type PersonalityPolicyLayer =
  | 'platform_security'
  | 'application'
  | 'tool_permissions'
  | 'voice_runtime'
  | 'personality'
  | 'user_preferences'
  | 'session_instructions'
  | 'conversation';

/** Conceptual precedence only; Personality System does not enforce these layers. */
export const PERSONALITY_POLICY_HIERARCHY: readonly PersonalityPolicyLayer[] = [
  'platform_security',
  'application',
  'tool_permissions',
  'voice_runtime',
  'personality',
  'user_preferences',
  'session_instructions',
  'conversation',
];

export interface PersonalityInstruction {
  readonly id: string;
  readonly layer: PersonalityInstructionLayer;
  readonly priority: number;
  readonly text: string;
}

export interface PersonalitySnapshot {
  readonly personalityId: string;
  readonly profileVersion: string;
  readonly schemaVersion: PersonalitySchemaVersion;
  /** Identity metadata for presentation/audit; description is not compiled as policy text. */
  readonly identity: CharacterIdentity;
  readonly instructions: readonly PersonalityInstruction[];
  readonly voiceHints?: VoicePresentationHints;
  readonly fingerprint?: string;
}

export interface PersonalityCompiler {
  compile(configuration: PersonalityConfiguration): PersonalitySnapshot;
}

export interface PersonalityValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type PersonalityValidationResult =
  | { readonly valid: true; readonly value: PersonalityProfile }
  | { readonly valid: false; readonly issues: readonly PersonalityValidationIssue[] };

export interface PersonalityEventPayloadMap {
  readonly personality_loaded: {
    readonly personalityId: string;
    readonly profileVersion: string;
    readonly schemaVersion: PersonalitySchemaVersion;
  };
  readonly personality_changed: {
    readonly previousPersonalityId?: string;
    readonly personalityId: string;
    readonly profileVersion: string;
  };
  readonly personality_validation_failed: {
    readonly personalityId?: string;
    readonly issueCount: number;
  };
}

export type PersonalityEventType = keyof PersonalityEventPayloadMap;

export interface PersonalityEventEnvelope<K extends PersonalityEventType = PersonalityEventType> {
  readonly eventId: string;
  readonly correlationId?: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: K;
  readonly payload: PersonalityEventPayloadMap[K];
}

export type PersonalityEventMap = {
  [K in PersonalityEventType]: PersonalityEventEnvelope<K>;
};

export type PersonalityEvent = {
  [K in PersonalityEventType]: PersonalityEventEnvelope<K>;
}[PersonalityEventType];

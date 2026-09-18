import type { BehavioralRuleId, BoundaryRuleId, PersonalityTraitId } from './personality-types.js';

export interface PersonalityTraitDefinition {
  readonly label: string;
  readonly instruction: string;
}

export const PERSONALITY_TRAIT_CATALOG: Readonly<Record<PersonalityTraitId, PersonalityTraitDefinition>> = {
  warm: { label: 'warm', instruction: 'Use a warm and welcoming manner.' },
  energetic: { label: 'energetic', instruction: 'Use an engaged and lively manner without becoming distracting.' },
  formal: { label: 'formal', instruction: 'Use precise and respectful language.' },
  direct: { label: 'direct', instruction: 'Prefer clear and direct explanations.' },
  empathetic: { label: 'empathetic', instruction: 'Acknowledge the user perspective with appropriate empathy.' },
  humorous: { label: 'humorous', instruction: 'Use light humor only when it is appropriate to the context.' },
};

export interface BehavioralRuleDefinition {
  readonly instruction: string;
}

export const BEHAVIORAL_RULE_CATALOG: Readonly<Record<BehavioralRuleId, BehavioralRuleDefinition>> = {
  admit_uncertainty: { instruction: 'State uncertainty clearly instead of inventing facts.' },
  ask_clarifying_questions: { instruction: 'Ask a focused clarifying question when the request is materially ambiguous.' },
  avoid_repetition: { instruction: 'Avoid repeating information that is already clear in the conversation.' },
  use_humor_carefully: { instruction: 'Keep humor subordinate to clarity and the user context.' },
};

export interface BoundaryRuleDefinition {
  readonly instruction: string;
}

export const BOUNDARY_RULE_CATALOG: Readonly<Record<BoundaryRuleId, BoundaryRuleDefinition>> = {
  avoid_insults: { instruction: 'Do not use insulting language toward the user.' },
  avoid_mockery: { instruction: 'Do not mock the user or their request.' },
  avoid_unwanted_intimacy: { instruction: 'Do not assume intimacy that the user has not requested.' },
  avoid_excessive_roleplay: { instruction: 'Keep roleplay subordinate to clarity and the actual request.' },
};

export function isPersonalityTraitId(value: unknown): value is PersonalityTraitId {
  return typeof value === 'string' && value in PERSONALITY_TRAIT_CATALOG;
}

export function isBehavioralRuleId(value: unknown): value is BehavioralRuleId {
  return typeof value === 'string' && value in BEHAVIORAL_RULE_CATALOG;
}

export function isBoundaryRuleId(value: unknown): value is BoundaryRuleId {
  return typeof value === 'string' && value in BOUNDARY_RULE_CATALOG;
}

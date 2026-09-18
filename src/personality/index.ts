export {
  BEHAVIORAL_RULE_CATALOG,
  BOUNDARY_RULE_CATALOG,
  PERSONALITY_TRAIT_CATALOG,
  isBehavioralRuleId,
  isBoundaryRuleId,
  isPersonalityTraitId,
} from './personality-catalog.js';
export { DEFAULT_PERSONALITY_PROFILE } from './default-profile.js';
export { PersonalityCompiler } from './personality-compiler.js';
export { PersonalityError, type PersonalityErrorCode } from './personality-errors.js';
export { PersonalityPolicy, normalizePreferenceOverrides } from './personality-policy.js';
export { PersonalityRegistry, serializePersonalityProfile } from './personality-registry.js';
export { PersonalityValidator } from './personality-validator.js';
export * from './personality-types.js';

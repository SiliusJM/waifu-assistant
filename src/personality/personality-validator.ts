import { PersonalityError } from './personality-errors.js';
import {
  isBehavioralRuleId,
  isBoundaryRuleId,
  isPersonalityTraitId,
} from './personality-catalog.js';
import { PERSONALITY_SCHEMA_VERSION, type PersonalityProfile, type PersonalityValidationIssue, type PersonalityValidationResult } from './personality-types.js';

const MAX_ID_LENGTH = 64;
const MAX_TEXT_LENGTH = 500;
const MAX_TRAITS = 16;
const MAX_RULES = 16;
const MAX_BOUNDARIES = 16;
const MAX_LOCALES = 8;
const PROFILE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const UNSAFE_CONTENT_PATTERN = /(system\s*prompt|ignore\s+(all|any|the|previous)|child_process|powershell|cmd(?:\.exe)?|shell|spawn\s*\(|exec\s*\(|tool\s+permission|risk\s*level|change\s+permissions?)/i;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: RecordValue): readonly string[] {
  return Object.keys(value);
}

function addUnknownKeys(value: RecordValue, allowed: readonly string[], path: string, issues: PersonalityValidationIssue[]): void {
  const allowedSet = new Set(allowed);
  for (const key of keys(value)) {
    if (!allowedSet.has(key)) issues.push({ path: path + '.' + key, code: 'UNKNOWN_FIELD', message: 'Unknown field.' });
  }
}

function addIssue(issues: PersonalityValidationIssue[], path: string, code: string, message: string): void {
  issues.push({ path, code, message });
}

function validateText(value: unknown, path: string, issues: PersonalityValidationIssue[], required: boolean, maxLength = MAX_TEXT_LENGTH): void {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || (required && value.trim().length === 0)) {
    addIssue(issues, path, 'INVALID_TEXT', required ? 'A non-empty text value is required.' : 'Text must be a string.');
    return;
  }
  if (value.length > maxLength) addIssue(issues, path, 'TEXT_TOO_LONG', 'Text exceeds the maximum length.');
  if (UNSAFE_CONTENT_PATTERN.test(value)) addIssue(issues, path, 'UNSAFE_CONTENT', 'Text contains an unsupported execution or instruction directive.');
}

function validateId(value: unknown, path: string, issues: PersonalityValidationIssue[]): void {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || value.length > MAX_ID_LENGTH) {
    addIssue(issues, path, 'INVALID_ID', 'ID must use the controlled identifier format.');
  }
}

function validateNumber(value: unknown, path: string, issues: PersonalityValidationIssue[], minimum: number, maximum: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    addIssue(issues, path, 'INVALID_NUMBER', 'Number must be finite and within the allowed range.');
  }
}

function validateIdentity(value: unknown, issues: PersonalityValidationIssue[]): void {
  const path = 'identity';
  if (!isRecord(value)) {
    addIssue(issues, path, 'INVALID_OBJECT', 'Identity must be an object.');
    return;
  }
  addUnknownKeys(value, ['displayName', 'role', 'pronouns', 'description'], path, issues);
  validateText(value.displayName, path + '.displayName', issues, true, 80);
  validateText(value.role, path + '.role', issues, false, 120);
  validateText(value.pronouns, path + '.pronouns', issues, false, 80);
  validateText(value.description, path + '.description', issues, false, MAX_TEXT_LENGTH);
}

function validateTraits(value: unknown, issues: PersonalityValidationIssue[]): void {
  if (!Array.isArray(value) || value.length > MAX_TRAITS) {
    addIssue(issues, 'traits', 'INVALID_ARRAY', 'Traits must be a bounded array.');
    return;
  }
  const seen = new Set<string>();
  value.forEach((trait, index) => {
    const path = 'traits[' + index + ']';
    if (!isRecord(trait)) {
      addIssue(issues, path, 'INVALID_OBJECT', 'Trait must be an object.');
      return;
    }
    addUnknownKeys(trait, ['id', 'strength', 'enabled'], path, issues);
    if (!isPersonalityTraitId(trait.id)) addIssue(issues, path + '.id', 'UNKNOWN_TRAIT', 'Trait is not in the controlled catalog.');
    else if (seen.has(trait.id)) addIssue(issues, path + '.id', 'DUPLICATE_ID', 'Trait IDs must be unique.');
    else seen.add(trait.id);
    validateNumber(trait.strength, path + '.strength', issues, 0, 1);
    if (trait.enabled !== undefined && typeof trait.enabled !== 'boolean') addIssue(issues, path + '.enabled', 'INVALID_BOOLEAN', 'Enabled must be boolean.');
  });
}

function validateTone(value: unknown, issues: PersonalityValidationIssue[]): void {
  const path = 'tone';
  const axes = ['warmth', 'formality', 'energy', 'directness', 'empathy'] as const;
  if (!isRecord(value)) {
    addIssue(issues, path, 'INVALID_OBJECT', 'Tone must be an object.');
    return;
  }
  addUnknownKeys(value, axes, path, issues);
  for (const axis of axes) validateNumber(value[axis], path + '.' + axis, issues, 0, 1);
}

function validateSpeakingStyle(value: unknown, issues: PersonalityValidationIssue[]): void {
  const path = 'speakingStyle';
  const allowed = ['verbosity', 'sentenceLength', 'emoji', 'formatting', 'addressStyle'] as const;
  if (!isRecord(value)) {
    addIssue(issues, path, 'INVALID_OBJECT', 'Speaking style must be an object.');
    return;
  }
  addUnknownKeys(value, allowed, path, issues);
  const values: Record<string, readonly string[]> = {
    verbosity: ['concise', 'balanced', 'detailed'],
    sentenceLength: ['short', 'mixed', 'long'],
    emoji: ['never', 'rare', 'sometimes', 'frequent'],
    formatting: ['plain', 'light', 'structured'],
    addressStyle: ['neutral', 'formal', 'affectionate'],
  };
  for (const field of allowed) {
    const allowedValues = values[field];
    if (allowedValues && !allowedValues.includes(value[field] as string)) addIssue(issues, path + '.' + field, 'INVALID_ENUM', 'Value is not allowed.');
  }
}

function validateRules(value: unknown, issues: PersonalityValidationIssue[]): void {
  if (!Array.isArray(value) || value.length > MAX_RULES) {
    addIssue(issues, 'behavioralRules', 'INVALID_ARRAY', 'Behavioral rules must be a bounded array.');
    return;
  }
  const seen = new Set<string>();
  value.forEach((rule, index) => {
    const path = 'behavioralRules[' + index + ']';
    if (!isRecord(rule)) {
      addIssue(issues, path, 'INVALID_OBJECT', 'Behavioral rule must be an object.');
      return;
    }
    const allowed = rule.id === 'ask_clarifying_questions'
      ? ['id', 'enabled', 'priority', 'maxQuestions']
      : rule.id === 'use_humor_carefully'
        ? ['id', 'enabled', 'priority', 'intensity']
        : ['id', 'enabled', 'priority'];
    addUnknownKeys(rule, allowed, path, issues);
    if (!isBehavioralRuleId(rule.id)) addIssue(issues, path + '.id', 'UNKNOWN_RULE', 'Rule is not in the controlled catalog.');
    else if (seen.has(rule.id)) addIssue(issues, path + '.id', 'DUPLICATE_ID', 'Rule IDs must be unique.');
    else seen.add(rule.id);
    if (typeof rule.enabled !== 'boolean') addIssue(issues, path + '.enabled', 'INVALID_BOOLEAN', 'Enabled must be boolean.');
    if (!Number.isInteger(rule.priority) || (rule.priority as number) < 0 || (rule.priority as number) > 100) addIssue(issues, path + '.priority', 'INVALID_PRIORITY', 'Priority must be an integer from 0 to 100.');
    if (rule.id === 'ask_clarifying_questions' && rule.maxQuestions !== 1 && rule.maxQuestions !== 2) addIssue(issues, path + '.maxQuestions', 'INVALID_PARAMETER', 'maxQuestions must be 1 or 2.');
    if (rule.id === 'use_humor_carefully' && rule.intensity !== 'subtle' && rule.intensity !== 'moderate') addIssue(issues, path + '.intensity', 'INVALID_PARAMETER', 'intensity must be subtle or moderate.');
  });
}

function validateBoundaries(value: unknown, issues: PersonalityValidationIssue[]): void {
  if (!Array.isArray(value) || value.length > MAX_BOUNDARIES) {
    addIssue(issues, 'boundaries', 'INVALID_ARRAY', 'Boundary rules must be a bounded array.');
    return;
  }
  const seen = new Set<string>();
  value.forEach((boundary, index) => {
    const path = 'boundaries[' + index + ']';
    if (!isRecord(boundary)) {
      addIssue(issues, path, 'INVALID_OBJECT', 'Boundary rule must be an object.');
      return;
    }
    addUnknownKeys(boundary, ['id', 'enabled'], path, issues);
    if (!isBoundaryRuleId(boundary.id)) addIssue(issues, path + '.id', 'UNKNOWN_BOUNDARY', 'Boundary is not in the controlled catalog.');
    else if (seen.has(boundary.id)) addIssue(issues, path + '.id', 'DUPLICATE_ID', 'Boundary IDs must be unique.');
    else seen.add(boundary.id);
    if (typeof boundary.enabled !== 'boolean') addIssue(issues, path + '.enabled', 'INVALID_BOOLEAN', 'Enabled must be boolean.');
  });
}

function validateLocale(value: unknown, issues: PersonalityValidationIssue[]): void {
  if (value === undefined) return;
  const path = 'locale';
  if (!isRecord(value)) {
    addIssue(issues, path, 'INVALID_OBJECT', 'Locale policy must be an object.');
    return;
  }
  addUnknownKeys(value, ['defaultLocale', 'allowedLocales', 'fallbackLocale'], path, issues);
  const locales = new Set<string>();
  for (const field of ['defaultLocale', 'fallbackLocale'] as const) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || !LOCALE_PATTERN.test(value[field]))) addIssue(issues, path + '.' + field, 'INVALID_LOCALE', 'Locale is invalid.');
  }
  if (value.allowedLocales !== undefined) {
    if (!Array.isArray(value.allowedLocales) || value.allowedLocales.length > MAX_LOCALES) addIssue(issues, path + '.allowedLocales', 'INVALID_ARRAY', 'Allowed locales must be a bounded array.');
    else value.allowedLocales.forEach((locale, index) => {
      if (typeof locale !== 'string' || !LOCALE_PATTERN.test(locale)) addIssue(issues, path + '.allowedLocales[' + index + ']', 'INVALID_LOCALE', 'Locale is invalid.');
      else if (locales.has(locale)) addIssue(issues, path + '.allowedLocales[' + index + ']', 'DUPLICATE_VALUE', 'Locales must be unique.');
      else locales.add(locale);
    });
  }
  if (typeof value.defaultLocale === 'string' && locales.size > 0 && !locales.has(value.defaultLocale)) addIssue(issues, path + '.defaultLocale', 'LOCALE_NOT_ALLOWED', 'Default locale must be in allowedLocales.');
  if (typeof value.fallbackLocale === 'string' && locales.size > 0 && !locales.has(value.fallbackLocale)) addIssue(issues, path + '.fallbackLocale', 'LOCALE_NOT_ALLOWED', 'Fallback locale must be in allowedLocales.');
}

function validateVoiceHints(value: unknown, issues: PersonalityValidationIssue[]): void {
  if (value === undefined) return;
  const path = 'voiceHints';
  if (!isRecord(value)) {
    addIssue(issues, path, 'INVALID_OBJECT', 'Voice hints must be an object.');
    return;
  }
  addUnknownKeys(value, ['voiceId', 'rate', 'pitch', 'pauseStyle'], path, issues);
  if (value.voiceId !== undefined && (typeof value.voiceId !== 'string' || !ID_PATTERN.test(value.voiceId) || value.voiceId.length > MAX_ID_LENGTH)) addIssue(issues, path + '.voiceId', 'INVALID_VOICE_ID', 'Voice ID must be an abstract identifier.');
  if (value.rate !== undefined) validateNumber(value.rate, path + '.rate', issues, 0.5, 2);
  if (value.pitch !== undefined) validateNumber(value.pitch, path + '.pitch', issues, -1, 1);
  if (value.pauseStyle !== undefined && !['minimal', 'natural', 'dramatic'].includes(value.pauseStyle as string)) addIssue(issues, path + '.pauseStyle', 'INVALID_ENUM', 'Pause style is invalid.');
}

export class PersonalityValidator {
  validate(value: unknown): PersonalityValidationResult {
    const issues: PersonalityValidationIssue[] = [];
    if (!isRecord(value)) return { valid: false, issues: [{ path: '', code: 'INVALID_OBJECT', message: 'Personality profile must be an object.' }] };
    addUnknownKeys(value, ['schemaVersion', 'personalityId', 'profileVersion', 'identity', 'traits', 'tone', 'speakingStyle', 'behavioralRules', 'boundaries', 'locale', 'voiceHints'], '', issues);
    if (value.schemaVersion !== PERSONALITY_SCHEMA_VERSION) addIssue(issues, 'schemaVersion', 'UNSUPPORTED_SCHEMA', 'Schema version is not supported.');
    validateId(value.personalityId, 'personalityId', issues);
    if (typeof value.profileVersion !== 'string' || !PROFILE_VERSION_PATTERN.test(value.profileVersion)) addIssue(issues, 'profileVersion', 'INVALID_VERSION', 'Profile version must use x.y.z format.');
    validateIdentity(value.identity, issues);
    validateTraits(value.traits, issues);
    validateTone(value.tone, issues);
    validateSpeakingStyle(value.speakingStyle, issues);
    validateRules(value.behavioralRules, issues);
    validateBoundaries(value.boundaries, issues);
    validateLocale(value.locale, issues);
    validateVoiceHints(value.voiceHints, issues);
    if (issues.length > 0) return { valid: false, issues };
    return { valid: true, value: value as unknown as PersonalityProfile };
  }

  assertValid(value: unknown): PersonalityProfile {
    const result = this.validate(value);
    if (!result.valid) throw new PersonalityError('Personality profile validation failed.', 'PERSONALITY_VALIDATION_ERROR');
    return result.value;
  }
}

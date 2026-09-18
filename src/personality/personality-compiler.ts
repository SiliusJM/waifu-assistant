import { createHash } from 'node:crypto';
import { PersonalityError } from './personality-errors.js';
import { PERSONALITY_TRAIT_CATALOG, BEHAVIORAL_RULE_CATALOG, BOUNDARY_RULE_CATALOG } from './personality-catalog.js';
import { PersonalityPolicy, type ResolvedPersonality } from './personality-policy.js';
import { PersonalityValidator } from './personality-validator.js';
import type {
  BehavioralRule,
  BoundaryRule,
  PersonalityCompiler as PersonalityCompilerContract,
  PersonalityConfiguration,
  PersonalityInstruction,
  PersonalitySnapshot,
  PersonalityTrait,
  ToneProfile,
} from './personality-types.js';

const MAX_INSTRUCTIONS = 64;
const MAX_INSTRUCTION_TEXT = 8000;

function toneLevel(value: number): string {
  if (value < 0.34) return 'low';
  if (value < 0.67) return 'moderate';
  return 'high';
}

function styleInstruction(resolved: ResolvedPersonality): string {
  const style = resolved.speakingStyle;
  return [
    'Use ' + style.verbosity + ' response length.',
    'Prefer ' + style.sentenceLength + ' sentences.',
    'Use emojis ' + style.emoji + '.',
    'Use ' + style.formatting + ' formatting.',
    'Address the user in a ' + style.addressStyle + ' manner.',
  ].join(' ');
}

function toneInstructions(tone: ToneProfile): readonly PersonalityInstruction[] {
  return [
    ['warmth', tone.warmth, 'warmth'],
    ['formality', tone.formality, 'formality'],
    ['energy', tone.energy, 'energy'],
    ['directness', tone.directness, 'directness'],
    ['empathy', tone.empathy, 'empathy'],
  ].map(([axis, value, label]) => ({
    id: 'tone.' + axis,
    layer: 'tone' as const,
    priority: 20,
    text: 'Use a ' + toneLevel(value as number) + ' level of ' + label + '.',
  }));
}

function traitInstruction(trait: PersonalityTrait): PersonalityInstruction {
  return {
    id: 'trait.' + trait.id,
    layer: 'trait',
    priority: 10,
    text: PERSONALITY_TRAIT_CATALOG[trait.id].instruction + ' Strength: ' + toneLevel(trait.strength) + '.',
  };
}

function behavioralInstruction(rule: BehavioralRule): PersonalityInstruction {
  const definition = BEHAVIORAL_RULE_CATALOG[rule.id];
  const parameter = rule.id === 'ask_clarifying_questions'
    ? ' Ask at most ' + rule.maxQuestions + ' focused question(s).'
    : rule.id === 'use_humor_carefully'
      ? ' Keep the humor ' + rule.intensity + '.'
      : '';
  return {
    id: 'behavior.' + rule.id,
    layer: 'behavior',
    priority: 30 + rule.priority,
    text: definition.instruction + parameter,
  };
}

function boundaryInstruction(rule: BoundaryRule): PersonalityInstruction {
  return {
    id: 'boundary.' + rule.id,
    layer: 'boundary',
    priority: 60,
    text: BOUNDARY_RULE_CATALOG[rule.id].instruction,
  };
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => JSON.stringify(key) + ':' + stableSerialize(record[key])).join(',') + '}';
}

function freezeSnapshot(snapshot: PersonalitySnapshot): PersonalitySnapshot {
  const identity = Object.freeze({ ...snapshot.identity });
  const instructions = Object.freeze(snapshot.instructions.map((instruction) => Object.freeze({ ...instruction })));
  const voiceHints = snapshot.voiceHints === undefined ? undefined : Object.freeze({ ...snapshot.voiceHints });
  return Object.freeze({ ...snapshot, identity, instructions, ...(voiceHints === undefined ? {} : { voiceHints }) });
}

export class PersonalityCompiler implements PersonalityCompilerContract {
  constructor(
    private readonly validator = new PersonalityValidator(),
    private readonly policy = new PersonalityPolicy(),
  ) {}

  compile(configuration: PersonalityConfiguration): PersonalitySnapshot {
    const profile = this.validator.assertValid(configuration.profile);
    const resolved = this.policy.resolve({ ...configuration, profile });
    const identity = resolved.profile.identity;
    const instructions: PersonalityInstruction[] = [{
      id: 'identity.character',
      layer: 'identity',
      priority: 0,
      text: [
        'The assistant identity name is ' + identity.displayName + '.',
        identity.role ? 'Its role is ' + identity.role + '.' : '',
        identity.pronouns ? 'Use these pronouns when relevant: ' + identity.pronouns + '.' : '',
      ].filter(Boolean).join(' '),
    }];
    instructions.push(...resolved.traits.map(traitInstruction));
    instructions.push(...toneInstructions(resolved.profile.tone));
    instructions.push({ id: 'style.response', layer: 'style', priority: 25, text: styleInstruction(resolved) });
    instructions.push(...resolved.profile.behavioralRules.filter((rule) => rule.enabled).map(behavioralInstruction));
    instructions.push(...resolved.profile.boundaries.filter((rule) => rule.enabled).map(boundaryInstruction));
    if (resolved.locale) instructions.push({ id: 'locale.default', layer: 'locale', priority: 70, text: 'Use locale ' + resolved.locale + ' when compatible with the user request.' });
    instructions.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
    const unique = new Map<string, PersonalityInstruction>();
    for (const instruction of instructions) unique.set(instruction.id, instruction);
    const normalized = [...unique.values()];
    const totalTextLength = normalized.reduce((total, instruction) => total + instruction.text.length, 0);
    if (normalized.length > MAX_INSTRUCTIONS || totalTextLength > MAX_INSTRUCTION_TEXT) {
      throw new PersonalityError('Compiled personality instructions exceed the configured bounds.', 'PERSONALITY_COMPILATION_ERROR');
    }
    const fingerprintInput = {
      personalityId: profile.personalityId,
      profileVersion: profile.profileVersion,
      schemaVersion: profile.schemaVersion,
      identity,
      instructions: normalized,
      voiceHints: profile.voiceHints,
    };
    const fingerprint = createHash('sha256').update(stableSerialize(fingerprintInput)).digest('hex');
    return freezeSnapshot({
      personalityId: profile.personalityId,
      profileVersion: profile.profileVersion,
      schemaVersion: profile.schemaVersion,
      identity,
      instructions: normalized,
      ...(profile.voiceHints === undefined ? {} : { voiceHints: profile.voiceHints }),
      fingerprint,
    });
  }
}

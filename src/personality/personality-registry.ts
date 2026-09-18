import { randomUUID } from 'node:crypto';
import { EventBus } from '../realtime/event-bus.js';
import { DEFAULT_PERSONALITY_PROFILE } from './default-profile.js';
import { PersonalityError } from './personality-errors.js';
import { PersonalityValidator } from './personality-validator.js';
import type {
  PersonalityEvent,
  PersonalityEventMap,
  PersonalityEventPayloadMap,
  PersonalityProfile,
} from './personality-types.js';

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => JSON.stringify(key) + ':' + stableSerialize(record[key])).join(',') + '}';
}

function cloneAndFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  const clone = structuredClone(value);
  const freeze = (current: unknown): unknown => {
    if (typeof current !== 'object' || current === null || Object.isFrozen(current)) return current;
    for (const nested of Object.values(current as Record<string, unknown>)) freeze(nested);
    return Object.freeze(current);
  };
  return freeze(clone) as T;
}

export function serializePersonalityProfile(profile: PersonalityProfile): string {
  return stableSerialize(profile);
}

export class PersonalityRegistry {
  readonly events = new EventBus<PersonalityEventMap>();
  private readonly profiles = new Map<string, PersonalityProfile>();
  private readonly validator: PersonalityValidator;
  private sequence = 0;
  private defaultPersonalityId: string;

  constructor(options: {
    readonly profiles?: readonly PersonalityProfile[];
    readonly defaultPersonalityId?: string;
    readonly validator?: PersonalityValidator;
  } = {}) {
    this.validator = options.validator ?? new PersonalityValidator();
    this.defaultPersonalityId = options.defaultPersonalityId ?? DEFAULT_PERSONALITY_PROFILE.personalityId;
    this.register(DEFAULT_PERSONALITY_PROFILE);
    for (const profile of options.profiles ?? []) this.register(profile);
    if (!this.profiles.has(this.defaultPersonalityId)) throw new PersonalityError('Default personality profile was not found.', 'PERSONALITY_NOT_FOUND_ERROR');
  }

  register(profile: PersonalityProfile, options: { readonly correlationId?: string; readonly makeDefault?: boolean } = {}): void {
    const result = this.validator.validate(profile);
    if (!result.valid) {
      this.publish('personality_validation_failed', {
        personalityId: typeof profile?.personalityId === 'string' ? profile.personalityId : undefined,
        issueCount: result.issues.length,
      }, options.correlationId);
      throw new PersonalityError('Personality profile validation failed.', 'PERSONALITY_VALIDATION_ERROR');
    }
    const previousDefault = this.defaultPersonalityId;
    const wasLoaded = this.profiles.has(profile.personalityId);
    const storedProfile = cloneAndFreeze(profile);
    this.profiles.set(profile.personalityId, storedProfile);
    this.publish('personality_loaded', {
      personalityId: profile.personalityId,
      profileVersion: profile.profileVersion,
      schemaVersion: profile.schemaVersion,
    }, options.correlationId);
    if (options.makeDefault) this.defaultPersonalityId = profile.personalityId;
    if (this.defaultPersonalityId !== previousDefault || (wasLoaded && options.makeDefault)) {
      this.publish('personality_changed', {
        previousPersonalityId: previousDefault,
        personalityId: this.defaultPersonalityId,
        profileVersion: this.require(this.defaultPersonalityId).profileVersion,
      }, options.correlationId);
    }
  }

  loadJson(json: string, options: { readonly correlationId?: string; readonly makeDefault?: boolean } = {}): PersonalityProfile {
    let value: unknown;
    try {
      value = JSON.parse(json) as unknown;
    } catch (error) {
      throw new PersonalityError('Personality JSON is invalid.', 'PERSONALITY_CONFIGURATION_ERROR', error);
    }
    const profile = this.validator.assertValid(value);
    this.register(profile, options);
    return this.require(profile.personalityId);
  }

  get(personalityId: string): PersonalityProfile | undefined {
    return this.profiles.get(personalityId);
  }

  list(): readonly PersonalityProfile[] {
    return Object.freeze([...this.profiles.values()].sort((left, right) => left.personalityId.localeCompare(right.personalityId)));
  }

  get defaultProfile(): PersonalityProfile {
    return this.require(this.defaultPersonalityId);
  }

  select(personalityId = this.defaultPersonalityId): PersonalityProfile {
    return this.require(personalityId);
  }

  setDefault(personalityId: string, correlationId?: string): void {
    const profile = this.require(personalityId);
    const previous = this.defaultPersonalityId;
    if (previous === personalityId) return;
    this.defaultPersonalityId = personalityId;
    this.publish('personality_changed', {
      previousPersonalityId: previous,
      personalityId,
      profileVersion: profile.profileVersion,
    }, correlationId);
  }

  private require(personalityId: string): PersonalityProfile {
    const profile = this.profiles.get(personalityId);
    if (!profile) throw new PersonalityError('Personality profile was not found.', 'PERSONALITY_NOT_FOUND_ERROR');
    return profile;
  }

  private publish<K extends keyof PersonalityEventPayloadMap>(type: K, payload: PersonalityEventPayloadMap[K], correlationId?: string): void {
    const event: PersonalityEvent = {
      eventId: randomUUID(),
      correlationId,
      sequence: ++this.sequence,
      occurredAt: new Date().toISOString(),
      type,
      payload,
    } as PersonalityEvent;
    this.events.publish(type, event as PersonalityEventMap[K]);
  }
}

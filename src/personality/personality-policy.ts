import type {
  InteractionPreferenceSnapshot,
  PersonalityConfiguration,
  PersonalityProfile,
  PersonalityTrait,
  SpeakingStyle,
} from './personality-types.js';

const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const VERBOSITY_VALUES = ['concise', 'balanced', 'detailed'] as const;
const FORMATTING_VALUES = ['plain', 'light', 'structured'] as const;
const ADDRESS_STYLE_VALUES = ['neutral', 'formal', 'affectionate'] as const;

export interface ResolvedPersonality {
  readonly profile: PersonalityProfile;
  readonly traits: readonly PersonalityTrait[];
  readonly speakingStyle: SpeakingStyle;
  readonly locale?: string;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizePreferenceOverrides(value: unknown): InteractionPreferenceSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(typeof value.locale === 'string' && LOCALE_PATTERN.test(value.locale) ? { locale: value.locale } : {}),
    ...(isOneOf(value.verbosity, VERBOSITY_VALUES) ? { verbosity: value.verbosity } : {}),
    ...(isOneOf(value.formatting, FORMATTING_VALUES) ? { formatting: value.formatting } : {}),
    ...(isOneOf(value.addressStyle, ADDRESS_STYLE_VALUES) ? { addressStyle: value.addressStyle } : {}),
  };
}

function resolveStyle(style: SpeakingStyle, preferences: InteractionPreferenceSnapshot | undefined): SpeakingStyle {
  return {
    ...style,
    verbosity: preferences?.verbosity ?? style.verbosity,
    formatting: preferences?.formatting ?? style.formatting,
    addressStyle: preferences?.addressStyle ?? style.addressStyle,
  };
}

export class PersonalityPolicy {
  resolve(configuration: PersonalityConfiguration): ResolvedPersonality {
    const { profile } = configuration;
    const preferenceOverrides = normalizePreferenceOverrides(configuration.preferenceOverrides);
    const requestedLocale = preferenceOverrides?.locale;
    const allowedLocales = profile.locale?.allowedLocales;
    const localeOverride = requestedLocale !== undefined
      && (allowedLocales === undefined || allowedLocales.includes(requestedLocale))
      ? requestedLocale
      : undefined;
    const locale = localeOverride
      ?? profile.locale?.defaultLocale
      ?? profile.locale?.fallbackLocale;
    return {
      profile,
      traits: profile.traits
        .filter((trait) => trait.enabled !== false && trait.strength > 0)
        .slice()
        .sort((left, right) => left.id.localeCompare(right.id)),
      speakingStyle: resolveStyle(profile.speakingStyle, preferenceOverrides),
      ...(locale === undefined ? {} : { locale }),
    };
  }
}

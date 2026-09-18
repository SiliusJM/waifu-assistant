import type {
  InteractionPreferenceSnapshot,
  PersonalityConfiguration,
  PersonalityProfile,
  PersonalityTrait,
  SpeakingStyle,
} from './personality-types.js';

export interface ResolvedPersonality {
  readonly profile: PersonalityProfile;
  readonly traits: readonly PersonalityTrait[];
  readonly speakingStyle: SpeakingStyle;
  readonly locale?: string;
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
    const { profile, preferenceOverrides } = configuration;
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

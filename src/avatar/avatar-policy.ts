import { AvatarError } from './avatar-errors.js';
import type {
  AvatarBaseState,
  AvatarCharacterProfile,
  AvatarPresentationMapping,
  AvatarPresentationFallback,
  AvatarVisualState,
} from './avatar-types.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function validateMapping(mapping: AvatarPresentationMapping | undefined): AvatarPresentationMapping | undefined {
  if (!mapping) return undefined;
  for (const id of [mapping.expressionId, mapping.animationId]) {
    if (id !== undefined && !ID_PATTERN.test(id)) {
      throw new AvatarError('Avatar presentation IDs must use the controlled identifier format.', 'AVATAR_CONFIGURATION_ERROR');
    }
  }
  if (mapping.intensity !== undefined && (!Number.isFinite(mapping.intensity) || mapping.intensity < 0 || mapping.intensity > 1)) {
    throw new AvatarError('Avatar presentation intensity must be between 0 and 1.', 'AVATAR_CONFIGURATION_ERROR');
  }
  return Object.freeze({ ...mapping });
}

export class AvatarPresentationPolicy {
  readonly fallback: AvatarPresentationFallback;

  constructor(options: { readonly fallback?: AvatarPresentationFallback } = {}) {
    this.fallback = options.fallback ?? 'error';
  }

  resolve(
    profile: AvatarCharacterProfile,
    state: AvatarVisualState,
    baseState: AvatarBaseState,
    reactionId?: string,
  ): AvatarPresentationMapping {
    if (state === 'REACTION') {
      if (!reactionId) throw new AvatarError('A reaction snapshot requires a controlled reaction ID.', 'AVATAR_CONFIGURATION_ERROR');
      const reaction = validateMapping(profile.reactions?.[reactionId]);
      if (reaction) return reaction;
      if (this.fallback === 'error') {
        throw new AvatarError('The requested avatar reaction is not configured.', 'AVATAR_ASSET_NOT_FOUND_ERROR');
      }
    }

    return validateMapping(profile.stateMappings?.[baseState]) ?? Object.freeze({});
  }
}

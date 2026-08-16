/**
 * Browser profile partition resolver.
 *
 * Maps a profile id to an Electron session partition string. The default
 * profile keeps the legacy `persist:browser-pane` partition so existing
 * cookies/storage survive without migration.
 */

import {
  DEFAULT_BROWSER_PROFILE_ID,
  type BrowserProfile,
} from '@craft-agent/shared/config/types';

const LEGACY_PARTITION = 'persist:browser-pane';
const PROFILE_PARTITION_PREFIX = 'persist:browser-pane:';

export { LEGACY_PARTITION as DEFAULT_BROWSER_PROFILE_PARTITION };

export type BrowserProfileOwnerType = 'session' | 'manual';

export class UserOnlyBrowserProfileError extends Error {
  readonly code = 'BROWSER_PROFILE_USER_ONLY';
  readonly profileId: string;

  constructor(profileId: string) {
    super(`Browser profile "${profileId}" is user-only and cannot be controlled by an agent`);
    this.name = 'UserOnlyBrowserProfileError';
    this.profileId = profileId;
  }
}

/**
 * A cookie import target must be a known, user-only profile. Thrown when the
 * requested profile is unknown or is not user-only. This is the inverse of
 * {@link UserOnlyBrowserProfileError}, which refuses agent control *of* a
 * user-only profile; here a user-only profile is *required*.
 */
export class UserOnlyBrowserProfileRequiredError extends Error {
  readonly code = 'BROWSER_PROFILE_USER_ONLY_REQUIRED';
  readonly profileId: string;

  constructor(profileId: string) {
    super(`Browser profile "${profileId}" must be a user-only profile for cookie import`);
    this.name = 'UserOnlyBrowserProfileRequiredError';
    this.profileId = profileId;
  }
}

export function resolveBrowserProfileId(
  profiles: readonly BrowserProfile[],
  requested: string | undefined,
  ownerType: BrowserProfileOwnerType,
): string {
  const requestedId = requested || DEFAULT_BROWSER_PROFILE_ID;
  const profile = profiles.find(candidate => candidate.id === requestedId)
    ?? profiles.find(candidate => candidate.id === DEFAULT_BROWSER_PROFILE_ID);
  if (!profile) return DEFAULT_BROWSER_PROFILE_ID;
  if (ownerType === 'session' && profile.userOnly === true) {
    throw new UserOnlyBrowserProfileError(profile.id);
  }
  return profile.id;
}

export function getProfilePartition(profileId: string | undefined | null): string {
  if (!profileId || profileId === DEFAULT_BROWSER_PROFILE_ID) {
    return LEGACY_PARTITION;
  }
  return `${PROFILE_PARTITION_PREFIX}${profileId}`;
}

export function isProfilePartition(partition: string): boolean {
  return partition === LEGACY_PARTITION || partition.startsWith(PROFILE_PARTITION_PREFIX);
}

export function profileIdFromPartition(partition: string): string | null {
  if (partition === LEGACY_PARTITION) return DEFAULT_BROWSER_PROFILE_ID;
  if (partition.startsWith(PROFILE_PARTITION_PREFIX)) {
    return partition.slice(PROFILE_PARTITION_PREFIX.length) || null;
  }
  return null;
}

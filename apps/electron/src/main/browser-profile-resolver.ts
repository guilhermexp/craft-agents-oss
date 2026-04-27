/**
 * Browser profile partition resolver.
 *
 * Maps a profile id to an Electron session partition string. The default
 * profile keeps the legacy `persist:browser-pane` partition so existing
 * cookies/storage survive without migration.
 */

import { DEFAULT_BROWSER_PROFILE_ID } from '@craft-agent/shared/config/types';

const LEGACY_PARTITION = 'persist:browser-pane';
const PROFILE_PARTITION_PREFIX = 'persist:browser-pane:';

export { LEGACY_PARTITION as DEFAULT_BROWSER_PROFILE_PARTITION };

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

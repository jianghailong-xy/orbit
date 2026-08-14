import { toUuid, uuidToBase62 } from '@orbit/shared';

/**
 * Any spelling of an id -> the short base62 public id, for building shareable links.
 *
 * Idempotent on purpose, and that is the whole point: the server is moving to base62 as the id it
 * hands out (docs/public-id-migration-design.md), so what `session.id` holds is a moving target.
 * Normalizing first means the 27 link-building call sites keep working across that flip without
 * being touched — the alternative was to thread a server-supplied `publicId` through every one of
 * them, which is 27 chances to miss one and get a link that throws on click.
 *
 * Still throws on a value that is neither spelling, exactly as before: a caller that cannot name
 * the thing it is linking to has a bug, and a link to nowhere hides it.
 */
export function encodeId(id: string): string {
  return uuidToBase62(toUuid(id));
}

/** Route param (base62 public id or raw UUID) -> UUID. Falls back to the raw
 *  value if it isn't decodable, so a malformed link degrades to "not found"
 *  rather than crashing the view. */
export function decodeId(param: string | null | undefined): string | null {
  if (!param) return null;
  try {
    return toUuid(param);
  } catch {
    return param;
  }
}

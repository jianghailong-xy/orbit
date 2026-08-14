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

/**
 * Route param (either spelling) -> the app's canonical internal id: the public id.
 *
 * The web asks the server for `X-Orbit-Id-Format: public`, so every id it holds — from a REST
 * payload, from an SSE frame, from a link it built — is base62. This is the one remaining place a
 * *different* spelling can enter: a bookmark from before the flip, or a link someone pasted with a
 * raw UUID in it. Normalizing here means those keep working and, more importantly, that the ~100
 * `x.id === y` comparisons scattered through the views never have to care — both sides are already
 * the same spelling, so none of them needed touching.
 *
 * Falls back to the raw value if it is neither spelling, so a malformed link degrades to "not
 * found" rather than crashing the view.
 */
export function routeId(param: string | null | undefined): string | null {
  if (!param) return null;
  try {
    return encodeId(param);
  } catch {
    return param;
  }
}

/** Either spelling -> UUID. Now only for storage keys that must stay stable across the flip
 *  (see transcriptStore); route params go through `routeId` instead. */
export function decodeId(param: string | null | undefined): string | null {
  if (!param) return null;
  try {
    return toUuid(param);
  } catch {
    return param;
  }
}

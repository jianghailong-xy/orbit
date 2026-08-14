import { Prisma } from '@prisma/client';
import { RunEventType } from '@orbit/shared';

/**
 * `system` subtypes anything actually reads. The runner forwards every Claude Code / Codex
 * `system` message verbatim (claude.go), so the stream also carries per-token progress pings
 * (`thinking_tokens`, `status`, `task_progress`, …) that nothing renders — the macOS reducer
 * files them under "lifecycle noise — no transcript item", and web only ever looks for
 * `resumed`. `init`/`resumed` are the two with real consumers: runtimeInitSessionId reads the
 * runtime's own session id off them, and `resumed` clears the running background/sub-workspace sets.
 */
const MEANINGFUL_SYSTEM_SUBTYPES = new Set(['init', 'resumed']);

/**
 * The three keys a bare progress ping carries — `{model, subtype, sessionId}`, and nothing else.
 * `model` has never once been non-null on one of these and `sessionId` only repeats the runtime
 * id already recorded on the session (from the init/resumed event), so an event holding just
 * these conveys nothing that isn't already known elsewhere.
 */
const PING_KEYS = new Set(['model', 'subtype', 'sessionId']);

/**
 * Is this a `system` event carrying nothing anyone could use? These are ~92% of all stored
 * run_events and three quarters of every transcript page, which both inflates the bytes a client
 * downloads on open and — because pages are capped by event *count* — starves the tail page of
 * real content (a 200-event page holds ~47 things the user could actually see).
 *
 * They are still PERSISTED in full: run_event stays the complete archive of what the runtime
 * emitted. This predicate gates only what crosses the wire — the live broadcast and the two read
 * paths (see `notNoiseSql`, which must select exactly the complement of this function).
 *
 * Keyed on the payload's SHAPE, not on a list of known-boring subtypes. Codex streams its
 * stderr as `system` events with no subtype at all (codex.go / codex_appserver.go) — "No
 * conversation found with session ID…", "Session ID … is already in use" — which no client
 * renders but which is the only record of why a runtime failed to come up. A subtype blocklist
 * would have swallowed those; requiring "the payload holds nothing but the ping keys" keeps
 * them, and keeps any future system event that carries real content too.
 *
 * Filtering them out of a replay leaves holes in the `seq` the client sees, which is already
 * normal: streaming deltas are broadcast but never persisted, so clients order and dedup by seq
 * without assuming it's gapless.
 */
export function isNoiseSystemEvent(e: { type: string; payload?: unknown }): boolean {
  if (e.type !== RunEventType.SYSTEM) return false;
  const p = e.payload;
  if (!p || typeof p !== 'object') return true; // an empty system event says nothing at all
  const record = p as Record<string, unknown>;
  const subtype = record.subtype;
  if (typeof subtype === 'string' && MEANINGFUL_SYSTEM_SUBTYPES.has(subtype)) return false;
  return Object.keys(record).every((k) => PING_KEYS.has(k));
}

/**
 * The SQL complement of `isNoiseSystemEvent`, for the read paths that page/replay run_event.
 * Applied in the query rather than after it so a `tail=200` page comes back holding 200 events
 * the client can render — filtering in JS would return whatever survived out of 200 rows (~47)
 * and make `hasMore` describe the wrong thing.
 *
 * `payload - 'model' - 'subtype' - 'sessionId' = '{}'` is the jsonb spelling of "holds nothing
 * but the ping keys". Kept literally in step with the function above; system-noise.spec.ts
 * checks both against the same payloads.
 */
export const notNoiseSql = Prisma.sql`NOT (
  type = 'system'
  AND COALESCE(payload->>'subtype', '') NOT IN ('init', 'resumed')
  AND (payload - 'model' - 'subtype' - 'sessionId') = '{}'::jsonb
)`;

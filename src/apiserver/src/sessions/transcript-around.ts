import { Prisma } from '@prisma/client';
import { replayableEventSql } from '../common/system-noise';
import { truncatePayload } from './truncate-payload';

/**
 * Reading a transcript from the middle: the page around one record, and the pages either side of it.
 *
 * The transcript is read tail-first (`GET /sessions/:id/events/page?tail=N`), so a record from early
 * in a long session is dozens of pages from where the session opens. A link that names one record —
 * a wiki footnote's location link (criterion 10 v2) — needs the page that record sits in, directly,
 * and a way to page out from it in both directions until the reader meets the tail they stream live.
 */

/** A run_event row as the page queries select it. */
export interface PageRow {
  seq: number;
  type: string;
  payload: unknown;
  turnId: string | null;
  createdAt: Date;
}

/** One event of a page, as every page read answers it. */
export interface PageEvent {
  seq: number;
  type: string;
  payload: unknown;
  turnId: string | null;
  ts: Date;
  truncated?: true;
}

/** A row as a page carries it: `maxPayload` clips bulky tool bodies to a preview (truncate-payload). */
export function toPageEvent(row: PageRow, maxPayload: number | undefined): PageEvent {
  const cut = maxPayload
    ? truncatePayload(row.type, row.payload, maxPayload)
    : { payload: row.payload, truncated: false };
  return {
    seq: row.seq,
    type: row.type,
    payload: cut.payload,
    turnId: row.turnId ?? null,
    ts: row.createdAt,
    ...(cut.truncated ? { truncated: true as const } : {}),
  };
}

/**
 * A page read from the middle of a transcript (`around=` or `after=`): the events, seq ascending, and a
 * cursor each way. `before` is what to pass as `before=` for the page older than this one and `after`
 * what to pass as `after=` for the page newer; null when that direction has nothing more. `hasMore`
 * keeps the meaning it has on every page — older events remain — so it is `before !== null`.
 */
export interface TranscriptPage {
  events: PageEvent[];
  hasMore: boolean;
  before: number | null;
  after: number | null;
}

/** The records a link can name inside a transcript: the three first-hand kinds a wiki source cites. */
export type TranscriptRecordKind = 'turn' | 'event' | 'tool_call';

/** The record a page was read around, and the seq it sits at in the transcript. */
export interface TranscriptAnchor {
  kind: TranscriptRecordKind;
  id: string;
  seq: number;
}

/**
 * The seq a record sits at in its session's transcript, or no row when it is not this session's.
 *
 * One query answers all three kinds — a record id is a UUIDv7 and names exactly one row of one table —
 * and every branch is keyed by the session as well as the id, so a record of another session (and so
 * of another owner) resolves to nothing:
 *
 *   - an event is its own row;
 *   - a turn is its `user` event — the message as it entered the transcript — or, for a turn whose
 *     echo never arrived, the first event the turn produced;
 *   - a tool call is its `tool_use` event, joined by the runtime's tool_use id — or its result, for a
 *     call whose use is not in the stream.
 *
 * A turn or a tool call the transcript shows nothing of resolves with a null seq: the record is real
 * but has nowhere to be scrolled to, and the caller answers it as the absent record it is to a reader.
 */
export function transcriptAnchorSql(sessionId: string, recordId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT 'event' AS "kind", e.seq AS "seq"
      FROM run_event e
     WHERE e.id = ${recordId}::uuid AND e.session_id = ${sessionId}::uuid
    UNION ALL
    SELECT 'turn' AS "kind", (
             SELECT e.seq
               FROM run_event e
              WHERE e.session_id = ${sessionId}::uuid
                AND e.turn_id = t.id
                AND ${replayableEventSql}
              ORDER BY (e.type = 'user') DESC, e.seq ASC
              LIMIT 1
           ) AS "seq"
      FROM conversation_turn t
     WHERE t.id = ${recordId}::uuid AND t.session_id = ${sessionId}::uuid
    UNION ALL
    SELECT 'tool_call' AS "kind", (
             SELECT e.seq
               FROM run_event e
              WHERE e.session_id = ${sessionId}::uuid
                AND (
                  (e.type = 'tool_use' AND e.payload->>'id' = c.tool_use_id)
                  OR (e.type = 'tool_result' AND e.payload->>'toolUseId' = c.tool_use_id)
                )
              ORDER BY (e.type = 'tool_use') DESC, e.seq ASC
              LIMIT 1
           ) AS "seq"
      FROM tool_call c
     WHERE c.id = ${recordId}::uuid AND c.session_id = ${sessionId}::uuid
  `;
}

/**
 * The page around an anchor, cut from the rows either side of it: `older` newest-first (seq below
 * the anchor), `newer` oldest-first (the anchor's own seq and above), each read one row past `take`.
 *
 * Half the page goes to each side, and a side that runs out hands its room to the other — so a record
 * near either end of the session still comes back in a full page rather than half of one. A side's
 * cursor is set exactly when rows remain past what the page kept.
 */
export function pageAround<T extends { seq: number }>(
  older: readonly T[],
  newer: readonly T[],
  take: number,
): { events: T[]; before: number | null; after: number | null } {
  let olderKept = Math.min(older.length, Math.floor(take / 2));
  const newerKept = Math.min(newer.length, take - olderKept);
  olderKept = Math.min(older.length, take - newerKept);
  const events = [...older.slice(0, olderKept).reverse(), ...newer.slice(0, newerKept)];
  const first = events[0]?.seq ?? null;
  const last = events[events.length - 1]?.seq ?? null;
  return {
    events,
    before: older.length > olderKept ? first : null,
    after: newer.length > newerKept ? last : null,
  };
}

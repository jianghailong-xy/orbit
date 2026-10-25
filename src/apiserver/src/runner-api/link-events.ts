import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { toUuid, type NormalizedRunEvent, type RunEventType } from '@orbit/shared';

import { NON_REPLAYABLE_EVENT_TYPES, TOMBSTONE_EVENT_TYPE } from '../common/system-noise';
import { classifyTransactionFault } from '../common/transaction-retry';
import { stripNul } from './strip-nul';

/**
 * Durable events over the runner link (docs/runner-link-design.md §5.8, §6.6): what a link call to the events route
 * takes, and what it answers with.
 *
 * The link gateway forwards each EventBatch as the body a runner posts over HTTPS (src/link-gateway/events.go), and
 * the route stores it with the ingest HTTPS uses (RunnerApiController.ingestEvents). What the link adds is that one
 * event the server will not store no longer fails its batch. It is refused on its own: a tombstone row holds its seq,
 * the events after it are stored as usual, and the answer names it (proto `EventAck.rejected`). The session's events
 * stay numbered without a hole, and the runner never sends the refused one again.
 *
 * An event is refused here, before anything is written, when it is not one the ingest can store: a type that is not a
 * word, a live stream event sent as a durable one, a time that is not one, a turn id that names no turn, a payload that
 * is not a JSON object. One the database refuses a value of is found by RunnerApiController.storeLinkEvents and refused
 * as EVENT_UNSTORABLE. A batch that is not one at all (no events, or seqs that do not count up by one) is refused
 * whole: without a seq there is nothing a tombstone could hold.
 *
 * A noise ping (common/system-noise.ts) is not refused. It is acknowledged and not stored, as over HTTPS, so
 * durable_seq goes past it.
 */

/** Why an event was refused, as EventAck.rejected[].code says it. */
export type LinkEventRejection =
  | 'EVENT_TYPE_INVALID'
  | 'EVENT_LIVE_ONLY'
  | 'EVENT_TS_INVALID'
  | 'EVENT_TURN_ID_INVALID'
  | 'EVENT_PAYLOAD_INVALID'
  | 'EVENT_UNSTORABLE';

/** An event the server would not store (proto `RejectedEvent`). */
export interface RejectedLinkEvent {
  seq: number;
  code: LinkEventRejection;
  /** Detail for logs, in English. */
  message: string;
}

/** The row that holds a refused event's seq, with what is legible of the event. */
export interface LinkTombstone extends RejectedLinkEvent {
  /** The event's type, when it was a word. */
  type: string | null;
  turnId: string | null;
  /** When the runner recorded the event, when it said so legibly; otherwise when it was received. */
  at: Date;
}

/** A link batch, checked. */
export interface LinkEventBatch {
  /** The events the ingest stores, sanitized as HTTPS sanitizes them (strip-nul.ts). */
  events: NormalizedRunEvent[];
  /** The events refused on sight, in seq order. */
  tombstones: LinkTombstone[];
  /** The batch's first seq. */
  firstSeq: number;
  /** The batch's last seq: once the batch is stored, every event of the session up to it is. */
  lastSeq: number;
}

/** What a link call to the events route answers: what EventAck says (proto `EventAck`). */
export interface LinkEventsAnswer {
  ok: true;
  durableSeq: number;
  rejected: RejectedLinkEvent[];
}

/** What a batch that is not one is answered with. */
export const EVENT_BATCH_MALFORMED = 'EVENT_BATCH_MALFORMED';

/** `run_event.seq` is an int4. */
const MAX_SEQ = 2_147_483_647;
/** An event type is a word; every one a runner sends is short snake case. */
const EVENT_TYPE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** The last moment a timestamp column takes as a four-digit year. */
const LAST_TS_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/**
 * Reads a link call's batch: the events to store, and those refused on sight. Throws 400 EVENT_BATCH_MALFORMED,
 * retryable as the gateway's own refusal of a malformed batch is, when it is not a batch of events numbered one after
 * another.
 */
export function readLinkEventBatch(body: unknown, now: Date = new Date()): LinkEventBatch {
  const raw = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(raw) || raw.length === 0) malformed('the batch has no events');
  // Sanitized as HTTPS sanitizes a batch, before anything is read off it (runner-api.controller.ts `events`).
  const listed = stripNul(raw as unknown[]);
  const events: NormalizedRunEvent[] = [];
  const tombstones: LinkTombstone[] = [];
  let previous = 0;
  listed.forEach((item, index) => {
    const event = (item ?? {}) as Record<string, unknown>;
    const seq = event.seq;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || seq > MAX_SEQ) {
      malformed(`event ${index}: seq ${JSON.stringify(seq) ?? 'undefined'} is not an event seq from 1 to ${MAX_SEQ}`);
    }
    if (index > 0 && seq !== previous + 1) malformed(`seq ${previous} is followed by ${seq}`);
    previous = seq;

    const type = typeof event.type === 'string' && EVENT_TYPE.test(event.type) ? event.type : null;
    const at = timeOf(event.ts);
    const turnId = turnIdOf(event.turnId);
    const refuse = (code: LinkEventRejection, message: string): void => {
      tombstones.push({ seq, code, message, type, turnId: turnId ?? null, at: at ?? now });
    };
    if (type === null) {
      refuse('EVENT_TYPE_INVALID', 'the type is not a word of at most 64 letters, digits and _.:-');
    } else if (type === TOMBSTONE_EVENT_TYPE) {
      refuse('EVENT_TYPE_INVALID', `${TOMBSTONE_EVENT_TYPE} is a type only the server writes`);
    } else if (NON_REPLAYABLE_EVENT_TYPES.includes(type)) {
      refuse('EVENT_LIVE_ONLY', `${type} is a live event: it travels in a LiveBatch, and is never stored`);
    } else if (at === null) {
      refuse('EVENT_TS_INVALID', 'ts is not a time from 1970 to 9999');
    } else if (turnId === undefined) {
      refuse('EVENT_TURN_ID_INVALID', 'turnId does not name a turn');
    } else if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      refuse('EVENT_PAYLOAD_INVALID', 'the payload is not a JSON object');
    } else {
      events.push({
        seq,
        type: type as RunEventType,
        ts: event.ts as string,
        ...(turnId ? { turnId } : {}),
        payload: event.payload as Record<string, unknown>,
      });
    }
  });
  return { events, tombstones, firstSeq: (listed[0] as { seq: number }).seq, lastSeq: previous };
}

/** An event's time, or null when its ts is not one a timestamp column takes. */
function timeOf(ts: unknown): Date | null {
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) && ms >= 0 && ms <= LAST_TS_MS ? new Date(ms) : null;
}

/** An event's turn as a UUID: null for none, undefined for a value that names no turn. */
function turnIdOf(turnId: unknown): string | null | undefined {
  if (turnId === undefined || turnId === null || turnId === '') return null;
  if (typeof turnId !== 'string') return undefined;
  try {
    return toUuid(turnId);
  } catch {
    return undefined;
  }
}

function malformed(message: string): never {
  throw new BadRequestException({
    code: EVENT_BATCH_MALFORMED,
    message: `This is not a batch of events numbered one after another: ${message}.`,
    retryable: true,
    retryAfterMs: 1_000,
  });
}

/** The run_event row that holds a refused event's seq, written in the ingest's transaction. */
export function tombstoneRow(
  tombstone: LinkTombstone,
  sessionId: string,
  runnerId: string,
  leaseOwner: string | null,
): Prisma.RunEventCreateManyInput {
  return {
    sessionId,
    seq: tombstone.seq,
    type: TOMBSTONE_EVENT_TYPE,
    payload: {
      code: tombstone.code,
      message: tombstone.message,
      ...(tombstone.type ? { type: tombstone.type } : {}),
    },
    turnId: tombstone.turnId,
    createdAt: tombstone.at,
    ingestedByRunnerId: runnerId,
    ingestedUnderLeaseGeneration: leaseOwner,
  };
}

/** A tombstone row read back as the refusal it holds: what EventAck.rejected said of it when it was written. */
export function rejectionOf(row: { seq: number; payload: unknown }): RejectedLinkEvent {
  const payload = (row.payload ?? {}) as { code?: unknown; message?: unknown };
  return {
    seq: row.seq,
    code: String(payload.code ?? 'EVENT_UNSTORABLE') as LinkEventRejection,
    message: String(payload.message ?? ''),
  };
}

/** The tombstone of an event the database refused a value of. */
export function unstorableTombstone(event: NormalizedRunEvent, sqlState: string): LinkTombstone {
  return {
    seq: event.seq,
    code: 'EVENT_UNSTORABLE',
    message: `the database refused a value of this event (SQLSTATE ${sqlState})`,
    type: event.type,
    turnId: event.turnId ?? null,
    at: new Date(event.ts),
  };
}

/**
 * The SQLSTATE classes that are the database refusing a value: 22, a data exception (text a uuid or jsonb column
 * cannot read, a character it cannot hold, a number or a time out of range), and 54, a program limit (an index row too
 * large). Both are about the values of one row. Unlike a failure of the connection, the transaction or the code, the
 * same row meets the same refusal however often it is sent.
 */
const VALUE_REFUSED = /^(?:22|54)[0-9A-Z]{3}$/;
/** A cause chain is data from a library; its depth and width are bounded. */
const MAX_CAUSE_DEPTH = 8;
const MAX_CAUSE_NODES = 32;

/**
 * The SQLSTATE of a value the database refused, found anywhere in an error's cause chain (Prisma 7 keeps PostgreSQL's
 * code at `meta.driverAdapterError.cause.originalCode`), or null for any other failure. What the transaction retry
 * reads as the database failing or aborting the transaction, or as an answer some layer already gave (an
 * HttpException: the ingest refusing the batch), is never one (classifyTransactionFault).
 */
export function refusedValueState(error: unknown): string | null {
  const { family } = classifyTransactionFault(error);
  if (family === 'TRANSIENT' || family === 'RESOURCE' || family === 'ANSWERED') return null;
  const seen = new Set<unknown>();
  let level: unknown[] = [error];
  let visited = 0;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && level.length > 0; depth += 1) {
    const next: unknown[] = [];
    for (const node of level) {
      if (!node || typeof node !== 'object' || seen.has(node) || visited >= MAX_CAUSE_NODES) continue;
      seen.add(node);
      visited += 1;
      const record = node as Record<string, unknown>;
      for (const field of ['code', 'originalCode']) {
        const code = record[field];
        if (typeof code === 'string' && VALUE_REFUSED.test(code)) return code;
      }
      next.push(record.cause);
      const meta = record.meta;
      if (meta && typeof meta === 'object') next.push(...Object.values(meta as Record<string, unknown>));
    }
    level = next;
  }
  return null;
}

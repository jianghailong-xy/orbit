import type { KeyObject } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import type { ManagedRunnerManagementState, Prisma } from '@prisma/client';
import { toUuid, type NormalizedRunEvent, type RunEventType } from '@orbit/shared';

import { NON_REPLAYABLE_EVENT_TYPES, TOMBSTONE_EVENT_TYPE } from '../common/system-noise';
import { classifyTransactionFault } from '../common/transaction-retry';
import { managedRunnerInstanceOffer, managedRunnerInstanceVerdict } from '../managed-runners/managed-runner-instance';
import { runnerLinkCredential, RunnerLinkTokenRefused, verifyRunnerLinkToken } from './runner-link-token';
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
 *
 * A link batch is stored once per seq, with everything derived from it (RunnerApiController.ingestEvents). A batch
 * sent again, or a copy of it another backend takes at the same time, writes no row twice and is answered as it was
 * the first time: the same durable_seq, and the same rejected, read back from its tombstones (rejectionOf).
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
  return sqlStateIn(error, VALUE_REFUSED);
}

/**
 * What a merged link call's transaction is cut short by: its own lock timeout (55P03) and statement timeout (57014),
 * LINK_CALL_LOCK_TIMEOUT_MS and LINK_CALL_STATEMENT_TIMEOUT_MS in RunnerApiController.
 */
const CUT_SHORT = /^(?:55P03|57014)$/;

/** Whether a merged link call's transaction was cut short by its own timeouts: its batches are then sent alone. */
export function linkCallCutShort(error: unknown): boolean {
  return sqlStateIn(error, CUT_SHORT) !== null;
}

/** The first SQLSTATE matching `pattern` anywhere in an error's cause chain, or null. */
function sqlStateIn(error: unknown, pattern: RegExp): string | null {
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
        if (typeof code === 'string' && pattern.test(code)) return code;
      }
      next.push(record.cause);
      const meta = record.meta;
      if (meta && typeof meta === 'object') next.push(...Object.values(meta as Record<string, unknown>));
    }
    level = next;
  }
  return null;
}

/**
 * The link gateway's merged call (docs/runner-link-design.md §6.6, §6.7): POST /runner/link/events
 * (RunnerLinkEventsController) takes the EventBatches a gateway collected from any of its connections for a short
 * window (src/link-gateway/events_merge.go) in ONE transaction (RunnerApiController.ingestLinkEventCall), where each
 * would otherwise be one call to the events route and one transaction of its own.
 *
 * Each batch is the body the gateway would forward alone, beside the connection it came on: the runner's link token
 * and what its Hello declared, which RunnerAuthGuard reads off a link call's headers. Each is answered in the order
 * asked, either as the events route answers it over the link (LinkEventsAnswer), or `sendAlone`: this call did not take
 * it and wrote nothing of it, and the gateway forwards it to the events route on its own, which answers it as it
 * always has. That is how everything a batch can be refused for, or fail of, is answered: exactly as before this call
 * existed.
 */

/** One connection of a merged call: what every call forwarded for it carries (src/link-gateway/link.go `headers`). */
export interface LinkEventCallConnection {
  /** The link token the runner connected with (X-Orbit-Runner-Link-Token): it names the runner and the process. */
  linkToken: string;
  /** The other headers a call forwarded for the connection carries, by their lowercase names. */
  headers: Record<string, string>;
}

/** One session's EventBatch in a merged call: the events route's body for it, and the connection it came on. */
export interface LinkEventCallBatch {
  /** Its connection, by index in `connections`. */
  connection: number;
  /** As the events route's path names it: a UUID or a public id. */
  sessionId: string;
  events: unknown;
}

export interface LinkEventCall {
  connections: LinkEventCallConnection[];
  batches: LinkEventCallBatch[];
}

/** A batch the merged call did not take: nothing of it was written, and it is to be forwarded on its own. */
export interface LinkEventSentAlone {
  sendAlone: true;
}

export type LinkEventCallResult = LinkEventsAnswer | LinkEventSentAlone;

/** What the merged call answers. */
export interface LinkEventCallAnswer {
  /** One for each batch, in the order asked. */
  results: LinkEventCallResult[];
  /** How long the call's transaction held the sessions it locked, until its commit, in milliseconds: 0 for none. */
  heldMs: number;
}

/** What a body that is not a merged call is answered with: the gateway then forwards each of its batches alone. */
export const LINK_EVENT_CALL_MALFORMED = 'LINK_EVENT_CALL_MALFORMED';

/**
 * How many batches, and connections, one merged call may carry. Each batch is a session the call's transaction holds
 * FOR UPDATE until it commits, so this bounds how long a user's message or a turn completion of any of them can wait
 * behind one call; the gateway asks for fewer (LINK_EVENT_MERGE_MAX_BATCHES).
 */
export const MAX_LINK_CALL_BATCHES = 256;

/** What a link token or one connection's headers may weigh: far more than any the gateway forwards. */
const MAX_LINK_TOKEN_CHARS = 8_192;
const MAX_CONNECTION_HEADERS = 64;
const MAX_HEADER_CHARS = 16_384;

/** Reads a merged call. Throws 400 LINK_EVENT_CALL_MALFORMED when it is not one; a batch it carries is read later. */
export function readLinkEventCall(body: unknown): LinkEventCall {
  const call = (body ?? {}) as { connections?: unknown; batches?: unknown };
  const { connections, batches } = call;
  if (!Array.isArray(connections) || connections.length === 0 || connections.length > MAX_LINK_CALL_BATCHES) {
    callMalformed(`connections is a list of 1 to ${MAX_LINK_CALL_BATCHES} connections`);
  }
  if (!Array.isArray(batches) || batches.length === 0 || batches.length > MAX_LINK_CALL_BATCHES) {
    callMalformed(`batches is a list of 1 to ${MAX_LINK_CALL_BATCHES} batches`);
  }
  const read: LinkEventCall = { connections: [], batches: [] };
  connections.forEach((item, index) => {
    const connection = (item ?? {}) as { linkToken?: unknown; headers?: unknown };
    const token = connection.linkToken;
    if (typeof token !== 'string' || token === '' || token.length > MAX_LINK_TOKEN_CHARS) {
      callMalformed(`connection ${index} names no link token`);
    }
    const headers: Record<string, string> = {};
    if (connection.headers !== undefined) {
      const given = connection.headers;
      if (!given || typeof given !== 'object' || Array.isArray(given) || Object.keys(given).length > MAX_CONNECTION_HEADERS) {
        callMalformed(`connection ${index}: headers is an object of at most ${MAX_CONNECTION_HEADERS} strings`);
      }
      for (const [name, value] of Object.entries(given as Record<string, unknown>)) {
        if (typeof value !== 'string' || value.length > MAX_HEADER_CHARS) callMalformed(`connection ${index}: header ${name} is not a string`);
        headers[name.toLowerCase()] = value;
      }
    }
    read.connections.push({ linkToken: token, headers });
  });
  batches.forEach((item, index) => {
    const batch = (item ?? {}) as { connection?: unknown; sessionId?: unknown; events?: unknown };
    const connection = batch.connection;
    if (typeof connection !== 'number' || !Number.isInteger(connection) || connection < 0 || connection >= read.connections.length) {
      callMalformed(`batch ${index} names no connection of this call`);
    }
    if (typeof batch.sessionId !== 'string') callMalformed(`batch ${index} names no session`);
    read.batches.push({ connection, sessionId: batch.sessionId, events: batch.events });
  });
  return read;
}

function callMalformed(message: string): never {
  throw new BadRequestException({
    code: LINK_EVENT_CALL_MALFORMED,
    message: `This is not a merged call of event batches: ${message}.`,
    retryable: false,
  });
}

/** A connection of a merged call that RunnerAuthGuard would admit: whose batches they are. */
export interface AdmittedLinkConnection {
  runnerId: string;
  ownerId: string;
  /** The process the link token was minted for, which every batch of the connection is fenced to (linkEvents). */
  leaseOwner: string;
}

/** What admitting a connection reads of its runner: the runner, its owner's state, its managed instance's mapping. */
interface LinkCallRunnerRow {
  id: string;
  ownerId: string;
  tokenHash: string;
  disabledAt: Date | null;
  mappingId: string | null;
  generation: number | null;
  podUid: string | null;
  managementState: string | null;
}

/**
 * Admits a merged call's connections as RunnerAuthGuard admits a link call, with ONE read for every runner they name:
 * the link token verified with the link's public key; the runner it names read with its owner's state and its
 * managed instance's mapping; the runner still holding the credential the token was minted with (the revocation the
 * gateway learns of by polling is exact here, as there); its owner's account not disabled; a managed runner's instance
 * the one its mapping authorizes for the headers the connection's calls carry. Null for a connection the guard would
 * refuse: its batches are sent alone, where the guard refuses them as it always has.
 */
export async function admitLinkCallConnections(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  publicKey: KeyObject,
  connections: readonly LinkEventCallConnection[],
  now: Date,
): Promise<Array<AdmittedLinkConnection | null>> {
  const claims = connections.map((connection) => {
    try {
      return verifyRunnerLinkToken(connection.linkToken, publicKey, now);
    } catch (error) {
      if (error instanceof RunnerLinkTokenRefused) return null;
      throw error;
    }
  });
  const runnerIds = [...new Set(claims.flatMap((claim) => (claim ? [claim.runnerId] : [])))];
  if (runnerIds.length === 0) return connections.map(() => null);
  const rows = await tx.$queryRaw<LinkCallRunnerRow[]>`
    SELECT r."id"::text AS "id", r."owner_id"::text AS "ownerId", r."token_hash" AS "tokenHash",
           u."disabled_at" AS "disabledAt",
           m."id"::text AS "mappingId", m."generation" AS "generation", m."pod_uid" AS "podUid",
           m."management_state"::text AS "managementState"
      FROM "runner" r
      JOIN "user" u ON u."id" = r."owner_id"
      LEFT JOIN "managed_runner" m ON m."runner_id" = r."id"
     WHERE r."id" = ANY(${runnerIds}::uuid[])
  `;
  const runners = new Map(rows.map((row) => [row.id, row]));
  return connections.map((connection, index) => {
    const claim = claims[index];
    const runner = claim ? runners.get(claim.runnerId) : undefined;
    if (!claim || !runner || runnerLinkCredential(runner.tokenHash) !== claim.credential) return null;
    if (runner.disabledAt) return null;
    if (runner.mappingId !== null) {
      const verdict = managedRunnerInstanceVerdict(
        {
          id: runner.mappingId,
          generation: Number(runner.generation),
          podUid: runner.podUid,
          managementState: runner.managementState as ManagedRunnerManagementState,
        },
        managedRunnerInstanceOffer(connection.headers),
      );
      if (!verdict.authorized) return null;
    }
    return { runnerId: runner.id, ownerId: runner.ownerId, leaseOwner: claim.leaseOwner };
  });
}

/**
 * The seqs the sessions of a merged call already hold a row at, an event's or a tombstone's, within each one's batch:
 * RunnerApiController.storedSeqs for every session in one statement, read inside the call's transaction once its
 * sessions are locked, so a copy another backend took first is seen as it committed.
 */
export async function storedLinkCallSeqs(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  batches: ReadonlyArray<{ sessionId: string; firstSeq: number; lastSeq: number }>,
): Promise<Map<string, Set<number>>> {
  const stored = new Map<string, Set<number>>(batches.map((batch) => [batch.sessionId, new Set<number>()]));
  if (batches.length === 0) return stored;
  const rows = await tx.$queryRaw<Array<{ sessionId: string; seq: number }>>`
    SELECT e."session_id"::text AS "sessionId", e."seq" AS "seq"
      FROM unnest(
             ${batches.map((batch) => batch.sessionId)}::uuid[],
             ${batches.map((batch) => batch.firstSeq)}::int[],
             ${batches.map((batch) => batch.lastSeq)}::int[]
           ) AS b(session_id, first_seq, last_seq)
      JOIN "run_event" e ON e."session_id" = b.session_id AND e."seq" BETWEEN b.first_seq AND b.last_seq
  `;
  for (const row of rows) stored.get(row.sessionId)?.add(Number(row.seq));
  return stored;
}

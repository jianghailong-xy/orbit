import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The receipt of one `project_create` or `session_create` request (docs/recovery-contract.md §7,
 * migration 0645).
 *
 * The runner names every create it sends with `X-Orbit-Request-Id`, drawn once per tool call or CLI
 * invocation and kept across every resend of it. What the server cannot tell apart on its own is a
 * repeat of a request whose answer was lost and a second request that happens to say the same
 * thing: the bytes are equal. The id says which. So the first delivery of an id claims a row before
 * it creates anything and keeps the answer on it; a repeat with the same id and the same payload is
 * answered from that row, concurrent or later, and never creates a second Project or Session. The
 * same id with a different payload is refused: one name cannot mean two requests.
 *
 * A request with no id writes no row and is the create it always was, so a runner that predates the
 * header is unaffected.
 *
 * When the delivery that holds the row fails in a way that may have written (anything but a 4xx
 * refusal), or dies while holding it, the row says UNKNOWN for good: a repeat is told the outcome is
 * unknown and to look before creating under a new id, rather than being let through to create a
 * second one. The narrow window that leaves is a create that committed and a receipt write that did
 * not; it is answered the same conservative way.
 */

export const REQUEST_ID_HEADER = 'x-orbit-request-id';

export type CreateRequestKind = 'PROJECT_CREATE' | 'SESSION_CREATE';

/** What every answer to a named create carries beside the created row. */
export interface CreateRequestReceipt {
  requestId: string;
  kind: CreateRequestKind;
  /** The Project or Session id the request created (or the held request's id), base62. */
  resourceId: string | null;
  /** When the request was first received. The same on every repeat. */
  receivedAt: string;
  /** False on the delivery that created it, true on every answer read back from the receipt. */
  replayed: boolean;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** How long a delivery creating under an id is waited for before its row reads as UNKNOWN. */
export const CREATE_REQUEST_LEASE_MS = 120_000;
/** How long a concurrent repeat waits for the first delivery's answer before it says IN_PROGRESS. */
export let createRequestReplayWaitMs = 10_000;
const REPLAY_POLL_MS = 100;

/** For specs: how long a concurrent repeat waits. */
export function setCreateRequestReplayWaitForTest(ms: number): void {
  createRequestReplayWaitMs = ms;
}

/** The request id a header carries, `undefined` when there is none, refused when it is malformed. */
export function readRequestId(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw new BadRequestException({
      code: 'REQUEST_ID_INVALID',
      message: `${REQUEST_ID_HEADER} must be 1 to 200 characters of letters, digits, '.', '_', ':' or '-'`,
      recovery: { effect: 'NONE', retryPolicy: 'NEVER', actionCode: 'FIX_REQUEST' },
    });
  }
  return value;
}

/** Keys sorted at every level, so two equal payloads hash the same whatever order they were built in. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function createRequestFingerprint(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}

/** The answer as JSON: dates as ISO strings, BigInt as a decimal string, as the response itself spells them. */
function storable(result: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(result ?? null, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)),
  ) as Prisma.InputJsonValue;
}

/** The created row's id, in the public spelling the `id` beside it is answered in. */
function resourceIdOf(result: unknown): string | null {
  const id = (result as { id?: unknown } | null)?.id;
  if (typeof id !== 'string') return null;
  try {
    return uuidToBase62(id);
  } catch {
    return id;
  }
}

function withReceipt<T>(result: T, receipt: CreateRequestReceipt): T & { requestReceipt: CreateRequestReceipt } {
  const base = result && typeof result === 'object' && !Array.isArray(result) ? result : { result };
  return { ...(base as object), requestReceipt: receipt } as T & { requestReceipt: CreateRequestReceipt };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class CreateRequestReceipts {
  private readonly logger = new Logger(CreateRequestReceipts.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Run `create` at most once per (owner, kind, requestId). `payload` is what the request says,
   * including the calling session: the same id with another payload is refused.
   */
  async run<T>(
    ownerId: string,
    kind: CreateRequestKind,
    requestId: string | undefined,
    payload: unknown,
    create: () => Promise<T>,
  ): Promise<T | (T & { requestReceipt: CreateRequestReceipt })> {
    if (!requestId) return create();
    const fingerprint = createRequestFingerprint(payload);
    const deadline = Date.now() + createRequestReplayWaitMs;
    for (;;) {
      const claimedAt = await this.claim(ownerId, kind, requestId, fingerprint);
      if (claimedAt) return this.createUnder(ownerId, kind, requestId, fingerprint, claimedAt, create);
      const row = await this.prisma.createRequestReceipt.findUnique({
        where: { ownerId_actionKind_requestToken: { ownerId, actionKind: kind, requestToken: requestId } },
      });
      // Gone: the delivery that held it was refused and wrote nothing. This one asks again.
      if (!row) continue;
      if (row.fingerprint !== fingerprint) throw CreateRequestReceipts.reused(kind, requestId);
      if (row.status === 'COMPLETED') {
        return withReceipt(row.result as T, {
          requestId,
          kind,
          resourceId: resourceIdOf(row.result),
          receivedAt: row.createdAt.toISOString(),
          replayed: true,
        });
      }
      if (row.status === 'UNKNOWN' || row.leaseExpiresAt.getTime() <= Date.now()) {
        throw CreateRequestReceipts.outcomeUnknown(kind, requestId);
      }
      if (Date.now() >= deadline) throw CreateRequestReceipts.inProgress(kind, requestId);
      await sleep(REPLAY_POLL_MS);
    }
  }

  /** The row for this id, made by this delivery: its received time, or null when another delivery has it. */
  private async claim(ownerId: string, kind: CreateRequestKind, requestId: string, fingerprint: string): Promise<Date | null> {
    try {
      const row = await this.prisma.createRequestReceipt.create({
        data: {
          ownerId,
          actionKind: kind,
          requestToken: requestId,
          fingerprint,
          status: 'OPEN',
          leaseExpiresAt: new Date(Date.now() + CREATE_REQUEST_LEASE_MS),
        },
      });
      return row.createdAt;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
      throw error;
    }
  }

  private async createUnder<T>(
    ownerId: string,
    kind: CreateRequestKind,
    requestId: string,
    fingerprint: string,
    receivedAt: Date,
    create: () => Promise<T>,
  ): Promise<T & { requestReceipt: CreateRequestReceipt }> {
    const key = { ownerId, actionKind: kind, requestToken: requestId };
    let result: T;
    try {
      result = await create();
    } catch (error) {
      // A 4xx is a refusal that wrote nothing: the id is free again, so the same request may be asked
      // again once whatever refused it has changed. Anything else may have written, so it stays UNKNOWN.
      const refused = error instanceof HttpException && error.getStatus() < 500;
      await this.settleFailed(key, fingerprint, refused);
      throw error;
    }
    try {
      await this.prisma.createRequestReceipt.updateMany({
        where: { ...key, fingerprint, status: 'OPEN' },
        data: { status: 'COMPLETED', result: storable(result) },
      });
    } catch (error) {
      // The create stands and this answer reports it. A repeat finds the row OPEN until its lease runs
      // out and then UNKNOWN: told to look, never let through to create a second one.
      this.logger.error(`${kind} ${requestId}: keeping its receipt failed: ${(error as Error).message}`);
    }
    return withReceipt(result, {
      requestId,
      kind,
      resourceId: resourceIdOf(result),
      receivedAt: receivedAt.toISOString(),
      replayed: false,
    });
  }

  private async settleFailed(
    key: { ownerId: string; actionKind: string; requestToken: string },
    fingerprint: string,
    refused: boolean,
  ): Promise<void> {
    try {
      if (refused) {
        await this.prisma.createRequestReceipt.deleteMany({ where: { ...key, fingerprint, status: 'OPEN' } });
      } else {
        await this.prisma.createRequestReceipt.updateMany({
          where: { ...key, fingerprint, status: 'OPEN' },
          data: { status: 'UNKNOWN' },
        });
      }
    } catch (error) {
      // Left OPEN, the row reads as UNKNOWN once its lease runs out, which is the conservative answer.
      this.logger.error(`${key.actionKind} ${key.requestToken}: settling a failed create failed: ${(error as Error).message}`);
    }
  }

  static reused(kind: CreateRequestKind, requestId: string): ConflictException {
    return new ConflictException({
      code: 'REQUEST_ID_REUSED',
      message: `request id ${requestId} already names a different ${kind} request; send this one under a new request id`,
      requestId,
      recovery: {
        effect: 'NONE',
        retryPolicy: 'NEVER',
        actionCode: 'USE_NEW_REQUEST_ID',
        resources: [{ type: 'REQUEST', id: requestId }],
      },
    });
  }

  static inProgress(kind: CreateRequestKind, requestId: string): ConflictException {
    return new ConflictException({
      code: 'CREATE_REQUEST_IN_PROGRESS',
      message: `${kind} request ${requestId} is still being created by an earlier delivery; send it again with the same request id to read its answer`,
      requestId,
      retryAfterSeconds: 2,
      recovery: {
        effect: 'UNKNOWN',
        retryPolicy: 'SAME_REQUEST_ID',
        retryAfterSeconds: 2,
        actionCode: 'RETRY_SAME_REQUEST',
        resources: [{ type: 'REQUEST', id: requestId }],
      },
    });
  }

  static outcomeUnknown(kind: CreateRequestKind, requestId: string): ConflictException {
    return new ConflictException({
      code: 'CREATE_REQUEST_OUTCOME_UNKNOWN',
      message: `the delivery of ${kind} request ${requestId} failed after it may have created something; look for it before creating it again under a new request id`,
      requestId,
      recovery: {
        effect: 'UNKNOWN',
        retryPolicy: 'VERIFY_THEN_RETRY',
        actionCode: 'VERIFY_STATE',
        resources: [{ type: 'REQUEST', id: requestId }],
      },
    });
  }
}

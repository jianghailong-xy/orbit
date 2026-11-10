import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WatchDeliveryService } from '../watches/watch-delivery.service';
import { OWNER_SECRET_MAX_DAYS, OWNER_REQUEST_NOT_PENDING, type OwnerRequestSecretSpec } from './owner-request';
import { enqueueResolutions } from './owner-request-endings';
import {
  SECRET_STORE_UNAVAILABLE,
  grantAad,
  openOwnerSecret,
  ownerSecretStoreAvailable,
  savedSecretAad,
  sealOwnerSecret,
} from './owner-secret-crypto';

/**
 * Owner-entered secrets delivered to one runner (design docs/design/owner-request-secrets.md, migration 0506).
 *
 * A grant is PENDING_DELIVERY from the owner's submit until the named runner acknowledges it, then ACTIVE until its
 * scope ends, then REMOVING (ciphertext already gone) until the runner confirms, then REMOVED. Whether a grant's scope
 * is still live is ONE SQL predicate (`LIVE`, §6.2), read by the heartbeat, the fetch and the sweep — no hook on the
 * many doors that can end a task or a session.
 *
 * Nothing here logs, returns or stores a value outside `value_enc`; the only plaintext leaves through `fetch`, to the
 * runner the grant names.
 */

/** The runner capability that says it can hold a secret (runner-go transport.go). */
export const OWNER_SECRET_CAPABILITY = 'owner-secret/v1';

export const SECRET_RUNNER_UNSUPPORTED = 'SECRET_RUNNER_UNSUPPORTED';
export const SECRET_ALREADY_DELIVERED = 'SECRET_ALREADY_DELIVERED';
export const SECRET_OWNER_CHANNEL_ONLY = 'SECRET_OWNER_CHANNEL_ONLY';

/** A value shorter than this could not be scrubbed without mangling ordinary text (§4.2). */
export const OWNER_SECRET_MIN_BYTES = 8;
export const OWNER_SECRET_MAX_BYTES = 16 * 1024;

const SWEEP_TICK_MS = 30_000;

export type GrantEndReason =
  | 'TASK_ENDED' | 'SESSION_ENDED' | 'EXPIRED' | 'WITHDRAWN' | 'REVOKED' | 'MOVED' | 'RUNNER_DELETED'
  | 'KEY_UNREADABLE' | 'DELIVERY_FAILED';

/**
 * Is grant `g` still allowed to exist (§6.1)? Its runner still exists, it has not passed its expiry, its session is
 * not deleted and still on that runner; task scope: the task has not ended; session scope: the session is not
 * completed or archived. A grant not yet delivered also needs its request still PENDING and not past its deadline.
 */
const LIVE = Prisma.sql`
  g."runner_id" IS NOT NULL
  AND g."expires_at" > now()
  AND EXISTS (
    SELECT 1 FROM "session" s
     WHERE s."id" = g."session_id" AND s."deleted_at" IS NULL
       AND (s."assigned_runner_id" IS NULL OR s."assigned_runner_id" = g."runner_id")
       AND (g."task_id" IS NOT NULL OR (s."completed_at" IS NULL AND s."archived_at" IS NULL)))
  AND (g."task_id" IS NULL OR EXISTS (
    SELECT 1 FROM "task" t WHERE t."id" = g."task_id" AND t."status"::text NOT IN ('DONE', 'CANCELLED', 'FAILED')
      AND COALESCE((SELECT p."lifecycle_epoch" FROM "task_progress" p WHERE p."task_id" = t."id"), 0) = COALESCE(g."task_epoch", 0)))
  AND (g."state" <> 'PENDING_DELIVERY' OR EXISTS (
    SELECT 1 FROM "owner_request" r
     WHERE r."id" = g."request_id" AND r."state" = 'PENDING' AND (r."expires_at" IS NULL OR r."expires_at" > now())))`;

/** Why a grant `LIVE` refuses ended, in the order §6.1 lists the triggers. */
const END_REASON = Prisma.sql`
  CASE
    WHEN g."runner_id" IS NULL THEN 'RUNNER_DELETED'
    WHEN g."expires_at" <= now() THEN 'EXPIRED'
    WHEN g."task_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "task" t WHERE t."id" = g."task_id" AND t."status"::text NOT IN ('DONE', 'CANCELLED', 'FAILED')
      AND COALESCE((SELECT p."lifecycle_epoch" FROM "task_progress" p WHERE p."task_id" = t."id"), 0) = COALESCE(g."task_epoch", 0))
      THEN 'TASK_ENDED'
    WHEN EXISTS (
      SELECT 1 FROM "session" s
       WHERE s."id" = g."session_id" AND s."deleted_at" IS NULL
         AND s."assigned_runner_id" IS NOT NULL AND s."assigned_runner_id" <> g."runner_id")
      THEN 'MOVED'
    WHEN g."state" = 'PENDING_DELIVERY' AND EXISTS (
      SELECT 1 FROM "owner_request" r WHERE r."id" = g."request_id" AND r."state" = 'EXPIRED')
      THEN 'EXPIRED'
    WHEN g."state" = 'PENDING_DELIVERY' AND EXISTS (
      SELECT 1 FROM "owner_request" r WHERE r."id" = g."request_id" AND r."state" = 'WITHDRAWN')
      THEN 'WITHDRAWN'
    WHEN g."state" = 'PENDING_DELIVERY' AND EXISTS (
      SELECT 1 FROM "owner_request" r WHERE r."id" = g."request_id" AND r."state" <> 'PENDING')
      THEN 'REVOKED'
    WHEN g."state" = 'PENDING_DELIVERY' AND EXISTS (
      SELECT 1 FROM "owner_request" r WHERE r."id" = g."request_id" AND r."expires_at" <= now())
      THEN 'EXPIRED'
    ELSE 'SESSION_ENDED'
  END`;

const RUNNER_DELETED_NOTE = 'Removal unconfirmed: the runner was deleted before it could confirm.';

/** What the owner's card reads of a grant: never the value, its length, or anything derived from it. */
export interface OwnerSecretGrantView {
  state: string;
  endReason: string | null;
  exposure: string;
  expiresAt: Date;
  deliveredAt: Date | null;
  removedAt: Date | null;
  removalNote: string | null;
  runnerOnline: boolean;
  runnerLastSeenAt: Date | null;
}

export interface SecretSubmission {
  value?: string;
  saveAs?: string;
  savedSecretId?: string;
}

/** A value the owner typed, checked before it is sealed. The message never quotes it. */
export function ownerSecretValueError(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'value is required';
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < OWNER_SECRET_MIN_BYTES) return `the key must be at least ${OWNER_SECRET_MIN_BYTES} bytes`;
  if (bytes > OWNER_SECRET_MAX_BYTES) return `the key may be at most ${OWNER_SECRET_MAX_BYTES} bytes`;
  if (value.includes('\0')) return 'the key may not contain a NUL byte';
  return undefined;
}

@Injectable()
export class OwnerSecretsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OwnerSecretsService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    /** Marks a runner changed after a commit, so its next link beat reconciles in full; then hints it. */
    @Optional() private readonly realtime?: RealtimeService,
    @Optional() private readonly delivery?: WatchDeliveryService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep().catch((e) => this.logger.error(`secret grant sweep failed: ${(e as Error).message}`));
    }, SWEEP_TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ─── Filing ────────────────────────────────────────────────────────────────────────────────

  /**
   * The runner a SECRET request filed by this session goes to (§4.1): the session's own, never the caller's choice.
   * A `claimed` runner id is accepted only when it is that one. Refused when the store has no key or the runner
   * cannot hold a secret.
   */
  async runnerForFiling(ownerId: string, sessionId: string, claimed: string | undefined): Promise<string> {
    if (!ownerSecretStoreAvailable()) {
      throw new ConflictException({
        code: SECRET_STORE_UNAVAILABLE,
        message: 'this Orbit server has no PROVIDER_SECRET_KEY, so it cannot keep a secret; ask the owner another way',
      });
    }
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId, deletedAt: null },
      select: { assignedRunnerId: true },
    });
    const runnerId = session?.assignedRunnerId;
    if (!runnerId) throw new BadRequestException('this session runs on no runner, so a secret has nowhere to go');
    if (claimed && claimed !== runnerId) {
      throw new BadRequestException('secretSpec.runnerId must be omitted: a secret goes to the runner this session runs on');
    }
    const runner = await this.prisma.runner.findFirst({
      where: { id: runnerId, ownerId },
      select: { capabilities: true },
    });
    if (!runner?.capabilities.some((c) => c.toLowerCase() === OWNER_SECRET_CAPABILITY)) {
      throw new ConflictException({
        code: SECRET_RUNNER_UNSUPPORTED,
        message: 'the runner this session runs on cannot receive secrets (it does not declare owner-secret/v1; '
          + 'Windows runners never do, others need a newer runner)',
      });
    }
    return runnerId;
  }

  // ─── The owner's doors ──────────────────────────────────────────────────────────────────────

  /**
   * The owner enters the value (§4.2 step 1). In one transaction holding the request's row lock: it is a PENDING
   * SECRET request, its session is still on the runner the card names, and no grant of it was delivered yet. A grant
   * waiting for delivery is replaced (a typo fix) by one with a new id, so a runner that fetched the old one is told
   * 404 when it acknowledges and drops it.
   */
  async submit(ownerId: string, requestId: string, given: SecretSubmission): Promise<void> {
    if (!ownerSecretStoreAvailable()) {
      throw new ConflictException({ code: SECRET_STORE_UNAVAILABLE, message: 'this Orbit server cannot keep a secret' });
    }
    const usesSaved = given.savedSecretId !== undefined;
    if (usesSaved && (given.value !== undefined || given.saveAs !== undefined)) {
      throw new BadRequestException('send either a value (optionally with saveAs) or savedSecretId, not both');
    }
    let value: string;
    if (usesSaved) {
      const saved = await this.prisma.accountSecret.findFirst({
        where: { id: given.savedSecretId, ownerId },
        select: { id: true, valueEnc: true },
      });
      if (!saved) throw new NotFoundException('saved secret not found');
      try {
        value = openOwnerSecret(saved.valueEnc, savedSecretAad(saved.id, ownerId));
      } catch {
        throw new ConflictException({
          code: 'KEY_UNREADABLE',
          message: 'this saved secret can no longer be read (the server key changed); replace or delete it',
        });
      }
    } else {
      const invalid = ownerSecretValueError(given.value);
      if (invalid) throw new BadRequestException(invalid);
      value = given.value as string;
    }
    const saveAs = given.saveAs?.trim();
    if (given.saveAs !== undefined && (!saveAs || saveAs.length > 100)) {
      throw new BadRequestException('saveAs is a label of 1 to 100 characters');
    }

    let runnerId = '';
    await withTransactionRetry(this.prisma, async (tx) => {
      const [request] = await tx.$queryRaw<Array<{ kind: string; state: string; expires_at: Date | null; asked_by_session_id: string; secret_spec: unknown }>>`
        SELECT "kind", "state", "expires_at", "asked_by_session_id", "secret_spec"
          FROM "owner_request" WHERE "id" = ${requestId}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
      if (!request) throw new NotFoundException('owner request not found');
      if (request.kind !== 'SECRET') throw new BadRequestException('only a SECRET request takes a key');
      if (request.state !== 'PENDING' || (request.expires_at && request.expires_at.getTime() <= Date.now())) {
        throw new ConflictException({
          code: OWNER_REQUEST_NOT_PENDING,
          state: request.state,
          message: `this request is ${request.state === 'PENDING' ? 'past its deadline' : request.state}; nothing was stored`,
        });
      }
      const spec = (request.secret_spec ?? {}) as Partial<OwnerRequestSecretSpec>;
      if (!spec.runnerId) throw new ConflictException('this request names no runner; the agent has to file it again');
      const session = await tx.session.findFirst({
        where: { id: request.asked_by_session_id, ownerId, deletedAt: null },
        select: { assignedRunnerId: true, taskId: true },
      });
      if (!session || session.assignedRunnerId !== spec.runnerId) {
        throw new ConflictException({
          code: 'SECRET_SESSION_MOVED',
          message: 'the session that asked is no longer on the runner this card names; nothing was stored',
        });
      }
      const existing = await tx.ownerRequestSecret.findUnique({ where: { requestId }, select: { state: true } });
      if (existing && existing.state !== 'PENDING_DELIVERY' && existing.state !== 'REMOVED') {
        throw new ConflictException({
          code: SECRET_ALREADY_DELIVERED,
          message: 'a key was already delivered for this request; revoke it on the card and let the agent ask again',
        });
      }
      if (existing) await tx.ownerRequestSecret.delete({ where: { requestId } });
      const [{ id }] = await tx.$queryRaw<Array<{ id: string }>>`SELECT gen_random_uuid()::text AS id`;
      const now = new Date();
      // The task's epoch now: reopening the task later starts a new one, which the grant does not live into (§6.1).
      const taskEpoch = session.taskId
        ? (await tx.taskProgress.findUnique({ where: { taskId: session.taskId }, select: { lifecycleEpoch: true } }))?.lifecycleEpoch ?? 0
        : null;
      await tx.ownerRequestSecret.create({
        data: {
          id,
          ownerId,
          requestId,
          runnerId: spec.runnerId,
          sessionId: request.asked_by_session_id,
          taskId: session.taskId,
          taskEpoch,
          name: spec.envVar ?? null,
          exposure: spec.envVar ? 'ENV' : 'FILE',
          filePath: spec.envVar ? null : (spec.filePath ?? null),
          valueEnc: sealOwnerSecret(value, grantAad(id, ownerId, spec.runnerId)),
          state: 'PENDING_DELIVERY',
          expiresAt: new Date(now.getTime() + OWNER_SECRET_MAX_DAYS * 24 * 60 * 60 * 1000),
        },
        select: { id: true },
      });
      if (saveAs) await this.saveInTx(tx, ownerId, saveAs, value);
      runnerId = spec.runnerId;
    }, loggedRetry(this.logger, 'ownerSecrets.submit'));
    this.realtime?.markRunnerChanged(runnerId);
  }

  /** The owner takes back a key that has not been delivered yet: the ciphertext goes, the card returns to its input. */
  async cancel(ownerId: string, requestId: string): Promise<void> {
    const ended = await this.prisma.ownerRequestSecret.updateManyAndReturn({
      where: { requestId, ownerId, state: 'PENDING_DELIVERY' },
      data: { state: 'REMOVED', endReason: 'REVOKED', valueEnc: null, removedAt: new Date() },
      select: { runnerId: true },
    });
    if (ended.length === 0) await this.requireRequest(ownerId, requestId, 'no key is waiting for delivery on this request');
    // A runner that fetched it before the cancel is told by its next reconcile, and by a 404 on its ack.
    if (ended[0]?.runnerId) this.realtime?.markRunnerChanged(ended[0].runnerId);
  }

  /** The owner's Revoke on a delivered key (§6.1): REMOVING at once, the runner removes it on its next heartbeat. */
  async revoke(ownerId: string, requestId: string): Promise<void> {
    const grant = await this.prisma.ownerRequestSecret.findFirst({
      where: { requestId, ownerId },
      select: { state: true, runnerId: true },
    });
    if (!grant) await this.requireRequest(ownerId, requestId, 'no key was delivered on this request');
    if (grant?.state === 'PENDING_DELIVERY') return this.cancel(ownerId, requestId);
    const ended = await this.prisma.ownerRequestSecret.updateMany({
      where: { requestId, ownerId, state: 'ACTIVE' },
      data: { state: 'REMOVING', endReason: 'REVOKED', valueEnc: null },
    });
    if (ended.count === 0) throw new ConflictException('this key is already being removed or was removed');
    if (grant?.runnerId) this.realtime?.markRunnerChanged(grant.runnerId);
  }

  private async requireRequest(ownerId: string, requestId: string, conflict: string): Promise<never> {
    const request = await this.prisma.ownerRequest.count({ where: { id: requestId, ownerId } });
    if (request === 0) throw new NotFoundException('owner request not found');
    throw new ConflictException(conflict);
  }

  /** The card's view of each request's grant, by request id. */
  async grantViews(ownerId: string, requestIds: string[]): Promise<Map<string, OwnerSecretGrantView>> {
    const views = new Map<string, OwnerSecretGrantView>();
    if (requestIds.length === 0) return views;
    const grants = await this.prisma.ownerRequestSecret.findMany({
      where: { ownerId, requestId: { in: requestIds } },
      select: {
        requestId: true, runnerId: true, state: true, endReason: true, exposure: true, expiresAt: true,
        deliveredAt: true, removedAt: true, removalNote: true,
      },
    });
    const runnerIds = [...new Set(grants.map((g) => g.runnerId).filter((id): id is string => Boolean(id)))];
    const runners = runnerIds.length === 0 ? [] : await this.prisma.runner.findMany({
      where: { id: { in: runnerIds }, ownerId },
      select: { id: true, status: true, lastHeartbeatAt: true },
    });
    const byId = new Map(runners.map((r) => [r.id, r]));
    for (const g of grants) {
      const runner = g.runnerId ? byId.get(g.runnerId) : undefined;
      views.set(g.requestId, {
        state: g.state,
        endReason: g.endReason,
        exposure: g.exposure,
        expiresAt: g.expiresAt,
        deliveredAt: g.deliveredAt,
        removedAt: g.removedAt,
        removalNote: g.removalNote,
        runnerOnline: runner?.status === 'ONLINE',
        runnerLastSeenAt: runner?.lastHeartbeatAt ?? null,
      });
    }
    return views;
  }

  // ─── Saved account secrets (§3.4): write-only ───────────────────────────────────────────────

  async listSaved(ownerId: string) {
    const secrets = await this.prisma.accountSecret.findMany({
      where: { ownerId },
      orderBy: { label: 'asc' },
      select: { id: true, label: true, createdAt: true, updatedAt: true },
    });
    return { secrets };
  }

  async replaceSaved(ownerId: string, id: string, value: unknown): Promise<void> {
    const invalid = ownerSecretValueError(value);
    if (invalid) throw new BadRequestException(invalid);
    if (!ownerSecretStoreAvailable()) {
      throw new ConflictException({ code: SECRET_STORE_UNAVAILABLE, message: 'this Orbit server cannot keep a secret' });
    }
    const written = await this.prisma.accountSecret.updateMany({
      where: { id, ownerId },
      data: { valueEnc: sealOwnerSecret(value as string, savedSecretAad(id, ownerId)) },
    });
    if (written.count === 0) throw new NotFoundException('saved secret not found');
  }

  /** Deleting a saved secret leaves grants already made from it alone; the owner revokes those on their cards. */
  async deleteSaved(ownerId: string, id: string): Promise<void> {
    const deleted = await this.prisma.accountSecret.deleteMany({ where: { id, ownerId } });
    if (deleted.count === 0) throw new NotFoundException('saved secret not found');
  }

  private async saveInTx(tx: Prisma.TransactionClient, ownerId: string, label: string, value: string): Promise<void> {
    const existing = await tx.accountSecret.findUnique({
      where: { ownerId_label: { ownerId, label } },
      select: { id: true },
    });
    if (existing) {
      await tx.accountSecret.update({
        where: { id: existing.id },
        data: { valueEnc: sealOwnerSecret(value, savedSecretAad(existing.id, ownerId)) },
      });
      return;
    }
    const [{ id }] = await tx.$queryRaw<Array<{ id: string }>>`SELECT gen_random_uuid()::text AS id`;
    await tx.accountSecret.create({
      data: { id, ownerId, label, valueEnc: sealOwnerSecret(value, savedSecretAad(id, ownerId)) },
    });
  }

  // ─── The asking session ─────────────────────────────────────────────────────────────────────

  /** The agent releases a delivered key it no longer needs (§6.1 WITHDRAWN). False when there was none to release. */
  async release(ownerId: string, sessionId: string, requestId: string): Promise<boolean> {
    const grant = await this.prisma.ownerRequestSecret.findFirst({
      where: { requestId, ownerId, state: 'ACTIVE' },
      select: { runnerId: true },
    });
    if (!grant) return false;
    const ended = await this.prisma.ownerRequestSecret.updateMany({
      where: { requestId, ownerId, state: 'ACTIVE', request: { askedBySessionId: sessionId } },
      data: { state: 'REMOVING', endReason: 'WITHDRAWN', valueEnc: null },
    });
    if (ended.count > 0 && grant.runnerId) this.realtime?.markRunnerChanged(grant.runnerId);
    return ended.count > 0;
  }

  // ─── The runner ─────────────────────────────────────────────────────────────────────────────

  /** The heartbeat's `secretGrants` and `secretGrantsRemoving` for this runner (§6.3). */
  async reconcileFor(runnerId: string): Promise<{
    secretGrants: Array<{ id: string; expiresAt: string }>;
    secretGrantsRemoving: string[];
  }> {
    const live = await this.prisma.$queryRaw<Array<{ id: string; expires_at: Date }>>`
      SELECT g."id"::text AS id, g."expires_at"
        FROM "owner_request_secret" g
       WHERE g."runner_id" = ${runnerId}::uuid AND g."state" IN ('PENDING_DELIVERY', 'ACTIVE') AND ${LIVE}
       ORDER BY g."id"`;
    const removing = await this.prisma.ownerRequestSecret.findMany({
      where: { runnerId, state: 'REMOVING' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return {
      secretGrants: live.map((g) => ({ id: g.id, expiresAt: g.expires_at.toISOString() })),
      secretGrantsRemoving: removing.map((g) => g.id),
    };
  }

  /**
   * §4.2 step 3: the one door a value leaves through. Only the authenticated runner the grant names, only while the
   * grant may be held and its scope is live; everything else is the same 404 as an id that does not exist.
   */
  async fetch(runner: { id: string; ownerId: string }, grantId: string) {
    const [grant] = await this.prisma.$queryRaw<Array<{
      id: string; request_id: string; owner_id: string; runner_id: string; session_id: string; task_id: string | null;
      name: string | null; exposure: string; file_path: string | null; value_enc: string; expires_at: Date;
    }>>`
      SELECT g."id"::text AS id, g."request_id"::text AS request_id, g."owner_id"::text AS owner_id,
             g."runner_id"::text AS runner_id, g."session_id"::text AS session_id, g."task_id"::text AS task_id,
             g."name", g."exposure", g."file_path", g."value_enc", g."expires_at"
        FROM "owner_request_secret" g
       WHERE g."id" = ${grantId}::uuid AND g."runner_id" = ${runner.id}::uuid AND g."owner_id" = ${runner.ownerId}::uuid
         AND g."state" IN ('PENDING_DELIVERY', 'ACTIVE') AND ${LIVE}`;
    if (!grant) throw new NotFoundException('secret grant not found');
    let value: string;
    try {
      value = openOwnerSecret(grant.value_enc, grantAad(grant.id, grant.owner_id, grant.runner_id));
    } catch {
      await this.prisma.$executeRaw`
        UPDATE "owner_request_secret"
           SET "state" = CASE WHEN "state" = 'ACTIVE' THEN 'REMOVING' ELSE 'REMOVED' END,
               "removed_at" = CASE WHEN "state" = 'ACTIVE' THEN NULL ELSE now() END,
               "end_reason" = 'KEY_UNREADABLE', "value_enc" = NULL, "updated_at" = now()
         WHERE "id" = ${grant.id}::uuid AND "state" IN ('PENDING_DELIVERY', 'ACTIVE')`;
      this.logger.warn(`secret grant ${grant.id} could not be decrypted and was ended KEY_UNREADABLE`);
      throw new NotFoundException('secret grant not found');
    }
    return {
      id: grant.id,
      requestId: grant.request_id,
      exposure: grant.exposure,
      name: grant.name,
      filePath: grant.file_path,
      value,
      expiresAt: grant.expires_at.toISOString(),
      sessionId: grant.session_id,
      taskId: grant.task_id,
    };
  }

  /**
   * §4.2 step 5. DELIVERED: in one transaction the grant becomes ACTIVE, the request DONE and its resolution turn is
   * queued; a repeat is a no-op. FAILED: the ciphertext goes and the request stays PENDING, its card back at input.
   */
  async ack(
    runner: { id: string; ownerId: string },
    grantId: string,
    outcome: 'DELIVERED' | 'FAILED',
    code: string | undefined,
    message: string | undefined,
  ): Promise<{ state: string }> {
    const result = await withTransactionRetry(this.prisma, async (tx) => {
      const [grant] = await tx.$queryRaw<Array<{ request_id: string; state: string }>>`
        SELECT g."request_id"::text AS request_id, g."state" FROM "owner_request_secret" g
         WHERE g."id" = ${grantId}::uuid AND g."runner_id" = ${runner.id}::uuid AND g."owner_id" = ${runner.ownerId}::uuid`;
      if (!grant || grant.state === 'REMOVING' || grant.state === 'REMOVED') return null;
      if (grant.state === 'ACTIVE') return { state: 'ACTIVE', resolved: false };
      // Lock order: the request, then the grant — as submit takes them.
      await tx.$queryRaw`SELECT 1 FROM "owner_request" WHERE "id" = ${grant.request_id}::uuid FOR UPDATE`;
      if (outcome === 'FAILED') {
        const note = [code, message].filter(Boolean).join(': ').slice(0, 500) || 'delivery failed';
        const failed = await tx.ownerRequestSecret.updateMany({
          where: { id: grantId, state: 'PENDING_DELIVERY' },
          data: { state: 'REMOVED', endReason: 'DELIVERY_FAILED', valueEnc: null, removedAt: new Date(), removalNote: note },
        });
        return failed.count === 1 ? { state: 'REMOVED', resolved: false } : null;
      }
      const live = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT g."id" FROM "owner_request_secret" g
         WHERE g."id" = ${grantId}::uuid AND g."state" = 'PENDING_DELIVERY' AND ${LIVE} FOR UPDATE OF g`;
      if (live.length === 0) return null;
      const now = new Date();
      await tx.ownerRequestSecret.update({ where: { id: grantId }, data: { state: 'ACTIVE', deliveredAt: now } });
      const done = await tx.ownerRequest.updateMany({
        where: { id: grant.request_id, state: 'PENDING' },
        data: { state: 'DONE', resolvedAt: now, resolvedByUserId: runner.ownerId },
      });
      if (done.count === 1) await enqueueResolutions(tx, [grant.request_id]);
      return { state: 'ACTIVE', resolved: done.count === 1 };
    }, loggedRetry(this.logger, 'ownerSecrets.ack'));
    if (!result) throw new NotFoundException('secret grant not found');
    if (result.resolved) this.delivery?.kick();
    return { state: result.state };
  }

  /** §6.3: the runner removed its copy. REMOVING → REMOVED, idempotent; anything else this runner does not hold is 404. */
  async removed(runner: { id: string; ownerId: string }, grantId: string, note: string | undefined): Promise<{ state: string }> {
    const grant = await this.prisma.ownerRequestSecret.findFirst({
      where: { id: grantId, runnerId: runner.id, ownerId: runner.ownerId },
      select: { state: true },
    });
    if (!grant) throw new NotFoundException('secret grant not found');
    if (grant.state === 'REMOVED') return { state: 'REMOVED' };
    if (grant.state !== 'REMOVING') {
      throw new ConflictException({ code: 'SECRET_GRANT_LIVE', message: 'this grant is still live; keep it' });
    }
    await this.prisma.ownerRequestSecret.updateMany({
      where: { id: grantId, state: 'REMOVING' },
      data: { state: 'REMOVED', removedAt: new Date(), removalNote: note?.trim().slice(0, 500) || null },
    });
    return { state: 'REMOVED' };
  }

  /**
   * The values a runner may be holding right now, for the write-door check (§7.2). One indexed read; decrypts only on a
   * runner with a grant in hand. A value that cannot be decrypted is skipped — the fetch ends that grant.
   */
  async valuesHeldBy(runner: { id: string; ownerId: string }): Promise<Array<{ name: string; value: string }>> {
    const grants = await this.prisma.ownerRequestSecret.findMany({
      where: { runnerId: runner.id, ownerId: runner.ownerId, state: { in: ['PENDING_DELIVERY', 'ACTIVE'] } },
      select: { id: true, name: true, filePath: true, valueEnc: true },
    });
    const values: Array<{ name: string; value: string }> = [];
    for (const g of grants) {
      if (!g.valueEnc) continue;
      try {
        values.push({
          name: g.name ?? g.filePath ?? 'secret',
          value: openOwnerSecret(g.valueEnc, grantAad(g.id, runner.ownerId, runner.id)),
        });
      } catch {
        // Unreadable: it cannot be delivered either, and the fetch ends it.
      }
    }
    return values;
  }

  // ─── Ending ─────────────────────────────────────────────────────────────────────────────────

  /**
   * §6.2's sweep: every grant whose scope is no longer live leaves PENDING_DELIVERY or ACTIVE, and its ciphertext goes
   * with it. A delivered one becomes REMOVING until its runner confirms; one never delivered, or whose runner is gone,
   * is REMOVED at once. Its own compare-and-set: two replicas sweeping at once end each grant once.
   */
  async sweep(): Promise<number> {
    const ended = await this.prisma.$queryRaw<Array<{ runner_id: string | null }>>`
      UPDATE "owner_request_secret" g
         SET "state" = CASE WHEN g."state" = 'ACTIVE' AND g."runner_id" IS NOT NULL THEN 'REMOVING' ELSE 'REMOVED' END,
             "removed_at" = CASE WHEN g."state" = 'ACTIVE' AND g."runner_id" IS NOT NULL THEN NULL ELSE now() END,
             "removal_note" = CASE WHEN g."state" = 'ACTIVE' AND g."runner_id" IS NULL THEN ${RUNNER_DELETED_NOTE}
                                   ELSE g."removal_note" END,
             "end_reason" = ${END_REASON},
             "value_enc" = NULL,
             "updated_at" = now()
       WHERE g."state" IN ('PENDING_DELIVERY', 'ACTIVE') AND NOT (${LIVE})
      RETURNING g."runner_id"::text AS runner_id`;
    // A REMOVING grant whose runner was deleted has nobody left to confirm it.
    const orphaned = await this.prisma.ownerRequestSecret.updateMany({
      where: { state: 'REMOVING', runnerId: null },
      data: { state: 'REMOVED', removedAt: new Date(), removalNote: RUNNER_DELETED_NOTE },
    });
    const touched = ended.map((row) => row.runner_id).filter((id): id is string => Boolean(id));
    if (touched.length > 0) this.realtime?.markRunnerChanged(touched);
    return ended.length + orphaned.count;
  }
}

/** The owner's doors refuse a request made on an agent's behalf: entering a secret is the owner's own act (§8.1). */
export function refuseActingSession(headers: Record<string, string | string[] | undefined>): void {
  const named = headers['x-orbit-session-id'];
  if (named !== undefined && String(named).trim() !== '') {
    throw new ForbiddenException({
      code: SECRET_OWNER_CHANNEL_ONLY,
      message: 'secrets are entered by the account owner, signed in; a request on a session\'s behalf cannot',
    });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import {
  type AccountHealthFailure,
  type AccountHealthRow,
  type AccountHealthState,
  type AccountHealthSubject,
  type AccountHealthView,
  failureScopeModel,
  healthView,
  stepOnFailure,
  subjectColumns,
  subjectKey,
  SUSPECT_WINDOW_MS,
  TRIAL_CLAIM_STALE_MS,
} from './account-health';

/** A live row as the router reads it (§7.1), with what the rules make of it now. */
export interface AccountHealthEntry extends AccountHealthRow {
  id: string;
  subjectKey: string;
  scopeModel: string;
  view: AccountHealthView;
}

/** What a dispatch about to start a run on an account gets from claimTrial (§6.5). */
export type TrialClaim =
  /** This dispatch's run is the trial. */
  | 'CLAIMED'
  /** Another run is the trial: route again with this account excluded. */
  | 'HELD'
  /** There is no trial due on this account: it is healthy, or still inside its block. */
  | 'NOT_DUE';

interface RawRow {
  id: string;
  state: AccountHealthState;
  kind: string;
  said: string | null;
  strikes: number;
  trips: number;
  first_at: Date;
  last_at: Date;
  last_session_id: string | null;
  blocked_until: Date | null;
  trial_session_id: string | null;
  trial_claimed_at: Date | null;
}

function rowOf(raw: RawRow): AccountHealthRow & { id: string } {
  return {
    id: raw.id,
    state: raw.state,
    kind: raw.kind,
    said: raw.said,
    strikes: raw.strikes,
    trips: raw.trips,
    firstAt: raw.first_at,
    lastAt: raw.last_at,
    lastSessionId: raw.last_session_id,
    blockedUntil: raw.blocked_until,
    trialSessionId: raw.trial_session_id,
    trialClaimedAt: raw.trial_claimed_at,
  };
}

/**
 * Account health (docs/routing-account-health-design.md §6): the one writer of `account_health`. The rules are
 * account-health.ts; this reads the live row of a subject and scope, applies them and writes the result.
 *
 * Called with runFailureKind's output by the places that see a run end (§6.3): a failure strikes or trips the
 * account, or cools one model on it; an admitted turn clears it; a dispatch about to start a run on an account whose
 * block ran out claims its trial.
 */
@Injectable()
export class AccountHealthService {
  private readonly log = new Logger('AccountHealth');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A run or turn of `failure.sessionId` on `subject` ended FAILED. One unit per call: a trial the session held on the
   * subject is released, then the live row of the scope the failure is about is locked, the rules applied, and the
   * result written. Idempotent per session: a retry of the same finalize finds its own session on a row of that scope
   * (live, or cleared since) and writes nothing.
   */
  async recordFailure(ownerId: string, subject: AccountHealthSubject, failure: AccountHealthFailure, now = new Date()): Promise<void> {
    const key = subjectKey(subject);
    const scopeModel = failureScopeModel(failure);
    const parts = subjectColumns(subject);
    await withTransactionRetry(this.prisma, async (tx) => {
      // A trial this session held ends with it, whatever the failure says (§6.5): released here, and the rules below
      // read a refused trial as the next trip from the row's expired block, not from the claim.
      await tx.$executeRaw`
        UPDATE "account_health" SET "trial_session_id" = NULL, "trial_claimed_at" = NULL, "updated_at" = ${now}
         WHERE "owner_id" = ${ownerId}::uuid AND "subject_key" = ${key} AND "cleared_at" IS NULL
           AND "trial_session_id" = ${failure.sessionId}::uuid`;
      if (scopeModel === null) return;
      // Idempotent per session: a row this session's failure already wrote, live or cleared since, takes no second.
      const [seen] = await tx.$queryRaw<Array<{ one: number }>>`
        SELECT 1 AS "one" FROM "account_health"
         WHERE "owner_id" = ${ownerId}::uuid AND "subject_key" = ${key} AND "scope_model" = ${scopeModel}
           AND "last_session_id" = ${failure.sessionId}::uuid
         LIMIT 1`;
      if (seen) return;
      // Twice at most: a live row inserted by a concurrent failure between our read and our insert is read again.
      for (let pass = 0; pass < 2; pass += 1) {
        const [raw] = await tx.$queryRaw<RawRow[]>`
          SELECT "id", "state", "kind", "said", "strikes", "trips", "first_at", "last_at", "last_session_id",
                 "blocked_until", "trial_session_id", "trial_claimed_at"
            FROM "account_health"
           WHERE "owner_id" = ${ownerId}::uuid AND "subject_key" = ${key} AND "scope_model" = ${scopeModel}
             AND "cleared_at" IS NULL
             FOR UPDATE`;
        const current = raw ? rowOf(raw) : null;
        const step = stepOnFailure(current, failure, now);
        const next = step.next;
        if (!next) return;
        if (current && !step.expirePrevious) {
          await tx.accountHealth.update({
            where: { id: current.id },
            data: {
              state: next.state, kind: next.kind, said: next.said, strikes: next.strikes, trips: next.trips,
              firstAt: next.firstAt, lastAt: next.lastAt, lastSessionId: next.lastSessionId, blockedUntil: next.blockedUntil,
              trialSessionId: next.trialSessionId, trialClaimedAt: next.trialClaimedAt, updatedAt: now,
            },
          });
          return;
        }
        if (current) {
          await tx.accountHealth.update({ where: { id: current.id }, data: { clearedAt: now, clearedBy: 'EXPIRED', updatedAt: now } });
        }
        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO "account_health" (
            "id", "owner_id", "subject_key", "scope_model", "runner_id", "engine", "account", "provider_id", "pool_id",
            "state", "kind", "said", "strikes", "trips", "first_at", "last_at", "last_session_id", "blocked_until",
            "created_at", "updated_at")
          VALUES (
            gen_random_uuid(), ${ownerId}::uuid, ${key}, ${scopeModel}, ${parts.runnerId}::uuid, ${parts.engine},
            ${parts.account}, ${parts.providerId}::uuid, ${parts.poolId}::uuid, ${next.state}, ${next.kind}, ${next.said},
            ${next.strikes}, ${next.trips}, ${next.firstAt}, ${next.lastAt}, ${next.lastSessionId}::uuid,
            ${next.blockedUntil}, ${now}, ${now})
          ON CONFLICT ("owner_id", "subject_key", "scope_model") WHERE "cleared_at" IS NULL DO NOTHING
          RETURNING "id"`;
        if (inserted.length) return;
      }
      throw new Error('account_health: the live row moved twice under one failure');
    }, loggedRetry(this.log, 'accountHealth.recordFailure'));
  }

  /**
   * A turn on `subject` was admitted (§6.3): it produced a reply, a tool call or usage, however the run ends later.
   * The account-level row and `model`'s row are cleared, so the ladder restarts at its first step; a row that had
   * already run out is stamped EXPIRED, one that still held the account SUCCESS. Other models' rows are untouched.
   */
  async recordSuccess(ownerId: string, subject: AccountHealthSubject, model: string | null, now = new Date()): Promise<void> {
    const key = subjectKey(subject);
    const scopes = model?.trim() ? ['', model.trim()] : [''];
    await this.prisma.$executeRaw`
      UPDATE "account_health"
         SET "cleared_at" = ${now},
             "cleared_by" = CASE
               WHEN "state" = 'SUSPECT' AND "last_at" + make_interval(secs => ${SUSPECT_WINDOW_MS / 1000}) <= ${now} THEN 'EXPIRED'
               WHEN "state" = 'COOLDOWN' AND "blocked_until" <= ${now} THEN 'EXPIRED'
               ELSE 'SUCCESS' END,
             "trial_session_id" = NULL, "trial_claimed_at" = NULL, "updated_at" = ${now}
       WHERE "owner_id" = ${ownerId}::uuid AND "subject_key" = ${key} AND "cleared_at" IS NULL
         AND "scope_model" IN (${Prisma.join(scopes)})`;
  }

  /**
   * A dispatch is about to start `sessionId`'s run on `subject` (§6.5): if the account's block ran out, its run is the
   * one trial, claimed by one conditional UPDATE, so two dispatches racing for one due trial cannot both win. A claim
   * is free to take while nobody holds it, or once it is 15 minutes old and its session is not running.
   */
  async claimTrial(ownerId: string, subject: AccountHealthSubject, scopeModel: string, sessionId: string, now = new Date()): Promise<TrialClaim> {
    const key = subjectKey(subject);
    const stale = new Date(now.getTime() - TRIAL_CLAIM_STALE_MS);
    const claimed = await this.prisma.$executeRaw`
      UPDATE "account_health" AS h
         SET "trial_session_id" = ${sessionId}::uuid, "trial_claimed_at" = ${now}, "updated_at" = ${now}
       WHERE h."owner_id" = ${ownerId}::uuid AND h."subject_key" = ${key} AND h."scope_model" = ${scopeModel}
         AND h."cleared_at" IS NULL AND h."state" = 'BLOCKED' AND h."blocked_until" <= ${now}
         AND (h."trial_session_id" IS NULL
              OR h."trial_session_id" = ${sessionId}::uuid
              OR (h."trial_claimed_at" <= ${stale}
                  AND NOT EXISTS (SELECT 1 FROM "session" s WHERE s."id" = h."trial_session_id" AND s."status" = 'RUNNING')))`;
    if (claimed > 0) return 'CLAIMED';
    const [row] = await this.prisma.$queryRaw<Array<{ due: boolean }>>`
      SELECT ("state" = 'BLOCKED' AND "blocked_until" <= ${now}) AS "due"
        FROM "account_health"
       WHERE "owner_id" = ${ownerId}::uuid AND "subject_key" = ${key} AND "scope_model" = ${scopeModel}
         AND "cleared_at" IS NULL`;
    return row?.due ? 'HELD' : 'NOT_DUE';
  }

  /**
   * The trial `sessionId` holds on `subject` ended some other way before admission (cancelled, runner lost, a
   * transport error): the health is unchanged and the trial is due again (§6.5).
   */
  async releaseTrial(ownerId: string, subject: AccountHealthSubject, sessionId: string, now = new Date()): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "account_health" SET "trial_session_id" = NULL, "trial_claimed_at" = NULL, "updated_at" = ${now}
       WHERE "owner_id" = ${ownerId}::uuid AND "subject_key" = ${subjectKey(subject)} AND "cleared_at" IS NULL
         AND "trial_session_id" = ${sessionId}::uuid`;
  }

  /** Every live row of an owner's accounts, as the router reads them in one batch (§7.1); rows that ran out are left out. */
  async live(ownerId: string, now = new Date()): Promise<AccountHealthEntry[]> {
    const rows = await this.prisma.$queryRaw<Array<RawRow & { subject_key: string; scope_model: string; trial_running: boolean }>>`
      SELECT h."id", h."subject_key", h."scope_model", h."state", h."kind", h."said", h."strikes", h."trips",
             h."first_at", h."last_at", h."last_session_id", h."blocked_until", h."trial_session_id", h."trial_claimed_at",
             EXISTS (SELECT 1 FROM "session" s WHERE s."id" = h."trial_session_id" AND s."status" = 'RUNNING') AS "trial_running"
        FROM "account_health" h
       WHERE h."owner_id" = ${ownerId}::uuid AND h."cleared_at" IS NULL
       ORDER BY h."subject_key", h."scope_model"`;
    return rows
      .map((raw) => {
        const row = rowOf(raw);
        return { ...row, subjectKey: raw.subject_key, scopeModel: raw.scope_model, view: healthView(row, now, raw.trial_running) };
      })
      .filter((entry) => entry.view !== 'healthy');
  }
}

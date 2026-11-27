import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma, RunnerStatus } from '@prisma/client';
import { isEngine, planUsageReported, RunEventType, runFailureKind, type PlanUsage } from '@orbit/shared';
import { engineKeepsAccounts } from '../common/runner-engines';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { sessionTurnStateSql } from '../sessions/session-turn-state';
import type { RoutingHealthEntry } from '../tasks/model-routing';
import { ACCOUNT_CHOICE } from './account';
import { runAccount } from './plan-usage-accounts';
import { sessionEngine } from './session-engine';
import {
  type AccountHealthEffect,
  type AccountHealthFailure,
  type AccountHealthRow,
  type AccountHealthState,
  type AccountHealthSubject,
  type AccountHealthView,
  alertDue,
  failureEffect,
  failureScopeModel,
  healthView,
  runnerSubjectAccount,
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
  notified_kind?: string | null;
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

  /** `moduleRef`: PushService is found lazily (the push module imports half the app); absent in specs, which see no push. */
  constructor(private readonly prisma: PrismaService, @Optional() private readonly moduleRef?: ModuleRef) {}

  /**
   * A run or turn of `failure.sessionId` on `subject` ended FAILED. One unit per call: a trial the session held on the
   * subject is released, then the live row of the scope the failure is about is locked, the rules applied, and the
   * result written. Idempotent per session: a retry of the same finalize finds its own session on a row of that scope
   * (live, or cleared since) and writes nothing.
   */
  async recordFailure(
    ownerId: string,
    subject: AccountHealthSubject,
    failure: AccountHealthFailure,
    now = new Date(),
  ): Promise<AccountHealthEffect | null> {
    const key = subjectKey(subject);
    const scopeModel = failureScopeModel(failure);
    const parts = subjectColumns(subject);
    let alert: AccountNeedsAction | null = null;
    const effect = await withTransactionRetry(this.prisma, async (tx) => {
      alert = null;
      // A trial this session held ends with it, whatever the failure says (§6.5): released here, and the rules below
      // read a refused trial as the next trip from the row's expired block, not from the claim.
      const heldTrial = await tx.$executeRaw`
        UPDATE "account_health" SET "trial_session_id" = NULL, "trial_claimed_at" = NULL, "updated_at" = ${now}
         WHERE "owner_id" = ${ownerId}::uuid AND "subject_key" = ${key} AND "cleared_at" IS NULL
           AND "trial_session_id" = ${failure.sessionId}::uuid`;
      if (scopeModel === null) return null;
      // Idempotent per session: a row this session's failure already wrote, live or cleared since, takes no second.
      const [seen] = await tx.$queryRaw<Array<{ one: number }>>`
        SELECT 1 AS "one" FROM "account_health"
         WHERE "owner_id" = ${ownerId}::uuid AND "subject_key" = ${key} AND "scope_model" = ${scopeModel}
           AND "last_session_id" = ${failure.sessionId}::uuid
         LIMIT 1`;
      if (seen) return null;
      // Twice at most: a live row inserted by a concurrent failure between our read and our insert is read again.
      for (let pass = 0; pass < 2; pass += 1) {
        const [raw] = await tx.$queryRaw<RawRow[]>`
          SELECT "id", "state", "kind", "said", "strikes", "trips", "first_at", "last_at", "last_session_id",
                 "blocked_until", "trial_session_id", "trial_claimed_at", "notified_kind"
            FROM "account_health"
           WHERE "owner_id" = ${ownerId}::uuid AND "subject_key" = ${key} AND "scope_model" = ${scopeModel}
             AND "cleared_at" IS NULL
             FOR UPDATE`;
        const current = raw ? rowOf(raw) : null;
        const step = stepOnFailure(current, failure, now);
        const next = step.next;
        if (!next) return null;
        // What the run records of it (§7.4), in the transaction that writes the row: a run whose failure was the
        // account's is not held against its task. Once per run; a run that is no session writes nothing.
        const effect = failureEffect(step, heldTrial > 0);
        if (effect) {
          await tx.session.updateMany({
            where: { id: failure.sessionId, accountHealthEffect: null },
            data: { accountHealthEffect: effect },
          });
        }
        if (current && !step.expirePrevious) {
          await tx.accountHealth.update({
            where: { id: current.id },
            data: {
              state: next.state, kind: next.kind, said: next.said, strikes: next.strikes, trips: next.trips,
              firstAt: next.firstAt, lastAt: next.lastAt, lastSessionId: next.lastSessionId, blockedUntil: next.blockedUntil,
              trialSessionId: next.trialSessionId, trialClaimedAt: next.trialClaimedAt, updatedAt: now,
            },
          });
          alert = await claimAlert(tx, ownerId, key, scopeModel, current.id, next, raw?.notified_kind ?? null, now);
          return effect;
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
        if (inserted.length) {
          // A new live row is a new streak: nothing was alerted for it yet.
          alert = await claimAlert(tx, ownerId, key, scopeModel, inserted[0].id, next, null, now);
          return effect;
        }
      }
      throw new Error('account_health: the live row moved twice under one failure');
    }, loggedRetry(this.log, 'accountHealth.recordFailure'));
    // After the commit and never in its way: the row says the owner was told, the push is best effort (§8).
    const owed = alert as AccountNeedsAction | null;
    if (owed) void this.alertOwner(ownerId, owed);
    return effect;
  }

  private async alertOwner(ownerId: string, alert: AccountNeedsAction): Promise<void> {
    try {
      const push = this.moduleRef?.get(PushService, { strict: false });
      await push?.notifyAccountNeedsAction(ownerId, alert);
    } catch (e) {
      this.log.warn(`account-needs-action push not sent for ${alert.subjectKey}: ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * The owner's Check again (§8): the live rows of this account (the account-level row and its model rows) are cleared,
   * `cleared_by = OWNER`, the ladder reset and any claimed trial dropped. Returns how many rows it cleared; zero when
   * the row was already cleared or is not the owner's. The next failure is trip 1 of a new streak.
   */
  async checkAgain(ownerId: string, id: string, now = new Date()): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "account_health" AS h
         SET "cleared_at" = ${now}, "cleared_by" = 'OWNER', "trial_session_id" = NULL, "trial_claimed_at" = NULL,
             "updated_at" = ${now}
        FROM "account_health" AS src
       WHERE src."id" = ${id}::uuid AND src."owner_id" = ${ownerId}::uuid AND src."cleared_at" IS NULL
         AND h."owner_id" = src."owner_id" AND h."subject_key" = src."subject_key" AND h."cleared_at" IS NULL`;
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
    return claimTrialByKey(this.prisma, ownerId, subjectKey(subject), scopeModel, sessionId, now);
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
    return liveAccountHealth(this.prisma, ownerId, now);
  }

  /**
   * A run of `sessionId` ended or finished a turn (§6.3): hand what it did to the rules, on the account it spent.
   *
   * - FAILED: recordFailure with runFailureKind's answer, the runner's admission flag or, from an older runner,
   *   the one §5.2 derives. An unclassified failure the runner says was admitted is the account working: a success.
   * - Admitted otherwise (a turn completed, or the run had turns): recordSuccess on the account and the run's model.
   * - Neither (cancelled or lost before any turn): a trial it held is due again (releaseTrial).
   *
   * After the release committed, and never in its way: a failure here is logged and the run's end stands.
   */
  async afterRunEnd(
    sessionId: string,
    end: { failed: boolean; turnCompleted?: boolean; until?: string | null },
    now = new Date(),
  ): Promise<void> {
    try {
      const session = await this.prisma.session.findUnique({ where: { id: sessionId }, select: HEALTH_SESSION_SELECT });
      if (!session) return;
      // A success on an owner with no live row at all changes nothing: one indexed read, no subject resolved.
      if (!end.failed && !(await hasLiveHealth(this.prisma, session.ownerId))) return;
      const resolved = await sessionHealthSubject(this.prisma, session, now);
      if (!resolved) return;
      const { subject, runnerOnline, usageReadingCovers } = resolved;
      if (end.failed) {
        const kind = runFailureKind(session);
        const admission = session.admissionFailure ?? (await derivedAdmission(this.prisma, session));
        if (kind === null && session.admissionFailure === false) {
          await this.recordSuccess(session.ownerId, subject, session.model, now);
          return;
        }
        const until = end.until ? new Date(end.until) : null;
        await this.recordFailure(session.ownerId, subject, {
          sessionId,
          kind,
          scope: (session.failureScope as AccountHealthFailure['scope']) ?? null,
          model: session.model,
          until: until && Number.isFinite(until.getTime()) ? until : null,
          said: session.failureSaid,
          admission,
          runnerOnline,
          usageReadingCovers,
        }, now);
        return;
      }
      if (end.turnCompleted || session.numTurns > 0) {
        await this.recordSuccess(session.ownerId, subject, session.model, now);
      } else {
        await this.releaseTrial(session.ownerId, subject, sessionId, now);
      }
    } catch (e) {
      this.log.warn(`account health not recorded for session ${sessionId}: ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * A SubAgent attempt ended (§6.3): failed on what its engine adapter classified (the fallback route), or the run
   * ended with the attempt it was on (the run's end). The attempt's own account: a Claude pool member by its
   * provider, a Codex pool login by its account, an engine's sign-in on the parent's runner, or a key. A SubAgent
   * run is no session, so its id stands in for one in the row's evidence and no run records an effect.
   */
  async afterSubagentAttempt(args: {
    ownerId: string;
    runId: string;
    runnerId: string | null;
    workspaceId: string | null;
    attempt: { engine: string; provider: string; model: string; poolMember?: { providerId?: string; accountId?: string } };
    failed: boolean;
    error?: string | null;
    failure?: { kind?: string; scope?: string; said?: string; until?: string } | null;
    admission?: boolean | null;
  }, now = new Date()): Promise<void> {
    try {
      if (!args.failed && !(await hasLiveHealth(this.prisma, args.ownerId))) return;
      const { attempt } = args;
      let subject: AccountHealthSubject | null = null;
      if (attempt.poolMember?.providerId) subject = { type: 'provider', providerId: attempt.poolMember.providerId };
      else if (attempt.poolMember?.accountId) {
        const pool = await this.prisma.providerPool.findFirst({ where: { slug: attempt.provider, ownerId: args.ownerId }, select: { id: true } });
        subject = pool ? { type: 'pool-login', poolId: pool.id, accountId: attempt.poolMember.accountId } : null;
      } else {
        subject = await routeSubject(this.prisma, args.ownerId, {
          runnerId: args.runnerId, workspaceId: args.workspaceId, engine: attempt.engine, provider: attempt.provider,
          builtin: isEngine(attempt.provider),
        }, null, now);
      }
      if (!subject) return;
      if (!args.failed) {
        await this.recordSuccess(args.ownerId, subject, attempt.model, now);
        return;
      }
      const runner = args.runnerId
        ? await this.prisma.runner.findUnique({ where: { id: args.runnerId }, select: { status: true } })
        : null;
      const kind = runFailureKind({ failureKind: args.failure?.kind ?? null, error: args.error ?? null });
      const until = args.failure?.until ? new Date(args.failure.until) : null;
      await this.recordFailure(args.ownerId, subject, {
        sessionId: args.runId,
        kind,
        scope: (args.failure?.scope as AccountHealthFailure['scope']) ?? null,
        model: attempt.model,
        until: until && Number.isFinite(until.getTime()) ? until : null,
        said: args.failure?.said ?? null,
        // No server-side derivation for a SubAgent: only what its runner measured feeds the breaker.
        admission: args.admission === true,
        runnerOnline: runner?.status === RunnerStatus.ONLINE,
      }, now);
    } catch (e) {
      this.log.warn(`account health not recorded for SubAgent run ${args.runId}: ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * §6.3: a fresh sign-in, a key saved again or a changed plan reading may be the fix, so the trial of every block
   * on those accounts is due now. The ladder is kept: only the owner's Check again resets it.
   */
  async makeTrialDue(
    ownerId: string,
    where: { runnerId: string; engine: string; account?: string } | { providerId: string },
    now = new Date(),
  ): Promise<number> {
    return makeTrialDue(this.prisma, ownerId, where, now);
  }
}

type HealthDb = Prisma.TransactionClient | PrismaService;

/** What the `account-needs-action` push says (§8): the row it is about, and the words it is made of. */
export interface AccountNeedsAction {
  rowId: string;
  subjectKey: string;
  /** A classified `RunFailureKind`, or `UNCLASSIFIED_ADMISSION` for the breaker. */
  kind: string;
  said: string | null;
  trips: number;
  blockedUntil: Date | null;
  since: Date;
  /** The model the row is about; '' for the whole account. */
  scopeModel: string;
}

/**
 * §8: inside the failure's transaction (the row is locked), decide whether this write owes the owner a push and
 * record it on the row, so two replicas cannot both send. A row about one model whose account was already alerted
 * (another live row of the subject has `notified_at`) is marked but not sent: not the same account on another model.
 */
async function claimAlert(
  tx: Prisma.TransactionClient,
  ownerId: string,
  key: string,
  scopeModel: string,
  rowId: string,
  next: AccountHealthRow,
  notifiedKind: string | null,
  now: Date,
): Promise<AccountNeedsAction | null> {
  if (!alertDue(next, notifiedKind)) return null;
  await tx.$executeRaw`UPDATE "account_health" SET "notified_at" = ${now}, "notified_kind" = ${next.kind} WHERE "id" = ${rowId}::uuid`;
  if (scopeModel !== '') {
    const [sibling] = await tx.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS "one" FROM "account_health"
       WHERE "owner_id" = ${ownerId}::uuid AND "subject_key" = ${key} AND "cleared_at" IS NULL
         AND "id" <> ${rowId}::uuid AND "notified_at" IS NOT NULL LIMIT 1`;
    if (sibling) return null;
  }
  return { rowId, subjectKey: key, kind: next.kind, said: next.said, trips: next.trips, blockedUntil: next.blockedUntil, since: next.firstAt, scopeModel };
}

/**
 * A dispatch is about to start `sessionId`'s run on the account `key` names (§6.5): if its block ran out, its run is
 * the one trial, claimed by one conditional UPDATE, so two dispatches racing for one due trial cannot both win. A
 * claim is free to take while nobody holds it, or once it is 15 minutes old and its session is not running.
 */
export async function claimTrialByKey(
  db: HealthDb,
  ownerId: string,
  key: string,
  scopeModel: string,
  sessionId: string,
  now = new Date(),
): Promise<TrialClaim> {
  const stale = new Date(now.getTime() - TRIAL_CLAIM_STALE_MS);
  const claimed = await db.$executeRaw`
    UPDATE "account_health" AS h
       SET "trial_session_id" = ${sessionId}::uuid, "trial_claimed_at" = ${now}, "updated_at" = ${now}
     WHERE h."owner_id" = ${ownerId}::uuid AND h."subject_key" = ${key} AND h."scope_model" = ${scopeModel}
       AND h."cleared_at" IS NULL AND h."state" = 'BLOCKED' AND h."blocked_until" <= ${now}
       AND (h."trial_session_id" IS NULL
            OR h."trial_session_id" = ${sessionId}::uuid
            OR (h."trial_claimed_at" <= ${stale}
                AND NOT EXISTS (SELECT 1 FROM "session" s WHERE s."id" = h."trial_session_id" AND ${sessionTurnStateSql('s')} = 'IN_FLIGHT')))`;
  if (claimed > 0) return 'CLAIMED';
  const [row] = await db.$queryRaw<Array<{ due: boolean }>>`
    SELECT ("state" = 'BLOCKED' AND "blocked_until" <= ${now}) AS "due"
      FROM "account_health"
     WHERE "owner_id" = ${ownerId}::uuid AND "subject_key" = ${key} AND "scope_model" = ${scopeModel}
       AND "cleared_at" IS NULL`;
  return row?.due ? 'HELD' : 'NOT_DUE';
}

/** Every live row of an owner's accounts with what the rules make of it at `now`; rows that ran out are left out. */
export async function liveAccountHealth(db: HealthDb, ownerId: string, now = new Date()): Promise<AccountHealthEntry[]> {
  const rows = await db.$queryRaw<Array<RawRow & { subject_key: string; scope_model: string; trial_running: boolean }>>`
    SELECT h."id", h."subject_key", h."scope_model", h."state", h."kind", h."said", h."strikes", h."trips",
           h."first_at", h."last_at", h."last_session_id", h."blocked_until", h."trial_session_id", h."trial_claimed_at",
           EXISTS (SELECT 1 FROM "session" s WHERE s."id" = h."trial_session_id" AND ${sessionTurnStateSql('s')} = 'IN_FLIGHT') AS "trial_running"
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

/** A live entry as routing input carries it (§7.1): its state, the one model it is about (null: the account), when. */
export function routingHealthEntry(entry: AccountHealthEntry): RoutingHealthEntry {
  const until = entry.view === 'suspect'
    ? entry.lastAt.getTime() + SUSPECT_WINDOW_MS
    : entry.view === 'trial-running' && entry.trialClaimedAt
      ? entry.trialClaimedAt.getTime() + TRIAL_CLAIM_STALE_MS
      : entry.blockedUntil?.getTime() ?? entry.lastAt.getTime();
  return {
    state: entry.view as RoutingHealthEntry['state'],
    model: entry.scopeModel === '' ? null : entry.scopeModel,
    kind: entry.kind,
    ...(entry.said ? { said: entry.said } : {}),
    since: entry.firstAt.getTime(),
    last: entry.lastAt.getTime(),
    until,
    trips: entry.trips,
    subject: entry.subjectKey,
  };
}

/** The owner's live health by subject key, in the one batched read the router makes (§7.1). */
export async function routingHealthIndex(db: HealthDb, ownerId: string, now = new Date()): Promise<Map<string, RoutingHealthEntry[]>> {
  const index = new Map<string, RoutingHealthEntry[]>();
  for (const entry of await liveAccountHealth(db, ownerId, now)) {
    const list = index.get(entry.subjectKey) ?? [];
    list.push(routingHealthEntry(entry));
    index.set(entry.subjectKey, list);
  }
  return index;
}

/** Whether the owner has any live row: what lets a success skip resolving its account. */
async function hasLiveHealth(db: HealthDb, ownerId: string): Promise<boolean> {
  const [row] = await db.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS "one" FROM "account_health" WHERE "owner_id" = ${ownerId}::uuid AND "cleared_at" IS NULL LIMIT 1`;
  return row !== undefined;
}

/** See AccountHealthService.makeTrialDue. */
export async function makeTrialDue(
  db: HealthDb,
  ownerId: string,
  where: { runnerId: string; engine: string; account?: string } | { providerId: string },
  now = new Date(),
): Promise<number> {
  const scope = 'providerId' in where
    ? Prisma.sql`"provider_id" = ${where.providerId}::uuid`
    : where.account !== undefined
      ? Prisma.sql`"subject_key" = ${subjectKey({ type: 'runner', runnerId: where.runnerId, engine: where.engine, account: where.account })}`
      : Prisma.sql`"runner_id" = ${where.runnerId}::uuid AND "engine" = ${where.engine}`;
  return db.$executeRaw`
    UPDATE "account_health" SET "blocked_until" = ${now}, "updated_at" = ${now}
     WHERE "owner_id" = ${ownerId}::uuid AND "cleared_at" IS NULL AND "state" = 'BLOCKED'
       AND "blocked_until" > ${now} AND ${scope}`;
}

const HEALTH_SESSION_SELECT = {
  id: true, ownerId: true, error: true, failureKind: true, failureScope: true, failureSaid: true, admissionFailure: true,
  engine: true, provider: true, providerBuiltin: true, model: true, assignedRunnerId: true, workspaceId: true,
  poolMemberProviderId: true, poolCodexAccountId: true, poolKeyId: true,
  codexAccount: true, claudeAccount: true, kimiAccount: true, antigravityAccount: true, cursorAccount: true,
  costUsd: true, numTurns: true, createdAt: true, startedAt: true, finishedAt: true,
} satisfies Prisma.SessionSelect;

type HealthSession = Prisma.SessionGetPayload<{ select: typeof HEALTH_SESSION_SELECT }>;

/**
 * The account a run spent (§6.1), as routing names it: a Claude pool member or a key by its provider row, a Codex
 * pool login by its pool and account, and an engine's own sign-in by its runner, engine and the account runAccount
 * resolves for the session, as dispatch ran it. Null for what health keeps no record of: a shared pool's key, an
 * engine without a sign-in, a run whose env brings its own credential, a provider that is gone.
 */
export async function sessionHealthSubject(
  db: HealthDb,
  session: HealthSession,
  now: Date,
): Promise<{ subject: AccountHealthSubject; runnerOnline: boolean; usageReadingCovers: boolean } | null> {
  const runner = session.assignedRunnerId
    ? await db.runner.findUnique({
      where: { id: session.assignedRunnerId },
      select: { id: true, status: true, engines: true, accountNames: true, accountPauses: true, defaultRemoved: true, planUsage: true },
    })
    : null;
  const runnerOnline = runner?.status === RunnerStatus.ONLINE;
  if (session.poolMemberProviderId) {
    return { subject: { type: 'provider', providerId: session.poolMemberProviderId }, runnerOnline, usageReadingCovers: false };
  }
  if (session.poolCodexAccountId) {
    const pool = await db.providerPool.findFirst({ where: { slug: session.provider, ownerId: session.ownerId }, select: { id: true } });
    return pool
      ? { subject: { type: 'pool-login', poolId: pool.id, accountId: session.poolCodexAccountId }, runnerOnline, usageReadingCovers: false }
      : null;
  }
  if (session.poolKeyId) return null;
  const engine = await sessionEngine(db as Prisma.TransactionClient, session);
  if (!engine) return null;
  const subject = await routeSubject(db, session.ownerId, {
    runnerId: session.assignedRunnerId, workspaceId: session.workspaceId, engine, provider: session.provider,
    builtin: session.providerBuiltin ?? isEngine(session.provider),
  }, session, now);
  if (!subject) return null;
  return {
    subject,
    runnerOnline,
    usageReadingCovers: subject.type === 'runner' && runner
      ? planUsageReported(runner.planUsage as PlanUsage | null, engine, subject.account)
      : false,
  };
}

/**
 * The account a run on `provider` × `engine` spends when it is no pool's (§6.1): a key by its provider row, an
 * engine's own sign-in by its runner, engine and the account runAccount resolves, as dispatch ran it (`chosen`: the
 * session's own account picks, which the workspace's fill in). Null for what health keeps no record of.
 */
async function routeSubject(
  db: HealthDb,
  ownerId: string,
  run: { runnerId: string | null; workspaceId: string | null; engine: string; provider: string; builtin: boolean },
  chosen: Partial<Record<(typeof ACCOUNT_CHOICE)[keyof typeof ACCOUNT_CHOICE], string | null>> | null,
  now: Date,
): Promise<AccountHealthSubject | null> {
  if (!run.builtin) {
    const row = await db.modelProvider.findFirst({
      where: { slug: run.provider, OR: [{ ownerId }, { ownerId: null }] },
      orderBy: { ownerId: { sort: 'asc', nulls: 'last' } },
      select: { id: true },
    });
    return row ? { type: 'provider', providerId: row.id } : null;
  }
  const engine = run.engine;
  if (!engineKeepsAccounts(engine) || !run.runnerId) return null;
  const runner = await db.runner.findUnique({
    where: { id: run.runnerId },
    select: { id: true, engines: true, accountNames: true, accountPauses: true, defaultRemoved: true, planUsage: true },
  });
  if (!runner) return null;
  const workspace = run.workspaceId
    ? await db.workspace.findUnique({
      where: { id: run.workspaceId },
      select: { env: true, codexAccount: true, claudeAccount: true, kimiAccount: true, antigravityAccount: true, cursorAccount: true },
    })
    : null;
  const choice = ACCOUNT_CHOICE[engine];
  const choices = { ...(workspace ?? {}), [choice]: chosen?.[choice] ?? workspace?.[choice] ?? null };
  const account = runnerSubjectAccount(runAccount(engine, workspace?.env, choices, runner, now));
  return account === null ? null : { type: 'runner', runnerId: runner.id, engine, account };
}

/** §5.2 for a runner too old to say: the run's first turn, no cost, no tool call, ended within 60 s of starting. */
async function derivedAdmission(db: HealthDb, session: HealthSession): Promise<boolean> {
  if (session.numTurns > 1) return false;
  if (session.costUsd > 0) return false;
  const started = (session.startedAt ?? session.createdAt).getTime();
  const ended = (session.finishedAt ?? new Date()).getTime();
  if (ended - started > ADMISSION_WINDOW_MS) return false;
  const tool = await db.runEvent.findFirst({ where: { sessionId: session.id, type: RunEventType.TOOL_USE }, select: { id: true } });
  return tool === null;
}

/** How soon after it started a run with no reply, tool call or cost must end to read as refused at admission (§5.2). */
const ADMISSION_WINDOW_MS = 60_000;

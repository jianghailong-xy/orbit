import { Prisma, type ManagedRunner } from '@prisma/client';

import { sessionHeldSql } from '../common/session-release';
import { sessionExecutingOutsideTurnSql } from '../common/session-working';
import { sessionTurnStateSql } from '../sessions/session-turn-state';
import { autoRetryEligibleSql } from '../sessions/auto-retry-eligibility';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * What the control plane records that a runner still has to do, and the demand counter a mapping
 * keeps (docs/managed-runner-design.md, "Provisioning retry wake and sleep" 5 to 8). Read by the
 * manager before it drains a runner to sleep and, for a sleeping one, on every pass to repair a wake
 * a hook missed; written by the demand hook (managed-runner-demand.ts) and that sweep. Plain
 * functions over the database, so the manager uses them without the Nest service.
 */

/**
 * Record demand on the runner's mapping: the demand counter and time, and RUNNING desired — which
 * is what wakes a sleeping mapping and calls off a drain that has not been acknowledged. One
 * statement by the runner's unique key; a deleted mapping is not woken, and neither is one whose
 * owner an administrator disabled — nothing is recorded for it, and its account enabled again, the
 * work still waiting is found by the sweep. Null: not a managed runner, or not one demand may wake.
 */
export async function recordManagedDemand(
  prisma: Pick<PrismaService, 'managedRunner'>,
  runnerId: string,
  now: Date,
): Promise<ManagedRunner | null> {
  const { count } = await prisma.managedRunner.updateMany({
    where: { runnerId, desiredState: { not: 'DELETED' }, owner: { disabledAt: null } },
    data: { demandRevision: { increment: 1 }, lastDemandAt: now, desiredState: 'RUNNING' },
  });
  return count === 0 ? null : prisma.managedRunner.findUnique({ where: { runnerId } });
}

/** The work a runner holds, as the control plane records it: each a reason it may not sleep. */
export type ManagedRunnerWork =
  | 'ACTIVE_TURN'
  | 'QUEUED_TURN'
  | 'BACKGROUND_WORK'
  | 'WORKTREE_OPERATION'
  | 'DUE_WAKEUP'
  | 'DUE_RETRY'
  | 'INTEGRATION_JOB'
  | 'REPOSITORY_OPERATION'
  | 'RESET_OPERATION'
  | 'RUNNER_OPERATION'
  | 'ACTIVE_CONDITION';

/** The sign-in states with a CLI of the runner's still in play (runner-api.controller drainLoginRequest). */
const LOGIN_IN_FLIGHT = Prisma.sql`ARRAY['pending', 'awaiting_code', 'awaiting_approval', 'cancelling']::text[]`;

/** A background shell of `s`, which the shared executing facts leave out: sleep counts it on top. */
const BACKGROUND_SHELL_SQL = `cardinality(s."running_bg_shells") > 0`;

/**
 * One EXISTS per kind of work, about one runner. Shared by the sleep decision (all of it) and the
 * sweep (what can wake a runner), so the two read the same facts the same way.
 */
function workSql(runner: Prisma.Sql) {
  const onRunner = Prisma.sql`s."assigned_runner_id" = ${runner}`;
  // A turn in flight (RUNNING) or queued (PENDING), on the runner's held rows (session_runner_held_idx).
  const turn = (state: 'IN_FLIGHT' | 'QUEUED') =>
    Prisma.sql`${sessionHeldSql('s')} AND ${sessionTurnStateSql('s')} = ${Prisma.raw(`'${state}'`)}`;
  return {
    ACTIVE_TURN: Prisma.sql`EXISTS (SELECT 1 FROM "session" s WHERE ${onRunner} AND ${turn('IN_FLIGHT')})`,
    QUEUED_TURN: Prisma.sql`EXISTS (SELECT 1 FROM "session" s WHERE ${onRunner} AND ${turn('QUEUED')} AND s."cancel_requested_at" IS NULL)`,
    // What a session that is still open executes outside a dispatched turn (the engine's own turn, a
    // subagent, a background job: common/session-working.ts), plus this reader's own addition, any
    // background shell — services included, since a process left up still runs on this machine: what
    // the runner's events last said was alive.
    BACKGROUND_WORK: Prisma.sql`EXISTS (SELECT 1 FROM "session" s WHERE ${onRunner}
      AND ${Prisma.raw(sessionExecutingOutsideTurnSql('s', [BACKGROUND_SHELL_SQL]))})`,
    WORKTREE_OPERATION: Prisma.sql`EXISTS (SELECT 1 FROM "session" s WHERE ${onRunner}
      AND (s."merge_status" = 'pending' OR s."commit_status" = 'pending'))`,
    // Already due: a wakeup or a retry still to come stays on the server and wakes the runner then.
    DUE_WAKEUP: Prisma.sql`EXISTS (SELECT 1 FROM "session_scheduled_wakeup" w JOIN "session" s ON s."id" = w."session_id"
      WHERE ${onRunner} AND w."state" = 'PENDING' AND w."due_at" <= now())`,
    DUE_RETRY: Prisma.sql`EXISTS (SELECT 1 FROM "session" s WHERE ${onRunner} AND s."retry_at" IS NOT NULL AND s."retry_at" <= now() AND ${autoRetryEligibleSql('s')})`,
    // A landing runs on the machine its source session's checkout lives on (integration-job-relay
    // claimOne): queued for that machine, or running on it.
    INTEGRATION_JOB: Prisma.sql`EXISTS (SELECT 1 FROM "project_integration_job" j
      WHERE (j."state" = 'RUNNING' AND j."runner_id" = ${runner})
         OR (j."state" = 'QUEUED' AND EXISTS (SELECT 1 FROM "session" s JOIN "workspace" w ON w."id" = s."workspace_id"
              WHERE s."id" = j."session_id" AND w."runner_id" = ${runner})))`,
    REPOSITORY_OPERATION: Prisma.sql`EXISTS (SELECT 1 FROM "wiki_repo_op" o
      WHERE (o."state" = 'running' AND o."runner_id" = ${runner})
         OR (o."state" = 'queued' AND EXISTS (SELECT 1 FROM "workspace" w WHERE w."id" = o."workspace_id" AND w."runner_id" = ${runner})))`,
    RESET_OPERATION: Prisma.sql`EXISTS (SELECT 1 FROM "codex_rate_limit_reset_operation" c WHERE c."runner_id" = ${runner}
      AND (c."consume_state" IN ('PENDING', 'CLAIMED') OR (c."consume_state" = 'CONFIRMED' AND c."refresh_state" = 'PENDING')))`,
    // The runner's one-slot relays: a sign-in, an install, a checkout clean-up, an account removal, a
    // history scan, a directory probe, a catalog refresh or a release check asked for and not yet over.
    RUNNER_OPERATION: Prisma.sql`EXISTS (SELECT 1 FROM "runner" r WHERE r."id" = ${runner} AND (
      r."login_status" = ANY (${LOGIN_IN_FLIGHT}) OR r."install_status" IN ('pending', 'installing')
      OR r."repo_cleanup_status" = 'pending' OR r."codex_account_remove_status" = 'pending'
      OR r."claude_account_swap_status" = 'pending'
      OR r."claude_history_status" = 'pending' OR r."dir_probe_status" = 'pending' OR r."model_catalog_refresh_at" IS NOT NULL
      OR r."self_update_requested_at" IS NOT NULL OR r."self_update_postpone_until" IS NOT NULL
      OR r."self_update_now_requested_at" IS NOT NULL))`,
    // A condition its runner probes (docs/condition-triggers-design.md §4.2, owner 2026-11-17): not ENDED, on one of the
    // runner's live workspaces the probe is handed for (ConditionsService.probesFor), and its owner object live — a
    // WHEN schedule that is ACTIVE (a PAUSED or HELD one releases the runner), or a startWhen task that is OPEN and has
    // not started (a start clears the task's pointer).
    ACTIVE_CONDITION: Prisma.sql`EXISTS (SELECT 1 FROM "condition" c
      JOIN "workspace" w ON w."id" = c."workspace_id" AND w."owner_id" = c."owner_id"
     WHERE w."runner_id" = ${runner} AND w."deleted_at" IS NULL AND w."work_dir" IS NOT NULL AND c."state" <> 'ENDED'
       AND (EXISTS (SELECT 1 FROM "schedule" sc WHERE sc."id" = c."schedule_id" AND sc."state" = 'ACTIVE')
         OR EXISTS (SELECT 1 FROM "task" t WHERE t."id" = c."task_id" AND t."start_when_condition_id" = c."id"
              AND t."status" = 'OPEN')))`,
  } satisfies Record<ManagedRunnerWork, Prisma.Sql>;
}

/** Everything the control plane records that this runner still has to do. Empty: nothing. */
export async function managedRunnerWork(prisma: Pick<PrismaService, '$queryRaw'>, runnerId: string): Promise<ManagedRunnerWork[]> {
  const work = workSql(Prisma.sql`${runnerId}::uuid`);
  const kinds = Object.keys(work) as ManagedRunnerWork[];
  const [row] = await prisma.$queryRaw<Array<Record<ManagedRunnerWork, boolean>>>(Prisma.sql`
    SELECT ${Prisma.join(kinds.map((kind) => Prisma.sql`${work[kind]} AS ${Prisma.raw(`"${kind}"`)}`), ', ')}`);
  return kinds.filter((kind) => row?.[kind]);
}

/** What can wake a runner: work that needs it to run. Not a turn or job the records still show as
 *  alive — a sleeping runner runs none, and the next instance's reclaim settles such records. */
const WAKING_WORK: readonly ManagedRunnerWork[] = [
  'QUEUED_TURN', 'WORKTREE_OPERATION', 'DUE_WAKEUP', 'DUE_RETRY', 'INTEGRATION_JOB', 'REPOSITORY_OPERATION', 'RESET_OPERATION', 'RUNNER_OPERATION',
  // A condition's probe runs only while its runner does: an active one keeps an Orbit Cloud workspace awake.
  'ACTIVE_CONDITION',
];

/** The work, of what this runner holds, that needs it to run (WAKING_WORK): what a FAILED runner's slow retry waits for. */
export async function managedRunnerWaitingWork(prisma: Pick<PrismaService, '$queryRaw'>, runnerId: string, reclaimRunningTurns = false): Promise<ManagedRunnerWork[]> {
  return (await managedRunnerWork(prisma, runnerId))
    .filter((kind) => WAKING_WORK.includes(kind) || (reclaimRunningTurns && kind === 'ACTIVE_TURN'));
}

/**
 * The sweep: sleeping mappings, not yet asked to wake, whose runner has work waiting. The runners'
 * ids, oldest asleep first; the caller records demand for each. A disabled owner's are not among
 * them (demand would wake nothing, and they would keep the batch from the rest) until the account is
 * enabled again.
 */
export async function sleepingRunnersWithDemand(prisma: Pick<PrismaService, '$queryRaw'>, limit: number): Promise<string[]> {
  const work = workSql(Prisma.raw('m."runner_id"'));
  const rows = await prisma.$queryRaw<Array<{ runnerId: string }>>(Prisma.sql`
    SELECT m."runner_id"::text AS "runnerId" FROM "managed_runner" m
      JOIN "user" u ON u."id" = m."owner_id" AND u."disabled_at" IS NULL
     WHERE m."management_state" = 'SLEEPING' AND m."desired_state" = 'SLEEPING'
       AND (${Prisma.join(WAKING_WORK.map((kind) => work[kind]), ' OR ')})
     ORDER BY m."state_entered_at" ASC
     LIMIT ${limit}`);
  return rows.map((row) => row.runnerId);
}

/**
 * The workspaces, of `workspaceIds`, that are on an Orbit Cloud (managed) runner: a condition checked in one keeps it
 * awake while it is active, and its cards and read say so (docs/condition-triggers-design.md §4.2, §6). With the
 * switch off nothing is read and nothing is.
 */
export async function cloudWorkspaceIds(
  prisma: Pick<PrismaService, 'workspace'>,
  gate: { enabled: boolean } | null | undefined,
  workspaceIds: Iterable<string>,
): Promise<Set<string>> {
  const ids = [...new Set(workspaceIds)].filter(Boolean);
  if (!gate?.enabled || ids.length === 0) return new Set();
  const rows = await prisma.workspace.findMany({
    where: { id: { in: ids }, deletedAt: null, runner: { is: { managedRunner: { is: { desiredState: { not: 'DELETED' } } } } } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

import { Prisma, type ManagedRunner } from '@prisma/client';

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
  | 'RUNNER_OPERATION';

/** The sign-in states with a CLI of the runner's still in play (runner-api.controller drainLoginRequest). */
const LOGIN_IN_FLIGHT = Prisma.sql`ARRAY['pending', 'awaiting_code', 'awaiting_approval', 'cancelling']::text[]`;

/**
 * One EXISTS per kind of work, about one runner. Shared by the sleep decision (all of it) and the
 * sweep (what can wake a runner), so the two read the same facts the same way.
 */
function workSql(runner: Prisma.Sql) {
  const onRunner = Prisma.sql`s."assigned_runner_id" = ${runner}`;
  return {
    ACTIVE_TURN: Prisma.sql`EXISTS (SELECT 1 FROM "session" s WHERE ${onRunner} AND s."status" = 'RUNNING')`,
    QUEUED_TURN: Prisma.sql`EXISTS (SELECT 1 FROM "session" s WHERE ${onRunner} AND s."status" = 'PENDING' AND s."cancel_requested_at" IS NULL)`,
    // A turn an engine runs on its own, a background shell or job (watches and services included) or
    // a subagent of a session that is still open: what the runner's events last said was alive.
    BACKGROUND_WORK: Prisma.sql`EXISTS (SELECT 1 FROM "session" s WHERE ${onRunner}
      AND s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
      AND (s."engine_turn_active" OR cardinality(s."running_bg_jobs") > 0
        OR cardinality(s."running_bg_shells") > 0 OR cardinality(s."running_subagents") > 0))`,
    WORKTREE_OPERATION: Prisma.sql`EXISTS (SELECT 1 FROM "session" s WHERE ${onRunner}
      AND (s."merge_status" = 'pending' OR s."commit_status" = 'pending'))`,
    // Already due: a wakeup or a retry still to come stays on the server and wakes the runner then.
    DUE_WAKEUP: Prisma.sql`EXISTS (SELECT 1 FROM "session_scheduled_wakeup" w JOIN "session" s ON s."id" = w."session_id"
      WHERE ${onRunner} AND w."state" = 'PENDING' AND w."due_at" <= now())`,
    DUE_RETRY: Prisma.sql`EXISTS (SELECT 1 FROM "session" s WHERE ${onRunner} AND s."retry_at" IS NOT NULL AND s."retry_at" <= now())`,
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
    // history scan, a catalog refresh or a release check asked for and not yet over.
    RUNNER_OPERATION: Prisma.sql`EXISTS (SELECT 1 FROM "runner" r WHERE r."id" = ${runner} AND (
      r."login_status" = ANY (${LOGIN_IN_FLIGHT}) OR r."install_status" IN ('pending', 'installing')
      OR r."repo_cleanup_status" = 'pending' OR r."codex_account_remove_status" = 'pending'
      OR r."claude_history_status" = 'pending' OR r."model_catalog_refresh_at" IS NOT NULL
      OR r."self_update_requested_at" IS NOT NULL))`,
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
];

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

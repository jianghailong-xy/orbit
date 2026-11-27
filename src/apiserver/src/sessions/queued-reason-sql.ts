import { Prisma } from '@prisma/client';

import { RUNNER_DISK_BELOW_FLOOR, sessionDiskHoldSql } from '../common/runner-disk-gate';
import { worktreeOperationFenceSql } from '../common/session-inbox-fence';
import {
  batchActiveTurns,
  runnerActiveTurns,
  runnerBackgroundHeldSessions,
  treeActiveTurns,
  treeCeiling,
} from '../common/session-tree-sql';
import { workspaceCloneHoldSql, workspaceCloneReasonSql } from '../common/workspace-clone-gate';
import { runnerOfflineSql } from '../runners/runner-presence';
import { sessionTurnStateSql } from './session-turn-state';

/**
 * Which gate holds a queued session, as SQL, in one place: the session list names it to the person waiting
 * (`queuedReason`), and a scheduled run's watch pass reads it to tell a full runner from one that is not
 * coming (docs/scheduled-tasks-design.md §7.2). Written twice, the two would drift, and the run would be
 * retired for a gate the list does not show. The session row is aliased `s` and its assigned runner `r`
 * (LEFT JOINed); the answer means something only for a PENDING row whose cancel was not asked for.
 */
export function queuedReasonSql(): Prisma.Sql {
  return Prisma.sql`CASE
              -- First, because it subsumes every gate below: a runner that is not polling will
              -- not claim this row whatever the counts say, and "waiting for a slot" on an idle
              -- machine is the least useful thing the UI could tell someone. Same rule
              -- deriveSessionCapabilities resumes on, so one runner cannot read online here and
              -- offline there.
              WHEN r.id IS NULL OR ${runnerOfflineSql('r')}
                THEN 'runner_offline'
              -- A GitHub workspace whose clone is not READY (docs/github-workspace-design.md §6): the claim's own gate,
              -- named before capacity, because a slot coming free would not start this session.
              WHEN ${workspaceCloneHoldSql(Prisma.sql`s.workspace_id`)}
                THEN ${workspaceCloneReasonSql(Prisma.sql`s.workspace_id`)}
              -- Keep Free (runner-disk-gate.ts): the claim's own gate on a session that has never run. Before capacity,
              -- because a slot coming free would not start it; it lifts when the runner reports space above its floor.
              WHEN ${sessionDiskHoldSql('s')}
                THEN ${RUNNER_DISK_BELOW_FLOOR}::text
              -- Second, for the offline gate's reason: a runner draining for a self-update claims
              -- nothing whatever its counts say (runner drainForUpdate), so naming a capacity gate
              -- here would send the reader to the wrong cause. Ends only when the update does.
              WHEN r.heartbeat_draining IS TRUE
                THEN 'runner_updating'
              -- Turns plus the slots other sessions' background jobs hold: what the runner itself
              -- admits against, and the claim's own gate (runnerBackgroundHeldSessions). Turns alone read
              -- 10 of 16 on a machine whose other 6 slots were held by bg_run jobs, and this row said
              -- nothing at all.
              WHEN ${runnerActiveTurns(Prisma.sql`s.assigned_runner_id`)}
                   + ${runnerBackgroundHeldSessions(Prisma.sql`s.assigned_runner_id`, Prisma.sql`s.id`)} >= r.max_concurrent
                THEN 'runner_at_capacity'
              WHEN s.root_session_id IS NOT NULL
                   AND ${treeActiveTurns('s')} >= ${treeCeiling(Prisma.sql`s.assigned_runner_id`)}
                THEN 'tree_at_capacity'
              WHEN s.batch_id IS NOT NULL
                   AND ${batchActiveTurns('s')} >= s.batch_max_concurrent
                THEN 'batch_at_capacity'
              -- Last, so a row that was already explained by capacity keeps that explanation.
              -- This one holds for seconds while a merge/commit finishes on the checkout, and
              -- it is the claim's own fence, not a second copy of it.
              WHEN ${worktreeOperationFenceSql('s')}
                THEN 'worktree_op_pending'
            END`;
}

/** The gates that are a full runner, run or batch: a slot coming free starts the session. */
export const CAPACITY_QUEUED_REASONS: ReadonlySet<string> = new Set([
  'runner_at_capacity',
  'tree_at_capacity',
  'batch_at_capacity',
]);

/** Whether a full runner, run or batch holds this session now: PENDING, no cancel asked, and that gate first. */
export async function sessionHeldByCapacity(
  db: { $queryRaw<T = unknown>(query: Prisma.Sql): Prisma.PrismaPromise<T> },
  sessionId: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ reason: string | null }>>(Prisma.sql`
    SELECT ${queuedReasonSql()} AS reason
      FROM "session" s
      LEFT JOIN runner r ON r.id = s.assigned_runner_id
     WHERE s.id = ${sessionId}::uuid
       AND ${sessionTurnStateSql('s')} = 'QUEUED'
       AND s.cancel_requested_at IS NULL`);
  const reason = rows[0]?.reason ?? null;
  return reason !== null && CAPACITY_QUEUED_REASONS.has(reason);
}

/** A session a full runner, run or batch holds: the gate, its numbers, and when the session went PENDING. */
export interface SessionCapacityGate {
  reason: string;
  active: number | null;
  limit: number | null;
  /** Of active, the slots background jobs hold; beside runner_at_capacity only. */
  heldByJobs: number | null;
  since: Date;
}

/**
 * `sessionHeldByCapacity` with the numbers the session list names beside the gate (SessionsService list, its
 * `queuedActive`, `queuedLimit`, `queuedHeldByJobs`), for one session: what a scheduled run's session page says
 * while it waits for a slot. Null when no capacity gate holds it.
 */
export async function sessionCapacityGate(
  db: { $queryRaw<T = unknown>(query: Prisma.Sql): Prisma.PrismaPromise<T> },
  sessionId: string,
): Promise<SessionCapacityGate | null> {
  const rows = await db.$queryRaw<Array<{
    reason: string | null;
    runnerActive: number | bigint | null;
    runnerHeld: number | bigint | null;
    runnerLimit: number | null;
    treeActive: number | bigint | null;
    treeLimit: number | bigint | null;
    batchActive: number | bigint | null;
    batchLimit: number | null;
    since: Date;
  }>>(Prisma.sql`
    SELECT ${queuedReasonSql()} AS reason,
           ${runnerActiveTurns(Prisma.sql`s.assigned_runner_id`)} AS "runnerActive",
           ${runnerBackgroundHeldSessions(Prisma.sql`s.assigned_runner_id`, Prisma.sql`s.id`)} AS "runnerHeld",
           r.max_concurrent AS "runnerLimit",
           ${treeActiveTurns('s')} AS "treeActive",
           ${treeCeiling(Prisma.sql`s.assigned_runner_id`)} AS "treeLimit",
           ${batchActiveTurns('s')} AS "batchActive",
           s.batch_max_concurrent AS "batchLimit",
           COALESCE(s.last_turn_at, s.created_at) AS since
      FROM "session" s
      LEFT JOIN runner r ON r.id = s.assigned_runner_id
     WHERE s.id = ${sessionId}::uuid
       AND ${sessionTurnStateSql('s')} = 'QUEUED'
       AND s.cancel_requested_at IS NULL`);
  const row = rows[0];
  if (!row?.reason || !CAPACITY_QUEUED_REASONS.has(row.reason)) return null;
  const n = (v: number | bigint | null) => (v == null ? null : Number(v));
  const [active, limit] = row.reason === 'runner_at_capacity'
    ? [(n(row.runnerActive) ?? 0) + (n(row.runnerHeld) ?? 0), n(row.runnerLimit)]
    : row.reason === 'tree_at_capacity'
      ? [n(row.treeActive), n(row.treeLimit)]
      : [n(row.batchActive), n(row.batchLimit)];
  return {
    reason: row.reason,
    active,
    limit,
    heldByJobs: row.reason === 'runner_at_capacity' ? n(row.runnerHeld) : null,
    since: row.since,
  };
}

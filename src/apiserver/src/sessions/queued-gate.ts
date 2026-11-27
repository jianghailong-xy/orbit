import { Prisma } from '@prisma/client';
import { OVER_CAPACITY_V1 } from '@orbit/shared';
import { RUNNER_DISK_BELOW_FLOOR } from '../common/runner-disk-gate';
import {
  batchActiveTurns,
  overCapacityPassPendingSql,
  runnerActiveTurns,
  runnerBackgroundHeldSessions,
  treeActiveTurns,
  treeCeiling,
} from '../common/session-tree-sql';
import {
  WORKSPACE_CLONE_FAILED,
  WORKSPACE_CLONING,
} from '../common/workspace-clone-gate';
import { queuedReasonSql } from './queued-reason-sql';
import { sessionTurnStateSql } from './session-turn-state';

/**
 * Which gate is holding a queued session, and against what numbers: the session list's `queuedReason`, and what Run
 * now (docs/mocks/queued-run-now) decides on. Written once because both read it, and a list that names one gate while
 * the door refuses on another is worse than either alone. Every count and ceiling is the SAME fragment the claim
 * decides with (session-tree-sql.ts).
 *
 * The lateral reads the session as `s` and its runner as `r` (a LEFT JOIN: `r.id` NULL when it has none). Only a
 * queued row the owner has not cancelled carries an answer; for the rest it yields no row. Asked inside, behind
 * OFFSET 0, rather than on the join: as a join condition the planner flattened this subquery and computed every gate's
 * counts for every row of the list, then dropped all but the PENDING ones (production, 2026-11-19: 1,297 rows for 15,
 * 130k of the statement's 154k buffers and 175 ms of its 289). Here it is a one-time filter.
 */
export function queuedGateLateral(): Prisma.Sql {
  return Prisma.sql`
    SELECT reason, active, "limit", held,
           g.runner_active AS "runnerActive", g.runner_held AS "runnerHeld", g.runner_limit AS "runnerLimit",
           g.runner_burst AS "runnerBurst", g.runner_overflow AS "runnerOverflow", g.pass_pending AS "passPending"
      FROM (
      SELECT
        -- The gate itself is queuedReasonSql: one CASE for the list, a scheduled run's watch and this door.
        ${queuedReasonSql()} AS reason,
        ${runnerActiveTurns(Prisma.sql`s.assigned_runner_id`)} AS runner_active,
        -- Other sessions' holders, as the gate itself and the runner count them: a session's own job holds no slot
        -- against its own message, so counted here it read one over the limit (5/4).
        ${runnerBackgroundHeldSessions(Prisma.sql`s.assigned_runner_id`, Prisma.sql`s.id`)} AS runner_held,
        r.max_concurrent AS runner_limit,
        -- What Run now decides on beside the counts: the runner's Extra sessions on demand, whether its process
        -- admits a turn claimed over its limit, and whether this session already holds a pass for its queued turn.
        r.burst_concurrent AS runner_burst,
        COALESCE(${OVER_CAPACITY_V1} = ANY(r.capabilities), false) AS runner_overflow,
        ${overCapacityPassPendingSql('s')} AS pass_pending,
        ${treeActiveTurns('s')} AS tree_active,
        ${treeCeiling(Prisma.sql`s.assigned_runner_id`)} AS tree_limit,
        ${batchActiveTurns('s')} AS batch_active,
        s.batch_max_concurrent AS batch_limit
      ) g,
      LATERAL (
        SELECT
          CASE g.reason
            -- The turns the drain waits for: every one in flight on the runner.
            WHEN 'runner_updating'    THEN g.runner_active
            WHEN 'runner_at_capacity' THEN g.runner_active + g.runner_held
            WHEN 'tree_at_capacity'   THEN g.tree_active
            WHEN 'batch_at_capacity'  THEN g.batch_active
          END AS active,
          CASE g.reason
            WHEN 'runner_at_capacity' THEN g.runner_limit
            WHEN 'tree_at_capacity'   THEN g.tree_limit
            WHEN 'batch_at_capacity'  THEN g.batch_limit
          END AS "limit",
          -- Of active, the slots background jobs hold (runner_at_capacity only): the part of a
          -- full runner its list of running turns does not show.
          CASE g.reason WHEN 'runner_at_capacity' THEN g.runner_held END AS held
      ) n
     WHERE ${sessionTurnStateSql('s')} = 'QUEUED' AND s.cancel_requested_at IS NULL
    OFFSET 0`;
}

/** The three slot gates Run now lifts (decision D): a full runner, run or batch. */
export const RUN_NOW_REASONS: readonly string[] = ['runner_at_capacity', 'tree_at_capacity', 'batch_at_capacity'];

/** What queuedGateLateral answers for one row, as the mapper and the door read it. */
export interface QueuedGateRow {
  reason: string | null;
  runnerActive: bigint | number | null;
  runnerHeld: bigint | number | null;
  runnerLimit: number | null;
  runnerBurst: number | null;
  runnerOverflow: boolean | null;
  passPending: boolean | null;
}

/** Whether Run now can start this queued message, and if not, the sentence that says why. */
export interface RunNow {
  available: boolean;
  /** English, for the disabled button's line; null when it is available. */
  refusal: string | null;
}

/**
 * Run now on a row the gate holds, or null where the button is not drawn at all: a row no slot gate holds. The
 * refusals, in the order a person can do something about them: a runner too old to admit an overflow turn, one
 * whose owner set no extra sessions, one already as far over as it may go, and a message already passed.
 */
export function runNowOf(gate: QueuedGateRow, runnerName: string | null): RunNow | null {
  if (gate.reason == null || !RUN_NOW_REASONS.includes(gate.reason)) return null;
  const name = runnerName?.trim() || 'This runner';
  const owned = runnerName?.trim() ? `${runnerName.trim()}'s` : "This session's";
  if (!gate.runnerOverflow) return { available: false, refusal: `${owned} runner is too old to run over its limit.` };
  const burst = gate.runnerBurst ?? 0;
  if (burst <= 0) {
    return { available: false, refusal: `${name} takes no sessions over its limit: its Extra sessions on demand is 0.` };
  }
  const limit = gate.runnerLimit ?? 0;
  const active = Number(gate.runnerActive ?? 0) + Number(gate.runnerHeld ?? 0);
  if (active >= limit + burst) {
    return {
      available: false,
      refusal: `${name} is already ${active - limit} over its limit, the most it can take. Wait, or stop another session.`,
    };
  }
  if (gate.passPending) return { available: false, refusal: `This message is already starting over ${name}'s limit.` };
  return { available: true, refusal: null };
}

/**
 * Why Run now is refused on a row no slot gate holds (decision D): a free slot would not start it, so neither does
 * one over the limit. Null for a slot gate, which runNowOf answers.
 */
export function runNowGateRefusal(reason: string | null, runnerName: string | null): string | null {
  const name = runnerName?.trim() || "This session's runner";
  switch (reason) {
    case null:
      return 'This message is not waiting for a free slot.';
    case 'runner_offline':
      return `${name} is offline, so running over its limit would not start this message.`;
    case 'runner_updating':
      return `${name} is updating and starts no new turn until it is done, over its limit or not.`;
    case RUNNER_DISK_BELOW_FLOOR:
      return `${name} is below its Keep Free disk floor, so running over its limit would not start this message.`;
    case WORKSPACE_CLONING:
      return "This workspace is still being cloned, so running over the limit would not start this message.";
    case WORKSPACE_CLONE_FAILED:
      return "This workspace's clone failed, so running over the limit would not start this message.";
    case 'worktree_op_pending':
      return "A merge or commit is still running on this session's checkout, so running over the limit would not start this message.";
    default:
      return RUN_NOW_REASONS.includes(reason) ? null : 'This message is not waiting for a free slot.';
  }
}

/** The list row's Run now columns, as `GET /sessions` reads them beside queuedReason. */
export interface QueuedRunNowColumns {
  queuedReason: string | null;
  queuedRunnerActive: bigint | number | null;
  queuedRunnerHeld: bigint | number | null;
  queuedRunnerLimit: number | null;
  queuedRunnerBurst: number | null;
  queuedRunnerOverflow: boolean | null;
  queuedPassPending: boolean | null;
  runnerLabel: string | null;
}

/**
 * What a client draws Run now from, beside a slot gate: whether the button presses, the sentence under a disabled
 * one, and the runner's Extra sessions on demand. False, null and null on a row no slot gate holds.
 */
export function queuedRunNowOf(row: QueuedRunNowColumns): {
  runNowAvailable: boolean;
  runNowRefusal: string | null;
  queuedBurstLimit: number | null;
} {
  const runNow = runNowOf({
    reason: row.queuedReason,
    runnerActive: row.queuedRunnerActive,
    runnerHeld: row.queuedRunnerHeld,
    runnerLimit: row.queuedRunnerLimit,
    runnerBurst: row.queuedRunnerBurst,
    runnerOverflow: row.queuedRunnerOverflow,
    passPending: row.queuedPassPending,
  }, row.runnerLabel);
  return {
    runNowAvailable: runNow?.available ?? false,
    runNowRefusal: runNow?.refusal ?? null,
    queuedBurstLimit: runNow ? row.queuedRunnerBurst : null,
  };
}

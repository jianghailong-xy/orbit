/**
 * Where §13.1's recomputation actually runs on the write path.
 *
 * `planTaskAggregation` is a pure function and `ProjectReconcileService` already applies it — but
 * only inside a reconcile, and a reconcile only happens for a Project whose coordinator is
 * ENABLED. `completionPolicy` is a column on Task, not on Project: it is set through the ordinary
 * task doors, it is legal on a task that is in no project at all, and until this module existed
 * the answer to "what does ALL_CHILDREN_DONE do on my tasks" was "nothing, unless you also turn
 * on a control loop you did not ask for". A parent left asserting a completion its own subtree
 * stopped supporting is exactly AG3's failure, and it does not become acceptable because nobody
 * enabled a coordinator.
 *
 * So the same plan is applied here too, by the writes that can change its inputs. Applying it
 * twice is harmless and is the point of AG1: it is a recomputation with no idempotency key, so
 * the reconcile pass and this one converge on the same answer rather than counting each other.
 *
 * What this deliberately does NOT do is dispatch. Moving a parent to DONE releases nothing and
 * starts nothing — releasing dependents is §7.4's decision and belongs to the loop that is
 * authorised to spend money. Aggregation only ever answers "does this parent's status still match
 * its children", and answering it must not become a way to start runs nobody approved.
 */

import { Prisma } from '@prisma/client';
import {
  AggregationTaskFact,
  AggregationTaskStatus,
  PlannedTaskAggregation,
} from './task-aggregation';
import { taskRetirement } from '../tasks/task-supersession';

/**
 * How many tasks one recomputation may pull in before it gives up.
 *
 * A bound rather than a belief about tree sizes. The closure below follows four relations, and
 * this exists so a write against a pathological shape degrades into "did nothing this time" —
 * which the next write recomputes from scratch — instead of into a request that reads a
 * six-figure task table. Real phase trees are two orders of magnitude under it.
 */
export const AGGREGATION_SCOPE_MAX_TASKS = 500;

export interface AggregationScope {
  /** Every task the plan needs, in no particular order. Empty when nothing was reachable. */
  facts: AggregationTaskFact[];
  /**
   * The closure hit the cap and is INCOMPLETE. A partial closure must not be planned over: a
   * parent whose children were cut off would be recomputed against a subset of them and reopened
   * — or completed — on evidence that is missing rows.
   */
  truncated: boolean;
}

type ScopeRow = {
  id: string;
  status: AggregationTaskStatus;
  parentTaskId: string | null;
  completionPolicy: AggregationTaskFact['completionPolicy'];
  completionCriterion: AggregationTaskFact['completionCriterion'];
  verifiesTaskId: string | null;
  verdict: AggregationTaskFact['verdict'];
  supersededByTaskId: string | null;
  terminalReason: string | null;
};

const SCOPE_SELECT = {
  id: true,
  status: true,
  parentTaskId: true,
  completionPolicy: true,
  completionCriterion: true,
  verifiesTaskId: true,
  verdict: true,
  // §13.6 SU6's two inputs. Read here rather than derived later so the closure and the plan judge
  // one row's retirement from one read.
  supersededByTaskId: true,
  terminalReason: true,
} satisfies Prisma.TaskSelect;

/**
 * Every task whose status the seeds could change, and every task needed to decide that.
 *
 * The closure follows four relations — parent, child, verifies, verified-by — because each of
 * them is an input to somebody's recomputation. Following only "up" would miss the sibling that
 * is still outstanding; following only "down" would miss the grandparent the plan settles in the
 * same pass; following neither verification direction would make VERIFICATION_PASSED read as
 * "zero checks, all of them passed".
 *
 * Ids are the internal UUIDs here, and stay that way through the plan: `planTaskAggregation`
 * compares them by identity and never parses them, so the spelling only has to be consistent.
 */
export async function collectAggregationScope(
  db: Prisma.TransactionClient,
  ownerId: string,
  seedTaskIds: readonly string[],
): Promise<AggregationScope> {
  const byId = new Map<string, ScopeRow>();
  let frontier = [...new Set(seedTaskIds)];

  while (frontier.length > 0) {
    // One query per level, asking for the frontier itself plus everything that points AT it.
    // The other direction — what the frontier points at — is read off the rows that come back.
    const rows: ScopeRow[] = await db.task.findMany({
      where: {
        ownerId,
        OR: [
          { id: { in: frontier } },
          { parentTaskId: { in: frontier } },
          { verifiesTaskId: { in: frontier } },
          // §13.6 SU9: whoever names one of these as its PREDECESSOR. Following supersession
          // backwards is what makes a change at the end of a chain wake the parent at the start of
          // it — the successor may sit under a different parent, and without this edge the row that
          // has to be recomputed is not in the closure at all.
          { supersededByTaskId: { in: frontier } },
        ],
      },
      select: SCOPE_SELECT,
    });
    const next = new Set<string>();
    for (const row of rows) {
      if (!byId.has(row.id)) {
        byId.set(row.id, row);
        if (byId.size > AGGREGATION_SCOPE_MAX_TASKS) return { facts: [], truncated: true };
      }
      // ...and forwards. `chainStaysUnder` walks to the END of a chain, so every hop of it has to
      // be loaded or the walk stops at an id the map does not hold and answers "cannot tell" —
      // which fails closed, correctly, but for the wrong reason: the row exists, it simply was not
      // fetched. Multi-hop chains, and chains that leave a parent and come back, need every link.
      for (const linked of [row.parentTaskId, row.verifiesTaskId, row.supersededByTaskId]) {
        if (linked && !byId.has(linked)) next.add(linked);
      }
    }
    frontier = [...next];
  }

  // The one place a ScopeRow becomes an AggregationTaskFact, so §13.6 SU6 is derived once from the
  // two columns rather than by each reader deciding what "retired" means.
  return {
    facts: [...byId.values()].map((row) => ({
      id: row.id,
      status: row.status,
      parentTaskId: row.parentTaskId,
      completionPolicy: row.completionPolicy,
      completionCriterion: row.completionCriterion,
      verifiesTaskId: row.verifiesTaskId,
      verdict: row.verdict,
      supersededByTaskId: row.supersededByTaskId,
      retirement: taskRetirement(row),
    })),
    truncated: false,
  };
}

/**
 * §13.1 AG5's compare-and-set, one statement per planned move.
 *
 * `status = from` is the whole of the concurrency control and zero rows is a normal outcome: the
 * parent already holds the recomputed value, or somebody moved it after this snapshot was read
 * and their fact is the newer one. `ownerId` is in the predicate as well as in the read, because
 * an id that arrived from anywhere but this closure must not be writable through here.
 *
 * Returns the ids that actually moved, which is what the caller notifies on — an aggregation that
 * changed nothing is not an event.
 */
export async function applyTaskAggregations(
  db: Prisma.TransactionClient,
  ownerId: string,
  aggregations: readonly PlannedTaskAggregation[],
  now: Date,
): Promise<string[]> {
  const moved: string[] = [];
  for (const aggregation of aggregations) {
    const rows = await db.$executeRaw(Prisma.sql`
      UPDATE "task"
         SET "status" = ${aggregation.to}::"task_status", "updated_at" = ${now}
       WHERE "id" = ${aggregation.taskId}::uuid
         AND "owner_id" = ${ownerId}::uuid
         AND "status" = ${aggregation.from}::"task_status"
         AND "status" IS DISTINCT FROM ${aggregation.to}::"task_status"
    `);
    if (rows > 0) moved.push(aggregation.taskId);
  }
  return moved;
}

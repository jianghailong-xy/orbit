/**
 * §13.3 DEP's database read: the three queries behind `verificationEpochGates`.
 *
 * Its own module so `TasksService` and `TaskListsService` ask ONE function rather than each writing
 * the sibling walk — the Ready tab has to offer exactly the runs the Run button accepts, which is
 * the promise `RUNNABLE_TASK_SQL` already makes about the clause next to this one.
 */

import { PrismaService } from '../prisma/prisma.service';
import { taskRetirement } from './task-supersession';
import {
  VerificationEpochEntry,
  VerificationRunFact,
  verificationEpochGates,
} from './verification-dependency';

/** Just the model accessors this read needs, so a transaction client is equally acceptable. */
type EpochPrismaClient = Pick<PrismaService, 'task' | 'session'>;

/**
 * §13.3 DEP for a set of candidate prerequisites: which of them have a PASS epoch, and what it says.
 *
 * A prerequisite has one when it IS a subject something checks, or when it is itself a check (whose
 * epoch is its subject's). Everything else — the ordinary case — is absent from the result and is
 * judged by its status alone.
 *
 * Three reads and one pure function, rather than a predicate written a second time in SQL: the
 * shape is `verificationEpochGates`, exactly as the Coordinator's pass computes it from its
 * snapshot, so the loop and the API cannot reach different conclusions about the same rows.
 * `verificationEpochOpenSql` is the third spelling and belongs to the sweeps, which have no rows
 * in hand to give a pure function; `verification-epoch.pg.spec` runs it against this one.
 *
 * The sibling walk is what makes it an epoch and not a verdict: every check of the same SUBJECT
 * is loaded, because a newer one closes what an older one opened.
 *
 * `ownerId` is required rather than inferred, and the owner clause is on the QUERY rather than on a
 * filter afterwards (unit L3, scope contract §3 SC6). Both halves matter: a caller that cannot
 * name the tenant it is asking about should not be able to ask, and a cross-tenant row that is read
 * and then dropped has still been read. The project half cannot be a query clause — it is a
 * self-join, "the check's project is the SUBJECT's project", which Prisma cannot express — so it is
 * applied to the rows below, before anything is derived from them. `verificationEpochOpenSql` says
 * the same thing in SQL; `verification-epoch.pg.spec` is what holds the two spellings together.
 */
export async function loadVerificationEpochGates(
prisma: EpochPrismaClient,
ownerId: string,
prerequisiteIds: string[],
): Promise<Map<string, VerificationEpochEntry>> {
  const unique = [...new Set(prerequisiteIds)];
  if (unique.length === 0) return new Map();
  // Both spellings of the edge in one read: a prerequisite that is a check resolves to what it
  // checks, and one that is a subject stands for itself — but only if something actually checks it.
  const anchors = await prisma.task.findMany({
    where: {
      id: { in: unique },
      ownerId,
      OR: [{ verifiesTaskId: { not: null } }, { verifiedBy: { some: {} } }],
    },
    select: { id: true, verifiesTaskId: true },
  });
  const subjectIds = [...new Set(anchors.map((a) => a.verifiesTaskId ?? a.id))];
  if (subjectIds.length === 0) return new Map();
  const loaded = await prisma.task.findMany({
    where: { ownerId, OR: [{ id: { in: subjectIds } }, { verifiesTaskId: { in: subjectIds } }] },
    select: {
      id: true, createdAt: true, status: true, verifiesTaskId: true, verdict: true,
      verdictRevision: true,
      projectId: true, supersededByTaskId: true, terminalReason: true,
    },
  });
  // §3 SC6, the project half. A check answers for its subject only if it counts towards the same
  // goal; one that does not is dropped here, before it can be the newest sibling of an epoch it
  // does not belong to. A subject that was never loaded — the same tenant test above already
  // removed it — takes its checks with it: fail closed, not "no subject, so no constraint".
  const subjectProject = new Map(
    loaded.filter((row) => subjectIds.includes(row.id)).map((row) => [row.id, row.projectId ?? null]),
  );
  const inSubjectScope = (row: { id: string; verifiesTaskId: string | null; projectId: string | null }) =>
    row.verifiesTaskId === null
      ? true
      : subjectProject.has(row.verifiesTaskId)
        && subjectProject.get(row.verifiesTaskId) === (row.projectId ?? null);
  const rows = loaded.filter(inSubjectScope);
  const checkIds = rows.filter((row) => row.verifiesTaskId != null).map((row) => row.id);
  const sessions = await prisma.session.findMany({
    where: { taskId: { in: checkIds } },
    select: {
      taskId: true, status: true, endReason: true,
      completedAt: true, archivedAt: true, deletedAt: true,
    },
  });
  const runs = new Map<string, VerificationRunFact[]>();
  for (const session of sessions) {
    if (!session.taskId) continue;
    const fact: VerificationRunFact = {
      runStatus: session.status,
      endReason: session.endReason,
      deletedAt: session.deletedAt,
      completionAt: session.completedAt ?? session.archivedAt,
    };
    const list = runs.get(session.taskId);
    if (list) list.push(fact);
    else runs.set(session.taskId, [fact]);
  }
  const epochRows = rows.map((row) => {
    return {
      id: row.id,
      createdAt: row.createdAt,
      status: row.status as unknown as string,
      verifiesTaskId: row.verifiesTaskId,
      verdict: row.verdict as unknown as string | null,
      verdictRevision: String(row.verdictRevision),
      retired: taskRetirement(row) != null,
    };
  });
  return verificationEpochGates(epochRows, runs);
}

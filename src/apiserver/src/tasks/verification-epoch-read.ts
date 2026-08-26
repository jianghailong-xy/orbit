/**
 * §13.3 DEP's database read: the four queries behind `verificationEpochGates`.
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
  verificationVerdictActionKeyOf,
} from './verification-dependency';
import { VERDICT_APPLY_EXHAUSTED } from '../projects/task-verification-verdict';

/** Just the model accessors this read needs, so a transaction client is equally acceptable. */
type EpochPrismaClient = Pick<PrismaService, 'task' | 'session' | 'projectAction'>
  & Partial<Pick<PrismaService, 'taskJudgmentRequest'>>;

/**
 * §13.3 DEP for a set of candidate prerequisites: which of them have a PASS epoch, and what it says.
 *
 * A prerequisite has one when it IS a subject something checks, or when it is itself a check (whose
 * epoch is its subject's). Everything else — the ordinary case — is absent from the result and is
 * judged by its status alone.
 *
 * Four reads and one pure function, rather than a predicate written a second time in SQL: the
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
  // Optional solely for unit/rolling compatibility with clients shaped before migration 0181.
  // A real PrismaService generated from this schema always has the accessor.
  const judgmentRequests = prisma.taskJudgmentRequest;
  // Both spellings of the edge in one read: a prerequisite that is a check resolves to what it
  // checks, and one that is a subject stands for itself — but only if something actually checks it.
  const [anchors, requestAnchors] = await Promise.all([
    prisma.task.findMany({
      where: {
        id: { in: unique },
        ownerId,
        OR: [{ verifiesTaskId: { not: null } }, { verifiedBy: { some: {} } }],
      },
      select: { id: true, verifiesTaskId: true },
    }),
    // The request commits before its deterministic verifier Task is filed. Read it as an anchor
    // during that post-commit window, otherwise a previously open PASS could briefly release a
    // dependent while the newer judgment question already exists.
    judgmentRequests?.findMany({
      where: {
        ownerId,
        kind: 'VERIFICATION',
        recipientType: 'VERIFIER_TASK',
        status: { in: ['OPEN', 'DECIDED'] },
        OR: [{ taskId: { in: unique } }, { recipientId: { in: unique } }],
      },
      select: { taskId: true },
    }) ?? Promise.resolve([]),
  ]);
  const subjectIds = [...new Set([
    ...anchors.map((a) => a.verifiesTaskId ?? a.id),
    ...requestAnchors.map((request) => request.taskId),
  ])];
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
  const [sessions, applied, judgments] = await Promise.all([
    prisma.session.findMany({
      where: { taskId: { in: checkIds } },
      select: {
        taskId: true, status: true, endReason: true,
        completedAt: true, archivedAt: true, deletedAt: true,
      },
    }),
    verdictActionKeys(prisma, rows),
    judgmentRequests?.findMany({
      where: {
        ownerId,
        taskId: { in: subjectIds },
        kind: 'VERIFICATION',
        recipientType: 'VERIFIER_TASK',
      },
      select: {
        id: true,
        taskId: true,
        recipientId: true,
        status: true,
        decision: true,
        createdAt: true,
      },
    }) ?? Promise.resolve([]),
  ]);
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
  const judgmentsByRecipient = new Map(judgments
    // N11's route pins all three identities to one fact. Fail closed on a malformed historical row
    // rather than letting a text recipient accidentally decorate another Task's epoch.
    .filter((request) => request.id === request.recipientId)
    .map((request) => [request.recipientId, request]));
  const epochRows = rows.map((row) => {
    const judgment = row.verifiesTaskId == null
      ? undefined
      : judgmentsByRecipient.get(row.id);
    const matchingJudgment = judgment?.taskId === row.verifiesTaskId ? judgment : undefined;
    return {
      id: row.id,
      createdAt: row.createdAt,
      status: row.status as unknown as string,
      verifiesTaskId: row.verifiesTaskId,
      verdict: row.verdict as unknown as string | null,
      verdictRevision: String(row.verdictRevision),
      // Outside a Project there is no ledger to have applied anything, and DEP4 reads that as
      // "not applicable" rather than as "not applied" — see `VerificationEpochCheckFact`.
      verdictApplied: row.projectId == null
        ? null
        : applied.applied.has(verificationVerdictActionKeyOf(
            row.projectId, row.id, String(row.verdictRevision),
          )),
      // `[K5]`: absent outside a Project for `verdictApplied`'s reason — there is no ledger to have
      // run out of attempts, so there is nothing to escalate.
      verdictApplyExhausted: row.projectId != null
        && applied.exhausted.has(verificationVerdictActionKeyOf(
          row.projectId, row.id, String(row.verdictRevision),
        )),
      judgmentStatus: matchingJudgment?.status ?? null,
      judgmentDecision: matchingJudgment?.decision ?? null,
      judgmentCreatedAt: matchingJudgment?.createdAt ?? null,
      retired: taskRetirement(row) != null,
    };
  });
  const loadedIds = new Set(rows.map((row) => row.id));
  // A just-committed OPEN request may not have its verifier Task yet. Represent that request as an
  // in-flight check so it closes an older PASS; a DECIDED request necessarily has a verifier Task
  // because the transition trigger requires its verdict, so only OPEN can normally reach here.
  for (const judgment of judgments) {
    if (loadedIds.has(judgment.id) || judgment.id !== judgment.recipientId
      || judgment.status === 'SUPERSEDED' || !subjectProject.has(judgment.taskId)) continue;
    epochRows.push({
      id: judgment.id,
      createdAt: judgment.createdAt,
      status: 'OPEN',
      verifiesTaskId: judgment.taskId,
      verdict: null,
      verdictRevision: '0',
      verdictApplied: null,
      verdictApplyExhausted: false,
      judgmentStatus: judgment.status,
      judgmentDecision: judgment.decision,
      judgmentCreatedAt: judgment.createdAt,
      retired: false,
    });
  }
  return verificationEpochGates(epochRows, runs);
}

/**
 * What the ledger says about these tasks' CURRENT verdict revisions: applied, or out of attempts.
 *
 * Asked by the action's own permanent key (§8.2) rather than by "some verdict action for this
 * task": a conclusion the check has since revised has its own key, and reading it as this one's
 * would let a superseded verdict release the work.
 */
async function verdictActionKeys(
prisma: EpochPrismaClient,
rows: ReadonlyArray<{ id: string; projectId: string | null; verdictRevision: bigint }>,
): Promise<{ applied: Set<string>; exhausted: Set<string> }> {
  const keys = rows
    .filter((row) => row.projectId != null)
    .map((row) => verificationVerdictActionKeyOf(
      row.projectId!, row.id, String(row.verdictRevision),
    ));
  const empty = { applied: new Set<string>(), exhausted: new Set<string>() };
  if (keys.length === 0) return empty;
  // One read for both facts, because they are the same row seen from two sides: APPLIED is DEP4's
  // satisfaction, and a spent retry budget is `[K5]`'s liveness. Two queries would let a row
  // change between them and make the two faces disagree about one action.
  const actions = await prisma.projectAction.findMany({
    where: { idempotencyKey: { in: keys }, type: 'APPLY_VERIFICATION_VERDICT' },
    select: { idempotencyKey: true, status: true, reasonCode: true },
  });
  const applied = new Set<string>();
  const exhausted = new Set<string>();
  for (const action of actions) {
    if (action.status === 'APPLIED') applied.add(action.idempotencyKey);
    // The BUCKET the pass that spent the last attempt stamped, not a count re-derived here. It is
    // on `reason_code` so that §11's condition detector — which sees a snapshot, and a snapshot
    // carries no `detail` — can read the same fact this does.
    else if (action.status === 'REFUSED' && action.reasonCode === VERDICT_APPLY_EXHAUSTED) {
      exhausted.add(action.idempotencyKey);
    }
  }
  return { applied, exhausted };
}

"use strict";
/**
 * §13.3 DEP's database read: the four queries behind `verificationEpochGates`.
 *
 * Its own module so `TasksService` and `TaskListsService` ask ONE function rather than each writing
 * the sibling walk — the Ready tab has to offer exactly the runs the Run button accepts, which is
 * the promise `RUNNABLE_TASK_SQL` already makes about the clause next to this one.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadVerificationEpochGates = loadVerificationEpochGates;
const task_supersession_1 = require("./task-supersession");
const verification_dependency_1 = require("./verification-dependency");
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
 */
async function loadVerificationEpochGates(prisma, prerequisiteIds) {
    const unique = [...new Set(prerequisiteIds)];
    if (unique.length === 0)
        return new Map();
    // Both spellings of the edge in one read: a prerequisite that is a check resolves to what it
    // checks, and one that is a subject stands for itself — but only if something actually checks it.
    const anchors = await prisma.task.findMany({
        where: {
            id: { in: unique },
            OR: [{ verifiesTaskId: { not: null } }, { verifiedBy: { some: {} } }],
        },
        select: { id: true, verifiesTaskId: true },
    });
    const subjectIds = [...new Set(anchors.map((a) => a.verifiesTaskId ?? a.id))];
    if (subjectIds.length === 0)
        return new Map();
    const rows = await prisma.task.findMany({
        where: { OR: [{ id: { in: subjectIds } }, { verifiesTaskId: { in: subjectIds } }] },
        select: {
            id: true, status: true, verifiesTaskId: true, verdict: true, verdictRevision: true,
            projectId: true, supersededByTaskId: true, terminalReason: true,
        },
    });
    const checkIds = rows.filter((row) => row.verifiesTaskId != null).map((row) => row.id);
    const [sessions, applied] = await Promise.all([
        prisma.session.findMany({
            where: { taskId: { in: checkIds } },
            select: {
                taskId: true, status: true, endReason: true,
                completedAt: true, archivedAt: true, deletedAt: true,
            },
        }),
        appliedVerdictKeys(prisma, rows),
    ]);
    const runs = new Map();
    for (const session of sessions) {
        if (!session.taskId)
            continue;
        const fact = {
            runStatus: session.status,
            endReason: session.endReason,
            deletedAt: session.deletedAt,
            completionAt: session.completedAt ?? session.archivedAt,
        };
        const list = runs.get(session.taskId);
        if (list)
            list.push(fact);
        else
            runs.set(session.taskId, [fact]);
    }
    return (0, verification_dependency_1.verificationEpochGates)(rows.map((row) => ({
        id: row.id,
        status: row.status,
        verifiesTaskId: row.verifiesTaskId,
        verdict: row.verdict,
        verdictRevision: String(row.verdictRevision),
        // Outside a Project there is no ledger to have applied anything, and DEP4 reads that as
        // "not applicable" rather than as "not applied" — see `VerificationEpochCheckFact`.
        verdictApplied: row.projectId == null
            ? null
            : applied.has((0, verification_dependency_1.verificationVerdictActionKeyOf)(row.projectId, row.id, String(row.verdictRevision))),
        retired: (0, task_supersession_1.taskRetirement)(row) != null,
    })), runs);
}
/**
 * Which of these tasks' CURRENT verdict revisions the ledger says are APPLIED (§13.3 DEP4).
 *
 * Asked by the action's own permanent key (§8.2) rather than by "some verdict action for this
 * task": a conclusion the check has since revised has its own key, and reading it as this one's
 * would let a superseded verdict release the work.
 */
async function appliedVerdictKeys(prisma, rows) {
    const keys = rows
        .filter((row) => row.projectId != null)
        .map((row) => (0, verification_dependency_1.verificationVerdictActionKeyOf)(row.projectId, row.id, String(row.verdictRevision)));
    if (keys.length === 0)
        return new Set();
    const applied = await prisma.projectAction.findMany({
        where: { idempotencyKey: { in: keys }, type: 'APPLY_VERIFICATION_VERDICT', status: 'APPLIED' },
        select: { idempotencyKey: true },
    });
    return new Set(applied.map((row) => row.idempotencyKey));
}
//# sourceMappingURL=verification-epoch-read.js.map
"use strict";
/**
 * What a verification verdict does (contract AC6 / §13.2).
 *
 * `task.verifiesTaskId` has always said "this task checks that one". v1 makes the conclusion carry
 * native consequences instead of asking a prompt to be conscientious about them: a FAIL puts the
 * subject back to OPEN, files a defect subtask under it, and stops the work that depends on it.
 *
 * One pure function over one snapshot, like §13.1's aggregation beside it — but unlike aggregation
 * these consequences are NOT a recomputation. Reverting a task, creating a subtask and raising a
 * condition are each writes that mean something different the second time, so they take a
 * permanent action key (§8.2) and this function's job is to say exactly which one:
 *
 *   pc:v1:<projectId>:verdict:<verifierTaskId>:<verdictRevision>
 *
 * The revision is the whole of V7 and the reason the key is not built from the verdict value. A
 * verdict has three states and a re-run can return to one it already held: `FAIL -> somebody fixes
 * it -> run the check again -> FAIL` would, keyed on the value, produce the SAME key as the first
 * FAIL, be skipped as already applied, and leave the subject sitting at DONE with no new defect
 * and nothing downstream stopped. Keyed on a revision that only advances when a conclusion is
 * actually reached, the same snapshot delivered twice collides (V2) and a genuinely new conclusion
 * does not (V4).
 *
 * The ids here are Base62 throughout, because a plan is audit material. The one place the internal
 * UUID appears is the action key, which is what the ledger's uniqueness is declared on; see
 * `verificationVerdictActionKey`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.verificationVerdictActionKey = verificationVerdictActionKey;
exports.verificationDefectIdempotencyKey = verificationDefectIdempotencyKey;
exports.planVerificationVerdicts = planVerificationVerdicts;
exports.verificationVerdictTurnFacts = verificationVerdictTurnFacts;
const task_supersession_1 = require("../tasks/task-supersession");
const verification_dependency_1 = require("../tasks/verification-dependency");
/**
 * The permanent identity of one conclusion's consequences (§7.3 / §8.2).
 *
 * Internal UUIDs, because this is the ledger's unique key and `ProjectReconcileService` requires
 * every key to be scoped by the Project's own UUID. It never reaches a client in that form: the
 * decision audit rewrites every UUID it finds in a string to Base62 on the way out.
 */
function verificationVerdictActionKey(projectId, verifierTaskId, verdictRevision) {
    // Delegated rather than spelled twice: §13.3 DEP4 reads this key back out of the ledger to ask
    // whether a conclusion has actually been applied, and it has to ask for the byte-identical
    // string this writer minted. One template, two callers.
    return (0, verification_dependency_1.verificationVerdictActionKeyOf)(projectId, verifierTaskId, verdictRevision);
}
/** The deterministic key that makes "one defect per conclusion" a database fact, not a habit. */
function verificationDefectIdempotencyKey(projectId, verifierTaskId, verdictRevision) {
    return `pc:v1:${projectId}:verdict-defect:${verifierTaskId}:${verdictRevision}`;
}
/**
 * Every verdict in `verifications` whose consequences are due, and why each of the rest is not.
 *
 * The skips are returned rather than filtered away because "this verdict did nothing" is the
 * answer somebody will need, and the alternative is reading it out of an absence.
 */
function planVerificationVerdicts(verifications, subjects) {
    const subjectById = new Map(subjects.map((subject) => [subject.id, subject]));
    const verdicts = [];
    const skipped = [];
    for (const fact of [...verifications].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        const skip = skipReason(fact, subjectById);
        if (skip) {
            skipped.push({ verifierTaskId: fact.id, reason: skip });
            continue;
        }
        const subject = subjectById.get(fact.verifiesTaskId);
        const verdict = fact.verdict;
        verdicts.push({
            verifierTaskId: fact.id,
            subjectTaskId: subject.id,
            verdict,
            verdictRevision: fact.verdictRevision,
            consequences: consequencesOf(verdict),
            evidence: {
                v: 1,
                verifierTaskId: fact.id,
                subjectTaskId: subject.id,
                verdict,
                verdictRevision: fact.verdictRevision,
                verifierStatus: fact.status,
                subjectStatus: subject.status,
                session: fact.session,
            },
        });
    }
    return { verdicts, skipped };
}
/**
 * `(verifierTaskId, verdictRevision, verdict)`, sorted — §7.2's `turnFacts` for the `VERDICT` row.
 *
 * The revision is in here on purpose (TF4): it is a lifecycle generation, not an observation
 * count, so the same world delivered N times digests identically while a genuinely new conclusion
 * on the same verifier does not. Without it a second failure of the same check looks byte-for-byte
 * like the first and the coordinator never gets woken for it.
 */
function verificationVerdictTurnFacts(plan) {
    return plan.verdicts
        .filter((planned) => planned.consequences.opensCoordinatorTurn)
        .map((planned) => [planned.verifierTaskId, planned.verdictRevision, planned.verdict])
        .sort((a, b) => (a[0] === b[0] ? Number(BigInt(a[1]) - BigInt(b[1])) : a[0] < b[0] ? -1 : 1));
}
function skipReason(fact, subjects) {
    if (!fact.verifiesTaskId)
        return 'NOT_A_VERIFICATION';
    if (!fact.verdict)
        return 'NO_VERDICT';
    // V1: the carrier is the verification task's own TERMINAL state plus a structured result. A
    // check that has concluded but not finished has not concluded.
    if (fact.status !== 'DONE')
        return 'NOT_CONCLUDED';
    if (fact.hasLiveSession)
        return 'RUN_IN_FLIGHT';
    // §13.6 SU6, both sides, before the subject is even looked up: neither a replaced check nor a
    // finding about replaced work may produce a consequence. Each has its own reason because they
    // send a reader to different places — "the re-run is over there" and "that work is being done
    // over there" are different sentences.
    if ((0, task_supersession_1.taskRetirement)({
        supersededByTaskId: fact.supersededByTaskId ?? null,
        terminalReason: fact.terminalReason ?? null,
    }) != null) {
        return 'VERIFIER_RETIRED';
    }
    // V6: the subject can be deleted while its check runs — fixtures take whole trees with them.
    // Planning nothing here is the quiet half; the action that races the delete records SUPERSEDED.
    const subject = subjects.get(fact.verifiesTaskId);
    if (!subject)
        return 'SUBJECT_MISSING';
    if ((0, task_supersession_1.taskRetirement)({
        supersededByTaskId: subject.supersededByTaskId ?? null,
        terminalReason: subject.terminalReason ?? null,
    }) != null) {
        return 'SUBJECT_RETIRED';
    }
    // A verdict written before migration 0124 has no revision, so it has no action identity. It is
    // not lost — the next conclusion on that verifier advances the counter and carries it.
    if (!(BigInt(fact.verdictRevision) > 0n))
        return 'UNREVISIONED_VERDICT';
    return null;
}
function consequencesOf(verdict) {
    if (verdict === 'PASS') {
        return {
            revertSubject: false,
            fileDefect: false,
            blockDownstream: false,
            raiseCondition: false,
            resolveConditions: true,
            opensCoordinatorTurn: false,
        };
    }
    const failed = verdict === 'FAIL';
    return {
        // INCONCLUSIVE deliberately reverts nothing and files nothing: "we could not tell" is not a
        // finding, and manufacturing a defect subtask out of it would put work in the tree that
        // nobody can close. It still leaves the condition, and it still wakes the coordinator.
        revertSubject: failed,
        fileDefect: failed,
        blockDownstream: failed,
        raiseCondition: true,
        resolveConditions: false,
        opensCoordinatorTurn: true,
    };
}
//# sourceMappingURL=task-verification-verdict.js.map
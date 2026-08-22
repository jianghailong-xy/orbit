"use strict";
/**
 * Task supersession (contract §13.6 SU1–SU5): everything about "this attempt was replaced by that
 * one" that is a pure function of stated facts.
 *
 * Kept out of the service for the reason `project-acceptance.ts` is: the rules here are read by the
 * service, by the runner API, by the CLI's own validation and by tests, and a rule that needs Nest
 * and Prisma standing up in order to be checked is a rule each caller reimplements.
 *
 * What the database enforces and this file does NOT duplicate: the acyclicity walk and the tenant
 * check, which are migration 0128's trigger. What this file exists for is the other half — turning
 * a refusal into a sentence the caller can act on, and deciding what a terminal reason means when
 * the successor it named has since been deleted.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TASK_SUPERSESSION_MAX_HOPS = exports.TASK_SUPERSEDABLE_STATUSES = exports.TASK_TERMINAL_REASONS = void 0;
exports.supersededByAbsentReason = supersededByAbsentReason;
exports.taskOutcome = taskOutcome;
exports.supersessionRefusal = supersessionRefusal;
exports.successorChain = successorChain;
exports.taskRetirement = taskRetirement;
exports.taskNotRetiredSql = taskNotRetiredSql;
exports.taskNotObsoleteSql = taskNotObsoleteSql;
exports.verificationFailureIsHistorySql = verificationFailureIsHistorySql;
exports.postgresSqlState = postgresSqlState;
exports.isLockNotAvailable = isLockNotAvailable;
exports.taskIsObsolete = taskIsObsolete;
exports.taskWorkRefusal = taskWorkRefusal;
exports.isTaskWorkRefusedByDatabase = isTaskWorkRefusedByDatabase;
exports.taskFenceConflictMessage = taskFenceConflictMessage;
/**
 * §13.6 SU1's closed set, the same two values migration 0128's CHECK freezes.
 *
 * Two, not four. `FAILED` and `CANCELLED` are already `TaskStatus`, and a column that restates its
 * neighbour is a column that can disagree with it. This one answers only the question the status
 * cannot: a CANCELLED task that was replaced and a CANCELLED task that was dropped are the same
 * status and opposite facts.
 */
exports.TASK_TERMINAL_REASONS = ['SUPERSEDED', 'ABANDONED'];
/** The statuses SU4 allows a successor to be named from. Linking writes nothing to `status`: the
 *  original outcome is the fact being preserved, not the one being tidied away. */
exports.TASK_SUPERSEDABLE_STATUSES = new Set(['CANCELLED', 'FAILED']);
/** How far a successor chain is followed before the reader gives up. The database refuses to build
 *  one longer than 256 hops, so a walk that reaches this has found data no writer here produced. */
exports.TASK_SUPERSESSION_MAX_HOPS = 256;
/**
 * Why there is no successor id, when the row nonetheless says it was superseded.
 *
 * `SUCCESSOR_DELETED` is a real state and not a bug: 0128's FK is ON DELETE SET NULL, so deleting
 * the successor takes the pointer and leaves the reason. Reporting that as "never superseded" would
 * be the one wrong answer — it is the difference between "nothing replaced this" and "something
 * did, and the record of what has been deleted".
 */
function supersededByAbsentReason(facts) {
    if (facts.supersededByTaskId != null)
        return null;
    return facts.terminalReason === 'SUPERSEDED' ? 'SUCCESSOR_DELETED' : 'NOT_SUPERSEDED';
}
function taskOutcome(facts) {
    if (facts.terminalReason === 'SUPERSEDED')
        return 'SUPERSEDED';
    if (facts.terminalReason === 'ABANDONED')
        return 'ABANDONED';
    switch (facts.status) {
        case 'OPEN':
        case 'IN_PROGRESS':
        case 'DONE':
        case 'FAILED':
        case 'CANCELLED':
            return facts.status;
        default:
            // An unrecognised status must read as itself, never as a healthy default.
            return facts.status;
    }
}
/**
 * SU2–SU4 as sentences. The database checks all of these again and would refuse anyway; this exists
 * so the caller is told which rule it broke instead of receiving a constraint name.
 *
 * Returns null when the link is allowed.
 */
function supersessionRefusal(input) {
    const { successor } = input;
    if (successor === null)
        return null;
    if (successor.id === input.taskId) {
        return 'A task cannot supersede itself';
    }
    if (!exports.TASK_SUPERSEDABLE_STATUSES.has(input.status)) {
        return (`Only a CANCELLED or FAILED task can name a successor — this one is ${input.status}. ` +
            'Supersession records that an attempt was replaced; it never rewrites how the attempt ended');
    }
    if (successor.ownerId !== input.ownerId) {
        return 'The successor task belongs to a different owner';
    }
    if ((successor.projectId ?? null) !== (input.projectId ?? null)) {
        return ('The successor must be in the same project as the task it replaces — work towards a ' +
            'different goal is not a later attempt at this one');
    }
    return null;
}
/**
 * Follow `supersededByTaskId` forward until it runs out: the attempt that is actually live.
 *
 * `edges` maps a task to its successor. The walk stops on a cycle rather than looping — 0128's
 * trigger makes one unwritable, and a reader that hangs on data it was told is impossible is worse
 * than one that reports what it found.
 */
function successorChain(from, edges) {
    const chain = [];
    const seen = new Set([from]);
    let cursor = edges.get(from) ?? null;
    while (cursor != null) {
        if (seen.has(cursor) || chain.length >= exports.TASK_SUPERSESSION_MAX_HOPS) {
            return { chain, truncated: true };
        }
        seen.add(cursor);
        chain.push(cursor);
        cursor = edges.get(cursor) ?? null;
    }
    return { chain, truncated: false };
}
function taskRetirement(facts) {
    // The pointer implies the reason (0128's `task_superseded_link_check`), so this arm is only ever
    // reached by a row written before that CHECK existed. Reading it as SUPERSEDED rather than
    // trusting the reason column alone is what makes the predicate safe on unmigrated data.
    if (facts.supersededByTaskId != null)
        return 'SUPERSEDED';
    if (facts.terminalReason === 'SUPERSEDED')
        return 'SUPERSEDED';
    if (facts.terminalReason === 'ABANDONED')
        return 'ABANDONED';
    return null;
}
/**
 * The same predicate in SQL, as a fragment every raw gate pastes rather than retypes.
 *
 * `t` is the task alias. Kept as a string constant and not a `Prisma.sql` so it can be spliced into
 * a template without becoming a parameter, and so a test can assert that each gate carries it
 * literally — the failure mode this closes is one query out of six spelling it differently.
 */
function taskNotRetiredSql(alias = 't') {
    return `(${alias}."terminal_reason" IS NULL AND ${alias}."superseded_by_task_id" IS NULL)`;
}
/**
 * `taskIsObsolete` in SQL: this task is not retired AND neither is the work it checks.
 *
 * The second half is a correlated subquery rather than a join so it can be pasted into a predicate
 * that already has its own FROM. `verifies_task_id IS NULL` — an ordinary task — reads as "nothing
 * to check", which is what `NOT EXISTS` gives for free.
 */
function taskNotObsoleteSql(alias = 't') {
    return `(${taskNotRetiredSql(alias)} AND NOT EXISTS (
    SELECT 1 FROM "task" obsolete_subject
     WHERE obsolete_subject."id" = ${alias}."verifies_task_id"
       AND NOT ${taskNotRetiredSql('obsolete_subject')}
  ))`;
}
/**
 * A verification failure that is HISTORY, in SQL — the second half of §13.6 SU6, and the one that
 * decides whether a project can ever be finished.
 *
 * `task_verification_failure` is resolved by exactly one thing: a later PASS on the same subject
 * (revoking the verdict deliberately does not resolve it, so deleting an inconvenient conclusion is
 * not a way to unblock work). That rule is right, and it has a terminal case it cannot answer:
 *
 *  - the VERIFIER was replaced — the check was re-run from scratch, and the re-run's own conclusion
 *    is the live one. Nothing will ever run the old verifier again, so no later PASS can come from
 *    it, and its FAIL sits unresolved forever;
 *  - the SUBJECT was replaced — the work the finding was about is not being done here anymore. The
 *    successor gets its own checks; the old subject will never be dispatched, so again no PASS can
 *    arrive.
 *
 * Either way the row stops being a request and becomes a record. §13.4's DONE gate counts
 * unresolved failures, and §7.4's third precondition defers every task downstream of one, so a row
 * left in that state is a project that cannot be accepted and tasks that cannot run, with no action
 * available to anybody that would change it. That is a wedge, not a safeguard — BL2's own
 * distinction — and it is exactly the shape this deployment's re-run history produces.
 *
 * `resolved_at` is deliberately NOT written when this becomes true: the row was never resolved, and
 * claiming it was would be a rewrite. It is read as history, by both readers, through this one
 * predicate — `verifier` and `subject` are the aliases of the two tasks the failure must be joined
 * to.
 */
function verificationFailureIsHistorySql(verifier = 'verifier', subject = 'subject') {
    return `(NOT ${taskNotRetiredSql(verifier)} OR NOT ${taskNotRetiredSql(subject)})`;
}
/**
 * The PostgreSQL SQLSTATE behind an error, wherever this stack happens to have put it.
 *
 * There are three shapes, and a predicate that knows fewer than all of them is a guard that works
 * in one place and silently does not in another:
 *
 *  - `pg` directly (every spec in this repo that opens its own connection): `error.code`;
 *  - Prisma before the driver adapter: `P2010` with the driver's code in `meta.code`;
 *  - **Prisma 7 with `@prisma/adapter-pg`** (what this deployment runs): `P2010` with the code at
 *    `meta.driverAdapterError.cause.originalCode`. `meta.code` is NOT set.
 *
 * The third one was missing until a real-PostgreSQL test caught it: `isLockNotAvailable` returned
 * false for every `FOR UPDATE NOWAIT` this process actually loses, so the typed refusal every
 * caller relies on was escaping as an unhandled `P2010`.
 */
function postgresSqlState(error) {
    if (typeof error !== 'object' || error === null)
        return null;
    const candidate = error;
    const adapter = candidate.meta?.driverAdapterError?.cause;
    for (const value of [adapter?.originalCode, adapter?.code, candidate.meta?.code, candidate.code]) {
        // `P2010` is Prisma's own wrapper code, never a SQLSTATE; skipping it keeps the fallback to
        // `error.code` honest for the bare-`pg` shape.
        if (typeof value === 'string' && value !== 'P2010')
            return value;
    }
    return null;
}
/** PostgreSQL's `lock_not_available` (55P03), as raised by a `FOR UPDATE NOWAIT` that lost. */
function isLockNotAvailable(error) {
    return postgresSqlState(error) === '55P03';
}
/**
 * §13.6 SU6, derived: a task the control loop must stop treating as outstanding.
 *
 * Two ways in, and the second is the one that kept being missed. A task is obsolete when it was
 * itself replaced or abandoned — or when it is a VERIFICATION whose subject was. The second is not
 * a weaker version of the first: the check itself is perfectly healthy, `OPEN`, un-retired, and
 * pointed at work that will never be dispatched again, so it can never run (§7.4's third
 * precondition needs its subject DONE) and never stop being outstanding. A world holding one sits
 * in `AWAITING_VERIFICATION` forever, waking every sixty seconds to decide nothing, with its parent
 * held open by a child nothing will move. That is §10.1 AC3's silent idling reached from a state
 * every individual rule calls healthy.
 *
 * One predicate, read by `runStateOf`, by §9.2's commit-point gate, by §13.1's aggregation and by
 * §7.8's pass, so those four cannot disagree about which tasks the project is still waiting on.
 * `subjectRetirement` is null for a task that verifies nothing — and for one whose subject this
 * snapshot cannot see, which reads as "not retired" for the same reason an unknown prerequisite
 * reads as outstanding: a projection may not infer a fact from a row it did not read.
 */
function taskIsObsolete(facts) {
    return facts.retirement != null || facts.subjectRetirement != null;
}
/**
 * §13.6 SU6 as one sentence for the public entry points: may this task's WORK be started?
 *
 * Every door that starts a run asks it — Run Now, the sweeps, a batch, a resume of a paused run,
 * arming an auto-retry — and each of them used to ask a slightly different version, or none. The
 * two that mattered were being missed in opposite directions: the derived half (this task CHECKS
 * work that was replaced, so it is obsolete even though it is healthy itself), and the fact that a
 * friendly pre-check has to name the same condition the database will refuse on. Without the first,
 * a caller got a raw `check_violation` 500 from 0130's guard; without the second, they got a
 * cheerful success and a session that could not exist.
 *
 * Returns the sentence, or null when the work may run. `retired`/`obsolete` are separate because
 * they send a reader to different places: one says "that attempt was replaced", the other says "the
 * thing you were going to check was".
 */
function taskWorkRefusal(facts, spell) {
    const own = taskRetirement(facts);
    if (own) {
        return `this task is recorded as ${own}` +
            (facts.supersededByTaskId
                ? ` — ${spell(facts.supersededByTaskId)} took over this work, so run that instead`
                : ' and nothing replaced it, so there is no run to repeat') +
            '. If this attempt really is being picked up again, clear the retirement first ' +
            '(supersededByTaskId: null with terminalReason: null); to read or salvage the old run, open ' +
            'a session against it directly rather than running the task';
    }
    const subject = taskRetirement({
        supersededByTaskId: facts.subjectSupersededByTaskId,
        terminalReason: facts.subjectTerminalReason,
    });
    if (subject) {
        return `this task checks work that is recorded as ${subject}` +
            (facts.subjectSupersededByTaskId
                ? ` — ${spell(facts.subjectSupersededByTaskId)} replaced it` : '') +
            ', so the check is obsolete: its subject will never be dispatched again and can never become ' +
            'DONE. Point a check at the attempt that took over instead';
    }
    return null;
}
/**
 * The database's own refusals for the same question, recognised so a race that slips past the
 * pre-check above still reaches the caller as a 409 rather than a 500.
 *
 * Matched on the message rather than the SQLSTATE because every guard in 0130 raises
 * `check_violation`, which is also what an ordinary CHECK raises — narrowing to the codes this
 * unit defines is what keeps an unrelated constraint failure from being relabelled as a
 * supersession conflict.
 */
function isTaskWorkRefusedByDatabase(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /TASK_SUPERSEDED|TASK_RETIRED_WHILE_RUNNING|TASK_VERIFICATION_SUBJECT_SUPERSEDED/
        .test(message);
}
/**
 * Every typed refusal this unit's database fences raise, turned into one question a service can
 * ask: is this error a "somebody else holds these rows right now" or "this work has been replaced"
 * condition the caller can act on?
 *
 * Centralised because the alternative is each call site matching its own subset, and the failure
 * mode of that is silent: a fence nobody translated surfaces as a raw Prisma error and reaches the
 * user as a 500 for a condition that has a name, a cause and a remedy. Every marker below is one
 * migration 0130 raises deliberately; anything else is left alone, so an unrelated constraint
 * failure is never relabelled as a supersession conflict.
 */
function taskFenceConflictMessage(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (/TASK_SUPERSEDED|TASK_VERIFICATION_SUBJECT_SUPERSEDED/.test(message)) {
        return "this task's work has been replaced — the attempt that took over holds it now, so no "
            + 'run of this one may be started. Open a session against it directly to read the old run';
    }
    if (/TASK_RETIRED_WHILE_RUNNING/.test(message)) {
        return 'this task still has a live run, so it cannot be recorded as replaced yet — wait for '
            + 'that run to reach a terminal status of its own';
    }
    if (/SESSION_PROJECT_BUSY|TASK_SUPERSESSION_PROJECT_BUSY/.test(message)) {
        return "this task's project is being reconciled right now — nothing was changed; retry";
    }
    if (/SESSION_TASK_BUSY|TASK_VERIFICATION_SUBJECT_BUSY/.test(message)) {
        return 'this task is being written right now — nothing was changed; retry';
    }
    // §13.1 AG6's write-time constraint, reached by any writer that did not ask first — an internal
    // creator, a binary that predates the service guard, a raw UPDATE, or a race between two writes
    // that were each legal alone. Prisma surfaces a CHECK violation as `P2010`/`23514` carrying the
    // constraint name, so the name is what is matched; without this the caller gets a 500 whose body
    // is a constraint identifier.
    if (/task_foreman_manual_policy/.test(message)) {
        return 'a coordinating (foreman) task is finished by its own run, so it cannot also be '
            + 'completed by aggregating subtasks — clear the foreman role, or leave completionPolicy '
            + 'as MANUAL';
    }
    // §13.1 AG6's lock-order refusals. Typed and retryable rather than a deadlock victim: every
    // acquisition in `task_aggregate_parent_shape_guard` is NOWAIT precisely so a caller is told to
    // retry instead of being killed at random by `40P01`.
    if (/TASK_AGGREGATE_PROJECT_BUSY/.test(message)) {
        return "this task's project is being reconciled right now — nothing was changed; retry";
    }
    if (/TASK_AGGREGATE_PARENT_BUSY/.test(message)) {
        return "this task's parent is being written right now — nothing was changed; retry";
    }
    if (/TASK_AGGREGATE_SCOPE_MOVED/.test(message)) {
        return 'a task involved in this write changed project while it was being prepared — nothing '
            + 'was changed; retry';
    }
    // §13.1 AG6's two database refusals. Translated here for the reason every other entry in this
    // function is: the guard is the last line, so the shape it catches is the one every service-side
    // pre-check MISSED — a genuinely concurrent write, or a binary that predates the gates. Left
    // untranslated it reaches the caller as a raw `check_violation`, which the API surfaces as a 500:
    // the run did not start AND the reason is unreadable, which is the worst of the two.
    if (/TASK_AGGREGATE_PARENT_ACTIVATION/.test(message)) {
        return 'this task is running work right now, so its completion cannot be handed to subtasks '
            + 'yet — let that run reach a terminal status of its own, or set the completion policy to '
            + 'MANUAL';
    }
    if (/TASK_AGGREGATE_PARENT/.test(message)) {
        return 'this task is completed by aggregating its subtasks, so it has no work of its own to '
            + 'run — run its subtasks, or set its completion policy to MANUAL';
    }
    if (/SESSION_TASK_MOVED/.test(message)) {
        return 'this task changed project while the request was being prepared — nothing was changed; '
            + 'retry';
    }
    // The acceptance-fact guard's refusals, from migration 0136 and from `task-lock-order.ts`. Same
    // clause as every entry above and for the same reason: each is a genuinely concurrent write the
    // service pre-checks cannot see, and each has a name, a cause and a remedy.
    //
    // They are translated here rather than retried, and that is `classifyTransactionError`'s own
    // decision: both are `lock_not_available` (`55P03`), which it deliberately excludes from the
    // transient set because a NOWAIT that declined to wait is a control-flow signal, not a fault.
    // Re-running the transaction would spend its attempts re-earning the same correct refusal.
    if (/TASK_FACT_PROJECT_BUSY/.test(message)) {
        return "this task's project is being written right now — nothing was changed; retry";
    }
    if (/TASK_FACT_SCOPE_MOVED/.test(message)) {
        return 'a task involved in this write changed project while it was being prepared — nothing '
            + 'was changed; retry';
    }
    return null;
}
//# sourceMappingURL=task-supersession.js.map
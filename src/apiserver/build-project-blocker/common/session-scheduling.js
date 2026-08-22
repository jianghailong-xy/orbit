"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SPAWN_TREE_OUTSTANDING = exports.SERVICE_TOKEN_CONCURRENCY = exports.SPAWN_TREE_RUNNER_RESERVE = exports.UNSETTLED_SESSION_STATUSES = exports.OPEN_SESSION_STATUSES = exports.ACTIVE_TURN_STATUSES = void 0;
exports.statusAfterTurnEnqueued = statusAfterTurnEnqueued;
exports.statusAfterTurnCompleted = statusAfterTurnCompleted;
exports.runnerOfflineIsFatal = runnerOfflineIsFatal;
const client_1 = require("@prisma/client");
/**
 * A runner slot represents active execution, not a resident (warm) runtime process.
 * Keep this separate from the broader "open/live session" sets used by streaming,
 * cancellation and resumability.
 */
exports.ACTIVE_TURN_STATUSES = [client_1.RunStatus.RUNNING];
/** Non-terminal sessions retained across runner restart (active ones plus cold/warm state). */
exports.OPEN_SESSION_STATUSES = [
    client_1.RunStatus.PENDING,
    client_1.RunStatus.RUNNING,
    client_1.RunStatus.AWAITING_INPUT,
    client_1.RunStatus.INTERRUPTED,
];
/**
 * A session that still owes an answer: queued for a turn, or running one. NOT the same as
 * "open" — an AWAITING_INPUT session has already produced its result and is merely parked in
 * case someone replies, and INTERRUPTED is a turn that was abandoned.
 *
 * This is the definition the rest of orchestration already used: session_create(wait) returns
 * the moment a child leaves PENDING/RUNNING ("result ready"), and the claim's supervisor
 * exemption asks the same question of a parent's children. Anything counting a tree's
 * unfinished work must use it too, or it contradicts what the caller was told.
 */
exports.UNSETTLED_SESSION_STATUSES = [client_1.RunStatus.PENDING, client_1.RunStatus.RUNNING];
/**
 * PENDING -> RUNNING must go through QueueService.trySessionClaim.
 *
 * Migration 0080 installs a BEFORE UPDATE trigger on `session` that silently drops that exact
 * transition for an OpenCode row unless the transaction set the `orbit.runner_supports_opencode`
 * GUC — which only the claim path does. A second writer would therefore no-op without raising.
 * Add new work-dispatch paths to the queue, not beside it.
 */
/**
 * Runner slots the spawn-tree cap always leaves for everyone else, so the tree's ceiling is
 * `max_concurrent - this`. Expressed against the runner's own capacity rather than as an
 * absolute count: the scarce resource is a slot on that machine, and a fixed number knows
 * nothing about how many there are — the same constant is meaningless on a 2-slot runner and
 * absurdly tight on a 64-slot one.
 *
 * The reserve is what a hard ceiling is actually for here. Ordinary fairness comes from claim
 * order (a tree already holding slots is picked last), which is work-conserving: one tree may
 * use the whole machine while nothing else wants it, and yields as soon as something does.
 * A ceiling cannot do that — it idles slots whether or not anyone is waiting — so its only job
 * is the guarantee ordering can't give on its own: a newcomer always gets a first slot without
 * waiting for a long turn to end.
 *
 * Fan-out is bounded by SPAWN_TREE_OUTSTANDING (admission) and MAX_SPAWN_DEPTH (recursion),
 * which is what lets this be generous.
 */
exports.SPAWN_TREE_RUNNER_RESERVE = 1;
/**
 * How many sessions one service-token credential may run at once. A headless bridge stuck in a
 * loop queues behind itself instead of flooding the machine. Unrelated to the spawn-tree cap
 * despite the shared history: there is no parent session and no tree here, only a credential,
 * so this stays a plain batch keyed on the token.
 */
exports.SERVICE_TOKEN_CONCURRENCY = 3;
/**
 * How many sessions of one spawn tree may still owe an answer at once. Admission control, a
 * different job from the concurrency cap above: that one decides how fast a tree drains, this
 * one decides whether more work may be created at all. Without it the backlog is unbounded and
 * invisible — session_create always succeeds and the work disappears into a queue nobody can
 * see the length of.
 *
 * Counted on UNSETTLED_SESSION_STATUSES, and that is the whole design. Count "open" sessions
 * instead and the cap is monotonic in practice: a child that finished its turn parks at
 * AWAITING_INPUT and stays there indefinitely, so the allowance never comes back and a
 * long-lived dispatcher wedges permanently once it has simply done enough work. That is the
 * exact trap that killed the old per-parent lifetime cap (de125146), wearing a different name —
 * and it is not theoretical: shipped that way, one tree reached 50 parked children with nothing
 * running and could no longer spawn at all.
 *
 * Counting only unsettled work keeps it self-releasing — every child eventually leaves
 * PENDING/RUNNING — while still bounding the thing the cap exists for, since an orchestrator
 * creating work faster than it settles accumulates exactly these statuses.
 */
exports.SPAWN_TREE_OUTSTANDING = 50;
/** Queueing work onto an idle interactive session requires a fresh runner slot. */
function statusAfterTurnEnqueued(status) {
    return status === client_1.RunStatus.AWAITING_INPUT || status === client_1.RunStatus.INTERRUPTED
        ? client_1.RunStatus.PENDING
        : status;
}
/** Keep an already-held slot only when another executable turn is already queued. */
function statusAfterTurnCompleted(hasPendingExecutableTurn) {
    return hasPendingExecutableTurn ? client_1.RunStatus.RUNNING : client_1.RunStatus.AWAITING_INPUT;
}
/** Losing a runner is fatal only while that runner is actively executing work. */
function runnerOfflineIsFatal(status) {
    return status === client_1.RunStatus.RUNNING;
}
//# sourceMappingURL=session-scheduling.js.map
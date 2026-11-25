import { RunStatus } from '@orbit/shared';

import type { TurnState } from '../sessions/session-turn-state';
import { HELD_SESSION_STATUSES } from './session-release';

/**
 * A runner slot represents active execution, not a resident (warm) runtime process: the turn state IN_FLIGHT
 * (sessions/session-turn-state.ts, common/session-working.ts `sessionHoldsSlot`), never `phase`. Keep this separate
 * from the broader "open/live session" sets used by streaming, cancellation and resumability.
 */

/** Non-terminal sessions retained across runner restart (active ones plus cold/warm state): the held ones. */
export const OPEN_SESSION_STATUSES: RunStatus[] = [...HELD_SESSION_STATUSES];

/**
 * A session that still owes an answer: queued for a turn, or running one. NOT the same as
 * "open" — an AWAITING_INPUT session has already produced its result and is merely parked in
 * case someone replies, and INTERRUPTED is a turn that was abandoned.
 *
 * This is the definition the rest of orchestration already used: the watch leaf
 * SESSION_TURN_SETTLED is a child leaving PENDING/RUNNING ("result ready"), and the claim's
 * supervisor exemption asks the same question of a parent's children. Anything counting a tree's
 * unfinished turns must use it too. `session_await` and `session_create(wait)` now wait by default
 * for SESSION_QUIESCENT (watches/watch-predicate.ts), which also waits out a child's own background
 * job, subagent and armed wake-ups; those hold no runner slot, so the spawn-tree allowance keeps
 * counting turns with this set.
 */
export const UNSETTLED_SESSION_STATUSES: RunStatus[] = [RunStatus.PENDING, RunStatus.RUNNING];

/**
 * PENDING -> RUNNING must go through QueueService.trySessionClaim.
 *
 * Migration 0080 installs a BEFORE UPDATE trigger on `session` that silently drops that exact
 * transition for an OpenCode row unless the transaction set the `orbit.runner_supports_opencode`
 * GUC, and migration 0367 does the same for an Antigravity row and
 * `orbit.runner_supports_antigravity` — GUCs only the claim path sets. Migrations 0377 and 0426 do
 * it for a DeepSeek Harness and a Cursor CLI session (`orbit.runner_supports_dsh`,
 * `orbit.runner_supports_cursor`), for its inbox lease too, and want the runner's persisted
 * heartbeat to declare the engine as well. A second writer would therefore no-op without raising.
 * Add new work-dispatch paths to the queue, not beside it.
 *
 * Migration 0414 adds the same barrier for every session with a recorded engine (Session.engine):
 * PENDING -> RUNNING, and taking its inbox lease (a new `inbox_lease_owner` or
 * `inbox_lease_generation`), need `orbit.claim_reads_session_engine` declared in the transaction —
 * a claim is skipped without it, a lease write is refused with an error. It is declared by
 * QueueService.trySessionClaim, by the runner lease routes (RunnerApiController takeover-leases and
 * activate-leases, beside assertDeclaredLeaseSupport) and by the inbox's account-pause fence
 * (RunnerApiController.dequeueTurn). A server terminal revive's v5 handoff marker is not a lease, and
 * clearing one never is. Any new writer of those transitions declares it too, or it fails on every
 * session there is.
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
export const SPAWN_TREE_RUNNER_RESERVE = 1;

/**
 * How many sessions one service-token credential may run at once. A headless bridge stuck in a
 * loop queues behind itself instead of flooding the machine. Unrelated to the spawn-tree cap
 * despite the shared history: there is no parent session and no tree here, only a credential,
 * so this stays a plain batch keyed on the token.
 */
export const SERVICE_TOKEN_CONCURRENCY = 3;

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
export const SPAWN_TREE_OUTSTANDING = 50;

/** A held session parked on a turn that was abandoned before it answered. */
export const ABANDONED_TURN_STATUS: RunStatus = RunStatus.INTERRUPTED;

/**
 * Queueing work onto an idle interactive session requires a fresh runner slot. Given the word the writer read and
 * returns the word it writes; the turn state written beside it is that word's (turnStateOfWord,
 * sessions/session-turn-state.ts), as that module's turnStateAfterTurnEnqueued gives it from a turn state.
 */
export function statusAfterTurnEnqueued(status: RunStatus | string): RunStatus {
  return status === RunStatus.AWAITING_INPUT || status === ABANDONED_TURN_STATUS
    ? RunStatus.PENDING
    : status as RunStatus;
}

/** Keep an already-held slot only when another executable turn is already queued. */
export function statusAfterTurnCompleted(hasPendingExecutableTurn: boolean): RunStatus {
  return hasPendingExecutableTurn ? RunStatus.RUNNING : RunStatus.AWAITING_INPUT;
}

/** Losing a runner is fatal only while that runner is actively executing work: a dispatched turn (IN_FLIGHT). */
export function runnerOfflineIsFatal(turnState: TurnState | null): boolean {
  return turnState === 'IN_FLIGHT';
}

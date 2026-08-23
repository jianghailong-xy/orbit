import { Prisma } from '@prisma/client';

/**
 * The claim lease — how a `PENDING -> RUNNING` handover stays reversible until the runner confirms
 * it.
 *
 * `QueueService.trySessionClaim` commits the transition in a short transaction and builds the
 * payload the runner receives outside it. The commit is the whole of the transition: the row is
 * RUNNING, it counts against `runner.max_concurrent`, and nothing records that the runner has not
 * been told. Between that commit and the response, the seed, the provider row, the model
 * compare-and-set, the credential and the response itself can each fail — and the reaper's liveness
 * branch cannot help, because it asks whether the RUNNER is gone and the runner is fine.
 *
 * So the claim writes a token, activation clears it, and a claim still carrying one may be put
 * back. Two callers do that, and they are the same statement with different reasons:
 *
 *  - the claim itself, when `buildSession` throws — synchronous, before the runner has been handed
 *    anything, and therefore safe for every runner regardless of what it can do;
 *  - the reaper, when the deadline passes — which only exists for a runner that said it activates.
 *
 * See `prisma/migrations/0157_session_claim_lease/migration.sql` for why the deadline is nullable
 * and what that NULL means.
 */

/**
 * How long a capable runner has to activate a claim before the watchdog takes it back.
 *
 * The interval it has to cover is claim response -> first `activate-leases`: the local supervisor
 * drain, the takeover, a `git worktree add` on whatever size of repository the workspace is, and
 * one engine reservation. None of those has an upper bound this process can see.
 *
 * The two errors are not symmetric, so this is not a midpoint. Expiring too LATE holds one slot
 * for longer in a failure that today holds it forever — bounded, and strictly better than the
 * behaviour being fixed. Expiring too EARLY requeues a session the runner is still setting up:
 * that runner goes on to activate and drive it (activation does not consult the claim), while the
 * queue is free to hand the same row out again. Two engines on one session is the one outcome
 * worth being slow to avoid, so this is set far above any plausible checkout rather than close to
 * the observed one. It is the same order as the reaper's own runtime-startup graces, which exist
 * for the same reason.
 *
 * A tighter bound would need activation to be able to REFUSE a claim that no longer stands, which
 * means the runner echoing the token back — a wire change, and a real one, since a session's later
 * turns activate without a claim at all.
 */
export const CLAIM_LEASE_MS = 15 * 60_000;

/**
 * The rollback switch. `ORBIT_CLAIM_LEASE=off` returns the claim path to what it was: no token, no
 * deadline, no compensation and no watchdog — the columns stay inert and an already-claimed session
 * behaves exactly as it did before migration 0157.
 *
 * Read per call rather than at module load so a drain can be verified against the same process that
 * will run with the flag flipped.
 */
export function claimLeaseEnabled(): boolean {
  return process.env.ORBIT_CLAIM_LEASE !== 'off';
}

/**
 * Put ONE unactivated claim back in the queue.
 *
 * Every predicate is load-bearing:
 *  - `claim_token` is the handover this caller is entitled to undo. An activation cleared it, and a
 *    later claim replaced it, so a compensation that arrives after either matches nothing. This is
 *    what keeps a delayed compensation from reviving a session that has since moved on — including
 *    one that entered a new inbox generation, since activating a generation is what clears it.
 *  - `status = 'RUNNING'` is the state being undone. A resume already took the row to PENDING and a
 *    finalize took it terminal; neither wants this write on top.
 *  - `cancel_requested_at IS NULL` is the fence the claim itself uses. A cancelled session must
 *    settle, not go back in a queue it would immediately be excluded from.
 *  - `expiredOnly` adds the deadline, and re-checks it against the database clock rather than the
 *    sweeping process's: the reaper decides WHICH rows to try from what it read, and this decides
 *    whether the write still applies.
 *
 * `started_at` is deliberately left alone. It records when this session first started, the claim
 * that set it was a real start, and the next claim COALESCEs onto it anyway.
 */
export function requeueUnactivatedClaim(
  sessionId: string,
  claimToken: string,
  expiredOnly: boolean,
): Prisma.Sql {
  return Prisma.sql`
    UPDATE "session" SET
      status = 'PENDING',
      "claim_token" = NULL,
      "claim_lease_expires_at" = NULL,
      "updated_at" = now()
    WHERE id = ${sessionId}::uuid
      AND "claim_token" = ${claimToken}::uuid
      AND status = 'RUNNING'
      AND "cancel_requested_at" IS NULL
      AND (
        ${!expiredOnly}
        OR ("claim_lease_expires_at" IS NOT NULL AND "claim_lease_expires_at" <= now())
      )
  `;
}

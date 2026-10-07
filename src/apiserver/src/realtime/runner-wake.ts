/**
 * The runner wake channel, and the one wake written from inside a transaction.
 *
 * A runner parks in `GET /runner/wake` and beats the moment the control plane asks it to, so work
 * the heartbeat carries — a sign-in to start, a Merge press, and now a queued landing — starts when
 * it is asked for rather than on the machine's next 30s tick. `RealtimeService.notifyRunnerWake`
 * emits that nudge, and its callers keep one rule by hand: call it AFTER the transaction that
 * queued the work commits, or the runner beats while the row is still invisible and waits out the
 * tick it was woken to skip.
 *
 * A queue that writes its own job row cannot make that call itself — it is a plain function over a
 * transaction with no service to reach through (projects/project-integration-job.ts) — so it uses
 * the one below, which says the same thing in the transaction that writes the row.
 */

import type { Prisma } from '@prisma/client';

/** The Postgres channel every replica LISTENs on for runner wakes (see RealtimeService.onNotify). */
export const RUNNER_WAKE_CHANNEL = 'orbit_runner_wake';

/** One runner-wake payload. `i` names the instance that already emitted it locally; a payload
 *  written from inside a transaction carries `c` instead, because nothing has emitted it locally
 *  yet and the emitting replica must take its own delivery. */
export type RunnerWakeMessage = { i?: string; r: string; c?: true };

/**
 * Wake the runner a transaction is queueing work for, from INSIDE that transaction.
 *
 * The same nudge as `RealtimeService.notifyRunnerWake` and the same channel, with one difference
 * that is the whole reason it exists: `pg_notify` is transactional, so Postgres delivers this at
 * COMMIT and only then. A wake emitted while the transaction is still open would reach the runner
 * before the row it is about is visible — the runner would beat, find nothing, and wait out its
 * tick anyway — and a transaction that rolls back (a `withTransactionRetry` attempt the server
 * discarded) wakes nobody at all. Delivery at commit is exactly the guarantee `notifyRunnerWake`'s
 * callers keep by hand, obtained here by construction.
 *
 * Hence `c` in the payload: onNotify skips its own instance's payloads on the grounds that they were
 * already emitted locally, which is true of `notifyRunnerWake` and false of this one.
 */
export async function notifyRunnerWakeOnCommit(
  tx: Prisma.TransactionClient,
  runnerId: string | null | undefined,
): Promise<void> {
  if (!runnerId) return;
  await tx.$executeRawUnsafe(
    'SELECT pg_notify($1, $2)',
    RUNNER_WAKE_CHANNEL,
    JSON.stringify({ r: runnerId, c: true } satisfies RunnerWakeMessage),
  );
}

import { randomUUID } from 'node:crypto';
import type { WikiOpOutcome } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * How a verification becomes a server job (contracts/wiki.contract.json `jobs.kindRuns.verify`, design §2.2
 * and §5.1): what the server records here is that an Automatic space has an op waiting for its verdict, and
 * the wiki-worker's `verify` job reads the ops and asks the System model.
 *
 * THE TRIGGER IS A FACT, NOT A CLOCK. An op that enters `verifying` is the whole reason a job exists, so the
 * submission that recorded it enqueues one: the session that proposed it is the one waiting for the verdict
 * (in the server path it does not run `orbit wiki verify` at all — contract `agentSurface.verify`), and the
 * job is made at {@link WIKI_VERIFY_PRIORITY} so it is taken before background maintenance. Nothing polls:
 * where the op came from is a session that is still waiting.
 *
 * ONE JOB PER WAITING SESSION, AND THE SECOND OP RIDES THE FIRST. A queued job has not read the list yet, so
 * it will verify every op of its session that waits when it runs — enqueueing another for the same session
 * and space while one is queued changes nothing, and this is why the check is a compare on this table rather
 * than on the ops: two submissions of one session, one job. An op that enters `verifying` while a job of its
 * session is already running is not this job's to verify — it read its page — so a new one is queued behind
 * it (the claim runs one job per space at a time), which is what makes the trickle of later proposals safe.
 */

/**
 * The priority a verify job is made with: above the background maintenance a job kind like `maintain` gets
 * (contract `jobs.priority`). A session is waiting for this verdict, and the space's ops are not live until
 * it arrives; the maintenance run's own pass over what ended sessions left waiting is the background one.
 */
export const WIKI_VERIFY_PRIORITY = 1;

/** Whether a submission left ops waiting for their verdict, which is a verify job's whole reason to exist. */
export function wikiVerifyJobNeeded(ops: readonly WikiOpOutcome[]): boolean {
  return ops.some((op) => op.status === 'pending' && op.waitsFor === 'verification');
}

/**
 * Queue the verification of one session's waiting ops in one space, unless the session already has a verify
 * job queued there (which will read the list when it runs, and so covers this too). The job's input names the
 * session whose ops it verifies: `recordVerifications` finds an op among its proposer's, so the job acts as
 * that session — an identity a row, not a session, has to be (the runner path's own rule, `verification.who`).
 */
export async function enqueueWikiVerifyJob(
  prisma: PrismaService,
  input: { ownerId: string; spaceId: string; sessionId: string; priority?: number },
): Promise<string | null> {
  await prisma.$executeRaw`
    INSERT INTO "wiki_job" ("id", "owner_id", "space_id", "kind", "input", "priority", "state")
    SELECT ${randomUUID()}::uuid, ${input.ownerId}::uuid, ${input.spaceId}::uuid, 'verify',
           ${JSON.stringify({ sessionId: input.sessionId })}::jsonb, ${input.priority ?? WIKI_VERIFY_PRIORITY}, 'queued'
    WHERE NOT EXISTS (
      SELECT 1 FROM "wiki_job" j
      WHERE j."space_id" = ${input.spaceId}::uuid
        AND j."kind" = 'verify'
        AND j."state" = 'queued'
        AND j."input" ->> 'sessionId' = ${input.sessionId}
    )`;
  // The job this session and space is owed, whether this call made it or found it: what a caller asking
  // for a verification is told it is waiting on (reviewModes.verification.routes.request).
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "wiki_job"
    WHERE "space_id" = ${input.spaceId}::uuid
      AND "kind" = 'verify'
      AND "state" = 'queued'
      AND "input" ->> 'sessionId' = ${input.sessionId}
    ORDER BY "created_at", "id"
    LIMIT 1`;
  return rows[0]?.id ?? null;
}

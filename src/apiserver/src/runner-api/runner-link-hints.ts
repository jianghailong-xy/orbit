import type { PrismaService } from '../prisma/prisma.service';

/**
 * What a heartbeat the link gateway forwarded is answered with beside today's HeartbeatResponse
 * (docs/runner-link-design.md §5.5, §5.7): everything a Hint frame would announce that holds now, whole, which the
 * gateway states in HeartbeatAck.hints (proto HintState) and takes out of the response the runner applies. A hint that
 * was lost costs the runner one heartbeat interval, no more, because this says the same thing again on every beat.
 *
 * Read only for a link call; an HTTPS heartbeat's response keeps the shape it always had.
 */
export interface RunnerLinkHints {
  /** Sessions of this runner with a message waiting in their inbox: what the inbox would hand out now. */
  inboxSessionIds: string[];
  /** Whether a session is queued for this runner to claim. */
  claim: boolean;
  /** This apiserver instance's count of each watched session's live streams (RunnerHints.watchersOf). */
  watchers?: { instance: string; sessions: Array<{ sessionId: string; watchers: number }> };
  /**
   * The release the runner is assigned, as GET /runner/release would answer it (runner-release-feed.ts), which the
   * gateway states in HeartbeatAck.release; absent when none can be stated now.
   */
  release?: { version: string; rollback: boolean };
}

/** At most this many sessions are named: a runner fetches what it is told of, and the next beat names the rest. */
const MAX_INBOX_SESSIONS = 1_000;

/**
 * The runner's waiting work, in one statement over the indexes the claim and the inbox read by (session by runner and
 * status, conversation_turn by session and status). Generous on purpose: a session it names that has nothing to hand
 * out costs the runner one call that answers nothing, while one it leaves out waits a heartbeat.
 *
 *   - inbox: an open session assigned to the runner with a turn PENDING, or IN_FLIGHT past its lease, which is what
 *     the inbox hands out (RunnerApiController.dequeueTurn decides which, and whether to this poller);
 *   - claim: a PENDING session assigned to the runner, which a claim may hand it (QueueService.trySessionClaim).
 */
export async function readRunnerLinkHints(
  prisma: Pick<PrismaService, '$queryRaw'>,
  runnerId: string,
): Promise<Pick<RunnerLinkHints, 'inboxSessionIds' | 'claim'>> {
  const rows = await prisma.$queryRaw<Array<{ inboxSessionIds: string[] | null; claim: boolean }>>`
    SELECT
      (
        SELECT array_agg(waiting.id)
        FROM (
          SELECT s.id::text AS id
          FROM "session" s
          WHERE s."assigned_runner_id" = ${runnerId}::uuid
            AND s.status IN ('RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
            AND EXISTS (
              SELECT 1 FROM "conversation_turn" t
              WHERE t."session_id" = s.id
                AND (t.status = 'PENDING' OR (t.status = 'IN_FLIGHT' AND t."lease_deadline_at" < now()))
            )
          LIMIT ${MAX_INBOX_SESSIONS}
        ) waiting
      ) AS "inboxSessionIds",
      EXISTS (
        SELECT 1 FROM "session" s WHERE s."assigned_runner_id" = ${runnerId}::uuid AND s.status = 'PENDING'
      ) AS "claim"
  `;
  return { inboxSessionIds: rows[0]?.inboxSessionIds ?? [], claim: rows[0]?.claim === true };
}

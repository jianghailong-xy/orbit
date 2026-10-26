import { Prisma } from '@prisma/client';
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
  /** Approvals of this runner's sessions that have a decision and whose reader is still waiting (proto ApprovalHint). */
  approvals: Array<{ sessionId: string; approvalId: string }>;
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
/** At most this many approvals, for the same reason. */
const MAX_DECIDED_APPROVALS = 1_000;

/**
 * The runner's waiting work, in one statement over the indexes the claim and the inbox read by (session by runner and
 * status, conversation_turn by session and status, approval by session and status). Generous on purpose: a session it
 * names that has nothing to hand out costs the runner one call that answers nothing, while one it leaves out waits a
 * heartbeat.
 *
 *   - inbox: an open session assigned to the runner with a turn PENDING, or IN_FLIGHT past its lease, which is what
 *     the inbox hands out (RunnerApiController.dequeueTurn decides which, and whether to this poller);
 *   - claim: a PENDING session assigned to the runner, which a claim may hand it (QueueService.trySessionClaim);
 *   - approvals: an approval of an open session assigned to the runner that a person allowed or denied, while its
 *     reader is still there to take the answer. That is the reader the card names, as SessionsService.stillBeingAsked
 *     reads it for a pending card (sessions/abandoned-approvals.ts): a card a runner-hosted job asked is read while
 *     the job is up (running_bg_shells); any other is read inside the call that asked, while the session generates,
 *     its turn has not been answered and its call has not returned. Only a session that can hold such a reader is
 *     read for them, so the beat of a runner with nothing generating reads no approval. A card that names neither a
 *     turn nor a call nor a job has no fact to end it by, so it is left out: its runner learns of the decision from
 *     the ApprovalHint and its own reads. A card the runner has already read stays named until its call returns or
 *     its job ends; a runner that is not waiting for it has nothing to ask.
 */
export async function readRunnerLinkHints(
  prisma: Pick<PrismaService, '$queryRaw'>,
  runnerId: string,
): Promise<Pick<RunnerLinkHints, 'inboxSessionIds' | 'claim' | 'approvals'>> {
  const rows = await prisma.$queryRaw<RunnerLinkHintColumns[]>`
    SELECT ${runnerLinkHintsSql(runnerId)}
  `;
  return runnerLinkHintsOf(rows[0]);
}

/** The three columns runnerLinkHintsSql selects, as Prisma reads them. */
export interface RunnerLinkHintColumns {
  inboxSessionIds: string[] | null;
  claim: boolean;
  approvals: Array<{ sessionId: string; approvalId: string }> | null;
}

/** What the three columns say, an absent row saying nothing waits. */
export function runnerLinkHintsOf(
  row: RunnerLinkHintColumns | undefined,
): Pick<RunnerLinkHints, 'inboxSessionIds' | 'claim' | 'approvals'> {
  return {
    inboxSessionIds: row?.inboxSessionIds ?? [],
    claim: row?.claim === true,
    approvals: row?.approvals ?? [],
  };
}

/**
 * The select list readRunnerLinkHints reads: three columns, "inboxSessionIds", "claim" and "approvals". A link
 * heartbeat answered from runner_presence reads them in its own statement (runner-api/link-heartbeat.ts), so the two
 * readings are one text.
 */
export function runnerLinkHintsSql(runnerId: string): Prisma.Sql {
  return Prisma.sql`
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
      ) AS "claim",
      (
        SELECT json_agg(json_build_object('sessionId', decided."sessionId", 'approvalId', decided."approvalId"))
        FROM (
          SELECT a."session_id"::text AS "sessionId", a.id::text AS "approvalId"
          FROM "session" s
          JOIN "approval" a ON a."session_id" = s.id AND a.status IN ('ALLOWED', 'DENIED')
          WHERE s."assigned_runner_id" = ${runnerId}::uuid
            AND s.status IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
            AND (
              s.status = 'RUNNING' OR (s.status = 'AWAITING_INPUT' AND s."engine_turn_active")
              OR cardinality(s."running_bg_shells") > 0
            )
            AND CASE
              WHEN a."background_job_id" IS NOT NULL THEN a."background_job_id" = ANY (s."running_bg_shells")
              ELSE (s.status = 'RUNNING' OR (s.status = 'AWAITING_INPUT' AND s."engine_turn_active"))
                AND (a."turn_id" IS NOT NULL OR a."tool_use_id" IS NOT NULL)
                AND (a."turn_id" IS NULL OR EXISTS (
                  SELECT 1 FROM "conversation_turn" t WHERE t.id = a."turn_id" AND t.status <> 'ANSWERED'
                ))
                AND (a."tool_use_id" IS NULL OR NOT EXISTS (
                  SELECT 1 FROM "tool_call" c
                  WHERE c."session_id" = a."session_id" AND c."tool_use_id" = a."tool_use_id" AND c."finished_at" IS NOT NULL
                ))
            END
          ORDER BY a.id
          LIMIT ${MAX_DECIDED_APPROVALS}
        ) decided
      ) AS "approvals"
  `;
}

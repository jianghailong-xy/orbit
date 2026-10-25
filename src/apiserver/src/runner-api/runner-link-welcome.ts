import { BadRequestException } from '@nestjs/common';
import { toUuid } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * Where a runner process's sessions stand as it connects to the runner link (docs/runner-link-design.md §5.3, §5.4,
 * §5.8): what the link gateway's Welcome tells the process in `sessions` (proto `SessionState`) and `release`
 * (proto `AssignedRelease`). The gateway asks POST /runner/link/welcome for the sessions its Hello names before it
 * writes Welcome (src/link-gateway/conn.go).
 */

/** What the gateway asks, for the sessions Hello names. */
export interface RunnerLinkWelcomeRequest {
  /**
   * The process the answer is for, read over HTTPS only. A link call is for the process its link token was minted
   * for, whatever the body says.
   */
  leaseOwner?: string;
  /** The sessions Hello.sessions names, UUID or public id. */
  sessionIds?: string[];
}

/** One session, as Welcome.sessions states it. */
export interface RunnerLinkSessionState {
  /** The session as the request named it. */
  sessionId: string;
  /**
   * The highest seq up to which every one of the session's events is stored, counting from 1, refused events
   * included: a tombstone holds each one's seq (link-events.ts). 0 when the session's first event is not stored, and
   * for a session that is not this runner's.
   */
  durableSeq: number;
  /**
   * Whether the process holds the session's lease: the session is this runner's, open, a conversation, and its inbox
   * leased to the process. The heartbeat's leaseLostSessionIds names exactly the supervised sessions this is false
   * for.
   */
  leaseHeld: boolean;
}

/** The route's answer. */
export interface RunnerLinkWelcomeAnswer {
  /** One for each session asked about, in the order asked. */
  sessions: RunnerLinkSessionState[];
  /** The release the runner is assigned (runner-release-feed.ts); absent when none can be stated now. */
  release?: { version: string; rollback: boolean };
}

/** As many sessions as a heartbeat may name (RunnerApiController.heartbeat). */
export const MAX_WELCOME_SESSIONS = 10_000;

/** The sessions a request names; 400 for a body that names none as a list of strings. */
export function welcomeSessionIds(body: unknown): string[] {
  const ids = (body as RunnerLinkWelcomeRequest | null)?.sessionIds ?? [];
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
    throw new BadRequestException({ code: 'RUNNER_LINK_WELCOME_INVALID', message: 'sessionIds must be a list of session ids.' });
  }
  if (ids.length > MAX_WELCOME_SESSIONS) {
    throw new BadRequestException({
      code: 'RUNNER_LINK_WELCOME_INVALID',
      message: `sessionIds names ${ids.length} sessions; at most ${MAX_WELCOME_SESSIONS} are answered at once.`,
    });
  }
  return ids;
}

/**
 * Each asked session's state, in one statement. Only the runner's own sessions are read: any other id, whoever's
 * session it names and whether or not it names one, is answered alike, with durableSeq 0 and leaseHeld false.
 *
 * durableSeq walks the session's events by (session_id, seq) from seq 1 and stops at the first seq missing: the
 * events up to there are stored one after another, and it is the number of them. A session with none missing is the
 * cheaper case for the stop and the dearer one for the walk, which then reads every one of its events. A noise ping is
 * stored as nothing (system-noise.ts), and over HTTPS so is every live event, though each took a seq: such a seq is a
 * missing one here, which makes durableSeq lower than everything stored and never higher.
 */
export async function readRunnerLinkSessionStates(
  prisma: Pick<PrismaService, '$queryRaw'>,
  runnerId: string,
  leaseOwner: string | null,
  sessionIds: string[],
): Promise<RunnerLinkSessionState[]> {
  const asked = sessionIds.map((sessionId) => ({ sessionId, uuid: uuidOf(sessionId) }));
  const uuids = [...new Set(asked.flatMap((s) => (s.uuid ? [s.uuid] : [])))];
  const rows = uuids.length === 0
    ? []
    : await prisma.$queryRaw<Array<{ id: string; durableSeq: number; leaseHeld: boolean | null }>>`
        SELECT s.id::text AS "id",
               COALESCE(
                 (SELECT stored.n - 1
                  FROM (
                    SELECT e."seq", row_number() OVER (ORDER BY e."seq") AS n
                    FROM "run_event" e
                    WHERE e."session_id" = s.id AND e."seq" > 0
                  ) stored
                  WHERE stored."seq" <> stored.n
                  ORDER BY stored."seq"
                  LIMIT 1),
                 (SELECT max(e."seq") FROM "run_event" e WHERE e."session_id" = s.id AND e."seq" > 0),
                 0
               )::int AS "durableSeq",
               (s.status IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
                 AND s."kind" = 'CONVERSATION'
                 AND s."inbox_lease_owner" = ${leaseOwner}::uuid) AS "leaseHeld"
        FROM "session" s
        WHERE s.id = ANY(${uuids}::uuid[]) AND s."assigned_runner_id" = ${runnerId}::uuid
      `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return asked.map(({ sessionId, uuid }) => {
    const row = uuid ? byId.get(uuid) : undefined;
    return { sessionId, durableSeq: row?.durableSeq ?? 0, leaseHeld: row?.leaseHeld === true };
  });
}

/** A session id's UUID, or null for a string that is not a session id in either spelling. */
function uuidOf(id: string): string | null {
  try {
    return toUuid(id);
  } catch {
    return null;
  }
}

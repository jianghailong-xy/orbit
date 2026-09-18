import { Prisma } from '@prisma/client';
import type { CoordinatorFuseUsage, CoordinatorWakeups } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import type { CoordinatorSpendAssessment } from './coordinator-convergence.service';

/**
 * The two things a project's coordinator card could never say (`docs/project-integration-line-
 * contract.md` §7.2 V7 / V9): whether the platform's last word actually reached the conversation,
 * and how much of today's own initiative it has left.
 *
 * WHY THESE TWO AND NOT A DASHBOARD. This project began from one measurement: 54 coordinator
 * conversations, 1374 turns, 7 of them delivered by the platform. A conversation that is idle
 * because nothing reached it looks exactly like one that is idle because there is nothing to do,
 * and the card that is supposed to answer "why has this project not moved" could distinguish
 * neither. One row says whether the last delivery landed; the other says whether the conversation
 * is allowed to act at all.
 *
 * Pure reads, both. Nothing here writes, locks or concludes anything a second reader would not
 * conclude from the same rows a moment later.
 */

/** What the newest platform delivery to one conversation looked like, before it is folded. */
interface CarriedRow {
  at: Date;
  returnedAt: Date | null;
  deliveredAt: Date | null;
}

/** A conversation nobody has ever sent anything to — and a project that has no coordinator at all,
 *  which is the same answer read one step earlier. */
const NOTHING_CARRIED: CoordinatorWakeups<Date> = { state: 'NONE', at: null };

/**
 * Whether the last thing the platform sent this conversation got there (§7.2 V7).
 *
 * Both carriers in one read, newest first, because they are the same fact to a reader: an exception
 * item handed over (`project_open_item_delivery`) and a wake delivered into the conversation
 * (`project_coordinator_wake`, status DELIVERED) are both "Orbit told it something". Which of the
 * two it was is not on the card — whether it arrived is.
 *
 * "Arrived" is `conversation_turn.delivered_at`, written when `dequeueTurn` hands the turn to an
 * engine, and never the row that queued it: a turn sitting behind a running one is QUEUED, which is
 * the honest state and the one X-D3 says is not a refusal. A delivery taken back at a drain point
 * (X-D5) reads RETURNED and is drawn in amber, because that one IS a delivery that did not happen.
 */
export async function readCoordinatorWakeups(
  db: PrismaService,
  sessionId: string | null,
): Promise<CoordinatorWakeups<Date>> {
  if (sessionId == null) return NOTHING_CARRIED;
  const [carried] = await db.$queryRaw<CarriedRow[]>(Prisma.sql`
    WITH carried AS (
      SELECT d."created_at" AS "at", d."returned_at" AS "returnedAt", d."client_turn_id" AS "clientTurnId"
        FROM "project_open_item_delivery" d
       WHERE d."session_id" = ${sessionId}::uuid
      UNION ALL
      SELECT w."updated_at" AS "at", NULL::timestamptz AS "returnedAt",
             w."delivery"->>'clientTurnId' AS "clientTurnId"
        FROM "project_coordinator_wake" w
       WHERE w."session_id" = ${sessionId}::uuid
         AND w."status" = 'DELIVERED' AND w."delivery" IS NOT NULL
    )
    SELECT c."at", c."returnedAt", t."delivered_at" AS "deliveredAt"
      FROM carried c
      LEFT JOIN "conversation_turn" t
             ON t."session_id" = ${sessionId}::uuid AND t."client_turn_id" = c."clientTurnId"
     ORDER BY c."at" DESC
     LIMIT 1
  `);
  if (!carried) return NOTHING_CARRIED;
  if (carried.returnedAt != null) return { state: 'RETURNED', at: carried.returnedAt };
  if (carried.deliveredAt != null) return { state: 'DELIVERED', at: carried.deliveredAt };
  return { state: 'QUEUED', at: carried.at };
}

/**
 * Today's self-started turns against today's limit, and whether the fuse is open (§7.2 V9).
 *
 * The one dimension of three, because it is the one that pauses projects in this deployment and the
 * one a reader can act on: the other two are backstops. `paused` is the assessment's own verdict
 * rather than a second derivation from the numbers beside it, so the card and the pause card cannot
 * disagree about whether the coordinator is stopped.
 */
export function coordinatorFuseUsage(
  spend: CoordinatorSpendAssessment,
  episodeId: string | null,
): CoordinatorFuseUsage {
  return {
    selfStartedToday: spend.spend.selfStartedTurns,
    limit: spend.limits.maxSelfStartedTurnsPerDay,
    // An episode that is OPEN is the fact; the reading is only how it got there, and a reading taken
    // after the owner resumed would otherwise re-pause the card they just cleared.
    paused: episodeId != null,
    episodeId,
  };
}

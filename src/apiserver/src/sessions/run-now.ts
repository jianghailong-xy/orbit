import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { sessionTurnStateSql } from './session-turn-state';
import { queuedGateLateral, runNowGateRefusal, runNowOf, type QueuedGateRow } from './queued-gate';

/**
 * Run now (docs/mocks/queued-run-now/01-run-now.png, every recommendation adopted): a person starts one queued message
 * held by a full runner, run or batch straight away, over the limit.
 *
 * The pass is `session.over_capacity_turn_id`, naming the session's oldest queued message (decision B: this one turn).
 * The claim (QueueService.trySessionClaim) takes a session holding one past all three slot gates while the runner's
 * turns plus the slots its background jobs hold stay under max_concurrent + burst_concurrent (C, D), and only for a
 * runner that declares OVER_CAPACITY_V1. It lifts nothing else: an offline or updating runner, a disk below its floor,
 * a clone not ready or a merge in flight on the checkout are refused here with the sentence that says so (D). The
 * overflow turn counts as active like any other, so a message already waiting still starts only below the limit (F).
 * When the turn ends the slot is returned (RunnerApiController.turnComplete): the session's next message queues.
 *
 * People only (E): the door refuses a personal access token (@PatForbidden('OWNER_INTERACTIVE')), a terminal
 * (TERMINAL_REFUSED_ROUTES) and a request carrying an acting session, and no MCP tool or CLI flag reaches it.
 */
export const RUN_NOW_REFUSED = 'RUN_NOW_REFUSED';
export const RUN_NOW_OWNER_CHANNEL_ONLY = 'RUN_NOW_OWNER_CHANNEL_ONLY';

export interface RunNowResult {
  ok: true;
  /** The queued message the pass covers. */
  turnId: string;
  /** True when this session already held a pass for it: a second press changes nothing. */
  alreadyPassed: boolean;
  /** The runner the claim is woken on. */
  runnerId: string;
}

/** A request carrying an acting session is refused before anything is read (decision E). */
export function refuseRunNowForSession(actingSessionId: string | null): void {
  if (actingSessionId !== null) {
    throw new ForbiddenException({
      code: RUN_NOW_OWNER_CHANNEL_ONLY,
      message: 'Run now is pressed by a person in the app; a request on a session\'s behalf cannot start a message over the limit.',
    });
  }
}

/**
 * The pass for session `sessionId` of `ownerId`, or the refusal that says why not, in the caller's transaction, which
 * holds the session row. `seed` lays the session's opening turn down when the claim has not yet (a session that has
 * never run is seeded at its claim, so its first message has no turn row until then); it runs only once every check
 * passed. Wakes nothing: the caller does, after the commit.
 */
export async function grantRunNow(
  prisma: PrismaClient | Prisma.TransactionClient,
  ownerId: string,
  sessionId: string,
  seed: () => Promise<void>,
): Promise<RunNowResult> {
  const [row] = await prisma.$queryRaw<Array<QueuedGateRow & {
    turnState: string | null;
    runnerId: string | null;
    runnerLabel: string | null;
    passTurnId: string | null;
  }>>(Prisma.sql`
    SELECT ${sessionTurnStateSql('s')} AS "turnState", s.assigned_runner_id AS "runnerId",
           COALESCE(NULLIF(btrim(r.display_name), ''), r.name) AS "runnerLabel",
           s.over_capacity_turn_id AS "passTurnId",
           q.reason, q."runnerActive", q."runnerHeld", q."runnerLimit", q."runnerBurst", q."runnerOverflow", q."passPending"
      FROM session s
      LEFT JOIN runner r ON r.id = s.assigned_runner_id
      LEFT JOIN LATERAL (${queuedGateLateral()}) q ON true
     WHERE s.id = ${sessionId}::uuid AND s.owner_id = ${ownerId}::uuid AND s.deleted_at IS NULL AND s.kind = 'CONVERSATION'
  `);
  if (!row) throw new NotFoundException('session not found');
  if (row.turnState !== 'QUEUED') throw refused('This message is not waiting for a free slot.', row.reason);
  // A second press, or one from another device, while the pass still waits: the same answer, nothing written.
  if (row.passPending && row.passTurnId && row.runnerId) {
    return { ok: true, turnId: row.passTurnId, alreadyPassed: true, runnerId: row.runnerId };
  }
  const gateRefusal = runNowGateRefusal(row.reason ?? null, row.runnerLabel);
  if (gateRefusal) throw refused(gateRefusal, row.reason);
  const runNow = runNowOf(row, row.runnerLabel);
  if (!runNow?.available) throw refused(runNow?.refusal ?? 'This message is not waiting for a free slot.', row.reason);
  await seed();
  // The oldest queued message is the one the next claim delivers first, and so the one turn the pass covers. Written
  // only while the session is still queued: a claim that took it meanwhile already started it.
  const [granted] = await prisma.$queryRaw<Array<{ turnId: string }>>(Prisma.sql`
    UPDATE session s SET over_capacity_turn_id = t.id, updated_at = now()
      FROM (
        SELECT ct.id FROM conversation_turn ct
         WHERE ct.session_id = ${sessionId}::uuid AND ct.status = 'PENDING' AND ct.kind IN ('message', 'shell')
         ORDER BY ct.seq ASC
         LIMIT 1
      ) t
     WHERE s.id = ${sessionId}::uuid AND ${sessionTurnStateSql('s')} = 'QUEUED' AND s.cancel_requested_at IS NULL
    RETURNING t.id AS "turnId"
  `);
  if (!granted) throw refused('This message is not waiting for a free slot.', row.reason);
  return { ok: true, turnId: granted.turnId, alreadyPassed: false, runnerId: row.runnerId! };
}

function refused(message: string, reason: string | null | undefined): ConflictException {
  return new ConflictException({ code: RUN_NOW_REFUSED, queuedReason: reason ?? null, message });
}

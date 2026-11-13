import { Prisma } from '@prisma/client';
import type { RunnerDrainWaiting } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * What of a runner's owner waits on the runner's drain for a self-update (docs/runner-update-drain-design.md
 * §3.4, D3): the web's update indicator and the native attention item say it. Nothing is pushed for it: the owner
 * found a push per drain too loud (docs/mocks/runner-update-indicator).
 *
 * Counted while the runner's heartbeat says draining:
 *   - a session: one PENDING on the runner that never ran a turn;
 *   - a message: a message turn still PENDING on one of its sessions — queued behind a running turn, a follow-up the
 *     runner holds for the update (holdFollowUpForUpdate) or one a drain-scoped claim took (both leave the turn
 *     undelivered: the runner's waitActive holds the inbox), or the message of a session waiting PENDING; and a
 *     session PENDING after earlier turns whose message is no such turn.
 */
function waitingSql(runnerId: Prisma.Sql, ownerId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*) FILTER (WHERE s.status = 'PENDING' AND s.num_turns = 0)::int AS sessions,
           (COALESCE(sum(m.turns) FILTER (WHERE NOT (s.status = 'PENDING' AND s.num_turns = 0)), 0)
            + count(*) FILTER (WHERE s.status = 'PENDING' AND s.num_turns > 0 AND m.turns = 0))::int AS messages
      FROM "session" s
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS turns FROM "conversation_turn" t
         WHERE t.session_id = s.id AND t.status = 'PENDING' AND t.kind = 'message'
      ) m
     WHERE s.assigned_runner_id = ${runnerId}
       AND s.owner_id = ${ownerId}
       AND s.status IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
       AND s.cancel_requested_at IS NULL
       AND s.deleted_at IS NULL`;
}

/** Each draining runner's waiting work of `ownerId`, by runner id; runners with nothing waiting are left out. */
export async function drainWaitingOf(
  prisma: PrismaService,
  ownerId: string,
  runners: Array<{ id: string; heartbeatDraining: boolean | null }>,
): Promise<Map<string, RunnerDrainWaiting>> {
  const draining = runners.filter((r) => r.heartbeatDraining === true).map((r) => r.id);
  const waiting = new Map<string, RunnerDrainWaiting>();
  if (draining.length === 0) return waiting;
  const rows = await prisma.$queryRaw<Array<{ runnerId: string; sessions: number; messages: number }>>(Prisma.sql`
    SELECT r.id AS "runnerId", w.sessions, w.messages
      FROM unnest(${draining}::uuid[]) AS r(id)
      CROSS JOIN LATERAL (${waitingSql(Prisma.sql`r.id`, Prisma.sql`${ownerId}::uuid`)}) w
     WHERE w.sessions + w.messages > 0`);
  for (const row of rows) waiting.set(row.runnerId, { sessions: row.sessions, messages: row.messages });
  return waiting;
}

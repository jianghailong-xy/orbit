import { Prisma } from '@prisma/client';
import type { RunnerDrainWaiting } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { sanitizeRunnerSelfUpdate } from './runner-self-update';

/**
 * What of a runner's owner waits on the runner's drain for a self-update (docs/runner-update-drain-design.md
 * §3.4, D3): the web's workspace banner, the native attention item and the drain's one push say it.
 *
 * Waiting is PENDING on the runner while its heartbeat says draining — exactly the rows the session list explains
 * with queuedReason 'runner_updating'. A session that never ran a turn is a waiting session; one that had is waiting
 * with a message sent to it (the queued message of board 2 ⑤).
 */
function waitingSql(runnerId: Prisma.Sql, ownerId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*) FILTER (WHERE s.num_turns = 0)::int AS sessions,
           count(*) FILTER (WHERE s.num_turns > 0)::int AS messages
      FROM "session" s
     WHERE s.assigned_runner_id = ${runnerId}
       AND s.owner_id = ${ownerId}
       AND s.status = 'PENDING'
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

/** The facts the push says, from the beat that claimed it. */
export interface DrainWaitingPush {
  runnerId: string;
  ownerId: string;
  machine: string;
  targetVersion: string | null;
  turns: number;
  waiting: RunnerDrainWaiting;
}

/**
 * Claim this drain's one push: set `drain_waiting_pushed_at` while the runner drains, none was sent this drain, and
 * something of its owner's waits on it. One conditional UPDATE, so of two beats racing only one matches and pushes.
 * Null when there is nothing to push. A beat that is not draining clears the column (the heartbeat's runner write),
 * which is what makes it once per drain.
 */
export async function claimDrainWaitingPush(prisma: PrismaService, runnerId: string): Promise<DrainWaitingPush | null> {
  const rows = await prisma.$queryRaw<Array<{
    ownerId: string; name: string; displayName: string | null; selfUpdate: unknown; activeTurns: number;
    sessions: number; messages: number;
  }>>(Prisma.sql`
    UPDATE "runner" r SET "drain_waiting_pushed_at" = now()
      FROM (${waitingSql(Prisma.sql`${runnerId}::uuid`, Prisma.sql`(SELECT owner_id FROM "runner" WHERE id = ${runnerId}::uuid)`)}) w
     WHERE r.id = ${runnerId}::uuid
       AND r."heartbeat_draining" IS TRUE
       AND r."drain_waiting_pushed_at" IS NULL
       AND w.sessions + w.messages > 0
    RETURNING r.owner_id AS "ownerId", r.name, r.display_name AS "displayName", r.self_update AS "selfUpdate",
              (SELECT count(*)::int FROM "session" busy
                WHERE busy.assigned_runner_id = r.id AND busy.status = 'RUNNING' AND busy.deleted_at IS NULL) AS "activeTurns",
              w.sessions, w.messages`);
  const row = rows[0];
  if (!row) return null;
  const report = sanitizeRunnerSelfUpdate(row.selfUpdate);
  return {
    runnerId,
    ownerId: row.ownerId,
    machine: row.displayName || row.name,
    targetVersion: report?.targetVersion ?? null,
    // The runner's own count covers every turn in flight; the rows are the nearest guess from one that sends none.
    turns: report?.turnsInFlight ?? row.activeTurns,
    waiting: { sessions: row.sessions, messages: row.messages },
  };
}

function counted(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/** `1 session and 1 message`, `2 sessions`, `1 message`. */
export function drainWaitingWords(waiting: RunnerDrainWaiting): string {
  const parts: string[] = [];
  if (waiting.sessions > 0) parts.push(counted(waiting.sessions, 'session', 'sessions'));
  if (waiting.messages > 0) parts.push(counted(waiting.messages, 'message', 'messages'));
  return parts.join(' and ');
}

/**
 * The banner's sentence, which the push says too (board 3 ⑥): `studio-mac is updating to 0.1.254 — 1 session and
 * 1 message are waiting for 2 turns to finish.` The web's runnerDrainBanner.ts says the same words.
 */
export function drainWaitingSentence(push: Pick<DrainWaitingPush, 'machine' | 'targetVersion' | 'turns' | 'waiting'>): string {
  const updating = push.targetVersion ? `${push.machine} is updating to ${push.targetVersion}` : `${push.machine} is updating`;
  const total = push.waiting.sessions + push.waiting.messages;
  const verb = total === 1 ? 'is' : 'are';
  const until = push.turns > 0
    ? `waiting for ${counted(push.turns, 'turn', 'turns')} to finish`
    : 'waiting for it to restart';
  return `${updating} — ${drainWaitingWords(push.waiting)} ${verb} ${until}.`;
}

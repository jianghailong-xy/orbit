import { heldFilter } from '../common/session-release';
import { turnStateFilter } from '../sessions/session-turn-state';
import type { PrismaService } from '../prisma/prisma.service';
import { runnerIsOnline, type RunnerBeats } from './runner-presence';

/**
 * The sessions a runner's background jobs hold slots for (RunnerHeartbeatRequest.backgroundJobSessionIds,
 * runner_presence.background_job_session_ids, migration 0780).
 *
 * A runner counts a session against its maxConcurrent while it holds a turn permit OR while runner-hosted background
 * jobs of its own still run (src/runner-go/session_pool.go admissionOccupancy). The second kind runs no turn, so a count
 * of turns alone reads a full machine as having room. Each beat names those sessions, and the beat's own write keeps
 * them on the presence row, replaced every time: the link beat statement (runner-api/link-heartbeat.ts readLinkBeat) or,
 * over HTTPS and for a managed runner, recordRunnerBeat. Only the ids of sessions assigned to the beating runner are
 * kept (in the link beat statement, and ownBackgroundJobSessionIds), so a beat cannot write another runner's session,
 * let alone another account's, into its row.
 */

/** At most this many ids are kept from one beat: far above any runner's maxConcurrent. */
export const BACKGROUND_JOB_SESSIONS_MAX = 512;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ids as they may be stored: UUIDs only, in lower case, each once, sorted. Empty for a beat that names none. */
export function sanitizeBackgroundJobSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const id of value) {
    if (typeof id === 'string' && UUID_RE.test(id)) ids.add(id.toLowerCase());
    if (ids.size >= BACKGROUND_JOB_SESSIONS_MAX) break;
  }
  return [...ids].sort();
}

/** Of the ids a beat over HTTPS (or a managed runner's) names, those of sessions assigned to that runner, sorted. */
export async function ownBackgroundJobSessionIds(
  prisma: Pick<PrismaService, 'session'>,
  runnerId: string,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.session.findMany({
    where: { id: { in: [...ids] }, assignedRunnerId: runnerId },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((r) => r.id);
}

/** A runner as runningSessionCounts reads it: its liveness, and the presence row's holders. */
export interface RunnerWithHolders {
  id: string;
  status: string;
  presence?: (NonNullable<RunnerBeats['presence']> & { backgroundJobSessionIds?: string[] | null }) | null;
}

/**
 * How many sessions each runner is running, as its "N of M running" shows it: the distinct sessions that are either
 * assigned to it in a turn (the turn state IN_FLIGHT, the slot fact), or named by its last beat as held by a background job and still open
 * and assigned to it. A session both ways counts once. Only a runner online by its presence row's own beat has its
 * holders counted: a stale report, or none (an older runner, a row a crash emptied), counts turns alone, as before.
 */
export async function runningSessionCounts(
  prisma: Pick<PrismaService, 'session'>,
  runners: readonly RunnerWithHolders[],
  now: number,
): Promise<Map<string, number>> {
  if (runners.length === 0) return new Map();
  const held = runners.flatMap((runner) => {
    const ids = runner.presence?.backgroundJobSessionIds ?? [];
    const fresh = runnerIsOnline({ status: runner.status, presence: runner.presence }, now);
    return fresh && ids.length > 0 ? [{ assignedRunnerId: runner.id, id: { in: ids } }] : [];
  });
  const counts = await prisma.session.groupBy({
    by: ['assignedRunnerId'],
    where: {
      assignedRunnerId: { in: runners.map((r) => r.id) },
      OR: [
        turnStateFilter(['IN_FLIGHT']),
        ...(held.length > 0 ? [{ ...heldFilter(), OR: held }] : []),
      ],
    },
    _count: { _all: true },
  });
  return new Map(counts.map((c) => [c.assignedRunnerId as string, c._count._all]));
}

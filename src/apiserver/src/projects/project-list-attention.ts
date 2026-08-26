import { Prisma, type ProjectStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type ProjectAttentionSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * The durable blocker facts the projects index needs to answer who must act next.
 *
 * Owner and recovery deliberately stay separate. USER means a person owns the next action;
 * TIME/EVENT/HUMAN says how the condition can clear. Treating recovery or blocker kind as the
 * actor would turn expected system waits into human alerts.
 */
export interface ProjectListAttention {
  userBlockers: number;
  coordinatorBlockers: number;
  systemBlockers: number;
  /** Loudest still-open USER-owned blocker; other actors never inflate human priority. */
  maxSeverity: ProjectAttentionSeverity | null;
  /** Oldest instant a still-open blocker became USER-owned, or null when none needs a person. */
  attentionSinceAt: Date | null;
  /** Earliest active durable check; escalated blockers no longer tick. */
  nextCheckAt: Date | null;
}

export function emptyProjectListAttention(): ProjectListAttention {
  return {
    userBlockers: 0,
    coordinatorBlockers: 0,
    systemBlockers: 0,
    maxSeverity: null,
    attentionSinceAt: null,
    nextCheckAt: null,
  };
}

interface AttentionRow extends ProjectListAttention {
  projectId: string;
}

/** Every open blocker on the requested projects, grouped in one bounded result row per project. */
export async function readProjectListAttention(
  prisma: PrismaService,
  ownerId: string,
  status?: ProjectStatus,
): Promise<Map<string, ProjectListAttention>> {
  const narrowed = status
    ? Prisma.sql`AND proj."status" = ${status}::project_status`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<AttentionRow[]>(Prisma.sql`
    SELECT blocker.project_id AS "projectId",
           (count(*) FILTER (WHERE blocker.owner = 'USER'))::int AS "userBlockers",
           (count(*) FILTER (WHERE blocker.owner = 'COORDINATOR'))::int AS "coordinatorBlockers",
           (count(*) FILTER (WHERE blocker.owner = 'SYSTEM'))::int AS "systemBlockers",
           (max(blocker.severity) FILTER (WHERE blocker.owner = 'USER'))::text AS "maxSeverity",
           min(coalesce(blocker.escalated_at, blocker.first_seen_at))
             FILTER (WHERE blocker.owner = 'USER') AS "attentionSinceAt",
           min(blocker.next_check_at)
             FILTER (WHERE blocker.escalated_at IS NULL) AS "nextCheckAt"
      FROM project_blocker blocker
      JOIN project proj ON proj.id = blocker.project_id
                       AND proj.owner_id = ${ownerId}::uuid
     WHERE blocker.resolved_at IS NULL ${narrowed}
     GROUP BY blocker.project_id`);

  return new Map(
    rows.map(({ projectId, ...attention }) => [projectId, attention]),
  );
}

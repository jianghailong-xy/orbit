import { Prisma } from '@prisma/client';
import type { SessionProjectMembership } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';

/** Direct membership, in the precedence order in session-list-projects-design.md §2. */
function directProjectMembershipSql(sessionAlias: string): Prisma.Sql {
  const s = Prisma.raw(sessionAlias);
  return Prisma.sql`(
    SELECT jsonb_build_object(
      'projectId', p.id, 'projectTitle', p.title, 'projectStatus', p.status,
      'role', candidate.role
    )
    FROM (
      SELECT p.id, 'COORDINATOR', 1
        FROM project p WHERE p.coordinator_session_id = ${s}.id
      UNION ALL
      SELECT t.project_id, 'TASK', 2
        FROM task t WHERE t.id = ${s}.task_id
      UNION ALL
      SELECT t.project_id, 'CONTEXT', 3
        FROM task t WHERE t.id = ${s}.context_task_id
      UNION ALL
      SELECT w.project_id, 'JUDGMENT', 4
        FROM project_coordinator_wake w
        WHERE w.session_id = ${s}.id AND w.status = 'SESSION_OPENED'
    ) candidate(project_id, role, priority)
    JOIN project p ON p.id = candidate.project_id
    ORDER BY candidate.priority, p.id
    LIMIT 1
  )`;
}

/** A JSON object or SQL NULL, shared by list, detail and realtime summaries.
 *  Only sessions without direct membership inherit their root's project, as CHILD.
 *  Aliases are caller-owned SQL identifiers, never request input. */
export function sessionProjectMembershipSql(sessionAlias: string): Prisma.Sql {
  const s = Prisma.raw(sessionAlias);
  return Prisma.sql`COALESCE(
    ${directProjectMembershipSql(sessionAlias)},
    (
      SELECT ${directProjectMembershipSql('membership_root')}
             || jsonb_build_object('role', 'CHILD')
      FROM session membership_root
      WHERE membership_root.id = ${s}.root_session_id AND membership_root.id <> ${s}.id
    )
  )`;
}

export async function readSessionProjectMembership(
  prisma: Pick<PrismaService, '$queryRaw'>,
  sessionId: string,
): Promise<SessionProjectMembership | null> {
  const [row] = await prisma.$queryRaw<Array<{ projectMembership: SessionProjectMembership | null }>>(Prisma.sql`
    SELECT ${sessionProjectMembershipSql('s')} AS "projectMembership"
    FROM session s WHERE s.id = ${sessionId}::uuid
  `);
  return row?.projectMembership ?? null;
}

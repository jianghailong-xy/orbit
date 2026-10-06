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

/** Every session that can be a member of `projectId`, read from that project's own rows through their
 *  indexes: its coordinator, the sessions executing or about its tasks, its open judgment sessions, and
 *  every session whose root is one of those. A superset — precedence can still put one of them in
 *  another project, or keep a child with its own membership out — so it is only ever narrowed by
 *  sessionProjectMembershipSql. Each source of directProjectMembershipSql needs a branch here.
 *
 *  The task branches are joins so the planner can start from either side: from the project's tasks
 *  when it has few, from the sessions that have a task when it has most of them (one production
 *  project holds 98% of all tasks; an array of its task ids took 0.4 s). The `IS NOT NULL` the join
 *  already implies is spelled out because it is what tells the planner how few those sessions are. */
function projectMembershipCandidatesSql(projectId: string): Prisma.Sql {
  return Prisma.sql`
    WITH direct(id) AS (
      SELECT p.coordinator_session_id FROM project p
        WHERE p.id = ${projectId}::uuid AND p.coordinator_session_id IS NOT NULL
      UNION ALL
      SELECT ts.id FROM session ts JOIN task t ON t.id = ts.task_id
        WHERE ts.task_id IS NOT NULL AND t.project_id = ${projectId}::uuid
      UNION ALL
      SELECT cs.id FROM session cs JOIN task t ON t.id = cs.context_task_id
        WHERE cs.context_task_id IS NOT NULL AND t.project_id = ${projectId}::uuid
      UNION ALL
      SELECT w.session_id FROM project_coordinator_wake w
        WHERE w.project_id = ${projectId}::uuid AND w.status = 'SESSION_OPENED' AND w.session_id IS NOT NULL
    )
    SELECT id FROM direct
    UNION
    SELECT child.id FROM session child WHERE child.root_session_id = ANY(ARRAY(SELECT id FROM direct))`;
}

/** `(sessionProjectMembershipSql(alias) ->> 'projectId')::uuid = projectId`, with the same answer for
 *  every session, but membership is computed only for the candidates above: as a filter, the bare
 *  comparison runs the membership subqueries for every row the rest of the WHERE leaves — every
 *  completed session of the owner, in the Completed view. The candidates, and their children, are
 *  matched with `= ANY` of an array, which stays an index lookup however its size is misestimated;
 *  `IN` lets a misestimate turn it into a scan of the whole table. */
export function sessionInProjectSql(sessionAlias: string, projectId: string): Prisma.Sql {
  const s = Prisma.raw(sessionAlias);
  return Prisma.sql`(
    ${s}.id = ANY(ARRAY(${projectMembershipCandidatesSql(projectId)}))
    AND (${sessionProjectMembershipSql(sessionAlias)} ->> 'projectId')::uuid = ${projectId}::uuid
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

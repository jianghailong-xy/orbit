import { Prisma } from '@prisma/client';

/**
 * A runaway backstop for the topological walk, not a product limit.
 *
 * `task_dependency` is kept acyclic by the application (`wouldCreateCycle`), not by a constraint,
 * so a cycle written by some other path would make the recursion below spin forever. The cap stops
 * it. It is far above any real project — the largest in the deployment is 118 tasks, and a chain
 * of N tasks reaches depth N-1 — so reaching it means the data is wrong, not that a project grew.
 */
export const PROJECT_TOPOLOGY_MAX_DEPTH = 1000;

/** One row of {@link projectTaskDependencyFactsSql}. */
export interface ProjectTaskDependencyFacts {
  taskId: string;
  status: string;
  /** Prerequisites of any kind, in this project or another. */
  prerequisiteCount: number;
  /** Effective chain tails still owing work — status OPEN or IN_PROGRESS. */
  unmetCount: number;
  /** Effective tails that ended without completing, or invalid chains — CANCELLED or FAILED. */
  abandonedCount: number;
  /** Prerequisites that are themselves tasks of this project (an edge inside the project). */
  projectPrerequisiteCount: number;
  /** Length in EDGES of the longest chain of in-project prerequisites reaching this task. */
  topoLevel: number;
}

/**
 * Every dependency fact this project's read faces derive from, one row per task, in one query.
 *
 * There is exactly one judgment about a prerequisite here and everything else is counted off it,
 * because the alternative — each endpoint asking the question in its own SQL — is how a task comes
 * to be `blocked` on one card and `ready` on the next. It mirrors `computeDependencyState`
 * (task-dependencies.ts) column for column. Each stored edge first resolves through the shared,
 * fail-closed supersession-chain function; a missing tail, broken link or cycle is treated as
 * FAILED. The resulting effective status is the definition every task surface shows:
 *
 *   - OPEN / IN_PROGRESS prerequisite  -> unmet         (BLOCKED: somebody still owes this work)
 *   - CANCELLED / FAILED prerequisite  -> abandoned     (BLOCKED_FAILED: nothing will finish it)
 *   - DONE prerequisite                -> neither
 *
 * so `dependencyState` is derivable from these counts alone: no prerequisites -> NONE, any
 * abandoned -> BLOCKED_FAILED, any unmet -> BLOCKED, otherwise READY.
 *
 * The two scopes here are also deliberate and different:
 *
 *   - `unmetCount` / `abandonedCount` count EVERY prerequisite, including one filed under another
 *     project. A task waiting on work outside its project is waiting, and a bucket that called it
 *     ready would send a reader looking for a dispatch refusal that does not exist.
 *   - `projectPrerequisiteCount` and `topoLevel` count the original stored edges with both ends in
 *     this project, because they describe the SHAPE and audit history of this project's graph.
 *     Supersession changes satisfaction, not the edge that was declared; an edge leaving the
 *     project is not part of the picture being drawn.
 */
export function projectTaskDependencyFactsSql(ownerId: string, projectId: string): Prisma.Sql {
  return Prisma.sql`
    WITH RECURSIVE
      scoped AS (
        SELECT t.id, t.status::text AS status
          FROM task t
         WHERE t.project_id = ${projectId}::uuid AND t.owner_id = ${ownerId}::uuid
      ),
      edge AS (
        SELECT d.task_id, d.depends_on_task_id
          FROM task_dependency d
          JOIN scoped dependent ON dependent.id = d.task_id
          JOIN scoped prerequisite ON prerequisite.id = d.depends_on_task_id
      ),
      prerequisite AS (
        SELECT d.task_id, coalesce(p.status::text, 'FAILED') AS status
          FROM task_dependency d
          JOIN scoped dependent ON dependent.id = d.task_id
          LEFT JOIN task p ON p.id = task_dependency_tail_id(d.depends_on_task_id)
      ),
      tally AS (
        SELECT task_id,
               count(*) AS prerequisite_count,
               count(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS')) AS unmet_count,
               count(*) FILTER (WHERE status IN ('CANCELLED', 'FAILED')) AS abandoned_count
          FROM prerequisite
         GROUP BY task_id
      ),
      project_tally AS (
        SELECT task_id, count(*) AS project_prerequisite_count FROM edge GROUP BY task_id
      ),
      -- Longest-path depth, walked forwards from the tasks with no in-project prerequisite.
      -- UNION rather than UNION ALL: the duplicate elimination is what bounds this at
      -- tasks x depth instead of enumerating every distinct path, which on a dense graph is
      -- exponential. A task reached at several depths keeps the largest, below.
      level(id, depth) AS (
        SELECT s.id, 0
          FROM scoped s
         WHERE NOT EXISTS (SELECT 1 FROM edge e WHERE e.task_id = s.id)
        UNION
        SELECT e.task_id, l.depth + 1
          FROM level l
          JOIN edge e ON e.depends_on_task_id = l.id
         WHERE l.depth < ${Prisma.raw(String(PROJECT_TOPOLOGY_MAX_DEPTH))}
      ),
      topo AS (SELECT id, max(depth) AS topo_level FROM level GROUP BY id)
    SELECT s.id AS "taskId",
           s.status AS "status",
           coalesce(tally.prerequisite_count, 0)::int AS "prerequisiteCount",
           coalesce(tally.unmet_count, 0)::int AS "unmetCount",
           coalesce(tally.abandoned_count, 0)::int AS "abandonedCount",
           coalesce(project_tally.project_prerequisite_count, 0)::int AS "projectPrerequisiteCount",
           -- A task absent from the walk is one nothing reached: it sits in a cycle, or past the
           -- depth cap. Both mean the graph is not what this metric assumes, so it contributes
           -- nothing to the depth rather than an invented number.
           coalesce(topo.topo_level, 0)::int AS "topoLevel"
      FROM scoped s
      LEFT JOIN tally ON tally.task_id = s.id
      LEFT JOIN project_tally ON project_tally.task_id = s.id
      LEFT JOIN topo ON topo.id = s.id`;
}

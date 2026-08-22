import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** How many roots the ranking returns when the caller does not say. */
export const DEFAULT_BLOCKING_LIMIT = 5;
/** A leaderboard, not a page: past a couple of dozen rows nobody is reading it as a ranking. */
export const MAX_BLOCKING_LIMIT = 50;

/**
 * Above this many unfinished tasks the closure is not walked at all, and the answer says so.
 *
 * The transitive closure of a graph of V nodes is up to V² pairs, so its cost grows with the
 * SQUARE of the project. At the size projects actually reach — the largest in the deployment is
 * 118 tasks — that is nothing, and this cap is nowhere near. It exists because "nothing" and
 * "everything" are two thousand tasks apart on that curve, and the failure it prevents is one
 * card taking the whole project page down with it.
 *
 * The guard is inside the statement (see the `edge` CTE), not around it: over the cap the planner
 * resolves the gate to a one-time filter and the walk is skipped rather than run and discarded.
 */
export const BLOCKING_MAX_UNFINISHED_TASKS = 2000;

/** One task, and how much of the project's remaining work is waiting behind it. */
export interface ProjectBlockingRoot {
  taskId: string;
  title: string;
  status: string;
  /**
   * Unfinished tasks that cannot start until this one is settled, counted through the WHOLE
   * chain rather than one hop out — see {@link readProjectBlockingLeaderboard}.
   */
  downstreamBlocked: number;
}

/** Why the ranking below is not the whole answer. */
export interface ProjectBlockingTruncation {
  reason: 'TOO_MANY_UNFINISHED_TASKS';
  /** The cap that was exceeded — {@link BLOCKING_MAX_UNFINISHED_TASKS}. */
  maxTasks: number;
}

export interface ProjectBlockingLeaderboard {
  /**
   * Every unfinished task in the project — the denominator, so a bar's length means something
   * absolute. "Unblocks 30" reads very differently against 34 remaining than against 300, and a
   * ranking normalised to its own leader cannot tell the two apart.
   */
  remainingCount: number;
  /** Highest `downstreamBlocked` first. Tasks blocking nothing are absent, not listed as zero. */
  items: ProjectBlockingRoot[];
  /** `null` when `items` is the real ranking, which is every case below the cap. */
  truncated: ProjectBlockingTruncation | null;
}

/** The half of every row that describes the project rather than one task in it. */
interface LeaderboardTotals {
  remainingCount: number;
  truncated: boolean;
}

/**
 * One row of the statement below: the totals on every row, the ranking spread across them.
 *
 * A project with no blocking task still answers with exactly one row, and on that row the whole
 * task half is null — see the LEFT JOIN LATERAL.
 */
type LeaderboardRow =
  | (LeaderboardTotals & ProjectBlockingRoot)
  | (LeaderboardTotals & { taskId: null; title: null; status: null; downstreamBlocked: null });

/**
 * Which unfinished task, if it were settled, would free the most of this project.
 *
 * `downstreamBlocked` is the TRANSITIVE closure, and that is the whole point of the endpoint. The
 * direct edge count is already available and is not an answer: in a chain the head and every link
 * in it block exactly one task each, so ranking by direct edges reports a five-way tie where one
 * task is holding up five and the rest are holding up one. Reaching through the chain is what
 * separates them, and it is what "unblock this first" has to mean.
 *
 * TWO THINGS THE WALK DELIBERATELY DOES NOT DO:
 *
 *   - It does not leave the unfinished subgraph. A DONE prerequisite is not a blocker — it owes
 *     nothing and cannot be "unblocked" — and a chain through one is not a chain: with A → B → C
 *     and B already DONE, settling A releases nothing, because C is waiting on B and B is
 *     finished. Dropping the finished tasks from both ends of every edge is what makes the count
 *     "work this task is holding up" rather than "work downstream of it in the original plan".
 *   - It does not count a task twice. `UNION` (not `UNION ALL`) dedupes the (root, reached) pairs
 *     as the recursion runs, so a diamond — A → B, A → C, both → D — credits A with three, not
 *     four. The dedupe is also what bounds the walk: the pair set is finite and monotone, so the
 *     recursion converges at V² rows in the worst case however dense the graph is, and terminates
 *     even on a cycle. That is why there is no depth cap here, unlike the longest-path walk in
 *     `project-dependency-facts.ts`, whose depth column can grow forever around a loop.
 *
 * The statement returns `remainingCount` on every row — including the one all-null row a project
 * with no blocking task produces — so the denominator survives an empty ranking.
 */
export async function readProjectBlockingLeaderboard(
  prisma: PrismaService,
  ownerId: string,
  projectId: string,
  limit: number,
): Promise<ProjectBlockingLeaderboard> {
  const rows = await prisma.$queryRaw<LeaderboardRow[]>(Prisma.sql`
    WITH RECURSIVE
      unfinished AS (
        SELECT t.id, t.title, t.status::text AS status
          FROM task t
         WHERE t.project_id = ${projectId}::uuid
           AND t.owner_id = ${ownerId}::uuid
           AND t.status NOT IN ('DONE', 'CANCELLED')
      ),
      -- Counted once and read twice: the number served as remainingCount is the same number the
      -- gate below decides on, so the answer cannot report a size the walk disagreed with.
      size AS (
        SELECT count(*)::int AS remaining,
               count(*) > ${Prisma.raw(String(BLOCKING_MAX_UNFINISHED_TASKS))} AS truncated
          FROM unfinished
      ),
      -- Both ends unfinished, and no edge at all once the project is over the cap: the subquery is
      -- uncorrelated, so the planner evaluates it once and skips the scan rather than filtering it.
      edge AS (
        SELECT d.depends_on_task_id AS blocker, d.task_id AS blocked
          FROM task_dependency d
          JOIN unfinished b ON b.id = d.depends_on_task_id
          JOIN unfinished w ON w.id = d.task_id
         WHERE NOT (SELECT truncated FROM size)
      ),
      reach(root, node) AS (
        SELECT blocker, blocked FROM edge
        UNION
        SELECT r.root, e.blocked FROM reach r JOIN edge e ON e.blocker = r.node
      )
    SELECT s.remaining AS "remainingCount",
           s.truncated AS "truncated",
           ranked."taskId",
           ranked."title",
           ranked."status",
           ranked."downstreamBlocked"
      FROM size s
      -- LATERAL over the one-row size CTE, so a project whose ranking is empty still answers with a
      -- row carrying the count instead of answering with nothing.
      LEFT JOIN LATERAL (
        SELECT o.id AS "taskId",
               o.title AS "title",
               o.status AS "status",
               count(DISTINCT r.node)::int AS "downstreamBlocked"
          FROM reach r
          JOIN unfinished o ON o.id = r.root
         GROUP BY o.id, o.title, o.status
         -- Title then id after the count: ties are common (every link of a chain blocks the same
         -- number) and a ranking that reshuffles between two identical reads is not a ranking.
         ORDER BY "downstreamBlocked" DESC, o.title ASC, o.id ASC
         LIMIT ${limit}
      ) ranked ON true
     ORDER BY ranked."downstreamBlocked" DESC, ranked."title" ASC, ranked."taskId" ASC`);

  const items: ProjectBlockingRoot[] = [];
  for (const row of rows) {
    if (row.taskId === null) continue;
    const { taskId, title, status, downstreamBlocked } = row;
    items.push({ taskId, title, status, downstreamBlocked });
  }

  const [first] = rows;
  return {
    remainingCount: first?.remainingCount ?? 0,
    items,
    truncated: first?.truncated
      ? { reason: 'TOO_MANY_UNFINISHED_TASKS', maxTasks: BLOCKING_MAX_UNFINISHED_TASKS }
      : null,
  };
}

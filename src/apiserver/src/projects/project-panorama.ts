import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { projectTaskDependencyFactsSql } from './project-dependency-facts';

/**
 * Which picture this project's graph is worth drawing as.
 *
 * `mesh` means the edges carry information a list cannot: enough of them per task that the
 * connections are the subject, and few enough tasks that a node-link drawing stays readable.
 * `chain` is everything else, and on the measured deployment it is nearly everything — twelve
 * projects, most of them at about one edge per task, the largest of them 118 tasks and 117 edges.
 */
export type ProjectTopologyForm = 'chain' | 'mesh';

/** Above this many edges per task the connections are the subject rather than the ordering. */
const MESH_EDGE_RATIO = 1.5;
/** Above this many tasks a node-link drawing stops being readable whatever its density. */
const MESH_MAX_TASKS = 30;

/**
 * How this project's work is distributed, with `OPEN` split into the three things it conflates.
 *
 * `tasksByStatus` (see `ProjectsService.get`) reports one OPEN number, and across the deployment
 * that number is 233 tasks waiting on a prerequisite and 29 that could start right now — the same
 * bucket for "nothing to do about this yet" and "nobody has picked this up". Separating them is
 * what this endpoint exists for: `ready > 0` with `running == 0` is a stalled project, and no
 * combined count can say so.
 *
 * `running` is the third thing that OPEN hides, and the reason it is not simply
 * `status = 'IN_PROGRESS'`: dispatch opens a Session and leaves the task row OPEN, so a project
 * with three live runs used to report `running: 0` — and, worse, raise the stalled banner, which
 * exists to say the queue is not being served. A task with a live Session is counted here and is
 * therefore NOT in `ready`, whose card reads "unblocked, not dispatched".
 *
 * A task in status FAILED is in none of these buckets, deliberately: it is neither work in flight
 * nor work settled, and folding it into `cancelled` would report a run that broke as a decision
 * somebody made. `shape.taskCount` still counts it, so the buckets need not sum to the total.
 */
export interface ProjectPanoramaBuckets {
  /** Work in flight: a task with a live Session on it, or one the row itself calls IN_PROGRESS. */
  running: number;
  ready: number;
  blocked: number;
  done: number;
  cancelled: number;
}

/** The project's dependency graph as three numbers and the verdict drawn from them. */
export interface ProjectPanoramaShape {
  taskCount: number;
  /** Edges with BOTH ends in this project — see `projectTaskDependencyFactsSql`. */
  edgeCount: number;
  /** `edgeCount / taskCount`, and exactly 0 for a project with no tasks. */
  ratio: number;
  /** Length in EDGES of the longest dependency path, so a 10-task chain reports 9. */
  maxDepth: number;
  form: ProjectTopologyForm;
}

export interface ProjectPanorama {
  buckets: ProjectPanoramaBuckets;
  shape: ProjectPanoramaShape;
}

interface PanoramaRow {
  running: number;
  ready: number;
  blocked: number;
  done: number;
  cancelled: number;
  taskCount: number;
  edgeCount: number;
  maxDepth: number;
}

/** The `form` rule on its own, so a caller can apply it to numbers it already holds. */
export function topologyForm(taskCount: number, ratio: number): ProjectTopologyForm {
  return ratio > MESH_EDGE_RATIO && taskCount < MESH_MAX_TASKS ? 'mesh' : 'chain';
}

/**
 * Both halves of the project page's header, in one round trip.
 *
 * Every number is aggregated database-side over `projectTaskDependencyFactsSql`, which is the one
 * place a prerequisite is judged: `ready` and `blocked` partition the OPEN tasks on that judgment
 * alone, so they cannot double-count and cannot leave one out. A prerequisite that was CANCELLED
 * makes its dependent `ready` rather than `blocked` — nothing is owed to it any more, and the
 * thing standing between it and a run is a person, which is what `ready` with nothing running
 * means everywhere else on this page.
 *
 * `edgeCount` is summed from each task's in-project prerequisite count rather than counted in a
 * second query, so "an edge inside this project" has one definition rather than two.
 */
export async function readProjectPanorama(
  prisma: PrismaService,
  ownerId: string,
  projectId: string,
): Promise<ProjectPanorama> {
  const facts = projectTaskDependencyFactsSql(ownerId, projectId);
  // An aggregate with no GROUP BY returns exactly one row over zero input rows, which is what
  // makes an empty project a row of zeroes rather than an empty result to guess at.
  //
  // `live` is the dispatch half of `running`, and the join is a derived table rather than an
  // `EXISTS` per task so a 23,442-task project costs one small index scan instead of 23,442
  // probes: `session_task_execution_claim_idx` is partial over exactly these statuses, so the
  // subquery reads the live sessions and nothing else.
  //
  // PENDING counts with RUNNING — both mean a session holds this task, which is what `ready`'s
  // "not dispatched" denies — and the pair is the same one `TasksService.withRunning` derives, so
  // the header, the task list and the project graph cannot disagree about a running task. Only an
  // OPEN task is promoted: a re-run opened against a task that is already DONE must not take it
  // back out of `done`, which is what the chain strip counts progress with.
  const [row] = await prisma.$queryRaw<PanoramaRow[]>(Prisma.sql`
    SELECT (count(*) FILTER (WHERE f."status" = 'IN_PROGRESS'
                                OR (f."status" = 'OPEN' AND live.task_id IS NOT NULL)))::int AS "running",
           (count(*) FILTER (WHERE f."status" = 'OPEN' AND live.task_id IS NULL
                               AND f."unmetCount" = 0))::int AS "ready",
           (count(*) FILTER (WHERE f."status" = 'OPEN' AND live.task_id IS NULL
                               AND f."unmetCount" > 0))::int AS "blocked",
           (count(*) FILTER (WHERE f."status" = 'DONE'))::int AS "done",
           (count(*) FILTER (WHERE f."status" = 'CANCELLED'))::int AS "cancelled",
           count(*)::int AS "taskCount",
           coalesce(sum(f."projectPrerequisiteCount"), 0)::int AS "edgeCount",
           coalesce(max(f."topoLevel"), 0)::int AS "maxDepth"
      FROM (${facts}) f
      LEFT JOIN (
        SELECT DISTINCT s.task_id
          FROM session s
         WHERE s.owner_id = ${ownerId}::uuid
           AND s.status IN ('PENDING', 'RUNNING')
           AND s.task_id IS NOT NULL
      ) live ON live.task_id = f."taskId"`);

  const taskCount = row?.taskCount ?? 0;
  const edgeCount = row?.edgeCount ?? 0;
  const ratio = taskCount === 0 ? 0 : edgeCount / taskCount;
  return {
    buckets: {
      running: row?.running ?? 0,
      ready: row?.ready ?? 0,
      blocked: row?.blocked ?? 0,
      done: row?.done ?? 0,
      cancelled: row?.cancelled ?? 0,
    },
    shape: { taskCount, edgeCount, ratio, maxDepth: row?.maxDepth ?? 0, form: topologyForm(taskCount, ratio) },
  };
}

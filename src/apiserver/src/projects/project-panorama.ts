import { Prisma } from '@prisma/client';
import type { ProjectIntegrationBuckets } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { dependenciesSatisfiedSql, everyPrerequisiteTailDoneSql } from '../tasks/task-dependencies';
import { projectTaskDependencyFactsSql } from './project-dependency-facts';
import { isCodeTaskSql, lineStartedSql, taskLandingSql } from './project-criterion-landing';
import { projectTaskWorkStateSql } from './project-task-work-state';

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
 * How this project's work is distributed by the canonical task-start/completion semantics.
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
 * FAILED and CANCELLED are separate terminal lanes. They are both explicit so this interface is an
 * exhaustive partition: every bucket sum equals `shape.taskCount`; failures can never disappear
 * from the denominator or be mistaken for a cancellation.
 */
export interface ProjectPanoramaBuckets extends Partial<ProjectIntegrationBuckets> {
  /** Work in flight: a task with a live Session on it, or one the row itself calls IN_PROGRESS. */
  running: number;
  ready: number;
  blocked: number;
  awaitingVerification: number;
  done: number;
  failed: number;
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

interface PanoramaRow extends ProjectIntegrationBuckets {
  /** Whether ANY task in this project sits under a binding that has begun integrating (§1.1). */
  lineStarted: boolean;
  running: number;
  ready: number;
  blocked: number;
  awaitingVerification: number;
  done: number;
  failed: number;
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
 * Shape is aggregated over `projectTaskDependencyFactsSql`; lifecycle lanes come from
 * `projectTaskWorkStateSql`, the same classifier the project list, task cards and topology read.
 * In particular READY embeds the execute predicate rather than reinterpreting OPEN + graph shape,
 * and an independent-verification subject remains AWAITING_VERIFICATION until its canonical newest
 * verifier opens a PASS epoch.
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
  const workState = Prisma.raw(projectTaskWorkStateSql('task_row'));
  // The integration half (§7.2 V6), read in the SAME pass over `task` as the lanes above: the
  // three buckets `done` splits across are a partition of it, and computing them in a second query
  // would let the two disagree about one task across the gap between them.
  const landing = Prisma.raw(taskLandingSql('task_row'));
  const isCode = Prisma.raw(isCodeTaskSql('task_row'));
  const lineStarted = Prisma.raw(lineStartedSql('task_row'));
  // Held up by a landing AND BY NOTHING ELSE: the dependency predicate refuses it, and the same
  // predicate with the landing clause lifted would not. The subtraction is what makes this
  // "waiting for a prerequisite to land" rather than "blocked", which every task with an
  // unfinished prerequisite also is. Same two expressions `ProjectReadyToRun` counts it with.
  const blockedByLanding = Prisma.raw(
    `(NOT (${dependenciesSatisfiedSql('task_row')})`
    + ` AND ${dependenciesSatisfiedSql('task_row', { ignoreLanding: true })})`,
  );
  // The necessary condition for that subtraction, which is what keeps it off 109,874 rows: both
  // halves of it require every prerequisite's chain tail to be DONE, and on the project measured
  // here 170 of those rows do. Asked as a set here rather than as a sixth column below, because a
  // column is a correlated subquery the planner runs once per row, while this is one anti join.
  const tailsDone = Prisma.raw(everyPrerequisiteTailDoneSql('task_row'));
  // An aggregate with no GROUP BY returns exactly one row over zero input rows, which is what
  // makes an empty project a row of zeroes rather than an empty result to guess at.
  //
  const [row] = await prisma.$queryRaw<PanoramaRow[]>(Prisma.sql`
    WITH line_started AS MATERIALIZED (
      -- One project, so one answer. Read per task it is the same EXISTS 109,874 times over; the
      -- one-row relation is what lets the shared definition go on reading a project_id column.
      SELECT (${lineStarted}) AS "lineStarted"
        FROM (SELECT ${projectId}::uuid AS "project_id") task_row
    ),
    landing_candidate AS MATERIALIZED (
      SELECT task_row."id"
        FROM "task" task_row
       WHERE task_row."owner_id" = ${ownerId}::uuid
         AND task_row."project_id" = ${projectId}::uuid
         -- OPEN for the same reason ProjectReadyToRun counts this over OPEN rows: the one
         -- consumer of the column below also asks for BLOCKED, and projectTaskWorkStateSql
         -- reaches BLOCKED only from an OPEN row — every other status is answered by an earlier
         -- branch of its CASE. Without it a project whose tasks are mostly finished pays the
         -- guard for rows whose answer the aggregate discards.
         AND task_row."status" = 'OPEN'::"task_status"
         AND ${tailsDone}
    ),
    -- MATERIALIZED on both, so the cheap half is a fence the expensive half cannot be planned
    -- across: the subtraction below runs on the candidates, not on the project.
    landing_wait AS MATERIALIZED (
      SELECT task_row."id"
        FROM "task" task_row
        JOIN landing_candidate ON landing_candidate."id" = task_row."id"
       WHERE ${blockedByLanding}
    ),
    work AS MATERIALIZED (
      SELECT task_row."id" AS "taskId", (${workState})::text AS "workState",
             (${landing})::text AS "landing",
             (${isCode}) AS "isCode",
             (SELECT "lineStarted" FROM line_started) AS "lineStarted",
             -- Blocked BY A LANDING: false for every row the candidate set above leaves out,
             -- which is why it is read only under a BLOCKED filter.
             (task_row."id" IN (SELECT "id" FROM landing_wait)) AS "waitingForLanding"
        FROM "task" task_row
       WHERE task_row."owner_id" = ${ownerId}::uuid
         AND task_row."project_id" = ${projectId}::uuid
    )
    SELECT (count(*) FILTER (WHERE work."workState" = 'RUNNING'))::int AS "running",
           (count(*) FILTER (WHERE work."workState" = 'READY'))::int AS "ready",
           (count(*) FILTER (WHERE work."workState" = 'BLOCKED'))::int AS "blocked",
           (count(*) FILTER (WHERE work."workState" = 'AWAITING_VERIFICATION'))::int
             AS "awaitingVerification",
           (count(*) FILTER (WHERE work."workState" = 'DONE'))::int AS "done",
           (count(*) FILTER (WHERE work."workState" = 'FAILED'))::int AS "failed",
           (count(*) FILTER (WHERE work."workState" = 'CANCELLED'))::int AS "cancelled",
           -- The three lanes DONE splits across, plus the remainder, in that order. Every one of
           -- them is filtered on DONE, so they partition it by construction: a reader adding them
           -- up gets the done count back, whatever the row underneath turns out to be.
           (count(*) FILTER (
              WHERE work."workState" = 'DONE' AND work."landing" = 'NOT_KNOWN'
                AND work."isCode" AND work."lineStarted"))::int AS "integrating",
           (count(*) FILTER (
              WHERE work."workState" = 'DONE' AND work."landing" = 'ON_INTEGRATION_LINE'))::int
             AS "onIntegrationLine",
           (count(*) FILTER (
              WHERE work."workState" = 'DONE' AND work."landing" = 'ON_UPSTREAM'))::int
             AS "onUpstream",
           (count(*) FILTER (
              WHERE work."workState" = 'DONE' AND work."landing" = 'NOT_KNOWN'
                AND NOT (work."isCode" AND work."lineStarted")))::int AS "doneNotIntegrated",
           (count(*) FILTER (
              WHERE work."workState" = 'BLOCKED' AND work."waitingForLanding"))::int
             AS "waitingForLanding",
           coalesce(bool_or(work."lineStarted"), false) AS "lineStarted",
           count(*)::int AS "taskCount",
           coalesce(sum(f."projectPrerequisiteCount"), 0)::int AS "edgeCount",
           coalesce(max(f."topoLevel"), 0)::int AS "maxDepth"
      FROM (${facts}) f
      JOIN work ON work."taskId" = f."taskId"`);

  const taskCount = row?.taskCount ?? 0;
  const edgeCount = row?.edgeCount ?? 0;
  const ratio = taskCount === 0 ? 0 : edgeCount / taskCount;
  return {
    buckets: {
      running: row?.running ?? 0,
      ready: row?.ready ?? 0,
      blocked: row?.blocked ?? 0,
      awaitingVerification: row?.awaitingVerification ?? 0,
      done: row?.done ?? 0,
      failed: row?.failed ?? 0,
      cancelled: row?.cancelled ?? 0,
      // Reported only by a project that HAS a line and has begun using it. Five zeroes on a
      // project that does not integrate would be five true numbers answering a question nobody
      // asked, and a client cannot tell "nothing is in flight" from "nothing ever will be"
      // once they are there — so the absence is the answer, and it is the whole set or none.
      ...(row?.lineStarted
        ? {
            integrating: row.integrating,
            onIntegrationLine: row.onIntegrationLine,
            onUpstream: row.onUpstream,
            doneNotIntegrated: row.doneNotIntegrated,
            waitingForLanding: row.waitingForLanding,
          }
        : {}),
    },
    shape: { taskCount, edgeCount, ratio, maxDepth: row?.maxDepth ?? 0, form: topologyForm(taskCount, ratio) },
  };
}

import { Logger } from '@nestjs/common';
import { Prisma, ProjectStatus } from '@prisma/client';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import type { PrismaService } from '../prisma/prisma.service';
import { readBackfillCandidates } from './landing-observation-backfill';
import {
  deliveredNothingOfItsOwnSql,
  frozenIdentityMeasuresNothingSql,
  unnamedIdentityMeasuresNothingSql,
} from './project-criterion-landing';
import { readDerivedProjectStatusWrite } from './project-done-derived';
import { refreshProjectDone } from './project-done-request';
import { readDeliveredIdentity } from './project-integration-job';
import { DELIVERY_REVIEW_KIND, deliveryReviewKey } from './project-open-item';

/**
 * The repair of what §12.15 P-M1's first reading wrote, run on every start of the API server after the
 * deploy-time pass (`landing-observation-backfill.ts`).
 *
 * WHAT HAPPENED (2026-11-20)
 * --------------------------
 * P-M1 shipped reading "a task has nothing to land" as: its frozen identity has no commit past its base,
 * AND no work session of it reported a non-empty `changed_files`. The runner reports `changed_files` as
 * `git diff <base>..HEAD` wherever HEAD is, and verification runs are told to `git checkout --detach`
 * their project's line: each such run, committing nothing, reported the whole diff from its base to the
 * commit it checked out. The deploy-time pass froze the empty identities of those finished tasks (codeless
 * ones were code work for the first time, P-M3), queued an observation for each project it froze
 * something in, and that observation's result re-derived the project with the first reading: settled
 * projects went from DONE to OPEN, their criteria read NO_RECEIPT, and their coordinators were asked
 * about "changed files outside the declaration" that the tasks had only checked out.
 *
 * WHAT THIS DOES, AND ONLY THIS
 * -----------------------------
 * The same deploy flipped two more settled projects through the other half of the rule: a task P-M3 made
 * code work whose identity nobody can name, because its work finished before the runner reported a branch
 * tip, read as work the line never answered for (`unnamedIdentityMeasuresNothing` is the owner's ruling on
 * those).
 *
 * The rule is fixed where it is read (`deliveredNothingOfItsOwn`): those tasks now read nothing to land,
 * so their criteria read LANDED, by a fact. What the first reading WROTE does not change with it, and that
 * is what is repaired here, for exactly the tasks the first reading misread — DONE, and either frozen with
 * no commit past the base, measuring nothing of their own now, with a work session whose `changed_files`
 * is a non-empty list (the first reading's clause, read here only to find its footprint, never to decide),
 * or measuring nothing of their own with an identity nobody can name:
 *
 *   1. the questions the first reading put about them, while still OPEN, are SUPERSEDED by the fact —
 *      the scope review (`DR:OUTSIDE_DECLARED_SCOPE:<task>`) and the `LANDING_UNOBSERVED` it opened as
 *      WORK_ELSEWHERE or IDENTITY_UNKNOWN. An item somebody already answered stays as they answered it: a
 *      closed item is never rewritten (`project_open_item_terminal_guard`);
 *   2. each project in which one of them serves a criterion is projected again (`refreshProjectDone`, the
 *      same projection every post-commit edge runs), so a project the first reading took out of DONE is
 *      DONE again when the facts prove it — recorded DERIVED, at the moment of this repair. The original
 *      completion time is not restored: the projection that took DONE away cleared it, and nothing else
 *      recorded it. A task that serves no criterion moves no derivation, so its project is not projected
 *      for it: that would only store whatever an unrelated lag left, which is not this repair's to do.
 *
 * It writes no merge receipt, no identity, no task status and no criterion, sends no push, and wakes no
 * coordinator. An owner's record or Reopen press stands, as the projection itself makes it stand.
 *
 * WHAT IT WILL DO IS READABLE BEFORE IT RUNS
 * ------------------------------------------
 * `predictLandingRegressionRepair` reads, and writes nothing, what a start would do: the same footprint,
 * the same items by the same condition, and the projection's own decision (`readDerivedProjectStatusWrite`,
 * the function `storeDerivedProjectStatus` writes from). `landing-regression-repair-dry-run.ts` runs it in
 * a READ ONLY transaction against any database, so a deploy can show the owner the list first; the start's
 * log lines name the same projects, tasks and items.
 *
 * WHY ON EVERY START, AND WHY TWICE IS FINE
 * ---------------------------------------
 * A release boots the new image once before the handover, while the old server still serves: the pass
 * and this repair run in that first process, and again in the process that stays. An edge of the old
 * server in between can re-derive a repaired project with the first reading and take DONE away again;
 * the second run puts it back. Every write is a compare-and-set — an item only while OPEN, the project
 * only through the projection's own — so a run over repaired rows writes nothing.
 */

const logger = new Logger('LandingRegressionRepair');

/** What a superseded question says, in the item's own record. */
export const NOTHING_OF_ITS_OWN_NOTE =
  'This task delivered nothing of its own: no work session of it holds a commit or an uncommitted change '
  + 'of its own, and its delivered commit is its base commit or every session reported an empty diff. '
  + 'The changed files this question was about were not its work.';

/** Which half of §12.15 P-M1 a task of the footprint measures nothing by. */
export type RepairClause =
  /** Frozen with no commit past its base, misread by the first reading through `changed_files`. */
  | 'EMPTY_IDENTITY'
  /** An identity nobody can name, whose every work session reported an empty diff. */
  | 'UNNAMED_IDENTITY_EMPTY_LISTS';

/** One task of the footprint. */
export interface RepairTask {
  taskId: string;
  clause: RepairClause;
  /** Whether it serves one of its project's criteria — only such a task can move the project's DONE. */
  servesCriterion: boolean;
}

/** What the repair did — or, predicted, will do — for one project. */
export interface RegressionRepairProject {
  projectId: string;
  tasks: RepairTask[];
  /** The OPEN items superseded by the fact (predicted: that will be). */
  supersededItemIds: string[];
  statusBefore: string | null;
  statusAfter: string | null;
  /** When the projection stored DONE in this run; null when it did not (and in a prediction). */
  doneAgainAt: Date | null;
  /** What the projection withholds DONE for, when it does. */
  withheld: string[];
}

export interface RegressionRepairResult {
  projects: RegressionRepairProject[];
  failures: Array<{ projectId: string; error: string }>;
}

/** What a start would do, read and not written. */
export interface RegressionRepairPrediction {
  /** Tasks the deploy-time pass would freeze before the repair runs, whose effect this does not follow. */
  passWouldFreeze: string[];
  /**
   * The OPEN tasks that wait on a footprint task (§2.5 J9 reads the same predicate, live): once the fixed
   * server runs, each is released as far as that prerequisite goes, and the 60 s ready sweep starts the
   * ones that start by themselves (`autoRunWhenReady`, in a started project that is not paused) once
   * their other prerequisites are met too.
   */
  dependents: Array<{
    taskId: string; title: string; waitsOn: string; projectId: string | null;
    autoRunWhenReady: boolean; projectStarted: boolean; projectPaused: boolean;
  }>;
  projects: Array<RegressionRepairProject & {
    title: string | null;
    items: Array<{ itemId: string; kind: string; dedupeKey: string; reason: string | null }>;
  }>;
}

interface Footprint {
  taskId: string;
  projectId: string;
  ownerId: string;
  clause: RepairClause;
  servesCriterion: boolean;
}

/**
 * The tasks the first reading misread, by project: DONE, and either frozen with no commit past their
 * base, with nothing of their own under the fixed rule, and with a work session whose `changed_files` is a
 * list with something in it — the clause the first reading withheld on — or measuring nothing of their
 * own with an identity nobody can name.
 */
export function readRegressionFootprint(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
): Promise<Footprint[]> {
  return db.$queryRaw<Footprint[]>(Prisma.sql`
    SELECT t."id" AS "taskId", t."project_id" AS "projectId", t."owner_id" AS "ownerId",
           CASE WHEN ${Prisma.raw(unnamedIdentityMeasuresNothingSql('t'))}
                THEN 'UNNAMED_IDENTITY_EMPTY_LISTS' ELSE 'EMPTY_IDENTITY' END AS "clause",
           t."criterion_definition_id" IS NOT NULL AS "servesCriterion"
      FROM "task" t
     WHERE t."status" = 'DONE'
       AND t."project_id" IS NOT NULL
       AND ((
         ${Prisma.raw(frozenIdentityMeasuresNothingSql('t'))}
         AND EXISTS (
           SELECT 1 FROM "session" first_reading
            WHERE first_reading."task_id" = t."id"
              AND first_reading."starts_task_work" = true
              AND first_reading."deleted_at" IS NULL
              AND first_reading."isolation_status" = 'worktree'
              AND first_reading."branch" IS NOT NULL
              AND jsonb_typeof(first_reading."changed_files") = 'array'
              AND first_reading."changed_files" <> '[]'::jsonb
         )
       ) OR ${Prisma.raw(unnamedIdentityMeasuresNothingSql('t'))})
     ORDER BY t."project_id", t."id"`);
}

/**
 * The OPEN questions the first reading put about these tasks, re-checked against the fixed rule: the
 * scope review (`DR:OUTSIDE_DECLARED_SCOPE:<task>`) and `LANDING_UNOBSERVED` as WORK_ELSEWHERE or
 * IDENTITY_UNKNOWN. One condition, read by the prediction and written by the repair.
 */
function firstReadingItemsWhere(projectId: string, taskIds: readonly string[]): Prisma.Sql {
  const scopeKeys = taskIds.map((taskId) => deliveryReviewKey('OUTSIDE_DECLARED_SCOPE', taskId));
  return Prisma.sql`
         item."project_id" = ${projectId}::uuid
     AND item."task_id" = ANY(${[...taskIds]}::uuid[])
     AND item."state" = 'OPEN'
     AND t."id" = item."task_id"
     AND t."status" = 'DONE'
     AND ${Prisma.raw(deliveredNothingOfItsOwnSql('t'))}
     AND (
       (item."kind" = ${DELIVERY_REVIEW_KIND} AND item."dedupe_key" = ANY(${scopeKeys}::text[]))
       OR (item."kind" = 'LANDING_UNOBSERVED'
           AND item."payload"->>'reason' IN ('WORK_ELSEWHERE', 'IDENTITY_UNKNOWN'))
     )`;
}

/** Supersede those questions, in one statement, each re-checked under the statement that closes it. */
export async function supersedeFirstReadingItems(
  tx: Prisma.TransactionClient,
  input: { projectId: string; taskIds: readonly string[] },
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "project_open_item" item
       SET "state" = 'SUPERSEDED',
           "resolved_at" = now(),
           "resolved_by" = 'PLATFORM',
           "resolution_note" = ${NOTHING_OF_ITS_OWN_NOTE},
           "updated_at" = now()
      FROM "task" t
     WHERE ${firstReadingItemsWhere(input.projectId, input.taskIds)}
    RETURNING item."id"`);
  return rows.map((row) => row.id).sort();
}

/** The footprint grouped by project, in project id order. */
function byProject(rows: readonly Footprint[]): Map<string, { ownerId: string; tasks: RepairTask[] }> {
  const grouped = new Map<string, { ownerId: string; tasks: RepairTask[] }>();
  for (const row of rows) {
    const project = grouped.get(row.projectId) ?? { ownerId: row.ownerId, tasks: [] };
    project.tasks.push({ taskId: row.taskId, clause: row.clause, servesCriterion: row.servesCriterion });
    grouped.set(row.projectId, project);
  }
  return grouped;
}

/**
 * What a start would do now, read and not written: every project of the footprint, the status the
 * projection would store over it, its tasks and the clause each measures nothing by, and the OPEN items
 * that would be superseded. Also the identities the deploy-time pass would freeze first, which the
 * prediction does not follow — a start after a pass that froze some may repair more than this says.
 */
export async function predictLandingRegressionRepair(
  db: Prisma.TransactionClient,
): Promise<RegressionRepairPrediction> {
  const passWouldFreeze: string[] = [];
  for (const candidate of await readBackfillCandidates(db)) {
    const reading = await readDeliveredIdentity(db, candidate.ownerId, candidate.taskId);
    if (reading.kind === 'KNOWN') passWouldFreeze.push(candidate.taskId);
  }
  const footprint = await readRegressionFootprint(db);
  const dependents = footprint.length === 0 ? [] : await db.$queryRaw<RegressionRepairPrediction['dependents']>(Prisma.sql`
    SELECT dependent."id" AS "taskId", dependent."title", edge."depends_on_task_id" AS "waitsOn",
           dependent."project_id" AS "projectId", dependent."auto_run_when_ready" AS "autoRunWhenReady",
           (project."started_at" IS NOT NULL) AS "projectStarted", (project."paused_at" IS NOT NULL) AS "projectPaused"
      FROM "task_dependency" edge
      JOIN "task" dependent ON dependent."id" = edge."task_id"
      LEFT JOIN "project" project ON project."id" = dependent."project_id"
     WHERE edge."depends_on_task_id" = ANY(${footprint.map((row) => row.taskId)}::uuid[])
       AND dependent."status" = 'OPEN'
     ORDER BY dependent."project_id", dependent."id"`);
  const prediction: RegressionRepairPrediction = { passWouldFreeze, dependents, projects: [] };
  for (const [projectId, { ownerId, tasks }] of byProject(footprint)) {
    const items = await db.$queryRaw<Array<{ itemId: string; kind: string; dedupeKey: string; reason: string | null }>>(
      Prisma.sql`
        SELECT item."id" AS "itemId", item."kind", item."dedupe_key" AS "dedupeKey",
               item."payload"->>'reason' AS "reason"
          FROM "project_open_item" item, "task" t
         WHERE ${firstReadingItemsWhere(projectId, tasks.map((task) => task.taskId))}
         ORDER BY item."id"`);
    const decision = await readDerivedProjectStatusWrite(db as unknown as PrismaService, ownerId, projectId);
    const project = await db.project.findFirst({ where: { id: projectId, ownerId }, select: { title: true } });
    const reprojected = tasks.some((task) => task.servesCriterion);
    prediction.projects.push({
      projectId,
      title: project?.title ?? null,
      tasks,
      items,
      supersededItemIds: items.map((item) => item.itemId),
      statusBefore: decision.stored?.status ?? null,
      statusAfter: (reprojected ? decision.write : null) ?? decision.stored?.status ?? null,
      doneAgainAt: null,
      withheld: decision.derived.withheld,
    });
  }
  return prediction;
}

/**
 * The repair: per project, its items in a transaction of their own, then the projection. One project that
 * fails is logged and left for the next start; it does not stop the others, and it never fails a start.
 */
export async function runLandingRegressionRepair(
  prisma: PrismaService,
  options: { log?: Pick<Logger, 'log' | 'warn' | 'error'> } = {},
): Promise<RegressionRepairResult> {
  const log = options.log ?? logger;
  const grouped = byProject(await readRegressionFootprint(prisma));
  const result: RegressionRepairResult = { projects: [], failures: [] };
  for (const [projectId, { ownerId, tasks }] of grouped) {
    try {
      const before = await prisma.project.findFirst({ where: { id: projectId, ownerId }, select: { status: true } });
      const supersededItemIds = await withTransactionRetry(
        prisma,
        (tx) => supersedeFirstReadingItems(tx, { projectId, taskIds: tasks.map((task) => task.taskId) }),
        loggedRetry(logger, 'landingRegressionRepair.items'),
      );
      // Only a project in which a misread task serves a criterion: nothing else moves its derivation.
      const derived = tasks.some((task) => task.servesCriterion)
        ? await refreshProjectDone(prisma, ownerId, projectId, {})
        : null;
      const after = await prisma.project.findFirst({
        where: { id: projectId, ownerId }, select: { status: true, doneAt: true },
      });
      const doneAgain = before?.status === ProjectStatus.OPEN && after?.status === ProjectStatus.DONE;
      const repaired: RegressionRepairProject = {
        projectId,
        tasks,
        supersededItemIds,
        statusBefore: before?.status ?? null,
        statusAfter: after?.status ?? null,
        doneAgainAt: doneAgain ? after?.doneAt ?? null : null,
        withheld: derived?.withheld ?? [],
      };
      result.projects.push(repaired);
      const line = repairLine(repaired);
      if (line) log.log(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failures.push({ projectId, error: message });
      log.error(`landing repair of project ${projectId} failed and is left for the next start: ${message}`);
    }
  }
  if (grouped.size > 0) {
    const doneAgain = result.projects.filter((project) => project.doneAgainAt !== null).length;
    const superseded = result.projects.reduce((sum, project) => sum + project.supersededItemIds.length, 0);
    log.log(`landing repair: ${grouped.size} project(s) hold tasks that measure nothing of their own and were `
      + `misread, ${doneAgain} done again by derivation, ${superseded} open item(s) superseded, `
      + `${result.failures.length} failed`);
  }
  return result;
}

/**
 * One line per project the repair acted on, or will act on, or leaves OPEN — the same line for a run and
 * for its prediction, so the deploy report can set one beside the other; nothing for a project that is
 * DONE and has nothing open.
 */
export function repairLine(project: RegressionRepairProject, predicted = false): string | null {
  const tasks = project.tasks.map((task) => `${task.taskId} ${task.clause}`).join(', ');
  const head = `landing repair${predicted ? ' (predicted)' : ''}: project ${project.projectId}: `
    + `${project.tasks.length} task(s) measure nothing of their own (${tasks})`;
  const items = project.supersededItemIds.length > 0
    ? `; ${predicted ? 'will supersede' : 'superseded'} ${project.supersededItemIds.length} open item(s) `
      + `(${project.supersededItemIds.join(', ')})`
    : '';
  const toDone = project.statusBefore === ProjectStatus.OPEN && project.statusAfter === ProjectStatus.DONE;
  if (toDone) {
    const at = predicted ? 'at the start' : `at ${project.doneAgainAt?.toISOString() ?? 'this start'}`;
    return `${head}${items}; OPEN -> DONE: done again by derivation ${at}; original completion time not recorded`;
  }
  if (project.statusAfter === ProjectStatus.OPEN) {
    return `${head}${items}; stays OPEN: ${project.withheld.join(', ') || 'the owner\'s Reopen stands'}`;
  }
  return items ? `${head}${items}; project stays ${project.statusAfter ?? 'gone'}` : null;
}

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
import { derivedDoneRecord, NO_REOPEN_RECORD, readDerivedProjectStatusWrite } from './project-done-derived';
import { readDeliveredIdentity } from './project-integration-job';
import { prerequisiteLandedOtherwiseSql } from '../tasks/task-dependencies';
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
 *   2. each project in which one of them serves a criterion, and which is OPEN, is DONE again when the
 *      projection's own decision over it is to store DONE (`readDerivedProjectStatusWrite`, what every
 *      post-commit edge stores from) — recorded DERIVED, at the moment of this repair, by one
 *      compare-and-set that matches only an OPEN row and writes only DONE (`storeDoneOverOpen`). The
 *      original completion time is not restored: the projection that took DONE away cleared it, and
 *      nothing else recorded it.
 *
 * It writes no merge receipt, no identity, no task status and no criterion, sends no push, and wakes no
 * coordinator. An owner's record or Reopen press stands, as the projection itself makes it stand.
 *
 * ONE DIRECTION, AS A PROPERTY OF THE STATEMENT
 * ---------------------------------------------
 * The first reading only ever took DONE away, so undoing it only ever gives DONE back: the repair never
 * takes a project out of DONE, whatever its projection reads. The production dry run of 2026-11-20 found
 * four projects DONE by derivation since September and October whose projection reads not done for
 * reasons of their own — a task under a criterion still OPEN or FAILED, a criterion nobody serves, a
 * standard set nobody confirmed since it was edited, work only on the project branch — the same reasons
 * on the code that ran before the fix. The first version of this repair projected through
 * `refreshProjectDone`, which writes both directions by design, and would have stored OPEN over them at
 * the start. Their next post-commit edge re-derives them as it always did; that is not this repair's to
 * do or to undo. A task that serves no criterion moves no derivation, so a project whose misread tasks
 * serve none is not asked about at all.
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
 * only from OPEN to DONE — so a run over repaired rows writes nothing.
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
  /** Whether a task of these serves a criterion, so the repair asks the projection about the project at
   *  all. Without one, the project is left as it is whatever the projection reads. */
  projected: boolean;
  /** The OPEN items superseded by the fact (predicted: that will be). */
  supersededItemIds: string[];
  /** The row as read before (`project.status`, `project.done_by`); null when there is no such project. */
  statusBefore: string | null;
  doneByBefore: string | null;
  /** The row as read after this run; predicted: the row as the repair would leave it. */
  statusAfter: string | null;
  doneByAfter: string | null;
  /** When this run stored DONE; null when it did not (and in a prediction). */
  doneAgainAt: Date | null;
  /** What the projection withholds DONE for, read now — on a DONE project, why its stored DONE is stale
   *  against the facts; the repair leaves it DONE all the same. Empty when not projected in a run. */
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
    autoRunWhenReady: boolean; dispatchHold: boolean; projectStarted: boolean; projectPaused: boolean;
    /** Whether J9 holds it on this prerequisite today — true when nothing but the P-M1 fact releases it, so
     *  the fix changes what a start (or a Resume of its project) does with it. */
    heldTodayByJ9: boolean;
    /** Since when, as far as the rows say: the later of the line's start and the prerequisite's last finish. */
    heldSince: Date | null;
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

/**
 * The one test the repair and its prediction apply to a project they ask about: the row is OPEN and the
 * projection's own decision over it (`readDerivedProjectStatusWrite`) is to store DONE. Nothing else
 * returns a project to DONE here, and nothing here takes one out of DONE.
 */
export function returnsToDone(decision: {
  stored: { status: ProjectStatus } | null;
  write: ProjectStatus | null;
}): boolean {
  return decision.stored?.status === ProjectStatus.OPEN && decision.write === ProjectStatus.DONE;
}

/**
 * The repair's only write to a project: DONE over OPEN, recorded DERIVED with the projection's own record
 * (`derivedDoneRecord`), when `returnsToDone` says so. One compare-and-set on the row as it was read — its
 * status, which can only be OPEN here, and its record — so the statement itself stores nothing but DONE,
 * matches nothing but an OPEN row, and writes nothing over an owner's record or press, or a projection,
 * committed after the read. It sends no push and tells no coordinator.
 */
export async function storeDoneOverOpen(prisma: PrismaService, ownerId: string, projectId: string) {
  const decision = await readDerivedProjectStatusWrite(prisma, ownerId, projectId);
  if (!decision.stored || !returnsToDone(decision)) return { decision, wrote: false };
  const written = await prisma.project.updateMany({
    where: {
      id: projectId,
      ownerId,
      status: ProjectStatus.OPEN,
      doneBy: decision.stored.doneBy,
      doneAt: decision.stored.doneAt,
      reopenedAt: decision.stored.reopenedAt,
    },
    data: { ...derivedDoneRecord(decision.seal), ...NO_REOPEN_RECORD },
  });
  return { decision, wrote: written.count === 1 };
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
 * What a start would do now, read and not written: every project of the footprint, its row as it stands
 * and the row as the repair would leave it — DONE where `returnsToDone` holds, as it is everywhere else —
 * with what the projection withholds DONE for, its tasks and the clause each measures nothing by, and the
 * OPEN items that would be superseded. Also the identities the deploy-time pass would freeze first, which
 * the prediction does not follow — a start after a pass that froze some may repair more than this says.
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
           dependent."dispatch_hold" AS "dispatchHold",
           (project."started_at" IS NOT NULL) AS "projectStarted", (project."paused_at" IS NOT NULL) AS "projectPaused",
           NOT ${Prisma.raw(prerequisiteLandedOtherwiseSql('prerequisite'))} AS "heldTodayByJ9",
           GREATEST(
             (SELECT line."integration_started_at" FROM "project_codebase" line
               WHERE line."project_id" = prerequisite."project_id" AND line."slot" = 'primary'),
             (SELECT max(work."finished_at") FROM "session" work
               WHERE work."task_id" = prerequisite."id" AND work."starts_task_work" = true AND work."deleted_at" IS NULL)
           ) AS "heldSince"
      FROM "task_dependency" edge
      JOIN "task" dependent ON dependent."id" = edge."task_id"
      JOIN "task" prerequisite ON prerequisite."id" = edge."depends_on_task_id"
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
    const projected = tasks.some((task) => task.servesCriterion);
    const returned = projected && returnsToDone(decision);
    prediction.projects.push({
      projectId,
      title: decision.stored?.title ?? null,
      tasks,
      projected,
      items,
      supersededItemIds: items.map((item) => item.itemId),
      statusBefore: decision.stored?.status ?? null,
      doneByBefore: decision.stored?.doneBy ?? null,
      statusAfter: returned ? ProjectStatus.DONE : decision.stored?.status ?? null,
      doneByAfter: returned ? derivedDoneRecord(decision.seal).doneBy : decision.stored?.doneBy ?? null,
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
      const row = { status: true, doneBy: true, doneAt: true } as const;
      const before = await prisma.project.findFirst({ where: { id: projectId, ownerId }, select: row });
      const supersededItemIds = await withTransactionRetry(
        prisma,
        (tx) => supersedeFirstReadingItems(tx, { projectId, taskIds: tasks.map((task) => task.taskId) }),
        loggedRetry(logger, 'landingRegressionRepair.items'),
      );
      // Only a project in which a misread task serves a criterion: nothing else moves its derivation.
      const projected = tasks.some((task) => task.servesCriterion);
      const returned = projected ? await storeDoneOverOpen(prisma, ownerId, projectId) : null;
      const after = await prisma.project.findFirst({ where: { id: projectId, ownerId }, select: row });
      const repaired: RegressionRepairProject = {
        projectId,
        tasks,
        projected,
        supersededItemIds,
        statusBefore: before?.status ?? null,
        doneByBefore: before?.doneBy ?? null,
        statusAfter: after?.status ?? null,
        doneByAfter: after?.doneBy ?? null,
        doneAgainAt: returned?.wrote ? after?.doneAt ?? null : null,
        withheld: returned?.decision.derived.withheld ?? [],
      };
      result.projects.push(repaired);
      // A line for each project this run wrote something about; the summary counts every other one.
      if (repaired.doneAgainAt !== null || supersededItemIds.length > 0) log.log(repairLine(repaired));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failures.push({ projectId, error: message });
      log.error(`landing repair of project ${projectId} failed and is left for the next start: ${message}`);
    }
  }
  if (grouped.size > 0) {
    log.log(`${repairSummary(result.projects)}; ${result.failures.length} failed`);
  }
  return result;
}

/** Whether the repair returned this project to DONE: its own write in a run, its decision in a prediction. */
function returnedToDone(project: RegressionRepairProject, predicted: boolean): boolean {
  return predicted
    ? project.statusBefore === ProjectStatus.OPEN && project.statusAfter === ProjectStatus.DONE
    : project.doneAgainAt !== null;
}

/** A status as a line prints it: the column as read, and who recorded a DONE. */
function statusText(status: string | null, doneBy: string | null): string {
  if (status === null) return 'gone';
  return status === ProjectStatus.DONE && doneBy ? `${status} (${doneBy})` : status;
}

/**
 * One line for one project: its status as read from the row, then the status the repair leaves it in
 * (predicted: would leave it in) and why, the tasks it holds, and the open items superseded. The same line
 * for a run and for its prediction, so the deploy report can set one beside the other. A prediction prints
 * one for every project of the footprint; a run logs the projects it wrote something about, and its
 * summary counts the rest.
 */
export function repairLine(project: RegressionRepairProject, predicted = false): string {
  const from = statusText(project.statusBefore, project.doneByBefore);
  const to = statusText(project.statusAfter, project.doneByAfter);
  let why: string;
  if (returnedToDone(project, predicted)) {
    why = `done again by derivation ${predicted ? 'at the start' : `at ${project.doneAgainAt!.toISOString()}`}; `
      + 'original completion time not recorded';
  } else if (project.statusBefore !== project.statusAfter) {
    why = 'moved by another writer during this run: the repair writes nothing but DONE over OPEN';
  } else if (project.statusBefore === null) {
    why = 'unchanged: there is no such project';
  } else if (project.statusBefore === ProjectStatus.CANCELLED) {
    why = 'unchanged: a cancelled project is never projected';
  } else if (!project.projected) {
    why = 'unchanged: no task of these serves a criterion, so the repair does not project it';
  } else if (project.statusBefore === ProjectStatus.DONE) {
    why = project.withheld.length > 0
      ? `unchanged: the projection withholds DONE (${project.withheld.join(', ')}), and the repair never takes `
        + 'a project out of DONE'
      : 'unchanged: the projection reads DONE too';
  } else {
    why = project.withheld.length > 0
      ? `unchanged: the projection withholds DONE (${project.withheld.join(', ')})`
      : 'unchanged: the owner\'s Reopen stands';
  }
  const tasks = project.tasks
    .map((task) => `${task.taskId} ${task.clause}${task.servesCriterion ? '' : ' (serves no criterion)'}`)
    .join(', ');
  const items = project.supersededItemIds.length > 0
    ? `${predicted ? 'will supersede' : 'superseded'} ${project.supersededItemIds.length} open item(s) `
      + `(${project.supersededItemIds.join(', ')})`
    : `${predicted ? 'no open item to supersede' : 'no open item superseded'}`;
  return `landing repair${predicted ? ' (predicted)' : ''}: project ${project.projectId}: ${from} -> ${to}, ${why}; `
    + `${project.tasks.length} task(s) measure nothing of their own (${tasks}); ${items}`;
}

/**
 * The totals of a run or a prediction: every project of the footprint counted once, by where its status
 * went — returned to DONE; in a prediction, taken out of DONE, which the repair never does and the count
 * shows; left as it was, by status, with how many of the DONE ones the projection reads as not done; in a
 * run, moved by another writer meanwhile — and the open items superseded.
 */
export function repairSummary(projects: readonly RegressionRepairProject[], predicted = false): string {
  const ids = (rows: readonly RegressionRepairProject[]) =>
    rows.length > 0 ? ` (${rows.map((project) => project.projectId).join(', ')})` : '';
  const returned = projects.filter((project) => returnedToDone(project, predicted));
  const rest = projects.filter((project) => !returnedToDone(project, predicted));
  const unchanged = rest.filter((project) => project.statusBefore === project.statusAfter);
  const moved = rest.filter((project) => project.statusBefore !== project.statusAfter);
  const byStatus = new Map<string, number>();
  for (const project of unchanged) {
    const status = project.statusBefore ?? 'gone';
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }
  const staleDone = unchanged.filter((project) => project.statusBefore === ProjectStatus.DONE
    && project.withheld.length > 0).length;
  const items = projects.reduce((sum, project) => sum + project.supersededItemIds.length, 0);
  const outOfDone = moved.filter((project) => project.statusBefore === ProjectStatus.DONE);
  return `landing repair${predicted ? ' (predicted)' : ''}: ${projects.length} project(s) hold misread tasks; `
    + `${returned.length} OPEN -> DONE${ids(returned)}; `
    + `${predicted ? `${outOfDone.length} taken out of DONE${ids(outOfDone)}; ` : ''}`
    + `unchanged: ${[...byStatus].map(([status, count]) => `${count} ${status}`).join(', ') || 'none'}`
    + `${staleDone > 0 ? ` (${staleDone} of the DONE ones read not done by the projection, and stay DONE)` : ''}`
    + `${!predicted && moved.length > 0 ? `; ${moved.length} moved by another writer during this run${ids(moved)}` : ''}; `
    + `${items} open item(s) ${predicted ? 'will be superseded' : 'superseded'}`;
}

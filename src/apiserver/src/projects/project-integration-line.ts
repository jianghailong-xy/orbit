import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';
import {
  uuidToBase62,
  type ProjectIntegrationSettings as SharedProjectIntegrationSettings,
  type ProjectIntegrationView as SharedProjectIntegrationView,
  type ProjectListIntegration,
} from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import { branchName } from './project-criterion-landing';

/**
 * A code project's integration line: the branch the platform lands its finished tasks on
 * (`docs/project-integration-line-contract.md` §1).
 *
 * TWO LINES
 * ---------
 * `MAIN` lands a task straight on the project's upstream. `PROJECT_BRANCH` lands it on the
 * project's own branch, which reaches main later — with the owner's confirmation, or by itself when
 * the project's Automatic setting is on and the branch's check is clean (§3.3 M-T11). Which one
 * a project has is not a column: it is whether the binding's `integration_ref` equals its
 * `upstream_ref`, so the two cannot disagree.
 *
 * WHO DECIDES, AND WHEN
 * ---------------------
 * The account owner may choose (L1, L5) — through `PATCH /projects/:id/integration` or a project
 * update, never from inside an agent session. Nobody has to: a project nobody chose for is decided
 * by the default rule at its FIRST integration, inside the transaction that queues it, and not a
 * moment earlier (L2, L3). Earlier the rule would be guessing from a plan that is still being
 * written; at the first integration the tasks and their dependencies are the ones the work is
 * actually made of.
 *
 * THE LOCK
 * --------
 * The first integration writes `integration_started_at`, and from then on the line does not move
 * (L4): work has landed on it, and a switch would strand that work on a branch nothing integrates
 * into any more. `configureProjectIntegration` refuses a switch with 409 `INTEGRATION_LINE_LOCKED`;
 * migration 0270's trigger refuses the same write from anybody else. What does not move the line —
 * the merge check — stays the owner's to change.
 *
 * WHERE IT IS STORED
 * ------------------
 * The project's primary `project_codebase` row. Never `workspace.defaultMergeTarget`, which is the
 * shared workspace's Merge-menu preference and not any one project's decision (PSC SR2).
 */

export type IntegrationLine = 'MAIN' | 'PROJECT_BRANCH';
export type IntegrationRefSource = 'EXPLICIT' | 'DEFAULT_RULE';

/**
 * A project's upstream until its owner says otherwise. Never probed: the API server has no
 * repository to ask, and falling back to `master` would be a convention of one repository in a
 * product that is about all of them (L6).
 */
export const DEFAULT_UPSTREAM_REF = 'refs/heads/main';

/**
 * The default rule (L2): a project whose code tasks depend on one another goes through a project
 * branch, and anything else goes straight to main.
 *
 * Only the edges count, and only those with both ends among the code tasks: one task, or several
 * that do not wait on each other, have nothing a shared branch would hold together. It reads no
 * title and no description — "this is an urgent fix" is the owner's choice to state, not a guess.
 */
export function defaultIntegrationLine(
  codeTasks: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<{ taskId: string; dependsOnTaskId: string }>,
): IntegrationLine {
  const inScope = new Set(codeTasks.map((task) => task.id));
  return edges.some((edge) => inScope.has(edge.taskId) && inScope.has(edge.dependsOnTaskId))
    ? 'PROJECT_BRANCH'
    : 'MAIN';
}

/** A project's own branch, named after its public id — the spelling every client shows (A-Q1). */
export function projectBranchRef(projectId: string): string {
  return `refs/heads/project/${uuidToBase62(projectId)}`;
}

/**
 * A remote URL as repository identity (PSC SR36): trimmed, scheme and host lower-cased, any
 * `user@` dropped, the scp form `git@host:owner/repo` spelled as `ssh://host/owner/repo`, and no
 * trailing `/` or `.git`. Used to compare and to satisfy `project_codebase_canonical_url_chk`, never
 * to clone. Null when nothing is left.
 */
export function canonicalRepoUrl(raw: string): string | null {
  let url = raw.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(\S+)$/.exec(url);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `ssh://${scp[1]}/${scp[2]}`;
  const remote = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/]*)(.*)$/i.exec(url);
  if (remote) url = `${remote[1]!.toLowerCase()}://${remote[2]!.toLowerCase()}${remote[3]}`;
  for (let trimmed = url.replace(/\/+$/, '').replace(/\.git$/, ''); trimmed !== url;
    trimmed = url.replace(/\/+$/, '').replace(/\.git$/, '')) {
    url = trimmed;
  }
  return url === '' ? null : url;
}

/** The columns of a binding this module reads and serves. */
const LINE_COLUMNS = {
  id: true,
  upstreamRef: true,
  integrationRef: true,
  integrationRefSource: true,
  integrationStartedAt: true,
  mergeCheckCommand: true,
  mergeCheckTimeoutSeconds: true,
} satisfies Prisma.ProjectCodebaseSelect;

export type ProjectCodebaseLine = Prisma.ProjectCodebaseGetPayload<{ select: typeof LINE_COLUMNS }>;

/** A project's primary binding, as this module needs it. One statement. */
export function readProjectCodebase(
  prisma: Pick<PrismaService, 'projectCodebase'>,
  projectId: string,
): Promise<ProjectCodebaseLine | null> {
  return prisma.projectCodebase.findFirst({
    where: { projectId, slot: 'primary' },
    select: LINE_COLUMNS,
  });
}

/**
 * The line every one of these projects lands on, for the list rows (§7.1 V1). One statement,
 * bounded by the page: a binding is joined by `(project_id, slot)`, the unique key that gives each
 * project at most one primary row.
 *
 * Read through `decidedLine` rather than as a SQL predicate, because "which line is this project
 * on" has exactly one definition and it already lives here — a second one written in SQL would be
 * a second answer to a question the settings card and the merge check both ask.
 *
 * A project whose binding states no line is absent from the map, not present with a null: a row
 * that has not decided is not one that decided main (§7.1 V1).
 */
export async function readProjectIntegrationLines(
  prisma: Pick<PrismaService, 'projectCodebase'>,
  projectIds: readonly string[],
): Promise<Map<string, ProjectListIntegration>> {
  if (projectIds.length === 0) return new Map();
  const rows = await prisma.projectCodebase.findMany({
    where: { projectId: { in: [...projectIds] }, slot: 'primary' },
    select: { ...LINE_COLUMNS, projectId: true },
  });
  const lines = new Map<string, ProjectListIntegration>();
  for (const row of rows) {
    const line = decidedLine(row);
    if (!line) continue;
    lines.set(row.projectId, { line, ref: branchName(row.integrationRef) });
  }
  return lines;
}

/** How long this project's exception items wait on its coordinator before they are the owner's. */
async function escalationWindow(
  db: Pick<Prisma.TransactionClient, 'project'>,
  projectId: string,
): Promise<number> {
  const row = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { exceptionEscalationSeconds: true },
  });
  return row.exceptionEscalationSeconds;
}

/** The line a binding states, when somebody decided it: the owner, or the default rule at the start. */
function decidedLine(row: ProjectCodebaseLine): IntegrationLine | null {
  if (row.integrationRefSource !== 'EXPLICIT' && !row.integrationStartedAt) return null;
  return row.integrationRef === row.upstreamRef ? 'MAIN' : 'PROJECT_BRANCH';
}

/**
 * What the project document carries about the line (contract §1.6): the settings half, which is the
 * one thing §1.4 lets into `ProjectsService.get` — it is already reading the binding row to decide
 * what "landed" means, so this costs the document nothing.
 *
 * The declaration itself lives in `@orbit/shared` (§7.0): the web and OrbitKit read these same
 * fields, and a second copy of a closed set like `IntegrationLine` is a client drawing a line the
 * server never described.
 */
export type ProjectIntegrationSettingsView = SharedProjectIntegrationSettings<Date>;

/** The settings plus what the queue has done with them — what `GET /projects/:id/integration`
 *  answers (§1.6), and the five facts the project page's line row is drawn from. */
export type ProjectIntegrationView = SharedProjectIntegrationView<Date>;

export function projectIntegrationView(
  row: ProjectCodebaseLine | null,
  escalationSeconds: number,
): ProjectIntegrationSettingsView {
  const line = row ? decidedLine(row) : null;
  return {
    line,
    lineAbsentReason: line ? null : 'NOT_DECIDED',
    ref: row && line ? branchName(row.integrationRef) : null,
    upstreamRef: row ? branchName(row.upstreamRef) : null,
    source: row && line ? (row.integrationRefSource as IntegrationRefSource) : null,
    locked: !!row?.integrationStartedAt,
    startedAt: row?.integrationStartedAt ?? null,
    mergeCheckCommand: row?.mergeCheckCommand ?? null,
    mergeCheckCommandAbsentReason: row?.mergeCheckCommand ? null : 'NOT_CONFIGURED',
    mergeCheckTimeoutSeconds: row?.mergeCheckTimeoutSeconds ?? null,
    escalationSeconds,
  };
}

/**
 * The settings, plus what the integration queue has done with them (§1.6).
 *
 * Two statements on top of the binding the caller already read, and they are the reason this is its
 * own endpoint rather than four more fields on the project document: `project-get-query-count`
 * holds that document to a budget, and the row that reads this polls.
 *
 * Every absence names its reason. A project whose first job has not finished is not one that is
 * zero commits ahead, and a project that has never absorbed main is not one that synced at the
 * epoch — printed as numbers, both would read as "nothing has happened here", which is the one
 * thing the row must not say about work that has.
 */
export async function readProjectIntegrationView(
  prisma: Pick<PrismaService, '$queryRaw'>,
  projectId: string,
  settings: ProjectIntegrationSettingsView,
): Promise<ProjectIntegrationView> {
  const [counts] = await prisma.$queryRaw<Array<{ integrating: number; queued: number }>>(Prisma.sql`
    SELECT (count(*) FILTER (WHERE "state" = 'RUNNING'))::int AS "integrating",
           (count(*) FILTER (WHERE "state" = 'QUEUED'))::int AS "queued"
      FROM "project_integration_job"
     WHERE "project_id" = ${projectId}::uuid`);
  // The newest FINISHED landing attempt, which is what "the tip" means: how far ahead it left the
  // line, and whether the check that ran on it passed. A job still running describes no tip yet.
  const [newest] = await prisma.$queryRaw<Array<{
    state: string; aheadOfUpstream: number | null;
  }>>(Prisma.sql`
    SELECT "state", "ahead_of_upstream" AS "aheadOfUpstream"
      FROM "project_integration_job"
     WHERE "project_id" = ${projectId}::uuid
       AND "kind" = 'LAND_TASK'
       AND "finished_at" IS NOT NULL
     ORDER BY "finished_at" DESC, "id" DESC
     LIMIT 1`);
  const [synced] = await prisma.$queryRaw<Array<{ at: Date }>>(Prisma.sql`
    SELECT "finished_at" AS "at"
      FROM "project_integration_job"
     WHERE "project_id" = ${projectId}::uuid
       AND "state" = 'LANDED'
       AND "main_sync_sha" IS NOT NULL
     ORDER BY "finished_at" DESC, "id" DESC
     LIMIT 1`);
  // The oldest job in flight, which is the one the two counts above are waiting on and the one the
  // Work overview card's live line names. Not filtered by kind, deliberately: it is the same rows
  // the counts count, so the line and the numbers can never be about different sets of jobs.
  //
  // Its clock starts at the claim for a running job and at the enqueue for a queued one — a QUEUED
  // job has never been claimed, so the two spellings are one COALESCE and no job reports the age of
  // the wrong wait. `id` breaks a tie between two jobs created in the same millisecond; uuid v7
  // sorts by time.
  const [oldest] = await prisma.$queryRaw<Array<{
    state: string; taskTitle: string | null; startedAt: Date;
  }>>(Prisma.sql`
    SELECT j."state",
           t."title" AS "taskTitle",
           COALESCE(j."claimed_at", j."created_at") AS "startedAt"
      FROM "project_integration_job" j
      LEFT JOIN "task" t ON t."id" = j."task_id"
     WHERE j."project_id" = ${projectId}::uuid
       AND j."state" IN ('RUNNING', 'QUEUED')
     ORDER BY COALESCE(j."claimed_at", j."created_at") ASC, j."id" ASC
     LIMIT 1`);

  const ahead = newest?.aheadOfUpstream ?? null;
  return {
    ...settings,
    commitsAheadOfUpstream: ahead,
    commitsAheadOfUpstreamAbsentReason: ahead === null ? 'NO_LANDING_YET' : null,
    lastUpstreamSyncAt: synced?.at ?? null,
    lastUpstreamSyncAbsentReason: synced ? null : 'NEVER_SYNCED',
    integratingCount: counts?.integrating ?? 0,
    queuedCount: counts?.queued ?? 0,
    mergeCheckOnTip: mergeCheckOnTip(newest?.state ?? null),
    inFlight: oldest
      ? {
        taskTitle: oldest.taskTitle,
        state: oldest.state === 'RUNNING' ? 'RUNNING' : 'QUEUED',
        startedAt: oldest.startedAt,
      }
      : null,
  };
}

/** What the newest finished landing says about the line's tip (§1.6). Anything that did not run
 *  its checks to a verdict — a conflict, an error, a cancellation — leaves the tip UNKNOWN rather
 *  than failing: nothing was tested, so nothing failed. */
function mergeCheckOnTip(state: string | null): 'PASSING' | 'FAILING' | 'UNKNOWN' {
  if (state === 'LANDED' || state === 'ALREADY_LANDED') return 'PASSING';
  if (state === 'CHECK_FAILED') return 'FAILING';
  return 'UNKNOWN';
}

/** What a request may set (L5). Each field is written only when sent; null clears the merge check. */
export interface IntegrationSettings {
  line?: IntegrationLine;
  /** A full `refs/heads/…` ref; sending one chooses `PROJECT_BRANCH`. */
  projectBranchName?: string;
  /** A full `refs/heads/…` ref. */
  upstreamRef?: string;
  mergeCheckCommand?: string | null;
  mergeCheckTimeoutSeconds?: number | null;
  /** This project's escalation window in seconds (§4.6). The column's CHECK bounds it, 300 to a week. */
  exceptionEscalationSeconds?: number;
}

/** The binding, locked for the rest of this transaction. Rank 55: after `task`, before its children. */
async function lockCodebase(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<ProjectCodebaseLine | null> {
  const [row] = await tx.$queryRaw<ProjectCodebaseLine[]>(Prisma.sql`
    SELECT "id", "upstream_ref" AS "upstreamRef", "integration_ref" AS "integrationRef",
           "integration_ref_source" AS "integrationRefSource",
           "integration_started_at" AS "integrationStartedAt",
           "merge_check_command" AS "mergeCheckCommand",
           "merge_check_timeout_seconds" AS "mergeCheckTimeoutSeconds"
      FROM "project_codebase"
     WHERE "project_id" = ${projectId}::uuid AND "slot" = 'primary'
       FOR UPDATE`);
  return row ?? null;
}

/**
 * Bind a project to its repository, standing on the upstream until a line is decided. A concurrent
 * binder may have won: the insert then does nothing, and the caller locks the row that one left.
 */
async function bind(
  tx: Prisma.TransactionClient,
  binding: { ownerId: string; projectId: string; canonicalRepoUrl: string },
): Promise<ProjectCodebaseLine> {
  await tx.projectCodebase.createMany({
    data: [{
      ownerId: binding.ownerId,
      projectId: binding.projectId,
      canonicalRepoUrl: binding.canonicalRepoUrl,
      upstreamRef: DEFAULT_UPSTREAM_REF,
      integrationRef: DEFAULT_UPSTREAM_REF,
      refAuthority: 'REMOTE',
      remoteName: 'origin',
    }],
    skipDuplicates: true,
  });
  return (await lockCodebase(tx, binding.projectId))!;
}

function repositoryUnknown(message: string): ConflictException {
  return new ConflictException({ statusCode: 409, code: 'INTEGRATION_REPOSITORY_UNKNOWN', message });
}

/** The repository a project with no binding yet would be bound to: the one its coordination
 *  workspace names, canonicalised — or null when that workspace names none. */
async function coordinationRepository(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
): Promise<string | null> {
  const [workspace] = await tx.$queryRaw<Array<{ repoUrl: string | null }>>(Prisma.sql`
    SELECT w."repo_url" AS "repoUrl"
      FROM "project" p
      LEFT JOIN "workspace" w ON w."id" = p."coordinator_workspace_id"
     WHERE p."id" = ${projectId}::uuid AND p."owner_id" = ${ownerId}::uuid`);
  return workspace?.repoUrl ? canonicalRepoUrl(workspace.repoUrl) : null;
}

/**
 * The repository this project integrates into, canonical: its binding's, or — before it has one —
 * the one its coordination workspace names. Null when neither names one, which is the project a
 * start refuses a project branch and a merge check for (`startProjectLine`).
 */
export async function projectRepository(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
): Promise<string | null> {
  const bound = await tx.projectCodebase.findFirst({
    where: { projectId, slot: 'primary' },
    select: { canonicalRepoUrl: true },
  });
  return bound?.canonicalRepoUrl ?? coordinationRepository(tx, ownerId, projectId);
}

/**
 * The account owner's integration settings, applied under the binding's lock (L-T1, L-T2, L-T5).
 *
 * A participant: the caller owns the transaction, has already established that the project is the
 * owner's, and — when it also holds the project row — took it first (rank 40 before this 55).
 * With no binding yet, the repository is the one the project's coordination workspace names.
 */
export async function configureProjectIntegration(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; projectId: string; settings: IntegrationSettings },
): Promise<ProjectIntegrationSettingsView> {
  const { ownerId, projectId, settings } = input;
  if (Object.values(settings).every((value) => value === undefined)) {
    throw new BadRequestException('name at least one integration setting to change');
  }
  if (settings.line === 'MAIN' && settings.projectBranchName !== undefined) {
    throw new BadRequestException('a project that integrates straight into main has no project branch to name');
  }

  // The escalation window is the PROJECT's column, not the binding's (§4.1): it says how long a
  // person waits, and a project with no code at all still has exceptions waiting on somebody. So it
  // is written first and on its own terms — a request that names only this one asks nothing of the
  // repository, and answers without binding the project to one. It is not locked when integration
  // starts either (L4), because nothing about the line it landed on is decided here.
  if (settings.exceptionEscalationSeconds !== undefined) {
    await tx.project.updateMany({
      where: { id: projectId, ownerId },
      data: { exceptionEscalationSeconds: settings.exceptionEscalationSeconds },
    });
  }
  // `!== undefined` rather than a falsy test, because `null` is a setting: it clears the merge check.
  const bindingNamed = settings.line !== undefined
    || settings.projectBranchName !== undefined
    || settings.upstreamRef !== undefined
    || settings.mergeCheckCommand !== undefined
    || settings.mergeCheckTimeoutSeconds !== undefined;
  if (!bindingNamed) {
    return projectIntegrationView(
      await readProjectCodebase(tx, projectId),
      await escalationWindow(tx, projectId),
    );
  }

  let row = await lockCodebase(tx, projectId);
  if (!row) {
    const repository = await coordinationRepository(tx, ownerId, projectId);
    if (!repository) {
      throw repositoryUnknown('this project has no repository to integrate into: its coordination '
        + 'workspace has no recorded remote. Wait for the runner to detect origin, or set Repository '
        + 'URL in the workspace settings.');
    }
    row = await bind(tx, { ownerId, projectId, canonicalRepoUrl: repository });
  }

  const decided = decidedLine(row);
  const chosen: IntegrationLine | undefined =
    settings.projectBranchName !== undefined ? 'PROJECT_BRANCH' : settings.line;
  const upstreamRef = settings.upstreamRef ?? row.upstreamRef;
  const integrationRef = (chosen ?? decided) === 'PROJECT_BRANCH'
    ? settings.projectBranchName
      ?? (decided === 'PROJECT_BRANCH' ? row.integrationRef : projectBranchRef(projectId))
    // MAIN, or not decided yet: the line stands on the upstream until the default rule moves it.
    : upstreamRef;
  if ((chosen ?? decided) === 'PROJECT_BRANCH' && integrationRef === upstreamRef) {
    throw new BadRequestException('a project branch cannot be the upstream it integrates into');
  }
  if (row.integrationStartedAt
    && (integrationRef !== row.integrationRef || upstreamRef !== row.upstreamRef)) {
    throw new ConflictException({
      statusCode: 409,
      code: 'INTEGRATION_LINE_LOCKED',
      message: `this project started integrating into ${branchName(row.integrationRef)} at `
        + `${row.integrationStartedAt.toISOString()}, so its integration line can no longer change. `
        + 'To change it, merge the project branch into main or abandon it first.',
    });
  }

  const written = await tx.projectCodebase.update({
    where: { id: row.id },
    data: {
      upstreamRef,
      integrationRef,
      ...(chosen ? { integrationRefSource: 'EXPLICIT' } : {}),
      ...(settings.mergeCheckCommand !== undefined
        ? { mergeCheckCommand: settings.mergeCheckCommand?.trim() || null }
        : {}),
      ...(settings.mergeCheckTimeoutSeconds !== undefined
        ? { mergeCheckTimeoutSeconds: settings.mergeCheckTimeoutSeconds }
        : {}),
    },
    select: LINE_COLUMNS,
  });
  return projectIntegrationView(written, await escalationWindow(tx, projectId));
}

/**
 * The session that did a code task's work, when the task is one (§1.1 `isCodeTask`): filed under a
 * project, not codeless, and its latest work session ran in a worktree on a branch.
 */
async function codeTaskWork(
  db: Pick<Prisma.TransactionClient, 'task'>,
  ownerId: string,
  taskId: string,
): Promise<{ repoUrl: string | null } | null> {
  const task = await db.task.findFirst({
    where: { id: taskId, ownerId },
    select: {
      projectId: true,
      codeless: true,
      sessions: {
        where: { startsTaskWork: true, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { isolationStatus: true, branch: true, workspace: { select: { repoUrl: true } } },
      },
    },
  });
  const work = task?.sessions[0];
  if (!task?.projectId || task.codeless || work?.isolationStatus !== 'worktree' || !work.branch) {
    return null;
  }
  return { repoUrl: work.workspace?.repoUrl ?? null };
}

/**
 * The default rule (L2) over this project's code tasks and their dependencies as they stand now:
 * the one reading of it, for the first integration and for a start that was given no line.
 */
export async function projectDefaultLine(
  db: Pick<Prisma.TransactionClient, 'task' | 'taskDependency'>,
  projectId: string,
): Promise<IntegrationLine> {
  const codeTasks = await db.task.findMany({
    where: { projectId, codeless: false, status: { not: TaskStatus.CANCELLED } },
    select: { id: true },
  });
  const ids = codeTasks.map((task) => task.id);
  const edges = await db.taskDependency.findMany({
    where: { taskId: { in: ids }, dependsOnTaskId: { in: ids } },
    select: { taskId: true, dependsOnTaskId: true },
  });
  return defaultIntegrationLine(codeTasks, edges);
}

/** The line half of a start's settings — what `startProjectLine` is asked for and answers with. */
export interface StartLineSettings {
  line: IntegrationLine;
  /** A full `refs/heads/…` ref, only with `PROJECT_BRANCH`. */
  projectBranchName?: string;
  mergeCheckCommand: string | null;
}

/**
 * The line a start would give a project whose owner chose nothing (`POST
 * /projects/:id/acceptance/confirmation` on a project not yet started): the line it is already on
 * or the owner already chose, if either; else the default rule over its tasks as they stand — and
 * `MAIN` for a project with no repository, where no project branch can exist. The merge check it
 * already has, if any.
 */
export async function defaultStartLine(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
): Promise<StartLineSettings> {
  const row = await readProjectCodebase(tx, projectId);
  const mergeCheckCommand = row?.mergeCheckCommand ?? null;
  const decided = row ? decidedLine(row) : null;
  if (row && decided) {
    return decided === 'PROJECT_BRANCH'
      ? { line: decided, projectBranchName: row.integrationRef, mergeCheckCommand }
      : { line: decided, mergeCheckCommand };
  }
  if (!row && !(await coordinationRepository(tx, ownerId, projectId))) {
    return { line: 'MAIN', mergeCheckCommand };
  }
  return { line: await projectDefaultLine(tx, projectId), mergeCheckCommand };
}

/**
 * A start's line and merge check, applied under the binding's lock (rank 55) as the owner's choice.
 *
 * A participant, like `configureProjectIntegration`, which does the writing: the caller owns the
 * transaction and holds the project row. Three ways it goes:
 *
 *   * THE LINE HAS STARTED. It is locked (L4), so the start leaves it where it is and writes only the
 *     merge check, and says so — `locked`, with the line the project is actually on.
 *   * THERE IS NO REPOSITORY. A project with no binding whose coordination workspace names no remote
 *     has nothing a line or a check could be recorded on, and nothing ever lands on a branch of it.
 *     A start that asks for `MAIN` and no check asks nothing of it and writes nothing; one asking for
 *     a project branch or a merge check is refused, 409 `INTEGRATION_REPOSITORY_UNKNOWN`, because
 *     writing the rest of the start without them would drop what the owner chose.
 *   * OTHERWISE the line is written `EXPLICIT` — binding the project first when it has no binding —
 *     together with the merge check.
 *
 * Answers with the line and check as they stand once it is done.
 */
export async function startProjectLine(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; projectId: string; settings: StartLineSettings },
): Promise<StartLineSettings & { locked: boolean }> {
  const { ownerId, projectId, settings } = input;
  const mergeCheckCommand = settings.mergeCheckCommand?.trim() || null;
  const row = await lockCodebase(tx, projectId);
  const locked = !!row?.integrationStartedAt;
  if (!row && !(await coordinationRepository(tx, ownerId, projectId))) {
    if (settings.line === 'PROJECT_BRANCH' || mergeCheckCommand !== null) {
      throw repositoryUnknown('this project has no repository to integrate into, so it can have '
        + 'neither a project branch nor a merge check: its coordination workspace has no recorded '
        + 'remote. Wait for the runner to detect origin, or set Repository URL in the workspace '
        + 'settings. A project without a repository can start on main with no merge check.');
    }
    return { line: 'MAIN', mergeCheckCommand: null, locked: false };
  }
  await configureProjectIntegration(tx, {
    ownerId,
    projectId,
    settings: locked
      ? { mergeCheckCommand }
      : {
        line: settings.line,
        ...(settings.line === 'PROJECT_BRANCH' && settings.projectBranchName !== undefined
          ? { projectBranchName: settings.projectBranchName }
          : {}),
        mergeCheckCommand,
      },
  });
  const written = (await readProjectCodebase(tx, projectId))!;
  const line = decidedLine(written)!;
  const stands = { mergeCheckCommand: written.mergeCheckCommand, locked };
  return line === 'PROJECT_BRANCH'
    ? { line, projectBranchName: written.integrationRef, ...stands }
    : { line, ...stands };
}

/** Whether a task is code work the platform integrates (§1.1), read only from committed rows. */
export async function isCodeTask(
  db: Pick<Prisma.TransactionClient, 'task'>,
  ownerId: string,
  taskId: string,
): Promise<boolean> {
  return (await codeTaskWork(db, ownerId, taskId)) !== null;
}

/** Whether a project has started integrating (§1.1 `lineStarted`), which is also what locks its line. */
export async function lineStarted(
  db: Pick<Prisma.TransactionClient, 'projectCodebase'>,
  projectId: string,
): Promise<boolean> {
  const started = await db.projectCodebase.count({
    where: { projectId, slot: 'primary', integrationStartedAt: { not: null } },
  });
  return started > 0;
}

export type FirstIntegration =
  | {
      started: true;
      line: IntegrationLine;
      integrationRef: string;
      upstreamRef: string;
      source: IntegrationRefSource;
      startedAt: Date;
    }
  | { started: false; refusal: 'INTEGRATION_REPOSITORY_UNKNOWN' };

/**
 * Start a project's integration line, inside the transaction that queues its first integration
 * (L3, L-T3, L-T4). Idempotent: a line that already started is returned as it stands.
 *
 * With no binding, the repository is the one the integrated code task's session worked in, and a
 * task with no such repository is refused rather than bound to a guess. A line nobody chose is
 * decided here by the default rule, over the project's code tasks as they stand at this moment,
 * and never again.
 *
 * What L3 also asks of this transaction — queueing the project's other finished code tasks onto
 * the line that just started — is the caller's: it owns the integration queue.
 */
export async function startOnFirstIntegration(
  tx: Prisma.TransactionClient,
  first: { ownerId: string; projectId: string; taskId: string },
): Promise<FirstIntegration> {
  let row = await lockCodebase(tx, first.projectId);
  if (!row) {
    const work = await codeTaskWork(tx, first.ownerId, first.taskId);
    const repository = work?.repoUrl ? canonicalRepoUrl(work.repoUrl) : null;
    if (!repository) return { started: false, refusal: 'INTEGRATION_REPOSITORY_UNKNOWN' };
    row = await bind(tx, { ownerId: first.ownerId, projectId: first.projectId, canonicalRepoUrl: repository });
  }

  if (!row.integrationStartedAt) {
    let integrationRef = row.integrationRef;
    if (row.integrationRefSource !== 'EXPLICIT') {
      integrationRef = await projectDefaultLine(tx, first.projectId) === 'PROJECT_BRANCH'
        ? projectBranchRef(first.projectId)
        : row.upstreamRef;
    }
    row = await tx.projectCodebase.update({
      where: { id: row.id },
      data: { integrationRef, integrationStartedAt: new Date() },
      select: LINE_COLUMNS,
    });
  }

  return {
    started: true,
    line: row.integrationRef === row.upstreamRef ? 'MAIN' : 'PROJECT_BRANCH',
    integrationRef: row.integrationRef,
    upstreamRef: row.upstreamRef,
    source: row.integrationRefSource as IntegrationRefSource,
    startedAt: row.integrationStartedAt!,
  };
}

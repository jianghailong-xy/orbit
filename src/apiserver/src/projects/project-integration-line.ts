import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';
import {
  uuidToBase62,
  type ProjectBranchCandidates,
  type ProjectIntegrationSettings as SharedProjectIntegrationSettings,
  type ProjectIntegrationView as SharedProjectIntegrationView,
  type ProjectLastMainBranch,
  type ProjectListIntegration,
  type ProjectIntegrationJob,
  type IntegrationJobKind,
  type IntegrationJobPhase,
} from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import { branchName } from './project-criterion-landing';
import { IntegrationCheckSource, integrationJobLimitSeconds } from './project-integration-job';
import { readProjectLandTaskViews } from './project-task-integration';

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
 * A project's upstream when its owner has never said otherwise for its repository. Never probed:
 * the API server has no repository to ask, and falling back to `master` would be a convention of one
 * repository in a product that is about all of them (L6). What the owner HAS said is remembered
 * instead: a new binding starts from their last choice for the same repository (`bind`).
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

/**
 * A repository as a person names it: the last two segments of its canonical URL, so
 * `ssh://github.com/acme/payments-api` is `acme/payments-api`. For showing only — identity is the
 * canonical URL.
 */
export function repositoryShortName(canonical: string): string {
  return canonical.split('/').filter((segment) => segment !== '').slice(-2).join('/');
}

/** The columns of a binding this module reads and serves. */
const LINE_COLUMNS = {
  id: true,
  upstreamRef: true,
  upstreamRefChosenAt: true,
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
): Promise<Map<string, ProjectListIntegration<Date>>> {
  const lines = new Map<string, ProjectListIntegration<Date>>();
  for (const [projectId, { integration }] of await readProjectListBindings(prisma, projectIds)) {
    if (integration) lines.set(projectId, integration);
  }
  return lines;
}

/** What a list row reads off a project's binding: its line, null until somebody decided one, and
 *  its main branch by name, which it has either way. */
export interface ProjectListBinding {
  integration: ProjectListIntegration<Date> | null;
  mainBranch: string;
}

/**
 * The statement behind `readProjectIntegrationLines`, for the rows that also name the project's
 * main branch (`mainBranch` on `GET /projects` and `GET /projects/sidebar`). A project with no
 * binding is absent: it has no repository, and its row's words say main.
 */
export async function readProjectListBindings(
  prisma: Pick<PrismaService, 'projectCodebase'>,
  projectIds: readonly string[],
): Promise<Map<string, ProjectListBinding>> {
  if (projectIds.length === 0) return new Map();
  const rows = await prisma.projectCodebase.findMany({
    where: { projectId: { in: [...projectIds] }, slot: 'primary' },
    select: {
      ...LINE_COLUMNS,
      projectId: true,
      _count: { select: { integrationJobs: { where: { state: { in: ['QUEUED', 'RUNNING'] } } } } },
      integrationJobs: {
        where: { state: { in: ['QUEUED', 'RUNNING'] } },
        select: {
          id: true, state: true, kind: true, phase: true, createdAt: true, claimedAt: true, heartbeatAt: true,
          task: { select: { title: true } },
        },
      },
    },
  });
  const bindings = new Map<string, ProjectListBinding>();
  for (const row of rows) {
    const binding: ProjectListBinding = { integration: null, mainBranch: branchName(row.upstreamRef) };
    bindings.set(row.projectId, binding);
    const line = decidedLine(row);
    if (!line) continue;
    const lead = oldestInFlight(row.integrationJobs ?? []);
    binding.integration = {
      line,
      ref: branchName(row.integrationRef),
      activeJobCount: row._count.integrationJobs,
      ...(lead ? {
        inFlight: {
          taskTitle: lead.task?.title ?? null,
          kind: lead.kind as IntegrationJobKind,
          phase: lead.phase as IntegrationJobPhase | null,
          state: lead.state === 'RUNNING' ? 'RUNNING' : 'QUEUED',
          startedAt: lead.claimedAt ?? lead.createdAt,
          heartbeatAt: lead.heartbeatAt,
          waitMs: claimedWaitMs({
            state: lead.state,
            startedAt: lead.claimedAt ?? lead.createdAt,
            queuedAt: lead.createdAt,
          }),
        },
      } : {}),
    };
  }
  return bindings;
}

/** `readProjectIntegrationView`'s ORDER BY over a project's active jobs, in memory: running first,
 *  then the oldest by claim-or-enqueue, `id` breaking a tie. */
function oldestInFlight<J extends { id: string; state: string; createdAt: Date; claimedAt: Date | null }>(
  jobs: readonly J[],
): J | null {
  const startedAt = (job: J) => (job.claimedAt ?? job.createdAt).getTime();
  return [...jobs].sort((a, b) =>
    Number(b.state === 'RUNNING') - Number(a.state === 'RUNNING')
    || startedAt(a) - startedAt(b) || a.id.localeCompare(b.id))[0] ?? null;
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
    upstreamChosenAt: row?.upstreamRefChosenAt ?? null,
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
 * The settings, plus what the integration queue has done with them (§1.6), and what the project's
 * main branch can be chosen from: its repository, the branches its coordination workspace reported,
 * and this account's last choice for that repository (L6).
 *
 * The queue facts are read on top of the binding the caller already read, which is why this is its
 * own endpoint rather than four more fields on the project document: `project-get-query-count`
 * holds that document to a budget, and the row that reads this polls.
 *
 * Every absence names its reason. A project whose first job has not finished is not one that is
 * zero commits ahead, and a project that has never absorbed main is not one that synced at the
 * epoch — printed as numbers, both would read as "nothing has happened here", which is the one
 * thing the row must not say about work that has.
 *
 * The caller has established that the project is the reader's: the reads added for the main branch
 * take the project's owner from its own row.
 */
export async function readProjectIntegrationView(
  prisma: Pick<PrismaService, '$queryRaw'>,
  projectId: string,
  settings: ProjectIntegrationSettingsView,
): Promise<ProjectIntegrationView> {
  const memory = await readMainBranchMemory(prisma, projectId);
  const branches = await readBranchCandidates(prisma, projectId);
  // The last finished attempt's checks may have failed on a tree that never landed. Keep its
  // verdict separate from the last successful landing's measured distance from upstream.
  const [newest] = await prisma.$queryRaw<Array<{
    checks: unknown; aheadOfUpstream: number | null;
  }>>(Prisma.sql`
    SELECT "checks",
           (SELECT landed."ahead_of_upstream"
              FROM "project_integration_job" landed
             WHERE landed."project_id" = ${projectId}::uuid
               AND landed."kind" = 'LAND_TASK'
               AND landed."state" IN ('LANDED', 'ALREADY_LANDED')
               AND landed."finished_at" IS NOT NULL
               AND landed."ahead_of_upstream" IS NOT NULL
             ORDER BY landed."finished_at" DESC, landed."id" DESC
             LIMIT 1) AS "aheadOfUpstream"
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
  const jobs = await readInFlightJobs(prisma, projectId);
  // Each current LAND_TASK through the task read model, so this page and the task's own describe
  // one landing in the same words (§2.7a).
  const landTasks = await readProjectLandTaskViews(prisma, projectId);

  const ahead = newest?.aheadOfUpstream ?? null;
  const lead = jobs[0];
  return {
    ...settings,
    lastMainBranch: lastMainBranchView(memory),
    repository: memory.repository ? repositoryShortName(memory.repository) : null,
    branches,
    commitsAheadOfUpstream: ahead,
    commitsAheadOfUpstreamAbsentReason: ahead === null ? 'NO_LANDING_YET' : null,
    lastUpstreamSyncAt: synced?.at ?? null,
    lastUpstreamSyncAbsentReason: synced ? null : 'NEVER_SYNCED',
    integratingCount: jobs.filter((job) => job.state === 'RUNNING').length,
    queuedCount: jobs.filter((job) => job.state === 'QUEUED').length,
    mergeCheckOnTip: lastLandingCheck(newest?.checks),
    landTasks,
    inFlight: lead
      ? {
        taskTitle: lead.taskTitle,
        kind: lead.kind,
        phase: lead.phase,
        state: lead.state,
        startedAt: lead.startedAt,
        heartbeatAt: lead.heartbeatAt,
        waitMs: claimedWaitMs(lead),
      }
      : null,
    inFlightJobs: jobs,
  };
}

/** A project's repository and this account's last choice of main branch for it (L6). */
export interface MainBranchMemory {
  /** Canonical: the binding's, or before there is one, the coordination workspace's. */
  repository: string | null;
  /** The newest choice of the owner's for that repository, as `rememberedUpstreamRef` reads it. */
  last: { upstreamRef: string; chosenAt: Date } | null;
}

/**
 * A project's repository and the owner's last choice of main branch for it, in one statement keyed
 * by the project alone — so the project document can spend exactly one on it, issued beside its
 * other reads (`project-get-query-count.pg.spec.ts`).
 *
 * A bound project's repository is its binding's, and the choice is read for that URL the way
 * `rememberedUpstreamRef` reads it: the newest row of the same owner and repository that has one.
 * An unbound project's repository is its coordination workspace's remote, which is canonical only
 * once `canonicalRepoUrl` has read it — so for that project the statement answers the owner's
 * newest choice for EACH repository they ever chose for, a row apiece, and the one for this
 * repository is picked here. That is bounded by the owner's repositories, never by their projects
 * or their work, and nothing is read when there is no repository to read for.
 */
export async function readMainBranchMemory(
  prisma: Pick<PrismaService, '$queryRaw'>,
  projectId: string,
): Promise<MainBranchMemory> {
  const rows = await prisma.$queryRaw<Array<{
    boundRepository: string | null;
    workspaceRepoUrl: string | null;
    chosenRepository: string | null;
    upstreamRef: string | null;
    chosenAt: Date | null;
  }>>(Prisma.sql`
    SELECT cb."canonical_repo_url" AS "boundRepository", w."repo_url" AS "workspaceRepoUrl",
           chosen."canonical_repo_url" AS "chosenRepository", chosen."upstream_ref" AS "upstreamRef",
           chosen."upstream_ref_chosen_at" AS "chosenAt"
      FROM "project" p
      LEFT JOIN "project_codebase" cb ON cb."project_id" = p."id" AND cb."slot" = 'primary'
      LEFT JOIN "workspace" w ON w."id" = p."coordinator_workspace_id"
      LEFT JOIN LATERAL (
        SELECT DISTINCT ON (c."canonical_repo_url")
               c."canonical_repo_url", c."upstream_ref", c."upstream_ref_chosen_at"
          FROM "project_codebase" c
         WHERE c."owner_id" = p."owner_id"
           AND c."upstream_ref_chosen_at" IS NOT NULL
           AND (CASE WHEN cb."canonical_repo_url" IS NOT NULL
                     THEN c."canonical_repo_url" = cb."canonical_repo_url"
                     ELSE NULLIF(btrim(w."repo_url"), '') IS NOT NULL END)
         ORDER BY c."canonical_repo_url", c."upstream_ref_chosen_at" DESC, c."id" DESC
      ) chosen ON true
     WHERE p."id" = ${projectId}::uuid`);
  const [first] = rows;
  const repository = first?.boundRepository
    ?? (first?.workspaceRepoUrl ? canonicalRepoUrl(first.workspaceRepoUrl) : null);
  const last = repository ? rows.find((row) => row.chosenRepository === repository) : undefined;
  return {
    repository,
    last: last?.upstreamRef && last.chosenAt
      ? { upstreamRef: last.upstreamRef, chosenAt: last.chosenAt }
      : null,
  };
}

/** `lastMainBranch` as every reader is served it: both names short, as a person reads them. */
export function lastMainBranchView(memory: MainBranchMemory): ProjectLastMainBranch<Date> | null {
  return memory.repository && memory.last
    ? {
      branch: branchName(memory.last.upstreamRef),
      repository: repositoryShortName(memory.repository),
      chosenAt: memory.last.chosenAt,
    }
    : null;
}

/** Orbit's own session branches, which are never anybody's main branch. */
const ORBIT_SESSION_BRANCHES = 'orbit/';

/**
 * The branches a project's main branch can be chosen from: the local branches the runner reported
 * for the newest session of the project's coordination workspace that reported any
 * (`session.merge_targets` — refreshed on every heartbeat while a session runs and once more when
 * it ends), without Orbit's `orbit/*` session branches and without this account's project branches.
 * `reportedAt` is when that session's row was last written, which is no earlier than the report.
 *
 * The account's project branches are the `integration_ref` of each binding of the project's owner
 * that differs from its `upstream_ref`: a line onto a project branch. A landing leaves that branch
 * behind in the coordination workspace's checkout, and it is never any project's main branch —
 * chosen, the project would merge into another project's branch. A line straight onto main has the
 * main branch itself for its `integration_ref`, so that branch stays, and so does a branch that is
 * only named `project/…`.
 *
 * Newest by creation rather than by last report, so the read walks the workspace's
 * `(workspace_id, created_at DESC)` index and stops at the first session with a report: the row
 * that reads this polls, and a coordination workspace can hold thousands of sessions, all of them
 * reporting the same repository. The account's project branches are read in the same statement,
 * once, through `project_codebase_owner_idx`, and each reported name is compared against them
 * there. Null when no session there has reported a branch, when none is left, or when the project
 * has no coordination workspace.
 */
export async function readBranchCandidates(
  prisma: Pick<PrismaService, '$queryRaw'>,
  projectId: string,
): Promise<ProjectBranchCandidates<Date> | null> {
  const [reported] = await prisma.$queryRaw<Array<{
    names: string[];
    workspaceName: string;
    reportedAt: Date;
  }>>(Prisma.sql`
    SELECT ARRAY(
             SELECT b."name"
               FROM unnest(s."merge_targets") WITH ORDINALITY AS b("name", "ord")
              WHERE ('refs/heads/' || b."name") <> ALL (ARRAY(
                      SELECT c."integration_ref"
                        FROM "project_codebase" c
                       WHERE c."owner_id" = p."owner_id"
                         AND c."integration_ref" <> c."upstream_ref"))
              ORDER BY b."ord") AS "names",
           w."name" AS "workspaceName", s."updated_at" AS "reportedAt"
      FROM "project" p
      JOIN "workspace" w ON w."id" = p."coordinator_workspace_id"
      JOIN LATERAL (
        SELECT s."merge_targets", s."updated_at"
          FROM "session" s
         WHERE s."workspace_id" = w."id"
           AND s."owner_id" = p."owner_id"
           AND s."deleted_at" IS NULL
           AND cardinality(s."merge_targets") > 0
         ORDER BY s."created_at" DESC, s."id" DESC
         LIMIT 1
      ) s ON true
     WHERE p."id" = ${projectId}::uuid`);
  if (!reported) return null;
  const names = reported.names.filter((name) => !name.startsWith(ORBIT_SESSION_BRANCHES));
  return names.length === 0
    ? null
    : { names, workspaceName: reported.workspaceName, reportedAt: reported.reportedAt };
}

/**
 * What a claimed job waited its turn, for the row's "Waited …"; null for one still queued, whose
 * whole elapsed time is that wait (its `startedAt` is the enqueue).
 *
 * The same measurement the task's own landing carries (`LandTaskIntegrationView.waitMs`), taken
 * from the same two instants: the clock a reader watches on this line counts from the claim, so
 * without this the minutes a job spent waiting for a runner read as minutes of work.
 */
function claimedWaitMs(job: { state: string; startedAt: Date; queuedAt: Date }): number | null {
  if (job.state !== 'RUNNING') return null;
  return Math.max(0, job.startedAt.getTime() - job.queuedAt.getTime());
}

/** One RUNNING or QUEUED job as `readInFlightJobs` reads it, before the limit is decided. */
interface InFlightJobRow extends IntegrationCheckSource {
  id: string;
  state: string;
  kind: IntegrationJobKind;
  phase: IntegrationJobPhase | null;
  generation: number;
  taskId: string | null;
  taskTitle: string | null;
  createdAt: Date;
  claimedAt: Date | null;
  heartbeatAt: Date | null;
  runnerName: string | null;
  retryRequestedBySessionId: string | null;
  retryRequestedByUserId: string | null;
  /** Seconds since the runner last said anything about it, by the database's clock. */
  silentSeconds: number | null;
  /** Another job on the same runner, repository and target ref was claimed first and still runs. */
  behindAnotherOnRunner: boolean;
}

/**
 * Every job this project has RUNNING and QUEUED, in `inFlight`'s order (§1.6 `inFlightJobs`).
 *
 * Running work takes precedence over queued work: an older queued job must not hide the work the
 * runner is doing. Within either state, the oldest job first. Its clock starts at the claim for a
 * running job and at the enqueue for a queued one — a QUEUED job has never been claimed, so the two
 * spellings are one COALESCE and no job reports the age of the wrong wait. `id` breaks a tie between
 * two jobs created in the same millisecond; uuid v7 sorts by time.
 *
 * The columns `checksFor` reads come along so a running job's limit is the one its claim was handed:
 * the acceptance of the task whose session the job names, and the codebase's merge check.
 *
 * A claimed job that has not reported since its claim may be waiting its turn rather than lost: the
 * runner takes the repository and target ref under one in-process lock, and a CHECK_PROMOTION's
 * serial key does not keep a landing on the same ref from being claimed beside it. While a job of any
 * project on the same runner, repository and ref was claimed first and still runs, this one is not
 * timed out — offering a retry of it would run the same work twice.
 */
export async function readInFlightJobs(
  prisma: Pick<PrismaService, '$queryRaw'>,
  projectId: string,
  /** Read just this job — how the retry door judges a timeout by the rule the page shows. */
  jobId?: string,
): Promise<ProjectIntegrationJob<Date>[]> {
  const rows = await prisma.$queryRaw<InFlightJobRow[]>(Prisma.sql`
    SELECT j."id", j."state", j."kind", j."phase", j."generation",
           j."task_id" AS "taskId", t."title" AS "taskTitle",
           j."created_at" AS "createdAt", j."claimed_at" AS "claimedAt",
           j."heartbeat_at" AS "heartbeatAt",
           r."name" AS "runnerName",
           j."retry_requested_by_session_id" AS "retryRequestedBySessionId",
           j."retry_requested_by_user_id" AS "retryRequestedByUserId",
           p."source_kind" AS "promotionSourceKind",
           st."acceptance_command" AS "acceptanceCommand",
           st."acceptance_expected_exit_code" AS "acceptanceExpectedExitCode",
           st."acceptance_timeout_seconds" AS "acceptanceTimeoutSeconds",
           cb."merge_check_command" AS "mergeCheckCommand",
           cb."merge_check_timeout_seconds" AS "mergeCheckTimeoutSeconds",
           j."skip_merge_check" AS "skipMergeCheck",
           EXTRACT(EPOCH FROM now() - COALESCE(j."heartbeat_at", j."claimed_at"))::float8 AS "silentSeconds",
           (j."state" = 'RUNNING' AND j."heartbeat_at" <= j."claimed_at" AND EXISTS (
              SELECT 1
                FROM "project_integration_job" o
                JOIN "project_codebase" ocb ON ocb."id" = o."codebase_id"
               WHERE o."state" = 'RUNNING'
                 AND o."runner_id" = j."runner_id"
                 AND o."target_ref" = j."target_ref"
                 AND ocb."canonical_repo_url" = cb."canonical_repo_url"
                 AND o."claimed_at" < j."claimed_at"
                 AND o."id" <> j."id")) AS "behindAnotherOnRunner"
      FROM "project_integration_job" j
      JOIN "project_codebase" cb ON cb."id" = j."codebase_id"
      LEFT JOIN "task" t ON t."id" = j."task_id"
      LEFT JOIN "session" s ON s."id" = j."session_id"
      LEFT JOIN "task" st ON st."id" = s."task_id"
      LEFT JOIN "project_promotion" p ON p."id" = j."promotion_id"
      LEFT JOIN "runner" r ON r."id" = j."runner_id"
     WHERE j."project_id" = ${projectId}::uuid
       AND j."state" IN ('RUNNING', 'QUEUED')
       ${jobId ? Prisma.sql`AND j."id" = ${jobId}::uuid` : Prisma.empty}
     ORDER BY (j."state" = 'RUNNING') DESC,
              COALESCE(j."claimed_at", j."created_at") ASC, j."id" ASC`);
  return rows.map((row) => {
    const running = row.state === 'RUNNING';
    const limitSeconds = integrationJobLimitSeconds(row);
    const timedOut = limitSeconds !== null && !row.behindAnotherOnRunner
      && (row.silentSeconds ?? 0) > limitSeconds;
    return {
      jobId: row.id,
      kind: row.kind,
      state: running ? 'RUNNING' : 'QUEUED',
      phase: row.phase,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      generation: row.generation,
      startedAt: row.claimedAt ?? row.createdAt,
      queuedAt: row.createdAt,
      heartbeatAt: row.heartbeatAt,
      runnerName: running ? row.runnerName : null,
      retriedBy: row.retryRequestedByUserId ? 'OWNER' : row.retryRequestedBySessionId ? 'COORDINATOR' : null,
      timedOut,
      limitSeconds,
      retryable: timedOut && row.kind === 'LAND_TASK',
    };
  });
}

/** The last attempt's check evidence, not the success of its push or the state of the current tip.
 *  Empty checks (including already-landed jobs) provide no passing verdict. */
export function lastLandingCheck(checks: unknown): 'PASSING' | 'FAILING' | 'UNKNOWN' {
  if (!Array.isArray(checks) || checks.length === 0) return 'UNKNOWN';
  let complete = true;
  for (const check of checks) {
    if (!check || typeof check !== 'object') { complete = false; continue; }
    if (check.timedOut === true) return 'FAILING';
    if (typeof check.expectedExitCode !== 'number' || typeof check.exitCode !== 'number'
      || check.timedOut !== false) { complete = false; continue; }
    if (check.exitCode !== check.expectedExitCode) return 'FAILING';
  }
  return complete ? 'PASSING' : 'UNKNOWN';
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
    SELECT "id", "upstream_ref" AS "upstreamRef",
           "upstream_ref_chosen_at" AS "upstreamRefChosenAt",
           "integration_ref" AS "integrationRef",
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
 * The main branch this owner chose last for a repository (L6): the newest of their bindings of it
 * that records a choice, `id` breaking a tie inside one millisecond — one range of
 * `project_codebase_upstream_choice_idx`. Null when they never chose one there.
 */
export async function rememberedUpstreamRef(
  db: Pick<Prisma.TransactionClient, 'projectCodebase'>,
  ownerId: string,
  canonicalRepoUrl: string,
): Promise<string | null> {
  const last = await db.projectCodebase.findFirst({
    where: { ownerId, canonicalRepoUrl, upstreamRefChosenAt: { not: null } },
    orderBy: [{ upstreamRefChosenAt: 'desc' }, { id: 'desc' }],
    select: { upstreamRef: true },
  });
  return last?.upstreamRef ?? null;
}

/**
 * Bind a project to its repository, standing on the upstream until a line is decided. A concurrent
 * binder may have won: the insert then does nothing, and the caller locks the row that one left.
 *
 * The upstream is the one the owner chose last for the same repository, and `refs/heads/main` only
 * when they never chose one there (L6) — the start door, a first `PATCH …/integration` and the
 * first integration of a project nobody started all bind through here. The binding does not
 * record a choice of its own: it carries one, and `upstream_ref_chosen_at` stays null until the
 * owner names this project's upstream.
 */
async function bind(
  tx: Prisma.TransactionClient,
  binding: { ownerId: string; projectId: string; canonicalRepoUrl: string },
): Promise<ProjectCodebaseLine> {
  const upstreamRef = await rememberedUpstreamRef(tx, binding.ownerId, binding.canonicalRepoUrl)
    ?? DEFAULT_UPSTREAM_REF;
  await tx.projectCodebase.createMany({
    data: [{
      ownerId: binding.ownerId,
      projectId: binding.projectId,
      canonicalRepoUrl: binding.canonicalRepoUrl,
      upstreamRef,
      integrationRef: upstreamRef,
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
 * With no binding yet, the repository is the one the project's coordination workspace names, and
 * the binding starts from the owner's last choice of upstream for it (`bind`).
 *
 * Every door the owner names an upstream through ends here — `PATCH /projects/:id/integration`,
 * `integration` on a project create or update (the CLI's `--upstream-ref` among them) and the start
 * door through `startProjectLine` — so this is where the choice is recorded: a request that names
 * `upstreamRef` writes `upstream_ref_chosen_at` with it, which is what the next binding of the same
 * repository starts from (L6).
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
      // The owner named it, so it is their choice, even where it is the upstream already there.
      ...(settings.upstreamRef !== undefined ? { upstreamRefChosenAt: new Date() } : {}),
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
  db: Pick<Prisma.TransactionClient, 'taskDependency'>,
  projectId: string,
): Promise<IntegrationLine> {
  // Filter both endpoints through their project rows instead of materializing all task IDs into
  // two `IN` lists. Large projects can exceed PostgreSQL's bind-parameter limit that way.
  const edge = await db.taskDependency.findFirst({
    where: {
      task: { projectId, codeless: false, status: { not: TaskStatus.CANCELLED } },
      dependsOnTask: { projectId, codeless: false, status: { not: TaskStatus.CANCELLED } },
    },
    select: { id: true },
  });
  return edge ? 'PROJECT_BRANCH' : 'MAIN';
}

/** The line half of a start's settings — what `startProjectLine` is asked for and answers with. */
export interface StartLineSettings {
  line: IntegrationLine;
  /** A full `refs/heads/…` ref, only with `PROJECT_BRANCH`. */
  projectBranchName?: string;
  /**
   * The main branch, a full `refs/heads/…` ref. Asked for, it is the owner's choice and recorded
   * as one; left out, the project keeps the upstream it stands on. In the answer, the upstream the
   * project stands on once the start is done — absent only for a project with no binding.
   */
  upstreamRef?: string;
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
 *     merge check, and says so — `locked`, with the line the project is actually on. A main branch
 *     the start asked for is not written either, and not recorded as a choice.
 *   * THERE IS NO REPOSITORY. A project with no binding whose coordination workspace names no remote
 *     has nothing a line or a check could be recorded on, and nothing ever lands on a branch of it.
 *     A start that asks for `MAIN` and no check asks nothing of it and writes nothing; one asking for
 *     a project branch, a main branch or a merge check is refused, 409
 *     `INTEGRATION_REPOSITORY_UNKNOWN`, because writing the rest of the start without them would
 *     drop what the owner chose.
 *   * OTHERWISE the line is written `EXPLICIT` — binding the project first when it has no binding,
 *     on the owner's last main branch for the repository — together with the merge check, and the
 *     main branch when the start names one, which records it as the owner's choice (L6).
 *
 * Answers with the line, the main branch and the check as they stand once it is done.
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
    if (settings.line === 'PROJECT_BRANCH' || mergeCheckCommand !== null
      || settings.upstreamRef !== undefined) {
      throw repositoryUnknown('this project has no repository to integrate into, so it can have '
        + 'no project branch, main branch or merge check: its coordination workspace has no '
        + 'recorded remote. Wait for the runner to detect origin, or set Repository URL in the '
        + 'workspace settings. A project without a repository can start on main with no merge '
        + 'check.');
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
        ...(settings.upstreamRef !== undefined ? { upstreamRef: settings.upstreamRef } : {}),
        mergeCheckCommand,
      },
  });
  const written = (await readProjectCodebase(tx, projectId))!;
  const line = decidedLine(written)!;
  const stands = {
    upstreamRef: written.upstreamRef,
    mergeCheckCommand: written.mergeCheckCommand,
    locked,
  };
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
      /** Whether THIS call wrote `integration_started_at` (L3 step 3), rather than finding the line
       *  already started by an earlier transaction. */
      startedNow: boolean;
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
 * the line that just started — is the caller's: it owns the integration queue. `startedNow` is how
 * it knows it is that transaction.
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

  const startedNow = !row.integrationStartedAt;
  if (startedNow) {
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
    startedNow,
  };
}

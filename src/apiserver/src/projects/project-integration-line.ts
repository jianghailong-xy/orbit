import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';
import {
  uuidToBase62,
  type DeliveryMode,
  type IntegrationCheckResult,
  type IntegrationJobGeneration,
  type IntegrationJobState,
  type ProjectBranchCandidates,
  type ProjectIntegrationRead,
  type ProjectIntegrationSettings as SharedProjectIntegrationSettings,
  type ProjectIntegrationView as SharedProjectIntegrationView,
  type ProjectLastMainBranch,
  type ProjectListIntegration,
  type ProjectIntegrationInFlight,
  type ProjectIntegrationJob,
  type ProjectIntegrationCheck,
  type ProjectLandTask,
  type ProjectPromotionIntegrationRead,
  type IntegrationJobBlockingReason,
  type IntegrationJobKind,
  type IntegrationJobLiveness,
  type IntegrationJobPhase,
  type PromotionBlockedReason,
  type PromotionSourceKind,
  type PromotionState,
} from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import { runnerOfflineSql } from '../runners/runner-presence';
import { branchName } from './project-criterion-landing';
import {
  INTEGRATION_JOB_CLAIM,
  INTEGRATION_PROGRESS_V2_PROTOCOL,
  IntegrationCheckSource,
  PROMOTION_AUTOMATIC_LAND,
  endTimedOutLanding,
  integrationJobLimitSeconds,
  type TimeoutEndCause,
} from './project-integration-job';
import {
  appendIntegrationJobEvent,
  cancelledText,
  readIntegrationJobTimeline,
  stopRequestedText,
  type IntegrationTimelineActorInput,
} from './project-integration-event';
import { readProjectIntegrationLog } from './project-integration-log';
import { medianMs } from './project-promotion';
import {
  queueBlockingSummary,
  type QueueBlockingFacts,
  type RunnerWait,
  readProjectLandTaskViews,
} from './project-task-integration';

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
  deliveryMode: true,
  deliveryModeChosenAt: true,
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
  prisma: Pick<PrismaService, 'projectCodebase' | '$queryRaw'>,
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
  prisma: Pick<PrismaService, 'projectCodebase' | '$queryRaw'>,
  projectIds: readonly string[],
): Promise<Map<string, ProjectListBinding>> {
  if (projectIds.length === 0) return new Map();
  const rows = await prisma.projectCodebase.findMany({
    where: { projectId: { in: [...projectIds] }, slot: 'primary' },
    select: {
      ...LINE_COLUMNS,
      projectId: true,
      _count: { select: { integrationJobs: { where: { state: { in: ['QUEUED', 'RUNNING'] } } } } },
    },
  });
  // The line's job is the one the integration view describes, read through that view's own function
  // so the two rows cannot state one job differently. The title travels with it: `task_id` is a
  // history reference with no foreign key (0423), so a job still in flight may name a task that was
  // deleted under it — and its line then says "a landing" rather than refusing to be drawn.
  const inFlight = await readInFlightJobsForProjects(prisma, rows.map((row) => row.projectId));
  const bindings = new Map<string, ProjectListBinding>();
  for (const row of rows) {
    const binding: ProjectListBinding = { integration: null, mainBranch: branchName(row.upstreamRef) };
    bindings.set(row.projectId, binding);
    const line = decidedLine(row);
    if (!line) continue;
    const lead = inFlight.get(row.projectId)?.[0];
    binding.integration = {
      line,
      ref: branchName(row.integrationRef),
      activeJobCount: row._count.integrationJobs,
      ...(lead ? { inFlight: inFlightOf(lead) } : {}),
    };
  }
  return bindings;
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
    // The column's default when there is no row: the mode a binding starts with (§10.4).
    deliveryMode: (row?.deliveryMode ?? 'PLATFORM') as DeliveryMode,
    deliveryModeChosenAt: row?.deliveryModeChosenAt ?? null,
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
    inFlight: lead ? inFlightOf(lead) : null,
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

/** §7.2 V6: a v2 claim is due a report inside 30 s, and "no word" starts after 90 s of silence. */
const LIVENESS_SILENT_AFTER_SECONDS = 90;

/** §7.2 V6: output quiet for this long while the heartbeat is fresh reads as `QUIET`. */
const LIVENESS_OUTPUT_QUIET_AFTER_SECONDS = 10 * 60;

/** How many successful runs of one check `typicalMs` is the middle of — the same "lately, not
 *  ever" sample §3.6's re-check estimate takes. */
const TYPICAL_MERGE_CHECK_SAMPLE = 5;

/** How many of a project's newest jobs that finished after their claim those runs are looked for
 *  in, whatever state the jobs ended in: the bound that keeps `typicalMs` a read of recent work
 *  however long ago the check last passed. A job that ended without a claim (cancelled while
 *  QUEUED) takes no place in it. */
const TYPICAL_MERGE_CHECK_WINDOW = 25;

/** One RUNNING or QUEUED job as `readInFlightJobsForProjects` reads it, before the read-time
 *  conclusions (`timedOut`, liveness, typical duration, blocking reason). */
interface InFlightJobRow extends IntegrationCheckSource {
  projectId: string;
  ownerId: string;
  id: string;
  state: string;
  kind: IntegrationJobKind;
  phase: IntegrationJobPhase | null;
  generation: number;
  taskId: string | null;
  taskTitle: string | null;
  promotionId: string | null;
  claimGeneration: bigint;
  round: number | null;
  step: string | null;
  stepStartedAt: Date | null;
  outputMovedAt: Date | null;
  currentCheck: unknown;
  cancelRequestedAt: Date | null;
  confirmedAutomatically: boolean;
  upstreamRef: string;
  createdAt: Date;
  claimedAt: Date | null;
  heartbeatAt: Date | null;
  runnerName: string | null;
  retryRequestedBySessionId: string | null;
  retryRequestedByUserId: string | null;
  /** Seconds since the runner last said anything about it, by the database's clock. */
  silentSeconds: number | null;
  /** Seconds since the current step's output last moved; null when no report measured it. */
  outputIdleSeconds: number | null;
  /** The protocol the current claim was made under (§2.2 J-T4): `'v2'`, or null for a legacy claim. */
  progressProtocol: string | null;
  /** Another job on the same runner, repository and target ref was claimed first and still runs. */
  behindAnotherOnRunner: boolean;
  /** A LAND_TASK or CHECK_PROMOTION whose subject's work session has not finished (J-T1a). */
  workHeld: boolean;
  /** Why the runner of the work's workspace would not claim a QUEUED job, as claimOne reads it. */
  runnerWait: RunnerWait | null;
  runnerWaitName: string | null;
  /** Whether that runner declares `promotion-automatic-land/v1` (M-T12). */
  runnerLandsAutomatically: boolean | null;
  /** The OPEN MAIN_SYNC item holding every later landing on this serial key (M2). */
  syncBlockJobId: string | null;
  syncBlockOwnerId: string | null;
  syncBlockOpenItemId: string | null;
  syncBlockTaskTitle: string | null;
  syncHandlingGeneration: number | null;
  /** The RUNNING job holding a QUEUED job's serial key (J1). */
  serialBlockJobId: string | null;
  serialBlockOwnerId: string | null;
  serialBlockKind: string | null;
  serialBlockTaskTitle: string | null;
  /** The landing session of this attempt's subject (`project_landing.session_id`, §2.9); null for
   *  a job written before 0436. Pre-generated when the subject opens, so it needs no session row. */
  landingSessionId: string | null;
}

/** The current check as the row stores it (`{ name, index, count, budgetSeconds, startedAt }`),
 *  or null when no v2 report named one. */
function currentCheckOf(raw: unknown): ProjectIntegrationCheck<Date> | null {
  if (!raw || typeof raw !== 'object') return null;
  const check = raw as Record<string, unknown>;
  if ((check.name !== 'TASK_ACCEPTANCE' && check.name !== 'MERGE_CHECK')
    || typeof check.index !== 'number' || typeof check.count !== 'number'
    || typeof check.budgetSeconds !== 'number' || typeof check.startedAt !== 'string') return null;
  const startedAt = new Date(check.startedAt);
  if (Number.isNaN(startedAt.getTime())) return null;
  return {
    name: check.name,
    index: check.index,
    count: check.count,
    budgetSeconds: check.budgetSeconds,
    startedAt,
  };
}

/** §7.2 V6's liveness, read off the claim and never stored. `LEASE_EXPIRED` is `timedOut`. */
function livenessOf(row: InFlightJobRow, timedOut: boolean): IntegrationJobLiveness | null {
  if (row.state !== 'RUNNING') return null;
  if (row.progressProtocol !== INTEGRATION_PROGRESS_V2_PROTOCOL) {
    return timedOut ? 'LEASE_EXPIRED' : 'LEGACY';
  }
  if (timedOut) return 'LEASE_EXPIRED';
  if ((row.silentSeconds ?? 0) > LIVENESS_SILENT_AFTER_SECONDS) return 'SILENT';
  if ((row.outputIdleSeconds ?? 0) > LIVENESS_OUTPUT_QUIET_AFTER_SECONDS) return 'QUIET';
  return 'LIVE';
}

/**
 * Why a job waits: the claim's own conditions, in the order §2.7a prints them, for a QUEUED one;
 * and the runner's local lock for a claimed one that is waiting its turn inside its own process.
 *
 * A blocking job of another account is named by neither id nor title — a serial key is a
 * repository and a ref, and another account's project may land on the same one — so the sentence
 * is the reason alone.
 */
function blockingReasonOf(row: InFlightJobRow): IntegrationJobBlockingReason | null {
  const mine = (ownerId: string | null) => ownerId === row.ownerId;
  if (row.state === 'RUNNING') {
    const localLock = row.progressProtocol === INTEGRATION_PROGRESS_V2_PROTOCOL
      ? row.step === 'WAITING_LOCAL_LOCK'
      : !!row.behindAnotherOnRunner;
    return localLock
      ? { code: 'WAITING_LOCAL_LOCK', summary: queueBlockingSummary('WAITING_LOCAL_LOCK', queueFacts(row)) }
      : null;
  }
  if (row.cancelRequestedAt) {
    return { code: 'CANCELLING', summary: queueBlockingSummary('CANCELLING', queueFacts(row)) };
  }
  if (row.workHeld) {
    return { code: 'WAITING_TASK_WORK', summary: queueBlockingSummary('WAITING_TASK_WORK', queueFacts(row)) };
  }
  if (row.syncBlockJobId) {
    const mineSync = row.syncBlockOwnerId === row.ownerId;
    const reason: IntegrationJobBlockingReason = {
      code: 'WAITING_MAIN_SYNC',
      summary: queueBlockingSummary('WAITING_MAIN_SYNC', queueFacts(row, {
        blockingTaskTitle: mineSync ? row.syncBlockTaskTitle : null,
        syncHandlingGeneration: mineSync ? row.syncHandlingGeneration : null,
      })),
    };
    if (mine(row.syncBlockOwnerId)) {
      reason.jobId = row.syncBlockJobId;
      if (row.syncBlockOpenItemId) reason.openItemId = row.syncBlockOpenItemId;
    }
    return reason;
  }
  if (row.runnerWait) {
    return { code: 'WAITING_RUNNER', summary: queueBlockingSummary('WAITING_RUNNER', queueFacts(row)) };
  }
  if (row.confirmedAutomatically && row.runnerLandsAutomatically === false) {
    return {
      code: 'WAITING_AUTOMATIC_RUNNER',
      summary: queueBlockingSummary('WAITING_AUTOMATIC_RUNNER', queueFacts(row)),
    };
  }
  if (row.serialBlockJobId) {
    const mineSerial = row.serialBlockOwnerId === row.ownerId;
    const reason: IntegrationJobBlockingReason = {
      code: 'WAITING_SERIAL_SLOT',
      summary: queueBlockingSummary('WAITING_SERIAL_SLOT', queueFacts(row, {
        blockingTaskTitle: mineSerial ? row.serialBlockTaskTitle : null,
        blockingJobKind: mineSerial ? row.serialBlockKind : null,
      })),
    };
    if (mineSerial) reason.jobId = row.serialBlockJobId;
    return reason;
  }
  return { code: 'WAITING_DISPATCH', summary: queueBlockingSummary('WAITING_DISPATCH', queueFacts(row)) };
}

/** What a queued job's sentence is built from. Only this owner's blocker names its task or kind. */
function queueFacts(row: InFlightJobRow, blocker: Partial<QueueBlockingFacts> = {}): QueueBlockingFacts {
  return {
    runnerName: row.runnerWaitName,
    runnerWait: row.runnerWait,
    mainBranch: branchName(row.upstreamRef),
    blockingTaskTitle: null,
    blockingJobKind: null,
    syncHandlingGeneration: null,
    ...blocker,
  };
}

/** One row as both the view's `inFlight` and its `inFlightJobs` entry state it. */
function inFlightJobOf(row: InFlightJobRow, typicalMs: Map<string, number>): ProjectIntegrationJob<Date> {
  const running = row.state === 'RUNNING';
  const limitSeconds = integrationJobLimitSeconds(row);
  const timedOut = limitSeconds !== null && !row.behindAnotherOnRunner
    && (row.silentSeconds ?? 0) > limitSeconds;
  // What the job is doing INSIDE its current claim: a requeued row keeps the columns of the claim it
  // gave back until the next claim resets them, and a step it is not on is not news.
  const check = running ? currentCheckOf(row.currentCheck) : null;
  return {
    jobId: row.id,
    kind: row.kind,
    state: running ? 'RUNNING' : 'QUEUED',
    landingSessionId: row.landingSessionId ?? null,
    phase: row.phase,
    taskId: row.taskId,
    taskTitle: row.taskTitle,
    promotionId: row.promotionId,
    generation: row.generation,
    startedAt: row.claimedAt ?? row.createdAt,
    queuedAt: row.createdAt,
    heartbeatAt: row.heartbeatAt,
    runnerName: running ? row.runnerName : null,
    retriedBy: row.retryRequestedByUserId ? 'OWNER' : row.retryRequestedBySessionId ? 'COORDINATOR' : null,
    timedOut,
    limitSeconds,
    progressProtocol: row.progressProtocol,
    claim: Number(row.claimGeneration),
    round: running ? row.round : null,
    check,
    stepStartedAt: running ? row.stepStartedAt : null,
    outputMovedAt: running ? row.outputMovedAt : null,
    typicalMs: check?.name === 'MERGE_CHECK' ? typicalMs.get(row.projectId) ?? null : null,
    liveness: livenessOf(row, timedOut),
    blockingReason: blockingReasonOf(row),
    retryable: timedOut && row.kind === 'LAND_TASK',
  };
}

/** The oldest job of a project, as the project's line states it — the same fields the view's
 *  `inFlight` carries, so a list row and the page cannot describe one job differently. */
function inFlightOf(job: ProjectIntegrationJob<Date>): ProjectIntegrationInFlight<Date> {
  const blockingReason = job.blockingReason ?? null;
  return {
    taskTitle: job.taskTitle,
    kind: job.kind,
    phase: job.phase,
    state: job.state,
    startedAt: job.startedAt,
    heartbeatAt: job.heartbeatAt,
    waitMs: claimedWaitMs(job),
    jobId: job.jobId,
    landingSessionId: job.landingSessionId,
    taskId: job.taskId,
    promotionId: job.promotionId ?? null,
    runner: job.runnerName,
    claim: job.claim,
    round: job.round ?? null,
    check: job.check ?? null,
    stepStartedAt: job.stepStartedAt ?? null,
    outputMovedAt: job.outputMovedAt ?? null,
    progressProtocol: job.progressProtocol ?? null,
    typicalMs: job.typicalMs ?? null,
    liveness: job.liveness ?? null,
    blockingReason,
  };
}

/**
 * How long this project's successful runs of each check usually take, in ms (§7.2 V6): the median
 * of the newest TYPICAL_MERGE_CHECK_SAMPLE (5), or fewer, finished jobs whose `MERGE_CHECK` PASSED,
 * among the project's newest TYPICAL_MERGE_CHECK_WINDOW (25) jobs that finished after their claim,
 * each measured from its last claim (`claimed_at`) to its end. Lately, not ever, as §3.6 reads it: fewer than five passes in those 25
 * give the median of the ones there are, and a project whose newest 25 finished jobs hold no pass
 * has no usual duration, however many passed before them.
 *
 * Not §3.6's `recentCheckDurations`: that one takes every finished run, failed checks included, and
 * measures from the first `started_at` — which J-T1e's requeue and J-T11's hand-back both keep, so a
 * job that queued twice reads as one long run. Only checks that passed are samples, and only the
 * claim that finished the job is the start of the work being measured.
 *
 * Read on every poll while a merge check runs, so it is bounded by the window: per project, the 25
 * are chosen by their columns alone (claimed, finished after the claim, newest `finished_at` first
 * with `id` breaking a tie), and the `checks` test runs only on those rows. The LIMIT inside the
 * lateral subquery is what keeps PostgreSQL from testing `checks` before the cut. No index orders a
 * project's jobs by `finished_at`, and none is needed: the project's rows are found by
 * `project_integration_job_project_idx` (or a scan where the table is small) and the newest 25 kept
 * by a top-N sort, which is cheap beside the JSON it no longer opens.
 */
async function readTypicalCheckMs(
  prisma: Pick<PrismaService, '$queryRaw'>,
  projectIds: readonly string[],
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const ids = Prisma.join(projectIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await prisma.$queryRaw<Array<{ projectId: string; ms: number }>>(Prisma.sql`
    SELECT p."projectId", passed."ms"
      FROM (SELECT DISTINCT ids."id" AS "projectId" FROM unnest(ARRAY[${ids}]) AS ids("id")) p
     CROSS JOIN LATERAL (
       SELECT finished."ms"
         FROM (
           SELECT j."id", j."finished_at", j."checks",
                  (EXTRACT(EPOCH FROM (j."finished_at" - j."claimed_at")) * 1000)::float8 AS "ms"
             FROM "project_integration_job" j
            WHERE j."project_id" = p."projectId"
              AND j."finished_at" IS NOT NULL AND j."claimed_at" IS NOT NULL
              AND j."finished_at" > j."claimed_at"
            ORDER BY j."finished_at" DESC, j."id" DESC
            LIMIT ${TYPICAL_MERGE_CHECK_WINDOW}
         ) finished
        WHERE EXISTS (
          SELECT 1
            FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(finished."checks") = 'array'
                        THEN finished."checks" ELSE '[]'::jsonb END) c
           WHERE c->>'name' = 'MERGE_CHECK'
             AND c->>'timedOut' = 'false'
             AND (c->>'exitCode') ~ '^[0-9]+$'
             AND (c->>'expectedExitCode') ~ '^[0-9]+$'
             AND (c->>'exitCode')::int = (c->>'expectedExitCode')::int)
        ORDER BY finished."finished_at" DESC, finished."id" DESC
        LIMIT ${TYPICAL_MERGE_CHECK_SAMPLE}
     ) passed`);
  const durations = new Map<string, number[]>();
  for (const row of rows) {
    durations.set(row.projectId, [...(durations.get(row.projectId) ?? []), Number(row.ms)]);
  }
  const medians = new Map<string, number>();
  for (const [projectId, values] of durations) {
    const median = medianMs(values);
    if (median !== null) medians.set(projectId, median);
  }
  return medians;
}

/**
 * Every job these projects have RUNNING and QUEUED, per project, in `inFlight`'s order (§1.6
 * `inFlightJobs`). One statement for a page of projects, so a list row costs no query of its own.
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
 *
 * The blocking conditions are claimOne's own (`runner-api/integration-job-relay.ts`), read in the
 * same order, so a reason never promises a claim the next heartbeat will not make; each blocker's
 * owner is read so that another account's job is named as the reason alone.
 */
async function readInFlightJobsForProjects(
  prisma: Pick<PrismaService, '$queryRaw'>,
  projectIds: readonly string[],
  /** Read just this job — how the retry door judges a timeout by the rule the page shows. */
  jobId?: string,
): Promise<Map<string, ProjectIntegrationJob<Date>[]>> {
  if (projectIds.length === 0) return new Map();
  const ids = Prisma.join(projectIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await prisma.$queryRaw<InFlightJobRow[]>(Prisma.sql`
    SELECT j."project_id" AS "projectId", j."owner_id" AS "ownerId",
           j."id", j."state", j."kind", j."phase", j."generation",
           j."task_id" AS "taskId", t."title" AS "taskTitle",
           j."promotion_id" AS "promotionId",
           j."claim_generation" AS "claimGeneration",
           j."round", j."step",
           j."step_started_at" AS "stepStartedAt",
           j."output_moved_at" AS "outputMovedAt",
           j."current_check" AS "currentCheck",
           j."cancel_requested_at" AS "cancelRequestedAt",
           j."confirmed_automatically" AS "confirmedAutomatically",
           j."upstream_ref" AS "upstreamRef",
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
           j."progress_protocol" AS "progressProtocol",
           EXTRACT(EPOCH FROM now() - COALESCE(j."heartbeat_at", j."claimed_at"))::float8 AS "silentSeconds",
           EXTRACT(EPOCH FROM now() - j."output_moved_at")::float8 AS "outputIdleSeconds",
           (j."state" = 'RUNNING' AND j."heartbeat_at" <= j."claimed_at" AND EXISTS (
              SELECT 1
                FROM "project_integration_job" o
                JOIN "project_codebase" ocb ON ocb."id" = o."codebase_id"
               WHERE o."state" = 'RUNNING'
                 AND o."runner_id" = j."runner_id"
                 AND o."target_ref" = j."target_ref"
                 AND ocb."canonical_repo_url" = cb."canonical_repo_url"
                 AND o."claimed_at" < j."claimed_at"
                 AND o."id" <> j."id")) AS "behindAnotherOnRunner",
           (j."state" = 'QUEUED' AND j."kind" IN ('LAND_TASK', 'CHECK_PROMOTION') AND EXISTS (
              SELECT 1 FROM "session" work
                JOIN "session" job_session ON job_session."id" = j."session_id"
               WHERE work."task_id" = COALESCE(j."task_id", job_session."task_id")
                 AND work."starts_task_work" = true
                 AND work."deleted_at" IS NULL AND work."finished_at" IS NULL)) AS "workHeld",
           runner_wait."wait" AS "runnerWait", runner_wait."name" AS "runnerWaitName",
           runner_wait."landsAutomatically" AS "runnerLandsAutomatically",
           sync_block."jobId" AS "syncBlockJobId", sync_block."ownerId" AS "syncBlockOwnerId",
           sync_block."openItemId" AS "syncBlockOpenItemId", sync_block."taskTitle" AS "syncBlockTaskTitle",
           sync_block."handlingGeneration" AS "syncHandlingGeneration",
           running_block."jobId" AS "serialBlockJobId", running_block."ownerId" AS "serialBlockOwnerId",
           running_block."kind" AS "serialBlockKind", running_block."taskTitle" AS "serialBlockTaskTitle",
           landing."session_id" AS "landingSessionId"
      FROM "project_integration_job" j
      JOIN "project_codebase" cb ON cb."id" = j."codebase_id"
      LEFT JOIN "project_landing" landing ON landing."id" = j."landing_id"
      LEFT JOIN "task" t ON t."id" = j."task_id"
      LEFT JOIN "session" s ON s."id" = j."session_id"
      LEFT JOIN "task" st ON st."id" = s."task_id"
      LEFT JOIN "project_promotion" p ON p."id" = j."promotion_id"
      LEFT JOIN "runner" r ON r."id" = j."runner_id"
      -- The runner the work's workspace names is the only one the claim can hand this job to (J-T2);
      -- read for a QUEUED job so WAITING_RUNNER and M-T12's capability speak about that one.
      LEFT JOIN LATERAL (
        SELECT CASE
                 WHEN runner."id" IS NULL THEN 'NO_RUNNER'
                 WHEN ${runnerOfflineSql('runner')} THEN 'OFFLINE'
                 WHEN runner."status" = 'DRAINING' OR runner."heartbeat_draining" = true THEN 'DRAINING'
                 WHEN runner."heartbeat_lease_owner" IS NULL
                   OR NOT (${INTEGRATION_JOB_CLAIM} = ANY(runner."capabilities")) THEN 'OUTDATED'
               END AS "wait",
               runner."name" AS "name",
               (${PROMOTION_AUTOMATIC_LAND} = ANY(runner."capabilities")) AS "landsAutomatically"
          FROM (SELECT 1) queued
          LEFT JOIN "session" source_session ON source_session."id" = j."session_id"
          LEFT JOIN "workspace" source_workspace ON source_workspace."id" = source_session."workspace_id"
          LEFT JOIN "runner" runner ON runner."id" = source_workspace."runner_id"
         WHERE j."state" = 'QUEUED'
      ) runner_wait ON true
      -- M2: an OPEN item about another landing's failed absorb of upstream into the same target
      -- holds every later landing on it; the conflicted job's own later generations are exempt (M3).
      -- The claim reads the item, not a handling generation (T17), so this does too.
      LEFT JOIN LATERAL (
        SELECT f."id" AS "jobId", i."id" AS "openItemId", i."owner_id" AS "ownerId",
               ft."title" AS "taskTitle",
               CASE WHEN handling."id" IS NOT NULL AND handling."state" IN ('QUEUED', 'RUNNING')
                    THEN handling."generation" END AS "handlingGeneration"
          FROM "project_open_item" i
          JOIN "project_integration_job" f ON f."id" = i."integration_job_id"
          LEFT JOIN "task" ft ON ft."id" = f."task_id"
          LEFT JOIN "project_integration_job" handling ON handling."id" = i."handling_job_id"
         WHERE j."state" = 'QUEUED'
           AND f."serial_key" = j."serial_key" AND f."phase" = 'MAIN_SYNC'
           AND i."kind" = 'INTEGRATION_CONFLICT' AND i."state" = 'OPEN'
           AND f."task_id" IS DISTINCT FROM j."task_id"
         ORDER BY i."created_at", i."id" LIMIT 1
      ) sync_block ON true
      -- J1: one RUNNING job per repository and target ref, whichever project queued it.
      LEFT JOIN LATERAL (
        SELECT r."id" AS "jobId", r."owner_id" AS "ownerId", r."kind" AS "kind", rt."title" AS "taskTitle"
          FROM "project_integration_job" r
          LEFT JOIN "task" rt ON rt."id" = r."task_id"
         WHERE j."state" = 'QUEUED'
           AND r."serial_key" = j."serial_key" AND r."state" = 'RUNNING'
         ORDER BY COALESCE(r."claimed_at", r."created_at"), r."id" LIMIT 1
      ) running_block ON true
     WHERE j."project_id" IN (${ids})
       AND j."state" IN ('RUNNING', 'QUEUED')
       ${jobId ? Prisma.sql`AND j."id" = ${jobId}::uuid` : Prisma.empty}
     ORDER BY j."project_id" ASC,
              (j."state" = 'RUNNING') DESC,
              COALESCE(j."claimed_at", j."created_at") ASC, j."id" ASC`);
  const typical = await readTypicalCheckMs(prisma, [...new Set(rows
    .filter((row) => row.state === 'RUNNING'
      && currentCheckOf(row.currentCheck)?.name === 'MERGE_CHECK')
    .map((row) => row.projectId))]);
  const byProject = new Map<string, ProjectIntegrationJob<Date>[]>();
  for (const row of rows) {
    const list = byProject.get(row.projectId) ?? [];
    list.push(inFlightJobOf(row, typical));
    byProject.set(row.projectId, list);
  }
  return byProject;
}

/** Every job this project has RUNNING and QUEUED, in `inFlight`'s order (§1.6 `inFlightJobs`). */
export async function readInFlightJobs(
  prisma: Pick<PrismaService, '$queryRaw'>,
  projectId: string,
  /** Read just this job — how the retry door judges a timeout by the rule the page shows. */
  jobId?: string,
): Promise<ProjectIntegrationJob<Date>[]> {
  return (await readInFlightJobsForProjects(prisma, [projectId], jobId)).get(projectId) ?? [];
}

/** The page selectors `GET /runner/projects/:id/integration` reserves for the timeline and log
 *  reads (contract §2.2 J-T4, §2.9 LS6). */
export interface IntegrationReadSelectors {
  jobId?: string;
  claim?: number;
  round?: number;
  check?: number;
  /** The check log's continuation. */
  cursor?: string;
  /** The attempt timeline's own continuation; the two pages are paged independently. */
  timelineCursor?: string;
}

/** One merge candidate's row, before its newest jobs are attached. */
interface PromotionReadRow {
  promotionId: string;
  sourceKind: string;
  sourceRef: string;
  upstreamRef: string;
  state: string;
  blockedReason: string | null;
  checks: unknown;
  mergedSha: string | null;
  mergedAt: Date | null;
  confirmedByUserId: string | null;
  confirmedAutomatically: boolean;
}

/** One `CHECK_PROMOTION` or `LAND_PROMOTION` row, as the candidate read attaches it. */
interface PromotionJobRow {
  promotionId: string;
  id: string;
  kind: string;
  generation: number;
  state: string;
  phase: string | null;
  errorCode: string | null;
  taskId: string | null;
  taskTitle: string | null;
  round: number | null;
  currentCheck: unknown;
  createdAt: Date;
  claimedAt: Date | null;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
  /** The attempt's landing session (`project_landing.session_id`, §2.9); null before 0436. */
  landingSessionId: string | null;
}

/**
 * The candidates an agent's integration read lists (§3.2, §3.6): the live ones — a check or a merge
 * in flight, or a card waiting on its owner — the blocked ones, and the one merged last. Bounded by
 * the queue and by what failed, never by the project's merge history.
 *
 * Each candidate carries its newest `CHECK_PROMOTION` and newest `LAND_PROMOTION` generation, which
 * is what "the most recent check and merge" is: the newest of each kind, not the newest row overall,
 * because a candidate's merge follows its check and both are part of the same decision.
 */
export async function readProjectPromotionIntegrationViews(
  prisma: Pick<PrismaService, '$queryRaw'>,
  projectId: string,
): Promise<ProjectPromotionIntegrationRead<Date>[]> {
  const candidates = await prisma.$queryRaw<PromotionReadRow[]>(Prisma.sql`
    WITH active AS (
      SELECT DISTINCT j."promotion_id"
        FROM "project_integration_job" j
       WHERE j."project_id" = ${projectId}::uuid
         AND j."promotion_id" IS NOT NULL
         AND j."state" IN ('QUEUED', 'RUNNING')
    ),
    last_merged AS (
      SELECT p."id"
        FROM "project_promotion" p
       WHERE p."project_id" = ${projectId}::uuid
         AND p."state" = 'MERGED'
       ORDER BY p."merged_at" DESC NULLS LAST, p."id" DESC
       LIMIT 1
    )
    SELECT p."id" AS "promotionId", p."source_kind" AS "sourceKind",
           p."source_ref" AS "sourceRef", p."upstream_ref" AS "upstreamRef",
           p."state", p."blocked_reason" AS "blockedReason", p."checks",
           p."merged_sha" AS "mergedSha", p."merged_at" AS "mergedAt",
           p."confirmed_by_user_id" AS "confirmedByUserId",
           p."confirmed_automatically" AS "confirmedAutomatically"
      FROM "project_promotion" p
     WHERE p."project_id" = ${projectId}::uuid
       AND (p."state" IN ('CHECKING', 'READY', 'CONFIRMED', 'RECHECKING', 'BLOCKED')
            OR p."id" IN (SELECT "promotion_id" FROM active)
            OR p."id" IN (SELECT "id" FROM last_merged))
     ORDER BY p."created_at" DESC, p."id" DESC`);
  if (candidates.length === 0) return [];

  const ids = Prisma.join(candidates.map((row) => Prisma.sql`${row.promotionId}::uuid`));
  const jobs = await prisma.$queryRaw<PromotionJobRow[]>(Prisma.sql`
    SELECT DISTINCT ON (j."promotion_id", j."kind")
           j."promotion_id" AS "promotionId", j."id", j."kind", j."generation", j."state",
           j."phase", j."error_code" AS "errorCode", j."task_id" AS "taskId",
           t."title" AS "taskTitle", j."round", j."current_check" AS "currentCheck",
           j."created_at" AS "createdAt", j."claimed_at" AS "claimedAt",
           j."heartbeat_at" AS "heartbeatAt", j."finished_at" AS "finishedAt",
           landing."session_id" AS "landingSessionId"
      FROM "project_integration_job" j
      LEFT JOIN "project_landing" landing ON landing."id" = j."landing_id"
      LEFT JOIN "task" t ON t."id" = j."task_id"
     WHERE j."project_id" = ${projectId}::uuid
       AND j."promotion_id" IN (${ids})
     ORDER BY j."promotion_id", j."kind", j."generation" DESC, j."created_at" DESC, j."id" DESC`);

  const byCandidate = new Map<string, { check: PromotionJobRow | null; land: PromotionJobRow | null }>();
  for (const row of jobs) {
    const pair = byCandidate.get(row.promotionId) ?? { check: null, land: null };
    if (row.kind === 'CHECK_PROMOTION') pair.check = row;
    else if (row.kind === 'LAND_PROMOTION') pair.land = row;
    byCandidate.set(row.promotionId, pair);
  }

  return candidates.map((candidate) => {
    const pair = byCandidate.get(candidate.promotionId);
    return {
      promotionId: candidate.promotionId,
      sourceKind: candidate.sourceKind as PromotionSourceKind,
      sourceRef: candidate.sourceRef,
      upstreamRef: candidate.upstreamRef,
      state: candidate.state as PromotionState,
      blockedReason: candidate.blockedReason as PromotionBlockedReason | null,
      checks: Array.isArray(candidate.checks) ? candidate.checks as IntegrationCheckResult[] : [],
      merged: candidate.mergedSha && candidate.mergedAt
        ? {
          sha: candidate.mergedSha,
          at: candidate.mergedAt,
          automatic: candidate.confirmedAutomatically,
          byUserId: candidate.confirmedByUserId,
        }
        : null,
      check: pair?.check ? promotionGenerationOf(pair.check) : null,
      land: pair?.land ? promotionGenerationOf(pair.land) : null,
    };
  });
}

/** One promotion job row as a generation: the attempt's number, where it got to, the round and the
 *  check it stopped in, and its error code. Why a stopped candidate blocked is the candidate's own
 *  `blockedReason`, which travels beside these rows. */
function promotionGenerationOf(row: PromotionJobRow): IntegrationJobGeneration<Date> {
  return {
    jobId: row.id,
    kind: row.kind as IntegrationJobKind,
    generation: row.generation,
    state: row.state as IntegrationJobState,
    landingSessionId: row.landingSessionId ?? null,
    phase: row.phase as IntegrationJobPhase | null,
    errorCode: row.errorCode,
    taskId: row.taskId,
    taskTitle: row.taskTitle,
    promotionId: row.promotionId,
    round: row.round,
    check: currentCheckOf(row.currentCheck),
    blockingReason: null,
    queuedAt: row.createdAt,
    startedAt: row.claimedAt ?? row.createdAt,
    heartbeatAt: row.heartbeatAt,
    finishedAt: row.finishedAt,
  };
}

/**
 * `GET /runner/projects/:id/integration` — the agent read of a project's line (§2.2 J-T4, §2.9
 * LS6), composed from the same reads every other surface uses: `readInFlightJobs` for the queue and
 * `readProjectLandTaskViews` (and so `readTaskIntegrationViews`) for each task's newest attempt. The
 * caller has established that the project is the reader's and that the acting session belongs to it.
 *
 * `generations` is the three reads folded into one list of current attempts: a job in the queue is
 * one, each task's newest landing is one, and each candidate's newest check and merge are one.
 */
export async function readProjectIntegrationRead(
  prisma: Pick<PrismaService, '$queryRaw' | 'projectCodebase' | 'projectIntegrationJob'>,
  project: { id: string; title: string; exceptionEscalationSeconds: number },
  selectors: IntegrationReadSelectors,
): Promise<ProjectIntegrationRead<Date>> {
  const [settings, queue, landTasks, promotionViews, log, timeline] = await Promise.all([
    readProjectCodebase(prisma, project.id).then((row) =>
      projectIntegrationView(row, project.exceptionEscalationSeconds)),
    readInFlightJobs(prisma, project.id),
    readProjectLandTaskViews(prisma, project.id),
    readProjectPromotionIntegrationViews(prisma, project.id),
    // The check log is served only when the caller named an attempt: the line itself has no output
    // to page, and a caller that did not ask for one reads the shape it always did.
    selectors.jobId
      ? readProjectIntegrationLog(prisma, project.id, selectors.jobId, selectors)
      : Promise.resolve(null),
    // §2.9 LS2: the attempt's own timeline, pageable by job, claim and round. Its cursor is its
    // own (`timelineCursor`), so a caller may read the log and the timeline of one attempt in the
    // same request without the two continuations colliding.
    selectors.jobId
      ? readIntegrationJobTimeline(prisma, project.id, {
        jobId: selectors.jobId,
        ...(selectors.claim !== undefined ? { claim: selectors.claim } : {}),
        ...(selectors.round !== undefined ? { round: selectors.round } : {}),
        ...(selectors.timelineCursor ? { cursor: selectors.timelineCursor } : {}),
      })
      : Promise.resolve(null),
  ]);
  const promotions = attachQueueFacts(promotionViews, queue);
  return {
    projectId: project.id,
    projectTitle: project.title,
    line: settings,
    queue,
    generations: currentAttempts(queue, landTasks, promotions),
    landTasks,
    promotions,
    pagination: {
      jobId: selectors.jobId ?? null,
      claim: selectors.claim ?? null,
      round: selectors.round ?? null,
      check: selectors.check ?? null,
      cursor: selectors.cursor ?? null,
      ...(selectors.timelineCursor ? { timelineCursor: selectors.timelineCursor } : {}),
    },
    ...(log ? { log } : {}),
    ...(timeline ? { timeline } : {}),
  };
}

/** A candidate's generations get the queue's own facts when they are still in it: one attempt is
 *  described by one reason, whether the reader reached it through the queue or through its
 *  candidate. */
function attachQueueFacts(
  promotions: ProjectPromotionIntegrationRead<Date>[],
  queue: ProjectIntegrationJob<Date>[],
): ProjectPromotionIntegrationRead<Date>[] {
  const byJob = new Map(queue.map((job) => [job.jobId, job]));
  const withFacts = (generation: IntegrationJobGeneration<Date> | null) => {
    if (!generation) return null;
    const job = byJob.get(generation.jobId);
    return job
      ? {
        ...generation,
        round: job.round ?? generation.round,
        check: job.check ?? generation.check,
        blockingReason: job.blockingReason ?? null,
      }
      : generation;
  };
  return promotions.map((promotion) => ({
    ...promotion,
    check: withFacts(promotion.check),
    land: withFacts(promotion.land),
  }));
}

/** Every current attempt once, in the order the three reads returned them. A job in the queue is
 *  already there with its blocking reason and its live check; a stopped one is added from the task
 *  or candidate read that carries it, so no generation is stated twice or in two voices. */
function currentAttempts(
  queue: ProjectIntegrationJob<Date>[],
  landTasks: ProjectLandTask<Date>[],
  promotions: ProjectPromotionIntegrationRead<Date>[],
): IntegrationJobGeneration<Date>[] {
  const byJob = new Map<string, IntegrationJobGeneration<Date>>();
  for (const job of queue) {
    byJob.set(job.jobId, {
      jobId: job.jobId,
      kind: job.kind,
      generation: job.generation,
      state: job.state,
      landingSessionId: job.landingSessionId ?? null,
      phase: job.phase,
      errorCode: null,
      taskId: job.taskId,
      taskTitle: job.taskTitle,
      promotionId: job.promotionId ?? null,
      round: job.round ?? null,
      check: job.check ?? null,
      blockingReason: job.blockingReason ?? null,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      heartbeatAt: job.heartbeatAt,
      finishedAt: null,
    });
  }
  for (const { taskId, taskTitle, integration } of landTasks) {
    const job = integration.landTask;
    if (!job || byJob.has(job.jobId)) continue;
    byJob.set(job.jobId, {
      jobId: job.jobId,
      kind: 'LAND_TASK',
      generation: Number(job.generation),
      state: job.state,
      landingSessionId: job.landingSessionId ?? null,
      phase: job.phase,
      errorCode: job.errorCode ?? null,
      taskId,
      taskTitle,
      promotionId: null,
      round: null,
      check: null,
      blockingReason: job.blockingReason,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      heartbeatAt: job.heartbeatAt,
      finishedAt: job.finishedAt,
    });
  }
  for (const promotion of promotions) {
    for (const generation of [promotion.check, promotion.land]) {
      if (generation && !byJob.has(generation.jobId)) byJob.set(generation.jobId, generation);
    }
  }
  return [...byJob.values()];
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

/** How a call to `stopInFlightJob` left the one generation it names. */
export type InFlightStop =
  /** A QUEUED row: ended `CANCELLED` on the spot (J-T8) — it never held the push, and it stops
   *  counting as in flight, in a queue, or against a criterion. */
  | { outcome: 'CANCELLED'; errorCode: null }
  /** A RUNNING row already silent past its limit (§7.2 V6): ended `ERROR` now, by the J-T9
   *  compare-and-set, with J12's code for its kind — nobody will ever collect it otherwise. */
  | { outcome: 'ENDED'; errorCode: 'RUNNER_LOST' | 'PUSH_OUTCOME_UNKNOWN' }
  /** A RUNNING row still inside its reporting window: `cancel_requested_at` only, and the runner's
   *  result decides (J-T12, M-T8). */
  | { outcome: 'STOP_REQUESTED'; errorCode: null }
  /** Not in flight when it was read, or the job moved on under the write. Nothing was written. */
  | { outcome: 'NONE'; errorCode: null };

/**
 * J-T8's one way of stopping a generation, for every door that stops one: the owner's Cancel and a
 * candidate's supersession (`project-promotion.service.ts`), a retired candidate's check (M-T13),
 * and a task reopened or cancelled (`tasks.service.ts`).
 *
 * WHY IT IS NOT JUST A WRITE. A QUEUED row is ended here and now: it was never claimed, so nothing
 * can have pushed, and leaving it to the runner's result is what used to leave a row nobody could
 * claim counted as in flight for ever. A RUNNING row still reporting is only ASKED to stop — the
 * runner reads that when it next reports (or when its next process claims it, J-T3) and answers
 * CANCELLED; the server must not claim a landing did not happen while a push may be in flight.
 * The exception is a RUNNING row that is already silent past its limit (§7.2 V6, read by
 * `readInFlightJobs` — this function has no timeout rule of its own): a request written onto it
 * would never be collected, and it would hold its `serial_key` for ever, so it is ended on the spot
 * as the ERROR it is, with J12's code (`timedOutErrorCode`: a check is always `RUNNER_LOST`; a
 * landing is `RUNNER_LOST` only when its current claim is v2 and recorded no PUSH, and
 * `PUSH_OUTCOME_UNKNOWN` otherwise — a legacy claim cannot prove nothing was pushed).
 *
 * `NONE` is an ordinary answer: the caller raced a result, a claim or another stop and the row has
 * already moved, so it must act on nothing. A caller that needs to know whether the promotion may
 * claim "not cancelled" reads the outcome: only `CANCELLED` and `RUNNER_LOST` prove nothing was
 * pushed.
 */
export async function stopInFlightJob(
  tx: Prisma.TransactionClient,
  input: {
    projectId: string;
    jobId: string;
    now: Date;
    /** Which door stopped it: the timeline's `TIMED_OUT` cause and the stop line's data. */
    cause?: TimeoutEndCause;
    /** Who pressed, when a person or a conversation did; the platform otherwise. */
    actor?: IntegrationTimelineActorInput;
    reason?: string | null;
  },
): Promise<InFlightStop> {
  const [job] = await readInFlightJobs(tx, input.projectId, input.jobId);
  if (!job) return { outcome: 'NONE', errorCode: null };

  if (job.state === 'QUEUED') {
    const ended = await tx.projectIntegrationJob.updateMany({
      where: { id: input.jobId, state: 'QUEUED' },
      data: { state: 'CANCELLED', cancelRequestedAt: input.now, finishedAt: input.now },
    });
    if (ended.count === 1) {
      // §2.9 LS2: a queued generation stopped here ends CANCELLED in this transaction — nothing
      // was ever pushed, so the timeline says so and names who pressed.
      await appendIntegrationJobEvent(tx, {
        jobId: input.jobId,
        key: 'cancelled',
        kind: 'CANCELLED',
        claim: job.claim ?? 0,
        round: job.round ?? null,
        phase: job.phase,
        actor: input.actor ?? { type: 'PLATFORM' },
        reason: input.reason ?? null,
        data: { cause: input.cause ?? 'STOP', state: 'CANCELLED' },
        text: cancelledText(true),
        at: input.now,
      });
      return { outcome: 'CANCELLED', errorCode: null };
    }
    // It was claimed between the read and the write: fall through and ask that claim to stop.
  } else if (job.timedOut) {
    const errorCode = await endTimedOutLanding(tx, job, input.cause ?? 'STOP');
    if (errorCode !== null) {
      return { outcome: 'ENDED', errorCode };
    }
    // The compare-and-set lost: it reported again between the read and the write, so it is talking
    // after all and gets the ordinary ask below.
  }

  const asked = await tx.projectIntegrationJob.updateMany({
    where: { id: input.jobId, state: 'RUNNING', cancelRequestedAt: null },
    data: { cancelRequestedAt: input.now },
  });
  if (asked.count === 1) {
    // J-T8 / J-T12: a live claim that is still reporting is only ASKED. The runner answers
    // CANCELLED (or a result that got past the push) and the result transaction writes the outcome;
    // this line is the ask, with the actor and the reason it was given.
    await appendIntegrationJobEvent(tx, {
      jobId: input.jobId,
      key: 'stop-requested',
      kind: 'STOP_REQUESTED',
      claim: job.claim ?? 0,
      round: job.round ?? null,
      phase: job.phase,
      actor: input.actor ?? { type: 'PLATFORM' },
      reason: input.reason ?? null,
      data: { cause: input.cause ?? 'STOP' },
      text: stopRequestedText(job.claim ?? null),
      at: input.now,
    });
    return { outcome: 'STOP_REQUESTED', errorCode: null };
  }
  // A second stop of the same claim (already asked), or a result that ended it first.
  const [after] = await readInFlightJobs(tx, input.projectId, input.jobId);
  return after?.state === 'RUNNING'
    ? { outcome: 'STOP_REQUESTED', errorCode: null }
    : { outcome: 'NONE', errorCode: null };
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
  /** How finished work reaches the upstream (§10.5 O-L1). Not locked by L4; `AGENT_PUSH` needs `MAIN`. */
  deliveryMode?: DeliveryMode;
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
           "merge_check_timeout_seconds" AS "mergeCheckTimeoutSeconds",
           "delivery_mode" AS "deliveryMode",
           "delivery_mode_chosen_at" AS "deliveryModeChosenAt"
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
 * repository starts from (L6). The delivery mode is recorded the same way, `delivery_mode_chosen_at`
 * in the UPDATE that writes `deliveryMode` (§10.5 O-L1).
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
    || settings.mergeCheckTimeoutSeconds !== undefined
    || settings.deliveryMode !== undefined;
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
        + `To change it, merge the project branch into ${branchName(row.upstreamRef)} or abandon it first.`,
    });
  }
  // The delivery mode moves no ref, so L4 does not lock it (O-L1). What it may not do is leave
  // AGENT_PUSH on anything but a MAIN line — and a line nobody decided is not one yet: the default
  // rule may still put it on a project branch at its first integration (L3), where 0453's CHECK
  // would refuse that transaction, and the DONE that queued it with it.
  const deliveryMode = settings.deliveryMode ?? (row.deliveryMode as DeliveryMode);
  if (deliveryMode === 'AGENT_PUSH' && (chosen ?? decided) !== 'MAIN') {
    throw deliveryModeNeedsMainLine(
      chosen ?? decided,
      integrationRef,
      settings.deliveryMode === undefined,
    );
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
      // Recorded like the upstream: named is chosen, even where it is the mode already there.
      ...(settings.deliveryMode !== undefined
        ? { deliveryMode: settings.deliveryMode, deliveryModeChosenAt: new Date() }
        : {}),
    },
    select: LINE_COLUMNS,
  });
  if (settings.deliveryMode === 'AGENT_PUSH' && row.deliveryMode !== 'AGENT_PUSH') {
    await deliveryModeTurnedAgentPush(tx, { ownerId, projectId });
  }
  return projectIntegrationView(written, await escalationWindow(tx, projectId));
}

/**
 * O-T4 (§10.6): the owner turned this project's delivery mode to AGENT_PUSH. Called inside the
 * transaction that wrote it, under the binding's lock (rank 55), so whatever it queues commits with
 * the choice or not at all. Queuing the observation lands with `OBSERVE_LANDING` itself; until then
 * this writes nothing.
 */
async function deliveryModeTurnedAgentPush(
  _tx: Prisma.TransactionClient,
  _change: { ownerId: string; projectId: string },
): Promise<void> {}

/** 409 `DELIVERY_MODE_NEEDS_MAIN_LINE` (O-L1): AGENT_PUSH asked for, or kept, off a MAIN line. */
function deliveryModeNeedsMainLine(
  line: IntegrationLine | null,
  integrationRef: string,
  kept: boolean,
): ConflictException {
  const message = line === null
    ? 'AGENT_PUSH needs a project that lands straight on its main branch, and this project\'s line '
      + 'is not decided yet: its first integration could still put it on a project branch. Send '
      + 'line: MAIN in the same request.'
    : kept
      ? 'this project delivers by AGENT_PUSH, which needs it to land straight on its main branch. '
        + 'Set deliveryMode to PLATFORM in the same request to move it onto a project branch.'
      : `AGENT_PUSH needs a project that lands straight on its main branch, and this one lands on `
        + `${branchName(integrationRef)}: its agents would push past the project branch. Keep `
        + 'PLATFORM, or send line: MAIN with it while the line can still change.';
  return new ConflictException({ statusCode: 409, code: 'DELIVERY_MODE_NEEDS_MAIN_LINE', message });
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
  /**
   * The check's budget in seconds. Asked for, it is written — null once more running the check on
   * its one-hour default; left out, the binding keeps the budget it has. In the answer, the budget
   * the project's check stands on once the start is done.
   */
  mergeCheckTimeoutSeconds?: number | null;
  /**
   * How finished work reaches the upstream (§10.5 O-L1), recorded as the owner's choice when asked
   * for — on a line that has started too, since L4 does not lock it. Never in the answer.
   */
  deliveryMode?: DeliveryMode;
}

/**
 * The line a start would give a project whose owner chose nothing (`POST
 * /projects/:id/acceptance/confirmation` on a project not yet started): the line it is already on
 * or the owner already chose, if either; else the default rule over its tasks as they stand — and
 * `MAIN` for a project with no repository, where no project branch can exist. The merge check it
 * already has, if any, and the budget that check runs on.
 */
export async function defaultStartLine(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
): Promise<StartLineSettings> {
  const row = await readProjectCodebase(tx, projectId);
  const mergeCheckCommand = row?.mergeCheckCommand ?? null;
  const mergeCheckTimeoutSeconds = row?.mergeCheckTimeoutSeconds ?? null;
  const decided = row ? decidedLine(row) : null;
  if (row && decided) {
    return decided === 'PROJECT_BRANCH'
      ? { line: decided, projectBranchName: row.integrationRef, mergeCheckCommand, mergeCheckTimeoutSeconds }
      : { line: decided, mergeCheckCommand, mergeCheckTimeoutSeconds };
  }
  if (!row && !(await coordinationRepository(tx, ownerId, projectId))) {
    return { line: 'MAIN', mergeCheckCommand, mergeCheckTimeoutSeconds };
  }
  return { line: await projectDefaultLine(tx, projectId), mergeCheckCommand, mergeCheckTimeoutSeconds };
}

/**
 * A start's line and merge check, applied under the binding's lock (rank 55) as the owner's choice.
 *
 * A participant, like `configureProjectIntegration`, which does the writing: the caller owns the
 * transaction and holds the project row. Three ways it goes:
 *
 *   * THE LINE HAS STARTED. It is locked (L4), so the start leaves it where it is and writes only the
 *     merge check — its command and the budget that check runs on — and the delivery mode it names,
 *     which L4 does not lock (O-L1), and says so — `locked`, with the line the project is actually
 *     on. A main branch the start asked for is not written either, and not recorded as a choice.
 *   * THERE IS NO REPOSITORY. A project with no binding whose coordination workspace names no remote
 *     has nothing a line or a check could be recorded on, and nothing ever lands on a branch of it.
 *     A start that asks for `MAIN` and no check asks nothing of it and writes nothing — `PLATFORM`
 *     delivery included, which is the mode a binding starts with; one asking for a project branch,
 *     a main branch, a merge check — a budget with no command among them — or `AGENT_PUSH` is
 *     refused, 409 `INTEGRATION_REPOSITORY_UNKNOWN`, because writing the rest of the start without
 *     them would drop what the owner chose.
 *   * OTHERWISE the line is written `EXPLICIT` — binding the project first when it has no binding,
 *     on the owner's last main branch for the repository — together with the merge check, and the
 *     main branch when the start names one, which records it as the owner's choice (L6), as it does
 *     the delivery mode the start names (O-L1).
 *
 * Answers with the line, the main branch and the check as they stand once it is done.
 */
export async function startProjectLine(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; projectId: string; settings: StartLineSettings },
): Promise<StartLineSettings & { locked: boolean }> {
  const { ownerId, projectId, settings } = input;
  const mergeCheckCommand = settings.mergeCheckCommand?.trim() || null;
  // Only when the start NAMED a budget: absent is a client that does not know the field, and
  // reading that as "no budget" would clear one its owner never saw (`StartProjectDto`). `null` is
  // the naming that says "back to the default", and it is written like any other value.
  const namedTimeout = settings.mergeCheckTimeoutSeconds !== undefined
    ? { mergeCheckTimeoutSeconds: settings.mergeCheckTimeoutSeconds }
    : {};
  const row = await lockCodebase(tx, projectId);
  const locked = !!row?.integrationStartedAt;
  if (!row && !(await coordinationRepository(tx, ownerId, projectId))) {
    if (settings.line === 'PROJECT_BRANCH' || mergeCheckCommand !== null
      || settings.mergeCheckTimeoutSeconds != null || settings.upstreamRef !== undefined
      || settings.deliveryMode === 'AGENT_PUSH') {
      throw repositoryUnknown('this project has no repository to integrate into, so it can have '
        + 'no project branch, main branch, merge check or AGENT_PUSH delivery: its coordination '
        + 'workspace has no recorded remote. Wait for the runner to detect origin, or set '
        + 'Repository URL in the workspace settings. A project without a repository can start on '
        + 'main with no merge check.');
    }
    return { line: 'MAIN', mergeCheckCommand: null, mergeCheckTimeoutSeconds: null, locked: false };
  }
  const namedDelivery = settings.deliveryMode !== undefined ? { deliveryMode: settings.deliveryMode } : {};
  await configureProjectIntegration(tx, {
    ownerId,
    projectId,
    settings: locked
      ? { mergeCheckCommand, ...namedTimeout, ...namedDelivery }
      : {
        line: settings.line,
        ...(settings.line === 'PROJECT_BRANCH' && settings.projectBranchName !== undefined
          ? { projectBranchName: settings.projectBranchName }
          : {}),
        ...(settings.upstreamRef !== undefined ? { upstreamRef: settings.upstreamRef } : {}),
        mergeCheckCommand,
        ...namedTimeout,
        ...namedDelivery,
      },
  });
  const written = (await readProjectCodebase(tx, projectId))!;
  const line = decidedLine(written)!;
  const stands = {
    upstreamRef: written.upstreamRef,
    mergeCheckCommand: written.mergeCheckCommand,
    mergeCheckTimeoutSeconds: written.mergeCheckTimeoutSeconds,
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

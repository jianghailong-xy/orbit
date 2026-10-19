import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  WIKI_DOCS_BUILD_JOB,
  WIKI_PLAN_JOB_RULES,
  WIKI_PLAN_REBUILD,
  WIKI_PLAN_SERVER_JOB,
  wikiMaintenanceSettings,
  type WikiMaintenanceSettings,
  type WikiPlanBuildProgress,
  type WikiPlanBuildReport,
  type WikiPlanDraftInput,
  type WikiPlanGateError,
  type WikiPlanJob,
  type WikiPlanJobHeldReason,
  type WikiPlanJobKind,
  type WikiPlanJobOutcome,
  type WikiPlanJobReport,
  type WikiPlanJobState,
  type WikiPlanJobTrigger,
  type WikiPlanMaterials,
} from '@orbit/shared';
import { redactSecrets } from '../common/secret-redaction';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { spaceScope } from './wiki-maintenance';

/**
 * The plan's jobs (criterion 11; contracts/wiki.contract.json `plan.jobs`, migrations 0338 and 0340): a
 * draft, a revision or a build of a space's plan — the last writing the documents of a version its owner
 * confirmed — each run by the wiki worker as a wiki_job (`plan.jobs.server`): a draft as `plan_draft`, a
 * revision as `plan_revise`, a build as `docs_build`. No task and no session is made for one.
 *
 * A FACT ASKS FOR A JOB, NEVER A CLOCK (hard constraint 5): the space was created (`space_created`), or its
 * owner asked on the plan page (`owner`) — for a draft (POST /api/wiki/spaces/:id/plan/redraft), or, by
 * confirming a version (POST …/plan/versions/:version/confirm), for the build of its documents — or an
 * administrator asked for a build again (`support`). What moves a held job on is a fact too — a change to the
 * space's maintenance settings, or the next request — and nothing is waited for.
 *
 * ONE DRAFT AT A TIME, ONE BUILD WAITING. A space has at most one draft or revision that has not ended, and
 * at most one build that waits to be made (two partial unique indexes): a second request is answered with
 * the first, and a second confirmation points the waiting build at the newer version. A build already made
 * does not stand in the way: it writes the version it was made for, and the waiting one the next — a
 * section whose material did not change is left as it is, so after a small edit only what changed is
 * written again. A job is not a maintenance run: it is not counted against the space's daily runs
 * (`wikiMaintenanceRunsToday`), and that limit does not hold it back.
 *
 * HELD, NOT FAILED. A job whose space's maintenance names no workspace — the worker reads the repository
 * through that workspace's runner — is not made, and says why on its row (`held`), until the owner's next
 * change to the maintenance settings or their next request asks again. A job does not need maintenance turned on.
 *
 * JUDGED BY WHAT IT DID. The worker ends the plan job with how its wiki_job went (`finishWikiPlanJob`): a draft
 * the gate let through, or, for a build, the documents of a confirmed version written with no section left
 * unwritten. A wiki_job that ended before it said how the plan job went leaves the plan job failed, with why.
 *
 * The functions here take the Prisma client and inject nothing, so the space's creation (WikiService),
 * its settings, and the plan's doors can each call them without a service between them.
 */

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────

type Db = PrismaService;

const OPEN_STATES = ['queued', 'held', 'made'] as const;
const WAITING_STATES = ['queued', 'held'] as const;
const DRAFT_KINDS = ['draft', 'revise'] as const;

const JOB_SELECT = {
  id: true,
  spaceId: true,
  ownerId: true,
  kind: true,
  trigger: true,
  instructions: true,
  state: true,
  heldReason: true,
  heldAt: true,
  taskId: true,
  jobId: true,
  madeAt: true,
  sessionId: true,
  startedAt: true,
  attempt: true,
  endedAt: true,
  outcome: true,
  version: true,
  errors: true,
  error: true,
  report: true,
  draft: true,
  progress: true,
  createdAt: true,
} satisfies Prisma.WikiPlanJobSelect;

export type WikiPlanJobRow = Prisma.WikiPlanJobGetPayload<{ select: typeof JOB_SELECT }>;

function storedMaintenance(settings: unknown): WikiMaintenanceSettings {
  const raw = settings !== null && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as Record<string, unknown>).maintenance
    : undefined;
  return wikiMaintenanceSettings(raw);
}

/** The space's draft or revision that has not ended, if it has one. */
async function openDraftJob(prisma: Db, ownerId: string, spaceId: string): Promise<WikiPlanJobRow | null> {
  return prisma.wikiPlanJob.findFirst({
    where: { ownerId, spaceId, kind: { in: [...DRAFT_KINDS] }, state: { in: [...OPEN_STATES] } },
    select: JOB_SELECT,
  });
}

/** The space's build that waits to be made, queued or held, if it has one. */
async function waitingBuildJob(prisma: Db, ownerId: string, spaceId: string): Promise<WikiPlanJobRow | null> {
  return prisma.wikiPlanJob.findFirst({
    where: { ownerId, spaceId, kind: 'build', state: { in: [...WAITING_STATES] } },
    select: JOB_SELECT,
  });
}

// ── Asking for a job ────────────────────────────────────────────────────────────────────────────

export interface WikiPlanJobAsk {
  ownerId: string;
  spaceId: string;
  kind: Extract<WikiPlanJobKind, 'draft' | 'revise'>;
  /** A revision's: the owner's words. */
  instructions: string | null;
  trigger: WikiPlanJobTrigger;
  requestedByUserId: string | null;
}

/** A build's request: the confirmed version whose documents are written. */
export interface WikiPlanBuildAsk {
  ownerId: string;
  spaceId: string;
  version: number;
  requestedByUserId: string | null;
}

export interface WikiPlanJobAnswer {
  /** False when the space's draft that had not ended answered the request. */
  created: boolean;
  jobId: string;
}

/**
 * Ask for a draft or a revision of a space's plan (contract `plan.jobs.request`). The space's draft that
 * has not ended answers it, asked again whether it may be made now; otherwise a job is recorded and
 * asked at once. A made job whose wiki_job already ended — or is gone — without saying how is ended
 * first, so it cannot stand in the way of every later request.
 */
export async function requestWikiPlanJob(prisma: Db, ask: WikiPlanJobAsk, now: Date = new Date()): Promise<WikiPlanJobAnswer> {
  const open = await openDraftJob(prisma, ask.ownerId, ask.spaceId);
  if (open && !(open.state === 'made' && (await endJobWhoseServerJobIsOver(prisma, open, now)))) {
    await advanceWikiPlanJob(prisma, ask.ownerId, open.id, now);
    return { created: false, jobId: open.id };
  }
  let jobId: string;
  try {
    const created = await prisma.wikiPlanJob.create({
      data: {
        spaceId: ask.spaceId,
        ownerId: ask.ownerId,
        kind: ask.kind,
        trigger: ask.trigger,
        instructions: ask.kind === 'revise' ? ask.instructions : null,
        state: 'queued',
        requestedByUserId: ask.requestedByUserId,
      },
      select: { id: true },
    });
    jobId = created.id;
  } catch (error) {
    // Two requests at the same moment: the partial unique index kept one, and that one answers both.
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const other = await openDraftJob(prisma, ask.ownerId, ask.spaceId);
    if (!other) throw error;
    return { created: false, jobId: other.id };
  }
  await advanceWikiPlanJob(prisma, ask.ownerId, jobId, now);
  return { created: true, jobId };
}

/**
 * Ask for the build of a confirmed version's documents (contract `plan.jobs.request`, kind build): what the
 * owner's confirmation asks for. The space's build that waits already answers it, pointed at this version
 * when it is the newer one, and is asked again whether it may be made now; otherwise a build is recorded
 * and asked at once. A made build whose wiki_job already ended — or is gone — without saying how is
 * ended first, as a draft's is, so that its row does not read as running for ever. A build already made
 * and running is left to write the version it was made for: this one is made beside it.
 */
export async function requestWikiPlanBuild(prisma: Db, ask: WikiPlanBuildAsk, now: Date = new Date()): Promise<WikiPlanJobAnswer> {
  const made = await prisma.wikiPlanJob.findMany({
    where: { ownerId: ask.ownerId, spaceId: ask.spaceId, kind: 'build', state: 'made' },
    select: { id: true, jobId: true },
  });
  for (const job of made) await endJobWhoseServerJobIsOver(prisma, job, now);
  const waiting = await waitingBuildJob(prisma, ask.ownerId, ask.spaceId);
  if (waiting) {
    if ((waiting.version ?? 0) < ask.version) {
      await prisma.wikiPlanJob.updateMany({ where: { id: waiting.id, state: { in: [...WAITING_STATES] } }, data: { version: ask.version } });
    }
    await advanceWikiPlanJob(prisma, ask.ownerId, waiting.id, now);
    return { created: false, jobId: waiting.id };
  }
  let jobId: string;
  try {
    const created = await prisma.wikiPlanJob.create({
      data: {
        spaceId: ask.spaceId,
        ownerId: ask.ownerId,
        kind: 'build',
        trigger: 'owner',
        instructions: null,
        state: 'queued',
        version: ask.version,
        requestedByUserId: ask.requestedByUserId,
      },
      select: { id: true },
    });
    jobId = created.id;
  } catch (error) {
    // Two confirmations at the same moment: the partial unique index kept one waiting build, and it answers both.
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const other = await waitingBuildJob(prisma, ask.ownerId, ask.spaceId);
    if (!other) throw error;
    if ((other.version ?? 0) < ask.version) {
      await prisma.wikiPlanJob.updateMany({ where: { id: other.id, state: { in: [...WAITING_STATES] } }, data: { version: ask.version } });
    }
    return { created: false, jobId: other.id };
  }
  await advanceWikiPlanJob(prisma, ask.ownerId, jobId, now);
  return { created: true, jobId };
}

/**
 * The documents of the version in force asked for again (contract `plan.jobs.rebuild`): by its owner on the plan
 * page, or by an administrator for support, who says why.
 */
export interface WikiPlanRebuildAsk {
  ownerId: string;
  spaceId: string;
  /** The space's version in force: the caller has read it. */
  version: number;
  trigger: Extract<WikiPlanJobTrigger, 'owner' | 'support'>;
  requestedByUserId: string;
  /** An administrator's request: the reason, recorded with it in their Activity row. */
  support: { reason: string } | null;
}

/** The Activity row of an administrator's request (contract `plan.jobs.rebuild.support`): theirs, naming the account. */
export const WIKI_PLAN_BUILD_REQUESTED_ACTIVITY = WIKI_PLAN_REBUILD.activity;

/**
 * Ask for the documents of the version in force again (contract `plan.jobs.rebuild`). A made build whose wiki_job
 * already ended without saying how is ended first, so that it cannot answer. Then, under the space's
 * row lock: that version's own build that has not ended answers it; otherwise the space's waiting build, pointed at
 * this version; otherwise a build is recorded — and asked at once, made as a confirmation's is.
 */
export async function requestWikiPlanRebuild(prisma: Db, ask: WikiPlanRebuildAsk, now: Date = new Date()): Promise<WikiPlanJobAnswer> {
  const made = await prisma.wikiPlanJob.findMany({
    where: { ownerId: ask.ownerId, spaceId: ask.spaceId, kind: 'build', state: 'made' },
    select: { id: true, jobId: true },
  });
  for (const job of made) await endJobWhoseServerJobIsOver(prisma, job, now);
  const writer = new PlanJobRebuildWriter(prisma);
  let answer: { jobId: string; created: boolean };
  try {
    answer = await writer.requestRebuild(ask);
  } catch (error) {
    // A confirmation's request, which takes no lock, recorded the space's waiting build meanwhile: the partial unique
    // index kept it, and asked again the lock finds it.
    if ((error as { code?: string }).code !== 'P2002') throw error;
    answer = await writer.requestRebuild(ask);
  }
  await advanceWikiPlanJob(prisma, ask.ownerId, answer.jobId, now);
  return answer;
}

/** The one writer of a build asked for again: a class only so that its retry is labelled like every other. */
class PlanJobRebuildWriter {
  private readonly logger = new Logger('WikiPlanJobs');

  constructor(private readonly prisma: PrismaService) {}

  async requestRebuild(ask: WikiPlanRebuildAsk): Promise<{ jobId: string; created: boolean }> {
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "wiki_space" WHERE "id" = ${ask.spaceId}::uuid AND "owner_id" = ${ask.ownerId}::uuid FOR NO KEY UPDATE`;
        const open = await tx.wikiPlanJob.findFirst({
          where: { ownerId: ask.ownerId, spaceId: ask.spaceId, kind: 'build', version: ask.version, state: { in: [...OPEN_STATES] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        });
        const waiting = open
          ? null
          : await tx.wikiPlanJob.findFirst({
            where: { ownerId: ask.ownerId, spaceId: ask.spaceId, kind: 'build', state: { in: [...WAITING_STATES] } },
            select: { id: true },
          });
        let answer: { jobId: string; created: boolean };
        if (open) {
          answer = { jobId: open.id, created: false };
        } else if (waiting) {
          await tx.wikiPlanJob.updateMany({ where: { id: waiting.id, state: { in: [...WAITING_STATES] } }, data: { version: ask.version } });
          answer = { jobId: waiting.id, created: false };
        } else {
          const created = await tx.wikiPlanJob.create({
            data: {
              spaceId: ask.spaceId,
              ownerId: ask.ownerId,
              kind: 'build',
              trigger: ask.trigger,
              instructions: null,
              state: 'queued',
              version: ask.version,
              requestedByUserId: ask.requestedByUserId,
            },
            select: { id: true },
          });
          answer = { jobId: created.id, created: true };
        }
        if (ask.support) {
          // What an administrator did to another account's wiki, and why: in the transaction that did it.
          await tx.activity.create({
            data: {
              actorId: ask.requestedByUserId,
              type: WIKI_PLAN_BUILD_REQUESTED_ACTIVITY,
              payload: {
                userId: ask.ownerId,
                spaceId: ask.spaceId,
                version: ask.version,
                planJobId: answer.jobId,
                created: answer.created,
                reason: ask.support.reason,
              },
              credentialKind: 'LOGIN',
            },
          });
        }
        return answer;
      },
      loggedRetry(this.logger, 'wiki.planRebuild'),
    );
  }
}

/**
 * Ask a queued or held job whether it may be made now, and make it when it may (contract `plan.jobs.server`): its
 * wiki_job queued, or why not on its row.
 */
export async function advanceWikiPlanJob(prisma: Db, ownerId: string, jobId: string, now: Date = new Date()): Promise<void> {
  const job = await prisma.wikiPlanJob.findFirst({ where: { id: jobId, ownerId }, select: JOB_SELECT });
  if (!job || (job.state !== 'queued' && job.state !== 'held')) return;
  await makeWikiPlanJobOnServer(prisma, job, wikiPlanServerJobOf(job), now);
}

/** What a plan job is made as when the server executes it: its wiki_job's kind, priority and input. */
export interface WikiPlanServerJob {
  kind: string;
  priority: number;
  input: Record<string, unknown>;
}

/**
 * The wiki_job a plan job runs as (contract `plan.jobs.server`): a draft as `plan_draft`, a revision as `plan_revise`,
 * a build as `docs_build` (P7, `docs.build.server`), all at the owner's priority.
 */
function wikiPlanServerJobOf(job: Pick<WikiPlanJobRow, 'id' | 'kind'>): WikiPlanServerJob {
  if (job.kind === 'draft' || job.kind === 'revise') {
    return { kind: WIKI_PLAN_SERVER_JOB.kinds[job.kind], priority: WIKI_PLAN_SERVER_JOB.priority, input: { planJobId: job.id } };
  }
  return { kind: WIKI_DOCS_BUILD_JOB.kind, priority: WIKI_DOCS_BUILD_JOB.priority, input: { planJobId: job.id } };
}

/**
 * Make a plan job the server's (contract `plan.jobs.server`): its wiki_job enqueued in the same transaction that
 * marks it made with it. The space's maintenance workspace is what the job needs — the worker reads the repository
 * through that workspace's runner — so a space without one holds the job. Answers the wiki_job made, or null.
 */
export async function makeWikiPlanJobOnServer(
  prisma: Db,
  job: WikiPlanJobRow,
  server: WikiPlanServerJob,
  now: Date = new Date(),
): Promise<string | null> {
  const space = await prisma.wikiSpace.findFirst({ where: { id: job.spaceId, ownerId: job.ownerId }, select: { settings: true } });
  if (!space) return null;
  const settings = storedMaintenance(space.settings);
  const workspace = settings.workspaceId
    ? await prisma.workspace.findFirst({ where: { id: settings.workspaceId, ownerId: job.ownerId, deletedAt: null }, select: { id: true } })
    : null;
  if (!workspace) {
    await holdJob(prisma, job, 'no_maintenance_workspace', now);
    return null;
  }
  return new PlanJobServerWriter(prisma).makeOnServer({ ownerId: job.ownerId, spaceId: job.spaceId, planJobId: job.id, now, server });
}

/** The one writer of a server-made plan job: a class only so that its retry is labelled like every other. */
class PlanJobServerWriter {
  private readonly logger = new Logger('WikiPlanJobs');

  constructor(private readonly prisma: PrismaService) {}

  async makeOnServer(input: { ownerId: string; spaceId: string; planJobId: string; now: Date; server: WikiPlanServerJob }): Promise<string | null> {
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const wikiJobId = randomUUID();
        const made = await tx.$executeRaw`
          UPDATE "wiki_plan_job"
             SET "state" = 'made', "job_id" = ${wikiJobId}::uuid, "made_at" = ${input.now}, "held_reason" = NULL, "held_at" = NULL, "updated_at" = now()
           WHERE "id" = ${input.planJobId}::uuid AND "owner_id" = ${input.ownerId}::uuid AND "state" IN ('queued', 'held')`;
        if (made === 0) return null;
        await tx.$executeRaw`
          INSERT INTO "wiki_job" ("id", "owner_id", "space_id", "kind", "input", "priority", "state")
          VALUES (${wikiJobId}::uuid, ${input.ownerId}::uuid, ${input.spaceId}::uuid, ${input.server.kind},
                  ${JSON.stringify(input.server.input)}::jsonb, ${input.server.priority}, 'queued')`;
        return wikiJobId;
      },
      loggedRetry(this.logger, 'wiki.planJobOnServer'),
    );
  }
}

/** Say on the job why it was not made; the reason it first held for keeps its time. */
async function holdJob(prisma: Db, job: WikiPlanJobRow, reason: WikiPlanJobHeldReason, now: Date): Promise<void> {
  if (job.state === 'held' && job.heldReason === reason) return;
  await prisma.wikiPlanJob.updateMany({
    where: { id: job.id, state: { in: ['queued', 'held'] } },
    data: { state: 'held', heldReason: reason, heldAt: now },
  });
}

// ── Facts that move a job on ────────────────────────────────────────────────────────────────────

/**
 * The space's jobs that wait — held, or queued and not yet made — each asked again: what the owner's change to a
 * space's maintenance settings calls.
 */
export async function resumeWikiPlanJobs(prisma: Db, ownerId: string, where: { spaceId: string }, now: Date = new Date()): Promise<void> {
  const jobs = await prisma.wikiPlanJob.findMany({
    where: { ownerId, spaceId: where.spaceId, state: { in: [...WAITING_STATES] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  for (const job of jobs) await advanceWikiPlanJob(prisma, ownerId, job.id, now);
}

const UNSETTLED_SERVER_JOB = ['queued', 'running', 'waiting'] as const;

/**
 * A made job whose wiki_job ended, or is gone, before it said how the plan job went: failed, with why. A job made
 * before the server ran plan jobs, as a task of the space's maintenance list (task_id, no job_id), has nothing left
 * that runs it, and is ended the same way. Answers whether the plan job is ended now.
 */
async function endJobWhoseServerJobIsOver(prisma: Db, job: { id: string; jobId: string | null }, now: Date): Promise<boolean> {
  const run = job.jobId ? await prisma.wikiJob.findFirst({ where: { id: job.jobId }, select: { state: true } }) : null;
  if (run && (UNSETTLED_SERVER_JOB as readonly string[]).includes(run.state)) return false;
  const why = run
    ? `its server job ended ${run.state} before it said how it went`
    : job.jobId
      ? 'its server job was deleted before it said how it went'
      : 'it was made as a task of the maintenance list, which no longer runs plan jobs';
  await prisma.wikiPlanJob.updateMany({ where: { id: job.id, state: 'made' }, data: { state: 'ended', outcome: 'failed', endedAt: now, error: why } });
  return true;
}

// ── What the plan's read says of a job ──────────────────────────────────────────────────────────

/** The job the plan's read shows: the space's that has not ended, else the one that ended last. */
export async function wikiPlanJobOfSpace(prisma: Db, ownerId: string, spaceId: string): Promise<WikiPlanJob | null> {
  const row = await wikiPlanJobRowOfSpace(prisma, ownerId, spaceId);
  return row ? wikiPlanJobView(row) : null;
}

/** That job's row, as it is stored: the spaces list counts what of the plan waits on the owner from it. */
export async function wikiPlanJobRowOfSpace(prisma: Db, ownerId: string, spaceId: string): Promise<WikiPlanJobRow | null> {
  const open = await prisma.wikiPlanJob.findFirst({
    where: { ownerId, spaceId, state: { in: [...OPEN_STATES] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: JOB_SELECT,
  });
  return open ?? (await prisma.wikiPlanJob.findFirst({
    where: { ownerId, spaceId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: JOB_SELECT,
  }));
}

/** Where a job stands as the plan's read says it (contract `plan.jobs.states`): a made one runs, an ended one says how. */
export function wikiPlanJobStateOf(row: Pick<WikiPlanJobRow, 'state' | 'outcome'>): WikiPlanJobState {
  return row.state === 'made'
    ? 'running'
    : row.state === 'ended'
      ? (row.outcome as WikiPlanJobOutcome)
      : (row.state as 'queued' | 'held');
}

/** A job row as the doors answer it. */
export function wikiPlanJobView(row: WikiPlanJobRow): WikiPlanJob {
  const state = wikiPlanJobStateOf(row);
  const build = row.kind === 'build';
  return {
    id: row.id,
    spaceId: row.spaceId,
    kind: row.kind as WikiPlanJobKind,
    trigger: row.trigger as WikiPlanJobTrigger,
    state,
    instructions: row.instructions,
    requestedAt: row.createdAt.toISOString(),
    held: row.heldReason && row.heldAt ? { reason: row.heldReason as WikiPlanJobHeldReason, at: row.heldAt.toISOString() } : null,
    waitingFor: null,
    taskId: row.taskId,
    provider: null,
    sessionId: row.sessionId,
    madeAt: row.madeAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    attempt: row.attempt,
    attemptsMax: WIKI_PLAN_JOB_RULES.attemptsMax,
    progress: build ? ((row.progress as unknown as WikiPlanBuildProgress | null) ?? null) : null,
    version: row.version,
    errors: (row.errors as unknown as WikiPlanGateError[] | null) ?? [],
    error: row.error,
    report: (row.report as unknown as WikiPlanJobReport | WikiPlanBuildReport | null) ?? null,
    draft: row.outcome === 'failed' ? ((row.draft as unknown as WikiPlanDraftInput | null) ?? null) : null,
  };
}

/** One job of the owner's, as the doors answer it; null for one that is not theirs. */
export async function wikiPlanJobById(prisma: Db, ownerId: string, jobId: string): Promise<WikiPlanJob | null> {
  const row = await prisma.wikiPlanJob.findFirst({ where: { id: jobId, ownerId }, select: JOB_SELECT });
  return row ? wikiPlanJobView(row) : null;
}

// ── The materials a draft reads of Orbit ────────────────────────────────────────────────────────

/**
 * What the drafting job reads of Orbit besides the repository (contract `plan.jobs.materials`): the
 * owner's projects with their task and session counts, the sessions of the space's workspaces of the
 * last `materialsSessionDays` days, and how the space's entries and topics are spread. Every title is
 * redacted before it leaves; the plan draft job counts and clusters (wiki-worker/wiki-plan-materials.ts).
 *
 * LANDING sessions are left out of both session reads (`kind = 'CONVERSATION'`): they are the
 * platform's own containers for landing work, their provider is the reserved `orbit` slug, and their
 * titles describe merges rather than anything the owner talked about (contract §2.9 LS6, errata E4).
 */
export async function wikiPlanMaterials(prisma: Db, ownerId: string, spaceId: string, now: Date = new Date()): Promise<WikiPlanMaterials> {
  const space = await prisma.wikiSpace.findFirstOrThrow({
    where: { id: spaceId, ownerId },
    select: { id: true, title: true, repoUrlNorm: true, rootCommitSha: true, settings: true },
  });
  const settings = storedMaintenance(space.settings);
  const workspace = settings.workspaceId
    ? await prisma.workspace.findFirst({ where: { id: settings.workspaceId, ownerId }, select: { id: true, workDir: true } })
    : null;
  const redact = (text: string) => redactSecrets(text).text;
  const projects = await prisma.$queryRaw<Array<{ id: string; title: string; status: string; createdAt: Date; tasks: number; sessions: number }>>`
    WITH "tasks" AS (
      SELECT t."project_id" AS "projectId", count(*)::int AS "n"
        FROM "task" t WHERE t."owner_id" = ${ownerId}::uuid AND t."project_id" IS NOT NULL GROUP BY 1),
    "sessions" AS (
      SELECT t."project_id" AS "projectId", count(*)::int AS "n"
        FROM "session" s JOIN "task" t ON t."id" = s."task_id"
       WHERE s."owner_id" = ${ownerId}::uuid AND t."project_id" IS NOT NULL GROUP BY 1)
    SELECT p."id" AS "id", p."title" AS "title", p."status"::text AS "status", p."created_at" AS "createdAt",
           coalesce(tk."n", 0) AS "tasks", coalesce(sn."n", 0) AS "sessions"
      FROM "project" p
      LEFT JOIN "tasks" tk ON tk."projectId" = p."id"
      LEFT JOIN "sessions" sn ON sn."projectId" = p."id"
     WHERE p."owner_id" = ${ownerId}::uuid
     ORDER BY p."created_at" ASC, p."id" ASC
     LIMIT ${WIKI_PLAN_JOB_RULES.materialsProjectsMax}`;
  const scope = await spaceScope(prisma, ownerId, spaceId);
  const since = new Date(now.getTime() - WIKI_PLAN_JOB_RULES.materialsSessionDays * 86_400_000);
  const workspaceIds = scope.workspaceIds;
  const [counted] = workspaceIds.length === 0
    ? [{ n: 0 }]
    : await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS "n" FROM "session" s
       WHERE s."owner_id" = ${ownerId}::uuid AND s."workspace_id" = ANY(${workspaceIds}::uuid[])
         AND s."created_at" > ${since} AND s."deleted_at" IS NULL
         AND s."kind" = 'CONVERSATION'`;
  const sessions = workspaceIds.length === 0
    ? []
    : await prisma.$queryRaw<Array<{ title: string; month: string; task: boolean; project: string | null; provider: string | null }>>`
      SELECT s."title" AS "title", to_char(s."created_at" AT TIME ZONE 'UTC', 'YYYY-MM') AS "month",
             (s."task_id" IS NOT NULL) AS "task", p."title" AS "project", s."provider" AS "provider"
        FROM "session" s
        LEFT JOIN "task" t ON t."id" = s."task_id"
        LEFT JOIN "project" p ON p."id" = t."project_id"
       WHERE s."owner_id" = ${ownerId}::uuid AND s."workspace_id" = ANY(${workspaceIds}::uuid[])
         AND s."created_at" > ${since} AND s."deleted_at" IS NULL
         AND s."kind" = 'CONVERSATION'
       ORDER BY s."created_at" DESC, s."id" DESC
       LIMIT ${WIKI_PLAN_JOB_RULES.materialsSessionsMax}`;
  const entries = await prisma.wikiEntry.groupBy({
    by: ['kind', 'status'],
    where: { ownerId, spaceId },
    _count: { _all: true },
    orderBy: [{ kind: 'asc' }, { status: 'asc' }],
  });
  const topics = await prisma.wikiTopic.findMany({
    where: { ownerId, spaceId },
    orderBy: [{ createdAt: 'asc' }, { slug: 'asc' }],
    select: { slug: true, title: true, category: true, pathPrefixes: true },
  });
  const active = await prisma.$queryRaw<Array<{ slug: string; n: number }>>`
    SELECT tp AS "slug", count(*)::int AS "n"
      FROM "wiki_entry" e, unnest(e."topics") tp
     WHERE e."owner_id" = ${ownerId}::uuid AND e."space_id" = ${spaceId}::uuid AND e."status" = 'active'
     GROUP BY 1`;
  const recent = await prisma.$queryRaw<Array<{ slug: string; kind: string; title: string }>>`
    SELECT x."slug" AS "slug", x."kind" AS "kind", x."title" AS "title" FROM (
      SELECT tp AS "slug", e."kind" AS "kind", e."title" AS "title",
             row_number() OVER (PARTITION BY tp ORDER BY e."recorded_at" DESC, e."id" DESC) AS "rank"
        FROM "wiki_entry" e, unnest(e."topics") tp
       WHERE e."owner_id" = ${ownerId}::uuid AND e."space_id" = ${spaceId}::uuid AND e."status" = 'active') x
     WHERE x."rank" <= 6
     ORDER BY x."slug", x."rank"`;
  const activeBySlug = new Map(active.map((row) => [row.slug, row.n]));
  const recentBySlug = new Map<string, Array<{ kind: string; title: string }>>();
  for (const row of recent) recentBySlug.set(row.slug, [...(recentBySlug.get(row.slug) ?? []), { kind: row.kind, title: redact(row.title) }]);
  return {
    spaceId: space.id,
    title: space.title,
    asOf: now.toISOString(),
    repo: { urlNorm: space.repoUrlNorm, rootCommitSha: space.rootCommitSha },
    workspace: workspace ? { id: workspace.id, workDir: workspace.workDir } : null,
    projects: projects.map((project) => ({
      id: project.id,
      title: redact(project.title),
      status: project.status,
      createdAt: project.createdAt.toISOString(),
      tasks: project.tasks,
      sessions: project.sessions,
    })),
    sessions: {
      days: WIKI_PLAN_JOB_RULES.materialsSessionDays,
      total: counted?.n ?? 0,
      items: sessions.map((session) => ({
        title: redact(session.title),
        month: session.month,
        task: session.task,
        project: session.project === null ? null : redact(session.project),
        provider: session.provider,
      })),
    },
    entries: entries.map((row) => ({ kind: row.kind, status: row.status, count: row._count._all })),
    topics: topics.map((topic) => ({
      slug: topic.slug,
      title: topic.title,
      category: topic.category,
      pathPrefixes: topic.pathPrefixes,
      active: activeBySlug.get(topic.slug) ?? 0,
      recent: recentBySlug.get(topic.slug) ?? [],
    })),
  };
}

// ── What a job's run says ───────────────────────────────────────────────────────────────────────

/**
 * How far a build the wiki worker runs has got (contract `plan.jobs.progress`), on its plan job while it is made and
 * still the worker's job's. Answers whether it was.
 */
export async function progressWikiPlanBuildOfJob(
  prisma: Db,
  planJobId: string,
  wikiJobId: string,
  progress: WikiPlanBuildProgress,
  now: Date = new Date(),
): Promise<boolean> {
  const value = JSON.stringify(progress);
  const moved = await prisma.$executeRaw`
    UPDATE "wiki_plan_job"
       SET "progress" = ${value}::jsonb, "started_at" = coalesce("started_at", ${now}), "updated_at" = now()
     WHERE "id" = ${planJobId}::uuid AND "state" = 'made' AND "kind" = 'build' AND "job_id" = ${wikiJobId}::uuid`;
  return moved > 0;
}

/**
 * A job's start and the gate round it is on (contract `plan.jobs.server`): the time it first started (coalesce)
 * and, when given, its round, on its row by id while it is made by this wiki_job. Answers whether it was.
 */
export async function progressWikiPlanJobOfJob(
  prisma: Db,
  input: { planJobId: string; wikiJobId: string; attempt: number | null },
  now: Date = new Date(),
): Promise<boolean> {
  const moved = await prisma.$executeRaw`
    UPDATE "wiki_plan_job"
       SET "started_at" = coalesce("started_at", ${now}), "attempt" = coalesce(${input.attempt}::int, "attempt"), "updated_at" = now()
     WHERE "id" = ${input.planJobId}::uuid AND "state" = 'made' AND "job_id" = ${input.wikiJobId}::uuid`;
  return moved > 0;
}

/**
 * The materials a server-run job drafts from, kept on it at its first run (contract `plan.jobs.server.materials`):
 * the snapshot's sha, what Orbit said of the space, and the texts the snapshot does not carry. A replay reads these
 * instead of reading again, so it asks the model the same questions. Only while it is made by this wiki_job.
 */
export async function saveWikiPlanJobMaterials(
  prisma: Db,
  input: { planJobId: string; wikiJobId: string; materials: Record<string, unknown> },
): Promise<boolean> {
  const moved = await prisma.$executeRaw`
    UPDATE "wiki_plan_job" SET "materials" = ${JSON.stringify(input.materials)}::jsonb, "updated_at" = now()
     WHERE "id" = ${input.planJobId}::uuid AND "state" = 'made' AND "job_id" = ${input.wikiJobId}::uuid`;
  return moved > 0;
}

/** How a job's run ended, as the worker says it. */
export interface WikiPlanJobEnd {
  outcome: WikiPlanJobOutcome;
  version: number | null;
  errors: WikiPlanGateError[];
  error: string | null;
  report: Record<string, unknown> | null;
  draft: Record<string, unknown> | null;
  attempt: number | null;
}

/**
 * The run ended (contract `plan.jobs.finish`): its made job is ended with what it said, by the wiki_job it was made
 * with. Answers whether it was — a job ended already is left as it is. A build keeps the version it was made for
 * when it failed, and names the one it wrote when it succeeded.
 */
export async function finishWikiPlanJob(
  prisma: Db,
  jobId: string,
  end: WikiPlanJobEnd,
  now: Date,
  kind: WikiPlanJobKind,
  wikiJobId: string,
): Promise<boolean> {
  const version = kind === 'build'
    ? (end.outcome === 'succeeded' && end.version !== null ? { version: end.version } : {})
    : { version: end.outcome === 'succeeded' ? end.version : null };
  const ended = await prisma.wikiPlanJob.updateMany({
    where: { id: jobId, state: 'made', jobId: wikiJobId },
    data: {
      state: 'ended',
      outcome: end.outcome,
      endedAt: now,
      ...version,
      errors: end.errors.length > 0 ? (end.errors as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      error: end.error,
      report: end.report === null ? Prisma.DbNull : (end.report as Prisma.InputJsonValue),
      draft: end.outcome === 'failed' && end.draft !== null ? (end.draft as Prisma.InputJsonValue) : Prisma.DbNull,
      ...(end.attempt !== null ? { attempt: end.attempt } : {}),
    },
  });
  return ended.count > 0;
}

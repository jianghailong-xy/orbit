import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  RunEventType,
  uuidToBase62,
  WIKI_PLAN_JOB_RULES,
  wikiMaintenanceSettings,
  type NormalizedRunEvent,
  type WikiMaintenanceSettings,
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
import type { Subscription } from 'rxjs';
import { redactSecrets } from '../common/secret-redaction';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TASK_COMPLETION_FENCE_REVISION } from '../tasks/task-completion-criterion';
import { spaceScope } from './wiki-maintenance';
import { ensureWikiMaintenanceList, wikiMaintenanceProviderProblem } from './wiki-maintenance-settings';

/**
 * The plan's jobs (criterion 11; contracts/wiki.contract.json `plan.jobs`, migration 0327): a draft, a
 * revision or — for the task that writes the documents — a build of a space's plan, each run as a task of
 * the space's hidden «Wiki maintenance» list, so its session is a maintenance session
 * (`isWikiMaintenanceSession`) and the plan's runner door, which only such a session may use, is open to it.
 *
 * A FACT ASKS FOR A JOB, NEVER A CLOCK (hard constraint 5): the space was created (`space_created`), or its
 * owner asked on the plan page (`owner`, POST /api/wiki/spaces/:id/plan/redraft). What moves a job on is a
 * fact too — its request, a change to the space's maintenance settings, a task of the owner's that
 * changed — and nothing is waited for.
 *
 * ONE DRAFT AT A TIME. A space has at most one draft or revision that has not ended (a partial unique
 * index): a second request is answered with the first. And the job shares the maintenance list with the
 * maintenance runs, one task of it at a time: a job whose list has a task that has not ended waits
 * (`queued`) and is made when a task of the owner's ends — the maintenance trigger, for its part, makes no
 * task while the list has one, so the local model is never asked by both at once. A job is not a
 * maintenance run: it is not counted against the space's daily runs (`wikiMaintenanceRunsToday`), and
 * that limit does not hold it back.
 *
 * HELD, NOT FAILED. A job whose space's maintenance names no workspace, or a provider no run could start
 * on, is not made — a task that could only fail the moment it was claimed — and says why on its row
 * (`held`), until the owner's next change to the maintenance settings or their next request asks again.
 * The list itself is made for it if the space has none yet: a job does not need maintenance turned on.
 *
 * JUDGED BY WHAT IT DID. The task's one criterion is EXECUTABLE — `orbit wiki plan check --space <id>
 * --job <id>`, which passes only when the run reported a draft the gate let through — and the run reports
 * how it ended (POST …/plan/job/finish). A task that ended before its run said anything leaves its job
 * failed, with why.
 *
 * The functions here take the Prisma client and inject nothing, so the space's creation (WikiService),
 * its settings, and the plan's doors can each call them without a service between them.
 */

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────

type Db = PrismaService;

const OPEN_STATES = ['queued', 'held', 'made'] as const;
const DRAFT_KINDS = ['draft', 'revise'] as const;
const UNFINISHED_TASK = ['OPEN', 'IN_PROGRESS'] as const;

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

export interface WikiPlanJobAnswer {
  /** False when the space's draft that had not ended answered the request. */
  created: boolean;
  jobId: string;
  /** The task made for it now, when one was: the caller publishes it. */
  madeTaskId: string | null;
}

/**
 * Ask for a draft or a revision of a space's plan (contract `plan.jobs.request`). The space's draft that
 * has not ended answers it, asked again whether it may be made now; otherwise a job is recorded and
 * asked at once. A made job whose task already ended — or is gone — without its run saying how is ended
 * first, so it cannot stand in the way of every later request.
 */
export async function requestWikiPlanJob(prisma: Db, ask: WikiPlanJobAsk, now: Date = new Date()): Promise<WikiPlanJobAnswer> {
  const open = await openDraftJob(prisma, ask.ownerId, ask.spaceId);
  if (open && !(open.state === 'made' && (await endJobWhoseTaskIsOver(prisma, open, now)))) {
    return { created: false, jobId: open.id, madeTaskId: await advanceWikiPlanJob(prisma, ask.ownerId, open.id, now) };
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
    return { created: false, jobId: other.id, madeTaskId: null };
  }
  return { created: true, jobId, madeTaskId: await advanceWikiPlanJob(prisma, ask.ownerId, jobId, now) };
}

/**
 * Ask a queued or held job whether it may be made now, and make it when it may: its task in the list,
 * or why not on its row. Answers the task it made, or null.
 */
export async function advanceWikiPlanJob(prisma: Db, ownerId: string, jobId: string, now: Date = new Date()): Promise<string | null> {
  const job = await prisma.wikiPlanJob.findFirst({ where: { id: jobId, ownerId }, select: JOB_SELECT });
  if (!job || (job.state !== 'queued' && job.state !== 'held')) return null;
  const space = await prisma.wikiSpace.findFirst({ where: { id: job.spaceId, ownerId }, select: { id: true, title: true, settings: true } });
  if (!space) return null;
  const settings = storedMaintenance(space.settings);
  const workspace = settings.workspaceId
    ? await prisma.workspace.findFirst({ where: { id: settings.workspaceId, ownerId, deletedAt: null }, select: { id: true } })
    : null;
  if (!workspace) {
    await holdJob(prisma, job, 'no_maintenance_workspace', now);
    return null;
  }
  if (await wikiMaintenanceProviderProblem(prisma, ownerId, settings.provider)) {
    await holdJob(prisma, job, 'maintenance_provider_unusable', now);
    return null;
  }
  const listId = settings.listId ?? (await ensureWikiMaintenanceList(prisma, ownerId, space.id));
  if (!listId) return null;
  const made = await new PlanJobTaskWriter(prisma).make({
    ownerId,
    jobId: job.id,
    listId,
    now,
    task: {
      title: `${job.kind === 'revise' ? 'Wiki plan redraft' : 'Wiki plan draft'}: ${space.title}`,
      description: planJobPrompt({
        kind: job.kind as 'draft' | 'revise',
        spaceRef: uuidToBase62(space.id),
        title: space.title,
        trigger: job.trigger as WikiPlanJobTrigger,
        instructions: job.instructions,
      }),
      acceptanceCommand: wikiPlanCheckCommand(uuidToBase62(space.id), uuidToBase62(job.id)),
      workspaceId: workspace.id,
      provider: settings.provider,
    },
  });
  if ('why' in made) {
    if (made.why === 'unfinished') await queueJob(prisma, job);
    return null;
  }
  return made.taskId;
}

/** The acceptance command a job's task is made with: its run is judged by what it reported. */
export function wikiPlanCheckCommand(spaceRef: string, jobRef: string): string {
  return `orbit wiki plan check --space ${spaceRef} --job ${jobRef}`;
}

/** Say on the job why it was not made; the reason it first held for keeps its time. */
async function holdJob(prisma: Db, job: WikiPlanJobRow, reason: WikiPlanJobHeldReason, now: Date): Promise<void> {
  if (job.state === 'held' && job.heldReason === reason) return;
  await prisma.wikiPlanJob.updateMany({
    where: { id: job.id, state: { in: ['queued', 'held'] } },
    data: { state: 'held', heldReason: reason, heldAt: now },
  });
}

/** The job waits behind an unfinished task of its list. */
async function queueJob(prisma: Db, job: WikiPlanJobRow): Promise<void> {
  if (job.state === 'queued') return;
  await prisma.wikiPlanJob.updateMany({
    where: { id: job.id, state: { in: ['queued', 'held'] } },
    data: { state: 'queued', heldReason: null, heldAt: null },
  });
}

/**
 * The one writer of a job's task: a class only so that its retry is labelled like every other. The list
 * row is locked first (rank 20, as the maintenance trigger locks it), then the list and the job are read
 * again under it: of a job and a maintenance run asking together, one finds the other's task.
 */
class PlanJobTaskWriter {
  private readonly logger = new Logger('WikiPlanJobs');

  constructor(private readonly prisma: PrismaService) {}

  async make(input: {
    ownerId: string;
    jobId: string;
    listId: string;
    now: Date;
    task: { title: string; description: string; acceptanceCommand: string; workspaceId: string; provider: string };
  }): Promise<{ taskId: string } | { why: 'no_list' | 'moved' | 'unfinished' }> {
    const { ownerId, jobId, listId, now } = input;
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const [list] = await tx.$queryRaw<Array<{ paused: boolean }>>`
          SELECT "paused" FROM "task_list" WHERE "id" = ${listId}::uuid AND "owner_id" = ${ownerId}::uuid FOR NO KEY UPDATE`;
        if (!list) return { why: 'no_list' } as const;
        const job = await tx.wikiPlanJob.findFirst({ where: { id: jobId, ownerId, state: { in: ['queued', 'held'] } }, select: { id: true } });
        if (!job) return { why: 'moved' } as const;
        const unfinished = await tx.task.findFirst({
          where: { ownerId, listId, status: { in: [...UNFINISHED_TASK] } },
          select: { id: true },
        });
        if (unfinished) return { why: 'unfinished' } as const;
        const task = await tx.task.create({
          data: {
            title: input.task.title,
            description: input.task.description,
            ownerId,
            creatorType: 'USER',
            creatorId: ownerId,
            listId,
            assigneeId: input.task.workspaceId,
            provider: input.task.provider,
            runAt: now,
            dispatchHold: list.paused,
            acceptanceCriteria:
              "The run stored a draft of the space's plan that passed the plan's gate (`orbit wiki plan check` exits 0).",
            acceptanceCommand: input.task.acceptanceCommand,
            acceptanceExpectedExitCode: 0,
            acceptanceTimeoutSeconds: WIKI_PLAN_JOB_RULES.checkTimeoutSeconds,
            completionCriterion: 'EXECUTABLE',
            completionFenceRevision: TASK_COMPLETION_FENCE_REVISION,
          },
          select: { id: true },
        });
        await tx.wikiPlanJob.update({
          where: { id: jobId },
          data: { state: 'made', taskId: task.id, madeAt: now, heldReason: null, heldAt: null },
        });
        return { taskId: task.id } as const;
      },
      loggedRetry(this.logger, 'wiki.planJobTask'),
    );
  }
}

/** What the job's session reads as its task (UI copy and prompts are English). */
function planJobPrompt(input: {
  kind: 'draft' | 'revise';
  spaceRef: string;
  title: string;
  trigger: WikiPlanJobTrigger;
  instructions: string | null;
}): string {
  const because = input.kind === 'revise'
    ? 'its owner asked for a redraft, with the instructions below'
    : input.trigger === 'space_created'
      ? 'the space was just created, and has no plan yet'
      : 'its owner asked for a draft';
  const command = input.kind === 'revise' ? 'revise' : 'draft';
  const lines = [
    `A Wiki plan ${input.kind === 'revise' ? 'redraft' : 'draft'} of the space «${input.title}» (${input.spaceRef}): ${because}.`,
    '',
    'Run this once, with the Bash tool, and let it finish — it takes an hour or two, and it prints what it did:',
    '',
    `    orbit wiki plan ${command} --space ${input.spaceRef}`,
    '',
    input.kind === 'revise'
      ? "It reads the plan's newest version and the owner's instructions (saved with this job; the command reads them "
        + 'itself), has the local model revise the plan, checks every reference against origin/main and the plan itself, '
        + "and submits it to the plan's gate, handing every error back to the model up to three rounds."
      : 'It reads the repository at origin/main and what the space already knows, has the local model draft the plan in '
        + "four steps, checks every reference against origin/main and the plan itself, and submits it to the plan's gate, "
        + 'handing every error back to the model up to three rounds.',
    'Then report it: task_progress_report with where the run ended, and one task_comment with the summary it printed — '
      + 'the documents, the gate rounds and their errors, the token spend and the time; if it failed, its last lines. '
      + 'Run nothing else, and do not run it again if it fails.',
  ];
  if (input.kind === 'revise' && input.instructions) {
    lines.push('', "The owner's instructions, as they were given:", '', ...input.instructions.split('\n').map((line) => `> ${line}`));
  }
  return lines.join('\n');
}

// ── Facts that move a job on ────────────────────────────────────────────────────────────────────

/**
 * The space's (or, with none named, the owner's) jobs that wait — queued behind a task, or held — each
 * asked again. What the owner's change to a space's maintenance settings, and a task of theirs that
 * ended, call. Answers the tasks made.
 */
export async function resumeWikiPlanJobs(
  prisma: Db,
  ownerId: string,
  where: { spaceId?: string; states?: ReadonlyArray<'queued' | 'held'> } = {},
  now: Date = new Date(),
): Promise<string[]> {
  const jobs = await prisma.wikiPlanJob.findMany({
    where: { ownerId, ...(where.spaceId ? { spaceId: where.spaceId } : {}), state: { in: [...(where.states ?? ['queued', 'held'])] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  const made: string[] = [];
  for (const job of jobs) {
    const taskId = await advanceWikiPlanJob(prisma, ownerId, job.id, now);
    if (taskId) made.push(taskId);
  }
  return made;
}

/**
 * A made job whose task ended, or is gone, before its run said how it ended: failed, with why. Answers
 * whether the job is ended now. A job its run reported on is ended already and is left as it said.
 */
async function endJobWhoseTaskIsOver(prisma: Db, job: Pick<WikiPlanJobRow, 'id' | 'taskId'>, now: Date): Promise<boolean> {
  const task = job.taskId ? await prisma.task.findFirst({ where: { id: job.taskId }, select: { status: true } }) : null;
  if (task && (UNFINISHED_TASK as readonly string[]).includes(task.status)) return false;
  const why = task
    ? `its task ended ${task.status} before the run said how it went`
    : 'its task was deleted before the run said how it went';
  await prisma.wikiPlanJob.updateMany({ where: { id: job.id, state: 'made' }, data: { state: 'ended', outcome: 'failed', endedAt: now, error: why } });
  return true;
}

/** The made jobs of these tasks whose task has ended: failed, with why. Answers how many ended. */
export async function settleWikiPlanJobsOfTasks(prisma: Db, ownerId: string, taskIds: readonly string[], now: Date = new Date()): Promise<number> {
  if (taskIds.length === 0) return 0;
  const jobs = await prisma.wikiPlanJob.findMany({ where: { ownerId, state: 'made', taskId: { in: [...taskIds] } }, select: { id: true, taskId: true } });
  let ended = 0;
  for (const job of jobs) if (await endJobWhoseTaskIsOver(prisma, job, now)) ended += 1;
  return ended;
}

const USER_SCOPE = 'user:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The owner and the tasks a published task change names, or null for any other event. */
export function wikiPlanJobHintFor(runId: string, event: NormalizedRunEvent): { ownerId: string; taskIds: string[] } | null {
  if (event.type !== RunEventType.TASK_CHANGED || !runId.startsWith(USER_SCOPE)) return null;
  const ownerId = runId.slice(USER_SCOPE.length);
  if (!UUID.test(ownerId)) return null;
  const payload = (event.payload ?? {}) as { taskId?: unknown; taskIds?: unknown };
  const ids = [...(Array.isArray(payload.taskIds) ? payload.taskIds : []), payload.taskId].filter(
    (id): id is string => typeof id === 'string' && UUID.test(id),
  );
  return { ownerId, taskIds: [...new Set(ids)] };
}

/**
 * The trigger's subscription (contract `plan.jobs.trigger`): every task change this replica published,
 * read for its owner — the made jobs of the tasks it names are ended if their task has, and the owner's
 * queued jobs are asked again, since the list they wait on may have just been freed. An event is
 * published after its write, at most once, and a crash between loses it: a lost one is a job that waits
 * for the owner's next task change, or their next request. An owner's hints are taken one at a time,
 * those arriving meanwhile merged into the next.
 */
@Injectable()
export class WikiPlanJobFacts implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WikiPlanJobFacts.name);
  private subscription?: Subscription;
  private readonly waiting = new Map<string, Set<string>>();
  private readonly draining = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.realtime?.localPublications().subscribe(({ runId, event }) => {
      try {
        this.take(runId, event);
      } catch (error) {
        this.logger.warn(`a task change was not taken: ${(error as Error).message}`);
      }
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
  }

  /** One published event, taken for its owner. */
  take(runId: string, event: NormalizedRunEvent): void {
    const hint = wikiPlanJobHintFor(runId, event);
    if (!hint) return;
    const waiting = this.waiting.get(hint.ownerId) ?? new Set<string>();
    for (const id of hint.taskIds) waiting.add(id);
    this.waiting.set(hint.ownerId, waiting);
    if (!this.draining.has(hint.ownerId)) {
      const owner = hint.ownerId;
      const drain = this.drain(owner).finally(() => this.draining.delete(owner));
      this.draining.set(owner, drain);
    }
  }

  /** Every evaluation under way, finished: what a spec waits on. */
  async idle(): Promise<void> {
    while (this.draining.size > 0) await Promise.all([...this.draining.values()]);
  }

  private async drain(ownerId: string): Promise<void> {
    for (let next = this.waiting.get(ownerId); next; next = this.waiting.get(ownerId)) {
      this.waiting.delete(ownerId);
      try {
        await this.evaluate(ownerId, [...next]);
      } catch (error) {
        this.logger.warn(`the plan jobs of an owner were not moved on: ${(error as Error).message}`);
      }
    }
  }

  /** The owner's jobs after a change to these tasks: answers the tasks made. */
  async evaluate(ownerId: string, taskIds: readonly string[], now: Date = new Date()): Promise<string[]> {
    const moving = await this.prisma.wikiPlanJob.findMany({
      where: { ownerId, state: { in: ['queued', 'made'] } },
      select: { id: true },
      take: 1,
    });
    if (moving.length === 0) return [];
    await settleWikiPlanJobsOfTasks(this.prisma, ownerId, taskIds, now);
    const made = await resumeWikiPlanJobs(this.prisma, ownerId, { states: ['queued'] }, now);
    if (made.length > 0) {
      this.logger.log(`made plan job tasks ${made.join(', ')}`);
      this.realtime?.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: made, resync: false });
    }
    return made;
  }
}

// ── What the plan's read says of a job ──────────────────────────────────────────────────────────

/** The job the plan's read shows: the space's that has not ended, else the one that ended last. */
export async function wikiPlanJobOfSpace(prisma: Db, ownerId: string, spaceId: string): Promise<WikiPlanJob | null> {
  const open = await prisma.wikiPlanJob.findFirst({
    where: { ownerId, spaceId, state: { in: [...OPEN_STATES] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: JOB_SELECT,
  });
  const row = open ?? (await prisma.wikiPlanJob.findFirst({
    where: { ownerId, spaceId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: JOB_SELECT,
  }));
  return row ? wikiPlanJobView(prisma, row) : null;
}

/** A job row as the doors answer it. */
export async function wikiPlanJobView(prisma: Db, row: WikiPlanJobRow): Promise<WikiPlanJob> {
  const state: WikiPlanJobState = row.state === 'made'
    ? 'running'
    : row.state === 'ended'
      ? (row.outcome as WikiPlanJobOutcome)
      : (row.state as 'queued' | 'held');
  let waitingFor: WikiPlanJob['waitingFor'] = null;
  if (row.state === 'queued') {
    const space = await prisma.wikiSpace.findFirst({ where: { id: row.spaceId, ownerId: row.ownerId }, select: { settings: true } });
    const listId = storedMaintenance(space?.settings).listId;
    const task = listId
      ? await prisma.task.findFirst({
        where: { ownerId: row.ownerId, listId, status: { in: [...UNFINISHED_TASK] } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, title: true },
      })
      : null;
    if (task) {
      const run = await prisma.wikiMaintenanceRun.findFirst({ where: { taskId: task.id }, select: { sessionId: true, startedAt: true } });
      const session = run?.sessionId
        ? null
        : await prisma.session.findFirst({ where: { taskId: task.id, deletedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true } });
      waitingFor = {
        taskId: task.id,
        title: task.title,
        sessionId: run?.sessionId ?? session?.id ?? null,
        startedAt: (run?.startedAt ?? session?.createdAt ?? null)?.toISOString() ?? null,
      };
    }
  }
  const task = row.taskId ? await prisma.task.findFirst({ where: { id: row.taskId }, select: { provider: true } }) : null;
  return {
    id: row.id,
    spaceId: row.spaceId,
    kind: row.kind as WikiPlanJobKind,
    trigger: row.trigger as WikiPlanJobTrigger,
    state,
    instructions: row.instructions,
    requestedAt: row.createdAt.toISOString(),
    held: row.heldReason && row.heldAt ? { reason: row.heldReason as WikiPlanJobHeldReason, at: row.heldAt.toISOString() } : null,
    waitingFor,
    taskId: row.taskId,
    provider: task?.provider ?? null,
    sessionId: row.sessionId,
    madeAt: row.madeAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    attempt: row.attempt,
    attemptsMax: WIKI_PLAN_JOB_RULES.attemptsMax,
    version: row.version,
    errors: (row.errors as unknown as WikiPlanGateError[] | null) ?? [],
    error: row.error,
    report: (row.report as unknown as WikiPlanJobReport | null) ?? null,
    draft: row.outcome === 'failed' ? ((row.draft as unknown as WikiPlanDraftInput | null) ?? null) : null,
  };
}

/** One job of the owner's, as the doors answer it; null for one that is not theirs. */
export async function wikiPlanJobById(prisma: Db, ownerId: string, jobId: string): Promise<WikiPlanJob | null> {
  const row = await prisma.wikiPlanJob.findFirst({ where: { id: jobId, ownerId }, select: JOB_SELECT });
  return row ? wikiPlanJobView(prisma, row) : null;
}

/** The job a session runs: the one whose task the session executes, in this space. */
export async function wikiPlanJobOfSession(prisma: Db, ownerId: string, spaceId: string, sessionId: string): Promise<WikiPlanJobRow | null> {
  const session = await prisma.session.findFirst({ where: { id: sessionId, ownerId }, select: { taskId: true } });
  if (!session?.taskId) return null;
  return prisma.wikiPlanJob.findFirst({ where: { ownerId, spaceId, taskId: session.taskId }, select: JOB_SELECT });
}

/** Whether a task is a plan job's: the maintenance claim and the day's run count ask it. */
export async function isWikiPlanJobTask(prisma: Pick<Prisma.TransactionClient, 'wikiPlanJob'>, taskId: string): Promise<boolean> {
  return (await prisma.wikiPlanJob.findFirst({ where: { taskId }, select: { id: true } })) !== null;
}

// ── The materials a draft reads of Orbit ────────────────────────────────────────────────────────

/**
 * What the drafting job reads of Orbit besides the repository (contract `plan.jobs.materials`): the
 * owner's projects with their task and session counts, the sessions of the space's workspaces of the
 * last `materialsSessionDays` days, and how the space's entries and topics are spread. Every title is
 * redacted before it leaves; the runner counts and clusters. Only the space's maintenance session asks.
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
         AND s."created_at" > ${since} AND s."deleted_at" IS NULL`;
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
 * The run started (contract `plan.jobs.context`): the calling session, and the time it first said so,
 * written onto its made job. A retried session of the same task overwrites the session and keeps the time.
 */
export async function startWikiPlanJob(prisma: Db, jobId: string, sessionId: string, now: Date = new Date()): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "wiki_plan_job"
       SET "session_id" = ${sessionId}::uuid, "started_at" = coalesce("started_at", ${now}), "updated_at" = now()
     WHERE "id" = ${jobId}::uuid AND "state" = 'made'`;
}

/** The gate round the run is on (contract `plan.jobs.progress`), on its job while it is made. Answers whether it was. */
export async function progressWikiPlanJob(prisma: Db, jobId: string, sessionId: string, attempt: number, now: Date = new Date()): Promise<boolean> {
  const moved = await prisma.$executeRaw`
    UPDATE "wiki_plan_job"
       SET "attempt" = ${attempt}, "session_id" = ${sessionId}::uuid, "started_at" = coalesce("started_at", ${now}), "updated_at" = now()
     WHERE "id" = ${jobId}::uuid AND "state" = 'made'`;
  return moved > 0;
}

/** How a run ended, as it said it, checked by the door before it is kept. */
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
 * The run ended (contract `plan.jobs.finish`): its made job is ended with what it said. Answers whether
 * it was — a job ended already, by its run or by its task, is left as it is.
 */
export async function finishWikiPlanJob(prisma: Db, jobId: string, sessionId: string, end: WikiPlanJobEnd, now: Date = new Date()): Promise<boolean> {
  const ended = await prisma.wikiPlanJob.updateMany({
    where: { id: jobId, state: 'made' },
    data: {
      state: 'ended',
      outcome: end.outcome,
      endedAt: now,
      sessionId,
      version: end.outcome === 'succeeded' ? end.version : null,
      errors: end.errors.length > 0 ? (end.errors as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      error: end.error,
      report: end.report === null ? Prisma.DbNull : (end.report as Prisma.InputJsonValue),
      draft: end.outcome === 'failed' && end.draft !== null ? (end.draft as Prisma.InputJsonValue) : Prisma.DbNull,
      ...(end.attempt !== null ? { attempt: end.attempt } : {}),
    },
  });
  return ended.count > 0;
}

/**
 * `orbit wiki plan check` (contract `plan.jobs.check`): did the job's run do what its task was made for —
 * ended succeeded, with the version it stored still one of the space's. Null for a job of another space.
 */
export async function wikiPlanJobCheck(
  prisma: Db,
  ownerId: string,
  spaceId: string,
  jobId: string,
): Promise<{ kind: WikiPlanJobKind; outcome: WikiPlanJobOutcome | null; version: number | null; ok: boolean; problems: string[] } | null> {
  const job = await prisma.wikiPlanJob.findFirst({
    where: { id: jobId, ownerId, spaceId },
    select: { kind: true, state: true, outcome: true, version: true, error: true, errors: true, taskId: true },
  });
  if (!job) return null;
  const problems: string[] = [];
  if (job.state !== 'ended') {
    problems.push(job.state === 'made'
      ? 'The run has not said how it ended: it did not finish, or was cut short before it could.'
      : `The job was never started: it is ${job.state}.`);
  } else if (job.outcome !== 'succeeded') {
    const count = Array.isArray(job.errors) ? job.errors.length : 0;
    problems.push(`The run ended failed${job.error ? `: ${job.error}` : ''}${count > 0 ? ` (the gate's last round found ${count} error${count === 1 ? '' : 's'})` : ''}.`);
  } else if (job.version === null) {
    problems.push('The run said it succeeded and named no version it stored.');
  } else if (!(await prisma.wikiPlan.findFirst({ where: { ownerId, spaceId, version: job.version }, select: { id: true } }))) {
    problems.push(`The version the run stored, ${job.version}, is not one of the space's.`);
  }
  return {
    kind: job.kind as WikiPlanJobKind,
    outcome: (job.outcome as WikiPlanJobOutcome | null) ?? null,
    version: job.version,
    ok: problems.length === 0,
    problems,
  };
}

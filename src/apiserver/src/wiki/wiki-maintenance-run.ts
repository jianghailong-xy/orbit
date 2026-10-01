import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  RunEventType,
  WIKI_CURSOR_OUTCOMES,
  WIKI_DEFAULT_TOPICS,
  WIKI_MAINTENANCE_JOB,
  WIKI_MAINTENANCE_RULES,
  WIKI_REVIEW_RULES,
  uuidToBase62,
  wikiMaintenanceCheckCommand,
  wikiMaintenanceRunSessions,
  wikiMaintenanceSettings,
  wikiSpaceSettings,
  type NormalizedRunEvent,
  type WikiCursorOutcome,
  type WikiCursorState,
  type WikiMaintenanceCheck,
  type WikiMaintenanceDue,
  type WikiMaintenanceHeldReason,
  type WikiMaintenanceRunContext,
} from '@orbit/shared';
import type { Subscription } from 'rxjs';
import { redactSecrets } from '../common/secret-redaction';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TASK_COMPLETION_FENCE_REVISION } from '../tasks/task-completion-criterion';
import {
  afterSql,
  comparePositions,
  countBacklog,
  decodeCursorToken,
  encodeCursorToken,
  factsAfter,
  factsSql,
  maintenanceDue,
  pageOf,
  PAGE_FACT_SCAN,
  spaceScope,
  type FactPosition,
  type WikiMaintenance,
} from './wiki-maintenance';
import { wikiMaintenanceRunsToday } from './wiki-maintenance-session';
import { hasQueuedWikiPlanJob, resumeWikiPlanJobs } from './wiki-plan-job';
import { currentWikiRollout, wikiOnFor } from './wiki-rollout';

/**
 * The Wiki maintenance job's server side (design §8.2, contracts/wiki.contract.json `maintenance.job`,
 * criterion 3): the fact that makes a space's maintenance task, and the four things its run asks —
 * where it starts, how it proposes, how it ends, and whether it did what its task expected.
 *
 * A FACT MAKES THE TASK, NEVER A CLOCK (hard constraint 5). Every event this replica publishes about a
 * session or a task is a hint (`WikiMaintenanceTrigger`); a hint is followed only when it names a
 * committed fact of a space whose maintenance is on — a session of the space that came to rest, an
 * approval it answered, a merge receipt of it, a task of the space that settled — which is still after
 * the space's cursor. Then, and only then, the space is asked whether it is due: `backlogThreshold`
 * sessions pending, or the oldest pending fact older than `maxPendingAgeHours`. The age is read when a
 * fact arrives, never waited for: a space whose oldest fact turns a day old in a quiet night makes its
 * task with the next fact of the morning. A hint that names nothing new — a rename, the maintenance run's
 * own events, a task of another space — changes nothing, however due the space is.
 *
 * ONE TASK AT A TIME, AND NO MORE THAN THE DAY ALLOWS. The task is made in the space's hidden list under
 * a lock on the list row, after the list is read again for a task that has not ended: two facts arriving
 * together make one task. A space whose runs for the UTC day are used up (`settings.maintenance
 * .dailyRunLimit`), or a Manual space whose review queue has no room for a run's proposals, makes none,
 * and says why on its cursor row (`held`) until one is made.
 *
 * A PLAN JOB GOES FIRST (contract `plan.jobs.staggered`). While a draft or a build the owner asked for
 * waits for the list (`queued`), no run is made, however due the space is: a fact that finds the list free
 * makes the job's task instead, and the facts stay in the backlog, so the first fact after the job's task
 * ended is asked by the rules above as it always was. On 2026-10-01 a build confirmed while a run was under
 * way waited behind two more runs, an hour and eleven minutes.
 *
 * THE TASK IS JUDGED BY WHAT ITS RUN DID. It is pinned to the space's maintenance workspace and provider,
 * starts at once (runAt now), and its one criterion is EXECUTABLE: `orbit wiki check --space <id>
 * --expect-cursor <token>`, the position covering the next `runSessions` sessions after the cursor. The
 * run reports how it ended — its outcome, the ops the server refused, its report with the token spend —
 * and the check passes only when the cursor reached that position and the run had no op refused.
 */

// ── The trigger ─────────────────────────────────────────────────────────────────────────────────

/** What a published event may be a fact about: sessions, and settled tasks. Identities only. */
export interface WikiMaintenanceHint {
  sessionIds: string[];
  taskIds: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_SCOPE = 'user:';

/**
 * The events a session publishes when one of its facts commits: its status settling (STATUS, and the
 * SESSION_UPDATED a turn that ends without failing publishes after /turn-complete commits it), its end,
 * and an approval answered. A merge receipt and a criterion revision publish nothing of their own: they
 * are counted in the backlog like every fact, and taken in with the next fact that arrives.
 */
const SESSION_FACT_EVENTS: ReadonlySet<string> = new Set([
  RunEventType.STATUS,
  RunEventType.SESSION_ENDED,
  RunEventType.SESSION_UPDATED,
  RunEventType.APPROVAL_RESOLVED,
]);

/**
 * The rows an event names, and the owner when the event says it (a user-scoped task change), or null for
 * an event that names no possible fact. Nothing it says about the rows is read.
 */
export function wikiMaintenanceHintFor(
  runId: string,
  event: NormalizedRunEvent,
): (WikiMaintenanceHint & { ownerId: string | null }) | null {
  if (event.type === RunEventType.TASK_CHANGED) {
    if (!runId.startsWith(USER_SCOPE)) return null;
    const ownerId = runId.slice(USER_SCOPE.length);
    if (!UUID.test(ownerId)) return null;
    const payload = (event.payload ?? {}) as { taskId?: unknown; taskIds?: unknown };
    const ids = [...(Array.isArray(payload.taskIds) ? payload.taskIds : []), payload.taskId].filter(
      (id): id is string => typeof id === 'string' && UUID.test(id),
    );
    return ids.length > 0 ? { ownerId, sessionIds: [], taskIds: [...new Set(ids)] } : null;
  }
  return SESSION_FACT_EVENTS.has(event.type) && UUID.test(runId) ? { ownerId: null, sessionIds: [runId], taskIds: [] } : null;
}

/** Why a hint made no task, or the task it made. */
export type WikiMaintenanceTriggerOutcome =
  | { made: true; spaceId: string; taskId: string; runId: string; due: WikiMaintenanceDue; expect: string; runSessions: number }
  | {
    made: false;
    spaceId: string;
    why: 'off' | 'unfinished' | 'plan_job_queued' | 'no_new_fact' | 'not_due' | 'nothing_settled' | WikiMaintenanceHeldReason;
  };

/** The rows `considerWikiMaintenance` reads and writes. */
type TriggerDb = PrismaService;

/**
 * Whether a hint makes the space's maintenance task, and the task when it does (contract
 * `maintenance.job.trigger`). Reads first — every refusal is a read — and writes only under the list's
 * lock: the task, its run row, and the cursor's `held` cleared. A held space writes its reason alone.
 */
export async function considerWikiMaintenance(
  prisma: TriggerDb,
  ownerId: string,
  spaceId: string,
  hint: WikiMaintenanceHint,
  now: Date = new Date(),
): Promise<WikiMaintenanceTriggerOutcome> {
  const no = (why: Extract<WikiMaintenanceTriggerOutcome, { made: false }>['why']): WikiMaintenanceTriggerOutcome => ({
    made: false,
    spaceId,
    why,
  });
  const space = await prisma.wikiSpace.findFirst({
    where: { id: spaceId, ownerId },
    select: { id: true, title: true, settings: true },
  });
  if (!space) return no('off');
  const settings = wikiMaintenanceSettings((space.settings as Record<string, unknown> | null)?.maintenance);
  if (!settings.enabled || !settings.workspaceId || !settings.listId) return no('off');
  const listId = settings.listId;
  // Cheap first: a run that has not ended is the one this fact waits for.
  if (await unfinishedTask(prisma, ownerId, listId)) return no('unfinished');
  // And a plan job that waits for the list goes before the next run.
  if (await hasQueuedWikiPlanJob(prisma, ownerId, spaceId)) return no('plan_job_queued');

  const scope = await spaceScope(prisma, ownerId, spaceId);
  const cursor = await cursorOf(prisma, ownerId, spaceId);
  const watermark: FactPosition | null = cursor.positionAt && cursor.positionKind && cursor.positionRef
    ? { at: cursor.positionAt, kind: cursor.positionKind as FactPosition['kind'], ref: cursor.positionRef }
    : null;

  // A new fact: the hint names a fact of this space that is still after the cursor.
  const sessionIds = hint.sessionIds.filter((id) => UUID.test(id));
  const taskIds = hint.taskIds.filter((id) => UUID.test(id));
  if (sessionIds.length === 0 && taskIds.length === 0) return no('no_new_fact');
  if (scope.workspaceIds.length === 0 && scope.projectIds.length === 0) return no('no_new_fact');
  const named = await prisma.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS "one" FROM (${factsSql(scope, watermark)}) f
     WHERE ${afterSql(watermark)}
       AND (f."sessionId" = ANY(${sessionIds}::text[])
         OR (f."kind" = 'task_terminal' AND f."ref" = ANY(${taskIds}::text[])))
     LIMIT 1`;
  if (named.length === 0) return no('no_new_fact');

  const backlog = await countBacklog(prisma, scope, watermark);
  const due = maintenanceDue(backlog, now);
  if (!due.backlog && !due.age) return no('not_due');

  // The day's runs, and — Manual — the review queue's room.
  const today = await wikiMaintenanceRunsToday(prisma, ownerId, spaceId, now);
  if (today.remaining <= 0) {
    await hold(prisma, cursor.id, cursor.heldReason, 'daily_limit_reached', now);
    return no('daily_limit_reached');
  }
  const mode = wikiSpaceSettings(space.settings).reviewMode;
  const runSessions = wikiMaintenanceRunSessions({
    mode,
    activeEntries: mode === 'manual' ? 0 : await prisma.wikiEntry.count({ where: { ownerId, spaceId, status: 'active' } }),
    pendingInSpace: mode === 'manual'
      ? await prisma.wikiChangesetOp.count({ where: { ownerId, decision: 'pending', spotCheck: false, changeset: { spaceId } } })
      : 0,
  });
  if (runSessions <= 0) {
    await hold(prisma, cursor.id, cursor.heldReason, 'review_queue_full', now);
    return no('review_queue_full');
  }

  // The position the run is expected to reach: the next `runSessions` sessions' facts after the cursor
  // that are past the grace a fact is given to commit — the very walk a dossier page makes, so a run
  // paging from the same cursor reaches exactly this.
  const settled = new Date(now.getTime() - WIKI_MAINTENANCE_RULES.settleGraceSeconds * 1000);
  const scanned = await factsAfter(prisma, scope, watermark, settled, PAGE_FACT_SCAN);
  const expect = pageOf(scanned, watermark, runSessions, scanned.length === PAGE_FACT_SCAN).end;
  if (!expect || comparePositions(expect, watermark) <= 0) return no('nothing_settled');
  const token = encodeCursorToken(spaceId, expect);
  const why: WikiMaintenanceDue = due.backlog ? 'backlog' : 'age';

  const made = await new MaintenanceTaskWriter(prisma).makeTask({
    ownerId,
    spaceId,
    listId,
    cursorId: cursor.id,
    now,
    task: {
      title: `Wiki maintenance: ${space.title}`,
      description: maintenanceTaskPrompt({
        spaceRef: uuidToBase62(spaceId),
        title: space.title,
        why,
        sessions: backlog.pendingSessions,
        oldest: backlog.oldestPendingAt,
        runSessions,
      }),
      acceptanceCommand: wikiMaintenanceCheckCommand(uuidToBase62(spaceId), token),
      workspaceId: settings.workspaceId,
      provider: settings.provider,
    },
    run: {
      due: why,
      backlog: backlog.backlog,
      pendingSessions: backlog.pendingSessions,
      oldestPendingAt: backlog.oldestPendingAt,
      expect,
    },
  });
  if ('why' in made) return no(made.why);
  return { made: true, spaceId, taskId: made.taskId, runId: made.runId, due: why, expect: token, runSessions };
}

/**
 * The one writer of a maintenance task: a class only so that its retry is labelled like every other. The
 * list row is locked before any task of it is read or written (rank 20, ahead of the task and the wiki
 * rows), and read again under that lock: of two facts arriving together, the second finds the first one's
 * task, a plan job queued meanwhile is found and goes first, and the day's limit is counted once more with
 * the lock held.
 */
class MaintenanceTaskWriter {
  private readonly logger = new Logger('WikiMaintenanceTrigger');

  constructor(private readonly prisma: PrismaService) {}

  async makeTask(input: {
    ownerId: string;
    spaceId: string;
    listId: string;
    cursorId: string;
    now: Date;
    task: { title: string; description: string; acceptanceCommand: string; workspaceId: string; provider: string };
    run: { due: WikiMaintenanceDue; backlog: number; pendingSessions: number; oldestPendingAt: Date | null; expect: FactPosition };
  }): Promise<{ taskId: string; runId: string } | { why: 'off' | 'unfinished' | 'plan_job_queued' | 'daily_limit_reached' }> {
    const { ownerId, spaceId, listId, now } = input;
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const [list] = await tx.$queryRaw<Array<{ paused: boolean }>>`
          SELECT "paused" FROM "task_list" WHERE "id" = ${listId}::uuid AND "owner_id" = ${ownerId}::uuid FOR NO KEY UPDATE`;
        if (!list) return { why: 'off' } as const;
        if (await unfinishedTask(tx, ownerId, listId)) return { why: 'unfinished' } as const;
        if (await hasQueuedWikiPlanJob(tx, ownerId, spaceId)) return { why: 'plan_job_queued' } as const;
        if ((await wikiMaintenanceRunsToday(tx, ownerId, spaceId, now)).remaining <= 0) return { why: 'daily_limit_reached' } as const;
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
              "The space's cursor reached the position this task expects, and the server refused none of the run's ops "
              + '(`orbit wiki check` exits 0).',
            acceptanceCommand: input.task.acceptanceCommand,
            acceptanceExpectedExitCode: 0,
            acceptanceTimeoutSeconds: WIKI_MAINTENANCE_JOB.checkTimeoutSeconds,
            completionCriterion: 'EXECUTABLE',
            completionFenceRevision: TASK_COMPLETION_FENCE_REVISION,
          },
          select: { id: true },
        });
        const run = await tx.wikiMaintenanceRun.create({
          data: {
            spaceId,
            ownerId,
            taskId: task.id,
            due: input.run.due,
            backlog: input.run.backlog,
            pendingSessions: input.run.pendingSessions,
            oldestPendingAt: input.run.oldestPendingAt,
            expectAt: input.run.expect.at,
            expectKind: input.run.expect.kind,
            expectRef: input.run.expect.ref,
          },
          select: { id: true },
        });
        await tx.wikiCursor.updateMany({ where: { id: input.cursorId }, data: { heldReason: null, heldAt: null } });
        return { taskId: task.id, runId: run.id };
      },
      loggedRetry(this.logger, 'wiki.maintenanceTask'),
    );
  }
}

/** The space's cursor row, made the first time a fact asks about the space. */
async function cursorOf(prisma: TriggerDb, ownerId: string, spaceId: string) {
  const select = { id: true, positionAt: true, positionKind: true, positionRef: true, heldReason: true } as const;
  try {
    return await prisma.wikiCursor.upsert({
      where: { spaceId_source: { spaceId, source: 'facts' } },
      create: { spaceId, ownerId, source: 'facts' },
      update: {},
      select,
    });
  } catch (error) {
    // Two facts of a space that has no cursor row yet: the other one made it.
    if ((error as { code?: string }).code !== 'P2002') throw error;
    return prisma.wikiCursor.findFirstOrThrow({ where: { spaceId, source: 'facts' }, select });
  }
}

async function unfinishedTask(db: Pick<Prisma.TransactionClient, 'task'>, ownerId: string, listId: string): Promise<boolean> {
  return (await db.task.findFirst({ where: { ownerId, listId, status: { in: ['OPEN', 'IN_PROGRESS'] } }, select: { id: true } })) !== null;
}

/** Say on the cursor row why a due space made no task; the first fact held for a reason keeps its time. */
async function hold(
  prisma: TriggerDb,
  cursorId: string,
  current: string | null,
  reason: WikiMaintenanceHeldReason,
  now: Date,
): Promise<void> {
  if (current === reason) return;
  await prisma.wikiCursor.updateMany({ where: { id: cursorId }, data: { heldReason: reason, heldAt: now } });
}

/** What the maintenance session reads as its task (UI copy and prompts are English). */
function maintenanceTaskPrompt(input: {
  spaceRef: string;
  title: string;
  why: WikiMaintenanceDue;
  sessions: number;
  oldest: Date | null;
  runSessions: number;
}): string {
  const because = input.why === 'backlog'
    ? `${input.sessions} sessions have facts the wiki has not taken in`
    : `its oldest fact the wiki has not taken in is from ${input.oldest?.toISOString() ?? 'more than a day ago'}`;
  return [
    `A Wiki maintenance run of the space «${input.title}» (${input.spaceRef}): ${because}. This run covers the next `
      + `${input.runSessions} of those sessions.`,
    '',
    'Run this once, with the Bash tool, and let it finish — it can take a while, and it prints what it did:',
    '',
    `    orbit wiki maintain --space ${input.spaceRef}`,
    '',
    'It reads the dossiers since the cursor, has the local model extract entries from them, checks and proposes '
      + 'them, has them verified when the space is Automatic, re-verifies the anchors, rewrites only the sections of '
      + "the confirmed plan's documents that the new entries and the repository's changes on origin/main touched — "
      + 'proposing a change to the plan for what fits no section — and advances the cursor. With no confirmed plan it '
      + 'writes no document. Then report it: task_progress_report with where the run ended, and one task_comment with '
      + 'the summary it printed, its token spend included; if it failed, its last lines. Run nothing else, and do not '
      + 'retry a failed run more than once.',
  ].join('\n');
}

/**
 * The trigger's subscription: every event this replica published, read as a hint (`wikiMaintenanceHintFor`)
 * and asked of the owner's spaces whose maintenance is on. An event is published after its write, at most
 * once, and a crash between loses it (docs/watch-contract.md §8): a lost hint is a fact that made no task,
 * which the next fact of the space makes. Hints for one owner are taken one evaluation at a time, those
 * arriving meanwhile merged into the next.
 */
@Injectable()
export class WikiMaintenanceTrigger implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WikiMaintenanceTrigger.name);
  private subscription?: Subscription;
  private readonly waiting = new Map<string, { sessionIds: Set<string>; taskIds: Set<string> }>();
  private readonly draining = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.realtime?.localPublications().subscribe(({ runId, event }) => {
      this.take(runId, event).catch((error) => this.logger.warn(`a hint was not taken: ${(error as Error).message}`));
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
  }

  /** One published event, taken as a hint for its owner. */
  async take(runId: string, event: NormalizedRunEvent): Promise<void> {
    const hint = wikiMaintenanceHintFor(runId, event);
    if (!hint) return;
    let ownerId = hint.ownerId;
    if (!ownerId) {
      const session = await this.prisma.session.findFirst({ where: { id: hint.sessionIds[0] }, select: { ownerId: true } });
      if (!session) return;
      ownerId = session.ownerId;
    }
    const waiting = this.waiting.get(ownerId) ?? { sessionIds: new Set<string>(), taskIds: new Set<string>() };
    for (const id of hint.sessionIds) waiting.sessionIds.add(id);
    for (const id of hint.taskIds) waiting.taskIds.add(id);
    this.waiting.set(ownerId, waiting);
    if (!this.draining.has(ownerId)) {
      const owner = ownerId;
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
        await this.evaluate(ownerId, { sessionIds: [...next.sessionIds], taskIds: [...next.taskIds] });
      } catch (error) {
        this.logger.warn(`the maintenance trigger of an owner's spaces failed: ${(error as Error).message}`);
      }
    }
  }

  /**
   * The owner's spaces whose maintenance is on, each asked about the hint — and a space whose plan job
   * waits for its free list has the job's task made in the run's place, whether or not the job heard the
   * list's last task end.
   */
  async evaluate(ownerId: string, hint: WikiMaintenanceHint, now: Date = new Date()): Promise<WikiMaintenanceTriggerOutcome[]> {
    if (!wikiOnFor(currentWikiRollout(), ownerId)) return [];
    const spaces = await this.prisma.wikiSpace.findMany({
      where: { ownerId, settings: { path: ['maintenance', 'enabled'], equals: true } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const outcomes: WikiMaintenanceTriggerOutcome[] = [];
    for (const space of spaces) {
      const outcome = await considerWikiMaintenance(this.prisma, ownerId, space.id, hint, now);
      if (outcome.made) {
        this.logger.log(`space ${space.id}: made maintenance task ${outcome.taskId} (${outcome.due})`);
        this.realtime?.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: [outcome.taskId], resync: false });
      } else if (outcome.why === 'plan_job_queued') {
        const made = await resumeWikiPlanJobs(this.prisma, ownerId, { spaceId: space.id, states: ['queued'] }, now);
        if (made.length > 0) {
          this.logger.log(`space ${space.id}: made plan job tasks ${made.join(', ')} before the next maintenance run`);
          this.realtime?.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: made, resync: false });
        }
      }
      outcomes.push(outcome);
    }
    return outcomes;
  }
}

// ── The run's four routes ───────────────────────────────────────────────────────────────────────

/** The run row of a maintenance session: its task's, made the first time a run of a task nobody's trigger made asks. */
async function runOfSession(prisma: PrismaService, ownerId: string, spaceId: string, sessionId: string) {
  const session = await prisma.session.findFirst({ where: { id: sessionId, ownerId }, select: { taskId: true } });
  if (!session?.taskId) return null;
  return prisma.wikiMaintenanceRun.upsert({
    where: { taskId: session.taskId },
    create: { spaceId, ownerId, taskId: session.taskId },
    update: {},
  });
}

/**
 * Where a maintenance run starts (contract `maintenance.job.context`): the space and its repository, the
 * guardrails' numbers, the workspace whose checkout the run works in, the topics an entry may name, and —
 * for a task a fact made — the position its check expects. Records that the run started, and which
 * session it is.
 */
export async function wikiMaintenanceRunContext(
  prisma: PrismaService,
  ownerId: string,
  spaceId: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<WikiMaintenanceRunContext> {
  const space = await prisma.wikiSpace.findFirstOrThrow({
    where: { id: spaceId, ownerId },
    select: { id: true, title: true, repoUrlNorm: true, rootCommitSha: true, settings: true },
  });
  const settings = wikiSpaceSettings(space.settings);
  const workspace = settings.maintenance.workspaceId
    ? await prisma.workspace.findFirst({ where: { id: settings.maintenance.workspaceId, ownerId }, select: { id: true, workDir: true } })
    : null;
  const activeEntries = await prisma.wikiEntry.count({ where: { ownerId, spaceId, status: 'active' } });
  const topics = await prisma.wikiTopic.findMany({
    where: { ownerId, spaceId },
    select: { slug: true, title: true, description: true },
    orderBy: { createdAt: 'asc' },
  });
  const run = await runOfSession(prisma, ownerId, spaceId, sessionId);
  if (run) {
    await prisma.wikiMaintenanceRun.updateMany({ where: { id: run.id }, data: { sessionId, startedAt: now } });
  }
  const expect = run?.expectAt && run.expectKind && run.expectRef
    ? encodeCursorToken(spaceId, { at: run.expectAt, kind: run.expectKind as FactPosition['kind'], ref: run.expectRef })
    : null;
  const pendingInSpace = settings.reviewMode === 'manual'
    ? await prisma.wikiChangesetOp.count({ where: { ownerId, decision: 'pending', spotCheck: false, changeset: { spaceId } } })
    : 0;
  return {
    spaceId,
    title: space.title,
    repo: { urlNorm: space.repoUrlNorm, rootCommitSha: space.rootCommitSha },
    reviewMode: settings.reviewMode,
    activeEntries,
    breaker: { minActiveEntries: WIKI_REVIEW_RULES.breakerMinActiveEntries, maxChangedPercent: WIKI_REVIEW_RULES.breakerMaxChangedPercent },
    workspace: workspace ? { id: workspace.id, workDir: workspace.workDir } : null,
    topics: topics.length > 0
      ? topics.map((topic) => ({ slug: topic.slug, title: topic.title, description: topic.description }))
      : WIKI_DEFAULT_TOPICS.map((topic) => ({ slug: topic.slug, title: topic.title, description: topic.description })),
    taskId: run?.taskId ?? null,
    expect,
    runSessions: wikiMaintenanceRunSessions({ mode: settings.reviewMode, activeEntries, pendingInSpace }),
  };
}

/** What a run says when it ends (contract `maintenance.job.finish`). */
export interface WikiMaintenanceFinishInput {
  to?: string | null;
  outcome?: WikiCursorOutcome;
  error?: string | null;
  report?: Record<string, unknown> | null;
}

/** The most a report may weigh as JSON: counts and a few short strings. */
const REPORT_MAX_BYTES = 16_000;

/**
 * A run ends: the cursor is advanced as `advanceCursor` rules (only a succeeded run moves it, forward
 * only), and what the run reported is kept on its row — with the outcome the cursor made of it, so a
 * succeeded run whose token the cursor refused is kept as failed.
 */
export async function finishWikiMaintenanceRun(
  prisma: PrismaService,
  maintenance: WikiMaintenance,
  ownerId: string,
  spaceId: string,
  sessionId: string,
  input: WikiMaintenanceFinishInput,
  now: Date = new Date(),
): Promise<{ advanced: boolean; outcome: WikiCursorOutcome; state: WikiCursorState }> {
  const outcome = input.outcome ?? 'succeeded';
  if (!(WIKI_CURSOR_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new BadRequestException(`outcome must be one of ${WIKI_CURSOR_OUTCOMES.join(', ')}`);
  }
  const report = input.report ?? null;
  if (report !== null && (typeof report !== 'object' || Array.isArray(report))) {
    throw new BadRequestException('report must be an object: what the run did, in counts');
  }
  if (report !== null && Buffer.byteLength(JSON.stringify(report), 'utf8') > REPORT_MAX_BYTES) {
    throw new BadRequestException(`report is at most ${REPORT_MAX_BYTES} bytes of JSON: counts, not content`);
  }
  const refused = opsRefusedOf(report);
  try {
    const answer = await maintenance.advanceCursor(ownerId, spaceId, { to: input.to ?? '', outcome, error: input.error ?? null }, now);
    await noteWikiMaintenanceRunEnd(prisma, ownerId, spaceId, sessionId, { outcome, error: input.error ?? null, report, opsRefused: refused }, now);
    return answer;
  } catch (error) {
    const said = (error as { response?: { message?: unknown } }).response?.message;
    await noteWikiMaintenanceRunEnd(prisma, ownerId, spaceId, sessionId, {
      outcome: 'failed',
      error: `the cursor refused the run's advance: ${typeof said === 'string' ? said : (error as Error).message}`,
      report,
      opsRefused: refused,
    }, now);
    throw error;
  }
}

/** `report.ops.refused` when the report says it, else null: a run that says nothing of its ops proved nothing. */
function opsRefusedOf(report: Record<string, unknown> | null): number | null {
  const ops = report?.ops as { refused?: unknown } | undefined;
  return typeof ops?.refused === 'number' && Number.isInteger(ops.refused) && ops.refused >= 0 ? ops.refused : null;
}

/**
 * Keep how a maintenance session's run ended on its run row. The cursor route calls it too, for the
 * failed or truncated run the runner reports there when a run is cut short.
 */
export async function noteWikiMaintenanceRunEnd(
  prisma: PrismaService,
  ownerId: string,
  spaceId: string,
  sessionId: string,
  end: { outcome: WikiCursorOutcome; error: string | null; report?: Record<string, unknown> | null; opsRefused?: number | null },
  now: Date = new Date(),
): Promise<void> {
  const run = await runOfSession(prisma, ownerId, spaceId, sessionId);
  if (!run) return;
  const error = redactSecrets((end.error ?? '').trim()).text.slice(0, 2000).trim() || null;
  await prisma.wikiMaintenanceRun.updateMany({
    where: { id: run.id },
    data: {
      sessionId,
      startedAt: run.startedAt ?? now,
      endedAt: now,
      outcome: end.outcome,
      error,
      ...(end.report !== undefined ? { report: (end.report ?? Prisma.DbNull) as Prisma.InputJsonValue } : {}),
      ...(end.opsRefused !== undefined ? { opsRefused: end.opsRefused } : {}),
    },
  });
}

/**
 * `orbit wiki check` (contract `maintenance.job.check`): did the run of the task that expects this
 * position do what it was made for — the cursor at or past the position, and the run ended succeeded
 * with none of its ops refused. The run is the latest one whose task expects exactly this position.
 */
export async function wikiMaintenanceCheck(
  prisma: PrismaService,
  ownerId: string,
  spaceId: string,
  expectToken: string,
): Promise<WikiMaintenanceCheck> {
  const expect = decodeCursorToken(expectToken, spaceId);
  if (!expect) throw new BadRequestException('expect-cursor names no position: it is the token a maintenance task was made with');
  const cursor = await prisma.wikiCursor.findFirst({
    where: { spaceId, ownerId, source: 'facts' },
    select: { positionAt: true, positionKind: true, positionRef: true },
  });
  const position: FactPosition | null = cursor?.positionAt && cursor.positionKind && cursor.positionRef
    ? { at: cursor.positionAt, kind: cursor.positionKind as FactPosition['kind'], ref: cursor.positionRef }
    : null;
  const reached = comparePositions(position, expect) >= 0;
  const run = await prisma.wikiMaintenanceRun.findFirst({
    where: { ownerId, spaceId, expectAt: expect.at, expectKind: expect.kind, expectRef: expect.ref },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { taskId: true, sessionId: true, outcome: true, opsRefused: true, endedAt: true, error: true },
  });
  const problems: string[] = [];
  if (!reached) {
    problems.push(position
      ? "The space's cursor stands before the position this task expects: the run did not get through its dossiers, or did not advance the cursor."
      : "The space's cursor has never moved: no run of it advanced the cursor.");
  }
  if (!run) {
    problems.push('No maintenance task of this space expects this position.');
  } else if (run.outcome === null) {
    problems.push('The run has not said how it ended: it did not finish, or was cut short before it could.');
  } else if (run.outcome !== 'succeeded') {
    problems.push(`The run ended ${run.outcome}${run.error ? `: ${run.error}` : '.'}`);
  } else if (run.opsRefused === null) {
    problems.push("The run said nothing of its ops, so none of them is known to have passed the server's checks.");
  } else if (run.opsRefused > 0) {
    problems.push(`The server refused ${run.opsRefused} of the run's ops.`);
  }
  return {
    spaceId,
    expect: encodeCursorToken(spaceId, expect),
    position: position ? encodeCursorToken(spaceId, position) : null,
    reached,
    run: run
      ? {
        taskId: run.taskId,
        sessionId: run.sessionId,
        outcome: (run.outcome as WikiCursorOutcome | null) ?? null,
        opsRefused: run.opsRefused,
        endedAt: run.endedAt?.toISOString() ?? null,
      }
      : null,
    ok: problems.length === 0,
    problems,
  };
}

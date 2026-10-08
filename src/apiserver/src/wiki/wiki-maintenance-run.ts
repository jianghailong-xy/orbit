import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import {
  RunEventType,
  WIKI_CURSOR_OUTCOMES,
  WIKI_DEFAULT_TOPICS,
  WIKI_MAINTENANCE_FAILURE_KINDS,
  WIKI_MAINTENANCE_JOB,
  WIKI_MAINTENANCE_RECOVERY,
  WIKI_MAINTAIN_JOB,
  WIKI_MAINTENANCE_RULES,
  WIKI_REVIEW_RULES,
  isRetryableApiErrorText,
  uuidToBase62,
  wikiMaintenanceCheckCommand,
  wikiMaintenanceRunSessions,
  wikiMaintenanceSettings,
  wikiSpaceSettings,
  type NormalizedRunEvent,
  type WikiCursorOutcome,
  type WikiCursorState,
  type WikiMaintenanceCatchUp,
  type WikiMaintenanceCheck,
  type WikiMaintenanceDue,
  type WikiMaintenanceFailureKind,
  type WikiMaintenanceHeldReason,
  type WikiMaintenanceRunContext,
} from '@orbit/shared';
import type { Subscription } from 'rxjs';
import { redactSecrets } from '../common/secret-redaction';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TASK_COMPLETION_FENCE_REVISION } from '../tasks/task-completion-criterion';
import { TASK_OCCUPYING } from '../tasks/reclaim-stalled-task';
import { queueWikiArticlesAfterRun, queueWikiArticlesAfterSessionRun } from './wiki-articles-jobs';
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
import { WIKI_RUN_BASH_TIMEOUT, wikiMaintenanceCatchUpOf, wikiMaintenanceRunsToday, wikiRunCutOff } from './wiki-maintenance-session';
import { wikiMaintenanceProviderIsLocal } from './wiki-maintenance-settings';
import { currentWikiExecutorSwitch, wikiExecutorServes } from './wiki-executor-switch';
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
 *
 * A TASK THAT DIED HOLDS THE LIST NO MORE (contract `maintenance.job.recovery`). A task whose session
 * ended while the task stayed OPEN — reaped `runner offline` while its runner restarted, an engine that
 * never came up — has nothing that will ever start it again: the dispatcher's automatic scans start a task
 * that has prerequisites, or one of a project, or one whose runAt is due, and a maintenance task is none
 * of those once its first dispatch consumed its runAt; and the reaper arms no retry of a session whose
 * task opts into auto-run, leaving it to those very scans. On 2026-10-02 such a task held the list for
 * four hours, every fact answered `unfinished`. So before anything else, every hint settles the list's
 * dead tasks: one that died of the platform (`infra`) is given a runAt, `rerunAfterMinutes` after its
 * session ended, and the dispatcher starts it again, once; any other, or one whose rerun died too, is
 * closed FAILED with its run's end written down. And a run whose task ended without the run saying how is
 * given that end, so no row is left without one.
 *
 * A SPACE THAT IS BEHIND CATCHES UP (contract `maintenance.job.catchUp`, criterion 3 revision 4). On 2026-10-02
 * the cursor stood thirteen days behind with nearly two thousand facts pending, and eight runs a day — the
 * failed ones counted — never caught up. So while the oldest pending fact is more than a day old, the end of
 * the space's latest run is itself the fact that makes the next one; a run on a local endpoint, or one that
 * failed, is not counted against the day; and the run writes no document, which waits for the first run after
 * the space has caught up. Read off the facts and the runs' own ends when a hint arrives — still no clock — and
 * paused once the space's last three runs all failed, until a run succeeds: a pause gives the day its limit
 * back, and a run's end makes nothing.
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

/**
 * Why a hint made no task, or the run it made — and, only when it did any, what settling the list's dead
 * tasks did first (`settled`). Exactly one of `taskId` and `jobId` names the maker (contract
 * `maintenance.job.server`, P8): a maintenance task under the runner executor, or a `maintain` wiki job
 * under an account the server executes.
 */
export type WikiMaintenanceTriggerOutcome =
  | {
    made: true;
    spaceId: string;
    /** The maintenance task made, under the runner executor; null when the server's job was made. */
    taskId: string | null;
    /** The `maintain` job made, under server execution; null when a task was. */
    jobId: string | null;
    runId: string;
    due: WikiMaintenanceDue;
    expect: string;
    runSessions: number;
    /** How the run was made (contract `maintenance.job.catchUp`): null while the space was not behind. */
    catchUp: WikiMaintenanceCatchUp | null;
    settled?: WikiMaintenanceSettled;
  }
  | {
    made: false;
    spaceId: string;
    why: 'off' | 'unfinished' | 'plan_job_queued' | 'no_new_fact' | 'not_due' | 'nothing_settled' | WikiMaintenanceHeldReason;
    settled?: WikiMaintenanceSettled;
  };

/** The rows `considerWikiMaintenance` reads and writes. */
type TriggerDb = PrismaService;

/**
 * Whether a hint makes the space's maintenance task, and the task when it does (contract
 * `maintenance.job.trigger`). Reads first — every refusal is a read — and writes only under the list's
 * lock: the task, its run row, and the cursor's `held` cleared. A held space writes its reason alone.
 *
 * AN ACCOUNT THE SERVER EXECUTES MAKES A JOB, NOT A TASK (contract `maintenance.job.server`, P8): the same
 * reads decide the same thing — due, the day's runs, the room, the position — and the writer makes a
 * `wiki_job` (`maintain`) with the run row that names it, under the space's lock. No task and no session
 * are made, no provider is asked for, and the hidden list is not required to exist: a workspace and the
 * space's own on-switch are all the run needs. Under the default `runner` everything here is unchanged.
 */
export async function considerWikiMaintenance(
  prisma: TriggerDb,
  ownerId: string,
  spaceId: string,
  hint: WikiMaintenanceHint,
  now: Date = new Date(),
): Promise<WikiMaintenanceTriggerOutcome> {
  let recovered: WikiMaintenanceSettled | undefined;
  const no = (why: Extract<WikiMaintenanceTriggerOutcome, { made: false }>['why']): WikiMaintenanceTriggerOutcome => ({
    made: false,
    spaceId,
    why,
    ...(recovered ? { settled: recovered } : {}),
  });
  const space = await prisma.wikiSpace.findFirst({
    where: { id: spaceId, ownerId },
    select: { id: true, title: true, settings: true },
  });
  if (!space) return no('off');
  const settings = wikiMaintenanceSettings((space.settings as Record<string, unknown> | null)?.maintenance);
  // The server's path needs the space turned on and a workspace to read the repository from; a list it has
  // none of, since it makes no task. The runner's path is what it always was.
  const onServer = wikiExecutorServes(currentWikiExecutorSwitch(), ownerId);
  if (!settings.enabled || !settings.workspaceId || (!onServer && !settings.listId)) return no('off');
  const listId = settings.listId;
  // A task of the list that died is started again or closed before anything else is asked: it holds the
  // list no more (contract `maintenance.job.recovery`). Its own session's end is the hint that gets here.
  const settling = listId ? await settleWikiMaintenanceList(prisma, ownerId, spaceId, listId, now) : { rerun: [], closed: [] };
  if (settling.rerun.length > 0 || settling.closed.length > 0) recovered = settling;
  // Cheap first: a run that has not ended is the one this fact waits for — the list's open task, or the
  // server's own unfinished job.
  if (listId && (await unfinishedTask(prisma, ownerId, listId))) return no('unfinished');
  if (await unfinishedMaintainJob(prisma, ownerId, spaceId)) return no('unfinished');
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
  // A hint that names no fact may name the end of the space's latest run, which is a fact of its own while the
  // space catches up (contract `maintenance.job.catchUp.trigger`) — and only then, as the catch-up read below says.
  const runEnded = named.length === 0 && (await namesLatestRunEnd(prisma, ownerId, spaceId, sessionIds, taskIds));
  if (named.length === 0 && !runEnded) return no('no_new_fact');

  const backlog = await countBacklog(prisma, scope, watermark);
  const catchUp = await wikiMaintenanceCatchUpOf(prisma, ownerId, spaceId, backlog.oldestPendingAt, now);
  if (runEnded && catchUp.state !== 'active') return no('no_new_fact');
  const due = maintenanceDue(backlog, now);
  if (!due.backlog && !due.age) return no('not_due');

  // The day's runs, and — Manual — the review queue's room. A run made in active catch-up on a local endpoint is
  // not counted against the day (contract `maintenance.job.catchUp.dailyLimit`), so the day holds it back no more.
  // A run the server executes has no provider to read: its endpoint is the System model's, whose locality the
  // worker records on the run row when it starts it, and the day is counted as it stands now.
  const localEndpoint = onServer ? false : await wikiMaintenanceProviderIsLocal(prisma, ownerId, settings.provider);
  if (!(catchUp.state === 'active' && localEndpoint) && (await wikiMaintenanceRunsToday(prisma, ownerId, spaceId, now)).remaining <= 0) {
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
  const run = {
    due: why,
    backlog: backlog.backlog,
    pendingSessions: backlog.pendingSessions,
    oldestPendingAt: backlog.oldestPendingAt,
    expect,
    catchUp: catchUp.state,
    localEndpoint,
  };

  if (onServer) {
    const made = await new MaintenanceJobWriter(prisma).makeJob({ ownerId, spaceId, cursorId: cursor.id, now, run });
    if ('why' in made) return no(made.why);
    return {
      made: true,
      spaceId,
      taskId: null,
      jobId: made.jobId,
      runId: made.runId,
      due: why,
      expect: token,
      runSessions,
      catchUp: catchUp.state,
      ...(recovered ? { settled: recovered } : {}),
    };
  }

  const made = await new MaintenanceTaskWriter(prisma).makeTask({
    ownerId,
    spaceId,
    listId: listId!,
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
        catchUp: catchUp.state,
      }),
      acceptanceCommand: wikiMaintenanceCheckCommand(uuidToBase62(spaceId), token),
      workspaceId: settings.workspaceId,
      provider: settings.provider,
    },
    run,
  });
  if ('why' in made) return no(made.why);
  return {
    made: true,
    spaceId,
    taskId: made.taskId,
    jobId: null,
    runId: made.runId,
    due: why,
    expect: token,
    runSessions,
    catchUp: catchUp.state,
    ...(recovered ? { settled: recovered } : {}),
  };
}

/**
 * Whether a hint names the end of the space's latest run (contract `maintenance.job.catchUp.trigger`): that run's
 * task, or one of its sessions, once the task has ended. The run's own events name nothing else of the space — and
 * a run a wiki job ran (task_id NULL, migration 0401) is named by none of them, so it names no next run either.
 */
async function namesLatestRunEnd(
  prisma: TriggerDb,
  ownerId: string,
  spaceId: string,
  sessionIds: string[],
  taskIds: string[],
): Promise<boolean> {
  const latest = await prisma.wikiMaintenanceRun.findFirst({
    where: { ownerId, spaceId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { taskId: true },
  });
  if (!latest?.taskId) return false;
  const named = taskIds.includes(latest.taskId) || (sessionIds.length > 0
    && (await prisma.session.findFirst({ where: { id: { in: sessionIds }, ownerId, taskId: latest.taskId }, select: { id: true } })) !== null);
  if (!named) return false;
  return (await prisma.task.findFirst({
    where: { id: latest.taskId, ownerId, status: { in: ['DONE', 'FAILED', 'CANCELLED'] } },
    select: { id: true },
  })) !== null;
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
    run: {
      due: WikiMaintenanceDue;
      backlog: number;
      pendingSessions: number;
      oldestPendingAt: Date | null;
      expect: FactPosition;
      catchUp: WikiMaintenanceCatchUp | null;
      localEndpoint: boolean;
    };
  }): Promise<{ taskId: string; runId: string } | { why: 'off' | 'unfinished' | 'plan_job_queued' | 'daily_limit_reached' }> {
    const { ownerId, spaceId, listId, now } = input;
    // A run made in active catch-up on a local endpoint is never counted against the day: nothing to count again.
    const counted = !(input.run.catchUp === 'active' && input.run.localEndpoint);
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const [list] = await tx.$queryRaw<Array<{ paused: boolean }>>`
          SELECT "paused" FROM "task_list" WHERE "id" = ${listId}::uuid AND "owner_id" = ${ownerId}::uuid FOR NO KEY UPDATE`;
        if (!list) return { why: 'off' } as const;
        if (await unfinishedTask(tx, ownerId, listId)) return { why: 'unfinished' } as const;
        if (await hasQueuedWikiPlanJob(tx, ownerId, spaceId)) return { why: 'plan_job_queued' } as const;
        if (counted && (await wikiMaintenanceRunsToday(tx, ownerId, spaceId, now)).remaining <= 0) return { why: 'daily_limit_reached' } as const;
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
            catchUp: input.run.catchUp,
            localEndpoint: input.run.localEndpoint,
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

/**
 * The one writer of a maintenance job (contract `maintenance.job.server`, P8): a run the server executes is
 * a `wiki_job` of kind `maintain` with the run row that names it, and no task. The space's row is locked
 * first (rank 60, the lock the run rows and the cursor sit behind), and everything is read again under it:
 * of two facts arriving together, the second finds the first's job, a plan job queued meanwhile is found
 * and goes first, and the day's limit is counted once more with the lock held.
 */
class MaintenanceJobWriter {
  private readonly logger = new Logger('WikiMaintenanceTrigger');

  constructor(private readonly prisma: PrismaService) {}

  async makeJob(input: {
    ownerId: string;
    spaceId: string;
    cursorId: string;
    now: Date;
    run: {
      due: WikiMaintenanceDue;
      backlog: number;
      pendingSessions: number;
      oldestPendingAt: Date | null;
      expect: FactPosition;
      catchUp: WikiMaintenanceCatchUp | null;
      localEndpoint: boolean;
    };
  }): Promise<{ jobId: string; runId: string } | { why: 'off' | 'unfinished' | 'plan_job_queued' | 'daily_limit_reached' }> {
    const { ownerId, spaceId, now } = input;
    const counted = !(input.run.catchUp === 'active' && input.run.localEndpoint);
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const [space] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "wiki_space" WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid FOR NO KEY UPDATE`;
        if (!space) return { why: 'off' } as const;
        if (await unfinishedMaintainJob(tx, ownerId, spaceId)) return { why: 'unfinished' } as const;
        if (await hasQueuedWikiPlanJob(tx, ownerId, spaceId)) return { why: 'plan_job_queued' } as const;
        if (counted && (await wikiMaintenanceRunsToday(tx, ownerId, spaceId, now)).remaining <= 0) return { why: 'daily_limit_reached' } as const;
        // Both ids are the application's: the row must name its maker from the moment it exists (the
        // maker CHECK holds every run row), and the job's input names the run it executes.
        const runId = randomUUID();
        const jobId = randomUUID();
        await tx.wikiMaintenanceRun.create({
          data: {
            id: runId,
            spaceId,
            ownerId,
            jobId,
            due: input.run.due,
            backlog: input.run.backlog,
            pendingSessions: input.run.pendingSessions,
            oldestPendingAt: input.run.oldestPendingAt,
            expectAt: input.run.expect.at,
            expectKind: input.run.expect.kind,
            expectRef: input.run.expect.ref,
            catchUp: input.run.catchUp,
            localEndpoint: input.run.localEndpoint,
          },
          select: { id: true },
        });
        const job = await tx.wikiJob.create({
          data: {
            id: jobId,
            ownerId,
            spaceId,
            kind: 'maintain',
            // The run the job executes: what it is for is the run row's, and the row is the job's.
            input: { runId },
            priority: WIKI_MAINTAIN_JOB.priority,
            state: 'queued',
          },
          select: { id: true },
        });
        await tx.wikiCursor.updateMany({ where: { id: input.cursorId }, data: { heldReason: null, heldAt: null } });
        return { jobId: job.id, runId };
      },
      loggedRetry(this.logger, 'wiki.maintenanceJob'),
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

/**
 * Whether the space's server-executed maintenance has a run that has not ended: a `maintain` job queued,
 * running or parked on its repository (contract `maintenance.job.server`, P8). It is the task check's
 * counterpart — one run of a space at a time — and the fact that arrives while one waits is answered
 * `unfinished`, exactly as it is for a list whose task is open.
 */
async function unfinishedMaintainJob(
  db: Pick<Prisma.TransactionClient, 'wikiJob'>,
  ownerId: string,
  spaceId: string,
): Promise<boolean> {
  return (await db.wikiJob.findFirst({
    where: { ownerId, spaceId, kind: WIKI_MAINTAIN_JOB.kind, state: { in: ['queued', 'running', 'waiting'] } },
    select: { id: true },
  })) !== null;
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

// ── A task of the list that died ────────────────────────────────────────────────────────────────

const OPEN_TASK = ['OPEN', 'IN_PROGRESS'] as const;
const OCCUPYING: ReadonlySet<string> = new Set<string>(TASK_OCCUPYING);

/** The end a run whose task ended before it said how is given (contract `maintenance.job.recovery.orphan`). */
export const WIKI_RUN_NOT_REPORTED = 'The run did not report its end.';

/** The claim's refusal of a run (wiki-maintenance-session.ts): a setting, which a rerun would be refused again for. */
const REFUSED_AT_CLAIM = /^This Wiki maintenance run did not start\b/u;

/**
 * Words that say a session's end was the platform's: the reaper's `runner offline` and `<provider> runtime
 * not initialized`, a disk that filled, a server that answered 5xx or did not answer, an overloaded provider.
 */
const INFRA_WORDS: readonly RegExp[] = [
  /\brunner offline\b/iu,
  /\bruntime not initialized\b/iu,
  /\bno space left on device\b|\benospc\b|\bdisk (?:is )?full\b/iu,
  /\b(?:internal server error|bad gateway|service unavailable|gateway timeout)\b/iu,
  /->\s*5\d\d\b/u,
  /\b(?:status|http|answered|returned|api error:?)\s*5\d\d\b/iu,
  /\b(?:econnrefused|econnreset|etimedout|ehostunreach|enetunreach|epipe)\b/iu,
  /\b(?:socket hang up|fetch failed|connection (?:refused|reset|closed)|could not be reached|server (?:is )?unavailable)\b/iu,
  /\boverloaded\b/iu,
];

/** Whose failure a session's end says it was (contract `maintenance.job.recovery.infra` and `content`). */
export function wikiMaintenanceFailureKindOf(text: string | null | undefined): WikiMaintenanceFailureKind {
  const said = (text ?? '').trim();
  if (!said || REFUSED_AT_CLAIM.test(said)) return 'content';
  return INFRA_WORDS.some((words) => words.test(said)) || isRetryableApiErrorText(said) ? 'infra' : 'content';
}

/** What settling the list did: the tasks started again, and the tasks closed. */
export interface WikiMaintenanceSettled {
  rerun: string[];
  closed: string[];
}

/** How a task's work came to stop, read off its latest session, when nothing can work the task any more. */
interface Death {
  status: RunStatus;
  error: string | null;
  endReason: string | null;
  numTurns: number;
  /** When the latest session ended. */
  at: Date;
  /** How many sessions the task has had: a rerun is one more. */
  sessions: number;
}

/**
 * The task's death, or null while something can still work it: a session PENDING, RUNNING, AWAITING_INPUT
 * or INTERRUPTED, or one whose own retry is armed (AutoRetryService resumes it) — and null for a task no
 * session has run yet, whose dispatch is still to come (contract `maintenance.job.recovery.deadTask`).
 */
async function deathOf(db: Pick<Prisma.TransactionClient, 'session'>, ownerId: string, taskId: string, now: Date): Promise<Death | null> {
  const sessions = await db.session.findMany({
    where: { ownerId, taskId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      status: true,
      error: true,
      endReason: true,
      numTurns: true,
      retryAt: true,
      completedAt: true,
      deletedAt: true,
      finishedAt: true,
      updatedAt: true,
    },
  });
  if (sessions.length === 0) return null;
  const working = sessions.some(
    (one) => one.deletedAt === null && (OCCUPYING.has(one.status) || (one.retryAt !== null && one.completedAt === null)),
  );
  if (working) return null;
  const latest = sessions[0]!;
  return {
    status: latest.status,
    error: latest.error,
    endReason: latest.endReason,
    numTurns: latest.numTurns,
    at: latest.finishedAt ?? latest.updatedAt ?? now,
    sessions: sessions.length,
  };
}

/** A run row as the settling reads it. */
interface RunEnd {
  id: string;
  outcome: string | null;
  failureKind: string | null;
  error: string | null;
  startedAt: Date | null;
  lastStartedAt: Date | null;
  reruns: number;
}

/**
 * Whose failure a death was, and why, in the words the run row keeps. What the run itself said of its end
 * comes first — its latest attempt reported before its session died — and the session's end otherwise: a
 * session somebody stopped is not the platform's, and one whose engine never answered a turn is.
 */
function verdictOf(death: Death, run: RunEnd | null): { kind: WikiMaintenanceFailureKind; reason: string } {
  const said = death.error ? redactSecrets(death.error.trim().split('\n', 1)[0]!).text.slice(0, 300).trim() : '';
  const ended = `its session ended ${death.status.toLowerCase().replace('_', ' ')}${said ? `: ${said}` : ''}`;
  if (run?.outcome === 'succeeded') return { kind: 'infra', reason: `The run succeeded, but ${ended} before its check ran.` };
  if (run?.outcome) {
    return { kind: run.failureKind === 'infra' ? 'infra' : 'content', reason: run.error ?? `The run ended ${run.outcome}.` };
  }
  let kind: WikiMaintenanceFailureKind;
  if (death.status === RunStatus.CANCELLED) kind = 'content';
  else if (death.status === RunStatus.FAILED && death.numTurns === 0 && !REFUSED_AT_CLAIM.test(death.error ?? '')) kind = 'infra';
  else kind = wikiMaintenanceFailureKindOf([death.error, death.endReason].filter(Boolean).join(' — '));
  return { kind, reason: `${ended.charAt(0).toUpperCase()}${ended.slice(1)}.` };
}

/**
 * Settle the maintenance list's tasks that died (contract `maintenance.job.recovery`), and give the space's
 * runs whose tasks ended without saying how that end. Reads first — almost always no task of the list is
 * open, or the open one is being worked — and decides each dead task under the list's lock.
 */
export async function settleWikiMaintenanceList(
  prisma: PrismaService,
  ownerId: string,
  spaceId: string,
  listId: string,
  now: Date = new Date(),
): Promise<WikiMaintenanceSettled> {
  const settled: WikiMaintenanceSettled = { rerun: [], closed: [] };
  const open = await prisma.task.findMany({
    where: { ownerId, listId, status: { in: [...OPEN_TASK] }, runAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  for (const task of open) {
    if (!(await deathOf(prisma, ownerId, task.id, now))) continue;
    const done = await new DeadTaskSettler(prisma).settle({ ownerId, listId, taskId: task.id, now });
    if (done === 'rerun') settled.rerun.push(task.id);
    if (done === 'closed') settled.closed.push(task.id);
  }
  await closeOrphanRuns(prisma, ownerId, spaceId);
  return settled;
}

/**
 * The one writer of a dead task's settling: a class only so that its retry is labelled like every other.
 * The list row is locked first (rank 20) — the lock the task maker takes — and the task and its sessions
 * are read again under it, so a task started or ended meanwhile is left as it now is.
 */
class DeadTaskSettler {
  private readonly logger = new Logger('WikiMaintenanceRecovery');

  constructor(private readonly prisma: PrismaService) {}

  async settle(input: { ownerId: string; listId: string; taskId: string; now: Date }): Promise<'rerun' | 'closed' | null> {
    const { ownerId, listId, taskId, now } = input;
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const [list] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "task_list" WHERE "id" = ${listId}::uuid AND "owner_id" = ${ownerId}::uuid FOR NO KEY UPDATE`;
        if (!list) return null;
        const open = await tx.task.findFirst({
          where: { id: taskId, ownerId, listId, status: { in: [...OPEN_TASK] }, runAt: null },
          select: { id: true },
        });
        if (!open) return null;
        const death = await deathOf(tx, ownerId, taskId, now);
        if (!death) return null;
        const run: RunEnd | null = await tx.wikiMaintenanceRun.findUnique({
          where: { taskId },
          select: { id: true, outcome: true, failureKind: true, error: true, startedAt: true, lastStartedAt: true, reruns: true },
        });
        const verdict = verdictOf(death, run);
        // A run that never said how its latest attempt ended says it now: no earlier than that attempt began.
        const began = run?.lastStartedAt ?? run?.startedAt ?? null;
        const end: Prisma.WikiMaintenanceRunUpdateManyMutationInput = run && run.outcome === null
          ? {
            outcome: 'failed',
            failureKind: verdict.kind,
            error: verdict.reason,
            endedAt: began && began > death.at ? began : death.at,
          }
          : {};
        const used = Math.max(run?.reruns ?? 0, death.sessions - 1);
        if (verdict.kind === 'infra' && used < WIKI_MAINTENANCE_RECOVERY.rerunsMax) {
          // Started again by the dispatcher's scheduled scan, a new session on the pinned workspace and
          // provider, once the backoff has passed — and claimed only by its runner, once that is online.
          const at = new Date(Math.max(now.getTime(), death.at.getTime() + WIKI_MAINTENANCE_RECOVERY.rerunAfterMinutes * 60_000));
          const moved = await tx.task.updateMany({
            where: { id: taskId, ownerId, status: { in: [...OPEN_TASK] }, runAt: null },
            data: { runAt: at },
          });
          if (moved.count === 0) return null;
          if (run) await tx.wikiMaintenanceRun.updateMany({ where: { id: run.id }, data: { reruns: used + 1, rerunAt: at, ...end } });
          return 'rerun' as const;
        }
        const closed = await tx.task.updateMany({
          where: { id: taskId, ownerId, status: { in: [...OPEN_TASK] }, runAt: null },
          data: { status: 'FAILED' },
        });
        if (closed.count === 0) return null;
        if (run && run.outcome === null) await tx.wikiMaintenanceRun.updateMany({ where: { id: run.id }, data: end });
        return 'closed' as const;
      },
      loggedRetry(this.logger, 'wiki.maintenanceRecovery'),
    );
  }
}

/**
 * The space's runs whose tasks ended — DONE, FAILED or CANCELLED — before the runs said how: each is given
 * outcome failed, failure kind infra and `WIKI_RUN_NOT_REPORTED`, ended no earlier than it last started.
 * A run that reports its end later still overwrites this, as any later end of a run does.
 */
async function closeOrphanRuns(prisma: PrismaService, ownerId: string, spaceId: string): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "wiki_maintenance_run" r
       SET "outcome" = 'failed', "failure_kind" = 'infra', "error" = ${WIKI_RUN_NOT_REPORTED},
           "ended_at" = GREATEST(t."updated_at" AT TIME ZONE 'UTC', COALESCE(r."last_started_at", r."started_at", r."created_at")),
           "updated_at" = now()
      FROM "task" t
     WHERE r."owner_id" = ${ownerId}::uuid AND r."space_id" = ${spaceId}::uuid AND r."outcome" IS NULL
       AND t."id" = r."task_id" AND t."owner_id" = r."owner_id" AND t."status"::text IN ('DONE', 'FAILED', 'CANCELLED')`;
}

/** What the maintenance session reads as its task (UI copy and prompts are English). */
function maintenanceTaskPrompt(input: {
  spaceRef: string;
  title: string;
  why: WikiMaintenanceDue;
  sessions: number;
  oldest: Date | null;
  runSessions: number;
  catchUp: WikiMaintenanceCatchUp | null;
}): string {
  const because = input.why === 'backlog'
    ? `${input.sessions} sessions have facts the wiki has not taken in`
    : `its oldest fact the wiki has not taken in is from ${input.oldest?.toISOString() ?? 'more than a day ago'}`;
  const behind = input.catchUp === null ? [] : [
    '',
    input.catchUp === 'active'
      ? 'The space is catching up: its oldest fact the wiki has not taken in is more than a day old. This run writes no '
        + 'document and proposes no change to the plan — the first run after the space has caught up rewrites what changed '
        + 'meanwhile — and its end makes the next run.'
      : 'The space is behind, and its catch-up is paused: its last runs all failed. This run writes no document and '
        + 'proposes no change to the plan; it counts against the day, and once a run succeeds the catch-up goes on.',
  ];
  return [
    `A Wiki maintenance run of the space «${input.title}» (${input.spaceRef}): ${because}. This run covers the next `
      + `${input.runSessions} of those sessions.`,
    '',
    `Run this once, with the Bash tool, and let it finish — it can take hours, and it prints what it did. ${WIKI_RUN_BASH_TIMEOUT}:`,
    '',
    `    orbit wiki maintain --space ${input.spaceRef}`,
    '',
    'It reads the dossiers since the cursor, has the local model extract entries from them, checks and proposes '
      + 'them, has them verified when the space is Automatic, re-verifies the anchors, rewrites only the sections of '
      + "the confirmed plan's documents that the new entries and the repository's changes on origin/main touched — "
      + 'proposing a change to the plan for what fits no section — and advances the cursor. With no confirmed plan it '
      + 'writes no document. Then report it: task_progress_report with where the run ended, and one task_comment with '
      + 'the summary it printed, its token spend included; if it failed, its last lines. Run nothing else, and do not '
      + 'retry a failed run more than once. When the Orbit server answers 5xx or not at all, it waits for the server '
      + 'itself before it ends, so a run it says you may run again is safe to run again at once; when it says the '
      + 'server did not come back, do not run it again — the next run takes the dossiers this one did not record.',
    wikiRunCutOff('the next run takes up where this one stopped.'),
    ...behind,
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
      if (outcome.settled) {
        const { rerun, closed } = outcome.settled;
        this.logger.log(`space ${space.id}: dead maintenance tasks — started again ${rerun.join(', ') || 'none'}, closed ${closed.join(', ') || 'none'}`);
        this.realtime?.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: [...rerun, ...closed], resync: false });
      }
      if (outcome.made && outcome.taskId) {
        this.logger.log(`space ${space.id}: made maintenance task ${outcome.taskId} (${outcome.due})`);
        this.realtime?.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: [outcome.taskId], resync: false });
      } else if (outcome.made && outcome.jobId) {
        // A run the server executes is a job and no task: Activity's Runs card is what hears it (P9), through
        // the same `wiki.changed` a write publishes — no task is made, so nothing about a task is announced.
        this.logger.log(`space ${space.id}: made maintenance job ${outcome.jobId} (${outcome.due})`);
        this.realtime?.publishWikiChanged(ownerId, space.id);
      } else if (!outcome.made && outcome.why === 'plan_job_queued') {
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
    // One more start (contract `maintenance.job.recovery.attempts`): the first is kept, and what the attempt
    // before this one said of its end is cleared — the row says how its latest attempt ended, never before
    // the run began. On 2026-10-02 a session's retry overwrote the start, and the row ended before it began.
    await prisma.wikiMaintenanceRun.updateMany({
      where: { id: run.id },
      data: {
        sessionId,
        startedAt: run.startedAt ?? now,
        lastStartedAt: now,
        attempts: { increment: 1 },
        outcome: null,
        endedAt: null,
        error: null,
        failureKind: null,
        opsRefused: null,
        report: Prisma.DbNull,
      },
    });
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
    catchUp: (run?.catchUp as WikiMaintenanceCatchUp | null | undefined) ?? null,
  };
}

/** What a run says when it ends (contract `maintenance.job.finish`). */
export interface WikiMaintenanceFinishInput {
  to?: string | null;
  outcome?: WikiCursorOutcome;
  error?: string | null;
  /** Whose a failure was (contract `maintenance.job.recovery.failureKinds`); read off `error` when it is not said. */
  failureKind?: WikiMaintenanceFailureKind | null;
  report?: Record<string, unknown> | null;
}

/** The most a report may weigh as JSON: counts and a few short strings. */
const REPORT_MAX_BYTES = 16_000;

/**
 * A run ends: the cursor is advanced as `advanceCursor` rules (only a succeeded run moves it, forward
 * only), and what the run reported is kept on its row — with the outcome the cursor made of it, so a
 * succeeded run whose token the cursor refused is kept as failed. A run that moved the cursor when its ops
 * were recorded (`WikiMaintenance.advanceRecorded`) ends with the same token: a success moves nothing more,
 * and a failure is counted with the cursor left where the recorded ops put it.
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
  const { outcome, report, failureKind, refused } = checkedFinish(input);
  try {
    const answer = await maintenance.advanceCursor(ownerId, spaceId, { to: input.to ?? '', outcome, error: input.error ?? null }, now);
    await noteWikiMaintenanceRunEnd(prisma, ownerId, spaceId, sessionId, {
      outcome,
      error: input.error ?? null,
      failureKind,
      report,
      opsRefused: refused,
    }, now);
    // The articles the run's end owes, when the executor gives this account to the server (contract
    // `articles.regeneration`); under the default runner executor nothing is read. Never throws.
    await queueWikiArticlesAfterSessionRun(prisma, { ownerId, spaceId, sessionId });
    return answer;
  } catch (error) {
    const said = (error as { response?: { message?: unknown } }).response?.message;
    await noteWikiMaintenanceRunEnd(prisma, ownerId, spaceId, sessionId, {
      outcome: 'failed',
      error: `the cursor refused the run's advance: ${typeof said === 'string' ? said : (error as Error).message}`,
      failureKind: 'content',
      report,
      opsRefused: refused,
    }, now);
    throw error;
  }
}

/**
 * The same end for a run the server's wiki job ran (contract `maintenance.job.server`, P8): the run row is
 * the job's (`wiki_maintenance_run.job_id`), there is no session, and the articles the end owes are asked
 * of the job's own facts — the run's outcome, how it was made, and whether it recorded an op — through the
 * one entry the owner's decision of 2026-10-08 names (`queueWikiArticlesAfterRun`).
 */
export async function finishWikiMaintenanceJob(
  prisma: PrismaService,
  maintenance: WikiMaintenance,
  ownerId: string,
  spaceId: string,
  jobId: string,
  input: WikiMaintenanceFinishInput,
  now: Date = new Date(),
): Promise<{ advanced: boolean; outcome: WikiCursorOutcome; state: WikiCursorState }> {
  const { outcome, report, failureKind, refused } = checkedFinish(input);
  const run = await prisma.wikiMaintenanceRun.findFirst({
    where: { ownerId, spaceId, jobId },
    select: { catchUp: true },
  });
  const recordedOps = (report?.ops as { recorded?: unknown } | undefined)?.recorded;
  try {
    const answer = await maintenance.advanceCursor(ownerId, spaceId, { to: input.to ?? '', outcome, error: input.error ?? null }, now);
    await noteWikiMaintenanceJobEnd(prisma, ownerId, spaceId, jobId, {
      outcome,
      error: input.error ?? null,
      failureKind,
      report,
      opsRefused: refused,
    }, now);
    await queueWikiArticlesAfterRun(prisma, {
      ownerId,
      spaceId,
      outcome,
      catchUp: run?.catchUp ?? null,
      recordedOps: typeof recordedOps === 'number' && recordedOps > 0,
    });
    return answer;
  } catch (error) {
    const said = (error as { response?: { message?: unknown } }).response?.message;
    await noteWikiMaintenanceJobEnd(prisma, ownerId, spaceId, jobId, {
      outcome: 'failed',
      error: `the cursor refused the run's advance: ${typeof said === 'string' ? said : (error as Error).message}`,
      failureKind: 'content',
      report,
      opsRefused: refused,
    }, now);
    throw error;
  }
}

/** What a finish request is held to before anything is written: the outcome, the report, whose failure it was. */
function checkedFinish(input: WikiMaintenanceFinishInput): {
  outcome: WikiCursorOutcome;
  report: Record<string, unknown> | null;
  failureKind: WikiMaintenanceFailureKind | null;
  refused: number | null;
} {
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
  const failureKind = input.failureKind ?? null;
  if (failureKind !== null && !(WIKI_MAINTENANCE_FAILURE_KINDS as readonly string[]).includes(failureKind)) {
    throw new BadRequestException(`failureKind must be one of ${WIKI_MAINTENANCE_FAILURE_KINDS.join(', ')}`);
  }
  return { outcome, report, failureKind, refused: opsRefusedOf(report) };
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
  end: {
    outcome: WikiCursorOutcome;
    error: string | null;
    /** Whose a failure was: read off the error when it is not said — a runner older than the field — and nothing for a run that succeeded. */
    failureKind?: WikiMaintenanceFailureKind | null;
    report?: Record<string, unknown> | null;
    opsRefused?: number | null;
  },
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
      failureKind: end.outcome === 'succeeded' ? null : (end.failureKind ?? wikiMaintenanceFailureKindOf(error)),
      error,
      ...(end.report !== undefined ? { report: (end.report ?? Prisma.DbNull) as Prisma.InputJsonValue } : {}),
      ...(end.opsRefused !== undefined ? { opsRefused: end.opsRefused } : {}),
    },
  });
}

/**
 * The same, for a run the server's wiki job ran (P8): the row is found by `job_id`, there is no session,
 * and the same fields are kept — whose the failure was, the report, and how many ops the server refused.
 */
export async function noteWikiMaintenanceJobEnd(
  prisma: PrismaService,
  ownerId: string,
  spaceId: string,
  jobId: string,
  end: {
    outcome: WikiCursorOutcome;
    error: string | null;
    failureKind?: WikiMaintenanceFailureKind | null;
    report?: Record<string, unknown> | null;
    opsRefused?: number | null;
  },
  now: Date = new Date(),
): Promise<void> {
  const run = await prisma.wikiMaintenanceRun.findFirst({ where: { ownerId, spaceId, jobId }, select: { id: true, startedAt: true } });
  if (!run) return;
  const error = redactSecrets((end.error ?? '').trim()).text.slice(0, 2000).trim() || null;
  await prisma.wikiMaintenanceRun.updateMany({
    where: { id: run.id },
    data: {
      startedAt: run.startedAt ?? now,
      endedAt: now,
      outcome: end.outcome,
      failureKind: end.outcome === 'succeeded' ? null : (end.failureKind ?? wikiMaintenanceFailureKindOf(error)),
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
 *
 * A run moves the cursor as soon as its ops are recorded (criterion 3 revision 4), so a run that failed after
 * that — at the verification, the anchors or the documents — has a cursor that reached the position and an end
 * that is failed: it does not pass. The cursor stays where it is, and the next run does not read those
 * sessions again; the run is one more failure in a row, and its task fails with it.
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
  } else if (run.outcome !== 'succeeded' && reached) {
    problems.push(`The cursor reached the position, past the sessions whose ops the run recorded — the next run does not `
      + `read them again — but the run ended ${run.outcome} after that${run.error ? `: ${run.error}` : '.'}`);
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

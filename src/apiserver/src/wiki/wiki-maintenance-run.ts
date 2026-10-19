import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  RunEventType,
  WIKI_CURSOR_OUTCOMES,
  WIKI_MAINTENANCE_CATCH_UP,
  WIKI_MAINTENANCE_FAILURE_KINDS,
  WIKI_MAINTAIN_JOB,
  WIKI_MAINTENANCE_RULES,
  isRetryableApiErrorText,
  wikiMaintenanceBehind,
  wikiMaintenanceRunSessions,
  wikiMaintenanceSettings,
  wikiSpaceSettings,
  type NormalizedRunEvent,
  type WikiCursorOutcome,
  type WikiCursorState,
  type WikiMaintenanceCatchUp,
  type WikiMaintenanceDue,
  type WikiMaintenanceFailureKind,
  type WikiMaintenanceHeldReason,
} from '@orbit/shared';
import type { Subscription } from 'rxjs';
import { redactSecrets } from '../common/secret-redaction';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { queueWikiArticlesAfterRun } from './wiki-articles-jobs';
import {
  afterSql,
  comparePositions,
  countBacklog,
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
import { currentWikiRollout, wikiOnFor } from './wiki-rollout';

/**
 * The Wiki maintenance job's server side (design §8.2, contracts/wiki.contract.json `maintenance.job`,
 * criterion 3): the fact that makes a space's maintenance run — a `maintain` job of the wiki worker
 * (`maintenance.job.server`, P8) — and how the run's end is kept.
 *
 * A FACT MAKES THE RUN, NEVER A CLOCK (hard constraint 5). Every event this replica publishes about a
 * session or a task is a hint (`WikiMaintenanceTrigger`); a hint is followed only when it names a
 * committed fact of a space whose maintenance is on — a session of the space that came to rest, an
 * approval it answered, a merge receipt of it, a task of the space that settled — which is still after
 * the space's cursor. Then, and only then, the space is asked whether it is due: `backlogThreshold`
 * sessions pending, or the oldest pending fact older than `maxPendingAgeHours`. The age is read when a
 * fact arrives, never waited for: a space whose oldest fact turns a day old in a quiet night makes its
 * run with the next fact of the morning. A hint that names nothing new — a rename, a task of another
 * space — changes nothing, however due the space is.
 *
 * ONE RUN AT A TIME, AND NO MORE THAN THE DAY ALLOWS. The run is made under a lock on the space's row,
 * after the space is read again for a `maintain` job that has not ended: two facts arriving together
 * make one run. A space whose runs for the UTC day are used up (`settings.maintenance.dailyRunLimit`),
 * or a Manual space whose review queue has no room for a run's proposals, makes none, and says why on
 * its cursor row (`held`) until one is made.
 *
 * THE RUN IS JUDGED BY WHAT IT DID. The run row records the position the run is expected to reach — the
 * next `runSessions` sessions after the cursor — and the job reports how it ended: its outcome, the ops
 * the server refused, its report with the token spend (`finishWikiMaintenanceJob`).
 *
 * A SPACE THAT IS BEHIND CATCHES UP (contract `maintenance.job.catchUp`, criterion 3 revision 4). On 2026-10-02
 * the cursor stood thirteen days behind with nearly two thousand facts pending, and eight runs a day — the
 * failed ones counted — never caught up. So while the oldest pending fact is more than a day old, a run on a
 * local endpoint, or one that failed, is not counted against the day; and the run writes no document, which
 * waits for the first run after the space has caught up. Read off the facts and the runs' own ends when a hint
 * arrives — still no clock — and paused once the space's last three runs all failed, until a run succeeds: a
 * pause gives the day its limit back.
 *
 * A RUN THAT QUEUED THE ARTICLES ASKS FOR THE NEXT ONE AS IT ENDS (the owner's decision of 2026-10-10:
 * maintenance first, an articles job yields one round at most; contract `maintenance.job.server.trigger`). The facts
 * that arrived while a run was under way were answered `unfinished`, and the next fact after its end is what asks them
 * again — 15 to 100 s later on the canary, while the articles job its end had queued was claimed within 2 s and ran an
 * hour and a half ahead of the round. So the end of a run that queued its space's articles job asks the space
 * once more, at once, with every read above as a fact would ask it: its own job, still running as it ends, is set
 * aside, and no fact is required of the ask. A space still due has its next round made then, right behind the
 * articles job and before the run lets the space go, and the claim takes the round first (wiki-worker/wiki-jobs.ts,
 * THE ORDER); a space no longer due makes nothing, and the articles job runs at the next pass.
 */

// ── The trigger ─────────────────────────────────────────────────────────────────────────────────

/** What a published event may be a fact about: sessions, and settled tasks. Identities only. */
export interface WikiMaintenanceHint {
  sessionIds: string[];
  taskIds: string[];
  /**
   * The `maintain` job whose end asks, after it queued the space's articles job (finishWikiMaintenanceJob): no fact
   * is required, and the job itself, still running, does not hold the space.
   */
  runEnd?: string;
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

/** Why a hint made no run, or the run it made: its `maintain` job and its run row (contract `maintenance.job.server`). */
export type WikiMaintenanceTriggerOutcome =
  | {
    made: true;
    spaceId: string;
    /** The `maintain` job made. */
    jobId: string;
    runId: string;
    due: WikiMaintenanceDue;
    expect: string;
    runSessions: number;
    /** How the run was made (contract `maintenance.job.catchUp`): null while the space was not behind. */
    catchUp: WikiMaintenanceCatchUp | null;
  }
  | {
    made: false;
    spaceId: string;
    why: 'off' | 'unfinished' | 'no_new_fact' | 'not_due' | 'nothing_settled' | WikiMaintenanceHeldReason;
  };

/** The rows `considerWikiMaintenance` reads and writes. */
type TriggerDb = PrismaService;

/**
 * Whether a hint makes the space's maintenance run, and the run when it does (contract
 * `maintenance.job.trigger`, `maintenance.job.server`). Reads first — every refusal is a read — and writes
 * only under the space's lock: the `maintain` job, the run row that names it, and the cursor's `held`
 * cleared. A held space writes its reason alone. No task and no session are made: a workspace — whose runner
 * the job reads the repository through — and the space's own on-switch are all the run needs.
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
    select: { id: true, settings: true },
  });
  if (!space) return no('off');
  const settings = wikiMaintenanceSettings((space.settings as Record<string, unknown> | null)?.maintenance);
  if (!settings.enabled || !settings.workspaceId) return no('off');
  // Cheap first: a run that has not ended is the one this fact waits for.
  if (await unfinishedMaintainJob(prisma, ownerId, spaceId, hint.runEnd)) return no('unfinished');

  const scope = await spaceScope(prisma, ownerId, spaceId);
  const cursor = await cursorOf(prisma, ownerId, spaceId);
  const watermark: FactPosition | null = cursor.positionAt && cursor.positionKind && cursor.positionRef
    ? { at: cursor.positionAt, kind: cursor.positionKind as FactPosition['kind'], ref: cursor.positionRef }
    : null;

  // A new fact: the hint names a fact of this space that is still after the cursor — or the end of a run that
  // queued the space's articles job asks (`runEnd`), with the facts that found that run unfinished still after it.
  const sessionIds = hint.sessionIds.filter((id) => UUID.test(id));
  const taskIds = hint.taskIds.filter((id) => UUID.test(id));
  if (!hint.runEnd && sessionIds.length === 0 && taskIds.length === 0) return no('no_new_fact');
  if (scope.workspaceIds.length === 0 && scope.projectIds.length === 0) return no('no_new_fact');
  const named = hint.runEnd ? [] : await prisma.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS "one" FROM (${factsSql(scope, watermark)}) f
     WHERE ${afterSql(watermark)}
       AND (f."sessionId" = ANY(${sessionIds}::text[])
         OR (f."kind" = 'task_terminal' AND f."ref" = ANY(${taskIds}::text[])))
     LIMIT 1`;
  if (!hint.runEnd && named.length === 0) return no('no_new_fact');

  const backlog = await countBacklog(prisma, scope, watermark);
  const catchUp = await wikiMaintenanceCatchUpOf(prisma, ownerId, spaceId, backlog.oldestPendingAt, now);
  const due = maintenanceDue(backlog, now);
  if (!due.backlog && !due.age) return no('not_due');

  // The day's runs, and — Manual — the review queue's room. The run's endpoint is the System model's, whose
  // locality the worker records on the run row when it starts it, so the day is counted as it stands now.
  if ((await wikiMaintenanceRunsToday(prisma, ownerId, spaceId, now)).remaining <= 0) {
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
  const why: WikiMaintenanceDue = due.backlog ? 'backlog' : 'age';
  const run = {
    due: why,
    backlog: backlog.backlog,
    pendingSessions: backlog.pendingSessions,
    oldestPendingAt: backlog.oldestPendingAt,
    expect,
    catchUp: catchUp.state,
  };
  const made = await new MaintenanceJobWriter(prisma).makeJob({ ownerId, spaceId, cursorId: cursor.id, now, run, endingJobId: hint.runEnd });
  if ('why' in made) return no(made.why);
  return {
    made: true,
    spaceId,
    jobId: made.jobId,
    runId: made.runId,
    due: why,
    expect: encodeCursorToken(spaceId, expect),
    runSessions,
    catchUp: catchUp.state,
  };
}

/**
 * The one writer of a maintenance job (contract `maintenance.job.server`, P8): a run is a `wiki_job` of kind
 * `maintain` with the run row that names it, and no task. The space's row is locked first (rank 60, the lock
 * the run rows and the cursor sit behind), and everything is read again under it: of two facts arriving
 * together, the second finds the first's job, and the day's limit is counted once more with the lock held.
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
    };
    /** The run whose end asks (`WikiMaintenanceHint.runEnd`): still running, and set aside as it ends. */
    endingJobId?: string;
  }): Promise<{ jobId: string; runId: string } | { why: 'off' | 'unfinished' | 'daily_limit_reached' }> {
    const { ownerId, spaceId, now } = input;
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const [space] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "wiki_space" WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid FOR NO KEY UPDATE`;
        if (!space) return { why: 'off' } as const;
        if (await unfinishedMaintainJob(tx, ownerId, spaceId, input.endingJobId)) return { why: 'unfinished' } as const;
        if ((await wikiMaintenanceRunsToday(tx, ownerId, spaceId, now)).remaining <= 0) return { why: 'daily_limit_reached' } as const;
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
            // The System model's locality is the worker's to record when it starts the run (P8).
            localEndpoint: false,
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

/**
 * Whether the space's maintenance has a run that has not ended: a `maintain` job queued, running or parked
 * on its repository (contract `maintenance.job.server`, P8) — one run of a space at a time, and the fact that
 * arrives while one waits is answered `unfinished`.
 */
async function unfinishedMaintainJob(
  db: Pick<Prisma.TransactionClient, 'wikiJob'>,
  ownerId: string,
  spaceId: string,
  // The run whose own end asks: still running while it ends, and no longer the space's unfinished run.
  ending?: string,
): Promise<boolean> {
  return (await db.wikiJob.findFirst({
    where: {
      ownerId, spaceId, kind: WIKI_MAINTAIN_JOB.kind, state: { in: ['queued', 'running', 'waiting'] },
      ...(ending ? { id: { not: ending } } : {}),
    },
    select: { id: true },
  })) !== null;
}

/** Say on the cursor row why a due space made no run; the first fact held for a reason keeps its time. */
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

// ── The day's runs, and catch-up ────────────────────────────────────────────────────────────────

/**
 * The catch-up runs a day leaves out (contract `maintenance.job.catchUp.dailyLimit`): a run made in active
 * catch-up on a local endpoint, or one that failed.
 *
 * Spelled POSITIVELY, as the set of runs to leave out, and never as `NOT { … }`: `catch_up` is NULL for
 * every run made while the space was not behind, and `NOT (NULL = 'active' AND …)` is NULL — not true — for
 * those. A negated predicate therefore drops every ordinary run on the rows whose other half holds, which
 * on 2026-10-10 was a space whose runs all sit on a local endpoint: the day read 0 runs, the limit of 8
 * never bound, and 13 runs were made (P10). Counting the day's runs and subtracting this set cannot go
 * wrong that way.
 */
const WIKI_RUNS_NOT_COUNTED: Prisma.WikiMaintenanceRunWhereInput = {
  catchUp: 'active',
  OR: [{ localEndpoint: true }, { outcome: { in: ['failed', 'truncated'] } }],
};

/**
 * How many maintenance runs a space has made today (the UTC day `now` is in) against its daily limit
 * (contract `space.settings.maintenance.keys.dailyRunLimit`): counted per RUN — the run rows its wiki jobs
 * made since midnight UTC (migration 0401), however they ended, less the catch-up runs `WIKI_RUNS_NOT_COUNTED`
 * names. A plan job is not a maintenance run and is not counted against the day. The trigger asks it before
 * it makes another. A run a maintenance task made, before the server made every run, has no job and is not
 * counted.
 */
export async function wikiMaintenanceRunsToday(
  db: Pick<Prisma.TransactionClient, 'wikiSpace' | 'wikiMaintenanceRun'>,
  ownerId: string,
  spaceId: string,
  now: Date = new Date(),
): Promise<{ limit: number; used: number; remaining: number; since: string }> {
  const space = await db.wikiSpace.findFirst({ where: { id: spaceId, ownerId }, select: { settings: true } });
  if (!space) throw new NotFoundException('no such wiki space');
  const stored = space.settings !== null && typeof space.settings === 'object' && !Array.isArray(space.settings)
    ? (space.settings as Record<string, unknown>).maintenance
    : undefined;
  const settings = wikiMaintenanceSettings(stored);
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const runs = { ownerId, spaceId, jobId: { not: null }, createdAt: { gte: since } };
  const used = (await db.wikiMaintenanceRun.count({ where: runs }))
    - (await db.wikiMaintenanceRun.count({ where: { ...runs, ...WIKI_RUNS_NOT_COUNTED } }));
  return {
    limit: settings.dailyRunLimit,
    used,
    remaining: Math.max(0, settings.dailyRunLimit - used),
    since: since.toISOString(),
  };
}

/** Where a space stands on catch-up (contract `maintenance.job.catchUp`). */
export interface WikiMaintenanceCatchUpRead {
  /** The oldest fact after the cursor is older than `catchUp.rules.behindHours`. */
  behind: boolean;
  /** How many of the space's latest runs that ended failed in a row, counted as far as the pause. */
  failures: number;
  /** null — not behind; `active` — behind and catching up; `paused` — behind, and its last runs all failed. */
  state: WikiMaintenanceCatchUp | null;
}

/**
 * Whether a space whose oldest fact after the cursor is `oldestPendingAt` is catching up at `now` (contract
 * `maintenance.job.catchUp`): behind is read off the facts, never waited for; paused, off the ends of its latest
 * runs, so a streak the cursor's own count never saw pauses it all the same.
 */
export async function wikiMaintenanceCatchUpOf(
  db: Pick<Prisma.TransactionClient, 'wikiMaintenanceRun'>,
  ownerId: string,
  spaceId: string,
  oldestPendingAt: Date | null,
  now: Date,
): Promise<WikiMaintenanceCatchUpRead> {
  if (!wikiMaintenanceBehind(oldestPendingAt, now)) return { behind: false, failures: 0, state: null };
  const ended = await db.wikiMaintenanceRun.findMany({
    where: { ownerId, spaceId, outcome: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: WIKI_MAINTENANCE_CATCH_UP.pauseAfterFailures,
    select: { outcome: true },
  });
  const succeeded = ended.findIndex((run) => run.outcome === 'succeeded');
  const failures = succeeded < 0 ? ended.length : succeeded;
  return { behind: true, failures, state: failures >= WIKI_MAINTENANCE_CATCH_UP.pauseAfterFailures ? 'paused' : 'active' };
}

// ── Whose failure a run's end was ──────────────────────────────────────────────────────────────

/**
 * Words that say a run's end was the platform's: a runner gone offline, a runtime not initialized, a disk that
 * filled, a server that answered 5xx or did not answer, an overloaded endpoint.
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

/** Whose failure a run's end says it was (contract `maintenance.job.recovery.infra` and `content`). */
export function wikiMaintenanceFailureKindOf(text: string | null | undefined): WikiMaintenanceFailureKind {
  const said = (text ?? '').trim();
  if (!said) return 'content';
  return INFRA_WORDS.some((words) => words.test(said)) || isRetryableApiErrorText(said) ? 'infra' : 'content';
}

/**
 * The trigger's subscription: every event this replica published, read as a hint (`wikiMaintenanceHintFor`)
 * and asked of the owner's spaces whose maintenance is on. An event is published after its write, at most
 * once, and a crash between loses it (docs/watch-contract.md §8): a lost hint is a fact that made no run,
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

  /** The owner's spaces whose maintenance is on, each asked about the hint. */
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
        // A run is a job and no task: Activity's Runs card is what hears it (P9), through the same
        // `wiki.changed` a write publishes.
        this.logger.log(`space ${space.id}: made maintenance job ${outcome.jobId} (${outcome.due})`);
        this.realtime?.publishWikiChanged(ownerId, space.id);
      }
      outcomes.push(outcome);
    }
    return outcomes;
  }
}

// ── The run's end ───────────────────────────────────────────────────────────────────────────────

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
 * A run ends (contract `maintenance.job.finish`, `maintenance.job.server`): the cursor is advanced as
 * `advanceCursor` rules (only a succeeded run moves it, forward only), and what the run reported is kept on
 * the run row its job made (`wiki_maintenance_run.job_id`) — with the outcome the cursor made of it, so a
 * succeeded run whose token the cursor refused is kept as failed. A run that moved the cursor when its ops
 * were recorded (`WikiMaintenance.advanceRecorded`) ends with the same token: a success moves nothing more,
 * and a failure is counted with the cursor left where the recorded ops put it. The articles the end owes are
 * asked of the job's own facts — the run's outcome, how it was made, and whether it recorded an op — through
 * the one entry the owner's decision of 2026-10-08 names (`queueWikiArticlesAfterRun`).
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
    const articles = await queueWikiArticlesAfterRun(prisma, {
      ownerId,
      spaceId,
      outcome,
      catchUp: run?.catchUp ?? null,
      recordedOps: typeof recordedOps === 'number' && recordedOps > 0,
    });
    // The articles job goes behind the space's next round (the owner's decision of 2026-10-10): the end asks for the
    // round now rather than leave it to the owner's next event (WikiMaintenanceHint.runEnd).
    if (articles) await askForNextWikiMaintenanceRound(prisma, ownerId, spaceId, jobId, now);
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

const runEndLog = new Logger('WikiMaintenanceTrigger');

/**
 * The space's next round, asked for by the end of a server run that queued the space's articles job (the owner's decision
 * of 2026-10-10, contract `maintenance.job.server.trigger`): every read of the trigger, as a fact asks it, with the run's
 * own job — still running as it ends — set aside and no fact required. A space still due has its round made now, behind
 * the articles job and before this run lets the space go; one that is not makes nothing. Never throws, and never the
 * run's failure: what it could not ask it logs, and the round is then the owner's next event's to make, as before.
 */
async function askForNextWikiMaintenanceRound(
  prisma: PrismaService,
  ownerId: string,
  spaceId: string,
  jobId: string,
  now: Date,
): Promise<void> {
  try {
    const outcome = await considerWikiMaintenance(prisma, ownerId, spaceId, { sessionIds: [], taskIds: [], runEnd: jobId }, now);
    if (outcome.made) runEndLog.log(`space ${spaceId}: the end of job ${jobId} made the next maintenance job ${outcome.jobId} (${outcome.due})`);
  } catch (error) {
    runEndLog.warn(`space ${spaceId}: the end of job ${jobId} could not ask for the next round: ${(error as Error)?.message ?? String(error)}`);
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
 * Keep how a run ended on its run row, found by its job (`job_id`, P8): the outcome, whose the failure was —
 * read off the error when it is not said, and nothing for a run that succeeded — the report, and how many
 * ops the server refused.
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

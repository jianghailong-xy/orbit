import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { CompletionInputRouter } from './completion-input-router.service';
import type { CoordinatorSpendLimits } from './convergence-contract';
import { COORDINATOR_SPEND_WINDOW_MS } from './coordinator-convergence';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  FUSE_PAUSED_TITLE,
  FUSE_RESUME_OWNER_ONLY,
  FuseHeldActionKind,
  FuseHeldActionState,
  FusePausedPayload,
  PROJECT_FUSE_PAUSED,
  fusePausedDedupeKey,
  openFuseEpisodeId,
} from './project-fuse';

/** The committed row whose arrival made the fuse read itself (§6.1 F5). */
export interface FuseCrossingFact {
  table: 'run_event' | 'tool_call' | 'task';
  id: string;
}

/** What a door is told when the action it was about to perform was held instead (§6.3 F-T2). */
export interface HeldAction {
  held: true;
  code: typeof PROJECT_FUSE_PAUSED;
  heldActionId: string;
}

/** What became of one held action when the owner resumed. */
export interface ReplayedAction {
  heldActionId: string;
  kind: string;
  state: Exclude<FuseHeldActionState, 'HELD'>;
}

/** One fact the pause refused, asked again from the same committed rows (§6.5 F10). */
export interface RejudgedFact {
  event: string;
  subjectId: string;
  outcome: string;
}

export interface FuseResumeResult {
  episodeId: string;
  replayed: ReplayedAction[];
  rejudged: RejudgedFact[];
}

/** The episode columns everything below is decided from. */
interface Episode {
  id: string;
  projectId: string;
  ownerId: string;
  pausedAt: Date;
}

/**
 * The durable half of `project-fuse.ts`: opening a pause, holding what the coordinator starts
 * during it, and putting both back when the account owner resumes
 * (`docs/project-integration-line-contract.md` §6.3–§6.5).
 *
 * WHERE THE PAUSE IS DECIDED, AND WHERE IT IS NOT
 * ===============================================
 * `CoordinatorConvergenceService.assessSpend` decides whether the coordinator is over its budget,
 * from committed rows and with no clock of its own. This service never re-decides that: it asks, on
 * the three committed facts §6.1 F5 names, and writes the episode when the answer is yes. A reading
 * taken on a fact nothing committed would be a pause nobody can replay.
 *
 * ONE EPISODE AT A TIME, AND THE NEXT ONE IS A NEW ROW
 * ====================================================
 * The partial unique index over open episodes is what makes a second reading of an already-blown
 * fuse find the pause it opened rather than open another. What it deliberately does NOT do is make
 * a LATER pause reuse the earlier row: the episode's key is its own id, the card's dedupe key is
 * that id, and a resumed episode is final. That is the defect this replaces, stated as a mechanism
 * — the retired breaker keyed its blocker on `<kind>:PROJECT:<projectId>`, so the second episode's
 * `ON CONFLICT DO NOTHING` found the first one still open and wrote nothing at all.
 *
 * NOTHING HERE MAY COST ITS CALLER
 * ================================
 * `evaluate` and `holdIfPaused` are called from doors whose own work has already committed, or is
 * about to; a fuse that threw would turn a reading into a failure of the thing it was reading
 * about. The two edges that run after somebody else's commit swallow and log, exactly as
 * `ProjectOpenItemService` does; `resume` is the owner's own request and answers it honestly.
 */
@Injectable()
export class ProjectFuseService {
  private readonly logger = new Logger(ProjectFuseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly convergence: CoordinatorConvergenceService,
    private readonly sessions: SessionsService,
    private readonly router: CompletionInputRouter,
  ) {}

  /**
   * §6.3 F-T1: read the fuse on one committed crossing fact, and pause if it is over.
   *
   * Returns the open episode — the one this call opened, or the one that was already open — and
   * null when the coordinator is inside its budget. Idempotent by that index rather than by the
   * caller: two crossing facts arriving together produce one pause.
   */
  async evaluate(projectId: string, crossing: FuseCrossingFact): Promise<string | null> {
    const open = await openFuseEpisodeId(this.prisma, projectId);
    if (open) return open;

    const assessed = await this.convergence.assessSpend(projectId);
    if (!assessed.paused || assessed.reason === null) return null;
    const payload: FusePausedPayload = {
      dimension: assessed.reason,
      observed: assessed.observed ?? 0,
      limit: assessed.limit ?? 0,
      spendToday: assessed.spend,
      heldCount: 0,
    };

    return withTransactionRetry(this.prisma, async (tx) => {
      // The project row serialises this against a second crossing fact of the same project, and is
      // taken before the episode and card rows it decides.
      await tx.$executeRaw(Prisma.sql`
        SELECT "id" FROM "project" WHERE "id" = ${projectId}::uuid FOR NO KEY UPDATE
      `);
      const already = await openFuseEpisodeId(tx, projectId);
      if (already) return already;
      const project = await tx.project.findUnique({
        where: { id: projectId },
        select: { ownerId: true },
      });
      if (!project) return null;
      const [last] = await tx.$queryRaw<Array<{ generation: number }>>(Prisma.sql`
        SELECT coalesce(max("generation"), 0) AS "generation"
          FROM "project_fuse_episode" WHERE "project_id" = ${projectId}::uuid
      `);
      const episode = await tx.projectFuseEpisode.create({
        data: {
          projectId,
          ownerId: project.ownerId,
          generation: Number(last?.generation ?? 0) + 1,
          dimension: assessed.reason!,
          observed: payload.observed,
          limitValue: payload.limit,
          windowStart: new Date(assessed.asOf.getTime() - COORDINATOR_SPEND_WINDOW_MS),
          spend: assessed.spend as unknown as Prisma.InputJsonValue,
          crossingFact: crossing as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      const now = new Date();
      await tx.projectOpenItem.create({
        data: {
          projectId,
          ownerId: project.ownerId,
          kind: 'FUSE_PAUSED',
          state: 'OPEN',
          // A pause is the owner's by construction: nobody else can raise what the agent may spend,
          // and the coordinator is the thing being held.
          assignee: 'OWNER',
          assigneeReason: 'DEFAULT',
          fuseEpisodeId: episode.id,
          dedupeKey: fusePausedDedupeKey(episode.id),
          title: FUSE_PAUSED_TITLE,
          payload: payload as unknown as Prisma.InputJsonValue,
          waitingSince: now,
          assignedAt: now,
          // There is nobody to escalate an owner's card to.
          escalateAt: null,
        },
        select: { id: true },
      });
      return episode.id;
    }, loggedRetry(this.logger, 'projectFuse.evaluate'));
  }

  /**
   * §6.1 F5 (1) and (2): an event batch this conversation committed carried spend of its own.
   *
   * The crossing fact is re-read here rather than threaded through the ingest path, because the
   * rows it names are written by `createMany`, which returns no ids. The newest qualifying row IS
   * the one the reading was taken on.
   */
  async afterCoordinatorSpend(
    sessionId: string,
    table: 'run_event' | 'tool_call',
  ): Promise<void> {
    await this.guarded('afterCoordinatorSpend', async () => {
      const project = await this.prisma.project.findUnique({
        where: { coordinatorSessionId: sessionId },
        select: { id: true, coordinatorEnabled: true },
      });
      if (!project?.coordinatorEnabled) return;
      const [row] = table === 'run_event'
        ? await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id" FROM "run_event"
             WHERE "session_id" = ${sessionId}::uuid AND "type" = 'turn_end' AND "turn_id" IS NULL
             ORDER BY "ingested_at" DESC LIMIT 1`)
        : await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id" FROM "tool_call"
             WHERE "session_id" = ${sessionId}::uuid
             ORDER BY "started_at" DESC LIMIT 1`);
      if (!row) return;
      await this.evaluate(project.id, { table, id: row.id });
    });
  }

  /** §6.1 F5 (3): a task write committed a `superseded_by_task_id`, which is a retry. */
  async afterSupersession(projectId: string | null | undefined, taskId: string): Promise<void> {
    if (!projectId) return;
    await this.guarded('afterSupersession', async () => {
      await this.evaluate(projectId, { table: 'task', id: taskId });
    });
  }

  /**
   * §6.3 F-T2: the coordinator of a paused project tried to start something.
   *
   * Returns null when nothing holds it — no pause, or a session that is not a paused project's
   * coordinator — and the caller performs the action as it always would. Otherwise the request is
   * kept verbatim, in the order it arrived, and the card's held count is brought up to date in the
   * same transaction so the owner reads what they are actually holding.
   */
  async holdIfPaused(
    actingSessionId: string,
    kind: FuseHeldActionKind,
    request: unknown,
    idempotencyKey?: string,
  ): Promise<HeldAction | null> {
    const [paused] = await this.prisma.$queryRaw<Array<{ id: string; projectId: string }>>(Prisma.sql`
      SELECT e."id", e."project_id" AS "projectId"
        FROM "project_fuse_episode" e
        JOIN "project" p ON p."id" = e."project_id"
       WHERE e."resumed_at" IS NULL AND p."coordinator_session_id" = ${actingSessionId}::uuid
    `);
    if (!paused) return null;

    return withTransactionRetry(this.prisma, async (tx) => {
      // The episode row, which is what `seq` is allocated under and what a concurrent resume
      // contends with.
      const [live] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "project_fuse_episode"
         WHERE "id" = ${paused.id}::uuid AND "resumed_at" IS NULL FOR NO KEY UPDATE
      `);
      if (!live) return null;
      const [last] = await tx.$queryRaw<Array<{ seq: number }>>(Prisma.sql`
        SELECT coalesce(max("seq"), 0) AS "seq"
          FROM "project_fuse_held_action" WHERE "episode_id" = ${paused.id}::uuid
      `);
      const held = await tx.projectFuseHeldAction.create({
        data: {
          episodeId: paused.id,
          projectId: paused.projectId,
          seq: Number(last?.seq ?? 0) + 1,
          kind,
          actingSessionId,
          request: (request ?? {}) as Prisma.InputJsonValue,
          idempotencyKey: idempotencyKey ?? null,
        },
        select: { id: true, seq: true },
      });
      // The card says how much is waiting, so it has to be told.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "project_open_item"
           SET "payload" = jsonb_set("payload", '{heldCount}', to_jsonb(${held.seq}::int)),
               "updated_at" = now()
         WHERE "fuse_episode_id" = ${paused.id}::uuid AND "state" = 'OPEN'
      `);
      return { held: true as const, code: PROJECT_FUSE_PAUSED, heldActionId: held.id };
    }, loggedRetry(this.logger, 'projectFuse.holdIfPaused'));
  }

  /**
   * §6.3 F-T4 and F-T5: the account owner resumes.
   *
   * The write and the recovery are deliberately on either side of one commit. Inside it: the
   * episode ends, the card is resolved by the fact that resolved it, and any raised limit becomes
   * the project's own. After it: every held action goes back out in the order it was asked in, and
   * every fact the pause refused is asked again from the same committed rows. A replay that started
   * before the commit could be replayed twice by a retry of the transaction it was inside.
   */
  async resume(
    ownerId: string,
    projectId: string,
    episodeId: string,
    options: {
      raiseLimits?: Partial<CoordinatorSpendLimits>;
      /** Present when a session made this request. A pause is not a session's to lift. */
      actingSessionId?: string;
    } = {},
  ): Promise<FuseResumeResult> {
    if (options.actingSessionId?.trim()) {
      throw new ForbiddenException({
        statusCode: 403,
        code: FUSE_RESUME_OWNER_ONLY,
        message: 'Resuming a paused coordinator is the account owner’s, not this session’s: the '
          + 'budget being lifted is the budget on what this session may start. Nothing was written. '
          + 'Ask them to resume it from the Orbit app, where the pause is a card they can read.',
      });
    }

    const resumed = await withTransactionRetry(this.prisma, async (tx) => {
      const [episode] = await tx.$queryRaw<Array<Episode & { resumedAt: Date | null }>>(Prisma.sql`
        SELECT "id", "project_id" AS "projectId", "owner_id" AS "ownerId",
               "paused_at" AS "pausedAt", "resumed_at" AS "resumedAt"
          FROM "project_fuse_episode"
         WHERE "id" = ${episodeId}::uuid AND "project_id" = ${projectId}::uuid
           AND "owner_id" = ${ownerId}::uuid
           FOR NO KEY UPDATE
      `);
      if (!episode) throw new NotFoundException('no such pause on this project');
      if (episode.resumedAt) {
        throw new ConflictException({
          statusCode: 409,
          code: 'FUSE_ALREADY_RESUMED',
          message: 'this pause was already resumed; a later pause is a card of its own',
        });
      }
      const now = new Date();
      await tx.projectFuseEpisode.update({
        where: { id: episodeId },
        data: {
          resumedAt: now,
          resumedByUserId: ownerId,
          raisedLimits: (options.raiseLimits ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
      await tx.projectOpenItem.updateMany({
        where: { fuseEpisodeId: episodeId, state: 'OPEN' },
        data: {
          state: 'RESOLVED',
          resolution: 'RESUMED',
          resolvedAt: now,
          resolvedBy: 'USER',
          resolvedByUserId: ownerId,
        },
      });
      if (options.raiseLimits && Object.keys(options.raiseLimits).length > 0) {
        const project = await tx.project.findUniqueOrThrow({
          where: { id: projectId },
          select: { convergenceThresholds: true },
        });
        await tx.project.update({
          where: { id: projectId },
          data: {
            convergenceThresholds: {
              ...(project.convergenceThresholds as Record<string, unknown> | null ?? {}),
              ...options.raiseLimits,
            } as Prisma.InputJsonValue,
          },
        });
      }
      const held = await tx.projectFuseHeldAction.findMany({
        where: { episodeId, state: 'HELD' },
        orderBy: { seq: 'asc' },
        select: { id: true, kind: true, actingSessionId: true, request: true },
      });
      return { episode, resumedAt: now, held };
    }, loggedRetry(this.logger, 'projectFuse.resume'));

    const replayed: ReplayedAction[] = [];
    for (const action of resumed.held) {
      replayed.push(await this.replay(resumed.episode.ownerId, action));
    }
    return {
      episodeId,
      replayed,
      rejudged: await this.rejudge(resumed.episode, resumed.resumedAt),
    };
  }

  /**
   * §6.5 F9: put one held action back through the door it was held at, with the session that asked.
   *
   * A door that refuses it now — the task was cancelled, the workspace is gone — drops the action
   * with the reason, rather than failing the resume: the owner asked for what was held to go out,
   * and "this one no longer can" is part of the answer, not a reason to withhold the rest.
   */
  private async replay(
    ownerId: string,
    action: { id: string; kind: string; actingSessionId: string; request: unknown },
  ): Promise<ReplayedAction> {
    let state: Exclude<FuseHeldActionState, 'HELD'> = 'REPLAYED';
    let result: Prisma.InputJsonValue;
    try {
      result = await this.perform(ownerId, action);
    } catch (error) {
      state = 'DROPPED';
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    await this.prisma.projectFuseHeldAction.updateMany({
      where: { id: action.id, state: 'HELD' },
      data: { state, replayedAt: new Date(), replayResult: result },
    });
    return { heldActionId: action.id, kind: action.kind, state };
  }

  /** The door itself. One kind holds today; the others are the tasks that add them. */
  private async perform(
    ownerId: string,
    action: { kind: string; actingSessionId: string; request: unknown },
  ): Promise<Prisma.InputJsonValue> {
    if (action.kind !== 'SESSION_CREATE') {
      throw new Error(`no door replays a held ${action.kind}`);
    }
    const request = (action.request ?? {}) as { dto?: Parameters<SessionsService['spawnFromSession']>[2] };
    if (!request.dto) throw new Error('the held request carried no session to open');
    const opened = await this.sessions.spawnFromSession(ownerId, action.actingSessionId, request.dto);
    return { sessionId: opened.id };
  }

  /**
   * §6.5 F10: ask again every fact this pause refused.
   *
   * By its SUBJECT and through its own door, which re-derives the fact from committed rows — not by
   * replaying the refused wake row, which is a record of a delivery and not a queue. The refusal
   * released each fact's key (0174's partial index leaves a REFUSED row out), and the pause recorded
   * no judgment against any of them, so the same fact key is claimable and gets a fresh answer.
   */
  private async rejudge(episode: Episode, resumedAt: Date): Promise<RejudgedFact[]> {
    const refused = await this.prisma.projectCoordinatorWake.findMany({
      where: {
        projectId: episode.projectId,
        status: 'REFUSED',
        refusalCode: PROJECT_FUSE_PAUSED,
        createdAt: { gte: episode.pausedAt, lte: resumedAt },
      },
      orderBy: { createdAt: 'asc' },
      select: { event: true, subjectId: true },
    });
    if (refused.length === 0) return [];

    // Each kind of fact once, through its own door, whatever the pause refused. The event is read
    // off the refused row rather than written out here: this method DERIVES no fact — it asks the
    // producer that does, and the census of wake producers should go on saying so.
    const rejudged: RejudgedFact[] = [];
    for (const event of new Set(refused.map((wake) => wake.event))) {
      const project = [episode.projectId];
      if (event === 'ATTEMPT_ENDED_UNSETTLED') {
        const taskIds = refused
          .filter((wake) => wake.event === event)
          .map((wake) => wake.subjectId);
        for (const routed of await this.router.routeTaskExceptions(taskIds)) {
          rejudged.push({ event, subjectId: routed.taskId, outcome: routed.outcome });
        }
      } else if (event === 'CRITERION_READY') {
        for (const routed of await this.router.routeReadyCriteria(project)) {
          rejudged.push({ event, subjectId: routed.criterionSubjectId, outcome: routed.outcome });
        }
      } else if (event === 'CRITERION_UNLANDED') {
        for (const routed of await this.router.routeUnlandedCriteria(project)) {
          rejudged.push({ event, subjectId: routed.criterionSubjectId, outcome: routed.outcome });
        }
      } else if (event === 'PROJECT_TASKS_SETTLED') {
        for (const routed of await this.router.routeSettledProjects(project)) {
          rejudged.push({ event, subjectId: routed.projectId, outcome: routed.outcome });
        }
      }
    }
    return rejudged;
  }

  /** The two edges that run after somebody else's commit may not cost it. */
  private async guarded(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.warn(`${what} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}

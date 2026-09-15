import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SessionNotSendable, SessionsService } from '../sessions/sessions.service';
import {
  OpenItemAssignee,
  OpenItemAssigneeReason,
  OpenItemKind,
  SESSION_ENDING_SELECT,
  TASK_FAILURE_CHAIN_LIMIT,
  openItemMessage,
  openItemTurnId,
  sessionHasEnded,
} from './project-open-item';

/** One exception item, as a reader of the project sees it (§4.8). */
export interface OpenItemRow {
  itemId: string;
  kind: OpenItemKind;
  title: string;
  /** The one line under the title: what happened, in the words of the fact that opened it. */
  detailLine: string;
  assignee: OpenItemAssignee;
  assigneeReason: OpenItemAssigneeReason;
  waitingSince: Date;
  escalateAt: Date | null;
  escalatedAt: Date | null;
  taskId: string | null;
  promotionId: string | null;
  fuseEpisodeId: string | null;
  /** Where this item is on its way to the coordinator, or that it is not owed to one. */
  delivery: {
    state: 'NOT_REQUIRED' | 'PENDING' | 'QUEUED' | 'DELIVERED' | 'RETURNED';
    sessionId: string | null;
    at: Date | null;
  };
  /** Doors that exist today. An action nobody can perform is not offered. */
  actions: Array<'OPEN_COORDINATOR' | 'OPEN_TASK_SESSION' | 'RETRY' | 'CANCEL_TASK'>;
}

/** The project's open exceptions, split by who is expected to act (§4.8). */
export interface ProjectOpenItems {
  needsYou: OpenItemRow[];
  withCoordinator: OpenItemRow[];
}

/** The item stopped being owed to the coordinator while its turn was being written. */
class OpenItemNoLongerOwed extends Error {}

/**
 * Exception items after the fact that opened them has committed: delivering them to the project's
 * coordinator, handing them to the owner when there is nobody to deliver to, closing them when the
 * task they are about has moved on, and reading them back
 * (`docs/project-integration-line-contract.md` §4.4, §4.8).
 *
 * WHY DELIVERY IS NOT A WAKE. An item is a durable row with an assignee; the turn is only how the
 * assignee is told. So it goes through `SessionsService.createTurn` (§0.3 G6) — the same door every
 * other turn takes — and not through the wake ledger: no idempotency key to spend, nothing to
 * refuse, and a busy conversation is not a refusal but a queue (§4.4 X-D3). A coordinator's own turn
 * ending is where anything still owed is handed over, which is the compensation point for a process
 * that died between the fact's commit and its delivery.
 *
 * Nothing here ever fails its caller: every method is called after somebody else's write has already
 * committed, and a delivery that could not be made is re-derived from the same rows at the next
 * chance rather than rolling back a task's failure.
 */
@Injectable()
export class ProjectOpenItemService {
  private readonly logger = new Logger(ProjectOpenItemService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * §4.4 X-D4 (1): the transaction that opened items about these tasks has committed.
   *
   * Reads which items are actually owed rather than taking the caller's word for it, so a door that
   * reports "the task was reclaimed" without knowing whether an item was opened is still right.
   */
  async deliverForTasks(taskIds: ReadonlyArray<string | null | undefined>): Promise<void> {
    const ids = unique(taskIds);
    if (ids.length === 0) return;
    await this.guarded('deliverForTasks', async () => {
      const owed = await this.prisma.projectOpenItem.findMany({
        where: { taskId: { in: ids }, state: 'OPEN', assignee: 'COORDINATOR' },
        select: { id: true },
        orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      });
      for (const item of owed) await this.deliver(item.id);
    });
  }

  /**
   * §4.4 X-D4 (3): a conversation's turn has just ended. If it is a project's coordinator, hand over
   * everything that project still owes it.
   *
   * This is the guarantee's backstop, and the reason an item does not depend on the next task write:
   * whatever was recorded while this conversation was busy — or while whoever recorded it died before
   * delivering — is queued here, on the committed fact of its turn ending.
   */
  async deliverOwedTo(sessionId: string): Promise<void> {
    await this.guarded('deliverOwedTo', async () => {
      const project = await this.prisma.project.findUnique({
        where: { coordinatorSessionId: sessionId },
        select: { id: true },
      });
      if (!project) return;
      await this.deliverOwed(project.id);
    });
  }

  /**
   * Everything this project owes its coordinator, delivered once each.
   *
   * Items whose task has meanwhile moved on are resolved first, so a coordinator bound to a project
   * with a long history is not handed a queue of answered questions.
   */
  async deliverOwed(projectId: string): Promise<void> {
    await this.guarded('deliverOwed', async () => {
      const owed = await this.prisma.projectOpenItem.findMany({
        where: { projectId, state: 'OPEN', assignee: 'COORDINATOR' },
        select: { id: true, assignedAt: true, taskId: true },
        orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      });
      if (owed.length === 0) return;
      await this.resolveByFact(owed.map((item) => item.taskId));
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { coordinatorEnabled: true, coordinatorSessionId: true },
      });
      const sessionId = project?.coordinatorEnabled ? project.coordinatorSessionId : null;
      const sent = sessionId
        ? await this.prisma.projectOpenItemDelivery.findMany({
            where: {
              sessionId,
              purpose: 'ITEM',
              returnedAt: null,
              itemId: { in: owed.map((item) => item.id) },
            },
            select: { itemId: true, clientTurnId: true },
          })
        : [];
      const already = new Set(sent.map((delivery) => `${delivery.itemId}:${delivery.clientTurnId}`));
      for (const item of owed) {
        if (already.has(`${item.id}:${openItemTurnId(item.id, item.assignedAt)}`)) continue;
        await this.deliver(item.id);
      }
    });
  }

  /**
   * Queue one item on the conversation that coordinates its project (§4.4 X-D1, X-D2).
   *
   * The conversation is read at THIS moment rather than when the item was opened: a project that
   * rotated its coordinator owes the item to the one it has now. A conversation that has ended, or a
   * project that no longer has one, means the item is the owner's — which is the same answer §4.3
   * gives when the item is opened, reached later.
   */
  async deliver(itemId: string): Promise<void> {
    const item = await this.prisma.projectOpenItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        kind: true,
        state: true,
        assignee: true,
        assignedAt: true,
        title: true,
        payload: true,
        taskId: true,
        projectId: true,
        ownerId: true,
        project: { select: { coordinatorEnabled: true, coordinatorSessionId: true } },
      },
    });
    if (!item || item.state !== 'OPEN' || item.assignee !== 'COORDINATOR') return;
    const sessionId = item.project.coordinatorEnabled ? item.project.coordinatorSessionId : null;
    if (!sessionId) {
      await this.handToOwner(item.id, item.assignedAt, 'NO_COORDINATOR');
      return;
    }
    const clientTurnId = openItemTurnId(item.id, item.assignedAt);
    try {
      const turn = await this.sessions.createTurn(item.ownerId, sessionId, {
        clientTurnId,
        content: openItemMessage({
          id: item.id,
          kind: item.kind,
          title: item.title,
          projectId: item.projectId,
          taskId: item.taskId,
          payload: item.payload,
        }),
        intent: 'NEXT_TURN',
      }, {
        participateSendTransaction: (tx) => this.acknowledgeDelivery(tx, {
          itemId: item.id,
          projectId: item.projectId,
          assignedAt: item.assignedAt,
          sessionId,
          clientTurnId,
        }),
      });
      // The turn the delivery row names. Written after the commit because the row is written inside
      // it, before the turn exists; a process that dies here leaves a delivery whose turn is found
      // by its key, which is what every read below uses anyway.
      await this.prisma.projectOpenItemDelivery.updateMany({
        where: { itemId: item.id, sessionId, purpose: 'ITEM', clientTurnId, turnId: null },
        data: { turnId: turn.turnId },
      });
    } catch (error) {
      if (error instanceof OpenItemNoLongerOwed) return;
      // SessionNotSendable is a ConflictException, so it is asked about first.
      if (error instanceof SessionNotSendable || error instanceof NotFoundException) {
        await this.handToOwner(item.id, item.assignedAt, 'COORDINATOR_ENDED');
        return;
      }
      if (error instanceof ConflictException) {
        // The key is held by a turn with a different body — this item was already queued by a build
        // that worded it differently. It reached the conversation; saying it twice would not help.
        this.logger.warn(`open item ${item.id} is already queued on ${sessionId} under ${clientTurnId}`);
        return;
      }
      throw error;
    }
  }

  /**
   * Close the items of tasks that have moved on (§4.2), re-derived from committed rows.
   *
   * A failure is answered by what happens to the task, not by anybody reporting back: it is done, it
   * was cancelled, a successor took over, or it is being attempted again. Idempotent and safe to call
   * from any edge after a task write — an item nothing has answered is left exactly as it is.
   */
  async resolveByFact(taskIds: ReadonlyArray<string | null | undefined>): Promise<void> {
    const ids = unique(taskIds);
    if (ids.length === 0) return;
    await this.guarded('resolveByFact', async () => {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "project_open_item" i
           SET "state" = 'RESOLVED',
               "resolution" = CASE
                 WHEN t."status" = 'DONE' THEN 'TASK_DONE'
                 WHEN t."superseded_by_task_id" IS NOT NULL THEN 'SUCCESSOR_FILED'
                 WHEN t."status" = 'CANCELLED' THEN 'TASK_CLOSED'
                 ELSE 'RETRIED' END,
               "resolved_at" = now(),
               "resolved_by" = 'PLATFORM',
               "updated_at" = now()
          FROM "task" t
         WHERE i."task_id" = t."id"
           AND i."kind" = 'TASK_FAILED'
           AND i."state" = 'OPEN'
           AND t."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
           AND (t."status" IN ('DONE', 'CANCELLED')
                OR t."superseded_by_task_id" IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM "session" s
                   WHERE s."task_id" = t."id"
                     AND s."starts_task_work"
                     AND s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
                     AND s."id" IS DISTINCT FROM i."session_id"))`);
    });
  }

  /**
   * The project's open exceptions, in the two groups a reader acts on (§4.8): what waits for the
   * owner, and what the coordinator is handling. Both oldest first, which is the order somebody
   * catching up wants them in.
   */
  async list(ownerId: string, projectId: string): Promise<ProjectOpenItems> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('project not found');
    const rows = await this.prisma.projectOpenItem.findMany({
      where: { projectId, state: 'OPEN' },
      orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        kind: true,
        title: true,
        payload: true,
        assignee: true,
        assigneeReason: true,
        waitingSince: true,
        escalateAt: true,
        escalatedAt: true,
        taskId: true,
        promotionId: true,
        fuseEpisodeId: true,
        assignedAt: true,
        deliveries: {
          where: { purpose: 'ITEM' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { sessionId: true, clientTurnId: true, returnedAt: true, createdAt: true },
        },
      },
    });
    const keys = rows.flatMap((row) => row.deliveries);
    const turns = keys.length > 0
      ? await this.prisma.conversationTurn.findMany({
          where: {
            OR: keys.map((key) => ({ sessionId: key.sessionId, clientTurnId: key.clientTurnId })),
          },
          select: { sessionId: true, clientTurnId: true, deliveredAt: true },
        })
      : [];
    const deliveredAt = new Map(
      turns.map((turn) => [`${turn.sessionId}:${turn.clientTurnId}`, turn.deliveredAt]),
    );
    const view = rows.map((row): OpenItemRow => {
      const [sent] = row.deliveries;
      const handed = sent ? deliveredAt.get(`${sent.sessionId}:${sent.clientTurnId}`) ?? null : null;
      return {
        itemId: row.id,
        kind: row.kind as OpenItemKind,
        title: row.title,
        detailLine: detailLine(row.kind, row.payload),
        assignee: row.assignee as OpenItemAssignee,
        assigneeReason: row.assigneeReason as OpenItemAssigneeReason,
        waitingSince: row.waitingSince,
        escalateAt: row.escalateAt,
        escalatedAt: row.escalatedAt,
        taskId: row.taskId,
        promotionId: row.promotionId,
        fuseEpisodeId: row.fuseEpisodeId,
        delivery: row.assignee !== 'COORDINATOR'
          ? { state: 'NOT_REQUIRED', sessionId: null, at: null }
          : !sent
            ? { state: 'PENDING', sessionId: null, at: null }
            : sent.returnedAt
              ? { state: 'RETURNED', sessionId: sent.sessionId, at: sent.returnedAt }
              : handed
                ? { state: 'DELIVERED', sessionId: sent.sessionId, at: handed }
                : { state: 'QUEUED', sessionId: sent.sessionId, at: sent.createdAt },
        actions: row.taskId
          ? row.assignee === 'COORDINATOR'
            ? ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK']
            : ['OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK']
          : [],
      };
    });
    return {
      needsYou: view.filter((row) => row.assignee === 'OWNER'),
      withCoordinator: view.filter((row) => row.assignee === 'COORDINATOR'),
    };
  }

  /**
   * The delivery's own ledger row, written in the turn's transaction under the Session lock (§0.3 G6).
   *
   * Three things are decided here rather than before the call, because here they are decided under
   * the lock that makes them true at the moment the turn is written: the conversation has not ended,
   * the item is still owed to the coordinator with the assignment this turn's key names, and the row
   * that records the delivery. A throw rolls the turn back with it.
   */
  private async acknowledgeDelivery(
    tx: Prisma.TransactionClient,
    delivery: {
      itemId: string;
      projectId: string;
      assignedAt: Date;
      sessionId: string;
      clientTurnId: string;
    },
  ): Promise<void> {
    const session = await tx.session.findUniqueOrThrow({
      where: { id: delivery.sessionId },
      select: SESSION_ENDING_SELECT,
    });
    if (sessionHasEnded(session)) {
      throw new SessionNotSendable('the coordinator conversation has ended');
    }
    const owed = await tx.projectOpenItem.count({
      where: {
        id: delivery.itemId,
        state: 'OPEN',
        assignee: 'COORDINATOR',
        assignedAt: delivery.assignedAt,
      },
    });
    if (owed === 0) throw new OpenItemNoLongerOwed();
    // One row per item per conversation. A row that was taken back unrun is re-armed rather than
    // duplicated: the item is owed again, and this is the delivery that answers it.
    await tx.projectOpenItemDelivery.upsert({
      where: {
        itemId_sessionId_purpose: {
          itemId: delivery.itemId,
          sessionId: delivery.sessionId,
          purpose: 'ITEM',
        },
      },
      create: {
        itemId: delivery.itemId,
        projectId: delivery.projectId,
        sessionId: delivery.sessionId,
        purpose: 'ITEM',
        clientTurnId: delivery.clientTurnId,
      },
      update: {
        clientTurnId: delivery.clientTurnId,
        turnId: null,
        returnedAt: null,
        returnCode: null,
        createdAt: new Date(),
      },
    });
  }

  /** An item nobody's coordinator can read is the owner's (§4.4 X-D6). */
  private async handToOwner(
    itemId: string,
    assignedAt: Date,
    reason: Extract<OpenItemAssigneeReason, 'NO_COORDINATOR' | 'COORDINATOR_ENDED'>,
  ): Promise<void> {
    await this.prisma.projectOpenItem.updateMany({
      where: { id: itemId, state: 'OPEN', assignee: 'COORDINATOR', assignedAt },
      data: {
        assignee: 'OWNER',
        assigneeReason: reason,
        assignedAt: new Date(),
        escalateAt: null,
      },
    });
  }

  /** Every entry point here runs after somebody else's commit, so none of them may cost it. */
  private async guarded(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.warn(`${what} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}

function unique(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => !!id))];
}

/** The line under an item's title, in the words of the fact (English: this is UI copy). */
function detailLine(kind: string, payload: unknown): string {
  if (kind !== 'TASK_FAILED') return '';
  const failure = (payload ?? {}) as {
    how?: string;
    exitCode?: number;
    expectedExitCode?: number;
    chain?: { failuresInChain?: number; limit?: number };
  };
  const attempt = failure.chain?.failuresInChain ?? 1;
  const limit = failure.chain?.limit ?? TASK_FAILURE_CHAIN_LIMIT;
  const exit = failure.exitCode !== undefined
    ? ` · exit ${failure.exitCode}, expected ${failure.expectedExitCode ?? 0}`
    : '';
  return `${howInEnglish(failure.how)}${exit} · attempt ${attempt} of ${limit} in this chain`;
}

function howInEnglish(how: string | undefined): string {
  switch (how) {
    case 'ACCEPTANCE_EXIT_MISMATCH':
      return 'The acceptance command disagreed with what the task declared';
    case 'RUN_FAILED':
      return 'A turn of the run failed';
    case 'RUNNER_FINALIZED_FAILED':
      return 'The runner finished the run as failed';
    case 'REAPED_API_ERROR':
      return 'The run stopped on an API or sign-in error and was reaped';
    case 'ATTEMPT_LOST_RUNNER_OFFLINE':
      return 'Its runner went offline and the attempt was taken back';
    case 'ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED':
      return 'Its runtime never started and the attempt was taken back';
    case 'REPORTED_FAILED':
      return 'Somebody filed it as failed';
    default:
      return 'The task failed';
  }
}

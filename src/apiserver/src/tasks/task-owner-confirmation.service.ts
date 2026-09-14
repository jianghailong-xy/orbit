import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { CreatorType, Prisma, TaskStatus } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  latestOwnerConfirmationRequest,
  readOwnerConfirmation,
  type OwnerConfirmationView,
} from './owner-confirmation-read';
import {
  deriveTaskCompletionStatus,
  type TaskCompletionCriterionValue,
} from './task-completion-criterion';
import {
  OWNER_DECISIONS,
  assertOwnerConfirmationPrincipal,
  ownerDecisionNote,
  ownerDecisionRefusal,
  ownerSendBackClientTurnId,
  throwOwnerConfirmationRefusal,
  type OwnerConfirmationPrincipal,
  type OwnerConfirmationStanding,
  type OwnerDecisionValue,
} from './task-owner-confirmation';
import { TasksService } from './tasks.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DecideOwnerConfirmation {
  decision: OwnerDecisionValue;
  /** The request the card was drawn for; omitted or null for a press that answers no run. */
  requestId?: string | null;
  note?: string | null;
}

/** What the door returns once it has recorded a decision. */
export interface OwnerDecisionReceipt {
  id: string;
  taskId: string;
  decision: OwnerDecisionValue;
  note: string | null;
  decidedAt: Date;
  decidedByType: CreatorType;
  requestId: string | null;
  /** The session whose run the decision answered; null for a confirmation that answered none. */
  sessionId: string | null;
  /** Whether this decision settled the task DONE. */
  completed: boolean;
  /** The message a send-back was delivered as. */
  turnId: string | null;
}

interface WrittenDecision {
  id: string;
  taskId: string;
  decision: OwnerDecisionValue;
  note: string | null;
  decidedAt: Date;
  decidedByType: CreatorType;
  requestId: string | null;
}

/**
 * The fourth criterion's door: the account owner confirms an OWNER_CONFIRMED task done, or sends it
 * back with a reason (`task-owner-confirmation.ts` states the rules).
 *
 * A CONFIRM writes its row and the status that row derives, under the task's row lock and past
 * 0267's lane in the database's DONE fence, which goes and finds the same decision for itself. A
 * SEND_BACK writes its row inside the transaction that files the owner's reason as the next message
 * of the run's session (`SessionsService.createTurn`), so a reason is never recorded without being
 * delivered, nor delivered without being recorded; the task is not written and stays open.
 */
@Injectable()
export class TaskOwnerConfirmationService {
  private readonly logger = new Logger(TaskOwnerConfirmationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    @Optional() private readonly tasks?: TasksService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  async read(ownerId: string, taskId: string): Promise<OwnerConfirmationView> {
    const view = await readOwnerConfirmation(this.prisma, ownerId, taskId);
    if (!view) throw new NotFoundException('task not found');
    return view;
  }

  async decide(
    ownerId: string,
    taskId: string,
    principal: OwnerConfirmationPrincipal,
    input: DecideOwnerConfirmation,
  ): Promise<OwnerDecisionReceipt> {
    // Who is asking is settled before anything is read: an agent learns nothing from this door.
    assertOwnerConfirmationPrincipal(ownerId, principal);
    if (!OWNER_DECISIONS.includes(input.decision)) {
      throw new BadRequestException(`decision must be one of ${OWNER_DECISIONS.join(', ')}`);
    }
    const answering = input.requestId ?? null;
    if (answering !== null && !UUID_RE.test(answering)) {
      throw new BadRequestException('requestId is invalid');
    }
    const note = ownerDecisionNote(input.decision, input.note);

    const receipt = input.decision === 'CONFIRM'
      ? await this.confirm(ownerId, taskId, answering, note)
      : await this.sendBack(ownerId, taskId, answering as string | null, note as string);

    // After the commit: the task's views re-read, and the list row the run's session had lit goes
    // dark — a session row is refreshed by nothing that happens to a task.
    this.realtime?.publishForUser(ownerId, RunEventType.TASK_CHANGED, {
      taskIds: [taskId],
      resync: false,
    });
    if (receipt.sessionId) this.realtime?.publishSessionUpdated(receipt.sessionId);
    if (receipt.completed) {
      await this.tasks?.dispatchDependentsAfterCompletion(ownerId, taskId).catch((error) => {
        this.logger.warn(`successor dispatch after owner confirmation ${taskId} failed: `
          + `${error instanceof Error ? error.message : error}`);
      });
    }
    return receipt;
  }

  /** CONFIRM: one row and the DONE it derives, in one transaction under the task's row lock. */
  private confirm(
    ownerId: string,
    taskId: string,
    answering: string | null,
    note: string | null,
  ): Promise<OwnerDecisionReceipt> {
    return withTransactionRetry(this.prisma, async (tx) => {
      const standing = await lockedStanding(tx, ownerId, taskId);
      const refusal = ownerDecisionRefusal(standing, 'CONFIRM', answering);
      if (refusal) throwOwnerConfirmationRefusal(refusal);
      const written = await writeDecision(tx, {
        id: randomUUID(),
        taskId,
        ownerId,
        requestId: answering,
        decision: 'CONFIRM',
        note,
      });
      const completed = deriveTaskCompletionStatus({
        completionCriterion: standing.completionCriterion,
        ownerDecision: written.decision,
      });
      let settled = false;
      if (completed != null) {
        // The criterion and the unsettled statuses are repeated although the row is locked: they
        // make the compare-and-set visible in SQL, and they keep a task somebody cancelled from
        // being completed by a press that was already on its way.
        const changed = await tx.task.updateMany({
          where: {
            id: taskId,
            ownerId,
            completionCriterion: 'OWNER_CONFIRMED',
            status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
          },
          data: { status: completed },
        });
        settled = changed.count > 0;
      }
      return receiptOf(written, {
        completed: settled,
        sessionId: answering === null ? null : standing.latestRequest?.sessionId ?? null,
        turnId: null,
      });
    }, loggedRetry(this.logger, 'taskOwnerConfirmation.confirm'));
  }

  /**
   * SEND_BACK: the owner's reason, delivered as the next message of the session whose run reported,
   * and the row that records it, in that message's own transaction.
   *
   * The session is found first, without a lock, because it is where the transaction has to start:
   * `createTurn` takes that session's row before anything else (rank 30), and the task's row is
   * taken inside it (rank 50). Everything that first read assumed is asked again under both locks
   * before the row is written, so a report that moved on in between is refused rather than answered.
   */
  private async sendBack(
    ownerId: string,
    taskId: string,
    answering: string | null,
    note: string,
  ): Promise<OwnerDecisionReceipt> {
    const addressed = await unlockedStanding(this.prisma, ownerId, taskId);
    const refusal = ownerDecisionRefusal(addressed, 'SEND_BACK', answering);
    if (refusal) throwOwnerConfirmationRefusal(refusal);
    const sessionId = addressed.latestRequest!.sessionId;
    const decisionId = randomUUID();
    const recorded: { row?: WrittenDecision } = {};
    const turn = await this.sessions.createTurn(
      ownerId,
      sessionId,
      { clientTurnId: ownerSendBackClientTurnId(decisionId), content: note, intent: 'NEXT_TURN' },
      {
        participateSendTransaction: async (tx) => {
          // A request belongs to one session, so the request still waiting being the one answered
          // is also the session this message was addressed to still being the right one.
          const late = ownerDecisionRefusal(
            await lockedStanding(tx, ownerId, taskId),
            'SEND_BACK',
            answering,
          );
          if (late) throwOwnerConfirmationRefusal(late);
          recorded.row = await writeDecision(tx, {
            id: decisionId,
            taskId,
            ownerId,
            requestId: answering,
            decision: 'SEND_BACK',
            note,
          });
        },
      },
    );
    // The hook runs for every new turn, and this client turn id was drawn above, so a turn without a
    // row would be a message the owner never decided to send. Say so rather than report success.
    if (!recorded.row) {
      throw new Error(`send-back ${decisionId} filed a message without recording its decision`);
    }
    return receiptOf(recorded.row, { completed: false, sessionId, turnId: turn.turnId });
  }
}

/** The task row, locked, and the request it is waiting on. */
async function lockedStanding(
  tx: Prisma.TransactionClient,
  ownerId: string,
  taskId: string,
): Promise<OwnerConfirmationStanding> {
  const [task] = await tx.$queryRaw<Array<{
    status: string;
    completionCriterion: TaskCompletionCriterionValue;
    verifiesTaskId: string | null;
  }>>(Prisma.sql`
    SELECT "status"::text AS "status",
           "completion_criterion"::text AS "completionCriterion",
           "verifies_task_id" AS "verifiesTaskId"
      FROM "task"
     WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
     FOR UPDATE
  `);
  if (!task) throw new NotFoundException('task not found');
  return { ...task, latestRequest: await latestRequestStanding(tx, taskId) };
}

/** The same facts without a lock: only good for deciding where a locked transaction has to start. */
async function unlockedStanding(
  tx: Prisma.TransactionClient,
  ownerId: string,
  taskId: string,
): Promise<OwnerConfirmationStanding> {
  const task = await tx.task.findFirst({
    where: { id: taskId, ownerId },
    select: { status: true, completionCriterion: true, verifiesTaskId: true },
  });
  if (!task) throw new NotFoundException('task not found');
  return {
    status: task.status,
    completionCriterion: task.completionCriterion as TaskCompletionCriterionValue,
    verifiesTaskId: task.verifiesTaskId,
    latestRequest: await latestRequestStanding(tx, taskId),
  };
}

async function latestRequestStanding(
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<OwnerConfirmationStanding['latestRequest']> {
  const latest = await latestOwnerConfirmationRequest(tx, taskId);
  return latest && { id: latest.id, sessionId: latest.sessionId, decided: latest.decisions.length > 0 };
}

/**
 * The row. `decidedAt` is read from the database clock after the task's row lock is held, not from
 * the transaction's start time: decisions about one task are serialised by that lock, and the DONE
 * fence asks which of them is the newest, so their order has to be the order they were made in.
 */
async function writeDecision(
  tx: Prisma.TransactionClient,
  row: {
    id: string;
    taskId: string;
    ownerId: string;
    requestId: string | null;
    decision: OwnerDecisionValue;
    note: string | null;
  },
): Promise<WrittenDecision> {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  return tx.taskOwnerDecision.create({
    data: {
      ...row,
      decidedAt: clock.now,
      decidedByType: CreatorType.USER,
      decidedById: row.ownerId,
    },
    select: {
      id: true,
      taskId: true,
      decision: true,
      note: true,
      decidedAt: true,
      decidedByType: true,
      requestId: true,
    },
  });
}

function receiptOf(
  row: WrittenDecision,
  outcome: { completed: boolean; sessionId: string | null; turnId: string | null },
): OwnerDecisionReceipt {
  return {
    id: row.id,
    taskId: row.taskId,
    decision: row.decision,
    note: row.note,
    decidedAt: row.decidedAt,
    decidedByType: row.decidedByType,
    requestId: row.requestId,
    ...outcome,
  };
}

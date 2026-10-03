import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type {
  OpenItemFacts,
  ProjectStartNotReadyBody,
  ProjectStartRequest,
  ProjectStartRequestBody,
  ProjectStartRequestFiled,
  ProjectStartSettings,
} from '@orbit/shared';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { SessionNotSendable, SessionsService } from '../sessions/sessions.service';
import {
  AskedQuestion,
  CoordinatorQuestion,
  INTEGRATION_ITEM_KINDS,
  MAX_OPEN_ITEM_RESOLUTION_NOTE,
  OpenItemAssignee,
  OpenItemAssigneeReason,
  OpenItemKind,
  OwnerAnswer,
  QuestionNotAskable,
  SESSION_ENDING_SELECT,
  TASK_FAILURE_CHAIN_LIMIT,
  coordinatorQuestion,
  openItemActions,
  openItemFacts,
  openItemMessage,
  openItemOwed,
  openItemTurnId,
  openItemsNoLongerOwed,
  ownerAnswerMessage,
  ownerAnswerTurnId,
  questionDetailLine,
  sessionHasEnded,
} from './project-open-item';
import { escalatesAt } from './open-item-escalation.service';
import { canonicalJson } from './canonical-json';
import { RetryableLandingFailureClass, queueLandingRetry } from './project-integration-job';
import {
  INTEGRATION_RETRY_COORDINATOR_ONLY,
  INTEGRATION_RETRY_NOT_APPLICABLE,
  INTEGRATION_RETRY_NOT_THIS_PROJECT,
  INTEGRATION_RETRY_REASON_REQUIRED,
  MAX_INTEGRATION_RETRY_REASON,
  decideIntegrationRetry,
} from './project-integration-retry';
import { FusePausedPayload, fusePausedDetailLine } from './project-fuse';
import {
  START_REQUEST_COORDINATOR_ONLY,
  START_REQUEST_DEDUPE_KEY,
  START_REQUEST_KIND,
  START_REQUEST_NOT_READY,
  START_REQUEST_TITLE,
  readStartPlan,
  startReadiness,
  startRequestDetailLine,
  supersedeStaleStartRequest,
} from './project-start-request';

/**
 * Who is asking for an item to be put in front of the project's coordinator conversation.
 *
 * `AUTOMATIC` is the platform: an item the coordinator owes, a drain finding one owed, an item
 * opened for a conversation. `OWNER` is the account owner's own press — `returnToCoordinator`, the
 * card's "Ask the coordinator again". The two differ in exactly one place and for one reason, the
 * coordinator switch; `deliver` is where that is spelled out.
 */
export type DeliverAskedBy = 'AUTOMATIC' | 'OWNER';

/** Only the project's coordinator conversation may put a question to the owner (§5.2 R8). */
export const ASK_OWNER_COORDINATOR_ONLY = 'ASK_OWNER_COORDINATOR_ONLY';
/** A question that has been answered, withdrawn or superseded is not answered again (§4.7). */
export const OPEN_ITEM_NOT_OPEN = 'OPEN_ITEM_NOT_OPEN';
/** An item the coordinator is already carrying is not handed back to it (§4.7). */
export const OPEN_ITEM_ALREADY_COORDINATORS = 'OPEN_ITEM_ALREADY_COORDINATORS';
/** A project with no coordinator conversation — or one that has ended — has nobody to ask again
 *  (§4.7). */
export const OPEN_ITEM_NO_COORDINATOR = 'OPEN_ITEM_NO_COORDINATOR';
/** The item is not the coordinator's to close: an item assigned to the owner — an escalation, a
 *  question, a merge card, a pause — is theirs (§4.7). */
export const OPEN_ITEM_NOT_COORDINATOR_ITEM = 'OPEN_ITEM_NOT_COORDINATOR_ITEM';
/** Only the conversation an item is assigned to may close it by hand (§4.7), or the owner. */
export const OPEN_ITEM_COORDINATOR_ONLY = 'OPEN_ITEM_COORDINATOR_ONLY';
/** This kind is decided by a press of its own — confirming a merge, or resuming a paused project
 *  (§4.2, §4.7). */
export const OPEN_ITEM_HAS_ITS_OWN_DOOR = 'OPEN_ITEM_HAS_ITS_OWN_DOOR';

/**
 * The kinds this door ends, and what each ending is called (§4.2).
 *
 * The integration kinds come from the constant rather than being listed again, so a fifth
 * `INTEGRATION_*` state the pipeline can stop in does not arrive without a way to close it. The two
 * that are absent are absent on purpose: `PROMOTION_APPROVAL` is decided by confirming or declining
 * the merge and `FUSE_PAUSED` by resuming the project, and closing either by hand would leave what
 * it is about — a promotion nobody decided, a project standing still — with no card in front of
 * anybody.
 */
const HAND_CLOSABLE_RESOLUTIONS: Readonly<Record<string, 'HANDLED' | 'WITHDRAWN'>> = {
  ...Object.fromEntries(INTEGRATION_ITEM_KINDS.map((kind) => [kind, 'HANDLED' as const])),
  TASK_FAILED: 'HANDLED',
  // §5.2 R12: a question is withdrawn, not handled, and who withdraws it is who asked it.
  COORDINATOR_QUESTION: 'WITHDRAWN',
};

/**
 * How many already-answered questions one binding reconsiders (§5.2 R11).
 *
 * A cap on the READ, not on the guarantee: an answer is redelivered while the work it unblocks is
 * still open, or to the one generation that replaced its asker, and both of those are self-limiting.
 * This only keeps a project with years of answered questions from re-reading all of them every time
 * a coordinator is bound.
 */
const ANSWERS_RECONSIDERED_PER_BINDING = 50;

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
  /** The attempt this item is about, when one is recorded: the run whose failure opened it. It is
   *  what the card's "Open task session" reaches, and a task can have had several. */
  sessionId: string | null;
  promotionId: string | null;
  fuseEpisodeId: string | null;
  /** Where this item is on its way to the coordinator, or that it is not owed to one. */
  delivery: {
    state: 'NOT_REQUIRED' | 'PENDING' | 'QUEUED' | 'DELIVERED' | 'RETURNED';
    sessionId: string | null;
    at: Date | null;
  };
  /** Doors that exist today. An action nobody can perform is not offered. */
  actions: Array<
    | 'REVIEW'
    | 'OPEN_COORDINATOR'
    | 'OPEN_TASK_SESSION'
    | 'RETRY'
    | 'CANCEL_TASK'
    | 'ASK_COORDINATOR_AGAIN'
    | 'RESUME'
    | 'ANSWER'
  >;
  /** What was asked, for a `COORDINATOR_QUESTION`; null for every other kind (§5.2, §4.8). */
  question: CoordinatorQuestion | null;
  /** What a `START_REQUEST` asks — the "Start this project?" card's source; null for every other
   *  kind. */
  startRequest: ProjectStartRequest | null;
  /** What the item's payload holds, as the rows its card draws (§7.5); null when the payload is
   *  not a shape this build reads, which leaves the card drawing what it drew before. */
  facts: OpenItemFacts | null;
}

/** A question filed, as `ask_owner` answers its caller (§5.2 R7). */
export interface OpenItemAsked {
  itemId: string;
  state: 'OPEN';
}

/** A question answered, and where the answer went (§5.2 R10). */
export interface OpenItemAnswered {
  itemId: string;
  state: 'RESOLVED';
  resolution: 'ANSWERED';
  /** Null when no conversation is coordinating the project: the answer waits for the next one. */
  delivery: { sessionId: string; turnId: string } | null;
}

/** An item the owner sent back to its project's coordinator (§4.7). */
export interface OpenItemReturned {
  itemId: string;
  assignee: 'COORDINATOR';
  /** The wait starts over, which is the whole of what "ask again" gives the coordinator. */
  waitingSince: Date;
  escalateAt: Date;
}

/** An item its assignee closed by hand, and what that ending is called (§4.7). */
export interface OpenItemResolved {
  itemId: string;
  state: 'RESOLVED';
  resolution: 'HANDLED' | 'WITHDRAWN';
}

/** A failed landing the coordinator ran again (§2.3 J-T1b), as `integration_retry` answers it. */
export interface IntegrationRetried {
  taskId: string;
  /** The generation this rerun queued, and the branch it will land. */
  jobId: string;
  generation: number;
  sourceRef: string;
  /** The failed generation it reruns, and what that one failed of. */
  retryOfJobId: string;
  failureClass: RetryableLandingFailureClass;
  reason: string;
  /** The coordinator's open items about the failed landing, now SUPERSEDED (RETRIED) with the
   *  reason on them. Empty when none was open — it may already have been closed by hand. */
  supersededItemIds: string[];
}

/** The project's open exceptions, split by who is expected to act (§4.8), and the coordinator's
 *  open request to start it — beside them rather than among them (`ProjectOpenItemsView`). */
export interface ProjectOpenItems {
  needsYou: OpenItemRow[];
  withCoordinator: OpenItemRow[];
  startRequest: OpenItemRow | null;
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
    /** Tells the owner's phone about the items that become theirs (§7.6 V12). `@Optional()` because
     *  a notification is one reader of an item and never a condition of filing one: a build without
     *  PushModule — every spec that assembles this service by hand — writes the same rows. */
    @Optional() private readonly push?: PushService,
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
      // The other half of "the assignee is always told": a failure opened with the OWNER on it
      // already — no coordinator to read it, the conversation ended, or the chain ran out (§4.5
      // X-C3) — is delivered to nobody, because a person is not a queue. Their devices are told
      // instead (§7.6 V12). Read the same way the deliveries above are: from the committed rows,
      // so a door that does not know whether it opened one is still right. A repeat is collapsed
      // on the item by APNs rather than stacking a second banner about one waiting thing.
      const mine = await this.prisma.projectOpenItem.findMany({
        where: { taskId: { in: ids }, state: 'OPEN', assignee: 'OWNER' },
        select: { id: true },
        orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      });
      for (const item of mine) void this.push?.notifyOwnerItem(item.id);
    });
  }

  /**
   * §4.4 X-D4 (1), for items whose caller is holding them by id.
   *
   * A promotion job names no task (§3.4 writes `task_id` NULL on purpose), so the item such a job
   * opens cannot be found by one — the caller that opened it is the only thing in the system that
   * knows it exists, and this is how it hands it over. Everything else is `deliverForTasks`: the
   * same re-derivation from committed rows, and the same delivery.
   */
  async deliverForItems(itemIds: ReadonlyArray<string | null | undefined>): Promise<void> {
    const ids = unique(itemIds);
    if (ids.length === 0) return;
    await this.guarded('deliverForItems', async () => {
      const owed = await this.prisma.projectOpenItem.findMany({
        where: { id: { in: ids }, state: 'OPEN', assignee: 'COORDINATOR' },
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
  async deliverOwed(projectId: string, replacedSessionId?: string): Promise<void> {
    await this.guarded('deliverOwed', async () => {
      await this.deliverAnsweredQuestions(projectId, replacedSessionId);
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
  async deliver(itemId: string, askedBy: DeliverAskedBy = 'AUTOMATIC'): Promise<void> {
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
    // THE SWITCH DECIDES AUTOMATIC HAND-OVERS, AND ONLY THOSE. `coordinatorEnabled` is the owner
    // saying the coordinator may not act on its own, and an item handed over by the platform is
    // exactly that. The owner's own press is not: it is that same person saying "put this one in
    // front of it", about one item, now — the authority is already theirs, and the switch stays
    // theirs to use. So the press needs the conversation to exist and nothing else, which is what
    // makes `ASK_COORDINATOR_AGAIN` a button rather than a treadmill: gated on the switch too, the
    // press would land back on the owner on the next line (`handToOwner`, below) and the item would
    // be exactly where it started — the clock the door's own comment used to refuse over.
    const sessionId = askedBy === 'OWNER' || item.project.coordinatorEnabled
      ? item.project.coordinatorSessionId
      : null;
    if (!sessionId) {
      // A TURN THAT IS ALREADY WRITTEN IS NOT THE PLATFORM REACHING FOR A COORDINATOR. The switch
      // decides THIS delivery; an item whose assignment has already been put in front of the
      // project's conversation is not one of those — its turn exists (queued, or read and answered),
      // and the consent that paid for it was spent when that turn was written: by the owner's own
      // press, or by an automatic hand-over made while the switch was on. Handing it back here is a
      // reader re-deciding an assignment nobody asked it to re-decide, and it is what made the press
      // a treadmill with a longer stride than the one `returnToCoordinator` closed: press → the
      // coordinator reads it → the next drain takes it back → press again (the account owner's
      // report, 2026-09-22: the exemption held in the press's own call and nowhere else).
      if (await this.carried(item.id, item.assignedAt, item.project.coordinatorSessionId)) return;
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
   * A coordinator puts a question to the account owner (§5.2 R7–R9).
   *
   * The question is a durable item with the owner on it, not a message: the tool returns as soon as
   * it is filed, the conversation goes on with whatever else it can do, and the answer arrives later
   * as a turn. So a coordinator that needs a decision it has no authority to make is neither blocked
   * nor forced to guess — and what it asked stays readable after the conversation itself is gone.
   *
   * Only the conversation this project is coordinated from may ask, because the question is filed in
   * the project's name and shown to the owner as the project asking. Any other session — a task's
   * own run, a coordinator of some other project — is refused rather than filed under a project it
   * does not speak for.
   *
   * The conversation, not the Automatic switch: a question is the coordinator asking the owner, not
   * acting for them, and the switch says how far the coordinator may act on its own. Before a
   * project starts is when a coordinator has the most to ask, and it asked nothing while this
   * required the switch — which a project that has not started need not have on.
   */
  async askOwner(
    ownerId: string,
    projectId: string,
    actingSessionId: string | undefined,
    asked: AskedQuestion & { clientQuestionId?: string },
  ): Promise<OpenItemAsked> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: {
        coordinatorSessionId: true,
        exceptionEscalationSeconds: true,
      },
    });
    if (!project) throw new NotFoundException('project not found');
    const asking = actingSessionId?.trim();
    if (!asking || asking !== project.coordinatorSessionId) {
      throw new ForbiddenException({
        code: ASK_OWNER_COORDINATOR_ONLY,
        message:
          'only the conversation coordinating this project may put a question to its owner. A '
          + 'question is filed in the project’s name, so the session asking has to be the one the '
          + 'project points at.',
      });
    }
    let question: CoordinatorQuestion;
    try {
      question = coordinatorQuestion(asked);
    } catch (error) {
      if (error instanceof QuestionNotAskable) throw new BadRequestException(error.message);
      throw error;
    }
    // The caller's own key for this question, so a tool call retried after a lost response files
    // one question rather than asking the owner the same thing twice.
    const dedupeKey = `CQ:${asked.clientQuestionId?.trim() || randomKey()}`;
    const now = new Date();
    const [created] = await this.prisma.projectOpenItem.createManyAndReturn({
      data: [{
        projectId,
        ownerId,
        kind: 'COORDINATOR_QUESTION' satisfies OpenItemKind,
        state: 'OPEN',
        assignee: 'OWNER' satisfies OpenItemAssignee,
        // The owner is not who this ended up with; it is who it was always for.
        assigneeReason: 'DEFAULT' satisfies OpenItemAssigneeReason,
        askedBySessionId: asking,
        dedupeKey,
        title: `Coordinator asks: ${question.question}`,
        payload: question as unknown as Prisma.InputJsonValue,
        waitingSince: now,
        assignedAt: now,
        // Nowhere to escalate to — it is already the owner's. The window becomes their one reminder.
        escalateAt: null,
        remindAt: new Date(now.getTime() + project.exceptionEscalationSeconds * 1_000),
      }],
      skipDuplicates: true,
      select: { id: true },
    });
    if (created) {
      // R9: the question is filed and the owner is told, in that order and after the commit.
      void this.push?.notifyOwnerItem(created.id);
      return { itemId: created.id, state: 'OPEN' };
    }
    const already = await this.prisma.projectOpenItem.findFirst({
      where: { projectId, dedupeKey, state: 'OPEN' },
      select: { id: true },
    });
    if (already) return { itemId: already.id, state: 'OPEN' };
    // The key is held by a question that has since been answered. Asking again under a key that is
    // spent would file nothing and report success, so it is refused with the one thing to do about it.
    throw new ConflictException({
      code: OPEN_ITEM_NOT_OPEN,
      message: 'a question under this clientQuestionId was already answered; ask under a new one',
    });
  }

  /**
   * The coordinator asks the account owner to start the project (`project_request_start`,
   * `project-start-request.ts`).
   *
   * Filed and returned at once, like a question: the owner answers on the "Start this project?"
   * card, and the coordinator is told when the project starts (`project-started.ts`). Only the
   * conversation the project is coordinated from may ask — the conversation, not the Automatic
   * switch, which is one of the settings being asked for — and only before the project has started.
   *
   * One transaction under the project row (FOR NO KEY UPDATE, the lock the start door takes first):
   * a request and a start of the same project are ordered, so no request is filed about a project
   * that has just started. The plan is checked under it and a plan that is not ready is refused with
   * every finding, writing nothing; one that is ready supersedes the request already open, if any,
   * and files this one — unless it is that same request again, which writes nothing.
   */
  async requestStart(
    ownerId: string,
    projectId: string,
    actingSessionId: string | undefined,
    body: ProjectStartRequestBody,
  ): Promise<ProjectStartRequestFiled> {
    if (body.line === 'MAIN' && body.projectBranchName != null) {
      throw new BadRequestException(
        'a project that lands directly into main has no project branch to name',
      );
    }
    const why = body.why?.trim();
    if (!why) {
      throw new BadRequestException(
        'why is required: the sentence the owner reads on the card about why the plan is ready',
      );
    }
    const settings: ProjectStartSettings = {
      line: body.line,
      ...(body.projectBranchName != null ? { projectBranchName: body.projectBranchName } : {}),
      automatic: body.automatic,
      maxConcurrentTasks: body.maxConcurrentTasks,
      mergeCheckCommand: body.mergeCheckCommand?.trim() || null,
    };
    const asking = actingSessionId?.trim();
    return withTransactionRetry(this.prisma, async (tx) => {
      const [project] = await tx.$queryRaw<Array<{
        startedAt: Date | null;
        coordinatorSessionId: string | null;
      }>>(Prisma.sql`
        SELECT "started_at" AS "startedAt", "coordinator_session_id" AS "coordinatorSessionId"
          FROM "project"
         WHERE "id" = ${projectId}::uuid AND "owner_id" = ${ownerId}::uuid
           FOR NO KEY UPDATE`);
      if (!project) throw new NotFoundException('project not found');
      if (!asking || asking !== project.coordinatorSessionId) {
        throw new ForbiddenException({
          code: START_REQUEST_COORDINATOR_ONLY,
          message:
            'only the conversation coordinating this project may ask its owner to start it. The '
            + 'request is filed in the project’s name, so the session asking has to be the one the '
            + 'project points at.',
        });
      }
      if (project.startedAt) {
        throw new ConflictException({
          code: 'PROJECT_ALREADY_STARTED',
          startedAt: project.startedAt.toISOString(),
          message:
            'this project has already been started, so there is nothing to ask: nothing was filed. '
            + 'Its auto-run tasks start by themselves; start the ones set to start by hand with '
            + 'task_start.',
        });
      }
      const plan = await readStartPlan(tx, ownerId, projectId);
      const findings = startReadiness(plan, settings);
      const refusals = findings.filter((finding) => finding.severity === 'REFUSE');
      if (refusals.length > 0) {
        const notReady: ProjectStartNotReadyBody = {
          code: START_REQUEST_NOT_READY,
          message:
            `this plan is not ready to start: ${refusals.length} check`
            + `${refusals.length === 1 ? '' : 's'} refused it, and nothing was filed`,
          written: 0,
          findings,
        };
        throw new ConflictException(notReady);
      }
      const request: ProjectStartRequest = {
        settings,
        why,
        criteriaDigest: plan.criteriaDigest,
        planDigest: plan.planDigest,
        repository: plan.repository,
        warnings: findings,
      };
      const open = await tx.projectOpenItem.findFirst({
        where: { projectId, kind: START_REQUEST_KIND, state: 'OPEN' },
        select: { id: true, payload: true },
      });
      if (open && canonicalJson(open.payload) === canonicalJson(request)) {
        return { ...request, itemId: open.id, state: 'OPEN', alreadyOpen: true, superseded: null };
      }
      const now = new Date();
      // Named before either write, so the request it replaces can say which one did — a row that is
      // no longer OPEN is final (`project_open_item_terminal_guard`) and cannot be told afterwards.
      const itemId = randomUUID();
      if (open) {
        await tx.projectOpenItem.updateMany({
          where: { id: open.id, state: 'OPEN' },
          data: {
            state: 'SUPERSEDED',
            resolvedAt: now,
            resolvedBy: 'COORDINATOR',
            resolvedBySessionId: asking,
            supersededByItemId: itemId,
            resolutionNote: 'the coordinator asked again',
          },
        });
      }
      await tx.projectOpenItem.create({
        data: {
          id: itemId,
          projectId,
          ownerId,
          kind: START_REQUEST_KIND satisfies OpenItemKind,
          state: 'OPEN',
          assignee: 'OWNER' satisfies OpenItemAssignee,
          assigneeReason: 'DEFAULT' satisfies OpenItemAssigneeReason,
          askedBySessionId: asking,
          dedupeKey: START_REQUEST_DEDUPE_KEY,
          title: START_REQUEST_TITLE,
          payload: request as unknown as Prisma.InputJsonValue,
          waitingSince: now,
          assignedAt: now,
          // The owner's from the start, so there is nobody to escalate to — and no reminder: the
          // card stays in front of them until they start the project or the plan moves.
          escalateAt: null,
        },
        select: { id: true },
      });
      return {
        ...request,
        itemId,
        state: 'OPEN',
        alreadyOpen: false,
        superseded: open ? { itemId: open.id } : null,
      };
    }, loggedRetry(this.logger, 'projectOpenItem.requestStart'));
  }

  /**
   * The account owner answers a question (§5.2 R10).
   *
   * The answer ends the item and is then told to whichever conversation coordinates the project NOW
   * — read after the answer has committed, so a project that rotated its coordinator while the owner
   * was deciding tells the one it has rather than the one that asked. Nothing here waits for the
   * delivery: the answer is written whether or not there is anybody to tell, and R11 tells the next
   * coordinator when there is one.
   */
  async answerOpenItem(
    ownerId: string,
    projectId: string,
    itemId: string,
    given: { option?: number; text?: string },
  ): Promise<OpenItemAnswered> {
    const item = await this.prisma.projectOpenItem.findFirst({
      where: { id: itemId, projectId, ownerId, kind: 'COORDINATOR_QUESTION' },
      select: { id: true, state: true, payload: true },
    });
    if (!item) throw new NotFoundException('question not found');
    const notOpen = (): ConflictException => new ConflictException({
      code: OPEN_ITEM_NOT_OPEN,
      message:
        'this question is no longer open. A question gets one answer: the first one is what the '
        + 'coordinator was told, and a second would replace an answer somebody already acted on.',
    });
    if (item.state !== 'OPEN') throw notOpen();
    const question = item.payload as unknown as CoordinatorQuestion;
    const text = given.text?.trim();
    const option = given.option ?? undefined;
    if (option === undefined && !text) {
      throw new BadRequestException('an answer needs an option or some text');
    }
    if (option !== undefined
      && (!Number.isInteger(option) || option < 0 || option >= (question.options?.length ?? 0))) {
      throw new BadRequestException('option must name one of the options this question offered');
    }
    const answer: OwnerAnswer = {
      ...(option !== undefined ? { option } : {}),
      ...(text ? { text } : {}),
      answeredByUserId: ownerId,
    };
    const settled = await this.prisma.projectOpenItem.updateMany({
      where: { id: itemId, state: 'OPEN' },
      data: {
        state: 'RESOLVED',
        resolution: 'ANSWERED',
        resolvedAt: new Date(),
        resolvedBy: 'USER',
        resolvedByUserId: ownerId,
        answer: answer as unknown as Prisma.InputJsonValue,
      },
    });
    if (settled.count === 0) throw notOpen();
    return {
      itemId,
      state: 'RESOLVED',
      resolution: 'ANSWERED',
      delivery: await this.deliverAnswer(itemId),
    };
  }

  /**
   * The owner hands an escalated item back to the project's coordinator (§4.7).
   *
   * An item became the owner's because nobody acted on it — that is the whole of what an escalation
   * says — so this is the owner saying "try again", and it deliberately ends nothing: the item goes
   * back to the coordinator with the clock the project set for it RESTARTED. Keeping the deadline it
   * already had would hand it back already due to return, which is the same as not handing it back
   * at all, and `waiting_since` moves with it because the wait a reader is shown is the one running
   * now (§4.6 X-E2). `assigned_at` moves for the same kind of reason on the other side: a delivery's
   * turn key names the assignment it was made under, so the coordinator is told in a fresh turn
   * rather than under the key of the one it never answered (X-D2).
   *
   * The three refusals in front of the write are what keep the press honest. An item that is no
   * longer open has nothing left to hand over; an item the coordinator is already carrying is not
   * the owner's to send; and a project with no coordinator conversation — or one that has ended —
   * has nobody to put the item in front of, so the delivery would hand it straight back and the
   * press would be a circle.
   *
   * WHAT IT NO LONGER REFUSES, AND WHY. It used to refuse when `coordinatorEnabled` was off, on the
   * same argument. That argument is about AUTOMATIC hand-overs (`deliver` spells it out): an item
   * nobody pressed for belongs to the owner when the coordinator may not act. This press is not
   * that — it is the owner, who owns the switch, putting one item in front of their own
   * conversation — so the door asks for a conversation and the delivery carries the authority. The
   * alternative was a card whose press is refused, or a card that hides the press and leaves the
   * owner with nothing to do about an item that is theirs precisely because nobody else will take
   * it (the account owner's report, 2026-09-22).
   */
  async returnToCoordinator(
    ownerId: string,
    projectId: string,
    itemId: string,
  ): Promise<OpenItemReturned> {
    const item = await this.prisma.projectOpenItem.findFirst({
      where: { id: itemId, projectId, ownerId },
      select: {
        id: true,
        state: true,
        assignee: true,
        project: {
          select: {
            coordinatorSessionId: true,
            coordinatorSession: { select: SESSION_ENDING_SELECT },
            exceptionEscalationSeconds: true,
          },
        },
      },
    });
    if (!item) throw new NotFoundException('item not found');
    if (item.state !== 'OPEN') {
      throw new ConflictException({
        code: OPEN_ITEM_NOT_OPEN,
        message:
          'this item is no longer open: it ended when the work it was about moved on, so there is '
          + 'nothing left to hand back.',
      });
    }
    if (item.assignee !== 'OWNER') {
      throw new ConflictException({
        code: OPEN_ITEM_ALREADY_COORDINATORS,
        message:
          'this item is already the coordinator’s. Sending it back is for an item that came to the '
          + 'owner because nobody acted on it.',
      });
    }
    // The conversation, not the switch: this press is the owner's own authority, so a project whose
    // coordinator is switched off still has somewhere to put the item — what it needs is somebody to
    // put it in front of (`deliver`, which this ends by calling with `OWNER`). What the switch does
    // keep is every automatic hand-over: an item opened for a switched-off coordinator is the
    // owner's from the start, and this refusal is what it was always about — a project with NO
    // conversation at all.
    const session = item.project.coordinatorSession;
    if (item.project.coordinatorSessionId == null || session == null || sessionHasEnded(session)) {
      throw new ConflictException({
        code: OPEN_ITEM_NO_COORDINATOR,
        message:
          'this project has no coordinator conversation to ask again — the item is yours because '
          + 'there was nobody to hand it to.',
      });
    }
    const now = new Date();
    const escalateAt = new Date(now.getTime() + item.project.exceptionEscalationSeconds * 1_000);
    const returned = await this.prisma.projectOpenItem.updateMany({
      where: { id: itemId, state: 'OPEN', assignee: 'OWNER' },
      data: {
        assignee: 'COORDINATOR',
        // Back where it started: nothing about it is anybody's exception now.
        assigneeReason: 'DEFAULT',
        assignedAt: now,
        waitingSince: now,
        escalateAt,
        escalatedAt: null,
      },
    });
    if (returned.count === 0) {
      // The same item somebody else moved between the read and the write — the press answered a
      // state that had already changed, so it is told to read again rather than reporting a
      // hand-back it did not make.
      throw new ConflictException({
        code: OPEN_ITEM_NOT_OPEN,
        message: 'this item changed while the press was being made — read the project again.',
      });
    }
    // §4.4 X-D4 (1), after the commit, and guarded: the item is the coordinator's from here whether
    // or not this process manages to tell it, and a delivery that fails is re-derived from the
    // committed row at the next drain point rather than costing the owner a 500.
    await this.guarded('returnToCoordinator', () => this.deliver(itemId, 'OWNER'));
    return { itemId, assignee: 'COORDINATOR', waitingSince: now, escalateAt };
  }

  /**
   * The assignee closes an item it has handled, saying why (§4.7's "标记已处理"; §5.2 R12 for a
   * question).
   *
   * WHY THIS DOOR EXISTS. Every other ending of an item is a fact the platform can read for itself:
   * a task that moved on, a landing that happened, a promotion that was decided, an answer that came
   * back. The one it cannot is work that landed BY HAND — a coordinator that replayed a branch onto
   * the target itself, before the integration line was carrying it, or because the line is not what
   * moves that work. Nothing about that leaves a row the platform can read, and the branch tip it
   * landed from stops being an ancestor of anything the moment the replay is pushed, so the item
   * about it says "this did not land" and goes on saying it: the platform does not retry, and the
   * task never runs again. The assignee knows. So the assignee is given a way to say so, and what it
   * says is written down — who closed it, which conversation, when, and why.
   *
   * WHO PRESSES. The item's assignee, which is the whole of "只有当前负责人能关": for an item the
   * project's coordinator is carrying, the conversation the project is coordinated FROM — read at
   * this moment, so a project that rotated its coordinator is closed by the one it has — and, for
   * anything at all, the account owner through the door that takes their own credential. A question
   * is the one kind whose assignee does not end it: it is the owner's to answer, and the conversation
   * that ASKED it that may withdraw it (R12).
   *
   * WHAT IT REFUSES. An item that is not OPEN: an ending is final, both here and in the row's own
   * guard trigger (`project_open_item_terminal_guard`), and a second press would write its reason
   * over an ending somebody else's fact produced. A session that is not the item's: an item is a fact
   * about one project's work, not a general-purpose write. A press with no reason, because the reason
   * IS what this door adds — the platform could not verify the ending, so the sentence is the
   * evidence. And the two kinds that have a press of their own (see `HAND_CLOSABLE_RESOLUTIONS`).
   */
  async resolveOpenItem(
    ownerId: string,
    projectId: string,
    itemId: string,
    given: { note: string },
    /** Who is pressing. Named rather than inferred from a nullable session id: an owner's press and
     *  a conversation's are authorized differently, and a door that reached the owner's branch by
     *  OMITTING the session would be one any machine credential could open as the owner. */
    actor: { kind: 'OWNER' } | { kind: 'SESSION'; sessionId: string },
  ): Promise<OpenItemResolved> {
    const item = await this.prisma.projectOpenItem.findFirst({
      where: { id: itemId, projectId, ownerId },
      select: {
        id: true,
        kind: true,
        state: true,
        assignee: true,
        askedBySessionId: true,
        project: { select: { coordinatorSessionId: true } },
      },
    });
    if (!item) throw new NotFoundException('item not found');
    const notOpen = (): ConflictException => new ConflictException({
      code: OPEN_ITEM_NOT_OPEN,
      message:
        'this item is no longer open. An ending is final: what it was about has already been '
        + 'answered by a fact or by somebody else, and a second press would write over that.',
    });
    if (item.state !== 'OPEN') throw notOpen();
    const resolution = HAND_CLOSABLE_RESOLUTIONS[item.kind];
    if (!resolution) {
      throw new ConflictException({
        code: OPEN_ITEM_HAS_ITS_OWN_DOOR,
        message:
          'this item is decided by a press of its own: confirm or decline the merge on its card, or '
          + 'resume the project. Closing it here would leave what it is about undecided and with no '
          + 'card in front of anybody.',
      });
    }
    const note = given.note?.trim();
    if (!note) {
      throw new BadRequestException(
        'a reason is required: this door is how an ending the platform could not see gets written '
        + 'down, so the sentence you give is the whole of its evidence.',
      );
    }
    if (note.length > MAX_OPEN_ITEM_RESOLUTION_NOTE) {
      throw new BadRequestException(`a reason is at most ${MAX_OPEN_ITEM_RESOLUTION_NOTE} characters`);
    }

    let resolvedBy: 'USER' | 'COORDINATOR';
    let resolvedByUserId: string | null = null;
    let resolvedBySessionId: string | null = null;
    if (actor.kind === 'OWNER') {
      resolvedBy = 'USER';
      resolvedByUserId = ownerId;
    } else {
      const sessionId = actor.sessionId?.trim();
      if (item.kind === 'COORDINATOR_QUESTION') {
        // R12: the question is the owner's, and the conversation that asked it may take it back.
        if (!sessionId || item.askedBySessionId !== sessionId) {
          throw new ConflictException({
            code: OPEN_ITEM_NOT_COORDINATOR_ITEM,
            message:
              'this is a question, so it is not the coordinator\'s to close: the owner answers it, '
              + 'and the conversation that asked it is the one that may withdraw it.',
          });
        }
      } else {
        if (item.assignee !== 'COORDINATOR') {
          throw new ConflictException({
            code: OPEN_ITEM_NOT_COORDINATOR_ITEM,
            message:
              'this item is the account owner\'s — it is theirs because they were asked, or because '
              + 'nobody acted and it escalated to them. Closing it is their press.',
          });
        }
        // The conversation, not the switch — the reading `returnToCoordinator` and `deliver` spell
        // out (§4.7). An item arrives on a coordinator either by an automatic hand-over the switch
        // authorized or by the owner's own press, and once it is its assignee's, its assignee ends
        // it: an assignment that cannot be closed is an item with no ending but its clock. Gated on
        // the switch, an item handed to a switched-off coordinator could only be ended by the owner
        // — the dead end the press was made exempt from the switch to avoid.
        if (!sessionId || sessionId !== item.project.coordinatorSessionId) {
          throw new ForbiddenException({
            code: OPEN_ITEM_COORDINATOR_ONLY,
            message:
              'this item is the project\'s coordinator\'s to close, and this session is not the '
              + 'conversation the project is coordinated from. An item is closed by its assignee: '
              + 'that conversation, or the account owner.',
          });
        }
      }
      resolvedBy = 'COORDINATOR';
      resolvedBySessionId = sessionId!;
    }

    const settled = await this.prisma.projectOpenItem.updateMany({
      where: { id: itemId, state: 'OPEN' },
      data: {
        state: 'RESOLVED',
        resolution,
        resolvedAt: new Date(),
        resolvedBy,
        resolvedByUserId,
        resolvedBySessionId,
        resolutionNote: note,
      },
    });
    if (settled.count === 0) {
      // Somebody else's fact, or another press, moved it between the read and the write — so the
      // press is told to read again rather than reporting a close it did not make.
      throw notOpen();
    }
    return { itemId, state: 'RESOLVED', resolution };
  }

  /**
   * The project's coordinator runs one of its failed landings again (`integration_retry`, §2.3
   * J-T1b) — the next generation of a DONE task's LAND_TASK, for a landing that stopped at a red check,
   * a check that ran out of time, or an integration error.
   *
   * WHY A REASON IS REQUIRED. Rerunning the same commits against the same checks is the cheapest way
   * to make a red go away without anybody deciding it was not the delivery's, which is the silent
   * retry the platform refuses to make (J5). So the caller says why this run will come out
   * differently — the merge check's baseline was repaired, the failure was the machinery's, the check
   * ran out of time — and the sentence is kept on the generation it queued and on every item it
   * supersedes.
   *
   * WHO MAY ASK. The conversation the project is coordinated from, read at this moment, and nothing
   * else on this door: a task's own run does not decide what happens to its landing, and a coordinator
   * of another project does not decide this one's. The account owner's say is the item: a failure
   * whose item is theirs is refused here (`decideIntegrationRetry` says how each case reads).
   *
   * WHAT IT WRITES. One transaction under the task row (FOR NO KEY UPDATE, the lock the DONE
   * transaction holds): the decision over the facts read under it, then exactly one new LAND_TASK
   * generation (`queueLandingRetry`) carrying what it reruns, why and who asked, then the
   * coordinator's open items about the failed landing SUPERSEDED with resolution RETRIED and the
   * reason. A second call while that generation is queued or running is refused — the lock orders two
   * concurrent ones, and J3's index would refuse the second row anyway. What happens next is the
   * line's: a landing resolves what is open about it and continues to the project branch's merge check
   * (§3.4), and a failure opens its own item, classified, for whoever the project routes it to.
   */
  async retryIntegration(
    ownerId: string,
    projectId: string,
    taskId: string,
    given: { reason?: string },
    actingSessionId: string | undefined,
  ): Promise<IntegrationRetried> {
    const reason = typeof given?.reason === 'string' ? given.reason.trim() : '';
    if (!reason) {
      throw new BadRequestException({
        code: INTEGRATION_RETRY_REASON_REQUIRED,
        message:
          'a reason is required: say why running this landing again will come out differently. A '
          + 'rerun nobody explained is the silent retry the platform refuses to make.',
      });
    }
    if (reason.length > MAX_INTEGRATION_RETRY_REASON) {
      throw new BadRequestException({
        code: INTEGRATION_RETRY_REASON_REQUIRED,
        message: `a reason is at most ${MAX_INTEGRATION_RETRY_REASON} characters`,
      });
    }
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { coordinatorSessionId: true },
    });
    if (!project) throw new NotFoundException('project not found');
    const asking = actingSessionId?.trim();
    const coordinatorOnly = (): ForbiddenException => new ForbiddenException({
      code: INTEGRATION_RETRY_COORDINATOR_ONLY,
      message:
        'only the conversation this project is coordinated from may run one of its landings again. '
        + 'A task\'s own run does not decide what happens to its landing, and the account owner\'s say '
        + 'is the item about it.',
    });
    if (!asking || asking !== project.coordinatorSessionId) throw coordinatorOnly();
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, ownerId },
      select: { projectId: true },
    });
    if (!task) throw new NotFoundException('task not found');
    if (task.projectId !== projectId) {
      throw new ForbiddenException({
        code: INTEGRATION_RETRY_NOT_THIS_PROJECT,
        message:
          'this task is not filed under this project, and a project\'s coordinator runs only its own '
          + 'project\'s landings again. The task\'s own project, and its coordinator, decide this one.',
      });
    }

    return withTransactionRetry(this.prisma, async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
        SELECT "status"::text AS "status" FROM "task"
         WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
           AND "project_id" = ${projectId}::uuid
         FOR NO KEY UPDATE`);
      if (!locked) throw new NotFoundException('task not found in this project');
      // Read again under the lock: the pointer can rotate, and the switch can move, while the call
      // was on its way here.
      const current = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { coordinatorEnabled: true, coordinatorSessionId: true },
      });
      if (current.coordinatorSessionId !== asking) throw coordinatorOnly();
      const newestLanding = await tx.projectIntegrationJob.findFirst({
        where: { taskId, kind: 'LAND_TASK' },
        orderBy: [{ generation: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, generation: true, state: true, checks: true },
      });
      const openItems = await tx.projectOpenItem.findMany({
        where: { projectId, taskId, kind: { in: [...INTEGRATION_ITEM_KINDS] }, state: 'OPEN' },
        select: { id: true, kind: true, assignee: true, assigneeReason: true },
        orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
      });
      const ownerBlockers = await tx.projectBlocker.findMany({
        where: { projectId, subjectType: 'TASK', subjectId: taskId, owner: 'USER', resolvedAt: null },
        select: { id: true, kind: true },
      });
      const decision = decideIntegrationRetry({
        coordinatorEnabled: current.coordinatorEnabled,
        taskStatus: locked.status,
        newestLanding,
        openItems,
        ownerBlockers,
      });
      if (!decision.ok) throw new HttpException(decision.body, decision.status);

      const queued = await queueLandingRetry(tx, {
        ownerId,
        projectId,
        taskId,
        retry: {
          ofJobId: decision.retryOfJobId,
          failureClass: decision.failureClass,
          reason,
          requestedBySessionId: asking,
        },
      });
      if (!queued) {
        throw new ConflictException({
          code: INTEGRATION_RETRY_NOT_APPLICABLE,
          message:
            'the landing could not be queued: the task has no work branch to hand the line, or the '
            + 'project no longer integrates on a branch of its own.',
        });
      }
      if (decision.supersede.length > 0) {
        await tx.projectOpenItem.updateMany({
          where: { id: { in: decision.supersede }, state: 'OPEN' },
          data: {
            state: 'SUPERSEDED',
            resolution: 'RETRIED',
            resolvedAt: new Date(),
            resolvedBy: 'COORDINATOR',
            resolvedBySessionId: asking,
            resolutionNote: reason,
          },
        });
      }
      return {
        taskId,
        jobId: queued.jobId,
        generation: queued.generation,
        sourceRef: queued.sourceRef,
        retryOfJobId: decision.retryOfJobId,
        failureClass: decision.failureClass,
        reason,
        supersededItemIds: decision.supersede,
      };
    }, loggedRetry(this.logger, 'projectOpenItem.retryIntegration'));
  }

  /**
   * Tell the project's current coordinator what the owner answered (§5.2 R10, R11).
   *
   * Keyed by the question AND the conversation, which is what makes a rotation safe: every
   * generation is told once, a replay of the same generation's key returns the turn already written,
   * and a project with nobody coordinating it is told nothing until it has somebody.
   *
   * Told whether or not the project's Automatic switch is on, for the reason `askOwner` asks either
   * way: the answer is the owner's reply to a question the coordinator put, not a hand-over the
   * switch has to authorize.
   */
  private async deliverAnswer(itemId: string): Promise<{ sessionId: string; turnId: string } | null> {
    const item = await this.prisma.projectOpenItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        ownerId: true,
        projectId: true,
        state: true,
        resolution: true,
        resolvedAt: true,
        payload: true,
        answer: true,
        project: { select: { coordinatorSessionId: true } },
      },
    });
    if (!item || item.state !== 'RESOLVED' || item.resolution !== 'ANSWERED') return null;
    if (!item.answer || !item.resolvedAt) return null;
    const sessionId = item.project.coordinatorSessionId;
    if (!sessionId) return null;
    const clientTurnId = ownerAnswerTurnId(item.id, sessionId);
    const content = ownerAnswerMessage(
      item.payload as unknown as CoordinatorQuestion,
      item.answer as unknown as OwnerAnswer,
      item.resolvedAt,
    );
    try {
      const turn = await this.sessions.createTurn(item.ownerId, sessionId, {
        clientTurnId,
        content,
        intent: 'NEXT_TURN',
      }, {
        participateSendTransaction: (tx) => this.acknowledgeAnswer(tx, {
          itemId: item.id,
          projectId: item.projectId,
          sessionId,
          clientTurnId,
        }),
      });
      await this.prisma.projectOpenItemDelivery.updateMany({
        where: { itemId: item.id, sessionId, purpose: 'ANSWER', clientTurnId, turnId: null },
        data: { turnId: turn.turnId },
      });
      return { sessionId, turnId: turn.turnId };
    } catch (error) {
      // A conversation that has ended is not revived to be told, and a key already held by a turn
      // means this generation has it. Both leave the answer on the item for the next coordinator.
      if (error instanceof SessionNotSendable || error instanceof NotFoundException) return null;
      if (error instanceof ConflictException) {
        this.logger.warn(`the answer to ${item.id} is already queued on ${sessionId}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * §5.2 R11: a conversation has just become this project's coordinator. Tell it the answers it
   * still needs — the ones to questions that block work nobody has settled, and the ones asked by the
   * conversation it just replaced, which would otherwise have been answered to nobody.
   *
   * Not every answer this project ever got: an answer is context for work still in front of the new
   * coordinator, and replaying a year of settled questions is noise, not a guarantee.
   */
  private async deliverAnsweredQuestions(
    projectId: string,
    replacedSessionId?: string,
  ): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { coordinatorSessionId: true },
    });
    const sessionId = project?.coordinatorSessionId ?? null;
    if (!sessionId) return;
    const answered = await this.prisma.projectOpenItem.findMany({
      where: {
        projectId,
        kind: 'COORDINATOR_QUESTION',
        state: 'RESOLVED',
        resolution: 'ANSWERED',
        deliveries: { none: { sessionId, purpose: 'ANSWER' } },
      },
      select: { id: true, payload: true, askedBySessionId: true },
      orderBy: [{ resolvedAt: 'desc' }, { id: 'desc' }],
      take: ANSWERS_RECONSIDERED_PER_BINDING,
    });
    for (const item of answered.reverse()) {
      const replaced = !!replacedSessionId && item.askedBySessionId === replacedSessionId;
      const question = item.payload as unknown as CoordinatorQuestion;
      if (!replaced && !(await this.blocksUnsettledWork(question.blocksTaskIds))) continue;
      await this.deliverAnswer(item.id);
    }
  }

  /** Whether any of these tasks is still somebody's to do. */
  private async blocksUnsettledWork(taskIds: ReadonlyArray<string> | undefined): Promise<boolean> {
    const ids = unique(taskIds ?? []);
    if (ids.length === 0) return false;
    return (await this.prisma.task.count({
      where: { id: { in: ids }, status: { notIn: ['DONE', 'CANCELLED'] } },
    })) > 0;
  }

  /** The answer's own ledger row, written in the turn's transaction under the Session lock (G6). */
  private async acknowledgeAnswer(
    tx: Prisma.TransactionClient,
    delivery: { itemId: string; projectId: string; sessionId: string; clientTurnId: string },
  ): Promise<void> {
    const session = await tx.session.findUniqueOrThrow({
      where: { id: delivery.sessionId },
      select: SESSION_ENDING_SELECT,
    });
    if (sessionHasEnded(session)) {
      throw new SessionNotSendable('the coordinator conversation has ended');
    }
    await tx.projectOpenItemDelivery.upsert({
      where: {
        itemId_sessionId_purpose: {
          itemId: delivery.itemId,
          sessionId: delivery.sessionId,
          purpose: 'ANSWER',
        },
      },
      create: {
        itemId: delivery.itemId,
        projectId: delivery.projectId,
        sessionId: delivery.sessionId,
        purpose: 'ANSWER',
        clientTurnId: delivery.clientTurnId,
      },
      update: { clientTurnId: delivery.clientTurnId },
    });
  }

  /**
   * Close the items of tasks that have moved on (§4.2), re-derived from committed rows.
   *
   * A failure is answered by what happens to the task, not by anybody reporting back: it is done, it
   * was cancelled, a successor took over, or it is being attempted again. Idempotent and safe to call
   * from any edge after a task write — an item nothing has answered is left exactly as it is.
   *
   * The integration items (§4.2's three `INTEGRATION_*` rows) are answered on this same axis but by
   * a narrower set of facts, and the second statement is that difference. DONE does not answer one:
   * a task is DONE to be integrated, and what a conflict is waiting for is the landing (J-T5). Being
   * attempted again does not answer one either: the task being carried to a new commit is not the
   * new generation §4.2 names, and an item that closed on every retry would close on the way to the
   * landing that is supposed to answer it. Cancelled and replaced are the two that do — nobody is
   * going to land a task that is gone.
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
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "project_open_item" i
           SET "state" = 'RESOLVED',
               "resolution" = 'TASK_CLOSED',
               "resolved_at" = now(),
               "resolved_by" = 'PLATFORM',
               "updated_at" = now()
          FROM "task" t
         WHERE i."task_id" = t."id"
           AND i."kind" IN (${Prisma.join(INTEGRATION_ITEM_KINDS.map((kind) => Prisma.sql`${kind}`))})
           AND i."state" = 'OPEN'
           AND t."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
           AND (t."status" = 'CANCELLED' OR t."superseded_by_task_id" IS NOT NULL)`);
    });
  }

  /**
   * The project's open exceptions, in the two groups a reader acts on (§4.8): what waits for the
   * owner, and what the coordinator is handling. Both oldest first, which is the order somebody
   * catching up wants them in. Only what is still owed (`openItemOwed`): an item about a candidate or
   * a task that has moved on is in front of nobody, whether or not anything has closed it yet.
   */
  async list(ownerId: string, projectId: string): Promise<ProjectOpenItems> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      // Read here rather than per row: whether this project has a conversation to hand an item
      // BACK to decides one press on every item it owns, and it is one project either way.
      select: {
        id: true,
        coordinatorSessionId: true,
        coordinatorSession: { select: SESSION_ENDING_SELECT },
      },
    });
    if (!project) throw new NotFoundException('project not found');
    // A start request whose plan has moved is superseded before the items are read, so the owner is
    // never shown a card about a plan that is no longer there (`project-start-request.ts`).
    await this.guarded('supersedeStaleStartRequest', async () => {
      await supersedeStaleStartRequest(this.prisma, ownerId, projectId);
    });
    // Whether there is a conversation to ask again — the SAME predicate `returnToCoordinator`
    // refuses on, minus the switch, which is not part of it: the press is the owner's own, so a
    // switched-off coordinator still has somewhere to put the item (`deliver`). Drawn the other way
    // round, the card would hide a press that works, which is the same failure as drawing one that
    // cannot (§4.7).
    const askable = project.coordinatorSessionId != null
      && project.coordinatorSession != null
      && !sessionHasEnded(project.coordinatorSession);
    const open = await this.prisma.projectOpenItem.findMany({
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
        sessionId: true,
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
    const settled = await openItemsNoLongerOwed(this.prisma, open.map((row) => row.id));
    const rows = open.filter((row) => !settled.has(row.id));
    const keys = rows.flatMap((row) => row.deliveries);
    // When each of the coordinator's items goes to the owner, as the clock decides it (§4.6): a
    // conversation still carrying one moves that moment on, so it is read here rather than taken
    // from the column the item was opened with — which would have the card say "due" about an item
    // that is not coming.
    const goesAt = new Map<string, Date>();
    if (rows.some((row) => row.assignee === 'COORDINATOR')) {
      const due = await this.prisma.$queryRaw<Array<{ id: string; at: Date }>>(Prisma.sql`
        SELECT item."id", ${escalatesAt('item')} AS "at"
          FROM "project_open_item" item
         WHERE item."project_id" = ${projectId}::uuid
           AND item."state" = 'OPEN' AND item."assignee" = 'COORDINATOR'`);
      for (const row of due) goesAt.set(row.id, row.at);
    }
    // The tasks these items are about, read once for the whole page: the card's first row names
    // what the item is about, and a task's title is not a column of the item. A task that is gone
    // leaves the row undrawn rather than drawn empty.
    const taskIds = unique(rows.map((row) => row.taskId));
    const tasks = taskIds.length > 0
      ? await this.prisma.task.findMany({
          where: { id: { in: taskIds } },
          select: { id: true, title: true },
        })
      : [];
    const titles = new Map(tasks.map((task) => [task.id, task.title]));
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
      const question = row.kind === 'COORDINATOR_QUESTION'
        ? (row.payload as unknown as CoordinatorQuestion)
        : null;
      const startRequest = row.kind === START_REQUEST_KIND
        ? (row.payload as unknown as ProjectStartRequest)
        : null;
      const title = row.taskId ? titles.get(row.taskId) : undefined;
      return {
        itemId: row.id,
        kind: row.kind as OpenItemKind,
        title: row.title,
        detailLine: question
          ? questionDetailLine(question)
          : startRequest
            ? startRequestDetailLine(projectId, startRequest)
            : detailLine(row.kind, row.payload),
        question,
        startRequest,
        facts: openItemFacts(
          row.kind,
          row.payload,
          row.taskId && title ? { id: row.taskId, title } : null,
        ),
        assignee: row.assignee as OpenItemAssignee,
        assigneeReason: row.assigneeReason as OpenItemAssigneeReason,
        waitingSince: row.waitingSince,
        escalateAt: goesAt.get(row.id) ?? row.escalateAt,
        escalatedAt: row.escalatedAt,
        taskId: row.taskId,
        sessionId: row.sessionId,
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
        // One derivation, shared with the card recorded beside an item's delivery
        // (`openItemActions`): the same row read twice must not offer two sets of doors. The
        // asking press is listed only while there is a conversation to ask (see `askable` above);
        // the card leaves it undrawn then, and the wait that ran into this escalation is the one
        // thing left to say.
        actions: openItemActions({
          kind: row.kind,
          assignee: row.assignee,
          taskId: row.taskId,
          promotionId: row.promotionId,
          fuseEpisodeId: row.fuseEpisodeId,
          askable,
        }),
      };
    });
    return {
      needsYou: view.filter((row) => row.assignee === 'OWNER' && row.kind !== START_REQUEST_KIND),
      withCoordinator: view.filter((row) => row.assignee === 'COORDINATOR'),
      startRequest: view.find((row) => row.kind === START_REQUEST_KIND) ?? null,
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

  /**
   * Whether this assignment has already been put in front of that conversation (§4.4 X-D2).
   *
   * The ledger's own answer to "has anybody been told", and the one `deliver` asks before it decides
   * that an item the platform may not hand over belongs to the owner. The row is not a hope: it is
   * written inside `createTurn`'s transaction, so a live one under this item, this conversation and
   * this assignment is the turn itself — already queued or already read. `returnedAt: null` is the
   * other half of it: a delivery that was taken back is a delivery that was not made, and the item
   * goes wherever the switch says it goes.
   */
  private async carried(
    itemId: string,
    assignedAt: Date,
    sessionId: string | null,
  ): Promise<boolean> {
    if (!sessionId) return false;
    const carried = await this.prisma.projectOpenItemDelivery.count({
      where: {
        itemId,
        sessionId,
        purpose: 'ITEM',
        returnedAt: null,
        clientTurnId: openItemTurnId(itemId, assignedAt),
      },
    });
    return carried > 0;
  }

  /**
   * An item nobody's coordinator can read is the owner's (§4.4 X-D6) — while it is still owed
   * (`openItemOwed`). One about a candidate or a task that has moved on is nobody's: it stays where it
   * is, and the escalation tick's backstop closes it.
   */
  private async handToOwner(
    itemId: string,
    assignedAt: Date,
    reason: Extract<OpenItemAssigneeReason, 'NO_COORDINATOR' | 'COORDINATOR_ENDED'>,
  ): Promise<void> {
    const handed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "project_open_item" item
         SET "assignee" = 'OWNER', "assignee_reason" = ${reason}, "assigned_at" = now(),
             "escalate_at" = NULL, "updated_at" = now()
       WHERE item."id" = ${itemId}::uuid AND item."state" = 'OPEN' AND item."assignee" = 'COORDINATOR'
         AND item."assigned_at" = ${assignedAt.toISOString()}::timestamptz
         AND ${openItemOwed('item')}`);
    // Only on the edge this call made: the compare-and-set above is what decides whether this
    // process is the one that handed the item over, and a second announcement of the same
    // handover is a second banner about one waiting thing.
    if (handed > 0) void this.push?.notifyOwnerItem(itemId);
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

/** A key for a caller that sent none: one question per call, which is what asking once means. */
function randomKey(): string {
  return randomUUID();
}

/** The line under an item's title, in the words of the fact (English: this is UI copy). */
function detailLine(kind: string, payload: unknown): string {
  // A pause writes its own, because what it has to say is not "something failed" but what the
  // coordinator spent, what is still running without it, and what resuming does and does not do.
  if (kind === 'FUSE_PAUSED') return fusePausedDetailLine(payload as FusePausedPayload);
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

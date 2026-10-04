import { Prisma } from '@prisma/client';
import {
  IntegrationCheckResult,
  OpenItemAction,
  OpenItemDeliveryCard,
  OpenItemFacts,
  OwnerItemKind,
  SessionLifecycleState,
  SessionRunState,
  deriveSessionLifecycleState,
  deriveSessionRunState,
  uuidToBase62,
} from '@orbit/shared';

import { taskLanding, readLandingBranches } from './project-criterion-landing';
import { LIVE_PROMOTION_STATES } from './project-promotion';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Exception items: what a project owes somebody a decision about
 * (`docs/project-integration-line-contract.md` §4).
 *
 * This module is the part that runs INSIDE the transaction that wrote the fact — the task failure
 * (§4.3), and the drain that takes an item's turn off a conversation's queue unrun (§4.4 X-D5). What
 * happens after that transaction commits — delivering an item to the coordinator, handing one to the
 * owner, resolving one whose task moved on — is `project-open-item.service.ts`, because it writes
 * turns and needs services this one deliberately does not import.
 *
 * The closed sets below are the same ones migration 0273 spells as CHECK constraints. They are
 * written out rather than derived from Prisma enums because the columns are `text`: a new kind is a
 * migration, not a deploy that starts writing a value the database has never seen.
 */

/** What an item is about (§4.2), and a coordinator's request to start its project
 *  (`START_REQUEST`, `project-start-request.ts`; migration 0333) or to have it recorded done
 *  (`DONE_REQUEST`, `project-done-request.ts`; migration 0345). */
export const OPEN_ITEM_KINDS = [
  'INTEGRATION_CONFLICT',
  'INTEGRATION_CHECK_FAILED',
  'INTEGRATION_ERROR',
  'TASK_FAILED',
  'PROMOTION_APPROVAL',
  'COORDINATOR_QUESTION',
  'FUSE_PAUSED',
  'START_REQUEST',
  'DONE_REQUEST',
] as const;
export type OpenItemKind = (typeof OPEN_ITEM_KINDS)[number];

/** Who acts on it: the project's coordinator conversation, or the account owner in person. */
export const OPEN_ITEM_ASSIGNEES = ['COORDINATOR', 'OWNER'] as const;
export type OpenItemAssignee = (typeof OPEN_ITEM_ASSIGNEES)[number];

/** Why it has that assignee — the difference between "this is the ordinary route" and every way an
 *  item ends up with a person: nobody coordinates this project, the conversation ended, the chain
 *  hit its limit, it waited too long, or somebody handed it over. */
export const OPEN_ITEM_ASSIGNEE_REASONS = [
  'DEFAULT',
  'NO_COORDINATOR',
  'COORDINATOR_ENDED',
  'CHAIN_LIMIT',
  'ESCALATED',
  'HANDED_OVER',
] as const;
export type OpenItemAssigneeReason = (typeof OPEN_ITEM_ASSIGNEE_REASONS)[number];

/**
 * Every reason an item ENDED UP with the owner rather than having been theirs all along (§7.1 V1).
 *
 * The four owner-facing kinds are not the seven an item can be about: a merge approval, a question
 * and a pause are the owner's from birth and say so in their own titles, and every exception that
 * reached them — no coordinator, the conversation ended, the chain ran out, the clock took it, or
 * somebody handed it over — is one thing to whoever is being told, "this is yours now".
 */
export const OPEN_ITEM_ESCALATION_REASONS: ReadonlyArray<OpenItemAssigneeReason> = [
  'NO_COORDINATOR',
  'COORDINATOR_ENDED',
  'CHAIN_LIMIT',
  'ESCALATED',
  'HANDED_OVER',
];

/**
 * Which of the four owner-facing kinds this item is (§7.6 V12/V13), or null when the owner is not
 * the one being asked.
 *
 * The one place that decides it, because three surfaces turn on the same answer and a second
 * derivation of it would be a third: the push that rings a phone, the count the Needs-you banner
 * and the macOS menu bar read, and the chip on the project list. `assignee` is the whole of the
 * negative case — an exception the coordinator is still working on is not the owner's to be told
 * about (owner decision 10), however long it has been open.
 */
export function ownerItemKind(item: {
  kind: OpenItemKind | string;
  assignee: OpenItemAssignee | string;
  assigneeReason: OpenItemAssigneeReason | string;
}): OwnerItemKind | null {
  if (item.assignee !== 'OWNER') return null;
  if (item.kind === 'PROMOTION_APPROVAL' || item.kind === 'COORDINATOR_QUESTION'
      || item.kind === 'FUSE_PAUSED') {
    return item.kind;
  }
  return OPEN_ITEM_ESCALATION_REASONS.includes(item.assigneeReason as OpenItemAssigneeReason)
    ? 'ESCALATED'
    : null;
}

export const OPEN_ITEM_STATES = ['OPEN', 'RESOLVED', 'SUPERSEDED'] as const;
export type OpenItemState = (typeof OPEN_ITEM_STATES)[number];

/** How an item ended. Each one names a fact, not a feeling: every value here is something a reader
 *  can go and check. */
export const OPEN_ITEM_RESOLUTIONS = [
  'LANDED',
  'RETRIED',
  'TASK_DONE',
  'TASK_CLOSED',
  'SUCCESSOR_FILED',
  'PROMOTION_MOVED_ON',
  'HANDLED',
  'APPROVED',
  'DECLINED',
  'ANSWERED',
  'WITHDRAWN',
  'RESUMED',
] as const;
export type OpenItemResolution = (typeof OPEN_ITEM_RESOLUTIONS)[number];

export const OPEN_ITEM_RESOLVED_BY = ['USER', 'COORDINATOR', 'PLATFORM'] as const;
export type OpenItemResolvedBy = (typeof OPEN_ITEM_RESOLVED_BY)[number];

/** One item's doors, as a reader that has to draw them needs it: the columns the list and the
 *  delivery card both fold into the same answer. */
export interface OpenItemActionsSource {
  kind: OpenItemKind | string;
  assignee: OpenItemAssignee | string;
  taskId: string | null;
  promotionId: string | null;
  fuseEpisodeId: string | null;
  /** Whether this project has a coordinator conversation left to ask again (§4.8) — the one press
   *  that turns on a fact outside the row. */
  askable: boolean;
}

/**
 * The doors that exist for one item today (§4.8): what its kind is decided by, and, for a task's
 * item, who is carrying it. An action nobody can perform is not offered, so the list is derived
 * from the row rather than from the kind alone.
 *
 * One function, because two readers draw it — the project's open-items list and the card recorded
 * beside an item's delivery — and two derivations of one answer are two things free to disagree.
 */
export function openItemActions(source: OpenItemActionsSource): OpenItemAction[] {
  if (source.fuseEpisodeId) return ['RESUME'];
  if (source.kind === 'COORDINATOR_QUESTION') return ['ANSWER'];
  // A merge into main is decided on its own card, which says what would land and what the checks
  // came to (§7.5): the row is the way in. An integration failure of that merge that has become the
  // owner's also has the way back a task's item has (§4.7): the press puts it back in front of the
  // coordinator, whose door for it is the candidate's re-check (`decidePromotionRetry`). The merge
  // card itself is the owner's to decide and has no such way back.
  if (source.promotionId) {
    return source.assignee === 'OWNER'
      && source.askable
      && INTEGRATION_ITEM_KINDS.includes(source.kind as OpenItemKind)
      ? ['ASK_COORDINATOR_AGAIN', 'REVIEW']
      : ['REVIEW'];
  }
  if (!source.taskId) return [];
  if (source.assignee === 'COORDINATOR') {
    // The coordinator's own: it can be looked at, run again, or stopped.
    return ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'];
  }
  // An escalated item's route back is through the coordinator that should have had it (§4.7) —
  // the owner's press is to ask again, not to retry work the coordinator owns — and to stop the
  // task outright.
  return [
    ...(source.askable ? ['ASK_COORDINATOR_AGAIN' as const] : []),
    'OPEN_TASK_SESSION',
    'CANCEL_TASK',
  ];
}

/**
 * How a task came to fail (§4.3). Every door that writes `task.status = FAILED`, plus the two the
 * reaper takes a run back through without writing FAILED at all — an attempt that was lost is a
 * failure of the attempt, and the task sitting in the pool again is not somebody having decided so.
 */
export const TASK_FAILURE_HOWS = [
  'ACCEPTANCE_EXIT_MISMATCH',
  'RUN_FAILED',
  'RUNNER_FINALIZED_FAILED',
  'REAPED_API_ERROR',
  'ATTEMPT_LOST_RUNNER_OFFLINE',
  'ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED',
  'REPORTED_FAILED',
] as const;
export type TaskFailureHow = (typeof TASK_FAILURE_HOWS)[number];

/**
 * How many failures one chain of attempts gets before the item goes to the owner instead of the
 * coordinator (§4.5 X-C3). The third failure is the first one no rule allows: the spend fuse permits
 * two retries of a chain, so a third failure is the coordinator having spent what it may spend on
 * this piece of work and still not having it.
 */
export const TASK_FAILURE_CHAIN_LIMIT = 3;

/** Hops the chain walk takes in each direction, the same bound the dependency tail walk uses. */
const MAX_CHAIN_HOPS = 256;

/** Longest error text an item carries. The message built from it is a turn, and a turn has a size. */
const MAX_ERROR_CHARS = 2_000;

/** Every item turn's client id starts here, which is how a drain recognises one on a queue. */
export const OPEN_ITEM_TURN_PREFIX = 'open-item:v1:';

/**
 * The key an item's turn is queued under (§0.3 G6): the item, and the moment its assignee was last
 * decided. A reassignment is a different key, so an item handed back to the coordinator is delivered
 * again rather than replaying the turn its previous assignee had.
 */
export function openItemTurnId(itemId: string, assignedAt: Date): string {
  return `${OPEN_ITEM_TURN_PREFIX}${itemId}:${assignedAt.getTime()}`;
}

/**
 * The item a delivery turn is about, read back off the turn's own key — or null for any other turn.
 *
 * The key is the item's id and the moment its assignee was last decided, which is exactly what a
 * reader of the turn needs to find the row it was built from. Nothing is minted and nothing is
 * looked up: the one write that makes a turn an item's delivery is the same one that names it here.
 */
export function openItemIdOfTurn(clientTurnId: string | null | undefined): string | null {
  // Every reader that is not an item turn answers null here, and a caller reading a column is one
  // of them: this runs on the event-ingest path, where a throw costs a batch of somebody's
  // transcript, and "this turn is not one of ours" is not a fault.
  if (typeof clientTurnId !== 'string' || !clientTurnId.startsWith(OPEN_ITEM_TURN_PREFIX)) return null;
  const rest = clientTurnId.slice(OPEN_ITEM_TURN_PREFIX.length);
  const cut = rest.lastIndexOf(':');
  return cut > 0 ? rest.slice(0, cut) : null;
}

/** Every owner answer's client id starts here (§5.2 R10). */
export const OWNER_ANSWER_TURN_PREFIX = 'owner-answer:v1:';

/**
 * The key an owner's answer is queued under: the question, and the conversation it is being told to.
 *
 * The conversation rather than a moment, because that is what §5.2 R11 counts: a project that
 * rotates its coordinator owes the answer to the new one as well, and one generation reads it once.
 */
export function ownerAnswerTurnId(itemId: string, sessionId: string): string {
  return `${OWNER_ANSWER_TURN_PREFIX}${itemId}:${sessionId}`;
}

/** What `ask_owner` files, and what the card renders (§5.2 R7, §4.2). */
export interface CoordinatorQuestion {
  question: string;
  options: Array<{ label: string; description?: string }>;
  /** Index into `options`; null when the coordinator recommended nothing. */
  recommendedOption: number | null;
  blocksTaskIds: string[];
  /** What happens if nobody answers, in the asker's own words. */
  ifUnanswered: string | null;
}

/** How the owner answered: an option, free text, or both. */
export interface OwnerAnswer {
  option?: number;
  text?: string;
  answeredByUserId: string;
}

/** Longest question a card shows and a turn carries (§5.2 R7). */
export const MAX_QUESTION_CHARS = 2_000;
/**
 * Longest reason a hand-closing carries (§4.7's "标记已处理").
 *
 * The same bound as a question, and for a comparable reason: this sentence is what somebody reads
 * where the platform could not decide for itself, so it should be a sentence. Longer than that is a
 * report, and a report's home is a task comment or the conversation, not a column on a card.
 */
export const MAX_OPEN_ITEM_RESOLUTION_NOTE = 2_000;
/** A choice is between alternatives; more than four is a conversation, not a card. */
const MAX_OPTIONS = 4;

/** A question as the caller asked it, before it is a row. */
export interface AskedQuestion {
  question: string;
  options?: Array<{ label: string; description?: string }>;
  recommendedOption?: number;
  blocksTaskIds?: string[];
  ifUnanswered?: string;
}

/** Refused at the door, in the words the caller reads. Thrown as a 400 by the service. */
export class QuestionNotAskable extends Error {}

/**
 * The question, normalized to the five fields every reader of the payload can count on.
 *
 * Every optional field becomes an explicit empty or null rather than an absent key: the card reads
 * this, the turn is built from it, and "the coordinator recommended nothing" is a different fact
 * from "an older build did not record recommendations".
 */
export function coordinatorQuestion(asked: AskedQuestion): CoordinatorQuestion {
  const question = (asked.question ?? '').trim();
  if (!question) throw new QuestionNotAskable('question is required');
  if (question.length > MAX_QUESTION_CHARS) {
    throw new QuestionNotAskable(`question must be at most ${MAX_QUESTION_CHARS} characters`);
  }
  const options = (asked.options ?? []).map((option) => ({
    label: (option?.label ?? '').trim(),
    ...(option?.description?.trim() ? { description: option.description.trim() } : {}),
  }));
  if (options.some((option) => !option.label)) {
    throw new QuestionNotAskable('every option needs a label');
  }
  // Nothing to choose between is a free answer; one option is not a choice at all.
  if (options.length === 1 || options.length > MAX_OPTIONS) {
    throw new QuestionNotAskable(`options must be 0 or 2 to ${MAX_OPTIONS} entries`);
  }
  const recommended = asked.recommendedOption;
  if (recommended !== undefined && recommended !== null) {
    if (!Number.isInteger(recommended) || recommended < 0 || recommended >= options.length) {
      throw new QuestionNotAskable('recommendedOption must name one of the options');
    }
  }
  return {
    question,
    options,
    recommendedOption: recommended ?? null,
    blocksTaskIds: [...new Set(asked.blocksTaskIds ?? [])],
    ifUnanswered: asked.ifUnanswered?.trim() || null,
  };
}

/** The one line under a question's title: what it blocks, and what happens if nobody answers. */
export function questionDetailLine(question: CoordinatorQuestion): string {
  const blocks = question.blocksTaskIds.length > 0
    ? `Blocks ${question.blocksTaskIds.length} task${question.blocksTaskIds.length > 1 ? 's' : ''}`
    : '';
  const unanswered = question.ifUnanswered ? `If you don’t answer: ${question.ifUnanswered}` : '';
  return [blocks, unanswered].filter(Boolean).join(' · ');
}

/** The answer in the words it is shown and told in: the option chosen, the text given, or both. */
export function answerInWords(question: CoordinatorQuestion, answer: OwnerAnswer): string {
  const chosen = answer.option !== undefined ? question.options[answer.option]?.label : undefined;
  return [chosen, answer.text?.trim()].filter(Boolean).join(' — ') || '(no answer given)';
}

/**
 * What the coordinator is told when the owner has answered (§5.2 R10).
 *
 * Built only from rows that no longer change — the question as it was asked, the answer as it was
 * given, the moment it was answered — because a replay under the same key compares the content byte
 * for byte, and a conversation that already read it must not be told a second, differently worded
 * version of the same answer.
 */
export function ownerAnswerMessage(
  question: CoordinatorQuestion,
  answer: OwnerAnswer,
  answeredAt: Date,
): string {
  return `From Orbit · owner answer: you asked "${question.question}". `
    + `The owner answered: ${answerInWords(question, answer)} (${answeredAt.toISOString()}).`;
}

/** The columns "has this conversation ended" is decided from. */
export const SESSION_ENDING_SELECT = {
  status: true,
  endReason: true,
  completedAt: true,
  archivedAt: true,
  deletedAt: true,
  cancelRequestedAt: true,
} as const;

export interface SessionEnding {
  status: string;
  endReason: string | null;
  completedAt: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
  cancelRequestedAt: Date | null;
}

/**
 * Whether a conversation is over, for the purposes of §0.3 G6: a platform turn is never what revives
 * one. Wider than `createTurn`'s own refusal on purpose — it also refuses a session filed as
 * Completed and an INTERRUPTED one whose end was recorded, both of which `createTurn` would queue
 * onto, because from the outside those are conversations somebody closed.
 */
export function sessionHasEnded(session: SessionEnding): boolean {
  if (session.cancelRequestedAt) return true;
  if (deriveSessionLifecycleState(session) !== SessionLifecycleState.OPEN) return true;
  const run = deriveSessionRunState(session);
  return run === SessionRunState.ENDED
    || run === SessionRunState.SUCCEEDED
    || run === SessionRunState.FAILED;
}

/**
 * Whether a conversation that cannot take a turn right now is only DOWN rather than over: its run
 * FAILED — the provider turned a turn away (a 429, an overload), its sign-in expired, its runner went
 * away — and nobody closed it. No end is recorded and it is still Open, so a retry, the owner's or
 * the auto-retry sweep's, brings the same conversation back.
 *
 * `sessionHasEnded` says yes to it, and is right to for what it guards: a platform turn does not
 * revive a conversation, and `createTurn` refuses a FAILED one anyway. Who an exception item waits
 * for is a different question. Handing every item opened during an outage straight to the owner
 * made them the coordinator's errand-runner for something it recovers from on the next retry
 * (2026-10-02: a merge conflict opened while the coordinator sat FAILED on 429s went to the owner,
 * who had to revive the coordinator and then press "Ask the coordinator again"). So an item stays
 * the coordinator's while it is down, is delivered when its next turn ends (§4.4 X-D4 3), and goes
 * to the owner by the clock if it is not back within the window (§4.6 X-E1).
 *
 * `cancelRequestedAt` is not read: a failed turn and the reaper both write it beside FAILED, to have
 * the runner tear the process down, and neither is anybody ending the conversation.
 */
export function conversationIsDown(session: SessionEnding): boolean {
  return deriveSessionRunState(session) === SessionRunState.FAILED
    && !session.endReason
    && deriveSessionLifecycleState(session) === SessionLifecycleState.OPEN;
}

/** Whether an exception item has no conversation left to wait for: it ended, and is not merely
 *  down (`conversationIsDown`). This, not `sessionHasEnded`, is what hands an item to the owner. */
export function conversationIsOver(session: SessionEnding): boolean {
  return sessionHasEnded(session) && !conversationIsDown(session);
}

/** A task failure, as the door that wrote it knows it. */
export interface TaskFailure {
  taskId: string;
  /** The attempt that failed, when there was one. */
  sessionId: string | null;
  how: TaskFailureHow;
  exitCode?: number;
  expectedExitCode?: number;
  error?: string | null;
}

/** What the caller needs after the commit to deliver the item it just opened. */
export interface RecordedOpenItem {
  itemId: string;
  projectId: string;
  /**
   * The task it is about, when it is about one. A promotion job names no task (§3.4 writes
   * `task_id` NULL deliberately), so an item it opens has none — and the caller has to deliver that
   * one by the item id it is holding, because no read can find it by a task it does not have.
   */
  taskId: string | null;
  assignee: OpenItemAssignee;
}

/** The item kinds an integration job's failure opens (§4.2). One family, because they share every
 *  terminal fact: the task landing, the task going away, or somebody deciding they are handled. */
export const INTEGRATION_ITEM_KINDS: readonly OpenItemKind[] = [
  'INTEGRATION_CONFLICT',
  'INTEGRATION_CHECK_FAILED',
  'INTEGRATION_ERROR',
];

/**
 * Whether an OPEN item is still owed — whether what it is about can still be put right by whoever it
 * is in front of — as SQL over the `project_open_item` row aliased `alias`. The one definition every
 * reader that shows or counts open items asks, and the one the escalation tick's backstop closes by
 * (`ProjectOpenItemEscalationService.reconcile`).
 *
 * An item is closed by the transaction that moves what it is about: the task landing, the task going
 * away, a candidate leaving the live states (§4.2). That is one edge per fact, written at each door,
 * and a door that misses its edge leaves an item open about something that is gone — escalated to the
 * owner on the clock, pushed to their phone, counted on the badge and, for an integration item, held
 * against every later candidate of the project by M-T11 (2026-10-02: a failed check about a superseded
 * candidate stayed open, with the owner, hours after the project's branch was on main). So the readers
 * do not take OPEN for owed; they ask this, and an edge missed tomorrow leaves nothing in front of
 * anybody.
 *
 * By what the item names:
 *  - a merge card (`PROMOTION_APPROVAL`) is owed while its candidate is READY, the one state the
 *    owner's Merge acts on (`promotionConfirmRefusal`);
 *  - an INTEGRATION_* item about a candidate, while the candidate is live (`LIVE_PROMOTION_STATES`,
 *    BLOCKED among them: a blocked candidate is what such an item waits on somebody to fix);
 *  - an INTEGRATION_* item about a task's landing, while the task is neither cancelled nor replaced —
 *    the two facts `resolveByFact` answers it with. A task that LANDED is deliberately not among
 *    them: the item is about landing on this project's line, and that the work reached some other
 *    branch instead is in no row, so such an item stays owed and the backstop only reports it;
 *  - anything else — a task's failure, a question, a pause, a request — while it is open: what
 *    answers those is a person, or a fact this predicate has no row for.
 *
 * Parameter-free, like `escalatesAt`: it splices into a statement without moving that statement's
 * placeholders, and its text is the text `scripts/project-liveness-audit.sql` spells, which has no
 * TypeScript to call.
 */
export function openItemOwed(alias: string): Prisma.Sql {
  const item = Prisma.raw(`"${alias}"`);
  const integration = Prisma.raw(INTEGRATION_ITEM_KINDS.map((kind) => `'${kind}'`).join(', '));
  const live = Prisma.raw(LIVE_PROMOTION_STATES.map((state) => `'${state}'`).join(', '));
  return Prisma.sql`(CASE
      WHEN ${item}."promotion_id" IS NOT NULL AND ${item}."kind" = 'PROMOTION_APPROVAL' THEN EXISTS (
        SELECT 1 FROM "project_promotion" owed_promotion
         WHERE owed_promotion."id" = ${item}."promotion_id"
           AND owed_promotion."state" = 'READY')
      WHEN ${item}."promotion_id" IS NOT NULL AND ${item}."kind" IN (${integration}) THEN EXISTS (
        SELECT 1 FROM "project_promotion" owed_promotion
         WHERE owed_promotion."id" = ${item}."promotion_id"
           AND owed_promotion."state" IN (${live}))
      WHEN ${item}."task_id" IS NOT NULL AND ${item}."kind" IN (${integration}) THEN EXISTS (
        SELECT 1 FROM "task" owed_task
         WHERE owed_task."id" = ${item}."task_id"
           AND owed_task."status" <> 'CANCELLED'
           AND owed_task."superseded_by_task_id" IS NULL)
      ELSE true
    END)`;
}

/**
 * Which of these items nobody owes any more (`openItemOwed`), for a reader that found them through
 * Prisma and so has no statement to splice the predicate into. One query whatever the number of ids,
 * and none for an empty list.
 */
export async function openItemsNoLongerOwed(
  db: Prisma.TransactionClient,
  itemIds: readonly string[],
): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT item."id"
      FROM "project_open_item" item
     WHERE item."id" IN (${Prisma.join(itemIds.map((id) => Prisma.sql`${id}::uuid`))})
       AND NOT ${openItemOwed('item')}`);
  return new Set(rows.map((row) => row.id));
}

interface ChainReading {
  rootTaskId: string;
  /** TASK_FAILED items already on this chain, since its last DONE. */
  failures: number;
  /** TASK_FAILED items on THIS task that no attempt is behind, which number the next such key. */
  writes: number;
}

/**
 * Open the item for a task that failed, in the transaction that wrote the failure (§4.3).
 *
 * Returns null when there is nothing to open: a task no project owns (nobody is responsible for work
 * that is under no goal), or a failure already recorded — the partial unique index over OPEN items
 * means one fact opens one item however many times the door is replayed.
 *
 * The assignee is decided here, from rows this transaction can see: the chain's failure count first
 * (§4.5), then whether this project has a coordinator conversation that can still read anything — a
 * conversation that is only down will, once it is retried (`conversationIsOver`). A delivery that
 * later finds the conversation over hands the item to the owner (§4.4 X-D6); this is the same
 * decision made earlier, when it can be made without waiting for the commit.
 */
export async function recordTaskFailure(
  tx: Prisma.TransactionClient,
  failure: TaskFailure,
): Promise<RecordedOpenItem | null> {
  const task = await tx.task.findUnique({
    where: { id: failure.taskId },
    select: { ownerId: true, projectId: true, title: true },
  });
  if (!task?.projectId) return null;
  const project = await tx.project.findUnique({
    where: { id: task.projectId },
    select: {
      coordinatorEnabled: true,
      coordinatorSessionId: true,
      exceptionEscalationSeconds: true,
      coordinatorSession: { select: SESSION_ENDING_SELECT },
    },
  });
  if (!project) return null;

  const chain = await readChain(tx, failure.taskId);
  const failuresInChain = chain.failures + 1;
  const dedupeKey = failure.sessionId
    ? `TF:${failure.taskId}:${failure.sessionId}`
    : `TF:${failure.taskId}:write:${chain.writes + 1}`;
  const coordinator = project.coordinatorEnabled && project.coordinatorSessionId
    ? project.coordinatorSession
    : null;
  const [assignee, assigneeReason]: [OpenItemAssignee, OpenItemAssigneeReason] =
    failuresInChain >= TASK_FAILURE_CHAIN_LIMIT ? ['OWNER', 'CHAIN_LIMIT']
      : !coordinator ? ['OWNER', 'NO_COORDINATOR']
        : conversationIsOver(coordinator) ? ['OWNER', 'COORDINATOR_ENDED']
          : ['COORDINATOR', 'DEFAULT'];
  const now = new Date();
  const payload = {
    how: failure.how,
    ...(failure.exitCode !== undefined ? { exitCode: failure.exitCode } : {}),
    ...(failure.expectedExitCode !== undefined ? { expectedExitCode: failure.expectedExitCode } : {}),
    ...(failure.error ? { error: clip(failure.error) } : {}),
    chain: {
      rootTaskId: chain.rootTaskId,
      failuresInChain,
      limit: TASK_FAILURE_CHAIN_LIMIT,
    },
  };
  const [created] = await tx.projectOpenItem.createManyAndReturn({
    data: [{
      projectId: task.projectId,
      ownerId: task.ownerId,
      kind: 'TASK_FAILED' satisfies OpenItemKind,
      state: 'OPEN' satisfies OpenItemState,
      assignee,
      assigneeReason,
      taskId: failure.taskId,
      sessionId: failure.sessionId,
      dedupeKey,
      title: `Task failed: ${task.title}`,
      payload: payload as unknown as Prisma.InputJsonValue,
      waitingSince: now,
      assignedAt: now,
      escalateAt: assignee === 'COORDINATOR'
        ? new Date(now.getTime() + project.exceptionEscalationSeconds * 1_000)
        : null,
    }],
    skipDuplicates: true,
    select: { id: true },
  });
  // A second failure of the same task is the first one having been retried, whatever the retry came
  // to. Said here, in the same transaction, because this is where the fact that says so is written.
  await tx.projectOpenItem.updateMany({
    where: {
      taskId: failure.taskId,
      kind: 'TASK_FAILED',
      state: 'OPEN',
      dedupeKey: { not: dedupeKey },
    },
    data: {
      state: 'RESOLVED' satisfies OpenItemState,
      resolution: 'RETRIED' satisfies OpenItemResolution,
      resolvedAt: now,
      resolvedBy: 'PLATFORM' satisfies OpenItemResolvedBy,
    },
  });
  if (!created) return null;
  return { itemId: created.id, projectId: task.projectId, taskId: failure.taskId, assignee };
}

/** An integration that stopped, as the transaction that finished the job knows it (§2.6). */
export interface IntegrationFailure {
  projectId: string;
  ownerId: string;
  jobId: string;
  taskId: string | null;
  sessionId: string | null;
  /** The job's terminal state, which decides the kind: CONFLICT, CHECK_FAILED or ERROR. */
  state: 'CONFLICT' | 'CHECK_FAILED' | 'ERROR';
  /** The promotion this failure was part of, when the job was checking or landing one (M-T3, M-T9). */
  promotionId?: string | null;
  title: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  /**
   * The account owner's hold on the failure this one repeats, when the coordinator's rerun failed
   * again after the item it was handling had reached the owner (§4.7 H4): the new item stays theirs,
   * with the reason and the wait it already had, rather than going back to the coordinator.
   */
  heldByOwner?: OwnerHeldItem | null;
}

/** An item the account owner holds, as the item that repeats its failure inherits it (§4.7 H4). */
export interface OwnerHeldItem {
  assigneeReason: OpenItemAssigneeReason;
  waitingSince: Date;
  escalatedAt: Date | null;
}

/**
 * Open the item for an integration that did not land, in the transaction that wrote the job's
 * terminal state (§2.6, §4.2).
 *
 * The platform does not retry a conflict or a red check by itself (J5), so this item IS the retry
 * mechanism: it names somebody, and what they decide is what happens next. Never escalated past the
 * coordinator by this function — a conflict has no chain limit, because there is no chain: one
 * failed job is one generation, and a second generation only exists because somebody asked.
 *
 * Returns null when the partial unique index already holds this key, which is how a result the
 * runner reported twice opens one item.
 */
export async function recordIntegrationFailure(
  tx: Prisma.TransactionClient,
  failure: IntegrationFailure,
): Promise<RecordedOpenItem | null> {
  const project = await tx.project.findUnique({
    where: { id: failure.projectId },
    select: {
      coordinatorEnabled: true,
      coordinatorSessionId: true,
      exceptionEscalationSeconds: true,
      coordinatorSession: { select: SESSION_ENDING_SELECT },
    },
  });
  if (!project) return null;

  const coordinator = project.coordinatorEnabled && project.coordinatorSessionId
    ? project.coordinatorSession
    : null;
  const [assignee, assigneeReason]: [OpenItemAssignee, OpenItemAssigneeReason] =
    !coordinator ? ['OWNER', 'NO_COORDINATOR']
      : conversationIsOver(coordinator) ? ['OWNER', 'COORDINATOR_ENDED']
        : ['COORDINATOR', 'DEFAULT'];
  const now = new Date();
  // §4.7 H4: a rerun's failure stays with the owner who already held the failure it repeats.
  const held = failure.heldByOwner ?? null;
  const [holder, holderBecause]: [OpenItemAssignee, OpenItemAssigneeReason] =
    held ? ['OWNER', held.assigneeReason] : [assignee, assigneeReason];
  const [created] = await tx.projectOpenItem.createManyAndReturn({
    data: [{
      projectId: failure.projectId,
      ownerId: failure.ownerId,
      kind: (failure.state === 'CONFLICT' ? 'INTEGRATION_CONFLICT'
        : failure.state === 'CHECK_FAILED' ? 'INTEGRATION_CHECK_FAILED'
          : 'INTEGRATION_ERROR') satisfies OpenItemKind,
      state: 'OPEN' satisfies OpenItemState,
      assignee: holder,
      assigneeReason: holderBecause,
      taskId: failure.taskId,
      sessionId: failure.sessionId,
      integrationJobId: failure.jobId,
      promotionId: failure.promotionId ?? null,
      dedupeKey: failure.dedupeKey,
      title: failure.title,
      payload: failure.payload as unknown as Prisma.InputJsonValue,
      // The owner's wait goes on rather than starting over: it is the same failure, and the card that
      // says how long they have had it would otherwise reset on every rerun.
      waitingSince: held?.waitingSince ?? now,
      assignedAt: now,
      escalatedAt: held?.escalatedAt ?? null,
      escalateAt: holder === 'COORDINATOR'
        ? new Date(now.getTime() + project.exceptionEscalationSeconds * 1_000)
        : null,
    }],
    skipDuplicates: true,
    select: { id: true },
  });
  if (!created) return null;
  return {
    itemId: created.id,
    projectId: failure.projectId,
    taskId: failure.taskId,
    assignee: holder,
  };
}

/**
 * §2.2 J-T5: the task's landing answers what was open about landing it.
 *
 * Called in the transaction that wrote the job's `LANDED` / `ALREADY_LANDED`, beside the receipt —
 * the item exists because this task's work is not on the integration line, and the receipt is the
 * fact that says it now is. Keyed by TASK rather than by the job that landed: the item still open
 * is the one an earlier generation left (§4.2 gives a conflict exactly one answer per fact, and the
 * one it gets here is the landing, whenever it comes).
 *
 * The three kinds are the ones a job's failure opens. `TASK_FAILED` is deliberately not among them:
 * a landing does not change the task's own status, and what answers that item is the status.
 */
export async function resolveIntegrationItemsOnLanding(
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<void> {
  await tx.projectOpenItem.updateMany({
    where: { taskId, kind: { in: [...INTEGRATION_ITEM_KINDS] }, state: 'OPEN' },
    data: {
      state: 'RESOLVED' satisfies OpenItemState,
      resolution: 'LANDED' satisfies OpenItemResolution,
      resolvedAt: new Date(),
      resolvedBy: 'PLATFORM' satisfies OpenItemResolvedBy,
    },
  });
}

/** What the coordinator's rerun of a failure carries onto the items it is handling (§4.7 H1). */
export interface OpenItemHandlingStart {
  /** The job the rerun queued: the task's next LAND_TASK, or the candidate's next CHECK_PROMOTION. */
  jobId: string;
  /** The coordinator conversation that asked for it. */
  sessionId: string;
  reason: string;
}

/**
 * §4.7 H1: the coordinator asked for a failure to be run again, so the items it holds about that
 * failure are now being HANDLED — written in the transaction that queued the rerun, beside the job.
 *
 * They are not closed. The rerun can land, or fail the same way, and which of the two it will be is
 * the one thing nobody knows at this moment: an item closed now is a card saying the failure was
 * dealt with while it may be about to happen again. So the item stays OPEN, naming the job that will
 * answer it, who asked and why, and that job's terminal state is what ends it (H2, H3).
 *
 * Only the coordinator's own items: the decision that let the rerun through refused it outright when
 * any item about the failure was the account owner's (`decideIntegrationRetry`,
 * `decidePromotionRetry`).
 */
export async function markOpenItemsHandling(
  tx: Prisma.TransactionClient,
  itemIds: readonly string[],
  handling: OpenItemHandlingStart,
): Promise<void> {
  if (itemIds.length === 0) return;
  await tx.projectOpenItem.updateMany({
    where: { id: { in: [...itemIds] }, state: 'OPEN', assignee: 'COORDINATOR' },
    data: {
      handlingJobId: handling.jobId,
      handlingSessionId: handling.sessionId,
      handlingReason: handling.reason,
      handlingStartedAt: new Date(),
    },
  });
}

/**
 * §4.7 H2: the coordinator's rerun succeeded — a task's landing LANDED or ALREADY_LANDED on the line,
 * or a blocked candidate's check came back READY — so the items it was handling are HANDLED, in the
 * transaction that wrote the job's terminal state.
 *
 * Every column of the ending is a fact somebody can check: the coordinator (`resolved_by`), the
 * conversation that asked for the rerun, the reason it gave, and the job that answered it — beside the
 * task or the candidate the item was always about. Only the items still the coordinator's: one the
 * clock handed to the account owner while the rerun ran is theirs (§4.6), and nothing closes it in the
 * coordinator's name after that — a landing answers it as it answers every item about the task
 * (LANDED, by the platform, J-T5), and a candidate's passing check leaves it to the owner, whose card
 * the merge then waits on (M-T11 counts it).
 *
 * Returns the items it closed.
 */
export async function resolveHandledItems(
  tx: Prisma.TransactionClient,
  jobId: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "project_open_item"
       SET "state" = 'RESOLVED',
           "resolution" = 'HANDLED',
           "resolved_at" = now(),
           "resolved_by" = 'COORDINATOR',
           "resolved_by_session_id" = "handling_session_id",
           "resolution_note" = "handling_reason",
           "resolved_by_job_id" = "handling_job_id",
           "updated_at" = now()
     WHERE "handling_job_id" = ${jobId}::uuid
       AND "state" = 'OPEN'
       AND "assignee" = 'COORDINATOR'
    RETURNING "id"`);
  return rows.map((row) => row.id);
}

/**
 * The account owner's hold on an item a rerun was handling — one the clock handed to them while the
 * rerun ran — as the item about the rerun's own failure inherits it (§4.7 H4); or null when every
 * item it was handling is still the coordinator's.
 */
export async function ownerHoldOnHandledItems(
  tx: Prisma.TransactionClient,
  jobId: string,
): Promise<OwnerHeldItem | null> {
  const held = await tx.projectOpenItem.findFirst({
    where: { handlingJobId: jobId, state: 'OPEN', assignee: 'OWNER' },
    orderBy: [{ waitingSince: 'asc' }, { id: 'asc' }],
    select: { assigneeReason: true, waitingSince: true, escalatedAt: true },
  });
  return held
    ? {
        assigneeReason: held.assigneeReason as OpenItemAssigneeReason,
        waitingSince: held.waitingSince,
        escalatedAt: held.escalatedAt,
      }
    : null;
}

/**
 * §4.7 H3: the coordinator's rerun failed again. The items it was handling are SUPERSEDED / RETRIED by
 * the item this failure just opened — in the transaction that wrote the job's terminal state and
 * opened that item — and never merely closed: the failure is real, and the new item is where it stands
 * in front of somebody. `superseded_by_item_id` is the thread from one to the other, written now
 * because a closed item is never rewritten (`project_open_item_terminal_guard`).
 *
 * Whoever holds them: an item the clock handed to the owner while the rerun ran is superseded as well,
 * by an item that stays theirs (`heldByOwner`), so the owner is never left holding a card about a
 * failure that has since happened again.
 */
export async function supersedeHandledItems(
  tx: Prisma.TransactionClient,
  jobId: string,
  byItemId: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "project_open_item"
       SET "state" = 'SUPERSEDED',
           "resolution" = 'RETRIED',
           "resolved_at" = now(),
           "resolved_by" = 'COORDINATOR',
           "resolved_by_session_id" = "handling_session_id",
           "resolution_note" = "handling_reason",
           "resolved_by_job_id" = "handling_job_id",
           "superseded_by_item_id" = ${byItemId}::uuid,
           "updated_at" = now()
     WHERE "handling_job_id" = ${jobId}::uuid
       AND "state" = 'OPEN'
       AND "id" <> ${byItemId}::uuid
    RETURNING "id"`);
  return rows.map((row) => row.id);
}

/**
 * The chain this task is one attempt in (§4.5 X-C1), and what has already failed on it.
 *
 * Both directions of `superseded_by_task_id`: the attempts this one replaced, and — for a task that
 * was itself replaced — the ones that replaced it. The count is every TASK_FAILED item on those
 * tasks since the last one of them was DONE, because a chain that succeeded and was reopened is not
 * a chain that has been failing all along.
 */
async function readChain(tx: Prisma.TransactionClient, taskId: string): Promise<ChainReading> {
  const [row] = await tx.$queryRaw<Array<{
    rootTaskId: string | null;
    failures: number;
    writes: number;
  }>>(Prisma.sql`
    WITH RECURSIVE "earlier" ("id", "depth") AS (
      SELECT ${taskId}::uuid, 0
      UNION ALL
      SELECT t."id", e."depth" + 1
        FROM "task" t JOIN "earlier" e ON t."superseded_by_task_id" = e."id"
       WHERE e."depth" < ${MAX_CHAIN_HOPS}
    ), "later" ("id", "depth") AS (
      SELECT ${taskId}::uuid, 0
      UNION ALL
      SELECT t."superseded_by_task_id", l."depth" + 1
        FROM "task" t JOIN "later" l ON t."id" = l."id"
       WHERE t."superseded_by_task_id" IS NOT NULL AND l."depth" < ${MAX_CHAIN_HOPS}
    ), "chain" AS (
      SELECT "id" FROM "earlier" UNION SELECT "id" FROM "later"
    ), "since" AS (
      SELECT max(i."resolved_at") AS "at"
        FROM "project_open_item" i
       WHERE i."task_id" IN (SELECT "id" FROM "chain") AND i."resolution" = 'TASK_DONE'
    )
    SELECT
      (SELECT e."id" FROM "earlier" e ORDER BY e."depth" DESC, e."id" LIMIT 1) AS "rootTaskId",
      (SELECT count(*)::int FROM "project_open_item" i, "since" s
        WHERE i."kind" = 'TASK_FAILED'
          AND i."task_id" IN (SELECT "id" FROM "chain")
          AND (s."at" IS NULL OR i."created_at" > s."at")) AS "failures",
      (SELECT count(*)::int FROM "project_open_item" i
        WHERE i."kind" = 'TASK_FAILED' AND i."task_id" = ${taskId}::uuid
          AND i."session_id" IS NULL) AS "writes"`);
  return {
    rootTaskId: row?.rootTaskId ?? taskId,
    failures: Number(row?.failures ?? 0),
    writes: Number(row?.writes ?? 0),
  };
}

/** What took an item's turn off a conversation's queue before a runner took it (§4.4 X-D5). */
export type UnrunOpenItemTurn =
  /** The conversation's run ended, and the drain that emptied its queue took this with it. */
  | { code: 'SESSION_ENDED'; ending: true }
  /** It was interrupted, and an interrupt drops what is queued behind the turn it stops. */
  | { code: 'TURN_INTERRUPTED' }
  /** One queued turn was withdrawn. */
  | { code: 'TURN_WITHDRAWN'; turnId: string };

/**
 * Take back an item's queued turn, in the transaction that takes it off the queue (§4.4 X-D5).
 *
 * "Delivered" is a turn a runner took, so a turn drained or deleted before that was never a delivery
 * and the item is still owed to somebody. Which somebody depends on what happened to the
 * conversation: an ENDING drain leaves nobody to read it, so the item becomes the owner's in this
 * same transaction; an interrupt or a withdrawal leaves the conversation alive, so the item stays
 * with the coordinator and is delivered again when its next turn ends (§4.4 X-D4).
 *
 * An ending drain whose run FAILED is the exception: the conversation is down, not over
 * (`conversationIsDown`), so the item stays the coordinator's too. A failed turn, the runner's
 * finalize and the reaper write that FAILED before they drain, which is what the read below sees;
 * an end somebody asked for drains before its status is written, and goes to the owner as before.
 * The drained turn is retired in place and keeps its key, which would make the next delivery a
 * replay of a turn nobody ran — so the assignment is re-made, same assignee and same clock, and
 * that delivery is a turn of its own.
 *
 * Called from every drain and delete that `deadLetterQueuedWatchWakes` is called from, immediately
 * beside it and for the same reason: nothing else would ever say the wake did not arrive.
 *
 * The read is the same shape as the statement that takes the turns off the queue, and a session with
 * nothing queued for it writes nothing. Lock order: the caller holds the Session row (rank 30); this
 * writes only delivery and item rows of that session's own items.
 */
export async function returnQueuedTurns(
  tx: Prisma.TransactionClient,
  sessionId: string,
  unrun: UnrunOpenItemTurn,
): Promise<void> {
  const queued = await tx.conversationTurn.findMany({
    where: {
      sessionId,
      ...('turnId' in unrun ? { id: unrun.turnId } : {}),
      status: 'PENDING',
      clientTurnId: { startsWith: OPEN_ITEM_TURN_PREFIX },
    },
    select: { clientTurnId: true },
  });
  if (queued.length === 0) return;
  const sent = await tx.projectOpenItemDelivery.findMany({
    where: {
      sessionId,
      purpose: 'ITEM',
      returnedAt: null,
      clientTurnId: { in: queued.map((turn) => turn.clientTurnId) },
    },
    select: { id: true, itemId: true },
  });
  if (sent.length === 0) return;
  const now = new Date();
  await tx.projectOpenItemDelivery.updateMany({
    where: { id: { in: sent.map((delivery) => delivery.id) }, returnedAt: null },
    data: { returnedAt: now, returnCode: unrun.code },
  });
  if (!('ending' in unrun)) return;
  const session = await tx.session.findUnique({ where: { id: sessionId }, select: SESSION_ENDING_SELECT });
  if (session && conversationIsDown(session)) {
    await tx.projectOpenItem.updateMany({
      where: {
        id: { in: sent.map((delivery) => delivery.itemId) },
        state: 'OPEN',
        assignee: 'COORDINATOR',
      },
      data: { assignedAt: now },
    });
    return;
  }
  await tx.projectOpenItem.updateMany({
    where: {
      id: { in: sent.map((delivery) => delivery.itemId) },
      state: 'OPEN',
      assignee: 'COORDINATOR',
    },
    data: {
      assignee: 'OWNER' satisfies OpenItemAssignee,
      assigneeReason: 'COORDINATOR_ENDED' satisfies OpenItemAssigneeReason,
      assignedAt: now,
      escalateAt: null,
    },
  });
}

/** The item as the message below is built from it: columns that never change after it was opened. */
export interface OpenItemMessageSource {
  id: string;
  kind: string;
  title: string;
  projectId: string;
  taskId: string | null;
  /** The candidate a promotion's failure is about; absent or null for every other item. */
  promotionId?: string | null;
  payload: unknown;
}

/** The payload fields an integration item carries (§4.2's payload column), all of them optional
 *  because the message is also built for items an older build opened. */
interface IntegrationItemPayload {
  jobKind?: string;
  phase?: string;
  targetRef?: string;
  targetSha?: string;
  files?: string[];
  nothingLanded?: boolean;
  branchUnchanged?: boolean;
  check?: {
    name?: string;
    command?: string;
    exitCode?: number;
    expectedExitCode?: number;
    outputTail?: string;
  } | null;
  errorCode?: string;
  errorDetail?: unknown;
  /** What the failure was of (`landingFailureClass`), and which generation of the landing it was. */
  failureClass?: string | null;
  generation?: number;
  /** Present on a generation the coordinator asked for through `integration_retry` (J-T1b). */
  retry?: {
    retryOfJobId?: string;
    failureClass?: string | null;
    reason?: string | null;
  } | null;
}

/** Longest tail of a check's output a turn carries. The payload holds 16 KiB; a turn is not a log. */
const MAX_CHECK_TAIL_IN_MESSAGE = 1_200;

/**
 * What the payload knows, in the words a reader acts on (§4.4 X-D2): which files conflicted, which
 * check disagreed and what it returned, which error code came back. Every value here is a column of
 * the item's own payload, which is why it is safe for the byte-for-byte replay `createTurn` does.
 */
function integrationItemFacts(kind: string, payload: IntegrationItemPayload): string[] {
  if (kind === 'INTEGRATION_CONFLICT') {
    const files = payload.files ?? [];
    return [
      `合并冲突（${payload.phase ?? '未记录阶段'}），目标分支 ${payload.targetRef ?? '未记录'} 没有动。`,
      files.length > 0
        ? `冲突的文件（${files.length} 个）：\n${files.map((file) => `- ${file}`).join('\n')}`
        : '这次冲突没有报出文件名。',
    ];
  }
  if (kind === 'INTEGRATION_CHECK_FAILED') {
    const check = payload.check;
    if (!check?.name) return ['合并后的树上有一条检查没过，这条待办没有记下是哪一条。'];
    const tail = typeof check.outputTail === 'string' ? check.outputTail : '';
    return [
      `检查 ${check.name} 的退出码是 ${check.exitCode}（声明要求 ${check.expectedExitCode}），`
        + '目标分支没有动。',
      ...(check.command ? [`它跑的是：${check.command}`] : []),
      ...(tail ? [`它的输出末尾：\n${clip(tail.slice(-MAX_CHECK_TAIL_IN_MESSAGE))}`] : []),
    ];
  }
  const detail = payload.errorDetail == null ? null : JSON.stringify(payload.errorDetail);
  return [
    `集成作业以一个错误结束：${payload.errorCode ?? '未记录错误码'}。`,
    ...(detail ? [`错误详情：${clip(detail)}`] : []),
  ];
}

/** What each failure class means, in the sentence a coordinator decides the next step from. */
const FAILURE_CLASS_MEANING: Readonly<Record<string, string>> = {
  CONFLICT: '两边改了同一处，git 合不上',
  CHECK_FAILED: '检查跑完了，退出码与声明不一致',
  CHECK_TIMED_OUT: '有一条检查跑到它的时间预算还没结束，被平台终止，没有给出结论',
  ERROR: '集成作业本身出了错，不是检查的结论',
};

/**
 * The failure's class, and — for a generation the coordinator asked for through `integration_retry`
 * — what it reran and why (J-T1b). Empty for a payload an older build wrote, which says neither.
 */
function failureClassLines(payload: IntegrationItemPayload, aboutTask: boolean): string[] {
  const lines: string[] = [];
  if (payload.failureClass) {
    const meaning = FAILURE_CLASS_MEANING[payload.failureClass];
    lines.push(`失败分类：${payload.failureClass}${meaning ? `（${meaning}）` : ''}。`);
  }
  const retry = payload.retry;
  if (retry?.retryOfJobId) {
    lines.push(
      (aboutTask
        ? `这是这项任务的第 ${payload.generation ?? '?'} 代落地，由协调会话要求重跑：上一代`
        : `这是这个合入 main 的候选的第 ${payload.generation ?? '?'} 次检查，由协调会话要求重跑：上一次`)
      + `（作业 ${uuidToBase62(retry.retryOfJobId)}）的失败分类是 ${retry.failureClass ?? '未记录'}，`
      + `重跑的理由是「${retry.reason ?? ''}」。同一个失败又出现了一次，不要再原样重跑。`,
    );
  }
  return lines;
}

/**
 * The next step a LAND_TASK's failure leaves its coordinator, by the class it failed of (J-T1b).
 *
 * The task is already DONE — a landing is what follows a DONE — so the one door this message must not
 * point at is `task_start`: it runs the task again on a new branch and never queues another landing
 * of the work it finished, which is how three DONE tasks of 34Y7My8sqhKLWtmCQYv1l stopped at their
 * first landing on 2026-10-01 with nothing able to move them.
 */
function landingNextStep(projectId: string, taskId: string, payload: IntegrationItemPayload): string {
  const read = `先读这条任务（task_get，taskId 传 ${taskId}，评论与它的会话都在上面）。任务本身已经是 DONE，`
    + '落地失败不改它的状态；task_start 只会再跑一遍任务、开一条新分支，不会重新排这次落地。\n';
  const rework = '用 task_reopen 把任务退回返工、另起一个取代它的任务（task_create 带 supersedesTaskId），'
    + '或者取消（task_update 置 CANCELLED）';
  if (payload.phase === 'MAIN_SYNC') return read + mainSyncNextStep(payload);
  if (payload.failureClass === 'CONFLICT' || (payload.files?.length ?? 0) > 0) {
    return read
      + '冲突只有改过的分支才能解开：原样重跑会再冲突一次，integration_retry 也不接受冲突。'
      + `${rework}。`;
  }
  return read
    + '先判断红的是谁。是交付本身的问题，就' + `${rework}。`
    + '不是交付的问题——合并检查的基线后来修好了、检查超时、集成机器出错——就用 integration_retry'
    + `（projectId 传 ${projectId}，taskId 传 ${taskId}，reason 写明这次为什么会不同）重排一次落地：`
    + '它入队这项任务的下一代落地，成了就进项目分支、继续往后的合并检查，没成会再开一条待办给你。'
    + '这类落地去留由你判，不拿去问账号所有者。';
}

/**
 * The next step a MAIN_SYNC conflict leaves its coordinator (§3.1 M3).
 *
 * The line conflicted while absorbing the upstream into the project branch, before it looked at the
 * task's branch, so the conflict is the line's and not the task's work. The general advice — send the
 * task back to rework — was followed on 2026-10-03 (task 34ZNP0XRLAnAreGEOvKuw) and its next landing
 * stopped in the same place. What resolves it is a source branch that already contains that absorb:
 * J-S2 then leaves the project branch's tip alone and J-S4 lands the source by MERGE.
 */
function mainSyncNextStep(payload: IntegrationItemPayload): string {
  const line = payload.targetRef ? `项目分支 ${payload.targetRef} ` : '项目分支';
  return `这次冲突停在 MAIN_SYNC：平台先把 upstream（project_get 的 integration.upstreamRef）合进${line}的 tip，`
    + '在那里就冲突了，还没看这项任务的提交。冲突在项目线和 upstream 之间，不在这项任务的工作里：'
    + '原样重跑会再冲突一次，integration_retry 也不接受冲突；只让任务重做自己的工作也解不开，'
    + '下一次落地照样先停在这里。\n'
    + '先在项目线上吸收 upstream、解决冲突，再落地：\n'
    + `1. 在这项任务的源分支上，把${line}的 tip 和 upstream 的 tip 合进来，解掉上面这些文件的冲突，`
    + '提交这个合并提交。任务原来的工作留着，不用重做。\n'
    + '2. 源分支同时包含这两个 tip，它的下一次落地就不再先合 upstream，而是按 J-S4 的 MERGE 模式落地，'
    + '进项目分支的树就是源分支的树。落地时其中一个 tip 又往前走了，源分支就缺了它，'
    + '落地会照旧停在 MAIN_SYNC，那就再合一次。\n'
    + '3. 这个合并提交由这项任务自己的会话放进源分支：先用 task_comment 在任务上写明这一轮只做第 1 步，'
    + '再用 task_reopen 把它退回。它再次 DONE 就会排下一次落地。\n'
    + '这条待办开着时，同一条集成线上其他任务的落地都在等（M2），只有这项任务自己的下一次落地不用等。'
    + '它落进项目分支后，这条待办由平台关闭，排着的落地接着走。';
}

/**
 * The next step a blocked candidate's failure leaves its coordinator (§4.7 H1) — the item a promotion's
 * check or landing opens, which names no task.
 *
 * The same judgement a task's landing asks for, about a merge into main: a conflict is answered only
 * by a project branch that changed, and a red that is not the work's is checked again through
 * `integration_retry` with the candidate's id. What that door brings back is the QUESTION — a
 * candidate that passed its checks — and never the answer: the merge stays the account owner's card,
 * or the Automatic setting's own rule over a clean result, exactly as it was before the red.
 */
function promotionNextStep(
  projectId: string,
  promotionId: string | null,
  payload: IntegrationItemPayload,
): string {
  const about = '这条待办身后没有任务：它来自一次晋升（把项目分支合入 main）的作业，那种作业不为任何单个'
    + '任务做事。\n';
  if (payload.failureClass === 'CONFLICT' || (payload.files?.length ?? 0) > 0) {
    return about
      + '冲突只有改过的项目分支才能解开：原样重跑会再冲突一次，integration_retry 也不接受冲突。'
      + '另起一个任务在项目分支上解决它；那个任务落地后，平台会为新的分支尖端开一个新的候选并重新检查，'
      + '这个候选和这条待办随之由平台关闭。';
  }
  const candidate = promotionId ? uuidToBase62(promotionId) : '这个候选的编号';
  const retry = `（projectId 传 ${projectId}，promotionId 传 ${candidate}，reason 写明这次为什么会不同）`;
  return about
    + '先判断红的是谁。是项目分支上的工作有问题，就另起一个任务修它，它落地后平台会开新的候选。'
    + '不是工作的问题——合并检查的基线后来修好了、检查超时、集成机器出错——就用 integration_retry'
    + `${retry}把这个候选的检查重跑一次。检查通过之后，合并照旧由账号所有者在卡上确认，或由 Automatic `
    + '设置按原来的规则自动合并：这扇门只让候选回到可以合并的状态，不替任何人合并。';
}

/**
 * The same payload again, this time as the ROWS an item's card draws (§7.5, mock 5).
 *
 * `integrationItemFacts` above is the same information written as prose for an agent, and this is
 * it as fields for a person's card. Both read one payload — neither is derived from the other —
 * which is why a card cannot come to disagree with the message the coordinator was handed.
 *
 * A key the payload does not carry reads as null (or as false, for the two booleans), so a payload
 * an older build wrote leaves a row the card skips rather than a hole it falls into. `failure` is
 * the one part read by KIND rather than by key: `how` and `chain` are a failed task's, and an
 * integration job's payload has neither, so reading them off one would invent a retry count no
 * failure ever had.
 *
 * `task` is a column of the item rather than of its payload — a conflict is about the task whose
 * branch would not land, and the card's first row names it.
 *
 * Null for the kinds whose card has no such rows (a question is its own card and a pause writes its
 * own sentence) and for a payload that is not an object at all.
 */
export function openItemFacts(
  kind: string,
  payload: unknown,
  task: { id: string; title: string } | null,
): OpenItemFacts | null {
  if (!(INTEGRATION_ITEM_KINDS as readonly string[]).includes(kind) && kind !== 'TASK_FAILED') {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const row = payload as IntegrationItemPayload & {
    how?: string;
    exitCode?: number;
    expectedExitCode?: number;
    chain?: { failuresInChain?: number; limit?: number };
  };
  return {
    task,
    targetRef: filled(row.targetRef),
    targetSha: filled(row.targetSha),
    files: Array.isArray(row.files)
      ? row.files.filter((file): file is string => typeof file === 'string' && file !== '')
      : [],
    nothingLanded: row.nothingLanded === true,
    check: checkResult(row.check),
    branchUnchanged: row.branchUnchanged === true,
    errorCode: filled(row.errorCode),
    failure: kind === 'TASK_FAILED'
      ? {
          how: filled(row.how),
          exitCode: typeof row.exitCode === 'number' ? row.exitCode : null,
          expectedExitCode: typeof row.expectedExitCode === 'number' ? row.expectedExitCode : null,
          attempt: typeof row.chain?.failuresInChain === 'number' ? row.chain.failuresInChain : 1,
          limit: typeof row.chain?.limit === 'number' ? row.chain.limit : TASK_FAILURE_CHAIN_LIMIT,
        }
      : null,
  };
}

function filled(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The check that disagreed, complete enough to draw: a payload that names no command is not one. */
function checkResult(value: IntegrationItemPayload['check']): IntegrationCheckResult | null {
  if (!value || typeof value !== 'object') return null;
  const check = value as Record<string, unknown>;
  if (typeof check.name !== 'string' || check.name === '') return null;
  if (typeof check.command !== 'string' || check.command === '') return null;
  return {
    name: check.name as IntegrationCheckResult['name'],
    command: check.command,
    expectedExitCode: typeof check.expectedExitCode === 'number' ? check.expectedExitCode : 0,
    exitCode: typeof check.exitCode === 'number' ? check.exitCode : null,
    timedOut: check.timedOut === true,
    durationMs: typeof check.durationMs === 'number' ? check.durationMs : 0,
    outputTail: typeof check.outputTail === 'string' ? check.outputTail : '',
  };
}

/**
 * What the coordinator is told (§0.3 G6). Derived only from columns that do not change, because a
 * replay of the same key compares the content byte for byte.
 *
 * It says what happened, that this item is theirs, and which decisions the platform will NOT make on
 * its own — a failed task is retried, replaced or cancelled by somebody who looked at it. The one
 * verb it does offer is the door §4.7 adds: an item the platform cannot close for itself — because
 * what ended it is not a fact it can read, work that landed by hand being the case that made this a
 * hole — is closed by its assignee, through `open_item_resolve`, with a reason.
 *
 * An integration item says what the payload knows — the files it conflicted on, the check that
 * disagreed and what it returned, the error code — because the reader's first question is which of
 * the two branches moved, and the answer is a column of this row. A promotion's failure names no
 * task, so it does not pretend to.
 */
export function openItemMessage(item: OpenItemMessageSource): string {
  const projectId = uuidToBase62(item.projectId);
  const payload = (item.payload ?? {}) as {
    how?: string;
    exitCode?: number;
    expectedExitCode?: number;
    error?: string;
    chain?: { failuresInChain?: number; limit?: number };
  } & IntegrationItemPayload;
  const notice = `待办编号 ${uuidToBase62(item.id)}。这是一条通知，不是打断：你正在跑的那一轮不会被它中断，`
    + '你是在那一轮结束之后才读到它的，所以以你自己刚读到的库里状态为准。';
  // The one ending the platform cannot produce for itself, and the only place a coordinator is told
  // the door exists: work that landed by HAND — a replay of the branch that the platform never saw —
  // leaves the item saying "this did not land" for ever, because the branch tip is not an ancestor of
  // anything and no job will ever report a landing for it again.
  const handClose = '平台自己关不掉的情况——这项工作已经用别的方式在目标分支上了，或者你已经另行处理过——'
    + '用 open_item_resolve 写明理由把它关掉：它标为已处理（HANDLED），你的会话和理由会留在待办上。';
  if ((INTEGRATION_ITEM_KINDS as readonly string[]).includes(item.kind)) {
    const taskId = item.taskId ? uuidToBase62(item.taskId) : null;
    // §4.7 H1–H3, said once for both scopes: a rerun does not close this item, its result does.
    const handling = (what: string, success: string) => `用 integration_retry ${what}后，这条待办显示为`
      + `处理中、仍然开着，直到重跑的那次作业有结果：${success}，它自动标为已处理（HANDLED），记下你的会话`
      + '和理由；又失败了，它标为已取代（RETRIED），新的失败另开一条待办。';
    return `【例外待办】${item.title}\n\n`
      + `项目 ${projectId} 的一次集成没有把工作放进集成线：\n`
      + `${[...integrationItemFacts(item.kind, payload), ...failureClassLines(payload, taskId !== null)].join('\n')}\n\n`
      + '这条待办的负责人是你。平台不会自己重试一次没有落地的集成，所以不会有第二次作业自己出现；'
      + '要判断的是下一步。\n'
      + (taskId
        ? `${landingNextStep(projectId, taskId, payload)}\n`
          + '任务落地、被取消或被取代之后，这条待办由平台自己关闭。'
          + `${handling('重排', '落地了')}你不用回报。${handClose}\n`
        : `${promotionNextStep(projectId, item.promotionId ?? null, payload)}\n`
          + '这个候选被新的落地取代、被拒绝或已经合并之后，这条待办由平台自己关闭。'
          + `${handling('重跑检查', '检查通过了')}你不用回报。${handClose}\n`)
      + `\n${notice}`;
  }
  if (item.kind !== 'TASK_FAILED' || !item.taskId) {
    return `【例外待办】${item.title}\n\n`
      + `项目 ${projectId} 有一条需要你处理的例外。待办编号 ${uuidToBase62(item.id)}。\n\n`
      + `这是一条通知，不是打断：你是在上一轮结束之后才读到它的，以你自己读到的库里状态为准。`;
  }
  const taskId = uuidToBase62(item.taskId);
  const attempt = payload.chain?.failuresInChain ?? 1;
  const limit = payload.chain?.limit ?? TASK_FAILURE_CHAIN_LIMIT;
  const detail = [
    payload.exitCode !== undefined
      ? `验收命令的退出码是 ${payload.exitCode}，声明要求 ${payload.expectedExitCode ?? 0}。`
      : null,
    payload.error ? `失败信息：\n${payload.error}` : null,
  ].filter((line): line is string => !!line);
  return `【例外待办】${item.title}\n\n`
    + `项目 ${projectId} 的任务 ${taskId} 失败了：${howInChinese(payload.how)}。\n`
    + (detail.length > 0 ? `${detail.join('\n')}\n` : '')
    + `这是这条取代链上的第 ${attempt} 次失败（上限 ${limit} 次；到第 ${limit} 次，待办不再发给你，`
    + `直接交给账号所有者）。\n\n`
    + `这条待办的负责人是你，要判断的是下一步：重新运行（task_start）、另起一个取代它的任务`
    + `（task_create 带 supersedesTaskId）、还是取消（task_update 置 CANCELLED）。`
    + `失败原因先用 task_get（taskId 传 ${taskId}）读任务评论与它的会话，不要照着这条消息猜。\n`
    + `任务重新跑起来、被取代、被取消或完成之后，这条待办由平台自己关闭，你不用回报。`
    + `${handClose}\n\n`
    + notice;
}

/**
 * The same item as a CARD: the fields the message above turns into prose, kept as fields
 * (`OpenItemDeliveryCard`, §4.4 X-D2).
 *
 * WHY IT IS READ HERE AND NOT WRITTEN AT DELIVERY TIME. What a client draws is a `user` event —
 * the runner's echo of the turn — so the only place a structured reading can live is beside that
 * echo, which is stored when the runner posts it and not when the turn was queued. Everything the
 * card says is re-derived from committed rows at that moment: the item's own columns, and the
 * landing, read live from the merge receipts of the task the item is about (the fold in
 * `project-criterion-landing`, so the card cannot say a different thing about landing than the
 * project read does).
 *
 * Nothing here decides anything: it is a reading, taken once, of a row that already exists. An item
 * that has since been resolved or handed to the owner still reads — the card is about the delivery
 * that was made, and a reader looking at it later is looking at what was handed over.
 */
export async function readOpenItemDeliveryCard(
  prisma: Pick<PrismaService, 'projectOpenItem' | 'projectCodebase' | 'task'>,
  itemId: string,
): Promise<OpenItemDeliveryCard | null> {
  const item = await prisma.projectOpenItem.findUnique({
    where: { id: itemId },
    select: {
      id: true,
      kind: true,
      title: true,
      payload: true,
      taskId: true,
      sessionId: true,
      projectId: true,
      assignee: true,
      promotionId: true,
      fuseEpisodeId: true,
    },
  });
  if (!item) return null;
  const payload = (item.payload ?? {}) as IntegrationItemPayload & {
    how?: string;
    exitCode?: number;
    expectedExitCode?: number;
    chain?: { failuresInChain?: number; limit?: number };
  };
  const task = item.taskId
    ? await prisma.task.findUnique({
        where: { id: item.taskId },
        select: {
          id: true,
          title: true,
          mergeReceipts: { select: { result: true, targetBranch: true } },
        },
      })
    : null;
  const branches = await readLandingBranches(prisma, item.projectId);
  const receipts = task?.mergeReceipts ?? [];
  return {
    itemId: item.id,
    kind: item.kind as OpenItemKind,
    title: item.title,
    task: task ? { id: task.id, title: task.title, sessionId: item.sessionId } : null,
    files: item.kind === 'INTEGRATION_CONFLICT' ? payload.files ?? [] : [],
    targetRef: payload.targetRef ?? null,
    check: payload.check?.name
      ? {
          name: payload.check.name,
          exitCode: payload.check.exitCode ?? null,
          expectedExitCode: payload.check.expectedExitCode ?? null,
        }
      : null,
    errorCode: item.kind === 'INTEGRATION_ERROR' ? payload.errorCode ?? null : null,
    failure: item.kind === 'TASK_FAILED'
      ? {
          how: payload.how ?? null,
          exitCode: payload.exitCode ?? null,
          expectedExitCode: payload.expectedExitCode ?? null,
          attempt: payload.chain?.failuresInChain ?? 1,
          limit: payload.chain?.limit ?? TASK_FAILURE_CHAIN_LIMIT,
        }
      : null,
    // The same derivation the project's list draws its presses from. `askable` is asked of a
    // project this read does not load: the one press that turns on it is offered only to an item
    // that has ALREADY been handed to its owner, and this card is recorded for a delivery to the
    // coordinator — a row that moved after the delivery reads with one press too few rather than
    // one nobody can make.
    actions: openItemActions({
      kind: item.kind,
      assignee: item.assignee,
      taskId: item.taskId,
      promotionId: item.promotionId,
      fuseEpisodeId: item.fuseEpisodeId,
      askable: false,
    }),
    landing: {
      receipts: receipts.length,
      state: taskLanding(receipts, branches),
      upstream: branches.upstream[0]!,
      integration: branches.integration[0]!,
    },
  };
}

function howInChinese(how: string | undefined): string {
  switch (how) {
    case 'ACCEPTANCE_EXIT_MISMATCH':
      return '验收命令的退出码与声明不一致';
    case 'RUN_FAILED':
      return '执行会话的一轮以失败结束';
    case 'RUNNER_FINALIZED_FAILED':
      return 'runner 把这次执行以失败收尾';
    case 'REAPED_API_ERROR':
      return '这次执行停在一次 API 或登录错误上，被平台回收';
    case 'ATTEMPT_LOST_RUNNER_OFFLINE':
      return '执行它的 runner 失联，这次执行被收回，任务回到待开工';
    case 'ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED':
      return '执行会话的运行时一直没起来，这次执行被收回，任务回到待开工';
    case 'REPORTED_FAILED':
      return '有人把它置为 FAILED';
    default:
      return '执行失败';
  }
}

/** PostgreSQL's `jsonb` holds no NUL, and a turn has a size; both are the caller's text, not ours. */
function clip(text: string): string {
  const clean = text.replace(/ /g, '');
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
}


/** What the owner is being asked to merge (§3.3 M-T2, §4.2). */
export interface PromotionApproval {
  projectId: string;
  ownerId: string;
  promotionId: string;
  jobId: string;
  taskId: string | null;
  sessionId: string | null;
  title: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

/**
 * Open the owner's "merge this into main?" card, in the transaction that recorded the passing check
 * (§3.3 M-T2).
 *
 * OWNER, always, and with no escalation clock. The other kinds in this table go to the project's
 * coordinator first and reach a person when that does not work; this one starts and ends with the
 * account owner, because what it is asking for is authority and no amount of waiting moves that to
 * somebody else. `escalateAt` is therefore null rather than two hours out: there is nobody above the
 * owner to escalate to, and a timer that can only fire into a void is a timer that will one day be
 * read as "this was ignored".
 *
 * Producing this row IS the event the push §3.3 names. Nothing here sends one: the four owner
 * pushes are the client task's (criterion 13), and they read this table.
 *
 * Returns null when the partial unique index already holds this key, which is how a check result the
 * runner reported twice opens one card.
 */
export async function recordPromotionApproval(
  tx: Prisma.TransactionClient,
  approval: PromotionApproval,
): Promise<string | null> {
  const now = new Date();
  const [created] = await tx.projectOpenItem.createManyAndReturn({
    data: [{
      projectId: approval.projectId,
      ownerId: approval.ownerId,
      kind: 'PROMOTION_APPROVAL' satisfies OpenItemKind,
      state: 'OPEN' satisfies OpenItemState,
      assignee: 'OWNER' satisfies OpenItemAssignee,
      assigneeReason: 'DEFAULT' satisfies OpenItemAssigneeReason,
      taskId: approval.taskId,
      sessionId: approval.sessionId,
      integrationJobId: approval.jobId,
      promotionId: approval.promotionId,
      dedupeKey: approval.dedupeKey,
      title: approval.title,
      payload: approval.payload as unknown as Prisma.InputJsonValue,
      waitingSince: now,
      assignedAt: now,
      escalateAt: null,
    }],
    skipDuplicates: true,
    select: { id: true },
  });
  return created?.id ?? null;
}

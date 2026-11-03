import type { Prisma } from '@prisma/client';
import type { CoordinatorDeliveryCard } from '@orbit/shared';

import { acceptanceLandedReadingOf } from './coordinator-judgment-opening';
import { criteriaDecisionReplyIntentOf, criteriaDecisionReplyTurnId } from './criteria-decision-reply';
import { CRITERIA_WEAKENING_EFFECT_CLASS } from './criteria-weakening-intent';
import { isDerivedUuid } from './project-dispatch-identity';

/**
 * The card a turn telling a session about a committed fact is drawn as (`CoordinatorDeliveryCard`):
 * a project's coordinator told of a fact (`CoordinatorDeliveryService`, the words
 * `buildCoordinatorDeliveryMessage` writes), and a session told the owner's answer to its criteria
 * proposal (`sendCriteriaDecisionReply`).
 *
 * Both turns are keyed by `derivedUuid`, which no client mints, so only those keys are looked up and
 * a batch of ordinary messages reads nothing. And a key is not taken at its word: each card is read
 * off the row that makes the turn the platform's —
 *
 *   * a delivery is the turn its wake's `delivery` record names (`bindQueuedDelivery`,
 *     `bindRequeuedDelivery`, and `send` for the older carrier), on a wake DELIVERED to THIS
 *     conversation. The fact is the wake's own event and `detail` — the title, the revision and the
 *     counts the coordinator was told, as the claim stored them — and the moment is the wake's
 *     bind (`updatedAt`), which is what the owner's evidence card reads as `Sent to the coordinator`;
 *   * a reply is the turn whose key is derived from the proposal its words name, answering a
 *     decision on a proposal THIS conversation filed. The moment is the turn's own.
 *
 * Who the conversation was to the project is the project's own pointer, not the session's kind: a
 * delivery's wake is DELIVERED only to the conversation coordinating its project, so its card says
 * so; a reply goes to whichever session filed the proposal, and its card says the coordinator only
 * where that project's `coordinator_session_id` names THIS conversation (`toCoordinator`). A task's
 * run that filed one, a conversation of the owner's, the coordinator of another project, one rotated
 * out of coordinating: each is told the answer, and none of them is the coordinator.
 *
 * A turn under one of those keys with no such row behind it — a caller's own message that took the
 * key, a delivery whose wake has since moved to the turn re-sending it — has no card, and is drawn as
 * the words, as every delivery was before this.
 */
export async function readCoordinatorDeliveryCards(
  db: Pick<
    Prisma.TransactionClient,
    'projectCoordinatorWake' | 'projectRatifiedActionIntent' | 'projectCriteriaDecision' | 'conversationTurn' | 'project'
  >,
  sessionId: string,
  turns: ReadonlyArray<{ id: string; clientTurnId: string; content: string | null }>,
): Promise<Map<string, CoordinatorDeliveryCard>> {
  const cards = new Map<string, CoordinatorDeliveryCard>();
  const derived = turns.filter((turn) => isDerivedUuid(turn.clientTurnId));
  if (derived.length === 0) return cards;

  // The deliveries: one read, on the partial index over DELIVERED wakes by conversation (0460).
  const byKey = new Map(derived.map((turn) => [turn.clientTurnId, turn]));
  const wakes = await db.projectCoordinatorWake.findMany({
    where: {
      sessionId,
      status: 'DELIVERED',
      OR: derived.map((turn) => ({ delivery: { path: ['clientTurnId'], equals: turn.clientTurnId } })),
    },
    select: { event: true, subjectId: true, detail: true, delivery: true, updatedAt: true },
  });
  for (const wake of wakes) {
    const key = (wake.delivery as { clientTurnId?: unknown } | null)?.clientTurnId;
    const turn = typeof key === 'string' ? byKey.get(key) : undefined;
    if (!turn) continue;
    const card = coordinatorDeliveryCardOf(wake, turn.content);
    if (card) cards.set(turn.id, card);
  }

  // The replies: the proposal each one's words name, held to the key derived from it.
  const replies = derived.flatMap((turn) => {
    if (cards.has(turn.id)) return [];
    const intentId = criteriaDecisionReplyIntentOf(turn.content);
    return intentId && criteriaDecisionReplyTurnId(intentId) === turn.clientTurnId ? [{ turn, intentId }] : [];
  });
  if (replies.length === 0) return cards;
  const intentIds = replies.map((reply) => reply.intentId);
  // Each proposal this conversation filed, by the project it was filed on.
  const filedHere = new Map((await db.projectRatifiedActionIntent.findMany({
    where: {
      id: { in: intentIds },
      principalType: 'AGENT',
      principalId: sessionId,
      effectClass: CRITERIA_WEAKENING_EFFECT_CLASS,
    },
    select: { id: true, projectId: true },
  })).map((intent) => [intent.id, intent.projectId]));
  // And the project this conversation coordinates, if any: `coordinator_session_id` is unique, so the
  // pointer names it for one project at most.
  const coordinated = (await db.project.findUnique({
    where: { coordinatorSessionId: sessionId },
    select: { id: true },
  }))?.id;
  const decisions = new Map((await db.projectCriteriaDecision.findMany({
    where: { intentId: { in: intentIds } },
    select: { intentId: true, decision: true },
  })).map((decision) => [decision.intentId, decision.decision]));
  const sentAt = new Map((await db.conversationTurn.findMany({
    where: { id: { in: replies.map((reply) => reply.turn.id) } },
    select: { id: true, createdAt: true },
  })).map((turn) => [turn.id, turn.createdAt]));
  for (const { turn, intentId } of replies) {
    const decision = decisions.get(intentId);
    const at = sentAt.get(turn.id);
    const projectId = filedHere.get(intentId);
    if (projectId === undefined || !at || (decision !== 'APPROVE' && decision !== 'REJECT')) continue;
    cards.set(turn.id, {
      kind: decision === 'APPROVE' ? 'CRITERIA_APPROVED' : 'CRITERIA_REJECTED',
      task: null,
      revision: null,
      count: null,
      deliveredAt: at.toISOString(),
      toCoordinator: projectId === coordinated,
    });
  }
  return cards;
}

/**
 * One delivered wake as the card its turn is drawn as, or null for a fact this carrier does not
 * write (none reaches a conversation today) or a row missing what its sentence needs. A wake is
 * delivered to the conversation coordinating its project and to no other, so every card here is the
 * coordinator's (`toCoordinator`).
 *
 * `content` is the turn's words, read for the one thing no row keeps: which reading a project whose
 * criteria have all landed was told in (`acceptanceLandedReadingOf`).
 */
export function coordinatorDeliveryCardOf(
  wake: { event: string; subjectId: string; detail: unknown; updatedAt: Date },
  content: string | null,
): CoordinatorDeliveryCard | null {
  const detail = wake.detail && typeof wake.detail === 'object' && !Array.isArray(wake.detail)
    ? wake.detail as Record<string, unknown>
    : {};
  const deliveredAt = wake.updatedAt.toISOString();
  const task = (title: unknown) => (
    typeof title === 'string' && title.trim() !== '' ? { id: wake.subjectId, title } : null
  );
  const counted = (count: unknown) => (
    typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : null
  );
  const named = (kind: CoordinatorDeliveryCard['kind'], title: unknown): CoordinatorDeliveryCard | null => {
    const about = task(title);
    return about ? { kind, task: about, revision: null, count: null, deliveredAt, toCoordinator: true } : null;
  };
  const counting = (kind: CoordinatorDeliveryCard['kind'], count: number | null): CoordinatorDeliveryCard | null => (
    count === null ? null : { kind, task: null, revision: null, count, deliveredAt, toCoordinator: true }
  );
  switch (wake.event) {
    case 'COMPLETION_EVIDENCE_REVISED': {
      const about = task(detail.title);
      const revision = counted(Number(detail.evidenceRevision));
      if (!about || revision === null) return null;
      return {
        kind: typeof detail.movedFromProjectId === 'string' ? 'EVIDENCE_MOVED_IN' : 'EVIDENCE_SUBMITTED',
        task: about,
        revision,
        count: null,
        deliveredAt,
        toCoordinator: true,
      };
    }
    case 'DEPENDENT_READY':
      return named('DEPENDENT_READY', detail.title);
    case 'TASK_DISPATCH_REFUSED':
      return named('TASK_DISPATCH_REFUSED', detail.taskTitle);
    case 'PROJECT_BLOCKER_RAISED':
      return named('PROJECT_BLOCKER_RAISED', detail.taskTitle);
    case 'TASK_RUN_STOPPED':
      return named('TASK_RUN_STOPPED', detail.title);
    case 'CRITERION_UNLANDED':
      return counting('CRITERION_UNLANDED', counted(detail.taskCount));
    case 'PROJECT_ACCEPTANCE_LANDED': {
      const reading = acceptanceLandedReadingOf(content);
      return counting(
        reading === 'DONE' ? 'ACCEPTANCE_LANDED_DONE' : reading === 'HELD' ? 'ACCEPTANCE_LANDED_HELD' : 'ACCEPTANCE_LANDED',
        counted(Array.isArray(detail.criteria) ? detail.criteria.length : null),
      );
    }
    case 'PROJECT_TASKS_SETTLED':
      return { kind: 'LOOKS_FINISHED', task: null, revision: null, count: null, deliveredAt, toCoordinator: true };
    case 'PROJECT_SETTLED_UNMERGED':
      return counting('SETTLED_UNMERGED', counted(Array.isArray(detail.commits) ? detail.commits.length : null));
    default:
      return null;
  }
}

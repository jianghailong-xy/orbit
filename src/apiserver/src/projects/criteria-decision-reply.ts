import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CreatorType } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { criteriaProposalDiff } from './criteria-pending-decisions';
import {
  CRITERIA_WEAKENING_EFFECT_CLASS,
  type CriteriaWeakeningAction,
} from './criteria-weakening-intent';
import { criteriaFromDefinitions } from './project-acceptance';
import { derivedUuid } from './project-dispatch-identity';

/**
 * The answer to a held criteria proposal, sent back to the session that asked for it.
 *
 * §0 — WHY THE PLATFORM SENDS IT
 * ==============================
 * A session whose edit would loosen the ruler is told the edit was held for the account owner, and
 * then it waits. The owner answers at the decision door, and until this unit the door told the
 * owner's clients and nobody else: the proposing session's id sat in the intent row's
 * `principal_id` and nothing read it. On 2026-09-13 a session waited seven hours for an answer
 * that had already been given. What the reply says is decided the moment the decision commits, so
 * it is the platform's to send — not a step to hand a coordinator and hope it relays.
 *
 * §1 — WHERE IT GOES
 * ==================
 * To the proposing session as a turn, when that session has not ended. A turn is a notification,
 * not an interrupt: a session in the middle of a turn reads it when that turn ends.
 *
 * When the session HAS ended — terminal, being cancelled, or in Trash — the answer is a comment on
 * the task that session ran. The line is `createTurn`'s own, and the reason not to cross it is
 * `coordinator-delivery.service.ts` §2's: reviving a conversation somebody ended in order to tell
 * it something is not a reply. The task outlives its sessions, and whoever runs it next reads it.
 *
 * A session with no task that has ended, or a session id that no longer resolves, has nowhere to
 * be told; the reply says so rather than claiming a delivery.
 *
 * §2 — ONE REPLY PER PROPOSAL, KEYED BY THE INTENT
 * ================================================
 * Both carriers take a key derived from the intent id and never minted: the turn's `clientTurnId`,
 * which `conversation_turn (session_id, client_turn_id)` holds unique and `createTurn` replays, and
 * the comment's own primary key, inserted with ON CONFLICT DO NOTHING. So processing the reply
 * again — after a failure, or twice at once — finds the reply already sent, under either key, and
 * reports it instead of sending a second. Both keys are read before anything is written, so a
 * reply that reached a session that has since ended is not written on its task as well.
 *
 * §3 — WHAT IT SAYS IS READ OFF COMMITTED ROWS
 * ============================================
 * The decision row, the intent's stored action and the criteria as they stand. Nothing is carried
 * in from the request that decided, so a reply sent by a later retry says what the first attempt
 * would have — and two attempts at once compose the same words, which `createTurn` requires of a
 * replay. An APPROVE names every criterion whose revision moved from the one the proposal was
 * composed against; a REJECT names the criteria the proposal was about, at the revisions still in
 * force. The criteria a REJECT would have dropped still stand and are named; the ones an APPROVE
 * dropped are gone, so they are counted.
 */

/** Why an answer reached nobody. */
export type CriteriaDecisionReplyUnsent =
  /** The proposing session's id resolves to no session of this owner. */
  | 'SESSION_GONE'
  /** The proposing session has ended and ran no task to record the answer on. */
  | 'SESSION_ENDED_WITHOUT_TASK'
  /** Sending it failed; the decision door says so instead of failing the decision. */
  | 'DELIVERY_FAILED';

/** Where the answer to one proposal went. */
export type CriteriaDecisionReply =
  | { channel: 'SESSION'; sessionId: string; sessionTitle: string; turnId: string; sentAt: Date }
  | {
      channel: 'TASK_COMMENT';
      sessionId: string;
      taskId: string;
      taskTitle: string;
      commentId: string;
      sentAt: Date;
    }
  | { channel: 'NOT_SENT'; sessionId: string; reason: CriteriaDecisionReplyUnsent };

/** The `clientTurnId` of the one turn that answers a proposal. */
export function criteriaDecisionReplyTurnId(intentId: string): string {
  return derivedUuid(`criteria-decision-reply:v1:turn:${intentId}`);
}

/** The id of the one comment that answers a proposal whose session had ended. */
export function criteriaDecisionReplyCommentId(intentId: string): string {
  return derivedUuid(`criteria-decision-reply:v1:comment:${intentId}`);
}

/** One criterion as it stands, narrowed to what the reply reads. */
interface StandingCriterion {
  id: string;
  ordinal: number;
  text: string;
  verificationMethod: string;
  completionCriterionOverrideReason: string | null;
  revision: number;
  contentHash: string;
}

/** What the decision did to the criteria the proposal was about, one clause per criterion. §3. */
export function affectedCriteriaClauses(
  decision: 'APPROVE' | 'REJECT',
  action: CriteriaWeakeningAction,
  standing: readonly StandingCriterion[],
): string[] {
  const byOrdinal = [...standing].sort((a, b) => a.ordinal - b.ordinal);
  if (decision === 'REJECT') {
    const diff = criteriaProposalDiff(action.request.proposed, criteriaFromDefinitions(byOrdinal));
    const about = new Set(diff.entries
      .filter((entry) => entry.change === 'CHANGED' || entry.change === 'REMOVED')
      .map((entry) => entry.definitionId));
    const clauses = byOrdinal
      .filter((criterion) => about.has(criterion.id))
      .map((criterion) => `criterion ${criterion.ordinal} stays at revision ${criterion.revision}`);
    if (diff.newCount > 0) {
      clauses.push(`${diff.newCount} new ${diff.newCount === 1 ? 'criterion was' : 'criteria were'} not added`);
    }
    return clauses;
  }
  const composedAgainst = new Map(
    action.baseline.material.map((version) => [version.definitionId, version.revision]),
  );
  const clauses = byOrdinal.flatMap((criterion) => {
    const was = composedAgainst.get(criterion.id);
    if (was === undefined) {
      return [`criterion ${criterion.ordinal} was added at revision ${criterion.revision}`];
    }
    return was === criterion.revision
      ? []
      : [`criterion ${criterion.ordinal} is now revision ${criterion.revision}`];
  });
  const kept = new Set(byOrdinal.map((criterion) => criterion.id));
  const dropped = [...composedAgainst.keys()].filter((id) => !kept.has(id)).length;
  if (dropped > 0) {
    clauses.push(`${dropped} ${dropped === 1 ? 'criterion was' : 'criteria were'} dropped`);
  }
  return clauses;
}

/** The reply's words. `endedSessionId` is set when it is written on that session's task. */
export function criteriaDecisionReplyMessage(input: {
  decision: 'APPROVE' | 'REJECT';
  intentId: string;
  projectId: string;
  projectTitle: string;
  decidedAt: Date;
  note: string | null;
  clauses: readonly string[];
  endedSessionId: string | null;
}): string {
  const proposal = uuidToBase62(input.intentId);
  const project = uuidToBase62(input.projectId);
  const asked = input.endedSessionId === null
    ? `Your criteria proposal ${proposal}`
    : `The criteria proposal ${proposal}, filed by session ${uuidToBase62(input.endedSessionId)},`;
  const verdict = input.decision === 'APPROVE' ? 'approved' : 'refused';
  const effect = input.decision === 'APPROVE' ? 'It is in force now' : 'Nothing was applied';
  const detail = input.clauses.length > 0 ? `: ${input.clauses.join('; ')}` : '';
  const paragraphs = [
    'From Orbit · criteria decision',
    `${asked} on project “${input.projectTitle}” (${project}) was ${verdict} by the account owner `
      + `at ${input.decidedAt.toISOString()}. ${effect}${detail}.`,
  ];
  if (input.endedSessionId !== null) {
    paragraphs.push(
      'That session had ended before the decision, so the answer is recorded here, on the task it ran.',
    );
  }
  if (input.note) paragraphs.push(`The owner’s note: ${input.note}`);
  paragraphs.push(input.decision === 'APPROVE'
    ? `Read the criteria back with project_get (projectId: ${project}) and continue against them.`
    : `Read the criteria back with project_get (projectId: ${project}) and keep working against `
      + 'the criteria in force.');
  return paragraphs.join('\n\n');
}

/**
 * Send the answer to one decided proposal to the session that filed it, once. §1 and §2.
 *
 * Null when there is nobody to answer: the proposal was the owner's own, or it names no decision.
 */
export async function sendCriteriaDecisionReply(
  prisma: PrismaService,
  sessions: SessionsService,
  ownerId: string,
  projectId: string,
  intentId: string,
): Promise<CriteriaDecisionReply | null> {
  const intent = await prisma.projectRatifiedActionIntent.findFirst({
    where: { id: intentId, projectId, ownerId, effectClass: CRITERIA_WEAKENING_EFFECT_CLASS },
    select: { principalType: true, principalId: true, action: true },
  });
  // `AGENT` is exactly an ask that arrived with an acting session; an `OWNER` ask arrived with
  // none, and the person who made it is the person who answered it.
  if (!intent || intent.principalType !== 'AGENT') return null;
  const decided = await prisma.projectCriteriaDecision.findUnique({
    where: { intentId },
    select: { decision: true, decidedAt: true, note: true },
  });
  if (!decided) return null;

  const sessionId = intent.principalId;
  const keys = {
    turnId: criteriaDecisionReplyTurnId(intentId),
    commentId: criteriaDecisionReplyCommentId(intentId),
  };
  const already = await sentReply(prisma, sessionId, keys);
  if (already) return already;

  const session = await prisma.session.findFirst({
    where: { id: sessionId, ownerId },
    select: {
      id: true, title: true, status: true, cancelRequestedAt: true, deletedAt: true, taskId: true,
    },
  });
  if (!session) return { channel: 'NOT_SENT', sessionId, reason: 'SESSION_GONE' };

  const project = await prisma.project.findFirstOrThrow({
    where: { id: projectId, ownerId },
    select: { title: true },
  });
  const standing = await prisma.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId },
    orderBy: { ordinal: 'asc' },
    select: {
      id: true,
      ordinal: true,
      text: true,
      verificationMethod: true,
      completionCriterionOverrideReason: true,
      revision: true,
      contentHash: true,
    },
  });
  const decision = decided.decision as 'APPROVE' | 'REJECT';
  const words = (endedSessionId: string | null): string => criteriaDecisionReplyMessage({
    decision,
    intentId,
    projectId,
    projectTitle: project.title,
    decidedAt: decided.decidedAt,
    note: decided.note,
    clauses: affectedCriteriaClauses(
      decision, intent.action as unknown as CriteriaWeakeningAction, standing,
    ),
    endedSessionId,
  });

  const ended = session.deletedAt !== null
    || session.cancelRequestedAt !== null
    || SessionsService.TERMINAL.includes(session.status);
  if (!ended) {
    try {
      await sessions.createTurn(ownerId, session.id, {
        clientTurnId: keys.turnId,
        content: words(null),
      });
    } catch (e) {
      // The refusals `createTurn` gives for a state of the world rather than a fault: the session
      // ended, went to Trash or is being cancelled between the read above and its lock (Conflict),
      // or went away (Not Found). The key is read again before the task is written to, because a
      // concurrent attempt may have sent this reply in the meantime.
      if (
        !(e instanceof NotFoundException
          || e instanceof ConflictException
          || e instanceof ForbiddenException
          || e instanceof BadRequestException)
      ) {
        throw e;
      }
    }
    const sent = await sentReply(prisma, sessionId, keys);
    if (sent) return sent;
  }

  const task = session.taskId
    ? await prisma.task.findFirst({
      where: { id: session.taskId, ownerId },
      select: { id: true, assigneeId: true, creatorType: true, creatorId: true },
    })
    : null;
  if (!task) return { channel: 'NOT_SENT', sessionId, reason: 'SESSION_ENDED_WITHOUT_TASK' };
  await prisma.taskComment.createMany({
    data: [{
      id: keys.commentId,
      taskId: task.id,
      // Attributed the way every comment Orbit writes on a task is (`postRunFailureComment`): to
      // the agent the task is assigned to, else to whoever filed it. The words say it is Orbit's.
      authorType: task.assigneeId ? CreatorType.AGENT : task.creatorType,
      authorId: task.assigneeId ?? task.creatorId,
      body: words(session.id),
    }],
    skipDuplicates: true,
  });
  return sentReply(prisma, sessionId, keys);
}

/** The reply already sent under either key, or null. The turn is looked for first: §2. */
async function sentReply(
  prisma: PrismaService,
  sessionId: string,
  keys: { turnId: string; commentId: string },
): Promise<CriteriaDecisionReply | null> {
  const turn = await prisma.conversationTurn.findUnique({
    where: { sessionId_clientTurnId: { sessionId, clientTurnId: keys.turnId } },
    select: { id: true, createdAt: true, session: { select: { title: true } } },
  });
  if (turn) {
    return {
      channel: 'SESSION',
      sessionId,
      sessionTitle: turn.session.title,
      turnId: turn.id,
      sentAt: turn.createdAt,
    };
  }
  const comment = await prisma.taskComment.findUnique({
    where: { id: keys.commentId },
    select: { id: true, createdAt: true, task: { select: { id: true, title: true } } },
  });
  if (comment) {
    return {
      channel: 'TASK_COMMENT',
      sessionId,
      taskId: comment.task.id,
      taskTitle: comment.task.title,
      commentId: comment.id,
      sentAt: comment.createdAt,
    };
  }
  return null;
}

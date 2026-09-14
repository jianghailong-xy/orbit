import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  taskCompletionRequiredAction,
  type TaskCompletionCriterionValue,
} from './task-completion-criterion';

/**
 * The rules of the fourth completion criterion's door, kept pure so they can be stated as a table.
 *
 * OWNER_CONFIRMED is settled by the account owner and by nobody else. The owner presses Confirm
 * done on the card Orbit draws into the task's own session once a run of it has ended its turn, or
 * in the task's detail panel when no run is waiting; either press posts to
 * `POST /tasks/:taskId/owner-confirmation`, and the recorded CONFIRM is the fact DONE is derived
 * from (`evaluateTaskCompletion`, and 0267's lane in the database's DONE fence). Send back… posts
 * the owner's reason to the same door, which delivers it to that session as their next message and
 * leaves the task open.
 *
 * WHO MAY ANSWER
 * --------------
 * The account owner, from the app: their own credential, and no `x-orbit-session-id` on the
 * request. Every agent tool reaches Orbit through the runner protocol and carries that header, so
 * both halves of the rule are the same fact seen from the two doors — a run of the task, a project
 * coordinator and any other session are refused alike, before anything is read. EVIDENCE_JUDGMENT
 * is the criterion that grants a decision to an independent session; this one exists precisely so
 * that no session's judgment stands in for the owner's.
 *
 * WHAT IS BEING ANSWERED
 * ----------------------
 * A card is drawn for one report: the request `runnerApi.turnComplete` recorded when a run's turn
 * succeeded. The same session can end another turn while the owner is reading, so a decision names
 * the request it answers and the door compares it with the one waiting now, under the task's row
 * lock (`ownerDecisionRefusal`). A panel press on a task no run is waiting on answers `null`, and is
 * refused the moment a run starts waiting — that request has a card, and one question keeps one
 * place to be answered.
 */

export const OWNER_DECISIONS = ['CONFIRM', 'SEND_BACK'] as const;
export type OwnerDecisionValue = (typeof OWNER_DECISIONS)[number];

/** The statuses an owner decision can still be recorded against: the task has not settled. */
export const OWNER_CONFIRMATION_UNSETTLED_STATUSES = ['OPEN', 'IN_PROGRESS'] as const;

/** The longest reason a send-back may carry — the note limit the evidence door already uses. */
export const MAX_OWNER_DECISION_NOTE_CHARS = 4_000;

/** The client turn id a send-back's message is filed under: one decision, one message. */
export function ownerSendBackClientTurnId(decisionId: string): string {
  return `owner-send-back:${decisionId}`;
}

export const REQUIRES_ACCOUNT_OWNER_CODE = 'OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER';
export const NOT_DECLARED_CODE = 'OWNER_CONFIRMATION_NOT_DECLARED';
export const TASK_SETTLED_CODE = 'OWNER_CONFIRMATION_TASK_SETTLED';
export const TASK_SETTLED_ACTION = 'REOPEN_THE_TASK_BEFORE_DECIDING_IT';
export const STALE_CODE = 'OWNER_CONFIRMATION_STALE';
export const STALE_ACTION = 'READ_THE_TASK_AGAIN_AND_DECIDE_WHAT_IS_WAITING_NOW';
export const NOTHING_TO_SEND_BACK_CODE = 'OWNER_CONFIRMATION_NOTHING_TO_SEND_BACK';
export const NOTHING_TO_SEND_BACK_ACTION = 'RUN_THE_TASK_OR_CONFIRM_IT';
export const SEND_BACK_REASON_CODE = 'OWNER_CONFIRMATION_SEND_BACK_REQUIRES_REASON';
export const SEND_BACK_REASON_ACTION = 'SAY_WHAT_IS_MISSING';

/** A refusal in the shape every door of this service answers with. */
export interface OwnerConfirmationRefusal {
  code: string;
  kind: 'REFUSAL';
  requiredAction: string;
  message: string;
}

/** Who is asking, as the two doors see it. */
export interface OwnerConfirmationPrincipal {
  /** `USER` is the app's JWT door; `RUNNER` is the protocol every agent tool and CLI call uses. */
  door: 'USER' | 'RUNNER';
  /** The account the credential authenticates. */
  userId: string;
  /** The `x-orbit-session-id` the request carried, when it carried one. */
  actingSessionId?: string | null;
}

/**
 * Why this caller may not record an owner decision, or null for the account owner in the app.
 *
 * Asked first and of nothing but the request, so an agent is refused before a single row is read —
 * including whether the task it named exists.
 */
export function ownerConfirmationPrincipalRefusal(
  ownerId: string,
  principal: OwnerConfirmationPrincipal,
): OwnerConfirmationRefusal | null {
  const session = principal.actingSessionId?.trim() ? principal.actingSessionId.trim() : null;
  let why: string | null = null;
  if (principal.door === 'RUNNER') {
    why = session
      ? `this request came from agent session ${session} over the runner protocol`
      : 'this request came over the runner protocol, which is how agents reach Orbit';
  } else if (session) {
    why = `this request carries the session header of ${session}, so an agent session is making it`;
  } else if (principal.userId !== ownerId) {
    why = 'this credential does not belong to the account that owns the task';
  }
  if (why === null) return null;
  return {
    code: REQUIRES_ACCOUNT_OWNER_CODE,
    kind: 'REFUSAL',
    requiredAction: taskCompletionRequiredAction('OWNER_CONFIRMED').requiredAction,
    message:
      `${why}; nothing was written. An OWNER_CONFIRMED task is confirmed or sent back only by the `
      + 'account owner, from the Orbit app with their own sign-in — no agent session can do it, the '
      + 'task\'s own run and a project coordinator included. Finish the work, say in the session what '
      + 'was done, and end the turn: the owner is shown a confirmation card in the task\'s session.',
  };
}

export function assertOwnerConfirmationPrincipal(
  ownerId: string,
  principal: OwnerConfirmationPrincipal,
): void {
  const refusal = ownerConfirmationPrincipalRefusal(ownerId, principal);
  if (refusal) throw new ForbiddenException(refusal);
}

/**
 * The reason a decision carries: required, trimmed and bounded for a send-back, optional for a
 * confirmation. A send-back with nothing in it would deliver an empty message to a run that is
 * about to go on working, which is the one state its reason exists to prevent.
 */
export function ownerDecisionNote(decision: OwnerDecisionValue, note: string | null | undefined): string | null {
  const written = note?.replace(/\r\n?/g, '\n').trim().normalize('NFC') ?? '';
  if (written.length > MAX_OWNER_DECISION_NOTE_CHARS) {
    throw new BadRequestException(`note must contain at most ${MAX_OWNER_DECISION_NOTE_CHARS} characters`);
  }
  if (written !== '') return written;
  if (decision !== 'SEND_BACK') return null;
  throw new BadRequestException({
    code: SEND_BACK_REASON_CODE,
    kind: 'REFUSAL',
    requiredAction: SEND_BACK_REASON_ACTION,
    message:
      'Send back needs a reason saying what is missing; nothing was written. The reason is sent to '
      + 'the task\'s session as your next message and the task stays open, so it is the only thing '
      + 'the next turn has to go on.',
  } satisfies OwnerConfirmationRefusal);
}

/** The facts the door decides from, read under the task's row lock. */
export interface OwnerConfirmationStanding {
  completionCriterion: TaskCompletionCriterionValue;
  status: string;
  verifiesTaskId?: string | null;
  /**
   * The newest confirmation request a run of this task recorded, with whether a decision already
   * answers it; null when no run of it has ever ended a turn successfully while it waited on its
   * owner.
   */
  latestRequest: { id: string; sessionId: string; decided: boolean } | null;
}

/** What is waiting on the owner right now: the newest request, unless a decision already answers it. */
export function waitingOwnerConfirmation(
  standing: Pick<OwnerConfirmationStanding, 'latestRequest'>,
): { requestId: string; sessionId: string } | null {
  const latest = standing.latestRequest;
  if (!latest || latest.decided) return null;
  return { requestId: latest.id, sessionId: latest.sessionId };
}

/**
 * Why this decision cannot be recorded against these facts, or null when it can.
 *
 * The order is authority over the subject first and freshness last: a task that does not declare
 * this criterion, or has settled, is refused whatever the card was drawn for, and only a question
 * that can still be answered is compared with the one the caller answered.
 */
export function ownerDecisionRefusal(
  standing: OwnerConfirmationStanding,
  decision: OwnerDecisionValue,
  answeringRequestId: string | null,
): OwnerConfirmationRefusal | null {
  if (standing.completionCriterion !== 'OWNER_CONFIRMED') {
    const remedy = taskCompletionRequiredAction(standing.completionCriterion, {
      verifiesTaskId: standing.verifiesTaskId,
    });
    return {
      code: NOT_DECLARED_CODE,
      kind: 'REFUSAL',
      requiredAction: remedy.requiredAction,
      message:
        `this task declares ${standing.completionCriterion}, which an owner confirmation does not `
        + `settle; nothing was written. To settle it, ${remedy.instruction}.`,
    };
  }
  if (!(OWNER_CONFIRMATION_UNSETTLED_STATUSES as readonly string[]).includes(standing.status)) {
    return {
      code: TASK_SETTLED_CODE,
      kind: 'REFUSAL',
      requiredAction: TASK_SETTLED_ACTION,
      message:
        `this task is ${standing.status}, so there is nothing open to confirm or send back; nothing `
        + 'was written. Reopen it first if it is not finished.',
    };
  }
  const waiting = waitingOwnerConfirmation(standing);
  if (decision === 'SEND_BACK' && waiting === null) {
    return {
      code: NOTHING_TO_SEND_BACK_CODE,
      kind: 'REFUSAL',
      requiredAction: NOTHING_TO_SEND_BACK_ACTION,
      message:
        'no run of this task is waiting on you, so there is no session to send a reason back to; '
        + 'nothing was written. Run the task, or confirm it if it is already done.',
    };
  }
  if ((waiting?.requestId ?? null) === answeringRequestId) return null;
  return {
    code: STALE_CODE,
    kind: 'REFUSAL',
    requiredAction: STALE_ACTION,
    message: `${staleReason(waiting, answeringRequestId)}; nothing was written.`,
  };
}

function staleReason(
  waiting: { requestId: string; sessionId: string } | null,
  answering: string | null,
): string {
  if (answering === null) {
    return 'a run of this task is waiting on your confirmation, so decide it on the card in that '
      + 'run\'s session, where its report is';
  }
  if (waiting === null) {
    return 'the run report this decision answers is no longer waiting on you: it has already been '
      + 'decided';
  }
  return 'a later run of this task has reported since the card you answered was drawn, so the '
    + 'report you read is not the one waiting now';
}

/** Throw a refusal as the HTTP error its code means. */
export function throwOwnerConfirmationRefusal(refusal: OwnerConfirmationRefusal): never {
  if (refusal.code === REQUIRES_ACCOUNT_OWNER_CODE) throw new ForbiddenException(refusal);
  if (refusal.code === SEND_BACK_REASON_CODE) throw new BadRequestException(refusal);
  throw new ConflictException(refusal);
}

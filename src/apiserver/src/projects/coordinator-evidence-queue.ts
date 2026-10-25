import type { Prisma } from '@prisma/client';

import {
  criterionStandingRefusal,
  decidingSessionDisqualification,
} from '../tasks/task-evidence-decision';
import type { CriterionStandingTask } from '../tasks/task-evidence-envelope';
import { completionEvidenceWakeKey } from './completion-input';
import {
  SESSION_ENDING_SELECT,
  type SessionEnding,
  conversationIsDown,
  conversationIsOver,
} from './project-open-item';

/**
 * An Automatic project's evidence revision while its coordinator is PAUSED: it waits for the
 * coordinator instead of becoming the account owner's card
 * (`docs/evidence-waits-for-coordinator-design.md`, owner's decision of 2026-10-09).
 *
 * WHAT CHANGED
 * ============
 * Until then a coordinator that could not take a turn was a coordinator that had ended:
 * `sessionHasEnded` says yes to a FAILED run, so a delivery to a coordinator that had hit its usage
 * limit was refused and the revision was on the owner's card at once, and a revision delivered
 * before it stopped stopped being held the moment it did. Nothing handed it over once the
 * conversation was back. Exception items have drawn this line since 2026-10-02
 * (`conversationIsDown` / `conversationIsOver`); evidence draws the same one now, and one more:
 * a conversation parked with a retry armed (`retryAt`) is paused too, because a turn written to it
 * disarms that retry (`createTurn` writes `retryAt: null`) and runs into the same limit again.
 *
 * WHERE A REVISION IS
 * ===================
 * Nothing new is stored. Where an unanswered revision is, is read off the rows that already exist —
 * the project, its coordinator conversation, the revision's wake rows and the turn each delivery
 * wrote — every time it is asked, exactly as the hold it extends always was:
 *
 *  - WAITING: owed to the project's coordinator. The project is Automatic, no fuse holds it, the
 *    coordinator conversation has not ended, took no part in the work, and the evidence quotes a live
 *    standard — and the coordinator is paused, or nothing has reached it yet (no delivery to it, or
 *    the last attempt was refused because it was paused), or the turn that carried it was taken off
 *    its queue unread (answered with nothing delivered: the drain a failed run does, or a turn
 *    removed from the queue). Nobody else is asked about it; the coordinator gets it when it is back
 *    (`CoordinatorEvidenceQueueService`).
 *  - HELD: the coordinator holds the delivery — `coordinatorHolds` as it always read, with an ended
 *    conversation in place of a stopped one: while the conversation that was handed it is paused,
 *    with no clock; while it is live, until the project's `exceptionEscalationSeconds` have passed
 *    since the delivery. A delivery that WAITED first says so (`WakeDeliveryRecord.waited`), which is
 *    what the owner's "Sent to the coordinator" line is drawn from.
 *  - otherwise: the owner's card, as it is today — a project that is not Automatic, a fuse, a
 *    coordinator that ended, was trashed or did the work, a revision only recorded, a delivery
 *    refused for any reason but a pause, or a hold whose window ran out.
 *
 * A pure read over a transaction client and nothing else: the pending read and the "Needs you" count
 * (`tasks/pending-evidence-judgments.ts`), which `sessions.service.ts` reaches, ask it, so it may not
 * import a service.
 */

/**
 * The refusal a delivery gives when the project's coordinator is paused, and the one refusal that
 * leaves the revision waiting for it rather than in front of the owner. Spelled beside the reader
 * that tells it apart from the others; `coordinator-delivery.service.ts` re-exports it beside the
 * codes it shares a column with.
 */
export const DELIVERY_COORDINATOR_PAUSED = 'DELIVERY_COORDINATOR_PAUSED';

/** The columns "is this conversation paused" is decided from: how it ended, and the retry it waits on. */
export const COORDINATOR_PAUSE_SELECT = { ...SESSION_ENDING_SELECT, retryAt: true } as const;

export interface CoordinatorConversationState extends SessionEnding {
  retryAt: Date | null;
}

/**
 * Whether a coordinator conversation is PAUSED: it will read what it is handed, but not now.
 *
 * Down (`conversationIsDown`: its run FAILED — a usage limit, a 429, an expired sign-in, a runner
 * that went away — and nobody ended it), or waiting on a retry it has armed (`retryAt`), which is
 * how a usage limit that did not fail the run parks it. A conversation that has ended is not paused:
 * it is over (`conversationIsOver`), and what it was owed is the owner's.
 */
export function conversationIsPaused(session: CoordinatorConversationState): boolean {
  if (conversationIsOver(session)) return false;
  return conversationIsDown(session) || session.retryAt !== null;
}

/** What a delivered wake row records about the message it carried (`project_coordinator_wake.delivery`). */
export type WakeDeliveryRecord = {
  /** The `conversation_turn` this delivery wrote, by the key it wrote it under. */
  clientTurnId: string;
  /** Set when the revision waited for its coordinator before this delivery reached it. */
  waited?: true;
  /** The turn a re-sent delivery replaces: the one that was taken off the queue unread. */
  replaces?: string;
};

/** The record a delivery writes. `waited` is written only when true, so an ordinary one stays `{ clientTurnId }`. */
export function wakeDeliveryRecord(
  clientTurnId: string,
  options: { waited?: boolean; replaces?: string } = {},
): WakeDeliveryRecord {
  return {
    clientTurnId,
    ...(options.waited ? { waited: true as const } : {}),
    ...(options.replaces ? { replaces: options.replaces } : {}),
  };
}

function deliveryRecordOf(json: unknown): WakeDeliveryRecord | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const { clientTurnId, waited, replaces } = json as Record<string, unknown>;
  if (typeof clientTurnId !== 'string') return null;
  return wakeDeliveryRecord(clientTurnId, {
    waited: waited === true,
    ...(typeof replaces === 'string' ? { replaces } : {}),
  });
}

/** One task whose latest evidence revision has no decision yet, as the pending read finds it. */
export interface UnansweredEvidenceRevision {
  task: CriterionStandingTask & { id: string };
  latest: {
    revision: bigint;
    criterionRevision: string;
    evidenceDigest: string;
    evidence: unknown;
  };
}

/** Where one unanswered revision of an Automatic project's task is, when it is not simply the owner's. */
export type CoordinatorEvidencePlace =
  | {
      place: 'WAITING';
      /** The conversation it waits for: the one the project is coordinated from now. */
      coordinatorSessionId: string;
      /**
       * The delivery to make again, when one was made and did not reach this conversation — its turn
       * was taken off the queue unread, or it went to a conversation the project has since replaced.
       * Its key stays held (DELIVERED is inside 0174's index), so it is re-sent under a turn key of
       * its own rather than claimed again. Null when nothing reached any conversation.
       */
      resend: { wakeId: string; idempotencyKey: string; clientTurnId: string } | null;
      /** The project a confirmed move brought the revision from, when it is that hand-over's to deliver. */
      movedFromProjectId: string | null;
    }
  | {
      place: 'HELD';
      /** The project's coordinator conversation now; null when it has none. */
      coordinatorSessionId: string | null;
      /** The conversation the delivery was made to. */
      sessionId: string;
      /** When it was made: the moment the hold's window runs from. */
      deliveredAt: Date;
      /** It was made after the revision had waited for its coordinator. */
      waited: boolean;
    };

const ATTEMPT_SELECT = {
  id: true,
  idempotencyKey: true,
  projectId: true,
  status: true,
  refusalCode: true,
  sessionId: true,
  delivery: true,
  detail: true,
  createdAt: true,
  updatedAt: true,
  session: { select: COORDINATOR_PAUSE_SELECT },
} as const;

/**
 * Where each of these unanswered revisions is with respect to its project's coordinator, by task id:
 * HELD by it, WAITING for it, or absent — the owner's card, exactly as it was before the coordinator
 * was handed anything (`docs/completion-input-routing.md` §A2 D1). The one reading both the pending
 * read and the "Needs you" count take (`tasks/pending-evidence-judgments.ts`), so the two cannot come
 * to disagree about it, and the one the catch-up delivery hands the waiting ones over from.
 *
 * A revision is HELD while ALL of these are true when it is read:
 *
 *   * its wake was DELIVERED — the revision the task's latest evidence row names, by the fact's own
 *     key or by the key a confirmed move handed it over under (`completionEvidenceRevisedFact`'s
 *     `movedFromProjectId`), under the project the task is filed under now (a delivery to the
 *     project it was moved out of holds nothing);
 *   * that project is still Automatic: switched off, it is the owner's card again, as it is for
 *     every project that is not (2026-09-10's behaviour, kept for them unchanged);
 *   * the conversation it was delivered to has not ended (`conversationIsOver`): a conversation that
 *     is over will not decide anything, and one that is only paused will once it is back (until
 *     2026-10-09 a FAILED run counted as over, `sessionHasEnded`);
 *   * the turn that carried it was not taken off the queue unread: such a delivery reached nobody;
 *   * and, while that conversation is live, the project's `exceptionEscalationSeconds` have not run
 *     out since the delivery was bound. `updatedAt` is that moment: the compare-and-set that writes
 *     DELIVERED is the row's last write, and a re-sent delivery writes it again. While the
 *     conversation is paused no clock runs.
 *
 * It WAITS for the coordinator under the rule the header states.
 */
export async function coordinatorHolds(
  tx: Prisma.TransactionClient,
  ownerId: string,
  rows: ReadonlyArray<UnansweredEvidenceRevision>,
  readAt: Date,
): Promise<Map<string, CoordinatorEvidencePlace>> {
  const places = new Map<string, CoordinatorEvidencePlace>();
  const inProjects = rows.filter((row) => row.task.projectId !== null);
  if (inProjects.length === 0) return places;

  const projectIds = [...new Set(inProjects.map((row) => row.task.projectId!))];
  const projects = new Map((await tx.project.findMany({
    where: { id: { in: projectIds }, ownerId },
    select: {
      id: true,
      coordinatorEnabled: true,
      exceptionEscalationSeconds: true,
      coordinatorSession: { select: { id: true, taskId: true, ...COORDINATOR_PAUSE_SELECT } },
    },
  })).map((project) => [project.id, project]));
  const fused = new Set((await tx.projectFuseEpisode.findMany({
    where: { projectId: { in: projectIds }, resumedAt: null },
    select: { projectId: true },
  })).map((episode) => episode.projectId));

  const keysOf = (row: UnansweredEvidenceRevision) => {
    const revision = {
      revision: row.latest.revision.toString(),
      criterionRevision: row.latest.criterionRevision,
      evidenceDigest: row.latest.evidenceDigest,
    };
    return {
      own: completionEvidenceWakeKey(row.task.id, revision),
      handedOver: completionEvidenceWakeKey(row.task.id, revision, row.task.projectId!),
    };
  };
  const wakes = await tx.projectCoordinatorWake.findMany({
    where: { idempotencyKey: { in: inProjects.flatMap((row) => Object.values(keysOf(row))) } },
    select: ATTEMPT_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  // The turn each delivery wrote, to tell one that was read from one taken off the queue unread.
  const delivered = wakes.flatMap((wake) => {
    const record = wake.status === 'DELIVERED' ? deliveryRecordOf(wake.delivery) : null;
    return record && wake.sessionId ? [{ sessionId: wake.sessionId, clientTurnId: record.clientTurnId }] : [];
  });
  const turns = delivered.length === 0 ? [] : await tx.conversationTurn.findMany({
    where: { OR: delivered },
    select: { sessionId: true, clientTurnId: true, status: true, deliveredAt: true },
  });
  const turnOf = (sessionId: string, clientTurnId: string) => turns.find((turn) => (
    turn.sessionId === sessionId && turn.clientTurnId === clientTurnId
  ));
  /**
   * The delivery's turn left the queue without being read: answered with nothing delivered, which is
   * what the drain of a failed run leaves (`runner-api.controller.ts`), or gone — an interrupt or a
   * withdrawal deletes a queued turn. Either way the coordinator never read it.
   */
  const unread = (sessionId: string, record: WakeDeliveryRecord): boolean => {
    const turn = turnOf(sessionId, record.clientTurnId);
    return !turn || (turn.status === 'ANSWERED' && turn.deliveredAt === null);
  };

  for (const row of inProjects) {
    const projectId = row.task.projectId!;
    const project = projects.get(projectId);
    if (!project) continue;
    const keys = keysOf(row);
    const forThisRevision = wakes.filter((wake) => (
      wake.idempotencyKey === keys.own || wake.idempotencyKey === keys.handedOver
    ));
    const attempts = forThisRevision.filter((wake) => wake.projectId === projectId);
    // The latest delivery, whichever conversation it reached. One whose conversation was deleted for
    // good names none any more (the FK is SET NULL) and holds nothing, but is still the delivery a
    // conversation the project has now is re-sent.
    const delivery = [...attempts]
      .filter((wake) => wake.status === 'DELIVERED')
      .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
      .at(-1);
    const record = delivery ? deliveryRecordOf(delivery.delivery) : null;
    const coordinator = project.coordinatorSession;

    // The hold, as `coordinatorHolds` has read it since 2026-09-29, with two changes: a conversation
    // that is only paused still holds what it was handed, with no clock running, and a delivery whose
    // turn was taken off the queue unread holds nothing — it was never read.
    const held = (): CoordinatorEvidencePlace | null => {
      if (!delivery || !record || !delivery.session || !project.coordinatorEnabled) return null;
      if (conversationIsOver(delivery.session) || unread(delivery.sessionId!, record)) return null;
      const escalatesAt = delivery.updatedAt.getTime() + project.exceptionEscalationSeconds * 1_000;
      if (!conversationIsPaused(delivery.session) && readAt.getTime() >= escalatesAt) return null;
      return {
        place: 'HELD',
        coordinatorSessionId: coordinator?.id ?? null,
        sessionId: delivery.sessionId!,
        deliveredAt: delivery.updatedAt,
        waited: record.waited === true,
      };
    };

    // Whether the conversation the project is coordinated from may be handed it at all — the same
    // questions the producer asks before it delivers (`CompletionEvidenceProducer`), and the fuse the
    // producer's authorizer refuses on. The two the door asks of the evidence cost a query each, so
    // they are asked last, and only where the answer can change the place (below).
    const reachable = project.coordinatorEnabled && coordinator !== null && !fused.has(projectId)
      && !conversationIsOver(coordinator);
    const owedTo = async (): Promise<string | null> => {
      if (!reachable) return null;
      if ((await criterionStandingRefusal(tx, row.task, row.latest.evidence)) !== null) return null;
      const scope = { ownerId, taskId: row.task.id };
      if ((await decidingSessionDisqualification(tx, scope, coordinator!)) !== null) return null;
      return coordinator!.id;
    };

    const waiting = (coordinatorSessionId: string): CoordinatorEvidencePlace => ({
      place: 'WAITING',
      coordinatorSessionId,
      resend: delivery && record
        ? { wakeId: delivery.id, idempotencyKey: delivery.idempotencyKey, clientTurnId: record.clientTurnId }
        : null,
      movedFromProjectId: movedFrom(forThisRevision, keys, projectId),
    });

    // Delivered to the live coordinator and read: held or not by its clock, whoever else could have
    // been asked — so the questions that cost a query are not asked.
    const readByLiveCoordinator = reachable && !conversationIsPaused(coordinator!)
      && delivery !== undefined && record !== null && delivery.sessionId === coordinator!.id
      && !unread(coordinator!.id, record);
    const coordinatorSessionId = readByLiveCoordinator ? null : await owedTo();
    let place: CoordinatorEvidencePlace | null;
    if (coordinatorSessionId === null) {
      place = held();
    } else if (conversationIsPaused(coordinator!)) {
      // Paused: whatever it was or was not handed, it is the coordinator's to decide once it is back.
      place = waiting(coordinatorSessionId);
    } else if (delivery && record && delivery.sessionId === coordinatorSessionId) {
      place = unread(coordinatorSessionId, record) ? waiting(coordinatorSessionId) : held();
    } else {
      // Nothing has reached the conversation the project has now. It waits for that conversation unless
      // the last attempt says the platform could not hand it over for some other reason than a pause —
      // recorded only, refused, or still in flight — which is the owner's card it always was.
      const last = attempts.at(-1);
      const notAPause = last !== undefined && last.status !== 'DELIVERED' && !(
        last.status === 'REFUSED' && last.refusalCode === DELIVERY_COORDINATOR_PAUSED
      );
      place = notAPause ? null : waiting(coordinatorSessionId);
    }
    if (place) places.set(row.task.id, place);
  }
  return places;
}

/**
 * The project a revision was moved in from, when its delivery here is a confirmed move's hand-over:
 * an attempt under the hand-over key says so in its own `detail`, and a delivery of the revision's
 * own key in another project says where it was submitted when no hand-over has been attempted yet.
 */
function movedFrom(
  wakes: ReadonlyArray<{ idempotencyKey: string; projectId: string; detail: unknown }>,
  keys: { own: string; handedOver: string },
  projectId: string,
): string | null {
  for (const wake of wakes) {
    if (wake.idempotencyKey !== keys.handedOver || wake.projectId !== projectId) continue;
    const detail = wake.detail as Record<string, unknown> | null;
    if (typeof detail?.movedFromProjectId === 'string') return detail.movedFromProjectId;
  }
  return wakes.find((wake) => wake.idempotencyKey === keys.own && wake.projectId !== projectId)?.projectId
    ?? null;
}

import { Prisma, TaskStatus } from '@prisma/client';

import { CRITERIA_WEAKENING_EFFECT_CLASS } from '../projects/criteria-weakening-intent';
import { stillUnanswered } from '../projects/criteria-pending-decisions';
import { DONE_REQUEST_KIND } from '../projects/project-done-request';
import { LOOKS_FINISHED_DELIVERY, projectsToRecordAsDone } from '../projects/project-looks-finished';
import { standardSetsAwaitingConfirmation } from '../projects/standard-set-awaiting-confirmation';
import { readWaitingOwnerConfirmations } from '../tasks/owner-confirmation-read';
import { evidenceCardsOfCoordinators, evidenceCardsOutsideProjects } from '../tasks/pending-evidence-judgments';

/**
 * THE DECISION CARDS THAT ARE THE ACCOUNT OWNER'S NOW, AND NOTHING ELSE PUSHES ABOUT
 * (task 354adqnR5U6CZFIfyR5df, `PushService.notifyDecisionCards`).
 *
 * Every other owner alert in push.service.ts hangs off a write: an approval asked, an owner item handed
 * over or escalated, an owner request or a crossing filed. These six cards had no such write, or none
 * that pushed, and several become the owner's with no write at all:
 *
 *   EVIDENCE            an evidence revision of a task in no project once its dispatching session stops
 *                       holding it (30 minutes after delivery, or the moment that session ends), or from
 *                       the start when there is none (`evidence-review.ts`); a project's revision once its
 *                       coordinator stops holding it (`coordinator-evidence-queue.ts`: switched off, ended,
 *                       a fuse, a hold whose window ran out, a project that is not Automatic).
 *   OWNER_CONFIRMATION  an OWNER_CONFIRMED task's run waiting on its owner (`readWaitingOwnerConfirmations`):
 *                       from the start with no reviewer, or once the review ends — reviewed, timed out, or
 *                       its reviewer ended. A coordinator's raise pushes as it is recorded
 *                       (`notifyConfirmationRaised`), and claims this same key, so it is not pushed twice.
 *   CRITERIA_DECISION   a held criteria proposal (CriteriaDecisionCard), as its coordinator files it.
 *   STANDARD_SET        a started project's standard set nobody has confirmed ("Confirm the new criteria?").
 *   DONE_REQUEST        a coordinator's request to record the project done ("Is this project done?").
 *   RECORD_AS_DONE      a project that looks finished, past its window with no request ("Record as done…").
 *
 * Each is read by the reader its Needs-you count already uses (`owner-decision-signal.ts`), over the
 * same population, so a push goes out exactly for what lights the row — and points where the card is
 * drawn. `START_REQUEST` is left out on purpose: nothing is blocked on a start, the badge and the
 * clients' bar leave it out too, and its card is the owner's to answer when they choose.
 *
 * Each card carries a KEY naming it and the version of it that is waiting: the ledger
 * (`owner_card_push`, migration 1720) holds one row per key pushed, so a card is pushed once however
 * many sweeps read it, and a new revision, request or set is a new key.
 */

export type OwnerCardKind =
  | 'EVIDENCE'
  | 'OWNER_CONFIRMATION'
  | 'CRITERIA_DECISION'
  | 'STANDARD_SET'
  | 'DONE_REQUEST'
  | 'RECORD_AS_DONE';

export interface OwnerCard {
  /** One push per key, ever (`owner_card_push`). */
  key: string;
  kind: OwnerCardKind;
  /** The conversation the card is drawn in: what the push's tap opens. */
  sessionId: string;
  projectId: string | null;
  taskId: string | null;
  /** The thing the card asks about: a revision, a request, a proposal, an item, a project. */
  subjectId: string;
  title: string;
  body: string;
  /** The conversation is open (not ended, filed away or in Trash): only then does the badge count it. */
  open: boolean;
}

/** The push kind every one of these cards is sent as; `cardKind` in the payload says which. */
export const DECISION_CARD_PUSH_KIND = 'decision-card';

/** The ledger key of an owner confirmation, which `notifyConfirmationRaised` claims as well. */
export function ownerConfirmationCardKey(requestId: string): string {
  return `owner-confirmation:${requestId}`;
}

/** The ledger key of an evidence revision's card. */
export function evidenceCardKey(evidenceId: string): string {
  return `evidence:${evidenceId}`;
}

const OPEN_CONVERSATION = { completedAt: null, archivedAt: null, deletedAt: null } as const;

/**
 * The cards above that are the owner's at `readAt`, each in a conversation that is not in Trash. One that
 * has ended is kept: a dispatching session that ended is exactly how an evidence card becomes the owner's,
 * and the card is drawn in it (`ownerEvidenceCard`). `open` says which the badge counts, which is the
 * clients' rule: a conversation filed away lights no row.
 */
export async function readOwnerCards(
  tx: Prisma.TransactionClient,
  ownerId: string,
  readAt: Date = new Date(),
): Promise<OwnerCard[]> {
  const cards: Array<Omit<OwnerCard, 'open'>> = [];

  // The projects coordinated from an open conversation: `readProjectDecisionSignals`'s scope.
  const coordinated = await tx.project.findMany({
    where: { ownerId, coordinatorSessionId: { not: null }, coordinatorSession: OPEN_CONVERSATION },
    select: { id: true, title: true, status: true, coordinatorSessionId: true, coordinatorSession: { select: { taskId: true } } },
  });
  const projectTitle = new Map(coordinated.map((project) => [project.id, project.title]));
  const coordinatorOf = new Map(coordinated.map((project) => [project.id, project.coordinatorSessionId!]));
  const projectIds = coordinated.map((project) => project.id);

  // Evidence, in a project and out of one: the rows the two badge counts fold.
  const evidence = [
    ...await evidenceCardsOfCoordinators(tx, ownerId, coordinated.map((project) => ({
      projectId: project.id,
      session: { id: project.coordinatorSessionId!, taskId: project.coordinatorSession?.taskId ?? null },
    })), readAt),
    ...await evidenceCardsOutsideProjects(tx, ownerId, readAt),
  ];
  for (const row of evidence) {
    cards.push({
      key: evidenceCardKey(row.evidenceId),
      kind: 'EVIDENCE',
      sessionId: row.sessionId,
      projectId: row.projectId,
      taskId: row.taskId,
      subjectId: row.evidenceId,
      title: row.title,
      body: `Does this evidence settle the task? · Revision ${row.revision}`,
    });
  }

  // An OWNER_CONFIRMED task's run waiting on its owner, on the task's own session.
  const confirmations = await readWaitingOwnerConfirmations(tx, ownerId);
  if (confirmations.length > 0) {
    const titles = new Map((await tx.task.findMany({
      where: { ownerId, id: { in: [...new Set(confirmations.map((waiting) => waiting.taskId))] } },
      select: { id: true, title: true },
    })).map((task) => [task.id, task.title]));
    for (const waiting of confirmations) {
      cards.push({
        key: ownerConfirmationCardKey(waiting.requestId),
        kind: 'OWNER_CONFIRMATION',
        sessionId: waiting.sessionId,
        projectId: waiting.projectId,
        taskId: waiting.taskId,
        subjectId: waiting.requestId,
        title: titles.get(waiting.taskId) ?? 'Orbit',
        body: 'Waiting for your confirmation',
      });
    }
  }

  if (projectIds.length > 0) {
    // Held criteria proposals: the filed rows, then which are still a question.
    const filed = await tx.projectRatifiedActionIntent.findMany({
      where: { ownerId, projectId: { in: projectIds }, effectClass: CRITERIA_WEAKENING_EFFECT_CLASS },
      select: { id: true, projectId: true, action: true },
    });
    for (const row of await stillUnanswered(tx, filed)) {
      if (row.projectId == null || !coordinatorOf.has(row.projectId)) continue;
      cards.push({
        key: `criteria-decision:${row.id}`,
        kind: 'CRITERIA_DECISION',
        sessionId: coordinatorOf.get(row.projectId)!,
        projectId: row.projectId,
        taskId: null,
        subjectId: row.id,
        title: projectTitle.get(row.projectId) ?? 'Orbit',
        body: 'A criteria change is waiting for your decision',
      });
    }

    for (const [projectId, digest] of await standardSetsAwaitingConfirmation(tx, ownerId, projectIds)) {
      cards.push({
        key: `standard-set:${projectId}:${digest}`,
        kind: 'STANDARD_SET',
        sessionId: coordinatorOf.get(projectId)!,
        projectId,
        taskId: null,
        subjectId: projectId,
        title: projectTitle.get(projectId) ?? 'Orbit',
        body: 'Confirm the new criteria?',
      });
    }

    // `projectsReadyToClose`'s rows, by request: a request filed again is a new card.
    const doneRequests = await tx.projectOpenItem.findMany({
      where: { ownerId, projectId: { in: projectIds }, kind: DONE_REQUEST_KIND, state: 'OPEN', project: { status: 'OPEN' } },
      select: { id: true, projectId: true },
    });
    for (const request of doneRequests) {
      cards.push({
        key: `done-request:${request.id}`,
        kind: 'DONE_REQUEST',
        sessionId: coordinatorOf.get(request.projectId)!,
        projectId: request.projectId,
        taskId: null,
        subjectId: request.id,
        title: projectTitle.get(request.projectId) ?? 'Orbit',
        body: 'Is this project done?',
      });
    }

    // A project that looks finished past its window, keyed by the delivery that told its coordinator:
    // the same episode is pushed once, and a project that settles again later is a new one.
    const open = coordinated.filter((project) => project.status === 'OPEN').map((project) => project.id);
    const due = await projectsToRecordAsDone(tx, ownerId, open, readAt);
    if (due.size > 0) {
      const deliveries = await tx.projectCoordinatorWake.findMany({
        where: { projectId: { in: [...due.keys()] }, event: LOOKS_FINISHED_DELIVERY, status: { in: ['DELIVERED', 'REFUSED'] } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: { id: true, projectId: true },
      });
      for (const projectId of due.keys()) {
        const delivery = deliveries.find((row) => row.projectId === projectId);
        if (!delivery) continue;
        cards.push({
          key: `record-as-done:${projectId}:${delivery.id}`,
          kind: 'RECORD_AS_DONE',
          sessionId: coordinatorOf.get(projectId)!,
          projectId,
          taskId: null,
          subjectId: projectId,
          title: projectTitle.get(projectId) ?? 'Orbit',
          body: 'This project looks finished · Record it as done?',
        });
      }
    }
  }

  if (cards.length === 0) return [];
  const sessions = new Map((await tx.session.findMany({
    where: { ownerId, id: { in: [...new Set(cards.map((card) => card.sessionId))] }, deletedAt: null },
    select: { id: true, completedAt: true, archivedAt: true },
  })).map((session) => [session.id, session.completedAt === null && session.archivedAt === null]));
  return cards
    .filter((card) => sessions.has(card.sessionId))
    .map((card) => ({ ...card, open: sessions.get(card.sessionId)! }));
}

/**
 * The owners who could have one of these cards: an unsettled task waiting on a judgment or a
 * confirmation, or an open project coordinated from a conversation. Grouped in SQL, so a sweep reads
 * one row per owner, not one per task.
 */
export async function ownersWithPossibleCards(tx: Prisma.TransactionClient): Promise<string[]> {
  const [tasks, projects] = await Promise.all([
    tx.task.groupBy({
      by: ['ownerId'],
      where: {
        status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
        completionCriterion: { in: ['EVIDENCE_JUDGMENT', 'OWNER_CONFIRMED'] },
      },
    }),
    tx.project.groupBy({
      by: ['ownerId'],
      where: { status: 'OPEN', coordinatorSessionId: { not: null } },
    }),
  ]);
  return [...new Set([...tasks, ...projects].map((row) => row.ownerId))];
}

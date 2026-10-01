import { Prisma } from '@prisma/client';
import type { AcceptedGap } from '@orbit/shared';

/**
 * A coordinator asking its owner to record the project done, and the owner's answer.
 *
 * The request is an open item of its own kind, `DONE_REQUEST`, with the owner on it from birth: the
 * coordinator's call, every gap Orbit cannot prove, and the seal of the criteria it was made about
 * (`DoneRequest`, `@orbit/shared`). It is what the owner's "Is this project done?" card is drawn
 * from. The owner answers it on `POST /projects/:id/done` (`ProjectAcceptanceService.
 * recordProjectDone`), which writes the project's DONE and resolves the request in one transaction
 * (`answerDoneRequests`), and refuses with nothing written when the request is no longer open or
 * the criteria have moved since it was made.
 */

export const DONE_REQUEST_KIND = 'DONE_REQUEST';
/** Every request of a project shares this key, so at most one of them is OPEN (0278's index). */
export const DONE_REQUEST_DEDUPE_KEY = 'DONE_REQUEST';
/** The item's title: the card's own question. */
export const DONE_REQUEST_TITLE = 'Is this project done?';

/**
 * The owner's DONE answers the request: the one the card named, or — when the owner records the
 * project done without being asked — whichever is open, since a project recorded done has nothing
 * left to ask. Resolved APPROVED, by the owner, at the record's own instant, with the gaps they
 * accepted as the answer. A participant of `recordProjectDone`'s transaction, after its project
 * lock and the request's.
 */
export async function answerDoneRequests(
  tx: Prisma.TransactionClient,
  answer: {
    ownerId: string;
    projectId: string;
    requestId: string | null;
    at: Date;
    acceptedGaps: readonly AcceptedGap[];
  },
): Promise<void> {
  await tx.projectOpenItem.updateMany({
    where: {
      projectId: answer.projectId,
      kind: DONE_REQUEST_KIND,
      state: 'OPEN',
      ...(answer.requestId !== null ? { id: answer.requestId } : {}),
    },
    data: {
      state: 'RESOLVED',
      resolution: 'APPROVED',
      resolvedAt: answer.at,
      resolvedBy: 'USER',
      resolvedByUserId: answer.ownerId,
      answer: answer.acceptedGaps as unknown as Prisma.InputJsonValue,
    },
  });
}

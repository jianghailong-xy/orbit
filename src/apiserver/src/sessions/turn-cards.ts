import type { Prisma, SessionRunSource } from '@prisma/client';
import type {
  ConfirmationReturnCard,
  ConfirmationReviewRequestCard,
  OpenItemDeliveryCard,
  ProjectStartedCard,
  SessionMessageCard,
  SessionReplyCard,
  TaskStartCard,
} from '@orbit/shared';

import { openItemIdOfTurn, readOpenItemDeliveryCard } from '../projects/project-open-item';
import { projectStartOfTurn, readProjectStartedCard } from '../projects/project-started';
import {
  readConfirmationReturnCard,
  readConfirmationReviewRequestCard,
} from '../tasks/owner-confirmation-review-turn';
import { readTaskStartCard } from '../tasks/task-start-card';
import { readSessionMessageCard } from './session-message';
import { readSessionReplyCards, readTurnRequestIds } from './session-request';

/**
 * The cards a user turn is drawn as, under the names the runner's echo stores them by: each field is
 * the key of the `user` event's payload that carries it (runner-api/control-plane-note.ts), and is
 * absent — not empty — on every turn that is not that card.
 *
 * A turn the control plane opened is drawn as a card rather than as the owner's own message: an
 * exception item's delivery, a task run's brief, a project's start, a confirmation request handed to
 * its reviewer and a reviewer's return handed to the run, another Orbit session's message, and the
 * outcomes of this session's own requests handed back to it. It is drawn twice — while it waits
 * (`SessionsService.listQueuedTurns`, both views) and once the runner echoes it (the event ingest,
 * runner-api.controller.ts) — and both read it here, so a card cannot be on one and missing from the
 * other. Each new kind of card used to be added to the echo first and to the queue later, and a
 * client drew the queued turn as the owner's bubble until it was: `sessionReplies` was missing from
 * the queue that way, and `taskStart` was never on it at all.
 */
export interface TurnCards {
  openItemDelivery?: OpenItemDeliveryCard;
  taskStart?: TaskStartCard;
  projectStarted?: ProjectStartedCard;
  confirmationReviewRequest?: ConfirmationReviewRequestCard;
  confirmationReturn?: ConfirmationReturnCard;
  sessionMessage?: SessionMessageCard;
  sessionReplies?: SessionReplyCard[];
}

/**
 * The cards each of these turns of one session carries, by turn id — for the turns that are a card,
 * and nothing at all for a batch of ordinary messages.
 *
 * Each card is read by the function that owns it, and each is read only for the turns it can be:
 * the turn's own key, or its sender column, says which those are, so an ordinary message costs one
 * indexed read (the reply cards, whose turn is whichever one the outcomes ride on) and no other.
 *
 * The reading is taken at each moment the turn is drawn, by design: a card is a snapshot of what the
 * platform knows, and the one way the queued card and the echo's can differ is the rows having moved
 * between the two — never two derivations of the same fields drifting apart.
 */
export async function readTurnCards(
  db: Prisma.TransactionClient,
  session: { id: string; ownerId: string; taskId: string | null; runSource: SessionRunSource | null },
  turns: ReadonlyArray<{ id: string; clientTurnId: string; content: string | null; senderSessionId: string | null }>,
): Promise<Map<string, TurnCards>> {
  const cards = new Map<string, TurnCards>();
  const add = (turnId: string, card: TurnCards) => cards.set(turnId, { ...cards.get(turnId), ...card });
  // The turns the control plane opened for an exception item, and the card each was drawn from
  // (project-open-item.ts `readOpenItemDeliveryCard`). Which turns those are is the turn's own key —
  // `open-item:v1:` is the prefix `openItemTurnId` mints — so this reads the item's columns and the
  // task's merge receipts for exactly the deliveries that have a card.
  for (const turn of turns) {
    const itemId = openItemIdOfTurn(turn.clientTurnId);
    if (!itemId) continue;
    const openItemDelivery = await readOpenItemDeliveryCard(db, itemId);
    if (openItemDelivery) add(turn.id, { openItemDelivery });
  }
  // The turn that hands a task's run its brief, and the task it was built from (tasks/task-start-card.ts).
  // Read only for a task run's opening or resume turn.
  for (const turn of turns) {
    const taskStart = await readTaskStartCard(db, session, turn);
    if (taskStart) add(turn.id, { taskStart });
  }
  // The turns telling a coordinator its project was started, by the same kind of key
  // (`project-started:v1:`, project-started.ts).
  for (const turn of turns) {
    const start = projectStartOfTurn(turn.clientTurnId);
    if (!start) continue;
    const projectStarted = await readProjectStartedCard(db, session.ownerId, start);
    if (projectStarted) add(turn.id, { projectStarted });
  }
  // A confirmation request handed to its reviewer, and a reviewer's return handed to the run
  // (docs/owner-confirmation-review-contract.md D7, B3), by the turn's own key.
  for (const turn of turns) {
    const confirmationReviewRequest = await readConfirmationReviewRequestCard(db, turn.clientTurnId);
    if (confirmationReviewRequest) add(turn.id, { confirmationReviewRequest });
    const confirmationReturn = await readConfirmationReturnCard(db, turn.clientTurnId);
    if (confirmationReturn) add(turn.id, { confirmationReturn });
  }
  // The turns another Orbit session sent (`session_send` / `project_send`), and who sent each — read
  // off the turn's sender column (session-message.ts, contract §2.3). A message that asked for a reply
  // names its request on the card (session-request.ts), and a client reads the request's state from
  // there: the card is stored once and the state moves.
  const signed = turns.filter((turn) => turn.senderSessionId);
  const requestOfTurn = await readTurnRequestIds(db, session.id, signed.map((turn) => turn.id));
  for (const turn of signed) {
    const sessionMessage = await readSessionMessageCard(
      db, session.ownerId, turn.senderSessionId!, requestOfTurn.get(turn.id),
    );
    if (sessionMessage) add(turn.id, { sessionMessage });
  }
  // The outcomes of this session's own requests that a turn hands back (contract §4.2), read off the
  // request rows by the key of the turn they ride on. That is not only a reply turn: an outcome held
  // for the session joins whichever of its turns is handed out next (`appendSessionRepliesContext`).
  const replies = await readSessionReplyCards(db, session.id, turns.map((turn) => turn.clientTurnId));
  for (const turn of turns) {
    const sessionReplies = replies.get(turn.clientTurnId);
    if (sessionReplies) add(turn.id, { sessionReplies });
  }
  return cards;
}

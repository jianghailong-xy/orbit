import type { CoordinatorDeliveryCard, OrbitMessageFrom } from '@orbit/shared';

import { readCoordinatorDeliveryCards } from '../projects/coordinator-delivery-card';
import { isOrbitAuthoredTurn, isOrbitAuthoredTurnOf } from './orbit-authored-turn';
import type { TurnCards } from './turn-cards';

/**
 * That the message a session row previews is Orbit's own, as the row records it beside
 * `lastUserText` (`lastUserFromOrbit`, docs/session-list-projects-design.md §3.5, owner 2026-11-07):
 * null for a message somebody sent — the account owner, or another session, which `lastUserFrom`
 * names whatever key it chose — and for one the control plane wrote, the card its line is written
 * from when the conversation draws it as a coordinator's notification (`coordinatorDelivery`).
 *
 * Orbit's own is a turn its key says the control plane wrote (`isOrbitAuthoredTurn`: a coordinator
 * told of a fact, the answer to a criteria proposal, a watch's wake, the owner's answer handed to a
 * coordinator, an exception item's delivery, a project's start, a task run's brief on a resume, a
 * confirmation's review…), or a turn the conversation draws as one of the platform's own cards. The
 * second adds a task run's brief on the turn that opened its session: every session's prompt is
 * filed under the same `initial-<id>` key, and the brief is told from a person's opening only by its
 * card (`readTaskStartCard`). The opening of a session the platform opened with a prompt of its own
 * and no card — a coordinator, a judgment, a dispatch console, an @-mention's reply — is told by the
 * session's own column instead (`isOrbitAuthoredTurnOf`, `session.prompt_by_orbit`).
 *
 * The same reading decides whether a failed turn's re-send is Orbit's (auto-retry.service.ts), so a
 * message is Orbit's on its re-send exactly where it was before it failed.
 */
export function orbitMessageOf(
  turn: { clientTurnId: string | null; senderSessionId: string | null },
  cards: TurnCards | undefined,
  session: { id: string; promptByOrbit: boolean },
): OrbitMessageFrom | null {
  if (turn.senderSessionId) return null;
  const platformCard = cards !== undefined && (
    cards.runQuestion !== undefined
    || cards.openItemDelivery !== undefined
    || cards.ownerAnswer !== undefined
    || cards.coordinatorDelivery !== undefined
    || cards.taskStart !== undefined
    || cards.projectStarted !== undefined
    || cards.confirmationReviewRequest !== undefined
    || cards.confirmationReturn !== undefined
    || cards.confirmationAnswers !== undefined
  );
  if (!platformCard && !isOrbitAuthoredTurnOf(session, turn.clientTurnId)) return null;
  return { coordinatorDelivery: cards?.coordinatorDelivery ?? null };
}

/**
 * `orbitMessageOf` for a turn just written, in the transaction that wrote it (createTurn, interrupt's
 * follow-up, the resume revive): the row previews the message from the moment it is queued, so it
 * says who wrote it from then on, not only once the runner echoes it. A coordinator's notification
 * is bound to its turn earlier in the same transaction (`bindQueuedDelivery`), so its card reads here
 * as the echo will read it; one whose wake is bound after the turn commits (the older carrier) reads
 * as Orbit's with no card until its echo, which reads the card again. A plain read, no lock, and
 * none at all for a turn whose key no delivery could have (`readCoordinatorDeliveryCards`).
 */
export async function readOrbitMessageFrom(
  db: Parameters<typeof readCoordinatorDeliveryCards>[0],
  sessionId: string,
  turn: { id: string; clientTurnId: string; content: string | null },
  senderSessionId: string | null,
): Promise<OrbitMessageFrom | null> {
  if (senderSessionId || !isOrbitAuthoredTurn(turn.clientTurnId)) return null;
  const coordinatorDelivery: CoordinatorDeliveryCard | undefined =
    (await readCoordinatorDeliveryCards(db, sessionId, [turn])).get(turn.id);
  return { coordinatorDelivery: coordinatorDelivery ?? null };
}

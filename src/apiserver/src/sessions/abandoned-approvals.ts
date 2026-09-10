import { Prisma } from '@prisma/client';

/**
 * Collecting the approvals whose tool call can never be answered — on a committed fact, never on a
 * clock.
 *
 * WHAT WENT WRONG WITHOUT THIS
 * ----------------------------
 * On 2026-09-09 an `AskUserQuestion` approval sat PENDING for eight hours and held the account
 * owner's "Needs you" badge lit the whole time. Nothing was waiting for them: the engine's
 * permission poll had hit `connection reset by peer`, the engine had simply asked the question
 * again, and the second ask was answered half an hour later. The first row was abandoned — and
 * being abandoned wrote nothing anywhere, because there was nowhere for it to be written.
 *
 * WHY NOT "PENDING FOR LONGER THAN N"
 * -----------------------------------
 * Because that is not a fact about the row. `permissionPrompt` (src/runner-go/mcp.go) polls with no
 * wall-clock cap on purpose — it is asking a human who may be asleep — and `approval` has neither
 * an expiry column nor a clock. So "it has been pending a while" is elapsed time, and
 * `docs/completion-input-routing.md` forbids exactly that reading on this path: no scheduler, no
 * timeout, no elapsed-time interpretation. An hour of silence from a sleeping owner and an hour of
 * silence from a dead poll loop are the same duration, and one of them is still a live question.
 *
 * THE FACT THIS USES INSTEAD
 * --------------------------
 * The turn that raised the approval has ended. That is two committed rows and no clock: the
 * approval names its opening turn (`approval.turn_id`, migration 0252), and the turn says whether
 * it is still live. The consequence is not a guess — the poll loop that would consume the answer
 * runs INSIDE that turn, so once the turn is ANSWERED there is nothing left that could receive one.
 * The row is not "probably stale"; it is unanswerable.
 *
 * A row whose opener is unknown (null `turn_id`: raised outside a turn, or filed before 0252) is
 * never collected. The predicate has to be a fact, and "we do not know who raised it" is not one.
 *
 * IT LEAVES A TRACE RATHER THAN DELETING
 * --------------------------------------
 * The row survives as ABANDONED carrying the sentence below, so the history of the conversation
 * still contains the question that was asked and the reason nobody will ever answer it. `decidedAt`
 * and `decidedById` stay null, because nobody decided anything — that is the whole distinction this
 * status exists to preserve, and collapsing it into DENIED would put a refusal in the record that
 * no person made.
 */

/** The status an unanswerable approval is left in. Not a decision — see the note above. */
export const APPROVAL_ABANDONED_STATUS = 'ABANDONED';

/** The trace, in the row itself, of why this one will never be answered. */
export const APPROVAL_ABANDONED_MESSAGE =
  'the turn that asked this ended before it was answered, so nothing is left to receive an answer';

/**
 * Collect this session's approvals whose opening turn has ended. Returns how many were collected.
 *
 * Called from the boundaries that END turns — the turn-complete acknowledgement and the drains that
 * settle every outstanding turn when a session finalizes — because that is where the fact this
 * depends on becomes committed. It is written as a predicate over current rows rather than as a
 * list of ids so that all of those boundaries call it the same way, and so that a boundary added
 * later is not a boundary that forgot.
 *
 * The live turns are read first and the collection excludes them, which is what keeps a concurrent
 * second ask safe: an engine that re-asked inside a turn that is still running has both rows
 * pointing at that turn, and neither is touched.
 */
export async function reapApprovalsOfEndedTurns(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<number> {
  const live = await tx.conversationTurn.findMany({
    where: { sessionId, status: { not: 'ANSWERED' } },
    select: { id: true },
  });
  const collected = await tx.approval.updateMany({
    where: {
      sessionId,
      status: 'PENDING',
      // Both clauses are load-bearing. `notIn: []` is a tautology in SQL, so without the explicit
      // "is not null" a session with no live turns would collect every approval including the ones
      // whose opener is unknown — precisely the guess this refuses to make.
      AND: [{ turnId: { not: null } }, { turnId: { notIn: live.map((turn) => turn.id) } }],
    },
    data: { status: APPROVAL_ABANDONED_STATUS, message: APPROVAL_ABANDONED_MESSAGE },
  });
  return collected.count;
}

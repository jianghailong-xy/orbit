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
 * The rows filed before 0252 were settled once instead, by migration 0258, on the two facts
 * `SessionsService.listApprovals` reads; that migration says why no rule here could reach them.
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

/** The trace, in the row itself, of why a card whose reader was replaced will never be answered. */
export const APPROVAL_ORPHANED_MESSAGE =
  'the process that asked this was replaced before it was answered, so nothing is left to receive an answer';

/**
 * Collect this session's pending approvals when a DIFFERENT process takes the session over. Returns
 * the ids collected.
 *
 * WHY THE PREDICATE ABOVE CANNOT SEE THESE
 * ----------------------------------------
 * A runner that restarts mid-turn leaves the turn IN_FLIGHT. It is re-delivered to the process that
 * takes over, keeps its id and runs on, so every fact `reapApprovalsOfEndedTurns` reads still says
 * "live" — and it is right, the turn is live. What died is narrower and just as committed: the poll
 * loops. They ran inside the process being replaced (`orbit mcp` is its child), so an answer to any
 * card they filed now reaches nobody.
 *
 * 2026-09-16 is what that costs when nothing collects them: a create card was raised at 05:53, the
 * runner restarted at 06:01, and the account owner answered at 06:02 — twice, a second card having
 * appeared beside the first — with both answers reaching nothing, because both loops had died nine
 * minutes earlier. The turn was still running the whole time.
 *
 * THE FACT IT USES
 * ----------------
 * A different process now supervises this session. That is the same committed rotation the takeover
 * already clears the predecessor's background shells and engine flag on, and the reasoning is
 * identical: what that process owned went with it. So this takes no view on WHICH turn raised a
 * card — unlike the reaper above, whose question is per-row ("is the turn that asked still live?")
 * and which must therefore refuse the rows whose opener is unknown. Here the fact is about the
 * session's reader, and every pending card of that session was being read by it.
 *
 * Called only where the rotation is committed, and only when there WAS a predecessor: a session
 * whose lease owner was null had no process to lose, and "nobody was supervising it" is not
 * evidence that nobody is reading these cards.
 */
export async function reapApprovalsOfReplacedSupervisor(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<string[]> {
  const collected = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "approval"
       SET "status" = ${APPROVAL_ABANDONED_STATUS}, "message" = ${APPROVAL_ORPHANED_MESSAGE}
     WHERE "session_id" = ${sessionId}::uuid AND "status" = 'PENDING'
    RETURNING "id"`;
  return collected.map((row) => row.id);
}

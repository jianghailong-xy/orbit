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
 * THE ONE CONSUMER THAT OUTLIVES ITS TURN
 * ---------------------------------------
 * A runner-hosted job. That is what hosting the process on the runner is FOR — it goes on running,
 * and polling, after the turn that started it has ended — so for a card raised from one the premise
 * above is simply false, and collecting it drops an answer the owner is about to give. 2026-09-19:
 * `orbit project resolve-blocker` run inside a background job filed a card, its turn ended, the row
 * was collected while the CLI was still polling, and the owner's Allow reached nobody; the same
 * card raised in-turn beside it was answered and written.
 *
 * Such a card names its job (`approval.background_job_id`, migration 0291) and is left alone for as
 * long as that job is up. That is `Session.running_bg_shells` — the runner reports a job's `running`
 * and its end, and the column means "a process is still up" (schema.prisma), which is exactly the
 * question. Deliberately NOT `runningBgJobs` (whose narrower "is work in flight" excludes a
 * `service`) and deliberately not the freshness rule built over its activity: a job blocked on this
 * card writes nothing BY DEFINITION, so a long silence is what an answerable card looks like rather
 * than evidence against one. When the job does go, its poll loop goes with it — the CLI is a
 * descendant of the job's process tree — and the next reap collects the row with a sentence saying
 * which reader was lost.
 *
 * This says nothing about the OTHER reaper below (`reapApprovalsOfReplacedSupervisor`), and cannot:
 * its fact is that this session's supervising process was replaced, it collects every pending row
 * on that fact, and the set read here is emptied by the very takeover it runs in. A runner-hosted
 * job may also be handed on to the next image rather than dying with the predecessor, so a card it
 * is still reading can be collected there — the same loss, at a boundary this file cannot decide
 * from current rows. Narrowing that one needs a fact about the handoff, not a stricter read of the
 * ones here.
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
 * The trace for a card whose reader was a runner-hosted job that is no longer up.
 *
 * Its own sentence rather than the one above, for the reason `APPROVAL_ORPHANED_MESSAGE` has one:
 * the outcome is the same and the reason is not. Writing "the turn that asked this ended" onto a
 * card a job asked re-states the very premise this module exists to correct — the turn had nothing
 * to do with reading it, and it is the job that went away.
 */
export const APPROVAL_ABANDONED_JOB_MESSAGE =
  'the background job that asked this ended before it was answered, so nothing is left to receive an answer';

/**
 * Collect this session's approvals whose reader is gone. Returns how many were collected.
 *
 * Called from the boundaries that END turns — the turn-complete acknowledgement and the drains that
 * settle every outstanding turn when a session finalizes — because that is where the fact this
 * depends on becomes committed. It is written as a predicate over current rows rather than as a
 * list of ids so that all of those boundaries call it the same way, and so that a boundary added
 * later is not a boundary that forgot.
 *
 * The live turns are read first and the collection excludes them, which is what keeps a concurrent
 * second ask safe: an engine that re-asked inside a turn that is still running has both rows
 * pointing at that turn, and neither is touched. The live jobs are read the same way and for the
 * same reason.
 *
 * The two readers are asked about separately, because each card has exactly one of them and the
 * facts are therefore not interchangeable. A card that names a job is read by that process, so its
 * job's liveness settles it and the turn is not consulted at all — a job may file while no turn is
 * in flight (`turn_id` null), which is the ordinary shape of a watch that decides an hour later,
 * and such a row is collected when its job goes rather than left for the turn rule that could
 * never reach it. Everything else is read by the turn it names, and is collected on that turn
 * ending; a card at the turn boundary in flight when a job filed one is the job's, not the turn's.
 */
export async function reapApprovalsOfEndedTurns(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<number> {
  const live = await tx.conversationTurn.findMany({
    where: { sessionId, status: { not: 'ANSWERED' } },
    select: { id: true },
  });
  // Deliberately the whole set rather than the fresh subset of it: `runningBgJobs` narrowed by
  // output freshness answers "is work in flight", and a job waiting for an answer is silent.
  const liveJobs =
    (
      await tx.session.findUnique({
        where: { id: sessionId },
        select: { runningBgShells: true },
      })
    )?.runningBgShells ?? [];
  // `not: null` beside `notIn` is load-bearing, here and below: `notIn: []` is a tautology in SQL,
  // so without it a session whose jobs (or turns) have all ended would collect every row,
  // including the ones whose reader is unknown — precisely the guess this refuses to make.
  const lostItsJob = await tx.approval.updateMany({
    where: {
      sessionId,
      status: 'PENDING',
      backgroundJobId: { not: null, notIn: liveJobs },
    },
    data: { status: APPROVAL_ABANDONED_STATUS, message: APPROVAL_ABANDONED_JOB_MESSAGE },
  });
  const lostItsTurn = await tx.approval.updateMany({
    where: {
      sessionId,
      status: 'PENDING',
      AND: [
        { turnId: { not: null } },
        { turnId: { notIn: live.map((turn) => turn.id) } },
        // The complement of the pass above, and the reason a card a live job is still reading is
        // in neither: it names its reader, so it is not this rule's to collect.
        { backgroundJobId: null },
      ],
    },
    data: { status: APPROVAL_ABANDONED_STATUS, message: APPROVAL_ABANDONED_MESSAGE },
  });
  return lostItsJob.count + lostItsTurn.count;
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

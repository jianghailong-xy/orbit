import { Prisma, PrismaClient } from '@prisma/client';

import { isSessionGenerating } from '../common/session-generating';

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
 * never collected by the TURN rule above. The predicate has to be a fact, and "we do not know who
 * raised it" is not one. The rows filed before 0252 were settled once instead, by migration 0258,
 * on the two facts `SessionsService.listApprovals` reads; that migration says why no rule here
 * could reach them.
 *
 * THE CARD'S OWN CALL IS A THIRD READER, AND A THIRD FACT
 * ------------------------------------------------------
 * The engine runs in stretches of its own — a background task reporting in, a scheduled wake-up,
 * both of which stay at AWAITING_INPUT for their whole duration (`common/session-generating.ts`) —
 * and an ask raised in one has no turn to name, so the turn rule can never reach it. 2026-09-20:
 * such a card (an `AskUserQuestion` at 20:56, `turn_id` null, no job) had its poll die on `context
 * deadline exceeded`; the engine wrote the error result and ran on for another 550 turns while the
 * row sat PENDING, keeping the conversation reading "Waiting for approval" with no card on any
 * surface to press — the count takes every pending row of a generating session, and the listing
 * hides this one on the very fact the pass below collects it by.
 *
 * That fact is the card's own and no one else's: the tool call it was raised for already has a
 * result. `tool_call.finished_at` is written by the same ingest that finishes every call, it is
 * what the engine leaving a call behind leaves there, and `SessionsService.stillBeingAsked` already
 * reads it to stop offering the card. Whatever the opener is, the loop that would consume an answer
 * runs INSIDE the call, and a call that has returned is not running. So a card that names neither
 * a turn nor a job is collected on it, and a card that names a job is not — that reader outlives
 * its own call by construction and is settled by its job alone.
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
 * The trace for a card whose own call has already returned — the third reader, after the turn and
 * the job.
 *
 * Its own sentence for the same reason the two above have theirs: the outcome is the same and the
 * reason is not. "The turn that asked this ended" would name a turn that never existed, and "the
 * job that asked this ended" a job that was never named.
 */
export const APPROVAL_ABANDONED_CALL_MESSAGE =
  'the call that asked this already returned, so nothing is left to receive an answer';

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
 * The readers are asked about separately, because each card has exactly one of them and the facts
 * are therefore not interchangeable. A card that names a job is read by that process, so its job's
 * liveness settles it and the turn is not consulted at all — a job may file while no turn is in
 * flight (`turn_id` null), which is the ordinary shape of a watch that decides an hour later, and
 * such a row is collected when its job goes rather than left for the turn rule that could never
 * reach it. A card that names neither is read by its own call, and is collected when that call has
 * returned (see the module note). Everything else is read by the turn it names, and is collected on
 * that turn ending; a card at the turn boundary in flight when a job filed one is the job's, not
 * the turn's.
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
  // The third reader, and the one both passes above are blind to by construction: a card raised
  // where the engine was running with no turn in flight names no opener (the turn rule declines to
  // guess, and rightly) and no job (so the job rule cannot see it). Its reader is its own call, and
  // `tool_call.finished_at` — the fact `SessionsService.stillBeingAsked` stops offering the card on
  // — is what says that call has returned. Read then written, because the pairing is a row in
  // another table: which card has a returned call is not a predicate `updateMany` can carry.
  const turnless = await tx.approval.findMany({
    where: {
      sessionId,
      status: 'PENDING',
      turnId: null,
      backgroundJobId: null,
      toolUseId: { not: null },
    },
    select: { id: true, toolUseId: true },
  });
  const paired = turnless
    .map((a) => a.toolUseId)
    .filter((id): id is string => id !== null);
  const returned =
    paired.length === 0
      ? new Set<string>()
      : new Set(
          (
            await tx.toolCall.findMany({
              where: { sessionId, toolUseId: { in: paired }, finishedAt: { not: null } },
              select: { toolUseId: true },
            })
          ).map((call) => call.toolUseId),
        );
  const collected = turnless.filter((a) => a.toolUseId !== null && returned.has(a.toolUseId));
  const lostItsCall =
    collected.length === 0
      ? { count: 0 }
      : await tx.approval.updateMany({
          where: { sessionId, status: 'PENDING', id: { in: collected.map((a) => a.id) } },
          data: { status: APPROVAL_ABANDONED_STATUS, message: APPROVAL_ABANDONED_CALL_MESSAGE },
        });
  return lostItsJob.count + lostItsTurn.count + lostItsCall.count;
}

/**
 * Collect the cards whose own call has just returned. Returns the ids collected.
 *
 * The third reader's fact, acted on where it is written rather than only where a turn ends: the
 * reaper above runs from /turn-complete and finalize, and a self-driven stretch reaches neither.
 * 2026-09-26: an `ExitPlanMode` card was raised at 15:07 in a stretch three finished sub-agents had
 * woken, its poll died on a deploy's 502 at 15:22, the engine asked again and was approved — and
 * the first row sat PENDING while the stretch went on coding, the conversation's row reading
 * "Waiting for approval" with nothing on any surface to press.
 *
 * So `RunnerApiController.events` calls this with the calls whose results it has just recorded.
 * A card that names a turn is taken too: its turn may run on for hours, but the loop that would
 * carry an answer back ran inside the call, and the listing already stopped offering the card on
 * this same fact (`SessionsService.stillBeingAsked`). A card that names a job is left to its job,
 * for the reason the module note gives. A replayed batch finds nothing PENDING left to collect.
 */
export async function reapApprovalsOfReturnedCalls(
  tx: Prisma.TransactionClient,
  sessionId: string,
  toolUseIds: readonly string[],
): Promise<string[]> {
  if (toolUseIds.length === 0) return [];
  const collected = await tx.approval.updateManyAndReturn({
    where: {
      sessionId,
      status: 'PENDING',
      backgroundJobId: null,
      toolUseId: { in: [...toolUseIds] },
    },
    data: { status: APPROVAL_ABANDONED_STATUS, message: APPROVAL_ABANDONED_CALL_MESSAGE },
    select: { id: true },
  });
  return collected.map((row) => row.id);
}

/**
 * Whether the runner-hosted job a card names is still there to read an answer.
 *
 * The read side of the rule the reaper above collects on, and the same expression on purpose: a
 * card that names a job is settled by that job alone, so it is still a question while the process
 * is up — whatever the conversation is doing, and whether or not a turn was ever in flight — and
 * it stops being one exactly where the reap would take it. `running_bg_shells` is the column that
 * means "a process is still up", the same one and for the same reason the reap reads it.
 *
 * Written here, beside the reap, because the two are one rule: an approval reader that asked the
 * question its own way is how a card stops being shown while it is still answerable, which is the
 * defect this pair exists to end.
 */
export function readByLiveBackgroundJob(
  approval: { backgroundJobId: string | null },
  runningBgShells: readonly string[],
): boolean {
  return approval.backgroundJobId !== null && runningBgShells.includes(approval.backgroundJobId);
}

/**
 * How many of a session's cards are still being asked, over the two readers above.
 *
 * The count half of that read, as one function so the surfaces that report a number cannot answer it
 * differently: a generating session holds its turn's cards and counts every pending row it has —
 * what this number has always been, and deliberately a superset, because the door re-reads the facts
 * and this is the signal — while a conversation that is NOT generating counts only the cards a
 * runner-hosted job is still reading, which it can be holding while parked. The session list
 * decides the same total per row (it has the page in hand); this is the shape for a caller that has
 * one session and asks for its number.
 *
 * The session is typed as the generating predicate's own input, so the two cannot come to different
 * verdicts about which states count (it reads the Prisma `RunStatus`, callers the shared one).
 */
export async function countLiveApprovals(
  db: Pick<PrismaClient, 'approval'>,
  session: { id: string; runningBgShells: readonly string[] } & Parameters<
    typeof isSessionGenerating
  >[0],
): Promise<number> {
  if (isSessionGenerating(session)) {
    return db.approval.count({ where: { sessionId: session.id, status: 'PENDING' } });
  }
  if (session.runningBgShells.length === 0) return 0;
  return db.approval.count({
    where: {
      sessionId: session.id,
      status: 'PENDING',
      // The predicate above as the query spells it. `in` over the session's own live set is the
      // whole rule: a card is a question while the job it named is up.
      backgroundJobId: { in: [...session.runningBgShells] },
    },
  });
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

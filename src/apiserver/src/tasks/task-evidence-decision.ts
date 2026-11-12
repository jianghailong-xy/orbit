import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { Prisma as PrismaTypes } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { criterionKeyOf } from '../projects/project-acceptance';
import { SESSION_ENDING_SELECT, sessionHasEnded } from '../projects/project-open-item';
import { assertMayEndWorkingRuns, assertSessionMayReach } from '../sessions/session-reach';
import {
  type CriterionStandingTask,
  definitionIdFromKey,
  evidenceCriterionMatch,
  heldToProjectCriterion,
  quotesDeclaredCriterion,
} from './task-evidence-envelope';
import { taskOfRunBehind } from './verifier-write-authority';

/**
 * The four checks `task_evidence_decide` makes, and the codes it makes them under.
 *
 * A decision is the third completion criterion's whole implementation, so what makes it worth
 * anything is not that somebody wrote CONFIRM — it is that the three things a reader would have to
 * verify by hand were verified AT THE MOMENT THE DECISION WAS MADE, and refused when they did not
 * hold:
 *
 *  1. **The evidence has not moved.** The answer names a revision, and that revision must still be
 *     the task's latest. This is a compare-and-set, not a label: an answer written against
 *     revision 3 while revision 4 exists is an answer to a question nobody is asking any more, and
 *     accepting it would let a run submit a weak version, collect a decision, and then submit the
 *     one it actually wanted judged.
 *  2. **The criterion has not moved.** The revision carries the task's stated criterion — the
 *     project criterion it declares, or else its own acceptance criteria — by key AND by text, as
 *     the server bound it at submit time (or, before it did, as the submitter quoted it), and the
 *     text is what is checked — bind to content, never to the identifier, exactly as
 *     `criterionRevision` already does on the evidence row. A criterion whose wording was rewritten
 *     after the evidence was submitted is a different standard under the same key, so a decision
 *     made against the old wording would be recorded as if it had been made against the new one.
 *  3. **The decider did not do the work.** Reusing the boundary that already refuses a run's own
 *     DONE (`tasks.service.ts#update`, §13.2's independence rule for verdicts): the session that
 *     produced the work does not get to settle it. The decision door is the one place that
 *     boundary GRANTS authority rather than withholding it — to a session that never touched this
 *     task — and that grant is the entire reason a CONFIRM here is a check rather than a signature
 *     on one's own homework. Nor may a session that acts for another project decide it: a task's
 *     evidence is its project's to decide, and the project it was moved out of no longer is that.
 *     Nor may a run decide evidence that is not addressed to it (`runDecisionDisqualification`):
 *     not having done the work makes a session independent, not the one to settle it.
 *  4. **A rejection says what to do next.** SEND_BACK carries a note; the task is not written to at
 *     all, so it stays OPEN and waits for the next evidence revision.
 *  5. **The decider may do this to the run.** A CONFIRM that settles the task ends the run working it,
 *     and a SEND_BACK gives the run that submitted a turn with the decider's words, so a session
 *     held back from either (sessions/session-reach.ts) is held back from it here. Asked last, of a
 *     decision about to be written (`assertDecisionMayReachRuns`).
 *
 * Every refusal carries a `requiredAction`, because a decider who is refused is holding an opinion
 * and needs to be told where to put it.
 */

export const EVIDENCE_DECISIONS = ['CONFIRM', 'SEND_BACK'] as const;
export type EvidenceDecisionValue = (typeof EVIDENCE_DECISIONS)[number];

/** The stored codes. `EVIDENCE_JUDGMENT_` is the spelling the retired wake events already use. */
export const EVIDENCE_SUPERSEDED_CODE = 'EVIDENCE_JUDGMENT_EVIDENCE_SUPERSEDED';
export const EVIDENCE_SUPERSEDED_ACTION = 'DECIDE_THE_CURRENT_EVIDENCE_REVISION';
export const CRITERION_MOVED_CODE = 'EVIDENCE_JUDGMENT_CRITERION_MOVED';
export const CRITERION_MOVED_ACTION = 'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION';
export const REQUIRES_INDEPENDENT_SESSION_CODE = 'EVIDENCE_JUDGMENT_REQUIRES_INDEPENDENT_SESSION';
export const REQUIRES_INDEPENDENT_SESSION_ACTION = 'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK';
export const TASK_IN_ANOTHER_PROJECT_CODE = 'EVIDENCE_JUDGMENT_TASK_IN_ANOTHER_PROJECT';
export const TASK_IN_ANOTHER_PROJECT_ACTION = 'DECIDE_FROM_THE_PROJECT_THE_TASK_IS_IN';
export const RUN_MAY_NOT_DECIDE_CODE = 'EVIDENCE_JUDGMENT_FROM_RUN_REFUSED';
export const RUN_MAY_NOT_DECIDE_ACTION = 'ASK_THE_COORDINATOR_OR_THE_OWNER';
export const SEND_BACK_NOTE_CODE = 'EVIDENCE_JUDGMENT_SEND_BACK_REQUIRES_NOTE';
export const SEND_BACK_NOTE_ACTION = 'SAY_WHAT_THE_NEXT_EVIDENCE_REVISION_MUST_SHOW';

/** The criterion a stored revision is held to, when it carries one: the standard the server bound
 * at submit time (`taskStandard`), or, on a revision stored before the server bound it, the
 * submitter's own quote. Both are read and compared the same way. */
export function quotedCriterion(evidence: unknown): { key: string; text: string } | null {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  const criterion = (evidence as Record<string, unknown>).criterion;
  if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) return null;
  const { key, text } = criterion as Record<string, unknown>;
  return typeof key === 'string' && typeof text === 'string' ? { key, text } : null;
}

/**
 * Check 1. The revision being answered is still the task's latest.
 *
 * `latest` is read under the Task mutex the caller already holds, which is what makes this a CAS
 * rather than a read followed by a hope: a concurrent submission has to wait for that lock, so it
 * either lands before this comparison or after the decision is committed.
 */
export function assertCurrentEvidenceRevision(answered: bigint, latest: bigint): void {
  if (answered === latest) return;
  throw new ConflictException({
    code: EVIDENCE_SUPERSEDED_CODE,
    answeredRevision: answered.toString(),
    currentRevision: latest.toString(),
    message:
      `this task's completion evidence is at revision ${latest}, and the decision answers ` +
      `revision ${answered}; nothing was written. A decision binds to one immutable version of ` +
      'the evidence, so an answer to a superseded one cannot be recorded as an answer to this one',
    requiredAction: EVIDENCE_SUPERSEDED_ACTION,
  });
}

/** Why check 2 would refuse every decision about this evidence — the door's words, not a flag. */
export interface CriterionStandingRefusal {
  /** The reason, as the refusal states it, for a reader who is not being refused anything yet. */
  reason: string;
  /** The whole sentence the door refuses with, of which `reason` is the first clause. */
  message: string;
  /** The key the evidence quoted, or null when it quoted no criterion at all. */
  criterionKey: string | null;
}

/**
 * Check 2, ASKED rather than enforced: is there a live stated standard to decide this against?
 *
 * The same two-function shape check 3 has, and for the same reason. The pending-decision read has
 * to be able to ask this question WITHOUT being refused: a queue that lists a row the door will
 * refuse whatever anybody presses is promising a decision that cannot be made, and one that
 * silently dropped the row would leave the submitter waiting on a question nobody was ever shown.
 * One predicate and two callers, so the queue cannot drift from what the door will do.
 */
export async function criterionStandingRefusal(
  tx: PrismaTypes.TransactionClient,
  task: CriterionStandingTask,
  evidence: unknown,
): Promise<CriterionStandingRefusal | null> {
  const criterion = quotedCriterion(evidence);
  if (!criterion) {
    // The server binds no standard when the task had no live one at submit time
    // (`taskStandard`), so a revision with none says that, in the words the task's state calls for.
    if (heldToProjectCriterion(task) && task.criterionDefinitionId === null) {
      return { ...movedRefusal(task, ''), criterionKey: null };
    }
    const reason =
      'this evidence quotes no project criterion, so there is no stated standard to decide it '
      + 'against';
    return { reason, message: `${reason}; nothing was written`, criterionKey: null };
  }
  const match = await evidenceCriterionMatch(tx, task, criterion);
  if (match.matchesLive) return null;
  return { ...movedRefusal(task, criterion.key), criterionKey: criterion.key };
}

/**
 * The words for a quote the live standard did not match, and the ONE thing this branches on.
 *
 * Whether a decision may be recorded was already settled above by `evidenceCriterionMatch`; this
 * only says why, and it may not reach a different answer. So it asks nothing the row did not
 * already carry, and branches on the same `heldToProjectCriterion` and `quotesDeclaredCriterion`
 * the match did: a task that declares no project criterion and has no `acceptanceCriteria` of its
 * own states no standard at all, which is a different sentence from a standard that moved and the
 * only honest one when there is nothing to have moved from. Reading that off the same row the predicate was given is what
 * keeps this a wording choice rather than a second opinion.
 */
function movedRefusal(
  task: CriterionStandingTask,
  key: string,
): { reason: string; message: string } {
  if (heldToProjectCriterion(task) && task.criterionDefinitionId === null) {
    // Declared, and the criterion is gone (`heldToProjectCriterion`): nothing moved that a new
    // quote could follow, so the way out is the declaration itself.
    const reason =
      'the project criterion this task declared has since been deleted, so there is no live '
      + 'standard to decide this evidence against';
    return {
      reason,
      message:
        `${reason}; nothing was written. Declare the criterion this task serves now (criterionKey), `
        + 'or take the declaration back (criterionKey: null) to hold it to its own '
        + 'acceptanceCriteria, then submit a revision quoting that standard',
    };
  }
  if (
    heldToProjectCriterion(task)
    && task.criterionDefinitionId !== null
    && definitionIdFromKey(key) !== null
    && !quotesDeclaredCriterion(task, key)
  ) {
    // A key that names some other row — another criterion, or no criterion at all (a task's own
    // public id decodes the same way): nothing the task declares moved, it was just not quoted.
    const reason = `the criterion this evidence quotes (${key}) is not the one this task declares `
      + `(${criterionKeyOf(task.criterionDefinitionId)})`;
    return {
      reason,
      message:
        `${reason}; nothing was written. A task that declares a project criterion is held to that `
        + 'one and to no other: submit a revision quoting it, or, if the task really serves a '
        + 'different criterion of its project, declare that one (criterionKey)',
    };
  }
  if (heldToProjectCriterion(task)) {
    // Word for word what this refusal has always said for a task held to a project criterion:
    // nothing about that path is being changed here, and its message is as much of it as its code.
    const reason =
      `the criterion this evidence quotes (${key}) is not what the project states today`;
    return {
      reason,
      message:
        `${reason}; nothing was written. The quote is bound to the criterion's CONTENT, not to `
        + 'its key, so a rewritten standard is a different standard and this evidence has not been '
        + 'measured against it',
    };
  }
  if ((task.acceptanceCriteria ?? '').trim() === '') {
    if (task.projectId) {
      const reason =
        'this task declares no live criterion of its project and states no acceptance criteria of '
        + 'its own, so there is no live standard to decide this evidence against';
      return {
        reason,
        message:
          `${reason}; nothing was written. Write what would settle this task into its `
          + 'acceptanceCriteria, or declare the project criterion it serves (criterionKey), then '
          + 'submit a revision quoting it',
      };
    }
    const reason =
      'this task is in no project and states no acceptance criteria of its own, so there is no '
      + 'live standard to decide this evidence against';
    return {
      reason,
      message:
        `${reason}; nothing was written. Write what would settle this task into its `
        + 'acceptanceCriteria, then submit a revision quoting them',
    };
  }
  const reason =
    'the acceptance criteria this evidence quotes are not what this task states today';
  return {
    reason,
    message:
      `${reason}; nothing was written. The quote is bound to the standard's CONTENT, so `
      + 'acceptance criteria rewritten after this evidence was submitted are a different standard '
      + 'and this evidence has not been measured against them',
  };
}

/**
 * Check 2. The criterion the evidence quotes still says what the evidence says it says.
 *
 * Fail-closed, and deliberately stricter than the same comparison at submission time, where a
 * stale quote is only REPORTED (`criterionMatch.matchesLive`). The two moments are not the same
 * question: submitting is a claim about work that was already done, and invalidating it because
 * the wording moved afterwards would punish the submitter for somebody else's edit — while
 * deciding is a judgment being made NOW, and a judgment made against wording that no longer exists
 * settles nothing. So evidence quoting no criterion, or quoting a key that resolves to nothing in
 * the project it names, reaches the same refusal: there is no live standard to hold this evidence
 * against. A task that declares no project criterion — in no project, or filed under one without a
 * `criterionKey` — is NOT that case: its own `acceptanceCriteria` are a live stated standard, and it
 * is refused only when the quote has moved away from them or there are none.
 */
export async function assertCriterionUnmoved(
  tx: PrismaTypes.TransactionClient,
  task: CriterionStandingTask,
  evidence: unknown,
): Promise<{ key: string; text: string }> {
  const refusal = await criterionStandingRefusal(tx, task, evidence);
  if (refusal) {
    throw new ConflictException({
      code: CRITERION_MOVED_CODE,
      ...(refusal.criterionKey === null ? {} : { criterionKey: refusal.criterionKey }),
      message: refusal.message,
      requiredAction: CRITERION_MOVED_ACTION,
    });
  }
  return quotedCriterion(evidence)!;
}

/**
 * Check 3. The deciding session never took part in this task's work.
 *
 * Two disqualifications, and they are separate on purpose. A session of this task is disqualified
 * whatever it did — that is the self-DONE boundary, unchanged. A session that submitted evidence
 * here is disqualified even if it belongs elsewhere, because the submitter is the one actor whose
 * judgment of the submission is definitionally its own. Today submitting requires a session of the
 * task, so the second is implied by the first; it is asked anyway, so the grant does not silently
 * widen the day that stops being true.
 *
 * The question and the refusal are two functions because the pending-decision read has to ask it
 * WITHOUT refusing: a row that says "you may not answer this one, and here is why" tells a reader
 * something, where hiding it or throwing at render time tells them nothing. One predicate and two
 * callers, so the door cannot drift from what the rail promised.
 */
export async function decidingSessionDisqualification(
  tx: PrismaTypes.TransactionClient,
  scope: { ownerId: string; taskId: string },
  session: { id: string; taskId: string | null },
): Promise<string | null> {
  if (session.taskId === scope.taskId) return 'this session is a run of the task it is deciding';
  const submitted = await tx.taskCompletionEvidence.findFirst({
    where: { taskId: scope.taskId, ownerId: scope.ownerId, sourceSessionId: session.id },
    select: { id: true },
  });
  return submitted ? 'this session submitted completion evidence for this task' : null;
}

export async function assertIndependentDecidingSession(
  tx: PrismaTypes.TransactionClient,
  scope: { ownerId: string; taskId: string },
  session: { id: string; taskId: string | null },
): Promise<void> {
  const why = await decidingSessionDisqualification(tx, scope, session);
  if (!why) return;
  throw new ForbiddenException({
    code: REQUIRES_INDEPENDENT_SESSION_CODE,
    message:
      `${why}; nothing was written. A decision about completion evidence is only worth ` +
      'recording when it comes from a run that did not produce the work, which is the whole ' +
      'reason this criterion is a check rather than a self-report',
    requiredAction: REQUIRES_INDEPENDENT_SESSION_ACTION,
  });
}

/**
 * The project a deciding session acts for, read the way a write's scope is
 * (`TasksService.deriveProjectScope`): the project it coordinates, the one a judgment session was
 * opened for, or else the project of the task it runs. Null for a session that acts for none.
 */
export async function decidingSessionProject(
  tx: PrismaTypes.TransactionClient,
  ownerId: string,
  sessionId: string,
): Promise<string | null> {
  const session = await tx.session.findFirst({
    where: { id: sessionId, ownerId },
    select: {
      coordinatorForProject: { select: { id: true } },
      coordinatorWakes: { where: { status: 'SESSION_OPENED' }, select: { projectId: true }, take: 1 },
      task: { select: { projectId: true } },
    },
  });
  // `?.` on the list as well, as `deriveProjectScope` has it: a hand-built double of the row omits it.
  return session?.coordinatorForProject?.id
    ?? session?.coordinatorWakes?.[0]?.projectId
    ?? session?.task?.projectId
    ?? null;
}

/**
 * Check 3's other half: a session that acts for one project does not decide the evidence of a task
 * filed under another. Asked against the project the task is in NOW, because a task can leave one:
 * a confirmed MOVE_TASK takes its undecided evidence with it, to be decided by the project it
 * moved into (decision of 2026-10-06), so the project it left — its coordinator, its judgment
 * sessions, its other runs — can no longer settle it, whatever it was told before the move. A
 * session that acts for no project, and a task in none, are not this check's to refuse.
 *
 * The same two-function shape as independence, for the same reason: the pending read asks it of
 * every row without being refused (`readPendingEvidenceJudgments`).
 */
export function taskProjectDisqualification(
  taskProjectId: string | null,
  sessionProjectId: string | null,
): string | null {
  if (taskProjectId === null || sessionProjectId === null || sessionProjectId === taskProjectId) {
    return null;
  }
  return `this session acts for project ${uuidToBase62(sessionProjectId)}, and this task is in `
    + `project ${uuidToBase62(taskProjectId)}`;
}

export async function assertDecidingSessionInTaskProject(
  tx: PrismaTypes.TransactionClient,
  scope: { ownerId: string; projectId: string | null },
  session: { id: string },
): Promise<void> {
  if (scope.projectId === null) return;
  const why = taskProjectDisqualification(
    scope.projectId,
    await decidingSessionProject(tx, scope.ownerId, session.id),
  );
  if (!why) return;
  throw new ForbiddenException({
    code: TASK_IN_ANOTHER_PROJECT_CODE,
    message:
      `${why}; nothing was written. A task's evidence is decided from the project it is in — by `
      + 'that project\'s coordinator, or by the account owner on the card drawn there — and a task '
      + 'moved to another project takes its undecided evidence with it',
    requiredAction: TASK_IN_ANOTHER_PROJECT_ACTION,
  });
}

/**
 * Check 3's third half: a run answers for its own task, and another task's evidence is addressed to it only by name.
 *
 * Without this the door took an answer from any run that did not do the work, and a CONFIRM is what settles the task, so
 * one run could settle a sibling and with it a criterion of the project. So a run (`taskOfRunBehind`) decides only what
 * `sessionJudgesEvidence` addresses to it: the subject of the task it verifies, and a task in no project that it dispatched.
 * Everybody else the door takes as it did: the project's coordinator and judgment sessions are no run, and neither is a
 * conversation nobody's run opened. The account owner pressing a card in the app is not asked this at all, whichever session
 * the press names: the owner decides there, not that session.
 *
 * A conversation a run opened answers as that run, so it is refused the run's own task here, where independence has nothing
 * to say about it: the check there reads the session's own task, and this conversation has none.
 *
 * The same two-function shape as independence, for the same reason: the pending read asks it without being refused.
 */
export async function runDecisionDisqualification(
  tx: PrismaTypes.TransactionClient,
  scope: { ownerId: string; taskId: string },
  session: { id: string; taskId: string | null },
): Promise<string | null> {
  const runs = await taskOfRunBehind(tx, scope.ownerId, session.id);
  if (runs === null) return null;
  if (runs === scope.taskId) {
    return session.taskId === scope.taskId
      ? 'this session is a run of the task it is deciding'
      : 'this session was opened by a run of the task it is deciding, and answers as that run';
  }
  if (await sessionJudgesEvidence(tx, scope, session)) return null;
  return session.taskId === null
    ? 'this session was opened by a run of another task, and answers as that run'
    : 'this session is a run of another task';
}

export async function assertRunMayDecide(
  tx: PrismaTypes.TransactionClient,
  scope: { ownerId: string; taskId: string },
  session: { id: string; taskId: string | null },
): Promise<void> {
  const why = await runDecisionDisqualification(tx, scope, session);
  if (!why) return;
  throw new ForbiddenException({
    code: RUN_MAY_NOT_DECIDE_CODE,
    kind: 'REFUSAL',
    message:
      `${why}; nothing was written. A task's evidence is decided by the project's coordinator or a judgment session opened `
      + 'for the project, by the session that dispatched a task in no project, by a run of a task that verifies this one, '
      + 'or by the account owner in the app. Ask one of them',
    requiredAction: RUN_MAY_NOT_DECIDE_ACTION,
  });
}

/**
 * Whether this task's evidence is this session's to judge, which is what lets it read the files that evidence cites
 * (docs/orbit-files-design.md §2.7), and what lets a run decide it (`runDecisionDisqualification`).
 *
 * For a session that is no run, narrower than the door, on purpose. The door asks who may not answer and takes an answer
 * from everybody else, which is the right question for an answer: it is recorded under a name and anyone can read why. Asked
 * of bytes it would hand every cited file to every unrelated session of the account. So this asks who the evidence is
 * addressed to, and the door's independence check still comes first: the session that did the work judges nothing. Four
 * readers:
 *
 *  - the conversation the task's project is coordinated from now, which is delivered each revision to decide;
 *  - a judgment session opened for that project (`decidingSessionProject` reads them as acting for it);
 *  - for a task in no project, the session that dispatched it (`evidence-review.ts`);
 *  - a run of a task that verifies this one (`verifiesTaskId`), which used to read the evidence out of the repository.
 *
 * All asked of the task as it stands, so a replaced coordinator, or the project a task was moved out of, reads nothing.
 */
export async function sessionJudgesEvidence(
  tx: PrismaTypes.TransactionClient,
  scope: { ownerId: string; taskId: string },
  session: { id: string; taskId: string | null },
): Promise<boolean> {
  if ((await decidingSessionDisqualification(tx, scope, session)) !== null) return false;
  const task = await tx.task.findFirst({
    where: { id: scope.taskId, ownerId: scope.ownerId },
    select: { projectId: true, creatorSessionId: true, project: { select: { coordinatorSessionId: true } } },
  });
  if (!task) return false;
  if (session.taskId !== null) {
    const verifies = await tx.task.count({
      where: { id: session.taskId, ownerId: scope.ownerId, verifiesTaskId: scope.taskId },
    });
    if (verifies > 0) return true;
  }
  if (task.projectId === null) return task.creatorSessionId === session.id;
  if (task.project?.coordinatorSessionId === session.id) return true;
  const judgments = await tx.projectCoordinatorWake.count({
    where: { projectId: task.projectId, sessionId: session.id, status: 'SESSION_OPENED' },
  });
  return judgments > 0;
}

/**
 * Check 5. What this decision is about to do to a run is held to what the deciding session may do to that run.
 *
 * A CONFIRM asks only when it settles the task, and of the runs working it now, whichever of them submitted. A SEND_BACK
 * asks of the session that submitted, and only when it would give that session a turn: `deliverSendBack` never brings back a
 * session that has ended, so the note then stays on the revision and nothing reaches anybody. The account owner's press in the
 * app is not asked: the caller does not call this for one.
 */
export async function assertDecisionMayReachRuns(
  tx: PrismaTypes.TransactionClient,
  scope: { ownerId: string; taskId: string },
  decidingSessionId: string,
  answer: { decision: EvidenceDecisionValue; settlesTheTask: boolean; submittedBy: string },
): Promise<void> {
  if (answer.decision === 'CONFIRM') {
    if (answer.settlesTheTask) {
      await assertMayEndWorkingRuns(tx, scope.ownerId, decidingSessionId, scope.taskId, 'confirmEvidence');
    }
    return;
  }
  const run = await tx.session.findFirst({
    where: { id: answer.submittedBy, ownerId: scope.ownerId },
    select: SESSION_ENDING_SELECT,
  });
  if (run && !sessionHasEnded(run) && run.cancelRequestedAt === null) {
    await assertSessionMayReach(tx, scope.ownerId, decidingSessionId, answer.submittedBy, 'sendBackEvidence');
  }
}

/** Check 4's other half: a rejection nobody can act on leaves the next revision nothing to aim at. */
export function decisionNote(
  decision: EvidenceDecisionValue,
  note: string | undefined,
): string | null {
  const written = note?.trim().normalize('NFC');
  if (note !== undefined && (!written || written.length > 4_000)) {
    throw new BadRequestException('note must contain 1 to 4000 characters');
  }
  if (decision !== 'SEND_BACK') return written ?? null;
  if (written) return written;
  throw new BadRequestException({
    code: SEND_BACK_NOTE_CODE,
    message:
      'SEND_BACK needs a note saying what the next evidence revision has to show; nothing was ' +
      'written. The task is left OPEN and nothing else changes, so the note is the only thing ' +
      'the next revision has to aim at',
    requiredAction: SEND_BACK_NOTE_ACTION,
  });
}

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { Prisma as PrismaTypes } from '@prisma/client';
import { evidenceCriterionMatch } from './task-evidence-envelope';

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
 *  2. **The criterion has not moved.** The envelope quotes a project criterion by key AND by text,
 *     and the text is what is checked — bind to content, never to the identifier, exactly as
 *     `criterionRevision` already does on the evidence row. A criterion whose wording was rewritten
 *     after the evidence was submitted is a different standard under the same key, so a decision
 *     made against the old wording would be recorded as if it had been made against the new one.
 *  3. **The decider did not do the work.** Reusing the boundary that already refuses a run's own
 *     DONE (`tasks.service.ts#update`, §13.2's independence rule for verdicts): the session that
 *     produced the work does not get to settle it. The decision door is the one place that
 *     boundary GRANTS authority rather than withholding it — to a session that never touched this
 *     task — and that grant is the entire reason a CONFIRM here is a check rather than a signature
 *     on one's own homework.
 *  4. **A rejection says what to do next.** SEND_BACK carries a note; the task is not written to at
 *     all, so it stays OPEN and waits for the next evidence revision.
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
export const SEND_BACK_NOTE_CODE = 'EVIDENCE_JUDGMENT_SEND_BACK_REQUIRES_NOTE';
export const SEND_BACK_NOTE_ACTION = 'SAY_WHAT_THE_NEXT_EVIDENCE_REVISION_MUST_SHOW';

/** The quoted criterion, when the stored evidence is the four-field envelope. */
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

/**
 * Check 2. The criterion the evidence quotes still says what the evidence says it says.
 *
 * Fail-closed, and deliberately stricter than the same comparison at submission time, where a
 * stale quote is only REPORTED (`criterionMatch.matchesLive`). The two moments are not the same
 * question: submitting is a claim about work that was already done, and invalidating it because
 * the wording moved afterwards would punish the submitter for somebody else's edit — while
 * deciding is a judgment being made NOW, and a judgment made against wording that no longer exists
 * settles nothing. So evidence quoting no criterion, quoting a key that resolves to nothing, or
 * sitting on a task with no project all reach the same refusal: there is no live standard to hold
 * this evidence against.
 */
export async function assertCriterionUnmoved(
  tx: PrismaTypes.TransactionClient,
  projectId: string | null,
  evidence: unknown,
): Promise<{ key: string; text: string }> {
  const criterion = quotedCriterion(evidence);
  if (!criterion) {
    throw new ConflictException({
      code: CRITERION_MOVED_CODE,
      message:
        'this evidence quotes no project criterion, so there is no stated standard to decide it ' +
        'against; nothing was written',
      requiredAction: CRITERION_MOVED_ACTION,
    });
  }
  const match = await evidenceCriterionMatch(tx, projectId, criterion);
  if (!match.matchesLive) {
    throw new ConflictException({
      code: CRITERION_MOVED_CODE,
      criterionKey: criterion.key,
      message:
        `the criterion this evidence quotes (${criterion.key}) is not what the project states ` +
        'today; nothing was written. The quote is bound to the criterion\'s CONTENT, not to its ' +
        'key, so a rewritten standard is a different standard and this evidence has not been ' +
        'measured against it',
      requiredAction: CRITERION_MOVED_ACTION,
    });
  }
  return criterion;
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

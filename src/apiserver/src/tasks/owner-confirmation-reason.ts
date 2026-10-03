import type { TaskCompletionCriterionValue } from './task-completion-criterion';

/**
 * Outside an Automatic project, an agent that hands a task to the account owner says why only the
 * owner can settle it (the B line of project 34Z2usxH1u0wBMagUPqlM, rules of 2026-10-03).
 *
 * WHY
 * ---
 * OWNER_CONFIRMED is settled by the account owner pressing Confirm done in the app and by nobody
 * else. The quantified report behind this rule (task 34Z35uEB5SDTmJPgU1Hw5): every one of the 77
 * tasks the owner was asked to confirm in the 30 days before 2026-10-03 had been filed by an agent,
 * and of 30 sampled outside any project, two needed the owner at all. The rest were work a test, a
 * CI run or a reviewer could settle — and since the same day such work can be settled outside a
 * project by the session that dispatched it (EVIDENCE_JUDGMENT, `evidence-review.ts`).
 *
 * So the declaration now carries its reason, one of four, which the owner chose as the whole of
 * what is theirs alone:
 *
 *   DEPLOY                   a release, a deploy, shipping a build, a change to a live database;
 *   IRREVERSIBLE             a step that cannot be undone — a DROP, deleting data;
 *   OWNER_DEVICE_OR_ACCOUNT  the owner's own device, account or keys;
 *   OWNER_TRADE_OFF          a trade-off only the owner can make.
 *
 * One sentence may go with it. Both are stored on the task (migration 0373) and `task_get` reads
 * them back; no gate reads them after the write.
 *
 * WHO IT BINDS, AND WHEN
 * ----------------------
 * Exactly whom `owner-confirmed-automatic-delegation.ts` binds — a write carrying an acting session
 * (`X-Orbit-Session-Id`) — and exactly when: a create or a batch item always, an update only when it
 * moves the criterion, the project or the criterion the task serves. It is asked of the task as the
 * write LEAVES it, and only where that rule is not: a task in no project, or in a project whose
 * Automatic is off. An Automatic project keeps the 09-29 rule, which asks the project's criterion
 * rather than the agent.
 *
 * A write without a reason is refused whole with 409: nothing is written, and in a batch no item is.
 * The refusal names EVIDENCE_JUDGMENT as the way forward, because that is where the work this rule
 * turns back belongs.
 */

export const OWNER_CONFIRMATION_REASONS = [
  'DEPLOY',
  'IRREVERSIBLE',
  'OWNER_DEVICE_OR_ACCOUNT',
  'OWNER_TRADE_OFF',
] as const;

export type OwnerConfirmationReasonValue = (typeof OWNER_CONFIRMATION_REASONS)[number];

/** The sentence that may go with a reason: what is at stake, not an essay. */
export const MAX_OWNER_CONFIRMATION_REASON_NOTE_CHARS = 500;

export const OWNER_CONFIRMATION_REASON_FIELD = 'ownerConfirmationReason' as const;
export const OWNER_CONFIRMATION_REASON_NOTE_FIELD = 'ownerConfirmationReasonNote' as const;

export const OWNER_CONFIRMATION_REASON_REQUIRED_CODE = 'OWNER_CONFIRMATION_REASON_REQUIRED';
export const OWNER_CONFIRMATION_REASON_REQUIRED_ACTION =
  'DECLARE_EVIDENCE_JUDGMENT_THE_DISPATCHING_SESSION_SETTLES';

/** What each reason covers, in the words the refusal and the tool descriptions use. */
const REASON_WORDS: Record<OwnerConfirmationReasonValue, string> = {
  DEPLOY: 'a release, a deploy, shipping a build, or a change to a live database',
  IRREVERSIBLE: 'a step that cannot be undone, such as a DROP or deleting data',
  OWNER_DEVICE_OR_ACCOUNT: 'the owner’s own device, account or keys',
  OWNER_TRADE_OFF: 'a trade-off only the owner can make',
};

/** The four reasons as one clause: `DEPLOY (…), IRREVERSIBLE (…), …`. */
export function ownerConfirmationReasonsInWords(): string {
  return OWNER_CONFIRMATION_REASONS.map((reason) => `${reason} (${REASON_WORDS[reason]})`).join(', ');
}

/** Trim the sentence once, at the write boundary; blank is no sentence. */
export function normaliseOwnerConfirmationReasonNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * Why this reason and sentence cannot stand on a task as the write leaves it, or null.
 *
 * A reason explains OWNER_CONFIRMED and nothing else, so one sent with another criterion is a
 * request that has not decided what it is declaring; and a sentence is the reason's, never on its
 * own. Both are 400s: the request is malformed, whoever sends it.
 */
export function ownerConfirmationReasonShapeError(declaration: {
  completionCriterion: TaskCompletionCriterionValue;
  reason: OwnerConfirmationReasonValue | null;
  note: string | null;
}): string | null {
  if (declaration.completionCriterion !== 'OWNER_CONFIRMED' && declaration.reason !== null) {
    return `${OWNER_CONFIRMATION_REASON_FIELD} explains an OWNER_CONFIRMED declaration, and this task `
      + `would be ${declaration.completionCriterion}; drop it, or declare OWNER_CONFIRMED`;
  }
  if (declaration.note !== null && declaration.reason === null) {
    return `${OWNER_CONFIRMATION_REASON_NOTE_FIELD} is the sentence that goes with `
      + `${OWNER_CONFIRMATION_REASON_FIELD}, and there is no reason for it to go with`;
  }
  if ((declaration.note?.length ?? 0) > MAX_OWNER_CONFIRMATION_REASON_NOTE_CHARS) {
    return `${OWNER_CONFIRMATION_REASON_NOTE_FIELD} must contain at most `
      + `${MAX_OWNER_CONFIRMATION_REASON_NOTE_CHARS} characters`;
  }
  return null;
}

/**
 * The refusal, in the shape the task doors beside it answer with (`code`, `kind`, `requiredAction`,
 * `itemIndex`, `message`), plus what a client needs to act on it without parsing the sentence: the
 * criterion it is pointed at and the field that would let the declaration through.
 *
 * `inProject` is whether the task lands in a project — one whose Automatic is off, since an
 * Automatic project never reaches this refusal. It changes one sentence: outside a project the
 * dispatching session is handed the run's evidence to decide, inside one the project's card is
 * where the evidence waits.
 */
export function ownerConfirmationReasonRequiredBody(itemIndex: number | null, inProject: boolean) {
  const settled = inProject
    ? 'declare EVIDENCE_JUDGMENT, and its run submits evidence quoting the project criterion it '
      + 'serves. This project’s Automatic is off, so that evidence waits on the owner’s card in the '
      + 'project’s conversation, and the session that dispatched the work — or any session that did '
      + 'not do it — can settle it first with task_evidence_decide.'
    : 'declare EVIDENCE_JUDGMENT, state in acceptanceCriteria what would settle it, and its run '
      + 'submits evidence quoting them. Outside a project that evidence is delivered to the session '
      + 'that dispatched the work — this one — to decide with task_evidence_decide, and the owner is '
      + 'asked only if it has not decided within 30 minutes or has ended.';
  return {
    code: OWNER_CONFIRMATION_REASON_REQUIRED_CODE,
    kind: 'REFUSAL',
    requiredAction: OWNER_CONFIRMATION_REASON_REQUIRED_ACTION,
    itemIndex,
    suggestedCriterion: 'EVIDENCE_JUDGMENT',
    reasonField: OWNER_CONFIRMATION_REASON_FIELD,
    reasons: [...OWNER_CONFIRMATION_REASONS],
    message:
      'Only the account owner can settle an OWNER_CONFIRMED task, so a session declares it only '
      + 'for a result that is the owner’s alone, and names which in '
      + `${OWNER_CONFIRMATION_REASON_FIELD}: ${ownerConfirmationReasonsInWords()}, optionally with `
      + `one sentence in ${OWNER_CONFIRMATION_REASON_NOTE_FIELD}. This declaration names none, so `
      + `nothing was written${itemIndex === null ? '' : ' — no item of this batch was'}. Work that a `
      + 'test, a CI run or a spec shows, or that a reviewer can judge, is settled by the session '
      + `that dispatches it: ${settled}`,
  } as const;
}

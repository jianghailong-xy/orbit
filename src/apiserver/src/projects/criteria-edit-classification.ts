/**
 * Which way does an edit to a project's acceptance criteria move the ruler?
 *
 * The invariant this serves is "the ruler may only walk toward strictness on its own": a tightening
 * edit takes effect where it is made, a loosening edit does not take effect at all and becomes a
 * proposal the account owner decides. This module answers only the first half of that sentence —
 * WHICH of the two an edit is — as a function of two lists of criteria and nothing else. It reads
 * no database, constructs no Nest provider, and is deliberately callable from a test with two
 * object literals. Routing the answer is the write path's business, not this one's.
 *
 * ONLY TWO ANSWERS, AND WHAT THEY MEAN
 * ------------------------------------
 * `ADDITIVE` means THIS EDIT MAY TAKE EFFECT IMMEDIATELY. It does not mean something was added:
 * a pure reorder adds nothing and is `ADDITIVE`, because reordering does not make the ruler any
 * kinder and a gate in front of it would only teach people that the gate is noise.
 *
 * `WEAKENING` means THIS EDIT MUST NOT TAKE EFFECT ON ITS OWN. It covers both edits that are
 * demonstrably looser and edits whose direction cannot be decided by machine — rewording a
 * criterion's `text`, or rewriting its `verificationMethod` as prose. There is no third value on
 * purpose. An `UNDECIDABLE` would have to be routed somewhere, every caller would have to choose
 * where, and the first caller to route it to "apply" would have re-opened the hole this exists to
 * close. Undecidable collapses INTO the safe side here, once, rather than at each call site.
 *
 * WHAT COUNTS AS A LOOSENING, IN THE ORDER THE RULES WERE STATED
 * -------------------------------------------------------------
 *  - a criterion is dropped from the set;
 *  - the verification predicate steps DOWN the HUMAN → VERIFICATION → EXECUTABLE ladder;
 *  - the set of accepted exit codes grows, or changes to a set that is not contained in the old
 *    one (accepting exit 1 where only 0 was accepted is not a tightening, whichever way it reads);
 *  - `evidenceTaskId` is repointed at all — a criterion answered by different work is a different
 *    criterion, and no direction can be read off the swap;
 *  - `text` changes, or `verificationMethod` changes in any way that is not a step UP the ladder.
 *
 * Additions and reorderings contribute nothing: they cannot loosen anything. So one loosening
 * signal anywhere in the edit decides the whole edit, which is what makes an edit that adds one
 * criterion and deletes another come out `WEAKENING` — the addition does not pay for the deletion.
 *
 * A NOTE ON THE FIELDS, BECAUSE THREE OF THEM ARE NOT ON TODAY'S CRITERION
 * -----------------------------------------------------------------------
 * A project criterion as `CreateProjectAcceptanceCriterionDto` accepts it today carries `text` and
 * `verificationMethod` and nothing else that bears on strictness: migration 0233 removed
 * `completionCriterion`, `acceptanceCommand`, `acceptanceExpectedExitCode` and `evidenceTaskId`
 * from that shape, and `dto.ts` now REFUSES all four rather than ignoring them. The rules above
 * name two of the removed fields anyway, so they are modelled here as optional and they simply do
 * not fire for an edit that cannot carry them. What that leaves on today's data is the safe half:
 * `verificationMethod` is required free prose, every rewrite of it is undecidable, and every
 * undecidable edit is `WEAKENING`.
 *
 * The ladder therefore lives ON `verificationMethod` rather than in a field of its own — the same
 * field is either one of the three rungs or it is prose, and prose on either side of an edit is
 * what "the direction cannot be decided" looks like. Inventing a second field for the rungs would
 * have meant inventing a column nothing writes.
 */

/** What the caller may do with an edit: apply it, or hold it for a decision. */
export type CriteriaEditDirection = 'ADDITIVE' | 'WEAKENING';

/**
 * One criterion, as an edit states it.
 *
 * `id` is the identity and position is not: the write path derives `ordinal` from array index, so
 * the same criterion at a different index is the same criterion. An item with no `id` is one being
 * added. An item in `current` with no `id` cannot be matched by anything and so reads as removed,
 * which is the safe side of a shape that is not supposed to occur — stored criteria all have one.
 */
export interface CriteriaEditItem {
  readonly id?: string;
  readonly text: string;
  /** One of the three rungs, or the free prose a stored criterion actually holds. */
  readonly verificationMethod: string;
  /**
   * The exit codes that would be accepted. Absent or `null` is the UNIVERSAL set — nothing is
   * ruled out — so naming codes where none were named narrows what passes, and dropping the field
   * widens it back to everything.
   */
  readonly acceptanceExpectedExitCode?: readonly number[] | null;
  /** The work whose output answers this criterion. */
  readonly evidenceTaskId?: string | null;
}

/** Weakest to strictest. A step toward the end of this list is the only automatic tightening. */
const VERIFICATION_METHOD_RUNGS: readonly string[] = ['HUMAN', 'VERIFICATION', 'EXECUTABLE'];

/** Whether `after` accepts anything `before` did not — widened, or simply incomparable. */
function acceptedExitCodesWiden(
  before: readonly number[] | null | undefined,
  after: readonly number[] | null | undefined,
): boolean {
  if (after == null) return before != null;
  if (before == null) return false;
  const accepted = new Set(before);
  return after.some((code) => !accepted.has(code));
}

/** Whether the predicate moved anywhere other than UP the ladder. */
function verificationMethodWeakens(before: string, after: string): boolean {
  if (before === after) return false;
  const from = VERIFICATION_METHOD_RUNGS.indexOf(before);
  const to = VERIFICATION_METHOD_RUNGS.indexOf(after);
  if (from >= 0 && to >= 0) return to < from;
  return true;
}

/** Whether this criterion, kept across the edit, got any easier to satisfy. */
function retainedCriterionWeakens(before: CriteriaEditItem, after: CriteriaEditItem): boolean {
  return (before.evidenceTaskId ?? null) !== (after.evidenceTaskId ?? null)
    || acceptedExitCodesWiden(before.acceptanceExpectedExitCode, after.acceptanceExpectedExitCode)
    || verificationMethodWeakens(before.verificationMethod, after.verificationMethod)
    || before.text !== after.text;
}

/**
 * Classify a proposed replacement of a project's acceptance criteria against the ones on record.
 *
 * `current` is the set as stored; `next` is the set the edit asks for. The answer is `WEAKENING`
 * if any single criterion was dropped or loosened, and `ADDITIVE` otherwise.
 */
export function classifyCriteriaEdit(
  current: readonly CriteriaEditItem[],
  next: readonly CriteriaEditItem[],
): CriteriaEditDirection {
  const proposed = new Map<string, CriteriaEditItem>();
  for (const item of next) {
    if (item.id !== undefined) proposed.set(item.id, item);
  }
  const weakened = current.some((before) => {
    const after = before.id === undefined ? undefined : proposed.get(before.id);
    return after === undefined || retainedCriterionWeakens(before, after);
  });
  return weakened ? 'WEAKENING' : 'ADDITIVE';
}

/**
 * The four readings of a finished delivery that a machine must not settle, and the one blocker
 * each of them raises.
 *
 * §0 — THE OTHER HALF OF THE SAME NIGHT
 * =====================================
 * `mechanical-disposition.ts` is the half of 2026-09-05/06 that took no judgement: four readings
 * of a round that produced the same four answers every time. This is the other half. The same
 * person, pushing the same eight tasks through, stopped four times — and every stop was the same
 * kind of stop, which is why they are one table and not four accidents:
 *
 *   | what the delivery did                             | what they had to do              |
 *   |---------------------------------------------------|----------------------------------|
 *   | argued that a criterion did not apply to it       | read the argument and decide     |
 *   | changed files nobody asked it to change           | look at them and approve, or not |
 *   | could only pass if the stated standard moved      | move the standard, or refuse to  |
 *   | produced a branch git would not merge             | resolve it by hand               |
 *
 * The line between the two tables is not difficulty. It is what the input IS. A round's exit code,
 * the rounds running beside it and what `main` says are all facts about the world, and a fold over
 * facts can be replayed and argued with. These four are facts about the world too — every one of
 * them is a row, and §2 says which — but what they are facts ABOUT is the ruler and the request:
 * whether an exemption is fair, whether an unasked-for change is welcome, whether the exam should
 * have said something else. Nobody can compute those, and a coordinator that decided them anyway
 * would be deciding what it is judged by.
 *
 * §1 — SO THIS FOLD DETECTS, AND NEVER EVALUATES
 * ==============================================
 * Each row below answers one question, and it is always the same question: has this happened? Not
 * "is the argument good", not "are the extra files harmless", not "should the standard have said
 * that". The blocker carries the observation to a person and stops; nothing here weighs it.
 *
 * That is also why every kind below is one the vocabulary already had. `project_blocker.kind` is a
 * ROUTING word — it answers "who fixes this and what does the UI offer them" — and these four
 * route to four answers that already exist. A fifth spelling would be a fifth thing to learn for a
 * question already answered, and would have to be added to a CHECK constraint and to the censuses
 * that keep the constraint and the code agreeing.
 *
 * §2 — WHY EACH ROW IS A ROW AND NOT A FLAG
 * =========================================
 * Nothing here may be handed in, for the same reason `mechanical-disposition.ts` states: a
 * decision about the world that can be told what the world is has stopped being about the world.
 * `wake-disposition.service.ts` reads all five observations and folds them here.
 *
 *   * `criterionExemptionArgued` — the task's `completion_criterion_override_reason`, which is
 *     prose somebody wrote to say that Orbit's own objection to the shape of the acceptance prose
 *     does not apply to this work. The column's contract already says the text is audit evidence
 *     and is "never interpreted as completion evidence"; leaning on it to merge would be
 *     interpreting it.
 *   * `statedCriterionMoved` — the criterion's `revision` today against the snapshot the task was
 *     filed with. A stale snapshot means the exam moved after the work was declared against it,
 *     and `coordinator-authority.ts` puts EDIT_ACCEPTANCE_CRITERIA in HUMAN_ONLY: the only
 *     principal allowed to move that ruler is the only one who can say what moving it meant.
 *   * `changedPaths` — the worktree diff the runner computed against the session's own base and
 *     reported at the turn boundary. It is the delivery, not a description of it.
 *   * `declaredPaths` — what the task's own declaration named, extracted by `declaredPaths` below.
 *   * `conflictedPaths` — the paths a recorded merge receipt says git refused. A conflict is
 *     observed by whoever attempted the merge and written down; it is not re-derived here.
 *
 * §3 — WHY "NOTHING TO SAY" IS NOT "NOTHING WRONG"
 * ================================================
 * `null` means this fold recognised nothing, exactly as its sibling's `null` does. It is not a
 * clearance. The delivery in §4's control returns `null` because all five observations came back
 * ordinary, and what happens to it next is the other table's answer.
 */

/** Which of the four this is. The reason a person is being asked, in one word. */
export const BLOCKER_REASONS = [
  /** The work argues in writing that a criterion does not apply to it. */
  'CRITERION_EXEMPTION_ARGUED',
  /** The exam moved after this work was declared against it. */
  'ACCEPTANCE_STANDARD_MOVED',
  /** The delivery changed files its own declaration never named. */
  'OUTSIDE_DECLARED_SCOPE',
  /** Git refused to merge the branch. */
  'MERGE_REFUSED_BY_GIT',
] as const;

export type BlockerReason = (typeof BLOCKER_REASONS)[number];

/**
 * The four routing words, all of them already in `project_blocker_kind_chk`.
 *
 * They are four DIFFERENT words because they send the reader to four different places: an argument
 * to weigh, an unasked-for change to approve, a standard only its owner may edit, and a tree only
 * a person with the tree can untangle.
 */
export const BLOCKER_KIND_FOR: Readonly<Record<BlockerReason, string>> = {
  // The existing kind for "work reached a state only a person can decide about", already carried
  // by the missing-judgment-path signal for exactly that reason.
  CRITERION_EXEMPTION_ARGUED: 'HUMAN_DECISION_REQUIRED',
  // Policy, not opinion: a table in `coordinator-authority.ts` says who may edit the exam, and the
  // answer is not the coordinator. The hold belongs to the rule, so it is named after the rule.
  ACCEPTANCE_STANDARD_MOVED: 'POLICY_MANUAL_HOLD',
  // There is something concrete to say yes or no to — the extra files — so this is the kind that
  // means a person's approval is what unblocks it.
  OUTSIDE_DECLARED_SCOPE: 'AWAITING_USER_APPROVAL',
  // The kind that has always meant this.
  MERGE_REFUSED_BY_GIT: 'MERGE_CONFLICT',
};

/** Everything the fold may look at. Every field is an observation; none is a setting. */
export interface DeliveryObservations {
  /** Whether the work carries written prose arguing a criterion does not apply to it. */
  criterionExemptionArgued: boolean;
  /** Whether the stated criterion's wording moved after this work was declared against it. */
  statedCriterionMoved: boolean;
  /** Every path this delivery changed, as the runner computed it. */
  changedPaths: readonly string[];
  /** Every path the task's own declaration named. Empty means the declaration named none. */
  declaredPaths: readonly string[];
  /** The paths a recorded receipt says git refused to merge. */
  conflictedPaths: readonly string[];
}

/** What the fold recognised, and what it is about. */
export interface BlockerDisposition {
  reason: BlockerReason;
  kind: string;
  /**
   * The paths this is about, for the two rows that are about paths. Carried so the blocker can
   * show a person WHICH files rather than only that some existed.
   */
  paths: readonly string[];
}

/**
 * A token in a declaration that is shaped like a path in this repository.
 *
 * A path is a token with a separator in it: `src/apiserver/src/projects/foo.ts` names a file and
 * `src/apiserver/src/projects/` names everything under it, while a bare `foo.ts` names a file
 * somewhere and is deliberately NOT read as a declaration — a declaration that means to authorize
 * a file says where it is. Trailing `:117` line references fall away because `:` is not part of a
 * segment, and so does the surrounding backtick, comma or full stop.
 */
const PATH_TOKEN = /(?<![\w./-])(?:[\w.-]+\/)+[\w.-]*/g;

/**
 * The paths a task's own declaration names.
 *
 * WHERE A DECLARED SCOPE COMES FROM
 * =================================
 * From the declaration, because that is the only place a task says what it is about. A task's
 * title, its description and its acceptance criteria are the three fields that state the request,
 * and this reads all three: a file named only in the acceptance criteria is as much a part of what
 * was asked for as one named in the body.
 *
 * It is an extraction and not a schema, which is a deliberate trade. A column would be exact and
 * would also be a second thing every caller has to fill in correctly for this check to mean
 * anything — and a scope column nobody filled in would read as "nothing was authorized" for every
 * task that ever existed. Reading the request itself has the opposite failure: a declaration that
 * names no path declares no scope, and §4 answers `null` for it rather than accusing it. The
 * check applies exactly to the work whose request said where to work.
 *
 * Over-permissive in one known way, on purpose: a path-shaped token that is part of a URL or a
 * command line is read as a declared path too. That widens the authorized set, and widening it can
 * only ever silence this fold — never make it accuse a delivery of something it did not do.
 */
export function declaredPaths(declaration: {
  title?: string | null;
  description?: string | null;
  acceptanceCriteria?: string | null;
}): string[] {
  const text = [declaration.title, declaration.description, declaration.acceptanceCriteria]
    .filter((part): part is string => !!part)
    .join('\n');
  const found = text.match(PATH_TOKEN) ?? [];
  return [...new Set(found.map((token) => token.replace(/\/$/, '')).filter(Boolean))].sort();
}

/**
 * The changed paths no declared path covers.
 *
 * A declared path covers itself and everything beneath it, which is what makes naming a directory
 * a way to authorize the work inside it. The comparison is on whole segments — `src/projects`
 * covers `src/projects/a.ts` and does not cover `src/projects-old/a.ts`.
 */
export function pathsOutsideScope(
  changedPaths: readonly string[],
  declaredScope: readonly string[],
): string[] {
  return changedPaths
    .filter((changed) => !declaredScope.some(
      (declared) => changed === declared || changed.startsWith(`${declared}/`),
    ))
    .sort();
}

/**
 * The table in §0, and nothing else.
 *
 * The order is the order a person would hit the questions, and it is fixed so that two readers of
 * the same delivery are asked the same thing. Whether the exam applies comes before whether the
 * work matches the request, because an exam nobody agrees on makes "did it do what was asked"
 * unanswerable; and both come before the merge, because a tree that will not merge is only worth
 * untangling for work that is going to be merged.
 */
export function blockerDisposition(observed: DeliveryObservations): BlockerDisposition | null {
  if (observed.criterionExemptionArgued) return dispose('CRITERION_EXEMPTION_ARGUED', []);
  if (observed.statedCriterionMoved) return dispose('ACCEPTANCE_STANDARD_MOVED', []);

  // A declaration that named no path authorized nothing and forbade nothing. Reading it as an
  // empty allow-list would make every delivery out of scope, which is the reading §3 refuses.
  if (observed.declaredPaths.length > 0) {
    const strayed = pathsOutsideScope(observed.changedPaths, observed.declaredPaths);
    if (strayed.length > 0) return dispose('OUTSIDE_DECLARED_SCOPE', strayed);
  }

  if (observed.conflictedPaths.length > 0) {
    return dispose('MERGE_REFUSED_BY_GIT', [...observed.conflictedPaths].sort());
  }

  return null;
}

function dispose(reason: BlockerReason, paths: readonly string[]): BlockerDisposition {
  return { reason, kind: BLOCKER_KIND_FOR[reason], paths };
}

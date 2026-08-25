/**
 * Unit T6: authority by ACTION, not by a project-wide level.
 *
 * §0 — WHY THE THREE-LEVEL SWITCH IS THE WRONG SHAPE
 * ==================================================
 * `project.automation_policy` has three values — MANUAL, GUARDED_AUTO, AUTO — and one of them has
 * to answer for every act a coordinator can perform. Those acts are not one kind of thing. Starting
 * a task whose prerequisites are all DONE costs a few minutes of machine time if it was wrong.
 * Writing `verdict = PASS` records that unfinished work is finished, and nothing downstream ever
 * asks again. A single dial that moves both together is a dial nobody can set correctly: turned
 * down it stops the cheap thing, turned up it authorises the irreversible one.
 *
 * So the question this module answers is not "how far may this project's coordinator go" but "may
 * THIS principal perform THIS action", and the answer is a table with three tiers:
 *
 *   AUTOMATIC           deterministic, cheap to get wrong, and no LLM is in the loop at all.
 *   COORDINATOR_BOUNDED a judgment session may, inside a stated bound it cannot widen.
 *   HUMAN_ONLY          a person, through the door a person signs in to.
 *
 * The column stays. What changed is that nothing here reads it: every function below is total over
 * (principal, action) and takes no policy, so the same write is refused at MANUAL, at GUARDED_AUTO
 * and at AUTO alike. That is asserted rather than asserted-in-prose — see
 * `coordinator-authority.spec.ts`, "the refusal does not depend on the project automation policy".
 *
 * §1 — WHO IS RESTRICTED
 * ======================
 * Exactly one principal: the one-shot JUDGMENT session unit T3 opens from a committed fact
 * (`CoordinatorJudgmentService`), identified by `session.dispatch_origin = 'PROJECT_COORDINATOR'`.
 *
 * Everybody else is USER here, and the word is doing the same work it does in §4 R1 of the scope
 * contract: a person in the web app or the CLI, a task's own execution run, and the long-lived
 * coordination conversation a person opens with `POST /projects/:id/coordinator` — which takes the
 * `USER` dispatch origin precisely because a person opened it and is driving it turn by turn. A
 * write that arrives with no acting session at all is a person's by construction and pays nothing:
 * none of these gates costs it a query.
 *
 * That leaves the boundary keyed on a column the writer does not control. `dispatch_origin` is
 * written by `sessions.create` from the door the session came through, and the acting session id
 * arrives in the `X-Orbit-Session-Id` header the runner injects — never in a body field. An agent
 * that could name its own principal would be an agent that could grant itself whatever it was
 * refused.
 *
 * §2 — WHY THE SERVER AND NOT THE PROMPT
 * ======================================
 * Both openings say what is in reach, and both are advice. `coordinator-opening.ts` said in so many
 * words that `project_update` was the coordinator's tool for the acceptance criteria and for
 * `status = DONE`; the openings are fixed in this same unit, and fixing them is not what makes the
 * boundary hold. A refusal a model can talk itself out of is not a boundary, so every rule here is
 * enforced inside the SERVICE — reached identically from the user door, the runner door and a
 * direct call — rather than at a controller, which would leave the service as a second, unguarded
 * way in.
 */

/**
 * The one dispatch origin this contract restricts.
 *
 * A literal rather than an import of `SessionDispatchOrigin`, so this module stays free of the
 * database client and can be reasoned about as rules. `coordinator-authority.spec.ts` asserts the
 * literal still names a member of that enum, which is what stops the two drifting apart silently.
 */
export const JUDGMENT_DISPATCH_ORIGIN = 'PROJECT_COORDINATOR';

/** §1's two answers. `USER` is every writer this contract does not restrict. */
export const AUTHORITY_PRINCIPALS = ['USER', 'JUDGMENT'] as const;
export type AuthorityPrincipal = (typeof AUTHORITY_PRINCIPALS)[number];

export const AUTHORITY_TIERS = ['AUTOMATIC', 'COORDINATOR_BOUNDED', 'HUMAN_ONLY'] as const;
export type AuthorityTier = (typeof AUTHORITY_TIERS)[number];

/**
 * Every act the old dial used to answer for, graded one at a time.
 *
 * The two AUTOMATIC rows carry no gate anywhere and are here anyway: a table that listed only the
 * restricted actions would be a list of refusals rather than a division of authority, and the whole
 * claim of this unit is that dispatching ready work and retrying a transient failure are NOT the
 * same kind of act as recording that a goal was met.
 */
export const COORDINATOR_ACTIONS = [
  'DISPATCH_READY_TASK',
  'RETRY_TRANSIENT_FAILURE',
  'OPEN_TASK',
  'EDIT_ACCEPTANCE_CRITERIA',
  'CONCLUDE_VERDICT_PASS',
  'SETTLE_PROJECT_DONE',
] as const;
export type CoordinatorAction = (typeof COORDINATOR_ACTIONS)[number];

/**
 * §0's table. One tier per action, and the argument for each is the cost of being wrong.
 *
 * The three HUMAN_ONLY rows are the irreversible ones, and they are irreversible in the same way:
 * each turns "not finished" into "finished" for a reader who will never ask again. A task's DONE
 * unlocks its successors; a verification's PASS completes the subject it checks
 * (`task-aggregation.ts` counts `status DONE && verdict PASS` and nothing else); an acceptance
 * run's PASS is what a project's own DONE is bound to. Editing the acceptance criteria is the
 * worst of the three even though it settles nothing by itself: it is the move that makes every
 * other judgment come out right, which is why it is a coordinator's road out of any bound this
 * table puts on it.
 */
export const COORDINATOR_AUTHORITY: Readonly<Record<CoordinatorAction, AuthorityTier>> = {
  // Deterministic: prerequisites all DONE, an assignee, under the concurrency cap. No LLM decides
  // it, and a wrong dispatch costs a session that gets cancelled.
  DISPATCH_READY_TASK: 'AUTOMATIC',
  // Same shape: a transient failure retried once more spends machine time. The bound that matters
  // is not authority but repetition, and it lives in `convergence-contract.ts` — a failure
  // fingerprint that has already been seen is not retried again.
  RETRY_TRANSIENT_FAILURE: 'AUTOMATIC',
  // Spending authority: every task opened is sessions, tokens and somebody's attention. Bounded by
  // the two rules in `refuseTaskOpening` below.
  OPEN_TASK: 'COORDINATOR_BOUNDED',
  EDIT_ACCEPTANCE_CRITERIA: 'HUMAN_ONLY',
  CONCLUDE_VERDICT_PASS: 'HUMAN_ONLY',
  SETTLE_PROJECT_DONE: 'HUMAN_ONLY',
};

/**
 * One code per boundary, so a refused caller learns WHICH rule it met rather than that something
 * was not allowed. §12 E2's rule against synonyms applies: none of these renames a refusal that
 * already exists elsewhere, and none of them is reused for two different rules.
 */
export const AUTHORITY_REFUSAL_CODES = [
  'ACCEPTANCE_CRITERIA_HUMAN_ONLY',
  'VERDICT_PASS_HUMAN_ONLY',
  'PROJECT_DONE_HUMAN_ONLY',
  'TASK_CRITERION_UNDECLARED',
  'TASK_CRITERION_UNKNOWN',
  'TASK_BUDGET_SPENT',
] as const;
export type AuthorityRefusalCode = (typeof AUTHORITY_REFUSAL_CODES)[number];

/**
 * What the refused caller does next. A closed set for the reason the scope contract's is one: a
 * refusal whose required action is "something" is a refusal nobody can act on.
 */
export const AUTHORITY_REQUIRED_ACTIONS = [
  /** Stop and report. This is not a decision a judgment session gets to make at all. */
  'ASK_A_PERSON',
  /** Say which of the project's stated acceptance criteria this new work serves, and retry. */
  'NAME_THE_CRITERION_THIS_SERVES',
  /** The day's allowance is spent. Nothing to fix in the request; it can be made again later. */
  'WAIT_FOR_THE_BUDGET_WINDOW',
] as const;
export type AuthorityRequiredAction = (typeof AUTHORITY_REQUIRED_ACTIONS)[number];

/**
 * A refusal, as a response body.
 *
 * It carries no ids. Everything it names — an action, a code, a criterion key — is already a value
 * the caller sent or can read back from `project_get`, so nothing here has to survive
 * `PublicIdExceptionFilter`, which maps an error body by field name and would ship a raw UUID
 * under any name it does not recognise.
 */
export interface AuthorityRefusal {
  code: AuthorityRefusalCode;
  /** Which row of `COORDINATOR_AUTHORITY` refused, and at which tier. */
  action: CoordinatorAction;
  tier: AuthorityTier;
  requiredAction: AuthorityRequiredAction;
  message: string;
}

/**
 * §1's derivation, from the acting session's own `dispatch_origin`.
 *
 * `undefined` — no acting session — is USER, and so is a session this owner does not have. That is
 * deliberately the opposite of the scope contract's fail-closed treatment of an unresolvable id,
 * and the two are answering different questions: a scope is an authority a session CLAIMS, so an
 * unreadable claim must grant nothing, while this is a restriction placed on one specific kind of
 * session, and a session that is not that kind is not restricted by it. Nothing is granted here
 * either way — every caller that reaches these gates has already been authorised by the tenancy
 * checks and by the scope contract.
 */
export function authorityPrincipal(
  actingSessionDispatchOrigin: string | null | undefined,
): AuthorityPrincipal {
  return actingSessionDispatchOrigin === JUDGMENT_DISPATCH_ORIGIN ? 'JUDGMENT' : 'USER';
}

const HUMAN_ONLY_REFUSALS: Readonly<
  Record<'EDIT_ACCEPTANCE_CRITERIA' | 'CONCLUDE_VERDICT_PASS' | 'SETTLE_PROJECT_DONE',
    { code: AuthorityRefusalCode; message: string }>
> = {
  EDIT_ACCEPTANCE_CRITERIA: {
    code: 'ACCEPTANCE_CRITERIA_HUMAN_ONLY',
    message:
      'A judgment session cannot change a project’s acceptance criteria. They are the exam this '
      + 'project is judged against, and a coordinator that may rewrite the exam can make any '
      + 'verdict come out right — including its own. Report what you think should change and let a '
      + 'person write it, from the Orbit web app or the user API.',
  },
  CONCLUDE_VERDICT_PASS: {
    code: 'VERDICT_PASS_HUMAN_ONLY',
    message:
      'A judgment session cannot write PASS. A PASS completes work for every reader downstream and '
      + 'nothing asks again, so it is not a coordinator’s to record. FAIL and INCONCLUSIVE are '
      + 'allowed from here: a conservative conclusion releases nothing and asks for a person.',
  },
  SETTLE_PROJECT_DONE: {
    code: 'PROJECT_DONE_HUMAN_ONLY',
    message:
      'A judgment session cannot record a project DONE. That is the final statement that the goal '
      + 'was reached, and it is a person’s to make. Say what you found and what is left; the '
      + 'evidence you record is what they will read.',
  },
};

/**
 * The three HUMAN_ONLY rows, as a refusal or null.
 *
 * Total over the principal on purpose: a caller cannot express "check this only for coordinators",
 * because that phrasing is where a gate ends up guarded by the very condition it was meant to test.
 */
export function refuseHumanOnlyAction(
  principal: AuthorityPrincipal,
  action: keyof typeof HUMAN_ONLY_REFUSALS,
): AuthorityRefusal | null {
  if (principal !== 'JUDGMENT') return null;
  const refusal = HUMAN_ONLY_REFUSALS[action];
  return {
    code: refusal.code,
    action,
    tier: COORDINATOR_AUTHORITY[action],
    requiredAction: 'ASK_A_PERSON',
    message: refusal.message,
  };
}

/** What `refuseTaskOpening` is decided over. Every field is server-read except the declared key. */
export interface TaskOpeningFacts {
  /** The criterion the caller says this work serves — `CreateTaskDto.criterionKey`, verbatim. */
  declaredCriterionKey: string | null | undefined;
  /** The keys of the project's currently stated criteria (`ProjectAcceptanceService`'s `key`). */
  statedCriterionKeys: readonly string[];
  /** How many tasks judgment sessions have already opened in this project inside the window. */
  openedInWindow: number;
  /** How many this call would open. A batch is judged whole — it lands whole or not at all. */
  opening: number;
  /** `project.session_budget_per_day`. null is the column's own "no limit". */
  budgetPerDay: number | null;
}

/**
 * `OPEN_TASK`'s two bounds, in order: what the work is for, then whether there is any allowance
 * left to do it with.
 *
 * WHY A CRITERION AND NOT A WORD LIMIT
 * ------------------------------------
 * The failure being bounded is task inflation — a coordinator that answers every difficulty by
 * filing more work, each item locally reasonable, until the project is a queue of its own
 * deliberation. A count would bound it arbitrarily. Naming the criterion pins it to a fact instead:
 * a project's acceptance criteria are FINITE and a person wrote them, so work that serves none of
 * them is work the project was not asked for, and that is a sentence somebody can check.
 *
 * The key must name a criterion that is stated TODAY. A project with none stated refuses every
 * coordinator-opened task, which is the correct answer rather than an edge case: there is nothing
 * for the work to serve yet, and the person who states the criteria is the person to ask.
 *
 * What this does NOT cover, considered and left out: MOVING an existing task into the project.
 * That is not opening work — the task exists, somebody already decided it was worth doing — and
 * the writer who may do it is decided by the scope contract's R6/R7 rather than here. The one way
 * it could be used as a way round this bound is to file work UNDER no project and then move it in,
 * and that door is already shut: a judgment session holds a scope, so a create naming no project
 * binds to that scope, and one naming `null` explicitly is R4's refusal.
 *
 * WHY THE BUDGET IS A REFUSAL AND NOT A WARNING
 * ---------------------------------------------
 * `task-plan-preflight.ts` warns that a plan exceeds `sessionBudgetPerDay` and lets it through,
 * and that is right there: the warning is about work a PERSON planned, and refusing somebody's plan
 * because it will queue would be an opinion about how they are allowed to work. This is the other
 * side of the same column — the spend an agent authorises for itself — and there the budget is the
 * whole of the authority. A bound that only warns is not a bound.
 */
export function refuseTaskOpening(
  principal: AuthorityPrincipal,
  facts: TaskOpeningFacts,
): AuthorityRefusal | null {
  if (principal !== 'JUDGMENT') return null;
  const declared = facts.declaredCriterionKey?.trim();
  if (!declared) {
    return {
      code: 'TASK_CRITERION_UNDECLARED',
      action: 'OPEN_TASK',
      tier: COORDINATOR_AUTHORITY.OPEN_TASK,
      requiredAction: 'NAME_THE_CRITERION_THIS_SERVES',
      message:
        'A judgment session opening a task has to say which of this project’s acceptance criteria '
        + 'the work serves: pass `criterionKey`, using a `key` from `project_get`. Work that '
        + 'serves none of the stated criteria is work this project was not asked for.',
    };
  }
  if (!facts.statedCriterionKeys.includes(declared)) {
    return {
      code: 'TASK_CRITERION_UNKNOWN',
      action: 'OPEN_TASK',
      tier: COORDINATOR_AUTHORITY.OPEN_TASK,
      requiredAction: 'NAME_THE_CRITERION_THIS_SERVES',
      message:
        `criterionKey ${declared} does not name any acceptance criterion this project states `
        + `today (it states ${facts.statedCriterionKeys.length}). Re-read them with project_get: `
        + 'editing a criterion changes its key, and a project that states none has nothing for new '
        + 'work to serve until a person writes them.',
    };
  }
  // Read as a whole-plan question. A batch that would take the project past its allowance is
  // refused entire rather than trimmed: the caller asked for a plan, and half a plan is a shape
  // nobody chose.
  if (facts.budgetPerDay !== null && facts.openedInWindow + facts.opening > facts.budgetPerDay) {
    return {
      code: 'TASK_BUDGET_SPENT',
      action: 'OPEN_TASK',
      tier: COORDINATOR_AUTHORITY.OPEN_TASK,
      requiredAction: 'WAIT_FOR_THE_BUDGET_WINDOW',
      message:
        `This project allows ${facts.budgetPerDay} coordinator-opened task(s) a day and `
        + `${facts.openedInWindow} of them have been opened in the last 24 hours, so opening `
        + `${facts.opening} more is over the allowance. Nothing is wrong with the request — say `
        + 'what still needs doing and let it wait, or ask for the budget to be raised.',
    };
  }
  return null;
}

/** How far back `openedInWindow` counts. A rolling window, so there is no reset a caller can wait
 *  for the edge of and no midnight at which a day's worth of authority arrives at once. */
export const TASK_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

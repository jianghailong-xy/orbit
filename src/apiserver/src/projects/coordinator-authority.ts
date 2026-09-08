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
 *   HUMAN_ONLY          owner review through an owner-authenticated channel, with action-specific
 *                       traceability.
 *
 * The column stays. What changed is that nothing here reads it: every function below is total over
 * (principal, action) and takes no policy, so the same write is refused at MANUAL, at GUARDED_AUTO
 * and at AUTO alike. That is asserted rather than asserted-in-prose — see
 * `coordinator-authority.spec.ts`, "the refusal does not depend on the project automation policy".
 *
 * §1 — WHO IS RESTRICTED
 * ======================
 * Exactly one session role: the one-shot JUDGMENT session unit T3 opens from a committed fact
 * (`CoordinatorJudgmentService`), identified by `session.dispatch_origin = 'PROJECT_COORDINATOR'`.
 *
 * Everything else is NON_JUDGMENT here: the owner-authenticated web/API door, a task execution
 * run, a long-lived coordination conversation, and a write with no acting session. The last case
 * deliberately preserves headless CLI, internal/cron and user-API callers; changing `undefined`
 * into a refusal would turn a role restriction into a new authentication requirement.
 *
 * NON_JUDGMENT does NOT mean "the server proved a person was present". This module classifies one
 * session role, not humans. `dispatch_origin` is written by `sessions.create`, and the acting
 * session id arrives in the runner-injected `X-Orbit-Session-Id` header rather than a body field,
 * so the one-shot judgment session cannot opt out while it uses its ordinary credential. A caller
 * that omits the header, borrows an owner credential, or can mint an owner JWT may still arrive as
 * NON_JUDGMENT. Tenancy and scope checks decide what that credential may reach; this table adds
 * workflow separation and action-specific evidence, not a hard human-presence boundary. PASS
 * conclusions and standard-set confirmations retain an actor; criteria retain the facts they
 * changed, while DONE is now a requester-free automatic projection. See
 * `docs/human-only-authority.md` for that exact audit matrix.
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

/** §1's two answers. `NON_JUDGMENT` is a negative role classification, not a human identity. */
export const AUTHORITY_PRINCIPALS = ['NON_JUDGMENT', 'JUDGMENT'] as const;
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
  'CONFIRM_ACCEPTANCE_CRITERIA',
  'CONCLUDE_VERDICT_PASS',
  'SETTLE_PROJECT_DONE',
] as const;
export type CoordinatorAction = (typeof COORDINATOR_ACTIONS)[number];

/**
 * §0's table. One tier per action, and the argument for each is the cost of being wrong.
 *
 * The two HUMAN_ONLY rows are what is left of owner review, and they are both about the RULER:
 * editing defines the exam, confirming says the complete exam expresses the goal. Reading the
 * ruler is no longer one of them. `CONCLUDE_VERDICT_PASS` moved to COORDINATOR_BOUNDED in the
 * same change that deleted `HUMAN_SIGNOFF`: a judgment session may now confirm a criterion as
 * well as refute one, bounded by the evidence version its conclusion names and by the conjunction
 * the evaluator still requires. Project settlement remains AUTOMATIC — no principal writes it.
 *
 * HUMAN_ONLY is the stable policy/API label for "route this to owner review"; it does not claim
 * that the credentialed owner channel is cryptographic proof of human presence.
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
  CONFIRM_ACCEPTANCE_CRITERIA: 'HUMAN_ONLY',
  // Bounded, not free: the conclusion must name the immutable evidence version it was reached
  // against, every stated criterion must be answered in the same call, and the project-level
  // verdict is derived from that conjunction rather than supplied.
  CONCLUDE_VERDICT_PASS: 'COORDINATOR_BOUNDED',
  SETTLE_PROJECT_DONE: 'AUTOMATIC',
};

/**
 * One code per boundary, so a refused caller learns WHICH rule it met rather than that something
 * was not allowed. §12 E2's rule against synonyms applies: none of these renames a refusal that
 * already exists elsewhere, and none of them is reused for two different rules.
 */
export const AUTHORITY_REFUSAL_CODES = [
  'ACCEPTANCE_CRITERIA_HUMAN_ONLY',
  'PROJECT_CRITERIA_CONFIRMATION_HUMAN_ONLY',
  'PROJECT_STATUS_NOT_SESSION_WRITABLE',
  'PROJECT_CRITERIA_CONFIRMATION_OWNER_CHANNEL_ONLY',
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
  /** Stop and request owner review. This is workflow guidance, not a human-authentication fact. */
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
 * `undefined` — no acting session — is NON_JUDGMENT, as is an unresolvable session. This is
 * deliberately different from the scope contract's fail-closed treatment of a claimed scope, and
 * the two answer different questions: scope is positive authority, while this helper only asks
 * whether the request is attributable to the one restricted judgment role. Nothing is granted by
 * this answer — tenancy and scope authorization have already run — and NON_JUDGMENT is expressly
 * not evidence that a human held the authenticated credential.
 */
export function authorityPrincipal(
  actingSessionDispatchOrigin: string | null | undefined,
): AuthorityPrincipal {
  return actingSessionDispatchOrigin === JUDGMENT_DISPATCH_ORIGIN
    ? 'JUDGMENT'
    : 'NON_JUDGMENT';
}

const HUMAN_ONLY_REFUSALS: Readonly<
  Record<'EDIT_ACCEPTANCE_CRITERIA' | 'CONFIRM_ACCEPTANCE_CRITERIA',
    { code: AuthorityRefusalCode; message: string }>
> = {
  EDIT_ACCEPTANCE_CRITERIA: {
    code: 'ACCEPTANCE_CRITERIA_HUMAN_ONLY',
    message:
      'A judgment session cannot change a project’s acceptance criteria. They are the exam this '
      + 'project is judged against, and a coordinator that may rewrite the exam can make any '
      + 'verdict come out right — including its own. Report what should change and request an '
      + 'owner review through an owner-authenticated channel. Orbit freezes the resulting criteria '
      + 'and digest in an evidence version, but this write does not persist the requester’s identity '
      + 'and the channel does not prove who held the credential.',
  },
  CONFIRM_ACCEPTANCE_CRITERIA: {
    code: 'PROJECT_CRITERIA_CONFIRMATION_HUMAN_ONLY',
    message:
      'A one-shot project judgment session cannot confirm the project acceptance standard set. ' +
      'Confirmation is the owner-review workflow for deciding whether the complete, digest-bound ' +
      'set expresses the goal. Use an owner channel or a headless runner path; Orbit records the ' +
      'credentialed actor, which is audit visibility and not proof that a human held it.',
  },
};

/**
 * The two HUMAN_ONLY rows, as a refusal or null.
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

/**
 * `SETTLE_PROJECT_DONE`'s tier, as a rule instead of a sentence.
 *
 * WHAT THE TABLE ALREADY SAID, AND WHAT THE SERVER DID
 * ---------------------------------------------------
 * The row above grades project settlement `AUTOMATIC` and says "no principal writes it". That was
 * a description of an intention. `UpdateProjectDto` carries `status`, `ProjectsService.update`
 * copies it into the Prisma input whenever a request sent one, and the only role gate on that
 * method left before it looked at anything else unless the same request was also rewriting the
 * acceptance criteria. So every session — an execution run, the one-shot judgment session, the
 * long-lived coordination conversation — could settle the project it was working inside, and the
 * three tiers above were dividing an authority that had no boundary underneath it.
 *
 * WHY THE FIELD AND NOT THE VALUE
 * -------------------------------
 * The act this closes is DONE: an agent recording that the goal it was given has been met, which
 * nothing downstream ever asks about again. A rule spelled that narrowly is one with a way round
 * it, so all three values are refused, and each for its own reason:
 *
 *   DONE      the act the row is about. Settlement is derived from the work, not requested.
 *   CANCELLED closes the project just as finally. "Abandoned" and "finished" differ in what they
 *             say about the goal and not at all in what they do to the work, so leaving this one
 *             writable would leave the same act available under a second name.
 *   OPEN      puts back into circulation a project somebody settled. It claims nothing about the
 *             goal, which is why it is the weakest of the three — and it is still an agent
 *             overturning a decision the owner made about their own project, in a column whose
 *             whole content is where the work stands.
 *
 * Refused rather than dropped, for the reason the runner door refuses the authorization set rather
 * than stripping it: a silently ignored field reads to the caller as a write that happened, and
 * this caller is a model that will go on to report a finished project.
 *
 * WHAT IT DOES NOT CLAIM
 * ----------------------
 * The same honesty §1 states about the rest of this table. The condition is the presence of an
 * acting session, which arrives as the runner-injected `X-Orbit-Session-Id` header — so it binds
 * the `project_update` tool an agent actually holds, and it does NOT establish that a request
 * without one came from a person. A caller that omits the header, holds a runner credential, or
 * can mint an owner JWT still reaches the write, exactly as it did before. Keeping that path is
 * the deliberate compatibility decision: the user API, the headless CLI and internal callers write
 * this column the way migration 0229 left them, and turning `undefined` into a refusal here would
 * reinstate for everybody the gate the account owner chose to remove.
 */
export function refuseProjectStatusWrite(
  /** `UpdateProjectDto.status` verbatim. `undefined` is "not sent", as everywhere else here. */
  requestedStatus: string | null | undefined,
  /** The acting session id the door resolved, or `undefined` when the request carried none. */
  actingSessionId: string | null | undefined,
): AuthorityRefusal | null {
  if (requestedStatus === undefined) return null;
  if (!actingSessionId?.trim()) return null;
  return {
    code: 'PROJECT_STATUS_NOT_SESSION_WRITABLE',
    action: 'SETTLE_PROJECT_DONE',
    tier: COORDINATOR_AUTHORITY.SETTLE_PROJECT_DONE,
    requiredAction: 'ASK_A_PERSON',
    message:
      'A request made from a session cannot write a project’s `status`. Where the work stands is '
      + 'a statement about the whole project — DONE says its goal was met and nothing downstream '
      + 'asks again, CANCELLED drops it, OPEN reverses somebody who settled it — and an agent that '
      + 'could write it could close the project it was given instead of finishing it. Nothing was '
      + 'written by this request, including the other fields it carried. Report what you found and '
      + 'let the account owner decide; that channel is a tenancy and audit boundary, not proof '
      + 'that a person held the credential.',
  };
}

/**
 * The one door `CONFIRM_ACCEPTANCE_CRITERIA` has, as a rule: a request with NO acting session.
 *
 * This is strictly narrower than `refuseHumanOnlyAction` above, and the difference is deliberate.
 * That function refuses one session ROLE because widening it would have changed what already
 * working doors accept — §1's compatibility decision, which is about not turning a role
 * restriction into a new authentication requirement for callers that predate it. Confirmation has
 * no such caller to preserve: it had no writer at all, so its door can be the shape the tier
 * describes from the first day rather than the shape compatibility leaves.
 *
 * What that buys is the deliverable `docs/human-only-authority.md` names for this tier — an
 * action-specific, durable record of who said the standard set expresses the goal — reached
 * through the owner-authenticated channel and nothing else. An acting session is refused whatever
 * its dispatch origin, so a coordinator conversation that has a person answering a card in it
 * prompts and links rather than presses the button on their behalf; what reaches the server that
 * way would be the agent's report of an answer, not the answer.
 *
 * Its own code, not the HUMAN_ONLY one above: a caller told `PROJECT_CRITERIA_CONFIRMATION_
 * HUMAN_ONLY` has met the judgment-role boundary, and a caller told this one has met a different
 * rule — it may be any role at all and still have no path here. §12 E2 forbids two spellings of
 * one rule; these are two rules, and each is raised by exactly one predicate.
 *
 * NOT a claim that a person is present. The owner channel is a credential like any other; this
 * says only that no acting session authored the write.
 */
export function refuseSessionAuthoredConfirmation(
  actingSessionId: string | null | undefined,
): AuthorityRefusal | null {
  if (!actingSessionId) return null;
  return {
    code: 'PROJECT_CRITERIA_CONFIRMATION_OWNER_CHANNEL_ONLY',
    action: 'CONFIRM_ACCEPTANCE_CRITERIA',
    tier: COORDINATOR_AUTHORITY.CONFIRM_ACCEPTANCE_CRITERIA,
    requiredAction: 'ASK_A_PERSON',
    message:
      'Confirming that a project’s acceptance standard set expresses its goal is not something a '
      + 'session does. It says the exam is the right exam, so it is the account owner’s to make '
      + 'through an owner-authenticated channel with no acting session — report what should be '
      + 'confirmed and let a person do it. Orbit records the credentialed actor and the exact '
      + 'version of the standard set that was confirmed; neither is proof that a human held the '
      + 'credential.',
  };
}

/** What `refuseTaskOpening` is decided over. Every field is server-read except the declared key. */
export interface TaskOpeningFacts {
  /** The already-validated declaration on the Task this call would open. */
  completionCriterion?: 'EXECUTABLE' | 'VERIFICATION' | 'EVIDENCE_JUDGMENT' | null;
  /** The criterion the caller says this work serves — `CreateTaskDto.criterionKey`, verbatim. */
  declaredCriterionKey: string | null | undefined;
  /** The keys of the project's currently stated criteria — each criterion's own id, as
   *  `criteriaFromDefinitions` spells it. */
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
 * a project's acceptance criteria are FINITE and the owner channel recorded them, so work that serves none of
 * them is work the project was not asked for, and that is a sentence somebody can check.
 *
 * The key must name a criterion that is stated TODAY. A project with none stated refuses every
 * coordinator-opened task, which is the correct answer rather than an edge case: there is nothing
 * for the work to serve yet, and the owner who states the criteria is the reviewer to ask.
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
        + 'a key is the criterion’s own id, so one that resolves nowhere here names a criterion '
        + 'that was deleted or one of another project’s, and a project that states none has '
        + 'nothing for new work to serve until an owner-authenticated channel records them.',
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

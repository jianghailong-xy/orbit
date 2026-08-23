/**
 * Coordinator write scope and cross-project attribution — the frozen half (unit L1).
 *
 * The incident this exists for: a coordinator session filed a batch of tasks into a project that
 * was not the one it coordinates. Nothing refused it. `TasksService.assertOwnedProject` asks one
 * question — does this OWNER own that project — and the owner owns every project, so a coordinator
 * acting on behalf of project A may write into project B and the write is indistinguishable from a
 * deliberate one. PAC §8.2 ⚠a already says a coordinator "只能在自己所属的那个 Project 内建";
 * it says it in prose, with no code to refuse with, no state to land in and nobody named as the
 * one who fixes it. Prose is not a gate.
 *
 * This module is the vocabulary and the frozen tables. `project-scope-decision.ts` is the decision
 * function over them. Both are pure: no clock, no database, no imports from the service layer, so
 * the rules can be tested as rules before anything enforces them (that is unit L3).
 *
 * What this contract does NOT touch, deliberately:
 *   - the LOCKS and the double reopen a cross-project move already takes (PCC §13.4 AE10) — this
 *     decides who may ask for the move, not how it is applied;
 *   - the acceptance-fact reopen for tasks a project ALREADY owns (PCC §13.4 AE8) — a status
 *     change inside a settled project still reopens it exactly as it does today;
 *   - `TASK_CLAIMED_PROJECT_MOVE` (PCC §7.7 D10), which refuses a move while a dispatch placeholder
 *     is held. That is a commit-time mechanical refusal about the task's runtime; this is an
 *     admission-time authority refusal about the writer. Different questions, different moments —
 *     a write this contract refuses never reaches D10.
 */

/** Who is doing the writing. §4 has one column per principal and the answers differ. */
export const SCOPE_PRINCIPALS = ['USER', 'COORDINATOR', 'WORKER'] as const;
export type ScopePrincipal = (typeof SCOPE_PRINCIPALS)[number];

/**
 * The write surface this contract covers. Three operations, because there are exactly three shapes
 * of task write that can change which goal a piece of work counts towards.
 *
 * `HANDOFF_TASK` is the declared crossing: moving an existing task to another project, or creating
 * work that lands in one. It is a distinct operation rather than a flag because the difference
 * between a violation and a request is precisely whether the writer said it was crossing (SC5).
 */
export const SCOPE_OPERATIONS = ['CREATE_TASK', 'UPDATE_TASK', 'HANDOFF_TASK'] as const;
export type ScopeOperation = (typeof SCOPE_OPERATIONS)[number];

export const SCOPE_DECISIONS = ['ALLOW', 'REQUIRE_APPROVAL', 'REFUSE'] as const;
export type ScopeDecision = (typeof SCOPE_DECISIONS)[number];

/** Project statuses an end of a write can be in. Mirrors the `ProjectStatus` enum. */
export type ScopeProjectStatus = 'OPEN' | 'DONE' | 'CANCELLED';

/**
 * Codes this contract INTRODUCES. Four, matching the four the unit was asked to freeze.
 *
 * Every other refusal on this path reuses a code that already exists, which is not politeness: PAC
 * §12 E2 forbids a new code that is a synonym of an old one, because two names for one event is
 * how two implementations end up both "conforming" while disagreeing.
 */
export const SCOPE_NEW_REFUSAL_CODES = [
  'PROJECT_SCOPE_MISMATCH',
  'UNMAPPED_PROJECT_WORK',
  'CROSS_PROJECT_APPROVAL_REQUIRED',
  'PROJECT_REOPEN_REQUIRED',
] as const;

/**
 * Codes this contract REUSES verbatim, with the file that already declares each one.
 *
 * `COORDINATOR_GENERATION_MOVED` is the takeover answer and it is not new: the coordinator turn
 * executor already refuses with it when the generation inside an idempotency key has moved
 * (`project-coordinator-turn.service.ts`, §8.2 GE4), and already treats it as retryable rather
 * than as a blocker. A write arriving from a scope that has been rotated away is the same fact
 * about the same counter, so it gets the same name.
 *
 * The four approval states are `ProjectAuthorizationReasonCode` members
 * (`project-authorization.service.ts`) and are already classified in `project-blocker.ts`. This
 * contract adds no fifth way to say "the approval is not a yes".
 */
export const SCOPE_REUSED_REFUSAL_CODES = [
  'COORDINATOR_GENERATION_MOVED',
  'APPROVAL_PENDING',
  'APPROVAL_DENIED',
  'APPROVAL_EXPIRED',
  'APPROVAL_TARGET_MISMATCH',
] as const;

export const SCOPE_REFUSAL_CODES = [
  ...SCOPE_NEW_REFUSAL_CODES,
  ...SCOPE_REUSED_REFUSAL_CODES,
] as const;
export type ScopeRefusalCode = (typeof SCOPE_REFUSAL_CODES)[number];

/**
 * What the refused writer — or the person the refusal names — has to do next. Closed set: a
 * refusal whose required action is "something" is a refusal nobody can act on, and §11.1 BL1's
 * fifth question exists because v1 shipped exactly that.
 */
export const SCOPE_REQUIRED_ACTIONS = [
  /** Re-read the scope from the server and retry the same write. Self-healing, no human. */
  'RE_DERIVE_SCOPE',
  /** Stop. This session is not the scope holder; whoever is will decide again. No retry. */
  'YIELD_TO_CURRENT_SCOPE',
  /** File it inside the scope actually held, or declare the crossing and ask. */
  'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF',
  /** Somebody has to say which project owns this work. Nothing an agent can answer for itself. */
  'NAME_OWNING_PROJECT',
  /** The landing project is settled; it has to be reopened (new acceptance epoch) first. */
  'REOPEN_PROJECT_FIRST',
  /** Wait for the user's answer on the declared crossing. */
  'AWAIT_HANDOFF_APPROVAL',
] as const;
export type ScopeRequiredAction = (typeof SCOPE_REQUIRED_ACTIONS)[number];

/** Who owns the refusal, in the same three values `project_blocker.owner` uses. */
export type ScopeResponsible = 'USER' | 'COORDINATOR' | 'SYSTEM';

export interface ScopeRefusalPolicy {
  /** What the write becomes. `REQUIRE_APPROVAL` is not applied either — it is a request. */
  decision: Exclude<ScopeDecision, 'ALLOW'>;
  /** Who has to act. Not "who is at fault" — the two differ for `UNMAPPED_PROJECT_WORK`. */
  responsible: ScopeResponsible;
  /**
   * The `project_blocker` kind this refusal becomes, or null when it deliberately becomes none.
   *
   * Every value here is a member of `PROJECT_BLOCKER_KINDS` — this contract invents no kind, which
   * is what keeps it off the migration path (a kind outside the closed set is rejected by
   * `project_blocker_kind_chk` at the database, i.e. the refusal itself would fail to persist).
   *
   * null is a claim, not a gap: it says the loop has NOT stopped. It is only null where the writer
   * can fix its own write on the next pass with no new information from anybody.
   */
  blockerKind: string | null;
}

/**
 * §5, as data. Refusal code → what it means for the write, who owns it and where it lands.
 *
 * `requiredAction` is deliberately NOT here. One code answers more than one rule — a write refused
 * `PROJECT_SCOPE_MISMATCH` because the token did not verify is told to re-derive and retry, and one
 * refused because it aimed at another project is told to file at home or ask — and the next step is
 * a property of which rule refused, not of the name the refusal carries. Putting it on the code
 * would force one of those two writers to be given advice that cannot work. It lives on the rule
 * (`SCOPE_RULES`), which has exactly one.
 *
 * `PROJECT_SCOPE_MISMATCH` is the one that becomes no blocker. It is the coordinator's own write to
 * fix — file it in the project it actually coordinates, or declare the crossing — and a blocker
 * would be a request addressed to a user who has nothing to decide. A coordinator that keeps
 * mismatching is a coordinator making no progress, and that is already the K unit's circuit
 * breaker; giving it a second, differently-shaped alarm here would double-count one condition.
 */
export const SCOPE_REFUSAL_POLICY: Readonly<Record<ScopeRefusalCode, ScopeRefusalPolicy>> = {
  PROJECT_SCOPE_MISMATCH: {
    decision: 'REFUSE',
    responsible: 'COORDINATOR',
    blockerKind: null,
  },
  UNMAPPED_PROJECT_WORK: {
    decision: 'REFUSE',
    // The coordinator is not at fault for noticing work whose owner is unclear; it is at fault only
    // if it picks an owner anyway. So the refusal is correct behaviour by the agent and a question
    // for the person — which is why the responsible party and the code's cause differ here.
    responsible: 'USER',
    blockerKind: 'AWAITING_USER_INPUT',
  },
  CROSS_PROJECT_APPROVAL_REQUIRED: {
    decision: 'REQUIRE_APPROVAL',
    responsible: 'USER',
    blockerKind: 'AWAITING_USER_APPROVAL',
  },
  PROJECT_REOPEN_REQUIRED: {
    decision: 'REFUSE',
    responsible: 'USER',
    blockerKind: 'AWAITING_USER_APPROVAL',
  },
  COORDINATOR_GENERATION_MOVED: {
    decision: 'REFUSE',
    // Nobody is being asked for anything: the successor scope holds the work and will decide again.
    responsible: 'SYSTEM',
    blockerKind: null,
  },
  APPROVAL_PENDING: {
    decision: 'REQUIRE_APPROVAL',
    responsible: 'USER',
    blockerKind: 'AWAITING_USER_APPROVAL',
  },
  APPROVAL_DENIED: {
    decision: 'REFUSE',
    responsible: 'COORDINATOR',
    blockerKind: null,
  },
  APPROVAL_EXPIRED: {
    decision: 'REFUSE',
    responsible: 'USER',
    blockerKind: null,
  },
  APPROVAL_TARGET_MISMATCH: {
    decision: 'REFUSE',
    responsible: 'COORDINATOR',
    blockerKind: null,
  },
};

/**
 * §2. The authoritative ownership column, and the four provenance columns beside it.
 *
 * The distinction the whole unit turns on: `project_id` is the ONLY column that says which goal a
 * task counts towards. The four below say where the work was noticed. They are evidence, and
 * evidence grants nothing — the day a gate reads `discovered_from_project_id` to decide anything,
 * "I found this" has quietly become "I may write here", and the incident is back with better
 * paperwork. §3 SC7 states it as an invariant and the decision spec tests it as one.
 *
 * Names only. The columns are unit L2's to persist; freezing the names here is what stops L2 and
 * L7 from inventing two spellings of the same fact.
 */
export const AUTHORITATIVE_OWNERSHIP_FIELD = 'projectId' as const;

export const SCOPE_PROVENANCE_FIELDS = [
  'discoveredFromProjectId',
  'triggerEvent',
  'sourceTaskId',
  'sourceSessionId',
] as const;
export type ScopeProvenanceField = (typeof SCOPE_PROVENANCE_FIELDS)[number];

/**
 * §6's states. One unit of discovered work, from noticed to filed.
 *
 * `ABANDONED` is the end of an ATTEMPT, not of the work: a successor coordinator that notices the
 * same thing starts again at `DISCOVERED`. Saying it the other way round would make a takeover
 * look like a decision that the work is not worth doing.
 */
export const SCOPE_WORK_STATES = [
  'DISCOVERED',
  'FILED',
  'UNMAPPED',
  'HANDOFF_REQUESTED',
  'HANDOFF_APPROVED',
  'REOPEN_REQUIRED',
  'ABANDONED',
] as const;
export type ScopeWorkState = (typeof SCOPE_WORK_STATES)[number];

export const SCOPE_WORK_EVENTS = [
  'FILE_IN_SCOPE',
  'TARGET_UNCLEAR',
  'DECLARE_HANDOFF',
  'APPROVE',
  'REFUSE_HANDOFF',
  'APPLY',
  'TARGET_SETTLED',
  'TARGET_REOPENED',
  'USER_ASSIGNS_PROJECT',
  'SCOPE_LOST',
] as const;
export type ScopeWorkEvent = (typeof SCOPE_WORK_EVENTS)[number];

/**
 * §6, as data. Every (state, event) cell has exactly one result; `null` means the event is refused
 * here and the state does not move — an explicit answer, not a hole. Two properties are load
 * bearing and are tested as properties rather than as rows:
 *
 *   - `USER_ASSIGNS_PROJECT` reaches `FILED` from every state, including `ABANDONED`. The user is
 *     the one principal no refusal in this contract applies to (§4 R1).
 *   - `SCOPE_LOST` is a fixed point of every state except `DISCOVERED`. A takeover must not undo
 *     anything already persisted; the only thing it can end is an attempt that had not yet written.
 */
export const SCOPE_WORK_TRANSITIONS: Readonly<
  Record<ScopeWorkState, Readonly<Record<ScopeWorkEvent, ScopeWorkState | null>>>
> = {
  DISCOVERED: {
    FILE_IN_SCOPE: 'FILED',
    TARGET_UNCLEAR: 'UNMAPPED',
    DECLARE_HANDOFF: 'HANDOFF_REQUESTED',
    APPROVE: null,
    REFUSE_HANDOFF: null,
    APPLY: null,
    TARGET_SETTLED: 'REOPEN_REQUIRED',
    TARGET_REOPENED: null,
    USER_ASSIGNS_PROJECT: 'FILED',
    SCOPE_LOST: 'ABANDONED',
  },
  FILED: {
    // Idempotent replay. The same scope token writing the same work twice is one task, which is
    // what makes a retry after a crash safe (AC2).
    FILE_IN_SCOPE: 'FILED',
    TARGET_UNCLEAR: null,
    DECLARE_HANDOFF: 'HANDOFF_REQUESTED',
    APPROVE: null,
    REFUSE_HANDOFF: null,
    APPLY: 'FILED',
    // A project reaching DONE does not evict the work it owns. Ownership is unchanged; what a
    // settled project refuses is NEW work (§4 R7).
    TARGET_SETTLED: 'FILED',
    TARGET_REOPENED: 'FILED',
    USER_ASSIGNS_PROJECT: 'FILED',
    SCOPE_LOST: 'FILED',
  },
  UNMAPPED: {
    // Retrying the identical write does not make the owner clearer. Without this cell a coordinator
    // could spin on the refusal until something else moved, which is the silent spinning AC3 bans.
    FILE_IN_SCOPE: null,
    TARGET_UNCLEAR: 'UNMAPPED',
    DECLARE_HANDOFF: 'HANDOFF_REQUESTED',
    APPROVE: null,
    REFUSE_HANDOFF: null,
    APPLY: null,
    TARGET_SETTLED: null,
    TARGET_REOPENED: null,
    USER_ASSIGNS_PROJECT: 'FILED',
    // The question is filed against the PROJECT, not the session that asked it. A takeover leaves
    // it standing, or every rotation would silently drop the questions asked before it.
    SCOPE_LOST: 'UNMAPPED',
  },
  HANDOFF_REQUESTED: {
    // Changing your mind is legal, but not by leaving a request outstanding: withdraw it first
    // (REFUSE_HANDOFF is the user-side shape of that) or two answers can arrive for one write.
    FILE_IN_SCOPE: null,
    TARGET_UNCLEAR: null,
    DECLARE_HANDOFF: 'HANDOFF_REQUESTED',
    APPROVE: 'HANDOFF_APPROVED',
    REFUSE_HANDOFF: 'ABANDONED',
    // Approval is not application. Without this cell "approved" and "moved" become the same event
    // and there is no state in which the approved move can wait for its own transaction.
    APPLY: null,
    TARGET_SETTLED: 'REOPEN_REQUIRED',
    TARGET_REOPENED: null,
    USER_ASSIGNS_PROJECT: 'FILED',
    SCOPE_LOST: 'HANDOFF_REQUESTED',
  },
  HANDOFF_APPROVED: {
    FILE_IN_SCOPE: null,
    TARGET_UNCLEAR: null,
    DECLARE_HANDOFF: 'HANDOFF_APPROVED',
    APPROVE: 'HANDOFF_APPROVED',
    REFUSE_HANDOFF: 'ABANDONED',
    APPLY: 'FILED',
    // Settled between the yes and the move: the yes was about a project that has since been
    // accepted, so it stops being a yes about the world it was given in.
    TARGET_SETTLED: 'REOPEN_REQUIRED',
    TARGET_REOPENED: null,
    USER_ASSIGNS_PROJECT: 'FILED',
    SCOPE_LOST: 'HANDOFF_APPROVED',
  },
  REOPEN_REQUIRED: {
    FILE_IN_SCOPE: null,
    TARGET_UNCLEAR: null,
    DECLARE_HANDOFF: 'REOPEN_REQUIRED',
    // An approval cannot buy a way past a settled project — that is how an accepted project gets
    // new work without its acceptance record ever being contested.
    APPROVE: null,
    REFUSE_HANDOFF: 'ABANDONED',
    APPLY: null,
    TARGET_SETTLED: 'REOPEN_REQUIRED',
    // Back to the entry, not back to the request: a reopen starts a new acceptance epoch, so the
    // world the earlier decision read is gone and §4 has to be answered again against this one.
    TARGET_REOPENED: 'DISCOVERED',
    USER_ASSIGNS_PROJECT: 'FILED',
    SCOPE_LOST: 'REOPEN_REQUIRED',
  },
  ABANDONED: {
    FILE_IN_SCOPE: null,
    TARGET_UNCLEAR: null,
    DECLARE_HANDOFF: null,
    APPROVE: null,
    REFUSE_HANDOFF: null,
    APPLY: null,
    TARGET_SETTLED: null,
    TARGET_REOPENED: null,
    USER_ASSIGNS_PROJECT: 'FILED',
    SCOPE_LOST: 'ABANDONED',
  },
};

/**
 * §6's transition function. Total over the closed sets, `null` where the cell says the event is
 * refused: an unknown state or event throws rather than returning null, because "this event does
 * not apply here" and "I have never heard of this event" must not answer the same.
 */
export function nextScopeWorkState(
  state: ScopeWorkState,
  event: ScopeWorkEvent,
): ScopeWorkState | null {
  const row = SCOPE_WORK_TRANSITIONS[state];
  if (!row) throw new Error(`unknown scope work state: ${state}`);
  if (!(event in row)) throw new Error(`unknown scope work event: ${event}`);
  return row[event];
}

/**
 * §2's scope token: the wire form of "which coordination scope authored this write".
 *
 * Derived, never secret, and never trusted from a client — the server recomputes it from the row
 * it read under the lock and compares. Two honest reasons it exists rather than sending the pair:
 * one opaque field cannot half-arrive (a projectId that agrees with a generation that does not is
 * not representable), and a write carries one column that says what it was authored under, which is
 * what makes the audit answerable after the fact.
 *
 * The shape follows `rotateCoordinatorSessionIdempotencyKey`: raw UUID, not Base62, because an
 * internal identity that re-encodes when the public codec changes renames every historical row.
 */
export function projectScopeToken(projectId: string, generation: bigint | string | number): string {
  return `psc:v1:${projectId}:${generation}`;
}

/**
 * §9, as data: which of the project's twelve stated acceptance criteria each clause of this
 * contract is answerable under.
 *
 * This is the difference between a contract and a prompt. A frozen document that no acceptance
 * criterion points at is a document the project can be declared DONE without ever having read;
 * mapping each clause onto a criterion the project ALREADY states means the acceptance run that
 * answers criterion 4 or 9 has to answer for these rules too. The criteria are not restated here —
 * the ordinals below name criteria the project itself states, rather than a copy that can drift.
 */
export const SCOPE_ACCEPTANCE_MAP: Readonly<Record<string, readonly number[]>> = {
  // Scope is an authorization boundary before it is anything else.
  'SC1': [4, 9],
  'SC2': [4, 9],
  'SC3': [5, 9],
  'SC4': [2, 9],
  // Ownership vs provenance: what acceptance counts, and what it must not count.
  'SC5': [4, 12],
  'SC6': [5, 12],
  'SC7': [5, 12],
  // Refusals are structured, owned and never silent.
  'SC8': [3, 8],
  // Recovery, takeover and mixed-version deployments.
  'SC9': [9, 11],
  'SC10': [11, 12],
};

/**
 * §4, as data: the decision, as an ORDERED list of rules. First match wins, and the list is total —
 * `R15_IN_SCOPE` has no predicate, so every input reaches exactly one rule.
 *
 * Order is not presentation. It is the whole of PAC §12 E3 ("one input, one code") on a path where
 * several predicates are true at once all the time: a stale coordinator writing into another
 * project's settled goal satisfies four of these. The order says which fact is the one worth
 * telling it, and it goes: who you are (R1) → whether you hold a live scope at all (R2, R3, R5) →
 * whether the write names a goal (R4) → whether it stays inside the scope (R6, R7) → whether the
 * goal is still open to work (R8) → what the user answered about the crossing (R9–R13).
 *
 * R8 sits ABOVE the approval rules on purpose: an approval must never be able to buy a way into a
 * settled project, or an accepted project silently gains work and its acceptance record becomes a
 * claim about a world that no longer exists.
 */
export interface ScopeRule {
  id: string;
  /** The refusal this rule lands on, or null for the two rules that allow. */
  code: ScopeRefusalCode | null;
  requiredAction: ScopeRequiredAction | null;
}

export const SCOPE_RULES: readonly ScopeRule[] = [
  { id: 'R1_USER_AUTHORITY', code: null, requiredAction: null },
  { id: 'R2_TOKEN_INCONSISTENT', code: 'PROJECT_SCOPE_MISMATCH', requiredAction: 'RE_DERIVE_SCOPE' },
  { id: 'R3_SCOPE_MOVED', code: 'COORDINATOR_GENERATION_MOVED', requiredAction: 'YIELD_TO_CURRENT_SCOPE' },
  { id: 'R4_NO_TARGET_PROJECT', code: 'UNMAPPED_PROJECT_WORK', requiredAction: 'NAME_OWNING_PROJECT' },
  { id: 'R5_NO_SCOPE', code: 'PROJECT_SCOPE_MISMATCH', requiredAction: 'YIELD_TO_CURRENT_SCOPE' },
  { id: 'R6_OUT_OF_SCOPE', code: 'PROJECT_SCOPE_MISMATCH', requiredAction: 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF' },
  { id: 'R7_UNDECLARED_CROSSING', code: 'PROJECT_SCOPE_MISMATCH', requiredAction: 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF' },
  { id: 'R8_SETTLED_PROJECT', code: 'PROJECT_REOPEN_REQUIRED', requiredAction: 'REOPEN_PROJECT_FIRST' },
  { id: 'R9_APPROVAL_TARGET_MISMATCH', code: 'APPROVAL_TARGET_MISMATCH', requiredAction: 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF' },
  { id: 'R10_NO_APPROVAL', code: 'CROSS_PROJECT_APPROVAL_REQUIRED', requiredAction: 'AWAIT_HANDOFF_APPROVAL' },
  { id: 'R11_APPROVAL_PENDING', code: 'APPROVAL_PENDING', requiredAction: 'AWAIT_HANDOFF_APPROVAL' },
  { id: 'R12_APPROVAL_DENIED', code: 'APPROVAL_DENIED', requiredAction: 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF' },
  { id: 'R13_APPROVAL_EXPIRED', code: 'APPROVAL_EXPIRED', requiredAction: 'AWAIT_HANDOFF_APPROVAL' },
  { id: 'R14_HANDOFF_APPROVED', code: null, requiredAction: null },
  { id: 'R15_IN_SCOPE', code: null, requiredAction: null },
];

export type ScopeRuleId = (typeof SCOPE_RULES)[number]['id'];

/** Rule id → its row, for the decision function and for anything reporting a decision. */
export const SCOPE_RULE_BY_ID: Readonly<Record<string, ScopeRule>> = Object.fromEntries(
  SCOPE_RULES.map((rule) => [rule.id, rule]),
);

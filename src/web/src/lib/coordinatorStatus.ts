/**
 * The reading half of `GET /projects/:id/coordinator/status` (unit 20, contract AC10): the shape
 * it answers with, and the sentences the Coordinator surface says about it.
 *
 * Everything here is a projection of what the server already decided. Nothing recomputes a run
 * state, a blocker, a wake, a budget or an acceptance verdict — the endpoint exists precisely so
 * that one reader cannot answer "why is this project not moving" differently from the loop that
 * moved it, and a second opinion assembled in the browser is exactly that drift.
 *
 * THREE RULES this module exists to hold, all of them about not lying by omission:
 *
 *  1. **An absent fact is rendered, never skipped.** The server pairs every nullable field with a
 *     closed-set `…AbsentReason`; {@link absentReasonText} turns each one into a sentence, and a
 *     reason this build has never heard of becomes "this build cannot explain it" rather than
 *     blank. A missing number must never paint as `0`, a missing blocker never as healthy, and a
 *     missing acceptance run never as passed.
 *  2. **No fallback is implied.** A provider that is down and a runner that is offline are two
 *     different waits, and neither of them is "we will use another one". The copy in
 *     {@link BLOCKER_KIND_COPY} says what is actually waited on; nothing here suggests a silent
 *     switch, because the loop performs none.
 *  3. **A control is disabled with a reason or not at all.** {@link triggerRefusal} and
 *     {@link policyRefusal} answer the same refusals the server would answer, before the request,
 *     so a disabled button always names what would have refused it.
 */

import { ApiError } from '../api';

/** Which absent-reason sentence, if any, applies. The server's set is closed; the type is not, so
 *  a server that grows one more reason renders it rather than dropping it (see the fallback in
 *  {@link absentReasonText}). */
export type AbsentReason = string;

/** The lifecycle of the WORK. A project is never IN_PROGRESS — that is `runState`. */
export type ProjectLifecycle = 'OPEN' | 'DONE' | 'CANCELLED';

/** How far the coordinator may go when it runs. Not a switch: `coordinatorEnabled` is. */
export type AutomationPolicy = 'MANUAL' | 'GUARDED_AUTO' | 'AUTO';

export interface CoordinatorSessionState {
  id: string;
  runStatus: string;
  runState: string;
  lifecycleState: string;
  endReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  completedAt: string | null;
  deletedAt: string | null;
}

export interface CoordinatorAction {
  id: string;
  decisionId: string | null;
  type: string;
  status: string;
  subjectType: string | null;
  subjectId: string | null;
  idempotencyKey: string | null;
  refusalCode: string | null;
  reasonCode: string | null;
  resultSessionId: string | null;
  fencingToken: string;
  createdAt: string;
  updatedAt: string;
}

export interface CoordinatorDecision {
  id: string;
  createdAt: string;
  decidedBy: string | null;
  reason: string | null;
  decisionInputHash: string | null;
  fencingToken: string;
  coordinatorAgentId: string | null;
  coordinatorSessionId: string | null;
  runStateBefore: string | null;
  runStateAfter: string | null;
  configRevision: string | null;
  nextWakeAt: string | null;
  nextWakeReason: string | null;
  actions: CoordinatorAction[];
}

export interface CoordinatorEvent {
  id: string;
  kind: string;
  occurredAt: string;
  sourceType: string | null;
  sourceId: string | null;
  dedupeKey: string | null;
  occurrences: number;
  lastAt: string;
  attempts: number;
  nextAttemptAt: string | null;
  consumedAt: string | null;
  disposition: string | null;
}

export interface CoordinatorBlocker {
  id: string;
  kind: string;
  owner: string;
  recovery: string;
  severity: string;
  requiredAction: string;
  nextCheckAt: string;
  subjectType: string;
  subjectId: string;
  lifecycleGeneration: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  escalatedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  raisedByActionId: string | null;
  raisedByActionStatus: string | null;
  detail?: unknown;
}

/** One wake candidate the DECIDING pass recorded (§10.4 W5 clause 4) — read back, never recomputed
 *  here, so the losers shown are the ones a decision actually weighed. */
export interface WakeCandidate {
  at?: string | null;
  reason?: string | null;
  [key: string]: unknown;
}

export interface MergeEvidence {
  sessionId: string;
  taskId: string | null;
  taskTitle: string | null;
  taskStatus: string | null;
  branch: string | null;
  baseSha: string | null;
  mergeStatus: string | null;
  mergeTarget: string | null;
  mergedSourceSha: string | null;
  branchMerged: boolean | null;
  mergedAt: string | null;
  commitStatus: string | null;
  worktreeDirty: boolean | null;
}

export interface CoordinatorStatus {
  projectId: string;
  readAt: string;
  project: {
    title: string;
    status: ProjectLifecycle;
    createdAt: string;
    updatedAt: string;
    taskCount: number;
    tasksByStatus: Record<string, number>;
  };
  coordination: {
    agentId: string | null;
    agentIdAbsentReason: AbsentReason | null;
    agentName: string | null;
    identitySource: 'DERIVED' | 'EXPLICIT' | string;
    workspaceId: string | null;
    workspaceIdAbsentReason: AbsentReason | null;
    generation: string;
    sessionId: string | null;
    sessionIdAbsentReason: AbsentReason | null;
    session: CoordinatorSessionState | null;
    sessionAbsentReason: AbsentReason | null;
  };
  policy: {
    coordinatorEnabled: boolean;
    automationPolicy: AutomationPolicy | string;
    configRevision: string;
    maxConcurrentTasks: number;
    sessionBudgetPerDay: number | null;
    sessionBudgetPerDayAbsentReason: AbsentReason | null;
  };
  consumption: {
    tasksInFlight: number;
    concurrencyRemaining: number;
    coordinatorSessionsLast24h: number;
    budgetRemaining: number | null;
    budgetRemainingAbsentReason: AbsentReason | null;
    budgetWindowStartedAt: string;
  };
  runtime: {
    runState: string;
    lease: { expiresAt: string; heartbeatAt: string | null; fencingToken: string } | null;
    leaseAbsentReason: AbsentReason | null;
    fencingToken: string;
    acceptanceAttempt: string;
  };
  nextWake: {
    at: string | null;
    reason: string | null;
    absentReason: AbsentReason | null;
    candidates: WakeCandidate[];
    candidatesAbsentReason: AbsentReason | null;
    flooredBy: string | null;
    decisionId: string | null;
  };
  decisions: CoordinatorDecision[];
  decisionsEmptyReason: AbsentReason | null;
  pendingActions: CoordinatorAction[];
  pendingActionsEmptyReason: AbsentReason | null;
  blockers: {
    open: CoordinatorBlocker[];
    openEmptyReason: AbsentReason | null;
    resolved: CoordinatorBlocker[];
  };
  events: {
    pending: CoordinatorEvent[];
    pendingEmptyReason: AbsentReason | null;
    recent: CoordinatorEvent[];
  };
  acceptance: {
    criteria: string | null;
    criteriaAbsentReason: AbsentReason | null;
    attempt: string;
    /** §13.4's native acceptance record: the latest attempt, its per-criterion conclusions and the
     *  digest of the facts it judged. Null until one has been run — and "never attempted" is
     *  rendered as itself, because a screen that drew it as a clean slate would be claiming a pass
     *  nobody ran. */
    run: AcceptanceRun | null;
    runAbsentReason: AbsentReason | null;
    /** Whether a DONE would be allowed right now, decided by the same code the write path runs
     *  (§13.4 AE2). Served so this screen can say what is missing BEFORE somebody presses a button
     *  and gets a 409 — it is a report of the gate, never a second opinion about it. */
    doneGate: {
      allowed: boolean;
      runId: string | null;
      refusalCode: string | null;
      reason: string | null;
      acceptanceDigest: string;
    };
    lastRun: CoordinatorAction | null;
    lastRunAbsentReason: AbsentReason | null;
    evidence: {
      verifications: {
        total: number;
        pending: number;
        pass: number;
        fail: number;
        inconclusive: number;
        unresolvedFailures: number;
      };
      merges: MergeEvidence[];
      mergesEmptyReason: AbsentReason | null;
      /**
       * §13.8: @-mentions in this project that nobody has received.
       *
       * Only BLOCKED and DEAD — a mention in flight is not a project condition, and listing it here
       * would bury the ones that are. Absent on a status read from a server that predates the
       * ledger, which is why it is optional rather than an empty array.
       */
      undeliveredMentions?: UndeliveredMention[];
      undeliveredMentionsEmptyReason?: AbsentReason | null;
    };
  };
}

/** One @-mention that has not reached the agent it named, with what would clear it. */
export interface UndeliveredMention {
  id: string;
  taskId: string;
  workspaceId: string;
  status: 'BLOCKED' | 'DEAD';
  attempts: number;
  errorCode: string | null;
  requiredAction: string | null;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
}

/** One stated criterion and what the attempt concluded about it (§13.4 clause 3). */
export interface AcceptanceCriterion {
  id: string;
  ordinal: number;
  criterionKey: string;
  criterionText: string;
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | null;
  summary: string | null;
  evidence: unknown;
  evidenceTaskId: string | null;
  evidenceSessionId: string | null;
  decidedAt: string | null;
}

/** One attempt at project-level acceptance. */
export interface AcceptanceRun {
  id: string;
  attempt: string;
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | null;
  decidedBy: string;
  criteriaRevision: string;
  inputDigest: string;
  resultDigest: string | null;
  supersededAt: string | null;
  supersededReason: string | null;
  startedAt: string;
  completedAt: string | null;
  criteria: AcceptanceCriterion[];
}

/**
 * What each DONE refusal means, in the words somebody can act on.
 *
 * The codes are the server's closed set; an unknown one is NAMED rather than dropped, for the same
 * reason `ABSENT_REASON_TEXT` names one — a refusal this build cannot explain is still a refusal,
 * and hiding it would read as "nothing is wrong".
 */
export const DONE_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  ACCEPTANCE_MISSING:
    'No usable acceptance PASS stands behind this project: none has been run, the latest has not concluded, it concluded FAIL or INCONCLUSIVE, or it was recorded by a person rather than the coordinator agent.',
  ACCEPTANCE_EVIDENCE_STALE:
    'An acceptance did pass, but not against these facts — a task, a verdict, the acceptance criteria or the target branch content has changed since it ran. Run acceptance again.',
  ACCEPTANCE_BLOCKED:
    'Something this project already knows about is unfinished: an open blocker, or a verification failure nobody has resolved.',
};

/**
 * One sentence per closed-set absent reason (`COORDINATOR_STATUS_ABSENT_REASONS`).
 *
 * Each is written to be readable where the value would have been, and each is careful about the
 * distinction its reason exists to draw: "never opened" is not "was opened and trashed", "no
 * limit" is not "a limit of zero", and "never attempted" is neither a pass nor a failure.
 */
export const ABSENT_REASON_TEXT: Readonly<Record<string, string>> = {
  // §13.8. Not "this build cannot explain it" — the ledger was read and it is empty, which is the
  // healthy case and deserves to say so.
  NO_UNDELIVERED_MENTION: 'Every @-mention in this project reached the agent it named.',
  // Distinct from the line above on purpose: "nothing is stuck" and "nobody was tracking" are
  // different answers, and only one of them is reassuring.
  MENTION_AUDIT_UNAVAILABLE:
    'This server does not track @-mention delivery, so whether every mention arrived was never recorded.',
  NO_COORDINATOR_AGENT: 'No agent holds this project’s coordinator seat, so nothing is deciding for it.',
  COORDINATOR_NEVER_OPENED: 'The coordination conversation has never been opened.',
  COORDINATOR_SESSION_TRASHED:
    'The coordination conversation was opened and later trashed. This project has been coordinated before; the next open starts a replacement.',
  NO_COORDINATION_WORKSPACE:
    'No default coordination workspace is recorded — one is written when a coordinator is bound.',
  UNLIMITED: 'Deliberately uncapped — no daily limit is set. This is not a limit of zero.',
  NOT_LEASED: 'Nobody holds the reconcile lease right now, which is the normal state between passes.',
  NO_WAKE_SCHEDULED: 'No wake is scheduled: nothing is waiting on a clock.',
  NO_DECISION_YET: 'This project has never been reconciled, so there is no decision to report.',
  DECISION_PREDATES_WAKE_AUDIT:
    'The most recent decision predates the wake audit and recorded no candidates — that is unknown, not none.',
  NO_PENDING_ACTION: 'Nothing is claimed and unpublished, so no action is mid-flight.',
  NO_OPEN_BLOCKER: 'Nothing is blocking this project right now.',
  NO_PENDING_EVENT: 'Every durable signal has been consumed; the outbox is empty.',
  NO_ACCEPTANCE_CRITERIA:
    'This project states no acceptance criteria, so there is nothing to accept it against.',
  ACCEPTANCE_NOT_ATTEMPTED:
    'Project acceptance has never run here. Not attempted is not the same as passed, and not the same as failed.',
  NO_MERGE_EVIDENCE: 'No session in this project has reported a branch, so there is no merge evidence to show.',
};

/**
 * The sentence for an absent reason, or null when the value is present.
 *
 * A reason this build does not recognise is NAMED rather than dropped. The alternative — an empty
 * string — is the one outcome the server's whole closed-set design exists to prevent: a field that
 * renders as nothing is indistinguishable from a field that is fine.
 */
export function absentReasonText(reason: AbsentReason | null | undefined): string | null {
  if (reason == null || reason === '') return null;
  return (
    ABSENT_REASON_TEXT[reason]
    ?? `No value, and this build does not recognise the reason the server gave (${reason}).`
  );
}

/** What a blocker kind means, and what is actually being waited on. */
export interface BlockerKindCopy {
  label: string;
  /** Written to close off the reading the loop never performs: nothing here reassigns a task to a
   *  different provider, runner or agent by itself. */
  note: string;
}

/**
 * §11.2's kind set in the reader's words.
 *
 * The three that get confused with each other are deliberately spelled apart: a PROVIDER that is
 * unavailable, a RUNNER that no online machine matches, and a RUNTIME that is missing on the
 * runners there are. Each waits on a different thing, and none of them is answered by quietly
 * running the work somewhere else.
 */
export const BLOCKER_KIND_COPY: Readonly<Record<string, BlockerKindCopy>> = {
  WHO_UNRESOLVED: {
    label: 'No agent resolved',
    note: 'The task names no agent this project’s team can resolve. Nothing is assigned on its behalf.',
  },
  WHO_NOT_IN_TEAM: {
    label: 'Assignee is not on the team',
    note: 'The assigned agent is not a member of this project. It is not added automatically.',
  },
  WHO_DISABLED: {
    label: 'Assignee is disabled',
    note: 'The assigned agent is disabled. It is not re-enabled and the task is not reassigned automatically.',
  },
  PROVIDER_UNAVAILABLE: {
    label: 'Provider unavailable',
    note: 'The provider this work runs on is not answering. The work waits for it — it is not moved to a different provider.',
  },
  RUNTIME_REQUIREMENT_UNMET: {
    label: 'Runtime missing on every runner',
    note: 'The runners that are online do not have the runtime this task requires. Nothing installs it for you.',
  },
  NO_PROJECT_WORKSPACE: {
    label: 'No project workspace',
    note: 'This project has no workspace to run in, and one is not chosen on your behalf.',
  },
  NO_MATCHING_RUNNER: {
    label: 'No matching runner online',
    note: 'No online runner satisfies this task — it is offline, busy or unmatched. The work waits for one; it is not rerouted to a runner that does not match.',
  },
  MERGE_CONFLICT: {
    label: 'Merge conflict',
    note: 'A branch could not be merged. Nothing is force-merged or discarded to get past it.',
  },
  TEST_FAILED: {
    label: 'Automatic retries exhausted',
    note: 'This task kept failing and has spent its automatic retries. It is not retried again on its own.',
  },
  VERIFICATION_FAILED: {
    label: 'Verification failed',
    note: 'A check concluded something other than PASS. The conclusion stands until the check is re-run.',
  },
  BUDGET_EXHAUSTED: {
    label: 'Daily session budget spent',
    note: 'The rolling 24h budget is used up. It rolls over on its own; raising the budget ends the wait sooner.',
  },
  AWAITING_USER_APPROVAL: {
    label: 'Waiting for your approval',
    note: 'An action is waiting on a person. It is answered in the session that asked, not from here.',
  },
  AWAITING_USER_INPUT: {
    label: 'Waiting for your answer',
    note: 'A session asked you a question. It is answered in that session, not from here.',
  },
  POLICY_MANUAL_HOLD: {
    label: 'Held by MANUAL policy',
    note: 'Automation is set to MANUAL, so steps that would change something wait for you. This is a choice, not a fault.',
  },
  DEPENDENCY_CYCLE: {
    label: 'Dependency cycle',
    note: 'Tasks in this project depend on each other in a loop. The loop is not broken automatically.',
  },
  COORDINATOR_UNAVAILABLE: {
    label: 'Coordinator unavailable',
    note: 'This project has no coordinator agent with a live coordination workspace. No stand-in is appointed.',
  },
  COORDINATOR_NO_PROGRESS: {
    label: 'Coordinator made no progress',
    note: 'The coordinator ran on these exact facts and changed none of them, so it is not run again on them.',
  },
  UNKNOWN_FAILURE: {
    label: 'Unclassified failure',
    note: 'Something failed that this build cannot classify. Automatic dispatch stops until somebody looks.',
  },
};

/** The copy for a kind, or the kind verbatim when a newer server sends one this build predates —
 *  an unrecognised blocker still has to read as a blocker, not as nothing. */
export function blockerKindCopy(kind: string): BlockerKindCopy {
  return (
    BLOCKER_KIND_COPY[kind]
    ?? {
      label: kind,
      note: 'This build does not recognise this blocker kind. Read the required action below.',
    }
  );
}

/** How a severity paints. CRITICAL is the only one that reads as an error; an expected wait must
 *  not, or every MANUAL project would look broken. */
export const BLOCKER_SEVERITY_COLOR: Readonly<Record<string, string>> = {
  INFO: 'blue',
  WARNING: 'gold',
  CRITICAL: 'red',
};

/**
 * The three automation levels, said accurately.
 *
 * MANUAL is the one most often mis-described. It is not "off" — the loop still works out the next
 * step and records it; it turns every step that would change something into a request. Off is
 * `coordinatorEnabled`, which is a separate switch precisely so that pausing cannot overwrite the
 * level you paused from.
 */
export const AUTOMATION_POLICY_COPY: Readonly<Record<string, { label: string; description: string }>> = {
  MANUAL: {
    label: 'Manual',
    description:
      'The coordinator still works out and records the next step, but every step that would change something waits for you. This is not “off”.',
  },
  GUARDED_AUTO: {
    label: 'Guarded auto',
    description:
      'The coordinator acts on its own within this project’s limits, and still stops at the boundaries that need a person.',
  },
  AUTO: {
    label: 'Auto',
    description:
      'The coordinator acts on its own wherever its limits allow. Raise this only for a project you are willing to leave running.',
  },
};

export function automationPolicyCopy(policy: string): { label: string; description: string } {
  return (
    AUTOMATION_POLICY_COPY[policy]
    ?? {
      label: policy,
      description: 'This build does not recognise this automation policy, so it cannot describe what it permits.',
    }
  );
}

/**
 * What a `runState` means, and how it paints.
 *
 * `unknown: true` is what stops a state this build predates from being drawn as a healthy one:
 * an unrecognised state is shown verbatim, in the neutral colour, and said to be unrecognised.
 */
export const RUN_STATE_COPY: Readonly<Record<string, { color: string; description: string }>> = {
  PLANNING: { color: 'blue', description: 'Working out what to do next.' },
  EXECUTING: { color: 'green', description: 'Tasks are being dispatched and run.' },
  AWAITING_VERIFICATION: { color: 'gold', description: 'Work is done and waiting on its checks.' },
  BLOCKED: { color: 'red', description: 'Something is stopping it — see Blockers.' },
  AWAITING_HUMAN: { color: 'gold', description: 'Waiting on a person before anything else happens.' },
  ACCEPTANCE: { color: 'purple', description: 'Being judged against this project’s acceptance criteria.' },
  SETTLED: { color: 'default', description: 'This project is DONE or CANCELLED; its coordinator does not run.' },
};

export function runStateCopy(state: string): { color: string; description: string; unknown: boolean } {
  const known = RUN_STATE_COPY[state];
  return known
    ? { ...known, unknown: false }
    : {
      color: 'default',
      description: 'This build does not recognise this run state, so it cannot say what it means.',
      unknown: true,
    };
}

/** Why a control cannot be pressed. A closed set, because each one is rendered as its own sentence
 *  and a free-text reason is one nobody can branch on. */
export type ControlRefusalCode =
  | 'READ_ONLY'
  | 'STATUS_UNKNOWN'
  | 'STALE_CONFLICT'
  | 'PROJECT_SETTLED'
  | 'COORDINATOR_DISABLED'
  | 'IN_FLIGHT';

export interface ControlRefusal {
  code: ControlRefusalCode;
  message: string;
}

export interface ControlGate {
  status: CoordinatorStatus | undefined | null;
  /** Set once the server has answered a control write with 403 — the signed-in user may read this
   *  project but not drive it. Never guessed from the payload: the read face carries no permission
   *  field, and inventing one here would either hide a control that works or offer one that does not. */
  readOnly?: boolean;
  /** A write of this kind is already on the wire. */
  pending?: boolean;
  /**
   * A compare-and-swap has been refused and not yet acknowledged.
   *
   * It closes the control rather than merely reporting the failure, and that is the point: the
   * next submit would carry the CURRENT `configRevision` and therefore succeed — writing the
   * reader's stale intent straight over the change that refused it. The refusal only means
   * something if it is followed by a look at what changed.
   */
  conflict?: boolean;
}

const READ_ONLY_MESSAGE =
  'This project is readable but not controllable with your account — the server refused the last control write. Its owner keeps the final control.';
const STATUS_UNKNOWN_MESSAGE =
  'The coordinator’s state has not loaded, so there is nothing to press this against. Reload the status first.';
const IN_FLIGHT_MESSAGE = 'A control write is already on the wire. Wait for it to answer.';
const STALE_CONFLICT_MESSAGE =
  'This project’s coordination settings changed after you read them, so the last write was refused and nothing was written. Review the current settings before writing again.';

/**
 * Why "Run now" cannot be pressed, or null when it can.
 *
 * The order is the order the server checks in, and the three middle codes are the three typed
 * refusals `POST …/coordinator/trigger` answers with — so a disabled button here names exactly
 * what a pressed one would have been told, rather than inventing a rule of its own.
 */
export function triggerRefusal(gate: ControlGate): ControlRefusal | null {
  if (gate.readOnly) return { code: 'READ_ONLY', message: READ_ONLY_MESSAGE };
  if (!gate.status) return { code: 'STATUS_UNKNOWN', message: STATUS_UNKNOWN_MESSAGE };
  if (gate.conflict) return { code: 'STALE_CONFLICT', message: STALE_CONFLICT_MESSAGE };
  if (gate.status.project.status !== 'OPEN') {
    return {
      code: 'PROJECT_SETTLED',
      message: `This project is ${gate.status.project.status}, and a settled project’s coordinator does not run. Set it back to OPEN if there is more work to do.`,
    };
  }
  if (!gate.status.policy.coordinatorEnabled) {
    return {
      code: 'COORDINATOR_DISABLED',
      message:
        'This project’s coordinator is switched off, so a trigger would be discarded rather than acted on. Turn it on below — naming an automation level — first.',
    };
  }
  if (gate.pending) return { code: 'IN_FLIGHT', message: IN_FLIGHT_MESSAGE };
  return null;
}

/**
 * Why the policy form cannot be submitted, or null when it can.
 *
 * Deliberately SHORTER than {@link triggerRefusal}: `PATCH /projects/:id` refuses neither a settled
 * project nor a switched-off coordinator, and disabling the form on either would be a rule this app
 * made up — the second of which would also trap the project, since turning the coordinator back on
 * is done from this very form.
 */
export function policyRefusal(gate: ControlGate): ControlRefusal | null {
  if (gate.readOnly) return { code: 'READ_ONLY', message: READ_ONLY_MESSAGE };
  if (!gate.status) return { code: 'STATUS_UNKNOWN', message: STATUS_UNKNOWN_MESSAGE };
  if (gate.conflict) return { code: 'STALE_CONFLICT', message: STALE_CONFLICT_MESSAGE };
  if (gate.pending) return { code: 'IN_FLIGHT', message: IN_FLIGHT_MESSAGE };
  return null;
}

/** What the coordination settings form holds. Every field starts as what the server reported, so
 *  an unchanged form submits the values it was showing rather than clearing them. */
export interface PolicyDraft {
  coordinatorEnabled: boolean;
  automationPolicy: AutomationPolicy | string;
  maxConcurrentTasks: number;
  /** null is a real choice — "no daily limit" — and is sent as null rather than omitted. */
  sessionBudgetPerDay: number | null;
}

export function policyDraftOf(status: CoordinatorStatus): PolicyDraft {
  return {
    coordinatorEnabled: status.policy.coordinatorEnabled,
    automationPolicy: status.policy.automationPolicy,
    maxConcurrentTasks: status.policy.maxConcurrentTasks,
    sessionBudgetPerDay: status.policy.sessionBudgetPerDay,
  };
}

/** Whether the draft still says what the server said. A form with nothing changed has nothing to
 *  submit, and submitting it anyway would bump `configRevision` — invalidating somebody else's
 *  in-flight compare-and-swap for no edit at all. */
export function policyDraftChanged(draft: PolicyDraft, status: CoordinatorStatus): boolean {
  const current = policyDraftOf(status);
  return (
    draft.coordinatorEnabled !== current.coordinatorEnabled
    || draft.automationPolicy !== current.automationPolicy
    || draft.maxConcurrentTasks !== current.maxConcurrentTasks
    || draft.sessionBudgetPerDay !== current.sessionBudgetPerDay
  );
}

/**
 * The body `PATCH /projects/:id` is given for a settings edit.
 *
 * Two things it always does. It carries `expectedConfigRevision`, so a write composed against
 * settings that have since changed is REFUSED rather than merged — last-write-wins on the
 * authorization set is not a merge, it is one person silently undoing another's revoke. And when
 * the switch is going from off to on it always names `automationPolicy`, because the server
 * refuses that request otherwise: turning a project into an automatic one without saying how far
 * it may go would pick a level on the owner's behalf.
 *
 * Only changed fields are sent. An unchanged field left out is what keeps this edit from being a
 * silent re-assertion of a value somebody else has just changed.
 */
export function policyPatchBody(
  draft: PolicyDraft,
  status: CoordinatorStatus,
): Record<string, unknown> {
  const current = policyDraftOf(status);
  const body: Record<string, unknown> = { expectedConfigRevision: status.policy.configRevision };
  const turningOn = draft.coordinatorEnabled && !current.coordinatorEnabled;
  if (draft.coordinatorEnabled !== current.coordinatorEnabled) {
    body.coordinatorEnabled = draft.coordinatorEnabled;
  }
  if (turningOn || draft.automationPolicy !== current.automationPolicy) {
    body.automationPolicy = draft.automationPolicy;
  }
  if (draft.maxConcurrentTasks !== current.maxConcurrentTasks) {
    body.maxConcurrentTasks = draft.maxConcurrentTasks;
  }
  if (draft.sessionBudgetPerDay !== current.sessionBudgetPerDay) {
    body.sessionBudgetPerDay = draft.sessionBudgetPerDay;
  }
  return body;
}

/**
 * How far each level lets the coordinator go, as an order rather than a set.
 *
 * Only used to answer "is this edit an escalation" — which is a question about direction, and the
 * three levels are genuinely ordered: MANUAL asks about everything, GUARDED_AUTO acts inside the
 * project's limits and stops at the boundaries that need a person, AUTO acts wherever its limits
 * allow.
 */
export const AUTOMATION_RANK: Readonly<Record<string, number>> = {
  MANUAL: 0,
  GUARDED_AUTO: 1,
  AUTO: 2,
};

/**
 * What about this edit hands the coordinator more room, or null when it hands it none.
 *
 * The three shapes an escalation takes, and none of them is "a bigger number": raising a
 * concurrency cap lets a project do the same kind of thing faster, while these three change what
 * it may do without asking. Each is stated as the sentence the reader has to confirm, so a
 * project is never made autonomous by an edit somebody made for another reason.
 *
 * A LEVEL this build does not recognise is treated as an escalation whenever it differs, because
 * an unknown rank cannot be shown to be a step down — and the safe reading of "I do not know how
 * much authority this grants" is to ask.
 */
export function policyEscalation(draft: PolicyDraft, status: CoordinatorStatus): string | null {
  const current = policyDraftOf(status);
  const reasons: string[] = [];
  if (draft.coordinatorEnabled && !current.coordinatorEnabled) {
    reasons.push('switches this project’s coordinator on, so it starts acting on its own schedule');
  }
  if (draft.automationPolicy !== current.automationPolicy) {
    const to = AUTOMATION_RANK[draft.automationPolicy];
    const from = AUTOMATION_RANK[current.automationPolicy];
    if (to === undefined || from === undefined || to > from) {
      reasons.push(
        `moves automation from ${automationPolicyCopy(current.automationPolicy).label} to ${automationPolicyCopy(draft.automationPolicy).label}`,
      );
    }
  }
  if (draft.sessionBudgetPerDay === null && current.sessionBudgetPerDay !== null) {
    reasons.push('removes the daily session budget, leaving how much it may start uncapped');
  }
  if (reasons.length === 0) return null;
  return `This ${reasons.join(', and ')}.`;
}

/**
 * The body `POST /projects/:id/coordinator/trigger` is given.
 *
 * `expectedConfigRevision` for the same reason the settings write carries one: the button was
 * pressed against a policy the reader could see, and a policy that has changed since is one they
 * did not agree to run under.
 *
 * `triggerId` names the PRESS, not the run. It is generated when the button goes down and kept
 * until that press is answered, so a retry after a timeout is the SAME request rather than a second
 * coordination pass — the durable signal coalesces on it. A build with no id to give sends none and
 * lets the server allocate one, which is honest for a first press and costs idempotency only on a
 * retry.
 */
export function triggerBody(
  status: CoordinatorStatus,
  triggerId: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = { expectedConfigRevision: status.policy.configRevision };
  if (triggerId) body.triggerId = triggerId;
  return body;
}

/**
 * The compare-and-swap failure, told apart from every other 409.
 *
 * `POST …/coordinator` answers 409 for "already coordinating elsewhere", and the trigger answers
 * 409 for a settled project and for a disabled coordinator. Only `STALE_CONFIG_REVISION` means
 * "somebody changed this under you" — the one that must never be retried automatically, because
 * the request was composed against settings that no longer exist. Matched on the server's own
 * `code`, not on its prose.
 */
export function isStaleConfigRevision(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'STALE_CONFIG_REVISION';
}

/** Whether the server refused this control write as a permission failure. Flips the surface into
 *  read-only rather than leaving a button that always fails. */
export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

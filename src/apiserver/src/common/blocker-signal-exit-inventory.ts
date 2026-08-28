/**
 * Exit conditions for every durable open blocker or signal understood by the API server.
 *
 * WHY THIS IS AN INVENTORY
 * ------------------------
 * Opening a state is easy to see at the call site; the transition that makes it stop being true
 * often belongs to a later event and a different service. That asymmetry has repeatedly produced
 * half state machines. This table makes the other edge part of declaring the type. The contract in
 * `blocker-signal-exit-inventory.spec.ts` derives the live `project_blocker.kind` set by replaying
 * migrations, derives durable signal-code declarations with a whole-source syntax scan, and
 * refuses a declaration that has no row here.
 *
 * This is intentionally an inventory, not a new runtime dispatcher. Some project-blocker kinds
 * survive the deleted coordinator control loop as database-compatible history, and this task does
 * not reintroduce or refactor that loop. `resolveWhen` states the predicate that ends an episode;
 * the service that owns that predicate remains the service that applies it.
 *
 * SCOPE
 * -----
 * `PROJECT_BLOCKER` is the closed set enforced by `project_blocker_kind_chk`. `DURABLE_SIGNAL` is
 * a named `*_SIGNAL_CODE`, `*_SIGNAL_KIND`, or `*_SIGNAL_TYPE` (or an inline `signalCode` /
 * `signalKind` / `signalType` literal) whose episode can remain open after the producing call.
 * Coordinator wake events are append-only facts with a terminal receipt, not open states, and
 * therefore are not entries in this table.
 */

export type BlockerSignalFamily = 'PROJECT_BLOCKER' | 'DURABLE_SIGNAL';

export interface BlockerSignalExitRegistration {
  family: BlockerSignalFamily;
  type: string;
  /** A falsifiable condition for the open episode to end, not merely an imperative like "fix it". */
  resolveWhen: string;
}

export const BLOCKER_SIGNAL_EXIT_INVENTORY = [
  {
    family: 'PROJECT_BLOCKER',
    type: 'WHO_UNRESOLVED',
    resolveWhen:
      'The task ceases to be live work, or its latest dispatch is no longer refused as WHO_UNRESOLVED after an assignee is selected.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'WHO_NOT_IN_TEAM',
    resolveWhen:
      'The task ceases to be live work, or its latest dispatch is no longer refused as WHO_NOT_IN_TEAM after the assignee joins the project team or is replaced.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'WHO_DISABLED',
    resolveWhen:
      'The task ceases to be live work, or its latest dispatch is no longer refused as WHO_DISABLED after the assignee is enabled or replaced.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'PROVIDER_UNAVAILABLE',
    resolveWhen:
      'The task ceases to be live work, or a later dispatch no longer reports PROVIDER_UNAVAILABLE because the provider recovered or the task was pinned elsewhere.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'RUNTIME_REQUIREMENT_UNMET',
    resolveWhen:
      'The task ceases to be live work, or a later dispatch no longer reports RUNTIME_REQUIREMENT_UNMET after a runner satisfies the requirement or the requirement is removed.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'NO_PROJECT_WORKSPACE',
    resolveWhen:
      'The project has at least one enabled, non-deleted workspace, or the affected task ceases to be live work and no later dispatch repeats this refusal.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'NO_MATCHING_RUNNER',
    resolveWhen:
      'The task ceases to be live work, or a later dispatch finds an online runner satisfying the task and no longer reports NO_MATCHING_RUNNER.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'MERGE_CONFLICT',
    resolveWhen:
      'No non-obsolete branch evidence for the subject task still reports mergeStatus=conflict, normally because the branch merged or the attempt was replaced.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'TEST_FAILED',
    resolveWhen:
      'The exhausted task is settled, cancelled, or retired after review, so its terminal failure-budget condition is no longer part of the live project work.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'VERIFICATION_FAILED',
    resolveWhen:
      'The current verification consequence no longer raises a non-PASS condition because a later check passes, the verdict is revoked or replaced, or the subject becomes obsolete.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'BUDGET_EXHAUSTED',
    resolveWhen:
      'The rolling daily dispatch count falls below sessionBudgetPerDay because its oldest counted action leaves the window, or the configured budget is raised or removed.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'AWAITING_USER_APPROVAL',
    resolveWhen:
      'The referenced approval is approved, denied, expired, or withdrawn, leaving no unanswered approval request for this episode.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'AWAITING_USER_INPUT',
    resolveWhen:
      'The referenced session leaves AWAITING_INPUT, is deleted, or belongs to an attempt whose task has been retired or superseded.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'POLICY_MANUAL_HOLD',
    resolveWhen:
      'The project is no longer MANUAL, or no eligible task remains held because the work was manually started, settled, cancelled, or otherwise became ineligible.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'DEPENDENCY_CYCLE',
    resolveWhen:
      'The combined prerequisite and parent-child graphs contain no cycle for the project after an edge is removed or the affected work is retired.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'COORDINATOR_UNAVAILABLE',
    resolveWhen:
      'The project again has an enabled coordinator agent and usable coordination workspace, or a task-scoped refusal is superseded by a later admissible dispatch.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'COORDINATOR_NO_PROGRESS',
    resolveWhen:
      'Strict acceptance progress or a changed project scope creates a new convergence question, or a person deliberately changes the convergence threshold and acknowledges the stopped episode.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'AGGREGATE_PARENT_UNSATISFIABLE',
    resolveWhen:
      'The aggregate parent gains or restores a child that can complete it, changes completion policy, or the parent itself is settled, cancelled, or retired.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'SUCCESSOR_OUTSIDE_SUBTREE',
    resolveWhen:
      'The replacement work is re-parented under the aggregate parent, the child retirement is cleared, the retired child is removed, or the parent ceases to be live work.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'VERIFICATION_REQUIRED',
    resolveWhen:
      'A live verification task is filed for the subject, its completion policy changes, or the subject is settled, cancelled, retired, or superseded.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'VERIFICATION_CANNOT_CONCLUDE',
    resolveWhen:
      'The check records a verdict, or that inconclusive check is cancelled, replaced, retired, or made obsolete with its subject.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'ENVIRONMENT_BROKEN',
    resolveWhen:
      'A later current-scope finding no longer classifies the environment as broken after repair, or the finding or its task is invalidated, retired, or superseded.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'HUMAN_DECISION_REQUIRED',
    resolveWhen:
      'For evidence-bound completion this is the project_judgment_blocker view and disappears exactly when its judgment request is DECIDED or SUPERSEDED; legacy stored episodes also resolve when that request is created.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'VERDICT_APPLY_EXHAUSTED',
    resolveWhen:
      'The refusal named by the exhausted apply is fixed and a fresh verdict revision applies successfully, or the affected check is retired or superseded.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'COMPLETION_ACK_STALE',
    resolveWhen:
      'The exact legacy v1 turn is ACKed and a matching DECIDED EXECUTABLE request/result canonically projects its PASS or FAIL outcome; the append-only incident and repair facts remain after the active projection and blocker close.',
  },
  {
    family: 'PROJECT_BLOCKER',
    type: 'UNKNOWN_FAILURE',
    resolveWhen:
      'The unclassified failure or dead-letter loss is acknowledged and cleared, or later attributable evidence replaces it and the original subject is settled or obsolete.',
  },
  {
    family: 'DURABLE_SIGNAL',
    type: 'ATTEMPT_ENDED_WITHOUT_JUDGMENT_PATH',
    resolveWhen:
      'The task is deleted, DONE or CANCELLED, records a later FAILED decision, or gains an evidence-bound judgment request; its timeline comment remains append-only audit evidence.',
  },
  {
    family: 'DURABLE_SIGNAL',
    type: 'OPEN_JUDGMENT_REQUEST',
    resolveWhen:
      'The bound task_judgment_request becomes DECIDED from its declared consumer or SUPERSEDED by a substantively new evidence revision; the request and old evidence remain auditable.',
  },
  {
    family: 'DURABLE_SIGNAL',
    type: 'EXECUTABLE_ACCEPTANCE_UNAVAILABLE',
    resolveWhen:
      'A later reserved EXECUTABLE turn records a comparable command result, or the task is explicitly failed, cancelled, retired, or otherwise ceases to await this criterion; the timeline comment remains append-only audit evidence.',
  },
] as const satisfies readonly BlockerSignalExitRegistration[];

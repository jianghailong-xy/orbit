/**
 * Unit L4: the explicit cross-project handoff — its three `HANDOFF_*` states, landed.
 *
 * L1 froze the rules and left this unit one job (§10): make `HANDOFF_TASK` reachable. Today it is
 * not — `decideProjectScopeWrite` has R9–R14 and nothing in the product can produce the approval
 * they read, so every crossing an agent attempts dies at R7 and the only cross-project work that
 * happens is the kind L1 exists to prevent. The gap is not a missing endpoint. It is a missing
 * FACT: "the user said yes to THIS crossing" is not derivable from any column the schema has.
 *
 * WHY THIS IS A ROW AND NOT A DERIVATION (§8 CM3)
 * ----------------------------------------------
 * CM3 says the scope machine adds no entity and derives its states from existing facts, and this
 * module obeys it everywhere it can: `DISCOVERED`, `FILED`, `UNMAPPED` and `ABANDONED` are still
 * read off `task` columns — nothing here stores them. But §6 also says, in the transition table
 * itself, that `APPROVE` and `APPLY` are two different events, "or there is no state in which the
 * approved move can wait for its own transaction". A yes that has been given and not yet spent is
 * therefore a fact that must SURVIVE between two transactions, and no existing table can hold it:
 *
 *   - `approval` is keyed on the session and cascades with it, while §6 makes `SCOPE_LOST` a fixed
 *     point of `HANDOFF_REQUESTED` — a question survives the rotation of whoever asked it;
 *   - `project_blocker.detail` is display-only by BL7 ("never an input to any decision"), and an
 *     authorization input read out of a display field is precisely the mistake this whole unit
 *     exists to stop;
 *   - `project_action` has ONE project column, and a crossing is a fact about two.
 *
 * So this unit persists exactly one thing: the ANSWER, and the single task it was spent on. It
 * owns no work, appears in no plan, and is not a fourth thing a user has to learn — Project and
 * Task remain the only entities that carry goals and work. It is the same category of row as
 * `project_blocker` and `session_merge_receipt`: a control-plane record of a decision.
 *
 * Pure, like L1's two modules: no clock, no database, no Nest. `now` arrives as an argument
 * because an approval's expiry has to replay identically in a different process at a different
 * time, and a decision that read `Date.now()` would let two replays of one world disagree.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json';
import type { ScopeRefusalCode } from './project-scope-contract';
import type { HandoffApproval, HandoffApprovalState } from './project-scope-decision';

/**
 * The three shapes of crossing, kept apart because an approval for one is not an approval for
 * another. A yes to "file this work in project B" is not a yes to "move this existing task into
 * B", and neither is a yes to "let B's task gate mine" — they differ in what moves, what the user
 * is looking at when they answer, and what is undone if they change their mind.
 */
export const HANDOFF_KINDS = ['FILE_TASK', 'MOVE_TASK', 'DEPEND_ON_TASK'] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

/**
 * What is stored. `EXPIRED` is deliberately NOT here: it is derived from `expiresAt` at read time
 * (see `handoffApprovalOf`), so no sweeper has to run for an unspent yes to stop being one, and a
 * process that never got around to expiring anything cannot let a stale approval through.
 */
export const HANDOFF_STORED_STATES = ['PENDING', 'APPROVED', 'DENIED', 'APPLIED'] as const;
export type HandoffStoredState = (typeof HANDOFF_STORED_STATES)[number];

/** Who answered. `POLICY` is only ever written where §4 R-p below allows it. */
export const HANDOFF_DECIDERS = ['USER', 'POLICY'] as const;
export type HandoffDecider = (typeof HANDOFF_DECIDERS)[number];

/**
 * How long a yes stays spendable, in milliseconds.
 *
 * The risk an expiry answers is not that the user forgets; it is that the world moves. An approval
 * names two projects and a payload, and seven days later the goal it was granted under can have
 * been re-scoped, accepted or reopened. R13 (`APPROVAL_EXPIRED`) already exists in the frozen table
 * for exactly this, and its required action is `AWAIT_HANDOFF_APPROVAL` — ask again, do not proceed.
 *
 * A PENDING request never expires. §6 keeps a question standing across a takeover, and a queue that
 * silently drops the questions nobody answered is a queue that teaches people not to read it.
 */
export const HANDOFF_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * WHAT the crossing would put in the other project — every field of the write it authorises.
 *
 * Not just the prose. An approval that bound only title and description would be a yes the writer
 * could spend on a task with another assignee, another provider, another parent, another set of
 * prerequisites or auto-run switched on: the user would have answered a question about words and
 * authorised a change in WHO does the work, WITH WHAT, WHEN it starts and what it gates. So every
 * authority, structural and execution field the write carries is in here, and `applyRequestIdentity`
 * recomputes this from the write that is actually about to happen — a field that moved between the
 * question and the answer is a payload mismatch, refused, with nothing written.
 *
 * Refs are bound by the identity of the item they name, not by the name: `ref` strings are local to
 * one batch and two batches can spell the same edge with different names, or different edges with
 * the same one.
 */
export interface HandoffPlan {
  title: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
  acceptanceCommand?: string | null;
  acceptanceExpectedExitCode?: number | null;
  completionCriterion?: string | null;
  labels?: readonly string[] | null;
  /** WHO — the workspace that would execute it. */
  assigneeId?: string | null;
  listId?: string | null;
  /** WITH WHAT. */
  provider?: string | null;
  model?: string | null;
  /** WHEN. */
  autoRunWhenReady?: boolean | null;
  runAt?: string | null;
  dueDate?: string | null;
  completionPolicy?: string | null;
  /** Structure. Each is either an existing task id or the digest of an item in this same plan. */
  parentTaskId?: string | null;
  parentRefDigest?: string | null;
  verifiesTaskId?: string | null;
  verifiesRefDigest?: string | null;
  supersedesTaskId?: string | null;
  dependsOnTaskIds?: readonly string[] | null;
  dependsOnRefDigests?: readonly string[] | null;
}

/**
 * WHERE the work was noticed — the four provenance columns the target task will carry (L2).
 *
 * In the identity, not beside it, and this is the correction that matters most: two coordinators
 * noticing the same thing about two different tasks would otherwise write the same title from the
 * same project and COLLAPSE onto one crossing — one question, one answer, and a target task whose
 * `source_task_id` points at whichever of them happened to be first. The back-link would be wrong
 * in a way nothing downstream could detect, which is the same class of defect as the incident this
 * unit exists for.
 *
 * The cost is stated rather than hidden: a coordinator rotation changes `sessionId`, so the
 * successor asks its own question. That is correct — it would file a row with different provenance,
 * so it is a different filing — and §6 is still satisfied, because the earlier request is not
 * dropped, invalidated or answered on the successor's behalf. It stands, addressed to the row it
 * named, and can still be answered by the person it was asked of.
 */
export interface HandoffSourceEvidence {
  projectId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  triggerEvent?: string | null;
}

export interface HandoffRequestIdentity {
  plan: HandoffPlan;
  source: HandoffSourceEvidence;
}

/**
 * The payload half of a crossing's identity: everything the answer is about, as one digest.
 *
 * Digested rather than compared field by field so the identity is one fixed-width column, and
 * normalised through `canonicalJson` so key order and "absent vs explicitly null" cannot make two
 * spellings of one request into two questions for the user. Every field is listed EXPLICITLY — a
 * spread of the caller's object would silently stop binding a field the day somebody renames one,
 * and the failure mode of that is an approval that authorises more than it was shown.
 */
export function handoffPayloadDigest(identity: HandoffRequestIdentity): string {
  const plan = identity.plan;
  const source = identity.source;
  // Preserve every pre-T10 approval byte-for-byte when it authorises no executable acceptance.
  // A task that does carry the new pair gets a new digest version and binds both fields, so an old
  // approval can never be stretched to authorise a command it did not show. An explicitly typed
  // N1 criterion advances to v4 and binds that type; omission keeps the rolling-client identity.
  const executableAcceptance =
    plan.acceptanceCommand != null || plan.acceptanceExpectedExitCode != null;
  const typedCompletion = plan.completionCriterion != null;
  // v5 is retired, not renumbered: 0227 removed the negotiated timeout pair that selected it, so
  // no new plan can reach that shape. Rows that were keyed with it keep the digest they were
  // written with, which is the whole point of an append-only idempotency preimage.
  return createHash('sha256')
    .update(canonicalJson({
      v: typedCompletion ? 4 : executableAcceptance ? 3 : 2,
      plan: {
        title: plan.title,
        description: plan.description ?? null,
        acceptanceCriteria: plan.acceptanceCriteria ?? null,
        ...(executableAcceptance
          ? {
              acceptanceCommand: plan.acceptanceCommand ?? null,
              acceptanceExpectedExitCode: plan.acceptanceExpectedExitCode ?? null,
            }
          : {}),
        ...(typedCompletion ? { completionCriterion: plan.completionCriterion } : {}),
        // Order-insensitive: `normalizeTaskLabels` dedupes but preserves the caller's order, and
        // two orderings of one label set are the same task to every reader of it.
        labels: [...(plan.labels ?? [])].sort(),
        assigneeId: plan.assigneeId ?? null,
        listId: plan.listId ?? null,
        provider: plan.provider ?? null,
        model: plan.model ?? null,
        autoRunWhenReady: plan.autoRunWhenReady ?? null,
        runAt: plan.runAt ?? null,
        dueDate: plan.dueDate ?? null,
        completionPolicy: plan.completionPolicy ?? null,
        parentTaskId: plan.parentTaskId ?? null,
        parentRefDigest: plan.parentRefDigest ?? null,
        verifiesTaskId: plan.verifiesTaskId ?? null,
        verifiesRefDigest: plan.verifiesRefDigest ?? null,
        supersedesTaskId: plan.supersedesTaskId ?? null,
        // Sorted: the prerequisite SET is what gates the task; the order they were listed in is not
        // a fact about the work and would make one plan two questions.
        dependsOnTaskIds: [...(plan.dependsOnTaskIds ?? [])].sort(),
        dependsOnRefDigests: [...(plan.dependsOnRefDigests ?? [])].sort(),
      },
      source: {
        projectId: source.projectId ?? null,
        taskId: source.taskId ?? null,
        sessionId: source.sessionId ?? null,
        triggerEvent: source.triggerEvent ?? null,
      },
    }))
    .digest('hex');
}

/**
 * The payload half for a dependency crossing: WHO is being made to wait.
 *
 * A dependency's two ends are two tasks, and the prerequisite is already named by `subjectTaskId`.
 * This digests the dependent — by id when it already exists, by its full request identity when the
 * plan is about to create it — so one answer authorises one edge and cannot be spent on another.
 */
export function handoffDependentDigest(dependent: {
  taskId?: string | null;
  identity?: HandoffRequestIdentity | null;
}): string {
  return createHash('sha256')
    .update(canonicalJson({
      v: 2,
      taskId: dependent.taskId ?? null,
      identity: dependent.identity ? handoffPayloadDigest(dependent.identity) : null,
    }))
    .digest('hex');
}

export interface HandoffCrossing {
  ownerId: string;
  fromProjectId: string;
  toProjectId: string;
  kind: HandoffKind;
  /**
   * MOVE_TASK: the task being moved. DEPEND_ON_TASK: the prerequisite. FILE_TASK: null — the task
   * it authorises does not exist yet, and the source task the work was NOTICED on is bound through
   * `payloadDigest` instead (`HandoffSourceEvidence`), which is what keeps two crossings that share
   * a project and a wording but not a source from collapsing into one question.
   */
  subjectTaskId: string | null;
  payloadDigest: string;
}

/**
 * The identity of one crossing — the key the approval is filed under and looked up by.
 *
 * Every field that could make this a DIFFERENT question for the user is in the preimage, and
 * nothing else is: not the session that asked (§6 keeps the question standing across a takeover),
 * not the turn (a retry after a timeout must find the same row, not ask a second time), not the
 * clock. That is what makes duplicate, concurrent, out-of-order and timed-out retries collapse
 * onto one row and one answer (AC3) — the collapsing is a unique index on this value, not a
 * best-effort de-duplication somebody has to remember to run.
 */
export function handoffCrossingKey(crossing: HandoffCrossing): string {
  return createHash('sha256')
    .update(canonicalJson([
      'pha:v1',
      crossing.ownerId,
      crossing.fromProjectId,
      crossing.toProjectId,
      crossing.kind,
      crossing.subjectTaskId ?? '',
      crossing.payloadDigest,
    ]))
    .digest('hex');
}

/**
 * The `trigger_event` a task filed by a session carries — the fourth provenance column (L2).
 *
 * Here, and called by `TasksService.resolveOwnedSession`, because unit L4 has to DERIVE the value a
 * declaration claims rather than believe it: a caller that could name its own trigger event could
 * describe a coordinator filing as an ordinary agent write, and the four provenance columns would
 * stop being evidence the moment one of them was writable. Two spellings of this rule would let the
 * value the task is written with and the value the declaration is checked against disagree, so
 * there is one.
 */
export function sessionTriggerEvent(session: {
  coordinatesProject: boolean;
  executesTask: boolean;
}): string {
  return session.coordinatesProject
    ? 'coordinator.session_filed'
    : session.executesTask
      ? 'task.session_filed'
      : 'agent.session_filed';
}

/** A project, as the acceptance rule below reads it. */
export interface HandoffProjectFacts {
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  automationPolicy: 'MANUAL' | 'GUARDED_AUTO' | 'AUTO';
}

export type HandoffAcceptedBy = HandoffDecider;

export interface HandoffAcceptanceDecision {
  acceptedBy: HandoffAcceptedBy;
  /** The rule that answered. Recorded on the row, so "why was this auto-accepted" has an answer. */
  rule: 'HP1_TARGET_NOT_OPEN' | 'HP2_NOT_BOTH_AUTO' | 'HP3_BOTH_AUTO';
}

/**
 * WHO may accept the work — the project instruction's "目标 Project／登录用户按策略接受工作", as one
 * rule with three rows.
 *
 * HP1. The target is not OPEN: only a person, ever. R8 already refuses the write outright
 *      (`PROJECT_REOPEN_REQUIRED`, and reopening is L5's door), and this row makes the same claim
 *      about the ANSWER: an approval must never be able to buy a way into a settled project, or an
 *      accepted project gains work while its acceptance record still claims to describe it.
 *
 * HP2. Anything short of both ends on AUTO: a person. This is the task's "guarded-auto 下跨项目 …
 *      必须等待人工" and it is stated as BOTH ends on purpose. The target's policy alone would let a
 *      guarded source push work into an automatic project without anybody looking; the source's
 *      alone would let an automatic coordinator sign for a project that asked to be asked. Under
 *      GUARDED_AUTO — the default for every new project — this is the row that answers.
 *
 * HP3. Both ends on AUTO and both open: the policy accepts, and the row records `POLICY` as the
 *      decider with this rule beside it. This is the only automatic yes in the unit, and it is not
 *      an agent signing for another agent (§7 RB2): no coordinator decided it, the two projects'
 *      OWNER did, in advance, by putting both of them on AUTO.
 */
export function decideHandoffAcceptance(
  from: HandoffProjectFacts,
  to: HandoffProjectFacts,
): HandoffAcceptanceDecision {
  if (to.status !== 'OPEN' || from.status !== 'OPEN') {
    return { acceptedBy: 'USER', rule: 'HP1_TARGET_NOT_OPEN' };
  }
  if (from.automationPolicy !== 'AUTO' || to.automationPolicy !== 'AUTO') {
    return { acceptedBy: 'USER', rule: 'HP2_NOT_BOTH_AUTO' };
  }
  return { acceptedBy: 'POLICY', rule: 'HP3_BOTH_AUTO' };
}

/** The stored row, as everything below reads it. */
export interface HandoffApprovalRow {
  fromProjectId: string;
  toProjectId: string;
  kind: HandoffKind;
  subjectTaskId: string | null;
  state: HandoffStoredState;
  /** When an APPROVED answer stops being spendable. Null in every other state. */
  expiresAt: Date | null;
  /** The one task this yes was spent on, or null while it is unspent. */
  appliedTaskId: string | null;
}

/**
 * The row, as L1's decision function reads an approval.
 *
 * Two derivations happen here and both are load bearing:
 *
 *   - **EXPIRED** is computed from the clock rather than stored, so nothing has to run for a stale
 *     yes to stop working. A process that has never expired anything still refuses at R13.
 *   - **APPLIED becomes an APPROVED that names the task it was spent on.** That is not a trick to
 *     reuse a state: it is the truth, and it is what makes R9 answer the second write. The yes was
 *     about one crossing; once it has produced a task it names that task, so a later create (whose
 *     `taskId` is null) no longer matches it and is refused `APPROVAL_TARGET_MISMATCH` — "a yes
 *     about a different move" — instead of quietly filing a second task under one approval.
 */
export function handoffApprovalOf(row: HandoffApprovalRow, now: Date): HandoffApproval {
  const state: HandoffApprovalState =
    row.state === 'APPLIED'
      ? 'APPROVED'
      : row.state === 'APPROVED'
        ? (row.expiresAt && row.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'APPROVED')
        : row.state;
  return {
    state,
    fromProjectId: row.fromProjectId,
    toProjectId: row.toProjectId,
    taskId: row.state === 'APPLIED'
      ? row.appliedTaskId
      : row.kind === 'FILE_TASK'
        ? null
        : row.subjectTaskId,
  };
}

/**
 * §6's `HANDOFF_*` transitions, as the stored states move.
 *
 * A subset of `SCOPE_WORK_TRANSITIONS` rather than a second spelling of it — `DENIED` here IS §6's
 * `ABANDONED`, reached by `REFUSE_HANDOFF` — and `project-handoff.spec.ts` checks each row below
 * against L1's frozen table rather than against a copy of it.
 *
 * `null` is a refused event, not a hole. Two rows carry the weight:
 *
 *   - `APPLIED` accepts nothing. A spent yes is the end of the line — that is exactly-once, and it
 *     is enforced a second time by the database (the trigger in migration 0155), because a rule
 *     that lives only in the service is a rule a repair script does not have.
 *   - `DENIED` accepts nothing either, and that is not the same as saying the user may not change
 *     their mind. §6 gives `ABANDONED` exactly one outgoing edge — `USER_ASSIGNS_PROJECT` → `FILED`
 *     — which is the user performing the write under their own authority (R1), a new action with a
 *     new identity. Reviving the refused REQUEST would be something else: the row the coordinator
 *     was told no to would become a yes, keeping the requester, the moment and the audit of a
 *     question that was answered "no". A no stays a no; what comes after it is somebody else's act.
 */
export const HANDOFF_EVENTS = ['APPROVE', 'DENY', 'APPLY'] as const;
export type HandoffEvent = (typeof HANDOFF_EVENTS)[number];

export const HANDOFF_TRANSITIONS: Readonly<
  Record<HandoffStoredState, Readonly<Record<HandoffEvent, HandoffStoredState | null>>>
> = {
  PENDING: { APPROVE: 'APPROVED', DENY: 'DENIED', APPLY: null },
  APPROVED: { APPROVE: 'APPROVED', DENY: 'DENIED', APPLY: 'APPLIED' },
  DENIED: { APPROVE: null, DENY: null, APPLY: null },
  APPLIED: { APPROVE: null, DENY: null, APPLY: null },
};

export function nextHandoffState(
  state: HandoffStoredState,
  event: HandoffEvent,
): HandoffStoredState | null {
  const row = HANDOFF_TRANSITIONS[state];
  if (!row) throw new Error(`unknown handoff state: ${state}`);
  if (!(event in row)) throw new Error(`unknown handoff event: ${event}`);
  return row[event];
}

/**
 * The refusal a dependency crossing gets, given the answer that exists for it.
 *
 * A dependency edge is a crossing L1's decision function does not model: the task it is written on
 * lands in its own project, so `crossing` is false and R10–R14 never run. The AUTHORITY question is
 * identical though — may this agent make one goal wait on another's work — so the answer reuses
 * L1's codes verbatim rather than inventing a parallel vocabulary (§12 E2 forbids a synonym), and
 * `null` means allowed.
 */
export function dependencyCrossingRefusal(
  approval: HandoffApproval | null,
): ScopeRefusalCode | null {
  if (!approval) return 'CROSS_PROJECT_APPROVAL_REQUIRED';
  switch (approval.state) {
    case 'APPROVED':
      return null;
    case 'PENDING':
      return 'APPROVAL_PENDING';
    case 'DENIED':
      return 'APPROVAL_DENIED';
    case 'EXPIRED':
      return 'APPROVAL_EXPIRED';
  }
}

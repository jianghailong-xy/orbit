/**
 * The scope decision itself (unit L1, contract §4) — `project-scope-contract.ts`'s ordered rule
 * table, executed.
 *
 * Pure and total: one snapshot in, one outcome out, no clock, no database, no exceptions for
 * ordinary inputs. That is not tidiness. Everything this decides has to be replayable — the same
 * facts must produce the same refusal after a restart, in a different process, at a different
 * generation — because a decision that cannot be replayed cannot be audited, and unit L3 has to be
 * able to enforce this at admission time inside somebody else's transaction.
 *
 * The server derives `world.scope` from the session row it read under the lock. It is not the
 * scope the caller sent: a client that could name its own scope would be a client that could name
 * any project it liked, which is exactly the hole this unit exists to close. What the caller sends
 * (`presentedScope`) is only ever COMPARED — see R2/R3.
 */

import {
  SCOPE_REFUSAL_POLICY,
  SCOPE_RULE_BY_ID,
  projectScopeToken,
  type ScopeDecision,
  type ScopeOperation,
  type ScopePrincipal,
  type ScopeProjectStatus,
  type ScopeProvenanceField,
  type ScopeRefusalCode,
  type ScopeRequiredAction,
  type ScopeResponsible,
} from './project-scope-contract';

/** What the writer says it is acting under. Checked, never trusted (SC3). */
export interface PresentedScope {
  projectId: string;
  /** Decimal string, as every BigInt counter crosses the wire in this codebase. */
  generation: string;
  token: string;
}

/** What the server read: the scope this session actually holds right now, or null for none. */
export interface DerivedScope {
  projectId: string;
  generation: string;
}

export type HandoffApprovalState = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

/**
 * A user's answer about ONE crossing. It names the ends and the task, because an approval that
 * names only "yes" is an approval that can be replayed onto a different move (`APPROVAL_TARGET_MISMATCH`).
 */
export interface HandoffApproval {
  state: HandoffApprovalState;
  /** null when the crossing files NEW work rather than moving an existing task. */
  fromProjectId: string | null;
  toProjectId: string;
  taskId: string | null;
}

export interface ScopeWriteRequest {
  principal: ScopePrincipal;
  operation: ScopeOperation;
  /** The task being written, or null when it does not exist yet. */
  taskId: string | null;
  /** Where the write would land. null = the write names no project at all. */
  targetProjectId: string | null;
  /** Which project owns the task today. null for new work. */
  currentProjectId: string | null;
  /** What the caller carried. null = a client old enough not to carry one (§8). */
  presentedScope: PresentedScope | null;
  /**
   * Where the work was noticed. Carried so the decision can be recorded WITH its provenance, and
   * read by nothing here: SC7 says evidence grants no authority, and the decision spec proves it by
   * varying these fields over every input and asserting the outcome never moves.
   */
  provenance?: Partial<Record<ScopeProvenanceField, string | null>>;
  world: {
    /** Server-derived, under the lock. null = this session holds no scope. */
    scope: DerivedScope | null;
    /**
     * The status of every project this write touches. A project whose status is absent counts as
     * NOT open — fail closed, the same way `blockerKindForRefusal` fails closed to
     * `UNKNOWN_FAILURE`. A gate that treats "I did not read it" as "it was fine" is not a gate.
     */
    projectStatus: Readonly<Record<string, ScopeProjectStatus>>;
    /** The user's answer about this crossing, if one has been asked for. */
    approval: HandoffApproval | null;
  };
}

export interface ScopeWriteOutcome {
  decision: ScopeDecision;
  /** Which rule answered. The audit's "why", and the thing a test pins. */
  rule: string;
  code: ScopeRefusalCode | null;
  responsible: ScopeResponsible | null;
  requiredAction: ScopeRequiredAction | null;
  blockerKind: string | null;
  /**
   * The two ends this decision was about — what the refusal has to name to be actionable.
   * `from` is the project the work is leaving (or the scope that is authoring it), `to` the project
   * it would land in.
   */
  ends: { from: string | null; to: string | null };
  /** True when the two ends differ: this write changes which goal the work counts towards. */
  crossing: boolean;
}

function isOpen(
  status: Readonly<Record<string, ScopeProjectStatus>>,
  projectId: string | null,
): boolean {
  if (projectId === null) return true;
  return status[projectId] === 'OPEN';
}

/**
 * §4, in order. Every `return` below is one row of the frozen rule table, and nothing decides
 * anything outside them.
 */
export function decideProjectScopeWrite(request: ScopeWriteRequest): ScopeWriteOutcome {
  const { world } = request;
  const scope = world.scope;
  // `from` is the project losing the work — the task's current project, or, for work that does not
  // exist yet, the scope authoring it. Defining it this way is what makes "create a task in another
  // project" and "move a task to another project" one crossing with one rule instead of two.
  const from = request.currentProjectId ?? scope?.projectId ?? null;
  const to = request.targetProjectId;
  const crossing = from !== to;
  const ends = { from, to };
  const allow = (rule: string): ScopeWriteOutcome => ({
    decision: 'ALLOW',
    rule,
    code: null,
    responsible: null,
    requiredAction: null,
    blockerKind: null,
    ends,
    crossing,
  });
  const refuse = (ruleId: string): ScopeWriteOutcome => {
    const rule = SCOPE_RULE_BY_ID[ruleId];
    const policy = SCOPE_REFUSAL_POLICY[rule.code!];
    return {
      decision: policy.decision,
      rule: ruleId,
      code: rule.code,
      responsible: policy.responsible,
      requiredAction: rule.requiredAction,
      blockerKind: policy.blockerKind,
      ends,
      crossing,
    };
  };

  // R1. The owner is not scoped by anything here. PAC §8.2's first rows already say every one of
  // these writes is theirs, and a contract that refuses the person it exists to serve has stopped
  // being an authorization boundary and become a policy about what they may want.
  if (request.principal === 'USER') return allow('R1_USER_AUTHORITY');

  const presented = request.presentedScope;
  // R2. A token that does not describe its own pair describes nothing. Retryable on purpose: this
  // is a client that got the wire form wrong, not a client that lost its authority.
  if (presented && presented.token !== projectScopeToken(presented.projectId, presented.generation)) {
    return refuse('R2_TOKEN_INCONSISTENT');
  }
  // R3. Presented against derived — the takeover answer. Absent derived scope counts as moved: a
  // session that held a binding and holds none now was rotated out, and the successor decides.
  if (
    presented
    && (!scope || presented.projectId !== scope.projectId || presented.generation !== scope.generation)
  ) {
    return refuse('R3_SCOPE_MOVED');
  }
  // R4. Work that names no goal. The refusal is the point: an agent that may silently file
  // unattributable work under its own project is how the wrong project ends up owning it, and an
  // agent that may file it under NO project is how the work stops being counted by any acceptance.
  if (to === null) return refuse('R4_NO_TARGET_PROJECT');
  // R5. No scope at all, and it never claimed one (a claim would have been answered by R3).
  if (!scope) return refuse('R5_NO_SCOPE');
  // R6. Not a crossing, and not at home either: a plain write into somebody else's project. This is
  // the incident, in one line.
  if (!crossing && to !== scope.projectId) return refuse('R6_OUT_OF_SCOPE');
  // R7. A crossing that did not say it was crossing. The difference between this and a legal
  // request is entirely that the writer declared it — which is why `HANDOFF_TASK` is an operation
  // rather than an inference: an inferred crossing would let the rule be satisfied by accident.
  if (crossing && request.operation !== 'HANDOFF_TASK') return refuse('R7_UNDECLARED_CROSSING');
  // R8. Above the approval rules: a settled project takes no new work until somebody reopens it,
  // approved or not. (This says nothing about the tasks it already owns — a status change inside a
  // settled project still reopens it through PCC §13.4 AE8, untouched by this contract.)
  if (!isOpen(world.projectStatus, from) || !isOpen(world.projectStatus, to)) {
    return refuse('R8_SETTLED_PROJECT');
  }

  if (crossing) {
    const approval = world.approval;
    const matches = approval !== null
      && approval.toProjectId === to
      && (approval.fromProjectId ?? null) === from
      && (approval.taskId ?? null) === request.taskId;
    // R9. A yes about a different move. Kept apart from "no yes yet" because re-asking is the right
    // answer to the second and the wrong answer to the first: an approval that can be re-aimed is
    // an approval that only has to be obtained once.
    if (approval?.state === 'APPROVED' && !matches) return refuse('R9_APPROVAL_TARGET_MISMATCH');
    if (!matches) return refuse('R10_NO_APPROVAL');
    if (approval!.state === 'PENDING') return refuse('R11_APPROVAL_PENDING');
    if (approval!.state === 'DENIED') return refuse('R12_APPROVAL_DENIED');
    if (approval!.state === 'EXPIRED') return refuse('R13_APPROVAL_EXPIRED');
    // R14. Declared, matched, answered yes, both ends open.
    return allow('R14_HANDOFF_APPROVED');
  }

  // R15. Inside the scope it holds, in a project that is open. The ordinary case, and the only one
  // that was ever supposed to be ordinary.
  return allow('R15_IN_SCOPE');
}

/**
 * Unit L3: the scope contract at admission time — the layer between a real write and L1's frozen
 * decision.
 *
 * L1 froze the rules (`project-scope-contract.ts`) and the decision over them
 * (`project-scope-decision.ts`); both are pure and neither is called by anything. This module is
 * what a write path calls. It answers three questions the decision function deliberately does not:
 *
 *   1. **Which project does the write actually land in.** The decision is handed a
 *      `targetProjectId`; somebody has to derive it. That somebody is here, and the derivation is
 *      the whole point of the unit — a coordinator write that names no project is filed under the
 *      project the SERVER says that session coordinates, never under one the model chose, the
 *      prompt suggested or the last browsed page happened to be.
 *   2. **Is this write on the write surface at all.** §2 defines the surface as writes that change
 *      which goal a piece of work counts towards. A create that names no project, from a session
 *      that holds no scope, changes nothing about any goal — there is no goal — so it is not a
 *      claim of ownership and §1's boundary leaves it alone. Without this test the contract would
 *      refuse every ordinary agent task in the product on R4, which is not what R4 is about.
 *   3. **Does a refusal actually refuse.** §8 CM2 requires L3 to land in two phases: an OBSERVE
 *      phase where a write the contract refuses is written anyway and audited, so "what would this
 *      rule reject" is countable BEFORE it is switched on, and an ENFORCE phase where it refuses.
 *
 * Pure, like the two modules below it: no clock, no database, no Nest. What the caller supplies is
 * what the server read — never what the client said. The one thing a client may say is the scope
 * token, and §2 SC3 is explicit that it is compared and never trusted: `parsePresentedScope` turns
 * it into a claim, and R2/R3 are what decide whether the claim survives contact with the row.
 */

import { uuidToBase62 } from '@orbit/shared';
import { ACCEPTANCE_FINDING_ROUTING } from './project-acceptance';
import {
  projectScopeToken,
  type ScopeOperation,
  type ScopePrincipal,
  type ScopeProjectStatus,
} from './project-scope-contract';
import {
  decideProjectScopeWrite,
  type DerivedScope,
  type HandoffApproval,
  type PresentedScope,
  type ScopeWriteOutcome,
} from './project-scope-decision';

/** §8 CM2's two phases. */
export type ProjectScopeMode = 'observe' | 'enforce';

export const PROJECT_SCOPE_MODE_ENV = 'ORBIT_PROJECT_SCOPE_MODE';

/**
 * Which phase this process is in.
 *
 * `enforce` is the default and `observe` is the only string that turns it off, deliberately in that
 * direction: a typo, an empty value or an unset variable has to land on the gate being ON. A flag
 * whose misspelling silently disables an authorization boundary is the boundary being optional.
 */
export function projectScopeMode(
  env: Record<string, string | undefined> = process.env,
): ProjectScopeMode {
  return env[PROJECT_SCOPE_MODE_ENV]?.trim() === 'observe' ? 'observe' : 'enforce';
}

/**
 * A presented scope token, parsed into the claim it makes — or into a claim that cannot survive R2.
 *
 * Absent is not malformed: a client too old to carry one presents nothing (§8 CM1 — that costs it
 * the ability to DECLARE a crossing and buys it no authority), while a client that carries a
 * mangled one is making a claim the server cannot read. Those must not answer the same, so a
 * malformed token becomes a claim whose token does not describe its own pair — which is exactly
 * R2's predicate, and R2 tells it to re-derive and retry.
 */
export function parsePresentedScope(raw: string | null | undefined): PresentedScope | null {
  if (raw === null || raw === undefined) return null;
  const token = raw.trim();
  if (!token) return null;
  const match = /^psc:v1:([0-9a-f-]{36}):(\d+)$/.exec(token);
  if (!match) return { projectId: '', generation: '', token };
  return { projectId: match[1], generation: match[2], token };
}

export interface ScopeAdmissionRequest {
  principal: ScopePrincipal;
  operation: ScopeOperation;
  /** The task being written, or null when it does not exist yet. */
  taskId: string | null;
  /**
   * What the caller asked for, in three states. `undefined` means the write did not mention the
   * project at all — which is where the server derivation happens; `null` means the caller
   * explicitly asked for no project, which IS an ownership claim and is decided like any other.
   */
  requestedProjectId: string | null | undefined;
  /** Which project owns the task today. null for new work. */
  currentProjectId: string | null;
  /** Server-derived from the session row under the owner's tenancy. null = holds no scope. */
  scope: DerivedScope | null;
  /** The raw `scopeToken` field off the request, if the client sent one. */
  presentedScopeToken?: string | null;
  /** Status of every project this write touches; a project absent from it counts as not OPEN. */
  projectStatus: Readonly<Record<string, ScopeProjectStatus>>;
  approval?: HandoffApproval | null;
}

export interface ScopeAdmission {
  /**
   * The project this write must land in once the mode allows the binding to apply. Equal to what
   * the caller asked for whenever it asked; the server's derivation only fills a silence.
   */
  projectId: string | null;
  /** False when the write claims no ownership at all — the decision was not asked. */
  onWriteSurface: boolean;
  /** null exactly when `onWriteSurface` is false. */
  outcome: ScopeWriteOutcome | null;
}

/**
 * §4's decision, over a write that actually happened.
 *
 * The binding rule, in one place because two spellings of it is how a create and an update end up
 * disagreeing about which project a coordinator writes into:
 *
 *   - the caller named a project (including naming none)  → that is the target, and it is decided;
 *   - a CREATE that said nothing                          → the scope the server derived;
 *   - an UPDATE that said nothing                         → whatever owns the task today.
 *
 * An update that leaves the project alone still reaches the decision, and has to: `from` and `to`
 * are then the same project, so R6 is what catches a session editing a task inside somebody else's
 * goal — a write that never mentions `projectId` and moves nothing is still a write into a project.
 */
export function admitProjectScopeWrite(request: ScopeAdmissionRequest): ScopeAdmission {
  const target =
    request.requestedProjectId !== undefined
      ? request.requestedProjectId
      : request.operation === 'UPDATE_TASK'
        ? request.currentProjectId
        : (request.scope?.projectId ?? null);
  // §2's surface: a write claims ownership when it lands in a project, or when it moves work out
  // of one. Everything else — an agent filing work under no goal, or editing a task that belongs
  // to no goal — changes nothing about which goal counts what, and §1 leaves the control loop's
  // own non-attributing writes alone for exactly that reason.
  //
  // The anchor is NOT `ScopeWriteRequest.from`. That definition folds "new work authored by this
  // scope" into the same field as "the project this task is in today", which is what makes filing
  // into another project and moving into it one rule (§4 R-b) — correct for the decision, and
  // wrong as a test of whether a write is a claim at all: an UPDATE of a task that belongs to no
  // project would read as work LEAVING the writer's scope, and R4 would refuse every coordinator
  // edit of an unfiled task. So a create anchors on the scope that would own the result, and an
  // update anchors on what actually owns the task.
  const anchor =
    request.currentProjectId
    ?? (request.operation === 'UPDATE_TASK' ? null : (request.scope?.projectId ?? null));
  if (target === null && anchor === null) {
    return { projectId: target, onWriteSurface: false, outcome: null };
  }
  return {
    projectId: target,
    onWriteSurface: true,
    outcome: decideProjectScopeWrite({
      principal: request.principal,
      operation: request.operation,
      taskId: request.taskId,
      targetProjectId: target,
      currentProjectId: request.currentProjectId,
      presentedScope: parsePresentedScope(request.presentedScopeToken),
      world: {
        scope: request.scope,
        projectStatus: request.projectStatus,
        approval: request.approval ?? null,
      },
    }),
  };
}

/** True when this outcome stops the write — in `enforce`; in `observe` nothing stops anything. */
export function scopeWriteRefused(
  admission: ScopeAdmission,
  mode: ProjectScopeMode,
): boolean {
  return mode === 'enforce' && !!admission.outcome && admission.outcome.decision !== 'ALLOW';
}

/**
 * The refusal, as a response body.
 *
 * Every id here is emitted under a field name the public-id allowlist already classifies
 * (`projectId`, `taskId`), because an error body does NOT pass through `PublicIdInterceptor` —
 * `PublicIdExceptionFilter` maps it by field name instead, and a name it does not recognise ships
 * a raw UUID to a client that has never been given one anywhere else. The prose is base62 at the
 * throw point for the same reason: no filter can find an id inside a sentence.
 */
export interface ScopeRefusalBody {
  code: string;
  rule: string;
  responsible: string | null;
  requiredAction: string | null;
  blockerKind: string | null;
  message: string;
  taskId: string | null;
  /** The scope the write was authored under, and where it tried to land. */
  scope: { projectId: string | null } | null;
  target: { projectId: string | null } | null;
}

const REFUSAL_PROSE: Readonly<Record<string, string>> = {
  RE_DERIVE_SCOPE: 'Re-read the coordination scope from the server and retry this write.',
  YIELD_TO_CURRENT_SCOPE:
    'This session no longer holds the coordination scope for that project; the scope that does '
    + 'will decide again. Do not retry.',
  FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF:
    'File this work under the project this session coordinates, or declare the crossing and ask '
    + 'for it.',
  NAME_OWNING_PROJECT:
    'Somebody has to say which project owns this work; a coordinator may not pick one for it.',
  REOPEN_PROJECT_FIRST:
    'That project is settled. It has to be reopened — which starts a new acceptance epoch — '
    + 'before it can take new work. ' + ACCEPTANCE_FINDING_ROUTING,
  AWAIT_HANDOFF_APPROVAL: 'Wait for the user to answer the declared crossing.',
};

export function scopeRefusalBody(
  outcome: ScopeWriteOutcome,
  taskId: string | null,
): ScopeRefusalBody {
  const publicId = (id: string | null): string | null => {
    if (!id) return null;
    try {
      return uuidToBase62(id);
    } catch {
      return null;
    }
  };
  const scopeId = publicId(outcome.ends.from);
  const targetId = publicId(outcome.ends.to);
  const where = outcome.crossing
    ? `scope ${scopeId ?? 'none'} → project ${targetId ?? 'none'}`
    : `project ${targetId ?? 'none'}`;
  return {
    code: outcome.code!,
    rule: outcome.rule,
    responsible: outcome.responsible,
    requiredAction: outcome.requiredAction,
    blockerKind: outcome.blockerKind,
    message:
      `${outcome.code} (${where}): `
      + (REFUSAL_PROSE[outcome.requiredAction ?? ''] ?? 'This write is outside its scope.'),
    taskId,
    scope: outcome.ends.from === null ? null : { projectId: outcome.ends.from },
    target: outcome.ends.to === null ? null : { projectId: outcome.ends.to },
  };
}

/**
 * One line of §8 CM2's observation audit: what the rule WOULD have refused, while it still refuses
 * nothing. Deliberately flat and deliberately without ids in the prose — this is counted and
 * grouped before the cutover, not read one at a time.
 */
export function scopeObservationLine(
  admission: ScopeAdmission,
  request: ScopeAdmissionRequest,
): string {
  const outcome = admission.outcome!;
  return (
    `project scope observe: decision=${outcome.decision} rule=${outcome.rule} `
    + `code=${outcome.code ?? 'none'} principal=${request.principal} `
    + `operation=${request.operation} crossing=${outcome.crossing} `
    + `responsible=${outcome.responsible ?? 'none'} `
    + `requiredAction=${outcome.requiredAction ?? 'none'} `
    + `blockerKind=${outcome.blockerKind ?? 'none'}`
  );
}

/** The token this scope would present. Exported so a test — and, later, a client — spells it once. */
export function derivedScopeToken(scope: DerivedScope): string {
  return projectScopeToken(scope.projectId, scope.generation);
}

export type { DerivedScope, PresentedScope, ScopeOperation, ScopePrincipal, ScopeWriteOutcome };

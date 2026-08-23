import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROJECT_SCOPE_MODE_ENV,
  admitProjectScopeWrite,
  derivedScopeToken,
  parsePresentedScope,
  projectScopeMode,
  scopeObservationLine,
  scopeRefusalBody,
  scopeWriteRefused,
  type ScopeAdmissionRequest,
} from './project-scope-admission';
import {
  PROJECT_BLOCKER_NON_BLOCKING_REFUSALS,
  PROJECT_BLOCKER_REFUSAL_KINDS,
  blockerKindForRefusal,
} from './project-blocker';
import { SCOPE_NEW_REFUSAL_CODES, SCOPE_REFUSAL_POLICY } from './project-scope-contract';

/**
 * Unit L3, the pure half: the layer that turns a real write into L1's frozen decision.
 *
 * L1's own spec proves the rule table is total and that one input lands on one code. This file
 * proves the three things that only exist once something CALLS it — which project the write lands
 * in, whether the write was a claim of ownership at all, and whether a refusal refuses.
 */

const SCOPE_PROJECT = '00000000-0000-7000-8000-0000000000aa';
const OTHER_PROJECT = '00000000-0000-7000-8000-0000000000bb';
const TASK = '00000000-0000-7000-8000-0000000000c1';

function request(over: Partial<ScopeAdmissionRequest> = {}): ScopeAdmissionRequest {
  return {
    principal: 'COORDINATOR',
    operation: 'CREATE_TASK',
    taskId: null,
    requestedProjectId: undefined,
    currentProjectId: null,
    scope: { projectId: SCOPE_PROJECT, generation: '3' },
    projectStatus: { [SCOPE_PROJECT]: 'OPEN', [OTHER_PROJECT]: 'OPEN' },
    ...over,
  };
}

// ── the binding: which project the write actually lands in ──────────────────────────────────

// The incident, inverted. Nothing about the target came from the caller: the coordinator said
// nothing, and the row it will write is filed under the project the SERVER says it coordinates.
test('a create that names no project is filed under the scope the server derived', () => {
  const admission = admitProjectScopeWrite(request());

  assert.equal(admission.projectId, SCOPE_PROJECT);
  assert.equal(admission.outcome!.decision, 'ALLOW');
  assert.equal(admission.outcome!.rule, 'R15_IN_SCOPE');
});

test('a create that names another project is refused, and the refusal names both ends', () => {
  const admission = admitProjectScopeWrite(request({ requestedProjectId: OTHER_PROJECT }));

  assert.equal(admission.outcome!.decision, 'REFUSE');
  assert.equal(admission.outcome!.code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(admission.outcome!.rule, 'R7_UNDECLARED_CROSSING');
  assert.deepEqual(admission.outcome!.ends, { from: SCOPE_PROJECT, to: OTHER_PROJECT });
});

// An update is not a create with a row attached: a write that does not mention the project must
// leave the task exactly where it is. Binding it to the writer's scope here would BE the incident,
// performed by the fix.
test('an update that says nothing about the project moves nothing', () => {
  const admission = admitProjectScopeWrite(request({
    operation: 'UPDATE_TASK',
    taskId: TASK,
    currentProjectId: SCOPE_PROJECT,
  }));

  assert.equal(admission.projectId, SCOPE_PROJECT);
  assert.equal(admission.outcome!.decision, 'ALLOW');
});

// The incident's other shape: not filing new work in the wrong project, but reaching into work
// that is already there. `projectId` is never mentioned, and it is still a write into a goal.
test('an update of a task inside another project is refused even though it moves nothing', () => {
  const admission = admitProjectScopeWrite(request({
    operation: 'UPDATE_TASK',
    taskId: TASK,
    currentProjectId: OTHER_PROJECT,
  }));

  assert.equal(admission.outcome!.rule, 'R6_OUT_OF_SCOPE');
  assert.equal(admission.outcome!.code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(admission.outcome!.crossing, false);
});

// §4 R4. Emptying a task out of the project that counts it is an ownership claim like any other,
// and it is the one an agent may not make for itself.
test('a coordinator may not empty a task out of the project that counts it', () => {
  const admission = admitProjectScopeWrite(request({
    operation: 'UPDATE_TASK',
    taskId: TASK,
    currentProjectId: SCOPE_PROJECT,
    requestedProjectId: null,
  }));

  assert.equal(admission.outcome!.code, 'UNMAPPED_PROJECT_WORK');
  assert.equal(admission.outcome!.requiredAction, 'NAME_OWNING_PROJECT');
  assert.equal(admission.outcome!.responsible, 'USER');
});

// Filing loose work INTO the scope it is being coordinated from is the ordinary thing a
// coordinator does with something it noticed, and nothing here should be in its way.
test('a coordinator may file an unfiled task into the project it coordinates', () => {
  const admission = admitProjectScopeWrite(request({
    operation: 'UPDATE_TASK',
    taskId: TASK,
    currentProjectId: null,
    requestedProjectId: SCOPE_PROJECT,
  }));

  assert.equal(admission.outcome!.decision, 'ALLOW');
  assert.equal(admission.projectId, SCOPE_PROJECT);
});

// ── the write surface: what is not a claim of ownership at all ──────────────────────────────

// Without this the contract would refuse every ordinary agent task in the product on R4, which is
// not what R4 is about: no goal is involved, so no goal's count moves.
test('an agent with no scope filing work under no project is not on the write surface', () => {
  const admission = admitProjectScopeWrite(request({ principal: 'WORKER', scope: null }));

  assert.equal(admission.onWriteSurface, false);
  assert.equal(admission.outcome, null);
  assert.equal(admission.projectId, null);
});

// Same session, one field different, and now it claims a goal.
test('an agent with no scope filing INTO a project is refused', () => {
  const admission = admitProjectScopeWrite(request({
    principal: 'WORKER',
    scope: null,
    requestedProjectId: SCOPE_PROJECT,
  }));

  assert.equal(admission.onWriteSurface, true);
  assert.equal(admission.outcome!.rule, 'R5_NO_SCOPE');
  assert.equal(admission.outcome!.requiredAction, 'YIELD_TO_CURRENT_SCOPE');
});

// The anchor an update uses is what the task is in TODAY, not the writer's scope. Read the other
// way round, a coordinator editing an unfiled task looks like work leaving its project and R4
// refuses every one of them.
test('a coordinator editing a task that belongs to no project is not on the write surface', () => {
  const admission = admitProjectScopeWrite(request({
    operation: 'UPDATE_TASK',
    taskId: TASK,
    currentProjectId: null,
  }));

  assert.equal(admission.onWriteSurface, false);
  assert.equal(admission.projectId, null);
});

// §4 R1, and AC5: the owner is outside this contract, in every operation and against any project.
test('the owner is allowed into any of their own projects, in every operation', () => {
  for (const operation of ['CREATE_TASK', 'UPDATE_TASK', 'HANDOFF_TASK'] as const) {
    const admission = admitProjectScopeWrite(request({
      principal: 'USER',
      operation,
      taskId: operation === 'CREATE_TASK' ? null : TASK,
      scope: null,
      requestedProjectId: OTHER_PROJECT,
      currentProjectId: operation === 'CREATE_TASK' ? null : SCOPE_PROJECT,
      // Empty on purpose: R1 answers before the status map is consulted, so the owner's write does
      // not depend on a read the service deliberately does not make for them.
      projectStatus: {},
    }));

    assert.equal(admission.outcome!.rule, 'R1_USER_AUTHORITY', operation);
    assert.equal(admission.outcome!.decision, 'ALLOW', operation);
    assert.equal(admission.projectId, OTHER_PROJECT, operation);
  }
});

// ── the token: compared, never trusted ──────────────────────────────────────────────────────

test('a token that describes its own pair is a claim; a mangled one cannot be', () => {
  const scope = { projectId: SCOPE_PROJECT, generation: '3' };
  assert.deepEqual(parsePresentedScope(derivedScopeToken(scope)), {
    projectId: SCOPE_PROJECT,
    generation: '3',
    token: `psc:v1:${SCOPE_PROJECT}:3`,
  });
  // Absent and malformed must not answer the same: one is a client too old to carry one, the other
  // is a claim the server cannot read.
  assert.equal(parsePresentedScope(undefined), null);
  assert.equal(parsePresentedScope(''), null);
  assert.equal(parsePresentedScope('  '), null);
  for (const bad of ['psc:v2:x:1', 'psc:v1:not-a-uuid:1', `psc:v1:${SCOPE_PROJECT}:`, 'garbage']) {
    const parsed = parsePresentedScope(bad)!;
    assert.equal(parsed.token, bad, bad);
    assert.notEqual(parsed.projectId, SCOPE_PROJECT, bad);
  }
});

test('a mangled token is told to re-derive its scope, not that it lost authority', () => {
  const admission = admitProjectScopeWrite(request({
    presentedScopeToken: `psc:v1:${SCOPE_PROJECT}:not-a-number`,
    requestedProjectId: SCOPE_PROJECT,
  }));

  assert.equal(admission.outcome!.rule, 'R2_TOKEN_INCONSISTENT');
  assert.equal(admission.outcome!.code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(admission.outcome!.requiredAction, 'RE_DERIVE_SCOPE');
});

// AC3. A session rotated away carries a generation that no longer matches the counter, and the
// answer names the takeover rather than the write — nobody is being asked to fix anything.
test('a write presenting a rotated-away generation yields to the current scope', () => {
  const admission = admitProjectScopeWrite(request({
    presentedScopeToken: derivedScopeToken({ projectId: SCOPE_PROJECT, generation: '2' }),
    requestedProjectId: SCOPE_PROJECT,
  }));

  assert.equal(admission.outcome!.rule, 'R3_SCOPE_MOVED');
  assert.equal(admission.outcome!.code, 'COORDINATOR_GENERATION_MOVED');
  assert.equal(admission.outcome!.responsible, 'SYSTEM');
  assert.equal(admission.outcome!.blockerKind, null);
});

// §8 CM1. The old client is scoped exactly like the new one; the only thing it cannot do is
// declare a crossing. A missing token that read as "unscoped, so allowed" would make downgrading
// the bypass.
test('a client that carries no token is scoped exactly like one that does', () => {
  const withToken = admitProjectScopeWrite(request({
    presentedScopeToken: derivedScopeToken({ projectId: SCOPE_PROJECT, generation: '3' }),
    requestedProjectId: OTHER_PROJECT,
  }));
  const without = admitProjectScopeWrite(request({ requestedProjectId: OTHER_PROJECT }));

  assert.equal(without.outcome!.code, withToken.outcome!.code);
  assert.equal(without.outcome!.rule, withToken.outcome!.rule);
});

// ── observe → enforce ───────────────────────────────────────────────────────────────────────

test('enforce is the default, and only the exact word turns it off', () => {
  assert.equal(projectScopeMode({}), 'enforce');
  assert.equal(projectScopeMode({ [PROJECT_SCOPE_MODE_ENV]: 'observe' }), 'observe');
  assert.equal(projectScopeMode({ [PROJECT_SCOPE_MODE_ENV]: ' observe ' }), 'observe');
  // A flag whose misspelling disables an authorization boundary is an optional boundary.
  for (const wrong of ['', 'OBSERVE', 'observ', 'off', 'false', 'audit']) {
    assert.equal(projectScopeMode({ [PROJECT_SCOPE_MODE_ENV]: wrong }), 'enforce', wrong);
  }
});

test('observe refuses nothing, and enforce refuses everything the decision does', () => {
  const refused = admitProjectScopeWrite(request({ requestedProjectId: OTHER_PROJECT }));
  const allowed = admitProjectScopeWrite(request());
  const offSurface = admitProjectScopeWrite(request({ principal: 'WORKER', scope: null }));

  assert.equal(scopeWriteRefused(refused, 'enforce'), true);
  assert.equal(scopeWriteRefused(refused, 'observe'), false);
  assert.equal(scopeWriteRefused(allowed, 'enforce'), false);
  assert.equal(scopeWriteRefused(offSurface, 'enforce'), false);
});

// The point of the observation phase is that it is COUNTABLE before the cutover, so the line has
// to carry the rule and the code rather than a sentence about them.
test('an observed refusal audits which rule would have refused it', () => {
  const req = request({ requestedProjectId: OTHER_PROJECT });
  const line = scopeObservationLine(admitProjectScopeWrite(req), req);

  assert.match(line, /decision=REFUSE/);
  assert.match(line, /rule=R7_UNDECLARED_CROSSING/);
  assert.match(line, /code=PROJECT_SCOPE_MISMATCH/);
  assert.match(line, /principal=COORDINATOR/);
  assert.match(line, /operation=CREATE_TASK/);
});

// ── the refusal on the wire ─────────────────────────────────────────────────────────────────

// An error body does not pass through `PublicIdInterceptor`; `PublicIdExceptionFilter` maps it by
// FIELD NAME. An id under a name the allowlist does not know ships a raw UUID to a client that has
// never been given one anywhere else — so the ids live under `projectId`/`taskId` and the prose
// carries base62 or nothing.
test('the refusal body carries its ids under allowlisted names, and none in the prose', () => {
  const outcome = admitProjectScopeWrite(request({ requestedProjectId: OTHER_PROJECT })).outcome!;
  const body = scopeRefusalBody(outcome, TASK);

  assert.equal(body.code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(body.rule, 'R7_UNDECLARED_CROSSING');
  assert.equal(body.requiredAction, 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF');
  assert.equal(body.responsible, 'COORDINATOR');
  assert.deepEqual(body.scope, { projectId: SCOPE_PROJECT });
  assert.deepEqual(body.target, { projectId: OTHER_PROJECT });
  assert.equal(body.taskId, TASK);
  assert.doesNotMatch(body.message, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.ok(body.message.length > 0);
});

test('every refusal this path can emit says what to do next', () => {
  const cases: ScopeAdmissionRequest[] = [
    request({ requestedProjectId: OTHER_PROJECT }),
    request({ presentedScopeToken: 'garbage', requestedProjectId: SCOPE_PROJECT }),
    request({
      presentedScopeToken: derivedScopeToken({ projectId: SCOPE_PROJECT, generation: '1' }),
      requestedProjectId: SCOPE_PROJECT,
    }),
    request({ principal: 'WORKER', scope: null, requestedProjectId: SCOPE_PROJECT }),
    request({ operation: 'UPDATE_TASK', taskId: TASK, currentProjectId: OTHER_PROJECT }),
    request({
      operation: 'UPDATE_TASK', taskId: TASK,
      currentProjectId: SCOPE_PROJECT, requestedProjectId: null,
    }),
    request({ projectStatus: { [SCOPE_PROJECT]: 'DONE' }, requestedProjectId: SCOPE_PROJECT }),
    // R8 fails closed: a project whose status was not read counts as not open.
    request({ projectStatus: {}, requestedProjectId: SCOPE_PROJECT }),
  ];

  for (const req of cases) {
    const outcome = admitProjectScopeWrite(req).outcome!;
    assert.notEqual(outcome.decision, 'ALLOW', outcome.rule);
    const body = scopeRefusalBody(outcome, req.taskId);
    assert.ok(body.requiredAction, outcome.rule);
    assert.ok(body.responsible, outcome.rule);
    assert.match(body.message, new RegExp(`^${outcome.code}`), outcome.rule);
  }
});

// ── §5 EC6: introducing a code and classifying it are one act ────────────────────────────────

// `blockerKindForRefusal` fails closed to UNKNOWN_FAILURE, which stops a project's automatic
// dispatch. A code the contract emits and nobody classified would stop it for the wrong reason.
test('EC6: the contract and the blocker tables agree on every code, kind for kind', () => {
  for (const [code, policy] of Object.entries(SCOPE_REFUSAL_POLICY)) {
    assert.equal(blockerKindForRefusal(code), policy.blockerKind, code);
  }
  for (const code of SCOPE_NEW_REFUSAL_CODES) {
    const classified =
      code in PROJECT_BLOCKER_REFUSAL_KINDS || PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has(code);
    assert.ok(classified, `${code} is in neither blocker list`);
  }
  // EC5: the coordinator's own write to fix, so no blocker — and the takeover answer likewise.
  assert.equal(blockerKindForRefusal('PROJECT_SCOPE_MISMATCH'), null);
  assert.equal(blockerKindForRefusal('COORDINATOR_GENERATION_MOVED'), null);
});

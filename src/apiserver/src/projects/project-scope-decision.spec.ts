import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SCOPE_RULES,
  SCOPE_REFUSAL_POLICY,
  SCOPE_WORK_EVENTS,
  SCOPE_WORK_STATES,
  nextScopeWorkState,
  projectScopeToken,
  type ScopeWorkState,
} from './project-scope-contract';
import {
  decideProjectScopeWrite,
  type HandoffApproval,
  type ScopeWriteOutcome,
  type ScopeWriteRequest,
} from './project-scope-decision';

// The decision is a pure function over a snapshot, so these are the whole of its behaviour: there
// is no clock to freeze, no database to seed and no order to fake. Each of the six situations the
// unit was asked to answer gets its own block — same project, cross project, unclear target, DONE
// project, takeover, mixed versions — and the two properties that hold across all of them (one
// input lands on exactly one rule; provenance changes nothing) are tested as properties rather than
// as more rows, because a rule that is only true for the rows somebody thought of is not a rule.

const A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const C = 'cccccccc-0000-0000-0000-00000000000c';
const TASK = 'tttttttt-0000-0000-0000-00000000000t';
const GEN = '3';

/** Every rule this file actually reached, checked for completeness at the end. */
const reached = new Set<string>();

function decide(request: ScopeWriteRequest): ScopeWriteOutcome {
  const outcome = decideProjectScopeWrite(request);
  reached.add(outcome.rule);
  // Two invariants worth asserting on EVERY call rather than once: the rule is one of the frozen
  // fifteen, and the decision it reports is the one its code declares. A decision function that
  // can disagree with its own tables is worse than no tables.
  const rule = SCOPE_RULES.find((r) => r.id === outcome.rule);
  assert.ok(rule, `decided under an unknown rule: ${outcome.rule}`);
  assert.equal(outcome.code, rule.code);
  assert.equal(outcome.requiredAction, rule.requiredAction);
  if (rule.code) {
    const policy = SCOPE_REFUSAL_POLICY[rule.code];
    assert.equal(outcome.decision, policy.decision);
    assert.equal(outcome.responsible, policy.responsible);
    assert.equal(outcome.blockerKind, policy.blockerKind);
  } else {
    assert.equal(outcome.decision, 'ALLOW');
  }
  return outcome;
}

type Overrides = Partial<Omit<ScopeWriteRequest, 'world'>> & { world?: Partial<ScopeWriteRequest['world']> };

/** A coordinator of A, carrying a well-formed scope for generation 3, writing inside A. */
function write(over: Overrides = {}): ScopeWriteRequest {
  const { world, ...rest } = over;
  return {
    principal: 'COORDINATOR',
    operation: 'CREATE_TASK',
    taskId: null,
    targetProjectId: A,
    currentProjectId: null,
    presentedScope: { projectId: A, generation: GEN, token: projectScopeToken(A, GEN) },
    ...rest,
    world: {
      scope: { projectId: A, generation: GEN },
      projectStatus: { [A]: 'OPEN', [B]: 'OPEN', [C]: 'OPEN' },
      approval: null,
      ...world,
    },
  };
}

function approval(over: Partial<HandoffApproval> = {}): HandoffApproval {
  return { state: 'APPROVED', fromProjectId: A, toProjectId: B, taskId: TASK, ...over };
}

/** A declared move of an existing task out of A and into B. */
function handoff(over: Overrides = {}): ScopeWriteRequest {
  return write({ operation: 'HANDOFF_TASK', taskId: TASK, currentProjectId: A, targetProjectId: B, ...over });
}

test('same project: creating and updating inside the scope it holds is allowed and needs nobody', () => {
  const created = decide(write());
  assert.equal(created.decision, 'ALLOW');
  assert.equal(created.rule, 'R15_IN_SCOPE');
  assert.equal(created.crossing, false);
  assert.equal(created.blockerKind, null);

  const updated = decide(write({ operation: 'UPDATE_TASK', taskId: TASK, currentProjectId: A }));
  assert.equal(updated.decision, 'ALLOW');
  assert.equal(updated.rule, 'R15_IN_SCOPE');
});

test('the incident: a coordinator of A filing work into B is refused, and told what to do instead', () => {
  const refused = decide(write({ targetProjectId: B }));
  assert.equal(refused.decision, 'REFUSE');
  assert.equal(refused.code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(refused.rule, 'R7_UNDECLARED_CROSSING');
  assert.equal(refused.requiredAction, 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF');
  assert.equal(refused.responsible, 'COORDINATOR');
  assert.deepEqual(refused.ends, { from: A, to: B });
  // And the same batch, filed where it belongs, still goes through. A gate that also stops the
  // ordinary case is a gate somebody switches off.
  assert.equal(decide(write({ targetProjectId: A })).decision, 'ALLOW');
});

test('cross project: touching a task that lives elsewhere is out of scope, declared or not', () => {
  // Not a crossing — both ends are B — but B is not this writer's scope.
  const outside = decide(write({ operation: 'UPDATE_TASK', taskId: TASK, currentProjectId: B, targetProjectId: B }));
  assert.equal(outside.rule, 'R6_OUT_OF_SCOPE');
  assert.equal(outside.code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(outside.crossing, false);

  // Pulling somebody else's task INTO the scope it holds is still a crossing, and still undeclared.
  const pulled = decide(write({ operation: 'UPDATE_TASK', taskId: TASK, currentProjectId: B, targetProjectId: A }));
  assert.equal(pulled.rule, 'R7_UNDECLARED_CROSSING');
  assert.deepEqual(pulled.ends, { from: B, to: A });
});

test('cross project: a declared handoff is a request, and the user is the one who answers it', () => {
  const asked = decide(handoff());
  assert.equal(asked.decision, 'REQUIRE_APPROVAL');
  assert.equal(asked.code, 'CROSS_PROJECT_APPROVAL_REQUIRED');
  assert.equal(asked.rule, 'R10_NO_APPROVAL');
  assert.equal(asked.responsible, 'USER');
  assert.equal(asked.blockerKind, 'AWAITING_USER_APPROVAL');
  assert.equal(asked.crossing, true);

  assert.equal(decide(handoff({ world: { approval: approval({ state: 'PENDING' }) } })).rule, 'R11_APPROVAL_PENDING');
  assert.equal(decide(handoff({ world: { approval: approval({ state: 'DENIED' }) } })).rule, 'R12_APPROVAL_DENIED');
  assert.equal(decide(handoff({ world: { approval: approval({ state: 'EXPIRED' }) } })).rule, 'R13_APPROVAL_EXPIRED');

  const granted = decide(handoff({ world: { approval: approval() } }));
  assert.equal(granted.decision, 'ALLOW');
  assert.equal(granted.rule, 'R14_HANDOFF_APPROVED');
});

test('cross project: a yes about another move is not a yes about this one', () => {
  const otherTask = decide(handoff({ world: { approval: approval({ taskId: 'another-task' }) } }));
  assert.equal(otherTask.rule, 'R9_APPROVAL_TARGET_MISMATCH');
  assert.equal(otherTask.code, 'APPROVAL_TARGET_MISMATCH');

  const otherTarget = decide(handoff({ world: { approval: approval({ toProjectId: C }) } }));
  assert.equal(otherTarget.rule, 'R9_APPROVAL_TARGET_MISMATCH');

  // A PENDING answer about a different move is not a near-miss — this move simply has not been
  // asked about yet, so the answer is to ask.
  const pendingElsewhere = decide(handoff({ world: { approval: approval({ state: 'PENDING', toProjectId: C }) } }));
  assert.equal(pendingElsewhere.rule, 'R10_NO_APPROVAL');
});

test('cross project: filing NEW work into another project is the same crossing as moving one', () => {
  const declared = decide(write({ operation: 'HANDOFF_TASK', targetProjectId: B }));
  assert.equal(declared.crossing, true);
  assert.deepEqual(declared.ends, { from: A, to: B }, 'new work leaves the scope that authored it');
  assert.equal(declared.rule, 'R10_NO_APPROVAL');

  const withYes = decide(write({
    operation: 'HANDOFF_TASK',
    targetProjectId: B,
    world: { approval: approval({ taskId: null }) },
  }));
  assert.equal(withYes.decision, 'ALLOW');

  // Labelling an ordinary in-scope create as a handoff does not invent a crossing, and therefore
  // does not invent an approval either.
  const notReally = decide(write({ operation: 'HANDOFF_TASK' }));
  assert.equal(notReally.crossing, false);
  assert.equal(notReally.rule, 'R15_IN_SCOPE');
});

test('unclear target: work that names no project is refused and handed to a person', () => {
  const unmapped = decide(write({ targetProjectId: null }));
  assert.equal(unmapped.decision, 'REFUSE');
  assert.equal(unmapped.code, 'UNMAPPED_PROJECT_WORK');
  assert.equal(unmapped.rule, 'R4_NO_TARGET_PROJECT');
  assert.equal(unmapped.responsible, 'USER');
  assert.equal(unmapped.requiredAction, 'NAME_OWNING_PROJECT');
  assert.equal(unmapped.blockerKind, 'AWAITING_USER_INPUT');

  // The refusal does not depend on holding a scope: an unattributable write is unattributable.
  assert.equal(
    decide(write({ targetProjectId: null, presentedScope: null, world: { scope: null } })).code,
    'UNMAPPED_PROJECT_WORK',
  );
});

test('DONE project: a settled project takes no new work, and no approval buys a way in', () => {
  const intoDone = decide(write({ world: { projectStatus: { [A]: 'DONE', [B]: 'OPEN' } } }));
  assert.equal(intoDone.code, 'PROJECT_REOPEN_REQUIRED');
  assert.equal(intoDone.rule, 'R8_SETTLED_PROJECT');
  assert.equal(intoDone.requiredAction, 'REOPEN_PROJECT_FIRST');
  assert.equal(intoDone.responsible, 'USER');

  const approvedIntoDone = decide(handoff({
    world: { approval: approval(), projectStatus: { [A]: 'OPEN', [B]: 'DONE' } },
  }));
  assert.equal(approvedIntoDone.rule, 'R8_SETTLED_PROJECT',
    'an approved handoff into an accepted project would give it work its acceptance never saw');

  // Leaving a settled project changes ITS task set too, so the source end is checked as well.
  const outOfDone = decide(handoff({
    world: { approval: approval(), projectStatus: { [A]: 'DONE', [B]: 'OPEN' } },
  }));
  assert.equal(outOfDone.rule, 'R8_SETTLED_PROJECT');

  assert.equal(decide(write({ world: { projectStatus: { [A]: 'CANCELLED' } } })).code, 'PROJECT_REOPEN_REQUIRED');
  // Fail closed: a status the snapshot did not carry is not an OPEN project.
  assert.equal(decide(write({ world: { projectStatus: {} } })).code, 'PROJECT_REOPEN_REQUIRED');
});

test('takeover: a write from a scope that has moved is refused, and told to yield rather than retry', () => {
  const behind = decide(write({
    presentedScope: { projectId: A, generation: '2', token: projectScopeToken(A, '2') },
  }));
  assert.equal(behind.code, 'COORDINATOR_GENERATION_MOVED');
  assert.equal(behind.rule, 'R3_SCOPE_MOVED');
  assert.equal(behind.requiredAction, 'YIELD_TO_CURRENT_SCOPE');
  assert.equal(behind.responsible, 'SYSTEM');
  assert.equal(behind.blockerKind, null, 'nobody is being asked for anything: the successor decides');

  // The binding is gone entirely — rotated out while this write was in flight.
  assert.equal(decide(write({ world: { scope: null } })).rule, 'R3_SCOPE_MOVED');
  // A leftover scope naming a project this session no longer coordinates.
  assert.equal(
    decide(write({ presentedScope: { projectId: B, generation: GEN, token: projectScopeToken(B, GEN) } })).rule,
    'R3_SCOPE_MOVED',
  );
  // Staleness outranks everything the stale writer believed about the target, including that the
  // target was another project: telling it to file at home would be advice from a world it left.
  assert.equal(decide(write({ targetProjectId: B, world: { scope: null } })).rule, 'R3_SCOPE_MOVED');
});

test('takeover: a session that never held a scope is refused too, and it is not a generation story', () => {
  const never = decide(write({ presentedScope: null, world: { scope: null } }));
  assert.equal(never.code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(never.rule, 'R5_NO_SCOPE');
  assert.equal(never.requiredAction, 'YIELD_TO_CURRENT_SCOPE');
});

test('mixed versions: a client too old to carry a token is scoped exactly like a new one', () => {
  const legacy = decide(write({ presentedScope: null }));
  assert.equal(legacy.decision, 'ALLOW');
  assert.equal(legacy.rule, 'R15_IN_SCOPE');

  // What it loses is the ability to DECLARE a crossing — not a smaller scope, and not a bigger one.
  const legacyCrossing = decide(write({ presentedScope: null, targetProjectId: B }));
  assert.equal(legacyCrossing.code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(legacyCrossing.rule, 'R7_UNDECLARED_CROSSING');
});

test('mixed versions: a token that does not describe its own pair is a client bug, and retryable', () => {
  const garbled = decide(write({
    presentedScope: { projectId: A, generation: GEN, token: 'psc:v1:somebody-else:9' },
  }));
  assert.equal(garbled.code, 'PROJECT_SCOPE_MISMATCH');
  assert.equal(garbled.rule, 'R2_TOKEN_INCONSISTENT');
  assert.equal(garbled.requiredAction, 'RE_DERIVE_SCOPE',
    'a client that got the wire form wrong has not lost its authority');
});

test('the user is refused by nothing here — including everything refused above', () => {
  const refusedForAgents: Array<Overrides> = [
    { targetProjectId: B },
    { targetProjectId: null },
    { world: { scope: null }, presentedScope: null },
    { world: { projectStatus: { [A]: 'DONE' } } },
    { presentedScope: { projectId: A, generation: '1', token: projectScopeToken(A, '1') } },
    { operation: 'UPDATE_TASK', taskId: TASK, currentProjectId: B, targetProjectId: A },
  ];
  for (const over of refusedForAgents) {
    const asAgent = decide(write(over));
    assert.notEqual(asAgent.decision, 'ALLOW', 'this case is meant to be refused for an agent');
    const asUser = decide(write({ ...over, principal: 'USER' }));
    assert.equal(asUser.decision, 'ALLOW');
    assert.equal(asUser.rule, 'R1_USER_AUTHORITY');
  }
});

test('a worker session is bound by the same table, with its task\'s project as its scope', () => {
  const inTask = decide(write({ principal: 'WORKER', operation: 'CREATE_TASK', targetProjectId: A }));
  assert.equal(inTask.decision, 'ALLOW');
  const elsewhere = decide(write({ principal: 'WORKER', targetProjectId: B }));
  assert.equal(elsewhere.code, 'PROJECT_SCOPE_MISMATCH');
});

test('SC7: provenance is evidence, so it moves no decision anywhere', () => {
  // One shape per rule, so this property is checked on an input that reaches EVERY branch. The
  // first version of this test varied provenance over seven convenient shapes, and a mutation that
  // let `discoveredFromProjectId` satisfy R6 — the exact shape of "discovery becomes authority" —
  // walked straight through it, because none of the seven reached R6.
  const shapes: Array<[string, Overrides]> = [
    ['R1_USER_AUTHORITY', { principal: 'USER', targetProjectId: B }],
    ['R2_TOKEN_INCONSISTENT', { presentedScope: { projectId: A, generation: GEN, token: 'psc:v1:x:9' } }],
    ['R3_SCOPE_MOVED', { presentedScope: { projectId: A, generation: '2', token: projectScopeToken(A, '2') } }],
    ['R4_NO_TARGET_PROJECT', { targetProjectId: null }],
    ['R5_NO_SCOPE', { presentedScope: null, world: { scope: null } }],
    ['R6_OUT_OF_SCOPE', { operation: 'UPDATE_TASK', taskId: TASK, currentProjectId: B, targetProjectId: B }],
    ['R7_UNDECLARED_CROSSING', { targetProjectId: B }],
    ['R8_SETTLED_PROJECT', { world: { projectStatus: { [A]: 'DONE' } } }],
    ['R9_APPROVAL_TARGET_MISMATCH', { operation: 'HANDOFF_TASK', taskId: TASK, currentProjectId: A,
      targetProjectId: B, world: { approval: approval({ taskId: 'other' }) } }],
    ['R10_NO_APPROVAL', { operation: 'HANDOFF_TASK', taskId: TASK, currentProjectId: A, targetProjectId: B }],
    ['R11_APPROVAL_PENDING', { operation: 'HANDOFF_TASK', taskId: TASK, currentProjectId: A,
      targetProjectId: B, world: { approval: approval({ state: 'PENDING' }) } }],
    ['R12_APPROVAL_DENIED', { operation: 'HANDOFF_TASK', taskId: TASK, currentProjectId: A,
      targetProjectId: B, world: { approval: approval({ state: 'DENIED' }) } }],
    ['R13_APPROVAL_EXPIRED', { operation: 'HANDOFF_TASK', taskId: TASK, currentProjectId: A,
      targetProjectId: B, world: { approval: approval({ state: 'EXPIRED' }) } }],
    ['R14_HANDOFF_APPROVED', { operation: 'HANDOFF_TASK', taskId: TASK, currentProjectId: A,
      targetProjectId: B, world: { approval: approval() } }],
    ['R15_IN_SCOPE', {}],
  ];
  const provenances = [
    undefined,
    { discoveredFromProjectId: B, triggerEvent: 'task.failed', sourceTaskId: TASK, sourceSessionId: 's1' },
    { discoveredFromProjectId: A, triggerEvent: 'merge.conflict', sourceTaskId: null, sourceSessionId: null },
    { discoveredFromProjectId: C, triggerEvent: 'verification.failed', sourceTaskId: 'x', sourceSessionId: 'y' },
  ];
  for (const [expected, shape] of shapes) {
    const baseline = decide(write(shape));
    assert.equal(baseline.rule, expected, `the shape for ${expected} no longer reaches it`);
    for (const provenance of provenances) {
      const withEvidence = decideProjectScopeWrite(write({ ...shape, provenance }));
      assert.deepEqual(withEvidence, baseline,
        `${expected}: a decision moved when only the provenance changed — discovery has become authority`);
    }
  }
  assert.deepEqual(shapes.map(([rule]) => rule), SCOPE_RULES.map((r) => r.id),
    'a rule this property does not reach is a rule provenance could quietly be read by');
});

test('restart: the same write replayed against the same snapshot decides the same way', () => {
  // SC4. After a restart the session does not remember what it decided — it re-derives the scope
  // from the same row and asks again. The decision is a pure function of the snapshot, so "asks
  // again" and "asked once" must be the same answer, or a retry after a crash becomes a second
  // outcome for one write. The token is part of that: it is recomputed, not remembered.
  const before = write();
  const afterRestart = write({
    presentedScope: { projectId: A, generation: GEN, token: projectScopeToken(A, GEN) },
  });
  assert.deepEqual(decide(afterRestart), decide(before));

  // And a replay that arrives after the scope was rotated away is refused rather than applied a
  // second time under a scope that no longer exists.
  const late = decide(write({ world: { scope: { projectId: A, generation: '4' } } }));
  assert.equal(late.rule, 'R3_SCOPE_MOVED');
  // Replaying a REFUSED write does not accumulate anything either: same input, same refusal.
  assert.deepEqual(decide(write({ targetProjectId: B })), decide(write({ targetProjectId: B })));
});

test('the transition table is total, and its two load-bearing properties hold', () => {
  for (const state of SCOPE_WORK_STATES) {
    for (const event of SCOPE_WORK_EVENTS) {
      const next = nextScopeWorkState(state, event);
      assert.ok(next === null || SCOPE_WORK_STATES.includes(next),
        `(${state}, ${event}) leads outside the state set`);
    }
    // S2: the user always has an exit, from every state including the terminal one.
    assert.equal(nextScopeWorkState(state, 'USER_ASSIGNS_PROJECT'), 'FILED');
    // S3: a takeover undoes nothing that was written down.
    assert.equal(nextScopeWorkState(state, 'SCOPE_LOST'), state === 'DISCOVERED' ? 'ABANDONED' : state);
  }
  // An unknown state or event is a different failure from a refused one, and must not answer alike.
  assert.throws(() => nextScopeWorkState('NOWHERE' as ScopeWorkState, 'APPLY'), /unknown scope work state/);
  assert.throws(() => nextScopeWorkState('FILED', 'NOTHING' as typeof SCOPE_WORK_EVENTS[number]),
    /unknown scope work event/);
});

test('the transition table refuses every shortcut it exists to refuse', () => {
  // S4: approval is not application.
  assert.equal(nextScopeWorkState('HANDOFF_REQUESTED', 'APPLY'), null);
  assert.equal(nextScopeWorkState('HANDOFF_APPROVED', 'APPLY'), 'FILED');
  // A settled landing cannot be approved past.
  assert.equal(nextScopeWorkState('REOPEN_REQUIRED', 'APPROVE'), null);
  assert.equal(nextScopeWorkState('REOPEN_REQUIRED', 'APPLY'), null);
  // S5: a reopen sends the decision back to the entry, because the world it read is gone.
  assert.equal(nextScopeWorkState('REOPEN_REQUIRED', 'TARGET_REOPENED'), 'DISCOVERED');
  // S6: retrying the same write does not make an unclear owner clearer.
  assert.equal(nextScopeWorkState('UNMAPPED', 'FILE_IN_SCOPE'), null);
  // A DONE project does not evict the work it already owns.
  assert.equal(nextScopeWorkState('FILED', 'TARGET_SETTLED'), 'FILED');
  // SC4: replaying the same write under the same scope is one task, not two.
  assert.equal(nextScopeWorkState('FILED', 'FILE_IN_SCOPE'), 'FILED');
});

test('every rule in the frozen table is reachable, and this file reaches all of them', () => {
  const missing = SCOPE_RULES.map((r) => r.id).filter((id) => !reached.has(id));
  assert.deepEqual(missing, [],
    'a rule no test in this file can reach is a rule nothing proves is right');
});

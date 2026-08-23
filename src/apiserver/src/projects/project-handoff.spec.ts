/**
 * Unit L4's rules, as rules — before anything enforces them.
 *
 * Every claim the contract module makes that a reviewer would otherwise have to take on trust:
 * that the state table IS §6's (checked against L1's frozen table, not against a copy), that a
 * refused crossing stays refused, that the identity binds every field an approval authorises, and
 * that two crossings which differ only in where the work was noticed are two questions.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HANDOFF_APPROVAL_TTL_MS,
  HANDOFF_EVENTS,
  HANDOFF_KINDS,
  HANDOFF_STORED_STATES,
  HANDOFF_TRANSITIONS,
  decideHandoffAcceptance,
  dependencyCrossingRefusal,
  handoffApprovalOf,
  handoffCrossingKey,
  handoffDependentDigest,
  handoffPayloadDigest,
  nextHandoffState,
  sessionTriggerEvent,
  type HandoffRequestIdentity,
} from './project-handoff';
import { SCOPE_WORK_TRANSITIONS, nextScopeWorkState } from './project-scope-contract';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PROJECT_A = '22222222-2222-4222-8222-222222222222';
const PROJECT_B = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';
const OTHER_TASK = '55555555-5555-4555-8555-555555555555';
const SESSION = '66666666-6666-4666-8666-666666666666';

const identity = (over: Partial<HandoffRequestIdentity['plan']> = {},
                  source: Partial<HandoffRequestIdentity['source']> = {}): HandoffRequestIdentity => ({
  plan: {
    title: 'ship the thing',
    description: 'the description',
    acceptanceCriteria: 'it ships',
    labels: ['b', 'a'],
    assigneeId: null,
    listId: null,
    provider: null,
    model: null,
    autoRunWhenReady: null,
    runAt: null,
    dueDate: null,
    completionPolicy: null,
    parentTaskId: null,
    parentRefDigest: null,
    verifiesTaskId: null,
    verifiesRefDigest: null,
    supersedesTaskId: null,
    dependsOnTaskIds: [],
    dependsOnRefDigests: [],
    ...over,
  },
  source: {
    projectId: PROJECT_A,
    taskId: TASK,
    sessionId: SESSION,
    triggerEvent: 'coordinator.session_filed',
    ...source,
  },
});

const crossing = (payloadDigest: string, over: Partial<Parameters<typeof handoffCrossingKey>[0]> = {}) =>
  handoffCrossingKey({
    ownerId: OWNER,
    fromProjectId: PROJECT_A,
    toProjectId: PROJECT_B,
    kind: 'FILE_TASK',
    subjectTaskId: null,
    payloadDigest,
    ...over,
  });

test('the stored transitions are §6 HANDOFF_* rows, not a second opinion about them', () => {
  // DENIED is §6's ABANDONED, reached by REFUSE_HANDOFF; the mapping is stated here so the
  // comparison below is against L1's frozen table rather than against a copy of it.
  const asScopeState = {
    PENDING: 'HANDOFF_REQUESTED',
    APPROVED: 'HANDOFF_APPROVED',
    DENIED: 'ABANDONED',
    APPLIED: 'FILED',
  } as const;
  const asScopeEvent = { APPROVE: 'APPROVE', DENY: 'REFUSE_HANDOFF', APPLY: 'APPLY' } as const;
  for (const state of HANDOFF_STORED_STATES) {
    for (const event of HANDOFF_EVENTS) {
      // The one cell that deliberately differs, and why. §6's `FILED --APPLY--> FILED` is the
      // IDEMPOTENT replay of one application — the same write arriving twice — and this table is
      // about the row's own state, where a second APPLY is a second crossing wearing the first
      // one's approval. The service tells them apart the only way they can be told apart: by which
      // task the yes was spent on (`ProjectHandoffService.spend`), answering "already done" to the
      // first and refusing the second. Modelling that as a transition would make them one event.
      if (state === 'APPLIED' && event === 'APPLY') {
        assert.equal(nextHandoffState(state, event), null);
        assert.equal(nextScopeWorkState('FILED', 'APPLY'), 'FILED');
        continue;
      }
      const mine = nextHandoffState(state, event);
      const theirs = nextScopeWorkState(asScopeState[state], asScopeEvent[event]);
      assert.equal(
        mine === null ? null : asScopeState[mine],
        theirs,
        `${state} --${event}--> disagrees with §6`,
      );
    }
  }
  // And the property that matters most, stated directly: a spent yes and a refused question both
  // accept nothing at all.
  for (const event of HANDOFF_EVENTS) {
    assert.equal(HANDOFF_TRANSITIONS.APPLIED[event], null);
    assert.equal(HANDOFF_TRANSITIONS.DENIED[event], null, `DENIED must not accept ${event}`);
  }
});

test('a refused crossing cannot be revived by re-approving it', () => {
  assert.equal(nextHandoffState('DENIED', 'APPROVE'), null);
  assert.equal(nextHandoffState('DENIED', 'APPLY'), null);
  // §6's one exit from ABANDONED is the user filing the work themselves, which is not an event of
  // this table at all — it is an ordinary write under R1.
  assert.equal(SCOPE_WORK_TRANSITIONS.ABANDONED.USER_ASSIGNS_PROJECT, 'FILED');
  assert.equal(SCOPE_WORK_TRANSITIONS.ABANDONED.APPROVE, null);
});

test('the identity binds every field an approval authorises, not just the prose', () => {
  const base = handoffPayloadDigest(identity());
  const moved: Array<[string, HandoffRequestIdentity]> = [
    ['title', identity({ title: 'something else' })],
    ['description', identity({ description: 'other' })],
    ['acceptanceCriteria', identity({ acceptanceCriteria: 'other' })],
    ['assignee', identity({ assigneeId: TASK })],
    ['list', identity({ listId: TASK })],
    ['provider', identity({ provider: 'codex' })],
    ['model', identity({ model: 'claude-opus-5' })],
    ['autoRunWhenReady', identity({ autoRunWhenReady: true })],
    ['runAt', identity({ runAt: '2026-08-23T00:00:00.000Z' })],
    ['dueDate', identity({ dueDate: '2026-08-23T00:00:00.000Z' })],
    ['completionPolicy', identity({ completionPolicy: 'ALL_CHILDREN_DONE' })],
    ['parent', identity({ parentTaskId: TASK })],
    ['parentRef', identity({ parentRefDigest: 'abc' })],
    ['verifies', identity({ verifiesTaskId: TASK })],
    ['verifiesRef', identity({ verifiesRefDigest: 'abc' })],
    ['supersedes', identity({ supersedesTaskId: TASK })],
    ['dependsOn', identity({ dependsOnTaskIds: [TASK] })],
    ['dependsOnRef', identity({ dependsOnRefDigests: ['abc'] })],
    ['labels', identity({ labels: ['c'] })],
    ['source project', identity({}, { projectId: PROJECT_B })],
    ['source task', identity({}, { taskId: OTHER_TASK })],
    ['source session', identity({}, { sessionId: OTHER_TASK })],
    ['source event', identity({}, { triggerEvent: 'agent.session_filed' })],
  ];
  for (const [what, moved_] of moved) {
    assert.notEqual(handoffPayloadDigest(moved_), base, `${what} must change the identity`);
  }
});

test('two spellings of one request are one question; two sources are two', () => {
  // Absent and explicitly null are the same request.
  assert.equal(
    handoffPayloadDigest(identity({ description: null })),
    handoffPayloadDigest({
      plan: { ...identity().plan, description: undefined },
      source: identity().source,
    }),
  );
  // Label ORDER is not a fact about the work.
  assert.equal(
    handoffPayloadDigest(identity({ labels: ['a', 'b'] })),
    handoffPayloadDigest(identity({ labels: ['b', 'a'] })),
  );
  // The same words noticed on a different task is a DIFFERENT crossing — the defect this closes is
  // two coordinators' findings collapsing into one question whose answer files a task whose
  // back-link points at whichever of them happened to be first.
  assert.notEqual(
    crossing(handoffPayloadDigest(identity({}, { taskId: TASK }))),
    crossing(handoffPayloadDigest(identity({}, { taskId: OTHER_TASK }))),
  );
});

test('the crossing key separates every end, kind and subject', () => {
  const digest = handoffPayloadDigest(identity());
  const base = crossing(digest);
  assert.notEqual(base, crossing(digest, { ownerId: PROJECT_A }));
  assert.notEqual(base, crossing(digest, { fromProjectId: PROJECT_B }));
  assert.notEqual(base, crossing(digest, { toProjectId: PROJECT_A }));
  assert.notEqual(base, crossing(digest, { kind: 'MOVE_TASK', subjectTaskId: TASK }));
  assert.notEqual(
    crossing(digest, { kind: 'MOVE_TASK', subjectTaskId: TASK }),
    crossing(digest, { kind: 'MOVE_TASK', subjectTaskId: OTHER_TASK }),
  );
  // Stable across runs and processes: an identity that moved between two calls would file a second
  // question for one crossing every time.
  assert.equal(base, crossing(handoffPayloadDigest(identity())));
});

test('a dependency crossing names the dependent, by id or by whole plan', () => {
  assert.notEqual(
    handoffDependentDigest({ taskId: TASK }),
    handoffDependentDigest({ taskId: OTHER_TASK }),
  );
  assert.notEqual(
    handoffDependentDigest({ identity: identity() }),
    handoffDependentDigest({ identity: identity({ title: 'other' }) }),
  );
  assert.notEqual(handoffDependentDigest({ taskId: TASK }), handoffDependentDigest({ identity: identity() }));
});

test('who may accept: both ends AUTO and open, or a person', () => {
  const open = (policy: 'MANUAL' | 'GUARDED_AUTO' | 'AUTO') =>
    ({ status: 'OPEN', automationPolicy: policy }) as const;
  assert.deepEqual(decideHandoffAcceptance(open('AUTO'), open('AUTO')),
    { acceptedBy: 'POLICY', rule: 'HP3_BOTH_AUTO' });
  // The task's own words: under guarded-auto a crossing waits for a person.
  for (const [from, to] of [
    ['GUARDED_AUTO', 'AUTO'], ['AUTO', 'GUARDED_AUTO'], ['MANUAL', 'AUTO'], ['AUTO', 'MANUAL'],
    ['GUARDED_AUTO', 'GUARDED_AUTO'],
  ] as const) {
    assert.deepEqual(decideHandoffAcceptance(open(from), open(to)),
      { acceptedBy: 'USER', rule: 'HP2_NOT_BOTH_AUTO' });
  }
  // A settled end is a person's decision whatever the policies say — and R8 refuses the write
  // outright, so this is only about who could ever answer.
  for (const status of ['DONE', 'CANCELLED'] as const) {
    assert.equal(
      decideHandoffAcceptance({ status, automationPolicy: 'AUTO' }, open('AUTO')).acceptedBy, 'USER');
    assert.equal(
      decideHandoffAcceptance(open('AUTO'), { status, automationPolicy: 'AUTO' }).rule,
      'HP1_TARGET_NOT_OPEN');
  }
});

test('an unspent yes expires; a spent one names the task it was spent on', () => {
  const now = new Date('2026-08-23T12:00:00.000Z');
  const live = {
    fromProjectId: PROJECT_A, toProjectId: PROJECT_B, kind: 'FILE_TASK' as const,
    subjectTaskId: null, state: 'APPROVED' as const,
    expiresAt: new Date(now.getTime() + 1), appliedTaskId: null,
  };
  assert.equal(handoffApprovalOf(live, now).state, 'APPROVED');
  assert.equal(handoffApprovalOf(live, now).taskId, null);
  assert.equal(handoffApprovalOf({ ...live, expiresAt: now }, now).state, 'EXPIRED');
  assert.equal(
    handoffApprovalOf({ ...live, expiresAt: new Date(now.getTime() - 1) }, now).state, 'EXPIRED');
  // APPLIED reads as an APPROVED that names its task, which is what makes R9 answer a second write:
  // a create's taskId is null, so it no longer matches.
  const spent = handoffApprovalOf(
    { ...live, state: 'APPLIED', appliedTaskId: TASK }, new Date(now.getTime() + HANDOFF_APPROVAL_TTL_MS * 2));
  assert.equal(spent.state, 'APPROVED');
  assert.equal(spent.taskId, TASK);
});

test('a dependency crossing refuses with L1 codes and no synonyms', () => {
  assert.equal(dependencyCrossingRefusal(null), 'CROSS_PROJECT_APPROVAL_REQUIRED');
  const base = { fromProjectId: PROJECT_A, toProjectId: PROJECT_B, taskId: null };
  assert.equal(dependencyCrossingRefusal({ ...base, state: 'PENDING' }), 'APPROVAL_PENDING');
  assert.equal(dependencyCrossingRefusal({ ...base, state: 'DENIED' }), 'APPROVAL_DENIED');
  assert.equal(dependencyCrossingRefusal({ ...base, state: 'EXPIRED' }), 'APPROVAL_EXPIRED');
  assert.equal(dependencyCrossingRefusal({ ...base, state: 'APPROVED' }), null);
});

test('the trigger event is derived from what the session is, in one place', () => {
  assert.equal(sessionTriggerEvent({ coordinatesProject: true, executesTask: false }), 'coordinator.session_filed');
  assert.equal(sessionTriggerEvent({ coordinatesProject: true, executesTask: true }), 'coordinator.session_filed');
  assert.equal(sessionTriggerEvent({ coordinatesProject: false, executesTask: true }), 'task.session_filed');
  assert.equal(sessionTriggerEvent({ coordinatesProject: false, executesTask: false }), 'agent.session_filed');
});

test('the closed sets are closed', () => {
  assert.deepEqual([...HANDOFF_KINDS], ['FILE_TASK', 'MOVE_TASK', 'DEPEND_ON_TASK']);
  assert.deepEqual([...HANDOFF_STORED_STATES], ['PENDING', 'APPROVED', 'DENIED', 'APPLIED']);
  assert.throws(() => nextHandoffState('NOPE' as never, 'APPROVE'), /unknown handoff state/);
  assert.throws(() => nextHandoffState('PENDING', 'NOPE' as never), /unknown handoff event/);
});

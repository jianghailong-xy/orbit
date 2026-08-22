import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FailedTaskFacts,
  failedTaskBlockerKind,
  failedTaskDisposition,
  failedTaskNeedsAttention,
  loopCanRetryFailedTask,
} from './project-failed-retry';
import { MAX_AUTO_RUN_FAILURES } from '../tasks/task-retry-policy';
import {
  ProjectActionAuthorizationInput,
  authorizeProjectAction,
} from './project-authorization.service';

/**
 * The one judgement four gates make (§7.4 precondition 1, §9.2, §7.2 TU2, §11.4), enumerated.
 *
 * Every test here is over the WHOLE input space rather than over examples, because the property
 * that matters is not "this case answers X" — it is that no case answers two things at once. Both
 * defects this unit closes were compositions of individually correct rules.
 */

function facts(overrides: Partial<FailedTaskFacts> = {}): FailedTaskFacts {
  return {
    status: 'FAILED',
    hasLiveSession: false,
    failureCount: 1,
    failureAttributable: true,
    retryBackoffExpired: true,
    ...overrides,
  };
}

const STATUSES = ['OPEN', 'IN_PROGRESS', 'FAILED', 'DONE', 'CANCELLED'];
const COUNTS = [0, 1, MAX_AUTO_RUN_FAILURES - 1, MAX_AUTO_RUN_FAILURES, MAX_AUTO_RUN_FAILURES + 1];
const BOOLS = [true, false];

/** The full cartesian product of everything the judgement reads: 5 × 2 × 5 × 2 × 2 = 200 worlds. */
function everyWorld(): FailedTaskFacts[] {
  const worlds: FailedTaskFacts[] = [];
  for (const status of STATUSES) {
    for (const hasLiveSession of BOOLS) {
      for (const failureCount of COUNTS) {
        for (const failureAttributable of BOOLS) {
          for (const retryBackoffExpired of BOOLS) {
            worlds.push({
              status, hasLiveSession, failureCount, failureAttributable, retryBackoffExpired,
            });
          }
        }
      }
    }
  }
  return worlds;
}

test('§9.5 Q3 rows 2 and 3: below the cap, an attributable failure is the loop\'s to move', () => {
  assert.equal(failedTaskDisposition(facts()), 'RETRY_DUE');
  assert.equal(failedTaskDisposition(facts({ retryBackoffExpired: false })), 'RETRY_BACKOFF');
  assert.equal(
    failedTaskDisposition(facts({ failureCount: MAX_AUTO_RUN_FAILURES - 1 })),
    'RETRY_DUE',
    'one short of the cap is still the loop\'s',
  );
  assert.ok(loopCanRetryFailedTask(failedTaskDisposition(facts())));
  assert.ok(loopCanRetryFailedTask(failedTaskDisposition(facts({ retryBackoffExpired: false }))));
});

test('§9.5 Q3 last row and §9.2\'s UNKNOWN_FAILURE: the two cells a person owns', () => {
  const exhausted = failedTaskDisposition(facts({ failureCount: MAX_AUTO_RUN_FAILURES }));
  const unattributable = failedTaskDisposition(facts({ failureAttributable: false }));
  assert.equal(exhausted, 'ATTEMPTS_EXHAUSTED');
  assert.equal(unattributable, 'UNATTRIBUTABLE');
  for (const disposition of [exhausted, unattributable]) {
    assert.equal(loopCanRetryFailedTask(disposition), false);
    assert.ok(failedTaskNeedsAttention(disposition));
  }
});

test('the overlap has ONE answer: unattributable AND at the cap is UNKNOWN_FAILURE', () => {
  // Five runs that all died without recording why. Both §11.2 rows' conditions hold; §9.2 has
  // answered `UNKNOWN_FAILURE` for this exact world since v1, and §11 must not contradict it.
  const both = facts({ failureCount: MAX_AUTO_RUN_FAILURES, failureAttributable: false });
  assert.equal(failedTaskBlockerKind(both), 'UNKNOWN_FAILURE');
  assert.equal(failedTaskDisposition(both), 'UNATTRIBUTABLE');
  assert.equal(failedTaskDisposition({ ...both, status: 'OPEN' }), 'NOT_FAILED');
  // …and the kind is still decided for the OPEN task, because §9.5 Q3 measures the run history and
  // not the label. This is what keeps `TEST_FAILED` opening on an OPEN task, as it has since v1.1.
  assert.equal(failedTaskBlockerKind({ ...both, failureAttributable: true }), 'TEST_FAILED');
});

test('a task with no counted failure is retryable, not unattributable', () => {
  // `failures.every(f => f.error)` is vacuously true at zero, and §6.1 excludes quota kills from
  // the count — so "FAILED with nothing counted" is one quota outage, which must not park a task
  // forever. The `> 0` guard is what makes that true.
  assert.equal(failedTaskDisposition(facts({ failureCount: 0 })), 'RETRY_DUE');
  assert.equal(
    failedTaskDisposition(facts({ failureCount: 0, failureAttributable: false })),
    'RETRY_DUE',
  );
  assert.equal(failedTaskBlockerKind({ failureCount: 0, failureAttributable: false }), null);
});

test('a live Session owns the task, whatever its failure history says', () => {
  for (const overrides of [{}, { failureCount: MAX_AUTO_RUN_FAILURES }, { failureAttributable: false }]) {
    assert.equal(
      failedTaskDisposition(facts({ ...overrides, hasLiveSession: true })),
      'OCCUPIED',
      'somebody is on it: §7.4 precondition 4 and §4.2 guard 5',
    );
  }
});

test('over every world: the disposition and the blocker kind never disagree', () => {
  for (const world of everyWorld()) {
    const disposition = failedTaskDisposition(world);
    const kind = failedTaskBlockerKind(world);
    if (disposition === 'UNATTRIBUTABLE') {
      assert.equal(kind, 'UNKNOWN_FAILURE', JSON.stringify(world));
    }
    if (disposition === 'ATTEMPTS_EXHAUSTED') {
      assert.equal(kind, 'TEST_FAILED', JSON.stringify(world));
    }
    // The converse only binds on a settled failure: `failedTaskBlockerKind` is deliberately status
    // -blind (an OPEN task that burned its budget still opens `TEST_FAILED`), so the implication
    // runs one way for the other statuses.
    if (world.status === 'FAILED' && !world.hasLiveSession && kind !== null) {
      assert.ok(failedTaskNeedsAttention(disposition), JSON.stringify(world));
    }
  }
});

test('over every world: exactly one of "the loop retries it" and "a person owns it" is true', () => {
  for (const world of everyWorld()) {
    const disposition = failedTaskDisposition(world);
    assert.equal(
      Number(loopCanRetryFailedTask(disposition)) + Number(failedTaskNeedsAttention(disposition)),
      disposition === 'NOT_FAILED' || disposition === 'OCCUPIED' ? 0 : 1,
      `${JSON.stringify(world)} answered two things at once`,
    );
  }
});

test('the cap is the shared one, and a caller may not install a second ladder', () => {
  // `maxAutoRunFailures` exists because §9.2's adapter carries the same constant on its input; it
  // is not a per-caller policy knob, and the default is the one ladder §9.5 froze.
  assert.equal(
    failedTaskDisposition(facts({ failureCount: 2, maxAutoRunFailures: 2 })),
    'ATTEMPTS_EXHAUSTED',
  );
  assert.equal(failedTaskDisposition(facts({ failureCount: 2 })), 'RETRY_DUE');
  assert.equal(MAX_AUTO_RUN_FAILURES, 5, 'the ladder this suite reasons about');
});

/**
 * §9.2 asked the same question, on the same facts, and the two must answer it the same way.
 *
 * This is the anti-drift check the whole module exists for, and it is why `authorizeTaskState` was
 * left with a plain `status` gate instead of a second call into this file: §9.2's own clauses ARE
 * the precedence `failedTaskBlockerKind` froze, so what has to be pinned is the AGREEMENT, not the
 * call graph. If somebody changes either side, this goes red.
 */
function authorizationOf(task: FailedTaskFacts) {
  const input: ProjectActionAuthorizationInput = {
    v: 1,
    sourceDecisionInputHash: 'h'.repeat(64),
    idempotencyKey: 'pc:v1:p:dispatch:t:0',
    evaluatedAt: '2026-08-22T00:00:00.000Z',
    action: 'DISPATCH_TASK',
    requiredPermission: 'COORDINATE',
    project: {
      id: 'p', status: 'OPEN', coordinatorEnabled: true, automationPolicy: 'AUTO',
      configRevision: '0', inFlightTasks: 0, maxConcurrentTasks: 3,
      coordinatorSessionsStartedLast24h: 0, sessionBudgetPerDay: null,
    },
    principal: {
      agentId: 'a', coordinatorAgentId: 'a', memberRole: 'COORDINATOR', agentEnabled: true,
      agentDeleted: false, canCoordinate: true, canCreateTasks: true, canDelegate: true,
    },
    task: {
      id: 't', status: task.status, dispatchHold: false, runAtDue: true, dependenciesReady: true,
      verificationBlock: null, hasLiveSession: task.hasLiveSession, assigneeAgentId: 'a',
      assigneeIsProjectMember: true, assigneeEnabled: true, agentInFlightTasks: 0,
      agentMaxConcurrentTasks: null,
      failureCount: task.failureCount,
      maxAutoRunFailures: task.maxAutoRunFailures ?? MAX_AUTO_RUN_FAILURES,
      failureAttributable: task.failureAttributable,
      // The backoff arm is asked of §9.2 the way the adapter asks it: an instant, not a boolean.
      retryBackoffUntil: task.retryBackoffExpired ? null : '2026-08-22T01:00:00.000Z',
    },
    approval: { state: 'NONE', targetIdempotencyKey: null },
    provider: {
      requestedProvider: 'claude', requestedModel: null, explicitFallbacks: [],
      availability: [{ provider: 'claude', available: true, models: null, defaultModel: null }],
    },
    runner: {
      available: true, capabilitiesReported: true, capabilities: [], requiredCapabilities: [],
    },
  };
  return authorizeProjectAction(input);
}

test('§9.2 and this module agree, on every world, about which cell a FAILED task is in', () => {
  for (const world of everyWorld()) {
    if (world.status !== 'FAILED') continue;
    const disposition = failedTaskDisposition(world);
    const { decision, reasonCode } = authorizationOf(world);
    const where = JSON.stringify(world);
    if (disposition === 'OCCUPIED') {
      assert.equal(reasonCode, 'TASK_ALREADY_RUNNING', where);
    } else if (disposition === 'UNATTRIBUTABLE') {
      assert.equal(reasonCode, 'UNKNOWN_FAILURE', where);
      assert.equal(decision, 'REQUIRE_APPROVAL', where);
    } else if (disposition === 'ATTEMPTS_EXHAUSTED') {
      assert.equal(reasonCode, 'MAX_ATTEMPTS_REACHED', where);
      assert.equal(decision, 'REQUIRE_APPROVAL', where);
    } else if (disposition === 'RETRY_BACKOFF') {
      assert.equal(reasonCode, 'RETRY_BACKOFF_ACTIVE', where);
      assert.equal(decision, 'DEFER', where);
    } else {
      // RETRY_DUE: the loop's own next step, admitted under AUTO with no approval in the way.
      assert.equal(decision, 'ALLOW', where);
      assert.equal(reasonCode, 'POLICY_ALLOWED', where);
    }
  }
});

test('a FAILED task is no longer answered with the silent code', () => {
  // `TASK_NOT_OPEN` is in §11.2's non-blocking list: it opens no row and names no owner, so it was
  // the shape of the silence. A settled failure must never come back with it again.
  for (const world of everyWorld()) {
    if (world.status !== 'FAILED') continue;
    assert.notEqual(authorizationOf(world).reasonCode, 'TASK_NOT_OPEN', JSON.stringify(world));
  }
  // …and every other non-OPEN status still is, because those are not failures at all.
  for (const status of ['IN_PROGRESS', 'DONE', 'CANCELLED']) {
    assert.equal(authorizationOf(facts({ status })).reasonCode, 'TASK_NOT_OPEN', status);
  }
});

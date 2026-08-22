import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatchDesiredSessionId,
  dispatchRuntimeSessionId,
} from './project-dispatch-identity';
import { wireRefusalCode } from './project-task-dispatcher.service';
import {
  PROJECT_BLOCKER_NON_BLOCKING_REFUSALS,
  blockerKindForRefusal,
} from './project-blocker';

const KEY = 'pc:v1:11111111-1111-4111-8111-111111111111:dispatch:22222222-2222-4222-8222-222222222222:7';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('the desired Session id is a function of the request, not of the attempt that computes it',
  () => {
    assert.equal(dispatchDesiredSessionId(KEY), dispatchDesiredSessionId(KEY));
    assert.match(dispatchDesiredSessionId(KEY), UUID);
    // §8.2 DA2: a genuinely new attempt mints a new epoch, so it must mint a new Session too —
    // otherwise a retry after a backoff would collide with the run it is retrying.
    assert.notEqual(dispatchDesiredSessionId(KEY), dispatchDesiredSessionId(`${KEY.slice(0, -1)}8`));
  });

test('the id says it was derived rather than drawn', () => {
  // RFC 9562 §5.5. A reader who cannot tell a derived id from a random one cannot tell "these are
  // the same request" from "these two ids happen to match".
  const [, , third, fourth] = dispatchDesiredSessionId(KEY).split('-');
  assert.equal(third[0], '5');
  assert.ok(['8', '9', 'a', 'b'].includes(fourth[0]), `variant nibble was ${fourth[0]}`);
});

test('the runtime id is derived from the same request in its own namespace', () => {
  assert.equal(dispatchRuntimeSessionId(KEY), dispatchRuntimeSessionId(KEY));
  assert.match(dispatchRuntimeSessionId(KEY), UUID);
  // Same key, two ids: the whole INSERT is a function of the request, and no column can collide
  // with another column of the same row.
  assert.notEqual(dispatchRuntimeSessionId(KEY), dispatchDesiredSessionId(KEY));
});

test('a raced Session insert goes on the wire as a code the fleet already classifies', () => {
  // §13.1 AG6-e. The persistent column must carry a word every reader ALREADY has: BL2 fails an
  // unrecognised code closed to `UNKNOWN_FAILURE` against the PROJECT, which BL1 reads as "stop
  // everything" and §11.4 can never clear. Adding the precise code to this build's non-blocking
  // set would fix this build's reader and nothing else in a rolling deploy.
  assert.equal(wireRefusalCode('DISPATCH_SESSION_RACED'), 'STALE_SNAPSHOT');
  assert.ok(PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has(wireRefusalCode('DISPATCH_SESSION_RACED')));
  assert.equal(blockerKindForRefusal(wireRefusalCode('DISPATCH_SESSION_RACED')), null);
  // ...and the precise cause is NOT on the wire, so nothing downstream can start branching on it.
  assert.ok(!PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has('DISPATCH_SESSION_RACED'));
  assert.equal(blockerKindForRefusal('DISPATCH_SESSION_RACED'), 'UNKNOWN_FAILURE');
});

test('the codes that already had a wire spelling keep it', () => {
  assert.equal(wireRefusalCode('TASK_AGGREGATE_PARENT'), 'STALE_SNAPSHOT');
  assert.equal(wireRefusalCode('VERIFICATION_NOT_PASSED'), 'TASK_DEPENDENCIES_INCOMPLETE');
  assert.equal(wireRefusalCode('TASK_ALREADY_RUNNING'), 'TASK_ALREADY_RUNNING');
});

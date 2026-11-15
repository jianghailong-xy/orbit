import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pendingWaitLabel } from './coordinator-pending-waits';

test('a wait is labelled by what it watches and what it waits for', () => {
  assert.equal(
    pendingWaitLabel({ kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_DONE' }, ['Fix login redirect']),
    'Waiting for "Fix login redirect" to be DONE',
  );
  assert.equal(
    pendingWaitLabel({ kind: 'ANY', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' }, ['A', 'B', 'C']),
    'Waiting for "A" and 2 more to finish',
  );
  assert.equal(
    pendingWaitLabel({ kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_PROGRESS_AT_LEAST', params: { percent: 50 } }, ['A']),
    'Waiting for "A" to reach 50%',
  );
  assert.equal(
    pendingWaitLabel({ kind: 'ANY_OF', operands: [{ kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' }] }, [null]),
    'Waiting for a deleted target to finish its turn',
  );
  assert.equal(pendingWaitLabel({}, []), 'Waiting for its targets to change');
});

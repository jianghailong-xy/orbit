import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGGREGATION_SCOPE_MAX_TASKS,
  AggregationScopeTransaction,
  collectAggregationScope,
} from './task-aggregation-writer';
import { transactionDouble } from '../test-support/prisma-transaction-double';

test('aggregation scope bounds the database page before retaining any partial closure', async () => {
  let calls = 0;
  let query: any;
  const rows = Array.from({ length: AGGREGATION_SCOPE_MAX_TASKS + 1 }, (_, index) => ({
    id: `task-${String(index).padStart(4, '0')}`,
    status: 'OPEN',
    parentTaskId: null,
    completionPolicy: 'MANUAL',
    completionCriterion: 'HUMAN_SIGNOFF',
    verifiesTaskId: null,
    verdict: null,
    supersededByTaskId: null,
    terminalReason: null,
  }));
  const db = transactionDouble<AggregationScopeTransaction>({
    task: {
      findMany: async (input) => {
        calls += 1;
        query = input;
        return rows;
      },
    },
  });

  const scope = await collectAggregationScope(db, 'owner-1', ['task-0000']);

  assert.deepEqual(scope, { facts: [], truncated: true });
  assert.equal(calls, 1);
  assert.equal(query.take, AGGREGATION_SCOPE_MAX_TASKS + 1);
  assert.deepEqual(query.orderBy, { id: 'asc' });
});

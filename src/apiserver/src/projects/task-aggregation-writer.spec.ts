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
    completionCriterion: 'EVIDENCE_JUDGMENT',
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

test('aggregation scope reads each task\'s creation time, which orders its checks', async () => {
  // `newestLiveCheck` orders a subject's checks by creation time ahead of id; a fact without it
  // falls back to id order, which N11's UUIDv4 verifier ids make meaningless.
  const createdAt = new Date('2026-08-30T16:40:12.084Z');
  let query: any;
  const db = transactionDouble<AggregationScopeTransaction>({
    task: {
      findMany: async (input) => {
        query = input;
        return [{
          id: 'task-0000',
          createdAt,
          status: 'OPEN',
          parentTaskId: null,
          completionPolicy: 'VERIFICATION_PASSED',
          completionCriterion: 'VERIFICATION',
          verifiesTaskId: null,
          verdict: null,
          supersededByTaskId: null,
          terminalReason: null,
        }];
      },
    },
  });

  const scope = await collectAggregationScope(db, 'owner-1', ['task-0000']);

  assert.equal(query.select.createdAt, true);
  assert.equal(scope.facts[0]?.createdAt, createdAt);
});

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RunnerTasksController } from '../runner-api/runner-tasks.controller';
import { TaskJudgmentReviewController } from './task-judgment-review.controller';
import { TaskJudgmentReviewService } from './task-judgment-review.service';

const OWNER = '019fcda0-d021-72a2-a914-2f4de38f4601';
const REQUEST = '019fcda0-d021-72a2-a914-2f4de38f4602';
const OTHER_REQUEST = '019fcda0-d021-72a2-a914-2f4de38f4603';
const PROJECT = '019fcda0-d021-72a2-a914-2f4de38f4604';
const TASK = '019fcda0-d021-72a2-a914-2f4de38f4605';
const DIGEST = 'd'.repeat(64);

test('human review REST surface is one JWT inbox/read/decision resource', () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, TaskJudgmentReviewController), 'judgments');
  const proto = TaskJudgmentReviewController.prototype;
  assert.equal(Reflect.getMetadata(PATH_METADATA, proto.list), '/');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, proto.list), RequestMethod.GET);
  assert.equal(Reflect.getMetadata(PATH_METADATA, proto.get), ':id');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, proto.get), RequestMethod.GET);
  assert.equal(Reflect.getMetadata(PATH_METADATA, proto.decide), ':id/decision');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, proto.decide), RequestMethod.POST);
});

test('controller derives the recipient from auth and forwards exact route/payload identity', async () => {
  const calls: unknown[][] = [];
  const reviews = {
    list: async (...args: unknown[]) => { calls.push(args); return { total: 1, items: [] }; },
    get: async (...args: unknown[]) => { calls.push(args); return { request: { id: REQUEST } }; },
    decide: async (...args: unknown[]) => { calls.push(args); return { reviewState: 'APPROVED' }; },
  };
  const controller = new TaskJudgmentReviewController(reviews as never);
  const user = { userId: OWNER, email: 'n13@invalid.test' };
  const decision = {
    requestId: REQUEST,
    evidenceDigest: DIGEST,
    action: 'PASS' as const,
    note: 'Reviewed the exact revision and its test output.',
  };

  assert.deepEqual(await controller.list(user, 'OPEN', PROJECT, TASK, '25'), {
    total: 1, items: [],
  });
  assert.deepEqual(calls[0], [OWNER, {
    status: 'OPEN', projectId: PROJECT, taskId: TASK, limit: '25',
  }]);
  assert.deepEqual(await controller.get(user, REQUEST), { request: { id: REQUEST } });
  assert.deepEqual(calls[1], [OWNER, REQUEST]);
  assert.deepEqual(await controller.decide(user, REQUEST, decision), { reviewState: 'APPROVED' });
  assert.deepEqual(calls[2], [OWNER, REQUEST, decision]);
});

test('the route and payload cannot name different judgment requests', async () => {
  const service = new TaskJudgmentReviewService({} as never, {} as never);
  await assert.rejects(
    service.decide(OWNER, REQUEST, {
      requestId: OTHER_REQUEST,
      evidenceDigest: DIGEST,
      action: 'PASS',
      note: 'This body belongs to another review.',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal((error.getResponse() as Record<string, unknown>).code,
        'EVIDENCE_JUDGMENT_REQUEST_ROUTE_MISMATCH');
      return true;
    },
  );
});

// Before migration 0224 this asserted the opposite: the runner door had no way to decide, because
// deciding was a person's job. It now has exactly one, and still has no second one — a judgment is
// decided on the task it belongs to, never through a generic "decision" endpoint.
test('runner/coordinator REST has exactly one judgment-decision route', () => {
  const proto = RunnerTasksController.prototype as unknown as Record<string, unknown>;
  const paths = Object.getOwnPropertyNames(proto)
    .map((name) => Reflect.getMetadata(PATH_METADATA, proto[name] as object))
    .filter((path): path is string => typeof path === 'string');
  assert.deepEqual(
    paths.filter((path) => path.includes('judgment') || path.includes('decision')),
    ['tasks/:id/judgment'],
  );
});

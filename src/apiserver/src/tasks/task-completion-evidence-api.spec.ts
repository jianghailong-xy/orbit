import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { CreatorType } from '@prisma/client';
import { RunnerTaskCompletionEvidenceController } from '../runner-api/runner-task-completion-evidence.controller';
import { TaskCompletionEvidenceController } from './task-completion-evidence.controller';
import { PendingEvidenceJudgmentsController } from './pending-evidence-judgments.controller';

const OWNER = '00000000-0000-7000-8000-000000000010';
const WORKSPACE = '00000000-0000-7000-8000-000000000011';
const TASK = '00000000-0000-7000-8000-000000000012';
const SESSION = '00000000-0000-7000-8000-000000000013';

test('user REST submit derives actor from auth and forwards the required source and structure', async () => {
  const calls: unknown[][] = [];
  const evidence = {
    submit: async (...args: unknown[]) => { calls.push(args); return { id: 'evidence-1' }; },
    list: async (...args: unknown[]) => { calls.push(args); return [{ id: 'evidence-1' }]; },
  };
  const controller = new TaskCompletionEvidenceController(evidence as never);

  assert.deepEqual(await controller.submit(
    { userId: OWNER, email: 'n10@invalid.test' },
    TASK,
    { sourceSessionId: SESSION, evidence: { exitCode: 0 }, idempotencyKey: 'turn-1' },
  ), { id: 'evidence-1' });
  assert.deepEqual(calls[0], [
    OWNER,
    TASK,
    { type: CreatorType.USER, id: OWNER },
    { sourceSessionId: SESSION, evidence: { exitCode: 0 }, idempotencyKey: 'turn-1' },
  ]);
  assert.deepEqual(await controller.list({ userId: OWNER, email: 'n10@invalid.test' }, TASK), [
    { id: 'evidence-1' },
  ]);
  assert.deepEqual(calls[1], [OWNER, TASK]);
});

test('legacy comment import is a distinct authenticated user call, never a comment side effect', async () => {
  const calls: unknown[][] = [];
  const evidence = {
    importLegacyComment: async (...args: unknown[]) => {
      calls.push(args);
      return { id: 'legacy-evidence-1' };
    },
  };
  const controller = new TaskCompletionEvidenceController(evidence as never);
  const dto = {
    sourceCommentId: '00000000-0000-7000-8000-000000000014',
    sourceSessionId: SESSION,
    evidence: { commands: [{ command: 'npm test', exitCode: 0 }] },
    idempotencyKey: 'review-comment-14',
    reviewNote: 'I read the source and selected only the recorded command result.',
    devicePush: false,
  };

  assert.deepEqual(await controller.importLegacyComment(
    { userId: OWNER, email: 'n8@invalid.test' },
    TASK,
    dto,
  ), { id: 'legacy-evidence-1' });
  assert.deepEqual(calls, [[
    OWNER,
    TASK,
    { type: CreatorType.USER, id: OWNER },
    dto,
  ]]);
});

test('runner REST submit derives actor and source from authenticated headers, not evidence prose', async () => {
  const calls: unknown[][] = [];
  const evidence = {
    submit: async (...args: unknown[]) => { calls.push(args); return { id: 'evidence-1' }; },
    list: async () => [],
  };
  const tasks = {
    resolveAgentCreator: async () => ({ type: CreatorType.AGENT, id: WORKSPACE }),
  };
  const controller = new RunnerTaskCompletionEvidenceController(evidence as never, tasks as never);
  const runner = { ownerId: OWNER } as never;

  await controller.submit(
    runner,
    TASK,
    SESSION,
    WORKSPACE,
    undefined,
    { evidence: { commands: [] }, idempotencyKey: 'turn-1' },
  );
  assert.deepEqual(calls[0], [
    OWNER,
    TASK,
    { type: CreatorType.AGENT, id: WORKSPACE },
    { evidence: { commands: [] }, idempotencyKey: 'turn-1', sourceSessionId: SESSION },
  ]);
  await assert.rejects(
    controller.submit(runner, TASK, undefined, WORKSPACE, undefined, { evidence: {} }),
    BadRequestException,
  );
});

/**
 * The app's decision door and the runner's are the SAME door, and this is what that means in code.
 *
 * Both controllers call one service method with one shape. The only difference is where the
 * deciding session comes from — a header the runner is authenticated as, a named field the browser
 * has to supply — and neither controller decides anything about it: the service asks the same
 * question of both, so an owner pressing the button in the app gets no shorter path than a
 * coordinator does.
 */
test('the app decides through the same service call, naming the session instead of carrying it', async () => {
  const calls: unknown[][] = [];
  const evidence = {
    decide: async (...args: unknown[]) => { calls.push(args); return { id: 'decision-1' }; },
  };
  const user = new TaskCompletionEvidenceController(evidence as never);
  const runner = new RunnerTaskCompletionEvidenceController(evidence as never, {
    resolveAgentCreator: async () => ({ type: CreatorType.AGENT, id: WORKSPACE }),
  } as never);

  await user.decide({ userId: OWNER, email: 'n10@invalid.test' }, TASK, {
    decidingSessionId: SESSION,
    evidenceRevision: '2',
    decision: 'CONFIRM',
  } as never);
  await runner.decide({ ownerId: OWNER } as never, TASK, SESSION, WORKSPACE, undefined, {
    evidenceRevision: '2',
    decision: 'CONFIRM',
  } as never);

  // Same method, same task, same version, same named session. Only the actor differs, and that is
  // who is signed in rather than what they are allowed to skip.
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), [OWNER, TASK]);
  assert.deepEqual(calls[1].slice(0, 2), [OWNER, TASK]);
  assert.deepEqual(calls[0][3], { decidingSessionId: SESSION, evidenceRevision: '2', decision: 'CONFIRM' });
  assert.deepEqual(calls[1][3], { decidingSessionId: SESSION, evidenceRevision: '2', decision: 'CONFIRM' });
});

test('the pending queue refuses to answer without the session it would be read for', async () => {
  const calls: unknown[][] = [];
  const evidence = {
    pending: async (...args: unknown[]) => { calls.push(args); return { count: 0, pending: [] }; },
  };
  const controller = new PendingEvidenceJudgmentsController(evidence as never);

  assert.deepEqual(
    await controller.pending({ userId: OWNER, email: 'n10@invalid.test' }, SESSION),
    { count: 0, pending: [] },
  );
  assert.deepEqual(calls, [[OWNER, SESSION]]);
  // Not optional, and not defaulted to "whoever is signed in": every row says whether THIS session
  // may answer it, so a queue read for nobody could only report questions it could not place.
  assert.throws(
    () => controller.pending({ userId: OWNER, email: 'n10@invalid.test' }, undefined),
    BadRequestException,
  );
});

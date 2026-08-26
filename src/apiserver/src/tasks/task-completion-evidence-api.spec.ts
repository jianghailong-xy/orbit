import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { CreatorType } from '@prisma/client';
import { RunnerTaskCompletionEvidenceController } from '../runner-api/runner-task-completion-evidence.controller';
import { TaskCompletionEvidenceController } from './task-completion-evidence.controller';

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

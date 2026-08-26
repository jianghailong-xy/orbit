// CreateTasksBatchDto's @Type decorator reads design-time metadata at import.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationPipe } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { uuidToBase62 } from '@orbit/shared';
import {
  AddDependencyDto,
  BatchDeleteDto,
  CreateTaskDto,
  CreateTasksBatchDto,
  ExpandDependencyGraphDto,
  RefreshDependencyGraphNodesDto,
  SubmitRunnerTaskCompletionEvidenceDto,
  SubmitTaskCompletionEvidenceDto,
  TASK_BATCH_CREATE_MAX,
  UpdateTaskDto,
} from './dto';

const TASK_A = '550e8400-e29b-41d4-a716-446655440000';
const TASK_B = '550e8400-e29b-41d4-a716-446655440001';

test('completion evidence DTOs require a structured object and REST requires its source Session', async () => {
  const validRest = Object.assign(new SubmitTaskCompletionEvidenceDto(), {
    sourceSessionId: TASK_A,
    evidence: { commands: [{ exitCode: 0 }] },
    idempotencyKey: 'turn-17-completion',
  });
  const missingSource = Object.assign(new SubmitTaskCompletionEvidenceDto(), { evidence: {} });
  const scalarEvidence = Object.assign(new SubmitTaskCompletionEvidenceDto(), {
    sourceSessionId: TASK_A,
    evidence: 'finished',
  });
  const missingRunnerEvidence = new SubmitRunnerTaskCompletionEvidenceDto();
  const oversizedKey = Object.assign(new SubmitRunnerTaskCompletionEvidenceDto(), {
    evidence: {},
    idempotencyKey: 'x'.repeat(201),
  });

  assert.equal((await validate(validRest)).length, 0);
  assert.notEqual((await validate(missingSource)).length, 0);
  assert.notEqual((await validate(scalarEvidence)).length, 0);
  assert.notEqual((await validate(missingRunnerEvidence)).length, 0);
  assert.notEqual((await validate(oversizedKey)).length, 0);
});

async function dependencyErrors(value: unknown, present = true) {
  const dto = new UpdateTaskDto();
  if (present) Object.assign(dto, { dependsOnTaskIds: value });
  return validate(dto);
}

test('task dependency replacement accepts omitted, empty, and populated arrays', async () => {
  assert.equal((await dependencyErrors(undefined, false)).length, 0);
  assert.equal((await dependencyErrors([])).length, 0);
  assert.equal((await dependencyErrors([TASK_A, TASK_B])).length, 0);
});

test('task dependency replacement rejects null and non-array values', async () => {
  assert.notEqual((await dependencyErrors(null)).length, 0);
  assert.notEqual((await dependencyErrors('task-a')).length, 0);
  assert.notEqual((await dependencyErrors(['task-a', 1])).length, 0);
});

test('task creation and single-edge DTOs reject non-UUID dependency ids', async () => {
  const create = Object.assign(new CreateTaskDto(), {
    title: 'Task',
    dependsOnTaskIds: ['not-a-uuid'],
  });
  const add = Object.assign(new AddDependencyDto(), { dependsOnTaskId: 'not-a-uuid' });

  assert.notEqual((await validate(create)).length, 0);
  assert.notEqual((await validate(add)).length, 0);
});

test('batch delete accepts UUID arrays and rejects malformed task ids', async () => {
  const valid = Object.assign(new BatchDeleteDto(), { taskIds: [TASK_A, TASK_A, TASK_B] });
  const empty = Object.assign(new BatchDeleteDto(), { taskIds: [] });
  const invalid = Object.assign(new BatchDeleteDto(), { taskIds: [TASK_A, 'not-a-uuid'] });

  assert.equal((await validate(valid)).length, 0);
  assert.equal((await validate(empty)).length, 0);
  assert.notEqual((await validate(invalid)).length, 0);
});

test('dependency expansion DTO accepts 501-node snapshots and rejects unsafe bounds', async () => {
  const ids = Array.from(
    { length: 501 },
    (_, index) => `00000000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
  );
  const valid = Object.assign(new ExpandDependencyGraphDto(), {
    anchorTaskId: ids[0],
    direction: 'prerequisites',
    knownTaskIds: ids,
    loadedNeighborTaskIds: [],
    limit: 100,
    cursor: 'opaque',
  });
  const tooMany = Object.assign(new ExpandDependencyGraphDto(), {
    ...valid,
    knownTaskIds: [TASK_A, ...Array.from({ length: 1_000 }, (_, index) =>
      `00000000-0000-7000-8001-${index.toString(16).padStart(12, '0')}`)],
  });
  const invalidDirection = Object.assign(new ExpandDependencyGraphDto(), {
    ...valid,
    direction: 'both',
  });
  const invalidLimit = Object.assign(new ExpandDependencyGraphDto(), { ...valid, limit: 101 });

  assert.equal((await validate(valid)).length, 0);
  assert.notEqual((await validate(tooMany)).length, 0);
  assert.notEqual((await validate(invalidDirection)).length, 0);
  assert.notEqual((await validate(invalidLimit)).length, 0);
});

test('dependency node refresh DTO accepts duplicate UUIDs and caps request payloads', async () => {
  const valid = Object.assign(new RefreshDependencyGraphNodesDto(), {
    taskIds: [TASK_A, TASK_A, TASK_B],
  });
  const malformed = Object.assign(new RefreshDependencyGraphNodesDto(), {
    taskIds: [TASK_A, 'not-a-uuid'],
  });
  const tooMany = Object.assign(new RefreshDependencyGraphNodesDto(), {
    taskIds: Array.from(
      { length: 1_001 },
      (_, index) => `00000000-0000-7000-8004-${index.toString(16).padStart(12, '0')}`,
    ),
  });

  assert.equal((await validate(valid)).length, 0);
  assert.notEqual((await validate(malformed)).length, 0);
  assert.notEqual((await validate(tooMany)).length, 0);
});

test('task update takes a parent as a base62 public id, and null to detach', async () => {
  // The id an agent actually holds is the short form (task_get, the web URL), and the column is
  // a uuid — so the decode has to happen at the DTO or the parent link is unaddressable from
  // everywhere except a raw uuid.
  const linked = plainToInstance(UpdateTaskDto, { parentTaskId: uuidToBase62(TASK_A) });
  assert.equal((await validate(linked)).length, 0);
  assert.equal(linked.parentTaskId, TASK_A);

  // Three-state, like every other nullable FK on this DTO: omitted keeps the current parent,
  // an id (re)links, null detaches. @IsOptional() is what lets the null through to mean it.
  const detached = plainToInstance(UpdateTaskDto, { parentTaskId: null });
  assert.equal((await validate(detached)).length, 0);
  assert.equal(detached.parentTaskId, null);
  assert.equal((await validate(plainToInstance(UpdateTaskDto, {}))).length, 0);

  assert.notEqual(
    (await validate(plainToInstance(UpdateTaskDto, { parentTaskId: 'not an id' }))).length,
    0,
  );
});

test('batch-create DTO validates each item and caps the batch size', async () => {
  const batch = (tasks: unknown[]) => plainToInstance(CreateTasksBatchDto, { tasks });

  assert.equal(
    (await validate(batch([{ title: 'a', ref: 's0' }, { title: 'b', dependsOnRefs: ['s0'] }])))
      .length,
    0,
  );
  // An item that fails CreateTaskDto's own rules fails the batch (nested validation is on).
  assert.notEqual((await validate(batch([{ title: '' }]))).length, 0);
  assert.notEqual((await validate(batch([{ title: 'a', assigneeId: 'not-a-uuid' }]))).length, 0);
  assert.notEqual((await validate(batch([]))).length, 0);
  assert.notEqual(
    (await validate(batch(Array.from({ length: TASK_BATCH_CREATE_MAX + 1 }, () => ({ title: 'a' })))))
      .length,
    0,
  );
});

test('the app ValidationPipe keeps every batch field it is meant to forward', async () => {
  // Exactly how main.ts configures it: whitelist strips undecorated keys, so a field the
  // item DTO forgets to declare would be dropped between HTTP and TasksService.
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });
  const payload = {
    tasks: [
      {
        title: 'S0',
        ref: 's0',
        description: 'first',
        autoRunWhenReady: false,
        acceptanceCommand: 'test -f result.json',
        acceptanceExpectedExitCode: 0,
        unknown: 'drop me',
      },
      {
        title: 'S1',
        dependsOnRefs: ['s0'],
        parentRef: 's0',
        dependsOnTaskIds: [TASK_A],
        assigneeId: null,
      },
    ],
  };

  const value = (await pipe.transform(payload, {
    type: 'body',
    metatype: CreateTasksBatchDto,
  })) as CreateTasksBatchDto;

  const kept = (index: number) =>
    Object.fromEntries(
      Object.entries(value.tasks[index]).filter(([, field]) => field !== undefined),
    );
  assert.deepEqual(kept(0), {
    title: 'S0',
    ref: 's0',
    description: 'first',
    autoRunWhenReady: false,
    acceptanceCommand: 'test -f result.json',
    acceptanceExpectedExitCode: 0,
  });
  assert.deepEqual(kept(1), {
    title: 'S1',
    dependsOnRefs: ['s0'],
    parentRef: 's0',
    dependsOnTaskIds: [TASK_A],
    assigneeId: null,
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate } from 'class-validator';
import {
  AddDependencyDto,
  BatchDeleteDto,
  CreateTaskDto,
  ExpandDependencyGraphDto,
  RefreshDependencyGraphNodesDto,
  UpdateTaskDto,
} from './dto';

const TASK_A = '550e8400-e29b-41d4-a716-446655440000';
const TASK_B = '550e8400-e29b-41d4-a716-446655440001';

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

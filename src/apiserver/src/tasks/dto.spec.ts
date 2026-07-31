import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate } from 'class-validator';
import { AddDependencyDto, CreateTaskDto, UpdateTaskDto } from './dto';

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

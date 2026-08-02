import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate } from 'class-validator';
import { ReorderRunnersDto, StartLoginDto } from './dto';

test('StartLoginDto accepts every built-in login engine, including Kimi', async () => {
  for (const engine of ['claude', 'codex', 'kimi'] as const) {
    const dto = new StartLoginDto();
    dto.engine = engine;
    assert.equal((await validate(dto)).length, 0, engine);
  }
});

test('StartLoginDto rejects a configured-provider slug as a login engine', async () => {
  const dto = new StartLoginDto();
  dto.engine = 'moonshot' as never;
  assert.notEqual((await validate(dto)).length, 0);
});

test('ReorderRunnersDto accepts a unique string id list', async () => {
  const dto = new ReorderRunnersDto();
  dto.ids = ['runner-2', 'runner-1'];
  assert.equal((await validate(dto)).length, 0);
});

test('ReorderRunnersDto rejects duplicate ids', async () => {
  const dto = new ReorderRunnersDto();
  dto.ids = ['runner-1', 'runner-1'];
  assert.notEqual((await validate(dto)).length, 0);
});

test('ReorderRunnersDto rejects non-array and non-string ids', async () => {
  const notArray = new ReorderRunnersDto();
  notArray.ids = 'runner-1' as unknown as string[];
  assert.notEqual((await validate(notArray)).length, 0);

  const nonString = new ReorderRunnersDto();
  nonString.ids = ['runner-1', 2] as unknown as string[];
  assert.notEqual((await validate(nonString)).length, 0);
});

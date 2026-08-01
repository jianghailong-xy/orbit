import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate } from 'class-validator';
import { StartLoginDto } from './dto';

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

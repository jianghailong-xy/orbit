import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { uuidToBase62 } from '@orbit/shared';
import { ReorderRunnersDto, StartInstallDto, StartLoginDto } from './dto';

test('Antigravity can be installed and signed into', async () => {
  const install = Object.assign(new StartInstallDto(), { engine: 'antigravity' });
  assert.equal((await validate(install)).length, 0);
  // Whether a given runner can relay its Google sign-in is the service's question (startLogin).
  const login = Object.assign(new StartLoginDto(), { engine: 'antigravity' });
  assert.equal((await validate(login)).length, 0);
});

test('StartInstallDto accepts OpenCode and every other installable engine', async () => {
  // OpenCode is never signed in through Orbit (StartLoginDto refuses it below), so this relay is
  // the only way its CLI gets onto a machine — a wrong list here refuses the install outright.
  const openCode = new StartInstallDto();
  openCode.engine = 'opencode';
  assert.equal((await validate(openCode)).length, 0);
  for (const engine of ['claude', 'codex', 'kimi', 'antigravity', 'dsh'] as const) {
    const dto = new StartInstallDto();
    dto.engine = engine;
    assert.equal((await validate(dto)).length, 0, engine);
  }
});

test('StartInstallDto rejects an engine slug it does not know', async () => {
  const dto = new StartInstallDto();
  dto.engine = 'aider' as never;
  assert.notEqual((await validate(dto)).length, 0);
});

test('StartLoginDto accepts every built-in login engine, including Kimi and Antigravity', async () => {
  for (const engine of ['claude', 'codex', 'kimi', 'antigravity'] as const) {
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

test('StartLoginDto still rejects OpenCode, which is installed and never signed in', async () => {
  const dto = new StartLoginDto();
  dto.engine = 'opencode' as never;
  assert.notEqual((await validate(dto)).length, 0);
});

// Two runners: the UUIDs their rows key by. GET /runners hands every client the base62 spelling.
const FIRST = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const SECOND = '019fe1dd-3f39-7610-8e5d-507e36a4ea9c';
// As the global ValidationPipe builds the body: plainToInstance first, which is where ids decode.
const reorder = (ids: unknown) => plainToInstance(ReorderRunnersDto, { ids });

test('ReorderRunnersDto decodes the public ids GET /runners hands out', async () => {
  // Taken as plain strings, the base62 ids every client sends back matched no runner, and the
  // service kept the stored order whatever was dragged.
  const dto = reorder([uuidToBase62(SECOND), FIRST]);
  assert.deepEqual(await validate(dto), []);
  assert.deepEqual(dto.ids, [SECOND, FIRST]);
});

test('ReorderRunnersDto rejects duplicate ids, in either spelling', async () => {
  for (const ids of [[FIRST, FIRST], [uuidToBase62(FIRST), FIRST]]) {
    assert.notEqual((await validate(reorder(ids))).length, 0, ids.join());
  }
});

test('ReorderRunnersDto rejects a non-array, a non-string and an id in neither spelling', async () => {
  for (const ids of ['runner-1', [FIRST, 2], ['runner-1']]) {
    assert.notEqual((await validate(reorder(ids))).length, 0, JSON.stringify(ids));
  }
});

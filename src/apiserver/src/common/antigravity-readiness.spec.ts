import assert from 'node:assert/strict';
import { test } from 'node:test';
import { antigravityState, hasGeminiEnvKey } from './antigravity-readiness';
import { uuidToBase62 } from '@orbit/shared';
import { addTwins } from './public-id-body';

test('Antigravity readiness is declared support plus independently reported CLI state', () => {
  assert.deepEqual(antigravityState({ engines: null }), {
    supported: false, installed: null, version: null, envKeyAvailable: false,
  });
  assert.deepEqual(antigravityState({
    capabilities: ['provider:antigravity'],
    engines: [{ engine: 'antigravity', installed: false, auth: 'no' }],
  }), { supported: true, installed: false, version: null, envKeyAvailable: false });
  assert.deepEqual(antigravityState({
    capabilities: ['provider:antigravity'],
    engines: [{ engine: 'antigravity', installed: true, version: '  1.2.3  ', auth: 'yes' }],
  }), { supported: true, installed: true, version: '1.2.3', envKeyAvailable: true });
  assert.equal(antigravityState({
    capabilities: ['antigravity', 'provider:antigravity-preview'],
    engines: [{ engine: 'antigravity', installed: true, auth: 'unknown' }],
  }).supported, false, 'installation and an approximate capability are not a declaration');
});

test('only a nonempty string Gemini workspace key is available', () => {
  for (const env of [null, {}, [], { GEMINI_API_KEY: '' }, { GEMINI_API_KEY: ' \n ' }, { GEMINI_API_KEY: 123 }]) {
    assert.equal(hasGeminiEnvKey(env), false);
  }
  assert.equal(hasGeminiEnvKey({ GEMINI_API_KEY: '  test-key  ' }), true);
});

test('workspace key map addresses match the runner ids at the public response boundary', () => {
  const runnerId = '22222222-2222-4222-8222-222222222222';
  const body = { runner: { id: runnerId }, antigravityKeyAvailableByRunner: { [runnerId]: true } };
  addTwins(body, true);
  assert.equal(body.runner.id, uuidToBase62(runnerId));
  assert.deepEqual(body.antigravityKeyAvailableByRunner, { [body.runner.id]: true });
  addTwins(body, true);
  assert.deepEqual(body.antigravityKeyAvailableByRunner, { [body.runner.id]: true }, 'public mapping is idempotent');
  const machine = { runner: { id: runnerId }, antigravityKeyAvailableByRunner: { [runnerId]: false } };
  addTwins(machine, false);
  assert.equal(machine.runner.id, runnerId);
  assert.deepEqual(machine.antigravityKeyAvailableByRunner, { [runnerId]: false });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANTIGRAVITY_GOOGLE_LOGIN_LINUX_ONLY,
  ANTIGRAVITY_GOOGLE_LOGIN_V1,
  antigravityGoogleLogin,
  antigravityGoogleLoginRefusal,
  antigravitySignInUnderWay,
  antigravityState,
  hasGeminiEnvKey,
} from './antigravity-readiness';
import { uuidToBase62 } from '@orbit/shared';
import { addTwins } from './public-id-body';

test('Antigravity readiness is declared support plus independently reported CLI state', () => {
  assert.deepEqual(antigravityState({ engines: null }), {
    supported: false, installed: null, version: null, envKeyAvailable: false, authSource: null, googleLogin: 'needs_update',
  });
  assert.deepEqual(antigravityState({
    capabilities: ['provider:antigravity'],
    engines: [{ engine: 'antigravity', installed: false, auth: 'no' }],
  }), { supported: true, installed: false, version: null, envKeyAvailable: false, authSource: null, googleLogin: 'needs_update' });
  // A runner from before Google sign-in names no source: its yes can only be the env key.
  assert.deepEqual(antigravityState({
    capabilities: ['provider:antigravity'],
    engines: [{ engine: 'antigravity', installed: true, version: '  1.2.3  ', auth: 'yes' }],
  }), { supported: true, installed: true, version: '1.2.3', envKeyAvailable: true, authSource: 'env_key', googleLogin: 'needs_update' });
  assert.equal(antigravityState({
    capabilities: ['antigravity', 'provider:antigravity-preview'],
    engines: [{ engine: 'antigravity', installed: true, auth: 'unknown' }],
  }).supported, false, 'installation and an approximate capability are not a declaration');
});

test('the readiness says which credential the built-in engine runs on, for the picker to label', () => {
  const capable = ['provider:antigravity', ANTIGRAVITY_GOOGLE_LOGIN_V1];
  const state = (health: Record<string, unknown>) =>
    antigravityState({ capabilities: capable, engines: [{ engine: 'antigravity', installed: true, ...health }] });
  assert.deepEqual(state({ auth: 'yes', authSource: 'google' }), {
    supported: true, installed: true, version: null, envKeyAvailable: true, authSource: 'google', googleLogin: 'available',
  });
  assert.deepEqual(
    [state({ auth: 'yes', authSource: 'env_key' }).authSource, state({ auth: 'yes', authSource: 'env_key' }).envKeyAvailable],
    ['env_key', true],
  );
  // A Google sign-in that has lapsed: still the credential, no longer one the engine can run on.
  assert.deepEqual(
    [state({ auth: 'no', authSource: 'google' }).authSource, state({ auth: 'no', authSource: 'google' }).envKeyAvailable],
    ['google', false],
  );
  // One the probe could not read stays offered: only a definite no takes it away.
  assert.equal(state({ auth: 'unknown', authSource: 'google' }).envKeyAvailable, true);
  assert.equal(state({ auth: 'unknown' }).envKeyAvailable, false);
  // Neither credential.
  assert.deepEqual(
    [state({ auth: 'no' }).authSource, state({ auth: 'no' }).envKeyAvailable],
    [null, false],
  );
});

test('only a Linux runner that declares the Google sign-in is asked for one', () => {
  assert.equal(antigravityGoogleLogin({ capabilities: [ANTIGRAVITY_GOOGLE_LOGIN_V1, 'os:linux'] }), 'available');
  assert.equal(antigravityGoogleLoginRefusal({ capabilities: [ANTIGRAVITY_GOOGLE_LOGIN_V1, 'os:linux'] }), null);
  // The capability first: an old runner needs updating whatever its platform.
  for (const capabilities of [undefined, [], ['provider:antigravity', 'os:linux'], ['antigravity-google-login/v2', 'antigravity-google-login', 'os:darwin']]) {
    assert.equal(antigravityGoogleLogin({ capabilities }), 'needs_update');
    assert.match(antigravityGoogleLoginRefusal({ capabilities }) ?? '', /too old to sign Antigravity in with Google — update it/);
  }
  // Then the platform it named: Linux only for now.
  for (const os of ['os:darwin', 'os:windows', 'os:freebsd']) {
    assert.equal(antigravityGoogleLogin({ capabilities: [ANTIGRAVITY_GOOGLE_LOGIN_V1, os] }), 'unsupported_platform', os);
    assert.equal(antigravityGoogleLoginRefusal({ capabilities: [ANTIGRAVITY_GOOGLE_LOGIN_V1, os] }), ANTIGRAVITY_GOOGLE_LOGIN_LINUX_ONLY);
  }
  // One that named none is let through: it refuses a platform it cannot do itself.
  assert.equal(antigravityGoogleLogin({ capabilities: [ANTIGRAVITY_GOOGLE_LOGIN_V1] }), 'available');
  // The readiness says the same.
  assert.equal(
    antigravityState({ capabilities: [ANTIGRAVITY_GOOGLE_LOGIN_V1, 'os:darwin'], engines: null }).googleLogin,
    'unsupported_platform',
  );
});

test('an Antigravity sign-in is under way from its start until its cancel is handed over', () => {
  for (const loginStatus of ['pending', 'awaiting_code', 'cancelling']) {
    assert.equal(antigravitySignInUnderWay({ loginEngine: 'antigravity', loginStatus }), true, loginStatus);
  }
  for (const loginStatus of [null, 'done', 'failed']) {
    assert.equal(antigravitySignInUnderWay({ loginEngine: 'antigravity', loginStatus }), false, String(loginStatus));
  }
  assert.equal(antigravitySignInUnderWay({ loginEngine: 'claude', loginStatus: 'awaiting_code' }), false);
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

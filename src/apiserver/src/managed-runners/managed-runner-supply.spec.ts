import assert from 'node:assert/strict';
import { test } from 'node:test';

import { managedRuntimeReady, managedRuntimeSupply } from './managed-runner-supply';

// Model supply on a managed runner: what its heartbeat reported installed and signed in, and the
// order a first session takes it in. A runtime that is not reported ready is never supply.

const engine = (name: string, change: Record<string, unknown> = {}) => ({ engine: name, installed: true, auth: 'yes', ...change });

test('installed and signed in is supply; signed out, unknown, uninstalled or broken is not', () => {
  const runner = {
    engines: [
      engine('claude', { auth: 'no' }),
      engine('codex'),
      engine('kimi', { auth: 'unknown' }),
      engine('antigravity', { installed: false }),
    ],
  };
  assert.deepEqual(managedRuntimeSupply(runner), ['codex']);
  assert.equal(managedRuntimeReady(runner, 'codex'), true);
  for (const runtime of ['claude', 'kimi', 'antigravity']) assert.equal(managedRuntimeReady(runner, runtime), false, runtime);
});

test("Orbit's own default is preferred when it is ready, and never assumed when it is not", () => {
  const all = { engines: [engine('kimi'), engine('codex'), engine('claude')] };
  assert.deepEqual(managedRuntimeSupply(all), ['claude', 'codex', 'kimi']);
  const noClaude = { engines: [engine('kimi'), engine('codex')] };
  assert.deepEqual(managedRuntimeSupply(noClaude), ['codex', 'kimi']);
});

test('nothing reported, or a report that cannot be read, is no supply', () => {
  assert.deepEqual(managedRuntimeSupply({ engines: null }), []);
  assert.deepEqual(managedRuntimeSupply({ engines: 'claude' }), []);
  assert.deepEqual(managedRuntimeSupply({ engines: [{ engine: 'claude', installed: 'yes', auth: 'yes' }] }), []);
  assert.deepEqual(managedRuntimeSupply({ engines: [] }), []);
});

test('Antigravity counts only on a runner that advertises it to the claim', () => {
  const engines = [engine('antigravity')];
  assert.deepEqual(managedRuntimeSupply({ engines, capabilities: [] }), []);
  assert.deepEqual(managedRuntimeSupply({ engines, capabilities: ['provider:antigravity'] }), ['antigravity']);
});

test('OpenCode and DeepSeek Harness are not supply in this version, whatever is reported', () => {
  const runner = {
    engines: [engine('opencode'), engine('dsh', { dsh: { versionCompatible: true, credentialPresent: true } })],
    capabilities: ['provider:opencode', 'provider:dsh'],
  };
  assert.deepEqual(managedRuntimeSupply(runner), []);
  assert.equal(managedRuntimeReady(runner, 'opencode', { bringsOwnCredentials: true }), false);
});

test("a session bringing its own credential needs the CLI installed, not the CLI's sign-in", () => {
  const runner = { engines: [engine('claude', { auth: 'no' }), engine('codex', { installed: false })] };
  assert.equal(managedRuntimeReady(runner, 'claude', { bringsOwnCredentials: true }), true);
  assert.equal(managedRuntimeReady(runner, 'codex', { bringsOwnCredentials: true }), false);
  assert.deepEqual(managedRuntimeSupply(runner), [], 'and it is still not supply of its own');
});

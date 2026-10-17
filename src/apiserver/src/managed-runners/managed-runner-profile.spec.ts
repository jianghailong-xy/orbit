import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';
import { loadManagedRunnerProfile, parseManagedRunnerProfile } from './managed-runner-profile';

// The environment profile is the only door to an enabled manager: one explicit file naming the
// kubeconfig, context, API server and namespace, and every budget. Anything placeholder-shaped,
// missing or loose leaves the feature unavailable.

const EXAMPLE = path.resolve(__dirname, '../../../../deploy/managed-runner/manager-profile.example.json');

const withChange = (change: (profile: Record<string, any>) => void) => {
  const profile = structuredClone(testManagedRunnerProfile()) as unknown as Record<string, any>;
  change(profile);
  return parseManagedRunnerProfile(profile);
};

test('a complete actual profile is accepted as it is', () => {
  const profile = testManagedRunnerProfile();
  assert.deepEqual(parseManagedRunnerProfile(structuredClone(profile)), { ok: true, profile });
});

test('every field a manager acts on is required and checked', () => {
  const cases: Array<[string, (p: Record<string, any>) => void, RegExp]> = [
    ['an example profile', (p) => (p.valueKind = 'example'), /valueKind must be "actual"/],
    ['another schema', (p) => (p.schemaVersion = 2), /schemaVersion must be 1/],
    ['no context', (p) => delete p.kubernetes.context, /kubernetes\.context must be a non-empty string/],
    ['no namespace', (p) => (p.kubernetes.namespace = ''), /kubernetes\.namespace must be a non-empty string/],
    ['a namespace that is no DNS label', (p) => (p.kubernetes.namespace = 'Orbit_Test'), /kubernetes\.namespace must be a DNS label/],
    ['a relative kubeconfig', (p) => (p.kubernetes.kubeconfig = 'kube/config.json'), /kubernetes\.kubeconfig must be an absolute path/],
    ['a plain-http API server', (p) => (p.kubernetes.apiServer = 'http://kube.invalid:6443'), /kubernetes\.apiServer must be an https URL/],
    ['an API server with credentials', (p) => (p.kubernetes.apiServer = 'https://u:p@kube.invalid'), /must not carry credentials/],
    ['a placeholder', (p) => (p.clusterKey = 'REPLACE_ME'), /clusterKey is still a placeholder/],
    ['a template token', (p) => (p.storage.className = '${storage.className}'), /storage\.className is still a placeholder/],
    ['an image by tag', (p) => (p.runner.image = 'registry.invalid/orbit-managed-runner:latest'), /runner\.image must be pinned by digest/],
    ['a remote plain-http Orbit server', (p) => (p.runner.serverUrl = 'http://orbit.invalid'), /runner\.serverUrl must be an https URL/],
    ['a capacity that is no quantity', (p) => (p.storage.capacity = 'twenty gigs'), /storage\.capacity is not a quantity/],
    ['no attempt budget', (p) => delete p.lifecycle.maxAttempts, /lifecycle\.maxAttempts must be an integer/],
    ['a fractional deadline', (p) => (p.lifecycle.startupDeadlineSeconds = 90.5), /lifecycle\.startupDeadlineSeconds must be an integer/],
    ['a backoff ceiling below its base', (p) => (p.lifecycle.backoffMaxSeconds = 1), /backoffMaxSeconds must not be below/],
    ['surrounding whitespace', (p) => (p.environmentId = ' orbit-mr-fake'), /environmentId must be a non-empty string without surrounding whitespace/],
  ];
  for (const [what, change, expected] of cases) {
    const result = withChange(change);
    assert.equal(result.ok, false, what);
    assert.ok(!result.ok && result.problems.some((p) => expected.test(p)), `${what}: ${JSON.stringify(!result.ok && result.problems)}`);
  }
});

test('http to a loopback Orbit server is allowed for a local fake control plane, as the image allows it', () => {
  assert.equal(withChange((p) => (p.runner.serverUrl = 'http://127.0.0.1:3000')).ok, true);
});

test('the shipped example is refused as it stands, and validates once an operator fills it in', () => {
  const example = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  const refused = parseManagedRunnerProfile(example);
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.problems.some((p) => /valueKind must be "actual"/.test(p)));
  assert.ok(!refused.ok && refused.problems.some((p) => /placeholder/.test(p)));

  // Same keys as the fixture, nothing missing and nothing extra: the example is the contract's shape.
  const keys = (value: unknown, prefix = ''): string[] =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
      : [prefix.slice(0, -1)];
  assert.deepEqual(keys(example).sort(), keys(testManagedRunnerProfile()).sort());
});

test('the loader reads only the explicit path, and refuses none, a relative one, or an unreadable one', () => {
  const read: string[] = [];
  const reader = (file: string) => {
    read.push(file);
    if (file === '/etc/orbit/profile.json') return JSON.stringify(testManagedRunnerProfile());
    throw new Error('ENOENT');
  };
  assert.deepEqual(loadManagedRunnerProfile(undefined, reader), { ok: false, problems: ['ORBIT_MANAGED_RUNNERS_PROFILE names no profile file'] });
  assert.deepEqual(loadManagedRunnerProfile('profile.json', reader), { ok: false, problems: ['ORBIT_MANAGED_RUNNERS_PROFILE must be an absolute path'] });
  assert.equal(loadManagedRunnerProfile('/etc/orbit/missing.json', reader).ok, false);
  assert.equal(loadManagedRunnerProfile('/etc/orbit/profile.json', reader).ok, true);
  assert.deepEqual(read, ['/etc/orbit/missing.json', '/etc/orbit/profile.json']);
});

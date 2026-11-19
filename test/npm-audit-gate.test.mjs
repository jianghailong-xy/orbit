import assert from 'node:assert/strict';
import test from 'node:test';
import { judge } from '../scripts/npm-audit-gate.mjs';

const advisory = (id, name, range, severity = 'high') => ({
  source: 1, name, dependency: name, title: `${name} advisory`, url: `https://github.com/advisories/${id}`, severity, range,
});
const audit = (...vias) => ({ vulnerabilities: Object.fromEntries(vias.map((v) => [v.name, { severity: v.severity, via: [v] }])) });
const PICO = { advisory: 'GHSA-fc5q-39xc-vjpf', package: 'picomatch', range: '<=4.0.7', expires: '2026-12-18', reason: 'test' };

test('an allowed advisory passes while unexpired and its range unchanged', () => {
  const result = judge(audit(advisory('GHSA-fc5q-39xc-vjpf', 'picomatch', '<=4.0.7')), [PICO], '2026-11-18');
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.allowed, ['GHSA-fc5q-39xc-vjpf']);
});

test('any other high or critical advisory fails; a moderate one does not', () => {
  const result = judge(audit(
    advisory('GHSA-fc5q-39xc-vjpf', 'picomatch', '<=4.0.7'),
    advisory('GHSA-aaaa-bbbb-cccc', 'left-pad', '<1.3.1', 'critical'),
    advisory('GHSA-g3hv-75wg-m249', 'minimatch', '>=7.0.0 <11.0.1', 'moderate'),
  ), [PICO], '2026-11-18');
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /critical GHSA-aaaa-bbbb-cccc in left-pad/);
});

test('an expired exemption fails', () => {
  const result = judge(audit(advisory('GHSA-fc5q-39xc-vjpf', 'picomatch', '<=4.0.7')), [PICO], '2026-12-19');
  assert.match(result.failures[0], /expired on 2026-12-18/);
});

test('a moved range (a patch was published) fails, so the upgrade is made', () => {
  const result = judge(audit(advisory('GHSA-fc5q-39xc-vjpf', 'picomatch', '<4.0.8')), [PICO], '2026-11-18');
  assert.match(result.failures[0], /range is now <4\.0\.8, not <=4\.0\.7/);
});

test('an exemption no advisory needs any more is noted, not failed', () => {
  const result = judge(audit(), [PICO], '2026-11-18');
  assert.deepEqual(result.failures, []);
  assert.match(result.stale[0], /no longer reported/);
});

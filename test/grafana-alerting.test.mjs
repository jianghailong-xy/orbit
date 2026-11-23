// The monitoring profile's alerting (docs/self-hosting.md, "Monitoring", "Alerts"): every rule, contact point and route
// is a file under deploy/monitoring/grafana/provisioning/alerting, and the variables they read reach Grafana from Compose.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = 'deploy/monitoring/grafana/provisioning/alerting';
const read = (file) => readFileSync(path.join(repo, file), 'utf8');

test('the rules cover every alert the monitoring criterion names, and the Watchdog', () => {
  const uids = [...read(`${dir}/rules.yml`).matchAll(/^ {6}- uid: (\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(uids.sort(), [
    'orbit-apiserver-down', 'orbit-base-backup-old', 'orbit-disk-85', 'orbit-http-5xx', 'orbit-http-p95', 'orbit-mirror-failing',
    'orbit-postgres-conflicts', 'orbit-wal-archive-failing', 'orbit-watchdog', 'orbit-work-no-runner',
  ]);
});

test('apiserver down is judged across every target, so a two-stage handover does not fire it', () => {
  const rules = read(`${dir}/rules.yml`);
  assert.match(rules, /expr: 'sum\(up\{job="apiserver"\}\) or vector\(0\)'/);
});

test('the Watchdog reads no data source and goes to its own contact point', () => {
  const rules = read(`${dir}/rules.yml`);
  const watchdog = rules.slice(rules.indexOf('uid: orbit-watchdog'));
  assert.doesNotMatch(watchdog, /datasourceUid: orbit-prometheus/);
  assert.match(read(`${dir}/policies.yml`), /receiver: orbit-watchdog\n\s+object_matchers:\n\s+- \[watchdog, "=", "true"\]/);
  assert.match(read(`${dir}/contact-points.yml`), /url: \$ORBIT_WATCHDOG_URL/);
});

test('ntfy is the default contact point, with email and webhook as the alternatives', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /ORBIT_ALERT_CONTACT: \$\{ORBIT_ALERT_CONTACT:-orbit-ntfy\}/);
  const contacts = read(`${dir}/contact-points.yml`);
  for (const name of ['orbit-ntfy', 'orbit-email', 'orbit-webhook', 'orbit-watchdog']) assert.match(contacts, new RegExp(`name: ${name}\\n`));
  assert.match(read(`${dir}/policies.yml`), /receiver: \$ORBIT_ALERT_CONTACT/);
});

test('every variable the alerting files read is passed to Grafana', () => {
  const compose = read('docker-compose.yml');
  const text = ['contact-points', 'policies', 'rules'].map((f) => read(`${dir}/${f}.yml`)).join('\n');
  for (const name of new Set([...text.matchAll(/\$(ORBIT_[A-Z_]+)/g)].map((m) => m[1]))) {
    assert.match(compose, new RegExp(`^ {6}${name}: `, 'm'), `${name} is not in the grafana service's environment`);
  }
});

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [tapPath, evidencePath, outputPath] = process.argv.slice(2);
assert.ok(outputPath, 'usage: outcome-reconciler-auto-dispatch-manifest.mjs TAP EVIDENCE OUTPUT');
const repo = path.resolve(import.meta.dirname, '..');
const tap = readFileSync(path.resolve(tapPath), 'utf8');
const evidence = JSON.parse(readFileSync(path.resolve(evidencePath), 'utf8'));
const targetSha = process.env.AUTO_DISPATCH_TARGET_SHA;
const fixtureCleaned = process.env.AUTO_DISPATCH_FIXTURE_CLEANED;

function counter(name) {
  const match = tap.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
  assert.ok(match, `TAP summary is missing ${name}`);
  return Number(match[1]);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

const summary = {
  tests: counter('tests'),
  passed: counter('pass'),
  failed: counter('fail'),
  cancelled: counter('cancelled'),
  skipped: counter('skipped'),
  todo: counter('todo'),
};
assert.ok(summary.tests >= 8, `automatic-dispatch suite was empty or truncated: ${summary.tests}`);
assert.equal(summary.passed, summary.tests, 'not every automatic-dispatch test passed');
assert.equal(summary.failed, 0, 'automatic-dispatch suite contains failures');
assert.equal(summary.cancelled, 0, 'cancelled tests are forbidden');
assert.equal(summary.skipped, 0, 'skipped tests are forbidden');
assert.equal(summary.todo, 0, 'todo tests are forbidden');

assert.equal(evidence.schemaVersion, 1);
assert.equal(evidence.suite, 'outcome-reconciler-auto-dispatch');
assert.match(targetSha ?? '', /^[0-9a-f]{40}$/);
assert.equal(evidence.targetSha, targetSha);
assert.equal(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), targetSha);
assert.equal(fixtureCleaned, 'true', 'the disposable PostgreSQL fixture survived testing');
assert.deepEqual(
  {
    required: evidence.postgres.required,
    connected: evidence.postgres.connected,
    lastMigration: evidence.postgres.lastMigration,
  },
  {
    required: true,
    connected: true,
    lastMigration: '0205_task_auto_dispatch_obligation',
  },
);
assert.match(evidence.postgres.version, /^1[6-9]\./);
assert.match(evidence.postgres.systemIdentifier, /^[0-9]+$/);
assert.ok(evidence.postgres.migrations > 0, 'zero migration samples are forbidden');
assert.match(evidence.postgres.database, /^orbit_auto_dispatch_[a-z0-9_]+$/);

const started = new Date(evidence.observationWindow.startedAt).getTime();
const finished = new Date(evidence.observationWindow.finishedAt).getTime();
assert.ok(Number.isFinite(started) && Number.isFinite(finished) && finished >= started,
  'observation window is missing or invalid');
assert.ok(evidence.observationWindow.immediate.declaredMaximumMilliseconds > 0);
assert.ok(evidence.observationWindow.immediate.measuredMilliseconds >= 0);
assert.ok(
  evidence.observationWindow.immediate.measuredMilliseconds
    <= evidence.observationWindow.immediate.declaredMaximumMilliseconds,
  'the immediate trigger missed its declared observation window',
);
assert.ok(evidence.observationWindow.periodicSweep.productionCadenceMilliseconds > 0);
assert.ok(evidence.observationWindow.periodicSweep.measuredMilliseconds >= 0);
assert.ok(
  evidence.observationWindow.periodicSweep.measuredMilliseconds
    <= evidence.observationWindow.periodicSweep.declaredTestDeliveryMaximumMilliseconds,
  'the delivered periodic sweep missed its declared test window',
);

for (const [name, count] of Object.entries(evidence.samples)) {
  assert.ok(Number.isInteger(count) && count > 0, `${name} has zero samples`);
}
for (const [name, proven] of Object.entries(evidence.coverage)) {
  assert.equal(proven, name === 'productionWrites' ? false : true, `${name} was not proven`);
}
assert.deepEqual(evidence.results.immediate, {
  activeSessions: 1,
  totalSessions: 1,
  dispatchAttempt: 1,
});
assert.deepEqual(evidence.results.sweepRecovery, {
  activeSessions: 1,
  totalSessions: 1,
  dispatchAttempt: 1,
});
assert.deepEqual(evidence.results.rollingV1Replay, {
  firstActiveSessions: 1,
  replayActiveSessions: 1,
  firstDispatchAttempt: 1,
  replayDispatchAttempt: 1,
  judgmentRequests: 1,
});
assert.deepEqual(evidence.results.concurrentDelivery, {
  deliveredSignals: 2,
  activeSessions: 1,
  totalSessions: 1,
  runRequests: 1,
});
assert.deepEqual(evidence.results.policyRefusal, {
  reasonCode: 'OWNER_RATIFICATION_REQUIRED',
  dispatchAttempt: 1,
  canonicalObligations: 1,
  wakeupStateBeforeRecovery: 'PENDING',
  activeSessionsAfterWakeup: 1,
});
assert.deepEqual(evidence.results.capacityRefusal, {
  reasonCode: 'RUNNER_OR_LIST_CAPACITY_EXHAUSTED',
  dispatchAttempt: 1,
  canonicalObligations: 1,
  wakeupState: 'PENDING',
  activeSessions: 0,
});

const sources = [
  'package.json',
  'src/apiserver/prisma/schema.prisma',
  'src/apiserver/prisma/migrations/0205_task_auto_dispatch_obligation/migration.sql',
  'src/apiserver/src/common/auto-dispatch-obligation.ts',
  'src/apiserver/src/common/control-plane-obligation.ts',
  'src/apiserver/src/projects/projects.service.ts',
  'src/apiserver/src/runner-api/runner-api.controller.ts',
  'src/apiserver/src/tasks/tasks.service.ts',
  'src/apiserver/src/tasks/task-retry-policy.ts',
  'src/apiserver/src/sessions/sessions.service.ts',
  'test/outcome-reconciler-auto-dispatch.test.mjs',
  'scripts/outcome-reconciler-auto-dispatch.sh',
  'scripts/outcome-reconciler-auto-dispatch-manifest.mjs',
];
const sourceDigests = Object.fromEntries(sources.map((source) => [
  source,
  digest(readFileSync(path.join(repo, source))),
]));
const sourceDigest = digest(canonical(sourceDigests));
assert.match(sourceDigest, /^[0-9a-f]{64}$/);

const manifest = {
  schemaVersion: 1,
  suite: evidence.suite,
  outcome: 'PASS',
  targetSha,
  sourceDigest,
  sourceDigests,
  summary,
  skipCount: 0,
  observationWindow: {
    startedAt: evidence.observationWindow.startedAt,
    finishedAt: evidence.observationWindow.finishedAt,
    durationMilliseconds: finished - started,
    immediate: evidence.observationWindow.immediate,
    periodicSweep: evidence.observationWindow.periodicSweep,
  },
  postgres: evidence.postgres,
  samples: evidence.samples,
  coverage: evidence.coverage,
  results: evidence.results,
  fixture: {
    disposable: true,
    cleanedBeforeManifest: true,
    productionWrites: false,
    manualProductionStart: false,
  },
  generatedAt: new Date().toISOString(),
};
writeFileSync(path.resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  outcome: manifest.outcome,
  targetSha: manifest.targetSha,
  sourceDigest: manifest.sourceDigest,
  tests: manifest.summary.tests,
  skipped: manifest.summary.skipped,
  observationWindow: manifest.observationWindow,
}, null, 2));

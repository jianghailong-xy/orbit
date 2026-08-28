#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [tapPath, evidencePath, goPath, outputPath] = process.argv.slice(2);
assert.ok(outputPath, 'usage: manifest.mjs TAP EVIDENCE GO_OUTPUT OUTPUT');
const repo = path.resolve(import.meta.dirname, '..');
const tap = readFileSync(tapPath, 'utf8');
const goOutput = readFileSync(goPath, 'utf8');
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));

function number(name) {
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
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

const summary = {
  tests: number('tests'), passed: number('pass'), failed: number('fail'),
  cancelled: number('cancelled'), skipped: number('skipped'), todo: number('todo'),
};
assert.ok(summary.tests >= 16, `acceptance suite was truncated: ${summary.tests}`);
assert.equal(summary.passed, summary.tests);
assert.equal(summary.failed, 0);
assert.equal(summary.cancelled, 0);
assert.equal(summary.skipped, 0);
assert.equal(summary.todo, 0);
assert.match(goOutput, /PASS/);
assert.match(goOutput, /TestExecutableAcceptanceShortProcessesProduceTypedFacts/);
assert.equal(evidence.suite, 'executable-acceptance-runtime-v2');
assert.equal(evidence.negotiation.rejected.decision, 'REJECTED');
assert.equal(evidence.negotiation.rejected.spawnCount, 0);
assert.equal(evidence.negotiation.admitted.effectiveTimeoutSeconds, 1200);
assert.equal(evidence.legacy.legacyTermination, 'UNTYPED');
assert.equal(evidence.legacy.legacyExitCode, -1);
assert.equal(evidence.legacy.diagnosis, 'TIMEOUT');
assert.equal(evidence.supersessionSurfaces.edgeStillPointsToW, true);
for (const key of [
  'taskGet', 'taskList', 'project', 'readySelector', 'runNow', 'instantTrigger',
  'periodicSweep', 'executeCommitGate', 'brokenFailClosed', 'cycleFailClosed',
]) assert.ok(evidence.supersessionSurfaces[key], `supersession evidence missing ${key}`);
assert.equal(evidence.watchdog.workerTerminated, true);
assert.equal(evidence.watchdog.staleEvent, true);
assert.equal(evidence.watchdog.staleSurfaceObligations, 1);
assert.equal(evidence.watchdog.allSixSurfacesStale, true);
assert.equal(evidence.watchdog.allSixSurfacesRecovered, true);
assert.equal(evidence.watchdog.recoveryCleared, true);
assert.equal(evidence.watchdog.deadmanReadsWorkerProjection, false);
for (const key of ['rest', 'cli', 'mcp', 'sharedWire']) {
  assert.equal(evidence.compatibility[key], true, `compatibility evidence missing ${key}`);
}

const subjects = [
  'package.json',
  'docker-compose.yml',
  'src/apiserver/prisma/schema.prisma',
  'src/apiserver/prisma/migrations/0200_executable_acceptance_runtime_contract/migration.sql',
  'src/apiserver/src/tasks/executable-acceptance-runtime.ts',
  'src/apiserver/src/tasks/task-completion-criterion.ts',
  'src/apiserver/src/tasks/task-dependencies.ts',
  'src/apiserver/src/tasks/tasks.service.ts',
  'src/apiserver/src/runner-api/runner-api.controller.ts',
  'src/apiserver/src/outcome-watchdog/outcome-watchdog.runner.ts',
  'src/apiserver/src/outcome-watchdog/outcome-watchdog.service.ts',
  'src/runner-go/executable_acceptance.go',
  'src/runner-go/executable_acceptance_test.go',
  'src/runner-go/transport.go',
  'src/runner-go/types.go',
  'src/runner-go/mcp.go',
  'src/runner-go/task_cli.go',
  'src/shared/src/dto.ts',
  'scripts/executable-acceptance-dead-man.mjs',
  'scripts/executable-acceptance-runtime.sh',
  'scripts/executable-acceptance-runtime-manifest.mjs',
  'test/executable-acceptance-runtime.test.mjs',
];
const subjectDigests = Object.fromEntries(subjects.map((subject) => [
  subject, digest(readFileSync(path.join(repo, subject))),
]));
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.match(sourceSha, /^[0-9a-f]{40}$/);
assert.equal(evidence.sourceSha, sourceSha);
const finishedAt = new Date().toISOString();
const payload = {
  schemaVersion: 1,
  suite: evidence.suite,
  outcome: 'PASS',
  command: 'npm run test:outcome-reconciler:acceptance-runtime',
  expectedExitCode: 0,
  sourceSha,
  sourceTreeDigest: digest(canonical(subjectDigests)),
  startedAt: process.env.EXECUTABLE_ACCEPTANCE_STARTED_AT,
  finishedAt,
  summary,
  tapDigest: digest(tap),
  goTestDigest: digest(goOutput),
  evidenceDigest: digest(canonical(evidence)),
  subjectDigests,
  successorBinding: {
    taskId: '34Ex0SFCY6DpfvW2I4ydE', requestedTimeoutSeconds: 1200,
    schemaRevision: 2, capabilityRevision: 2,
  },
};
assert.ok(payload.startedAt, 'start timestamp missing');
const manifest = { ...payload, manifestDigest: digest(canonical(payload)) };
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`executable acceptance manifest: ${outputPath}\n`);
process.stdout.write(`manifestDigest=${manifest.manifestDigest} sourceSha=${sourceSha} skip=0\n`);

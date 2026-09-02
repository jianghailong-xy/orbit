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
assert.deepEqual(evidence.negotiation.liveReadback, {
  requestedTimeoutSeconds: 1200,
  effectiveTimeoutSeconds: 1200,
  runnerSchemaRevision: 2,
  runnerCapabilityRevision: 2,
  runnerHardMaxSeconds: 3600,
  runnerSha: evidence.sourceSha,
  spawnCount: 1,
});
const persistedTimeout = evidence.persistedTypedAttempts.find(({ kind }) => kind === 'TIMED_OUT');
assert.deepEqual(persistedTimeout, {
  kind: 'TIMED_OUT', factPersisted: true, actualExitCode: null,
  goalActionable: true, continuation: 'RETRY',
});
assert.equal(evidence.legacy.legacyTermination, 'UNTYPED');
assert.equal(evidence.legacy.legacyExitCode, -1);
assert.equal(evidence.legacy.diagnosis, 'TIMEOUT');
assert.equal(evidence.supersessionSurfaces.edgeStillPointsToW, true);
for (const key of [
  'taskGet', 'taskList', 'project', 'readySelector', 'runNow', 'instantTrigger',
  'periodicSweep', 'executeCommitGate', 'brokenFailClosed', 'cycleFailClosed',
]) assert.ok(evidence.supersessionSurfaces[key], `supersession evidence missing ${key}`);
assert.equal(evidence.watchdog.staleEvent, true);
assert.equal(evidence.watchdog.staleSurfaceObligations, 2);
assert.equal(evidence.watchdog.allSixSurfacesStale, true);
assert.equal(evidence.watchdog.allSixSurfacesRecovered, true);
assert.equal(evidence.watchdog.recoveryCleared, true);
assert.equal(evidence.watchdog.deadmanReadsWorkerProjection, false);
assert.equal(evidence.watchdog.neverHeartbeatedGenerationDetected, true);
assert.equal(evidence.watchdog.missingEventExactlyOnce, true);
assert.equal(evidence.watchdog.generationsRegisteredBeforeStart, 2);
assert.equal(evidence.watchdog.heartbeatGenerationAndModuleBound, true);
for (const key of ['rest', 'cli', 'mcp', 'sharedWire']) {
  assert.equal(evidence.compatibility[key], true, `compatibility evidence missing ${key}`);
}
assert.deepEqual(evidence.compatibility.rollingV1CanonicalBridge, {
  retryRollback: true, duplicateNoop: true, canonicalFacts: 1, typedAttempts: 0,
});
// `rollingV1ExistingOpenRequest` and `rollingV1ExistingResult` used to be written here by the
// rolling-upgrade verifier. ba1f1972 removed the completion-ACK protocol they described, and
// deleted the two lines that produced them without deleting the two that read them, so this
// manifest has since asserted evidence that nothing writes. The rolling lane still proves what
// survives an upgrade through `rollingV1CanonicalBridge` and `rollingV1StaleOpenIsolation`.
assert.equal(evidence.compatibility.rollingV1StaleOpenIsolation, true);
assert.equal(evidence.compatibility.nMinusOnePlan, 'v1');
assert.equal(evidence.compatibility.legacyMinusOneActionable, true);
assert.equal(evidence.compatibility.stagedPre0193V1Turn, true);
assert.equal(evidence.compatibility.crossed0193And0200, true);
assert.equal(evidence.compatibility.historicalTerminalEventUningested, true);
assert.equal(evidence.compatibility.runtimeSchemaIndexesPresent, true);
assert.equal(evidence.negotiation.httpSuccessStatus, 200);

const subjects = [
  'package.json',
  'docker-compose.yml',
  'src/apiserver/prisma/schema.prisma',
  'src/apiserver/prisma.frontier.config.ts',
  'src/apiserver/prisma/migrations/0200_executable_acceptance_runtime_contract/migration.sql',
  'src/apiserver/prisma/migrations/0201_completion_ack_canonical_obligation/migration.sql',
  'src/apiserver/prisma/migrations/0202_completion_ack_persistent_coordinator/migration.sql',
  'src/apiserver/prisma/migrations/0220_completion_ack_removal/migration.sql',
  'src/apiserver/prisma/migrations/0221_watchdog_persistent_coordinator_removal/migration.sql',
  'src/apiserver/src/tasks/executable-acceptance-runtime.ts',
  'src/apiserver/src/tasks/task-completion-criterion.ts',
  'src/apiserver/src/tasks/task-dependencies.ts',
  'src/apiserver/src/tasks/tasks.service.ts',
  'src/apiserver/src/tasks/manual-runnable-task-sql.ts',
  'src/apiserver/src/runner-api/runner-api.controller.ts',
  'src/apiserver/src/runner-api/runner-api.module.ts',
  'src/apiserver/src/common/blocker-signal-exit-inventory.ts',
  'src/apiserver/src/common/db-write-inventory.ts',
  'src/apiserver/src/projects/coordinator-judgment-opening.ts',
  'src/apiserver/src/projects/coordinator-judgment.module.ts',
  'src/apiserver/src/projects/coordinator-wake.ts',
  'src/apiserver/src/projects/project-list-rollup.ts',
  'src/apiserver/src/projects/project-panorama.ts',
  'src/apiserver/src/projects/projects.service.ts',
  'src/apiserver/src/realtime/realtime.service.ts',
  'src/apiserver/src/sessions/sessions.service.ts',
  'src/apiserver/src/tasks/task-completion-evidence.service.ts',
  'src/runner-go/executable_acceptance.go',
  'src/runner-go/executable_acceptance_test.go',
  'src/runner-go/transport.go',
  'src/runner-go/types.go',
  'src/runner-go/mcp.go',
  'src/runner-go/task_cli.go',
  'src/shared/src/dto.ts',
  'src/shared/src/realtime.ts',
  'src/web/src/api.ts',
  'src/web/src/components/WorkspaceView.tsx',
  'src/web/src/lib/projectAttention.ts',
  'src/web/src/lib/queries.ts',
  'scripts/executable-acceptance-dead-man.mjs',
  'scripts/executable-acceptance-runtime.sh',
  'scripts/executable-acceptance-rolling-upgrade.mjs',
  'scripts/executable-acceptance-runtime-manifest.mjs',
  '.agents/skills/upgrade/scripts/upgrade.sh',
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

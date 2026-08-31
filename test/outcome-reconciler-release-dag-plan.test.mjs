import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fullApiCaseIdentity } from '../scripts/outcome-reconciler-release-dag-database.mjs';
import {
  CASE_FAILED_TESTS,
  CASE_NO_TESTS,
  CASE_PASS,
  classifyCase,
  tapMetrics,
} from '../scripts/outcome-reconciler-release-dag-full-api-shard.mjs';
import {
  canonical,
  checkpointReuseDecision,
  commandDigest,
  dagPlanDigest,
  deriveBinding,
  addResources,
  metricsForNode,
  nodeInputDigest,
  nodeInputDigests,
  resourceFits,
  resumeProjection,
  scopeDigests,
  scopeNameForPath,
  sha256,
  topologicalOrder,
  validatePlan,
} from '../scripts/outcome-reconciler-release-dag-lib.mjs';
import {
  readCheckpoint,
  readmitCheckpoint,
  writeCheckpoint,
} from '../scripts/outcome-reconciler-release-dag-checkpoints.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const readJson = (relative) => JSON.parse(readFileSync(path.join(repo, relative), 'utf8'));
const read = (relative) => readFileSync(path.join(repo, relative), 'utf8');
const digest = (file) => {
  const raw = readFileSync(file);
  return { bytes: raw.byteLength, sha256: sha256(raw) };
};
const plan = readJson('contracts/outcome-reconciler-release-dag.json');
const frontier = readJson('contracts/outcome-reconciler-release-frontier.json');
const authoritative = readJson('contracts/outcome-reconciler-authoritative-target.json');
const packageJson = readJson('package.json');
const nodeById = new Map(plan.nodes.map((node) => [node.id, node]));
const zeroTarget = '0'.repeat(40);
const oneTarget = '1'.repeat(40);
const targetReceiptDigest = '2'.repeat(64);
const environment = {
  identity: plan.environment.identity,
  versions: { node: 'fixture', npm: 'fixture', git: 'fixture', docker: 'fixture', go: 'fixture' },
  imageIds: { [plan.environment.postgresImage]: 'fixture', [plan.environment.swiftImage]: 'fixture' },
  boundInputs: { PUBLIC_ORIGIN: 'http://localhost:2086' },
};
const binding = deriveBinding({ plan, targetSha: zeroTarget, targetReceiptDigest, environment });
// The next round: a new commit, so a new target SHA and a new round binding, on the very
// same checkout content. This is the situation the old key could not tell apart from a
// genuinely different tree.
const nextBinding = deriveBinding({ plan, targetSha: oneTarget, targetReceiptDigest, environment });

// One representative file per declared scope, so an edit can be aimed at exactly one of them.
const CHECKOUT_FIXTURE = [
  ['package.json', 'package'],
  ['package-lock.json', 'lock'],
  ['tsconfig.base.json', 'tsconfig-base'],
  ['contracts/outcome-reconciler-release-dag.json', 'release-dag-plan'],
  ['contracts/outcome-reconciler-authoritative-target.json', 'authoritative'],
  ['contracts/outcome-reconciler-release-frontier.json', 'frontier'],
  ['contracts/outcome-reconciler-v2-watchdog-slo.json', 'watchdog-slo'],
  ['scripts/outcome-reconciler-release-dag.mjs', 'runner'],
  ['test/outcome-reconciler-v2.watchdog.test.mjs', 'watchdog-suite'],
  ['docs/postgres-lock-order.md', 'lock-order'],
  ['src/apiserver/src/sessions/current-work-delivery.spec.ts', 'current-work-spec'],
  ['src/apiserver/src/runner-api/inbox-lease-generation.spec.ts', 'inbox-lease-spec'],
  ['src/apiserver/src/test-support/prisma-transaction-double.ts', 'transaction-double'],
  ['src/apiserver/src/outcome-watchdog/outcome-watchdog.ts', 'watchdog-source'],
  ['src/apiserver/prisma/schema.prisma', 'schema'],
  ['src/shared/src/index.ts', 'shared-source'],
  ['src/web/src/App.tsx', 'web-source'],
  ['src/macos/OrbitKit/Sources/OrbitKit/OrbitKit.swift', 'swift-source'],
  ['src/ios/Orbit/OrbitApp.swift', 'ios-source'],
  ['src/runner-go/main.go', 'go-source'],
];

function checkout(edits = {}) {
  return CHECKOUT_FIXTURE.map(([file, seed]) => ({
    path: file,
    sha256: sha256(edits[file] ?? seed),
  }));
}

function inputsAfter(edits = {}, selectedPlan = plan, selectedBinding = binding) {
  return nodeInputDigests({
    plan: selectedPlan,
    scopeDigests: scopeDigests(selectedPlan, checkout(edits)),
    environmentDigest: selectedBinding.environmentDigest,
  });
}

const baselineInputs = inputsAfter();

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function successReceipt(node, selectedBinding = binding, index = baselineInputs) {
  return {
    nodeId: node.id,
    state: 'SUCCESS',
    exitCode: 0,
    binding: selectedBinding,
    commandDigest: commandDigest(node.command),
    inputDigest: index.get(node.id).inputDigest,
    inputs: index.get(node.id).inputs,
  };
}

// Round one ran on the baseline checkout; every receipt below was written then.
function receiptsFromPreviousRound(index = baselineInputs) {
  return new Map(plan.nodes.map((node) => [node.id, successReceipt(node, binding, index)]));
}

function projectNextRound(edits, { selectedPlan = plan, receipts } = {}) {
  const target = selectedPlan ?? plan;
  return resumeProjection({
    plan: target,
    binding: nextBinding,
    receipts: receipts ?? receiptsFromPreviousRound(),
    scopeDigests: scopeDigests(target, checkout(edits)),
  });
}

const HEAVY_NODES = ['full-swift', 'full-go', 'full-web', 'suite-watchdog-111k'];
// The real repair between the 36/45 round and the 39/45 round: transaction-double specs
// and the double itself, and nothing else.
const TRANSACTION_DOUBLE_REPAIR = {
  'src/apiserver/src/sessions/current-work-delivery.spec.ts': 'current-work-spec-repaired',
  'src/apiserver/src/runner-api/inbox-lease-generation.spec.ts': 'inbox-lease-spec-repaired',
  'src/apiserver/src/test-support/prisma-transaction-double.ts': 'transaction-double-repaired',
};

test('the formal evaluator and every DAG node have bounded admission', () => {
  const result = validatePlan(plan);
  assert.equal(plan.evaluator.acceptanceCommand, 'npm run test:outcome-reconciler:release-dag');
  assert.equal(plan.builder.acceptanceCommand,
    'npm run test:outcome-reconciler:release-dag-regression-rebind');
  assert.deepEqual({
    taskId: plan.supersededAttempt.taskId,
    sessionId: plan.supersededAttempt.sessionId,
    terminalState: plan.supersededAttempt.terminalState,
    actualExitCode: plan.supersededAttempt.actualExitCode,
    failureFingerprint: plan.supersededAttempt.failureFingerprint,
    evidenceReuse: plan.supersededAttempt.evidenceReuse,
  }, {
    taskId: '34GVK9T3B4GW7UpXH6kmT',
    sessionId: '5saDXo7pdATSJ98Cd7VcdK',
    terminalState: 'EXITED',
    actualExitCode: 1,
    failureFingerprint: '1a09b7ba0ad9ecf8c6b42e00eb7037e94120764ff0a658a42493838d28fbb153',
    evidenceReuse: 'NONE',
  });
  assert.equal(plan.builder.timeoutSeconds, 1800);
  assert.equal(plan.builder.commandDigest,
    'dd60f2d723df98ed4605f894751a11c0a6d63f8c128984dcdf50bb899bf80241');
  assert.equal(plan.builder.evaluationPlanDigest,
    '6c852b45dedf94260b61ce17a269ed484c8c2b523b9b0ed84d999dea00853da2');
  assert.equal(plan.evaluator.attemptTimeoutSeconds, 3600);
  assert.ok(plan.evaluator.schedulerDeadlineSeconds < plan.evaluator.attemptTimeoutSeconds);
  assert.equal(plan.evaluator.automaticRetries, 0);
  assert.equal(plan.evaluator.phase, 'PREDEPLOY_EVALUATION');
  assert.equal(plan.postDeploymentBoundary.taskId, plan.evaluator.deploymentTaskId);
  assert.equal(plan.postDeploymentBoundary.mode, 'TYPED_DEFERRED_ASSERTIONS');
  assert.match(plan.evaluator.commandDigest, /^[0-9a-f]{64}$/u);
  assert.equal(plan.evaluator.commandDigest,
    'f4cbb8f5c00e309cd82e53508b3e45d3ab125f245153aa0512be29c14d0cf23c');
  assert.equal(plan.evaluator.evaluationPlanDigest,
    '21e4e031a6caf1ec6a837c6f4be2628d24ab465b3736216e6486cb4687c10dc1');
  assert.equal(result.order.length, plan.nodes.length);
  for (const node of plan.nodes) {
    assert.ok(node.timeoutSeconds > 0 && node.timeoutSeconds <= 3600, node.id);
    assert.ok(node.timeoutSeconds <= plan.evaluator.attemptTimeoutSeconds, node.id);
  }
  const builderHarness = read('scripts/outcome-reconciler-release-dag-regression-rebind.sh');
  const builderBudgets = [...builderHarness.matchAll(/timeout -k \d+ (\d+)/gu)]
    .map((match) => Number(match[1]));
  assert.deepEqual(builderBudgets, [30, 180, 90, 1400, 45]);
  assert.ok(builderBudgets.reduce((total, seconds) => total + seconds, 0)
    < plan.builder.timeoutSeconds);
  let inUse = addResources({}, nodeById.get('prepare-postgres'));
  assert.equal(resourceFits(
    nodeById.get('full-swift'), inUse, plan.resourceLimits, 1,
  ), false, 'two docker-heavy nodes were admitted together');
  inUse = addResources(inUse, nodeById.get('prepare-postgres'), -1);
  assert.equal(resourceFits(nodeById.get('full-swift'), inUse, plan.resourceLimits, 0), true);
  const runner = read('scripts/outcome-reconciler-release-dag.mjs');
  assert.match(runner, /const processStartedAtMs = Date\.now\(\)/u);
  assert.match(runner, /timeout: 120_000/u);
  assert.match(runner, /resourceFits\(node, inUse, plan\.resourceLimits, running\.size\)/u);
  assert.match(runner, /addResources\(inUse, node, 1\)/u);
});

test('all former release-frontier entrypoints map one-to-one to explicit nodes', () => {
  assert.equal(frontier.namedSuites.length, 17);
  const former = [
    ...frontier.namedSuites,
    ...frontier.restoredSuites,
    ...frontier.fullMatrices,
    { name: 'authoritative-target', packageScript: 'test:outcome-reconciler:authoritative-target' },
  ].map(({ name, packageScript }) => ({ name, packageScript }));
  assert.deepEqual(
    plan.legacyEntrypoints.map(({ name, packageScript }) => ({ name, packageScript })),
    former,
  );
  assert.equal(new Set(plan.legacyEntrypoints.map((entry) => entry.nodeId)).size, former.length);
  for (const entry of plan.legacyEntrypoints) {
    assert.ok(nodeById.has(entry.nodeId), entry.nodeId);
    assert.ok(packageJson.scripts[entry.packageScript], entry.packageScript);
    if (!['test:outcome-reconciler:full-api', 'test:outcome-reconciler:full-clients']
      .includes(entry.packageScript)) {
      assert.deepEqual(nodeById.get(entry.nodeId).command, ['npm', 'run', entry.packageScript]);
    }
  }
  assert.deepEqual(plan.legacyDirectEntrypoints, [{
    name: 'release-live-state',
    command: ['node', 'scripts/outcome-reconciler-release-live-state.mjs'],
    nodeId: 'release-live-state-boundary',
  }]);
  assert.deepEqual(nodeById.get('release-live-state-boundary').command,
    plan.legacyDirectEntrypoints[0].command);
  assert.ok(frontier.additionalManifests.includes(
    'build/outcome-reconciler-release-live-state-manifest.json',
  ));
});

test('Full API, clients, 111k Watchdog, aggregation and publication are explicit', () => {
  const required = [
    'suite-watchdog-111k',
    'full-api-inventory',
    'full-api-shard-0', 'full-api-shard-1', 'full-api-shard-2', 'full-api-shard-3',
    'full-api-serial', 'full-api',
    'full-shared', 'full-web', 'full-go', 'full-swift', 'full-clients',
    'manifest-aggregate', 'release-live-state-boundary', 'publish-evidence-cut',
  ];
  for (const id of required) assert.ok(nodeById.has(id), id);
  assert.deepEqual(nodeById.get('suite-watchdog-111k').scale,
    { tasks: 111000, replaySamples: 111000 });
  assert.deepEqual(nodeById.get('full-api-serial').dependsOn,
    ['full-api-shard-0', 'full-api-shard-1', 'full-api-shard-2', 'full-api-shard-3']);
  assert.deepEqual(nodeById.get('full-clients').dependsOn,
    ['full-shared', 'full-web', 'full-go', 'full-swift']);
  assert.equal(nodeById.get('manifest-aggregate').dependsOn.includes('full-api'), true);
  assert.deepEqual(nodeById.get('release-live-state-boundary').dependsOn, ['manifest-aggregate']);
  assert.deepEqual(nodeById.get('publish-evidence-cut').dependsOn,
    ['release-live-state-boundary']);
});

test('the matrix is exhaustive and has no release-level test filter', () => {
  const commands = plan.nodes.flatMap((node) => node.command).join('\n');
  assert.doesNotMatch(commands, /--test-name-pattern|--grep|--filter|--exclude|\.only\b/iu);
  const apiAdapter = read('scripts/outcome-reconciler-release-dag-full-api.sh');
  const apiStep = read('scripts/outcome-reconciler-release-dag-step.mjs');
  const clientAdapter = read('scripts/outcome-reconciler-release-dag-client.sh');
  assert.match(apiStep, /EXHAUSTIVE_DISJOINT_PARTITION_WITHOUT_NAME_FILTER/u);
  assert.match(apiStep, /an exhaustive one-time cover/u);
  assert.match(apiStep, /a Full API spec was executed twice/u);
  assert.match(apiAdapter, /full-api-case\.sh/u);
  for (const id of [
    'full-api-inventory', 'full-api-shard-0', 'full-api-shard-1',
    'full-api-shard-2', 'full-api-shard-3', 'full-api-serial', 'full-api',
  ]) {
    assert.equal(nodeById.get(id).usesSharedBuild, true, `${id} omitted shared build context`);
    assert.equal(nodeById.get(id).usesSharedPostgres, true, `${id} omitted shared PG context`);
  }
  assert.match(clientAdapter, /vitest" run --maxWorkers=1 --fileParallelism=false/u);
  assert.match(clientAdapter, /go test -json -count=1 -timeout 1800s \.\/\.\.\./u);
  assert.match(clientAdapter, /swift test --jobs 3 --scratch-path/u);
  const workOverview = read('scripts/outcome-reconciler-work-overview-readiness.sh');
  assert.match(workOverview, /project-work-overview-readiness\.pg\.spec\.js/u);
  assert.match(workOverview, /WorkOverviewReadiness\.acceptance\.test\.tsx/u);
  assert.match(workOverview, /PREDEPLOY_EVALUATION/u);
  assert.match(workOverview, /DEFERRED_TO_BOUND_TASK/u);
  const deferred = plan.nodes.filter((node) => node.kind === 'predeploy-attestation');
  assert.deepEqual(deferred.map((node) => node.id), [
    'suite-auto-dispatch-integration', 'suite-watchdog-current-binding',
  ]);
  assert.ok(deferred.every((node) => node.testBearing === false && node.usesSharedBuild === true));
});

test('there is one matrix orchestrator and one evidence-cut writer', () => {
  assert.equal(packageJson.scripts['test:outcome-reconciler:release-frontier'],
    'npm run test:outcome-reconciler:release-dag');
  assert.equal(packageJson.scripts['test:outcome-reconciler:release-dag'],
    'node scripts/outcome-reconciler-release-dag.mjs');
  const writers = plan.nodes.filter((node) => node.evidenceWriter === true);
  assert.deepEqual(writers.map((node) => node.id), ['publish-evidence-cut']);
  assert.equal(plan.evidenceCut.membership,
    'ALL_SUCCESSFUL_NODE_RECEIPTS_EXCEPT_PUBLISHER_SELF');
  const dagCommands = plan.nodes.map((node) => node.command.join(' '));
  assert.equal(dagCommands.filter((command) => command.includes('test:outcome-reconciler:full-api')).length, 0);
  assert.equal(dagCommands.filter((command) => command.includes('test:outcome-reconciler:full-clients')).length, 0);
  const watchdog = nodeById.get('suite-watchdog-111k');
  assert.equal(watchdog.environment.OUTCOME_WATCHDOG_RUNTIME_CLOSURE, 'reuse');
  assert.equal(watchdog.environment.OUTCOME_WATCHDOG_LIVE_RELEASE_FENCE, 'offline');
  assert.ok(watchdog.dependsOn.includes('suite-acceptance-runtime'));
});

test('shared preparation and resource ceilings prevent repeated setup and oversubscription', () => {
  assert.equal(plan.resourceLimits.maxConcurrent, 4);
  assert.ok(plan.resourceLimits.cpu <= 8);
  assert.equal(plan.resourceLimits.cpu
    + plan.hostResourceEnvelope.persistentPostgresReservation.cpu,
  plan.hostResourceEnvelope.cpu);
  assert.equal(plan.resourceLimits.memoryMiB
    + plan.hostResourceEnvelope.persistentPostgresReservation.memoryMiB,
  plan.hostResourceEnvelope.memoryMiB);
  assert.equal(plan.resourceLimits.dockerHeavy, 1);
  assert.equal(plan.nodes.filter((node) => node.kind === 'preparation' && node.id === 'prepare-build').length, 1);
  assert.equal(plan.nodes.filter((node) => node.kind === 'preparation' && node.id === 'prepare-postgres').length, 1);
  assert.equal(plan.nodes.filter((node) => node.kind === 'preparation' && node.id === 'prepare-prisma').length, 1);
  assert.deepEqual(nodeById.get('prepare-prisma').dependsOn, ['prepare-dependencies']);
  assert.deepEqual(nodeById.get('prepare-build').dependsOn, ['prepare-prisma']);
  assert.deepEqual(nodeById.get('prepare-postgres').dependsOn, ['prepare-prisma']);
  for (const node of plan.nodes) {
    for (const [resource, amount] of Object.entries(node.resources ?? {})) {
      assert.ok(amount <= plan.resourceLimits[resource], `${node.id}/${resource}`);
    }
  }
  const prepare = read('scripts/outcome-reconciler-release-dag-prepare.sh');
  assert.equal((prepare.match(/npm run prisma:generate/g) ?? []).length, 1);
  assert.doesNotMatch(prepare, /\.bin\/prisma generate|isolated-prisma-schema/u);
  assert.match(prepare, /cp -a --reflink=auto.*@prisma/su);
  assert.match(prepare, /tsc -p tsconfig\.test\.json/u);
  assert.match(prepare, /materialize target-lock-isolated Prisma fixture/u);
  assert.match(prepare, /outcome-reconciler-release-dag-prisma-fixture\.mjs/u);
  assert.match(prepare, /node node_modules\/prisma\/build\/index\.js migrate deploy --config/u);
  assert.match(prepare, /clone pre-owner fixture and reach current frontier/u);
  assert.doesNotMatch(prepare, /\$API\/node_modules\/\.bin\/prisma.*migrate deploy/su);
  assert.match(prepare, /--cpus 2 --memory 3072m --memory-swap 3072m/u);
  const step = read('scripts/outcome-reconciler-release-dag-step.mjs');
  assert.match(step, /FIXED_DISPOSABLE_LOOPBACK_ONLY/u);
  assert.doesNotMatch(step, /\bpassword,\s*$/mu);
  assert.equal(nodeById.get('full-go').environment.GOMAXPROCS, '2');
  assert.match(read('scripts/outcome-reconciler-release-dag-client.sh'),
    /--cpus 3 --memory 4g.*swift test --jobs 3/su);
  assert.match(read('scripts/lib/outcome-reconciler-release-dag.sh'), /stale Release DAG build binding/u);
});

test('target, environment, evaluator plan and evidence cut form one exact binding', () => {
  const repeated = deriveBinding({ plan, targetSha: zeroTarget, targetReceiptDigest, environment });
  assert.deepEqual(repeated, binding);
  const targetChanged = deriveBinding({ plan, targetSha: oneTarget, targetReceiptDigest, environment });
  assert.notEqual(targetChanged.bindingDigest, binding.bindingDigest);
  assert.notEqual(targetChanged.evidenceCutDigest, binding.evidenceCutDigest);
  const receiptChanged = deriveBinding({
    plan, targetSha: zeroTarget, targetReceiptDigest: '3'.repeat(64), environment,
  });
  assert.notEqual(receiptChanged.bindingDigest, binding.bindingDigest);
  assert.notEqual(receiptChanged.evidenceCutDigest, binding.evidenceCutDigest);
  const environmentChanged = deriveBinding({
    plan,
    targetSha: zeroTarget,
    targetReceiptDigest,
    environment: { ...environment, versions: { ...environment.versions, node: 'changed' } },
  });
  assert.notEqual(environmentChanged.bindingDigest, binding.bindingDigest);
  const changedPlan = structuredClone(plan);
  changedPlan.resourceLimits.maxConcurrent -= 1;
  changedPlan.declaredDagPlanDigest = dagPlanDigest(changedPlan);
  const planChanged = deriveBinding({
    plan: changedPlan, targetSha: zeroTarget, targetReceiptDigest, environment,
  });
  assert.notEqual(planChanged.dagPlanDigest, binding.dagPlanDigest);
  assert.notEqual(planChanged.bindingDigest, binding.bindingDigest);
});

test('checkpoints reuse only exact successful command/artifact bindings', () => {
  const node = nodeById.get('suite-contract');
  const inputDigest = baselineInputs.get(node.id).inputDigest;
  const inputs = baselineInputs.get(node.id).inputs;
  const decide = (overrides = {}) => checkpointReuseDecision({
    receipt: successReceipt(node), node, binding, artifactsValid: true, inputDigest, inputs,
    ...overrides,
  });
  assert.deepEqual(decide(), { reusable: true, reason: 'EXACT_SUCCESS_CHECKPOINT' });
  assert.equal(decide({
    receipt: { ...successReceipt(node), state: 'TIMED_OUT', exitCode: null },
  }).reusable, false);
  assert.equal(decide({ receipt: { ...successReceipt(node), commandDigest: 'f'.repeat(64) } }).reason,
    'STALE_COMMAND');
  assert.equal(decide({ artifactsValid: false }).reason, 'ARTIFACT_MISMATCH');
  // A node whose artifacts name the round they were produced in cannot be handed to
  // another round, however identical its inputs are.
  const embedded = nodeById.get('prepare-build');
  assert.equal(embedded.artifactBinding, 'BINDING_EMBEDDED');
  assert.equal(checkpointReuseDecision({
    receipt: successReceipt(embedded),
    node: embedded,
    binding: nextBinding,
    artifactsValid: true,
    inputDigest: baselineInputs.get(embedded.id).inputDigest,
    inputs: baselineInputs.get(embedded.id).inputs,
  }).reason, 'STALE_BINDING');
});

test('a simulated timeout reschedules only unfinished nodes', () => {
  const unfinished = new Set([
    'full-api-shard-2', 'full-api-serial', 'full-api',
    'manifest-aggregate', 'release-live-state-boundary', 'publish-evidence-cut',
  ]);
  const receipts = new Map(plan.nodes
    .filter((node) => !unfinished.has(node.id))
    .map((node) => [node.id, successReceipt(node)]));
  receipts.set('full-api-shard-2', {
    ...successReceipt(nodeById.get('full-api-shard-2')),
    state: 'TIMED_OUT',
    exitCode: null,
  });
  const resumeScopes = scopeDigests(plan, checkout());
  const projection = resumeProjection({ plan, binding, receipts, scopeDigests: resumeScopes });
  assert.deepEqual(projection.incomplete, topologicalOrder(plan).filter((id) => unfinished.has(id)));
  assert.deepEqual(projection.ready, ['full-api-shard-2']);
  for (const id of projection.reusable) assert.equal(unfinished.has(id), false, id);

  const mixedReceipts = new Map(plan.nodes.map((node) => [node.id, successReceipt(node)]));
  mixedReceipts.set('suite-auto-dispatch', {
    ...successReceipt(nodeById.get('suite-auto-dispatch')),
    state: 'TIMED_OUT',
    exitCode: null,
  });
  const mixed = resumeProjection({
    plan, binding, receipts: mixedReceipts, scopeDigests: resumeScopes,
  });
  assert.equal(mixed.invalid.get('suite-auto-dispatch'), 'CHECKPOINT_NOT_SUCCESSFUL');
  // A node that has to run again does not discard a successor whose own inputs never
  // moved -- the round still fails, because the cut below demands a SUCCESS receipt for
  // every declared node, but it fails without rebuilding what nothing touched.
  assert.equal(mixed.reusable.has('suite-auto-dispatch-integration'), true);
  assert.equal(mixed.incomplete.includes('suite-auto-dispatch'), true);

  // Without scope digests nothing can be pinned down, so nothing is reused.
  const blind = resumeProjection({ plan, binding, receipts: mixedReceipts });
  assert.equal(blind.reusable.size, 0);
  for (const node of plan.nodes) {
    assert.equal(blind.invalid.get(node.id) === 'INDETERMINATE_INPUTS'
      || blind.invalid.get(node.id) === 'CHECKPOINT_NOT_SUCCESSFUL', true, node.id);
  }
});

test('every node receipt schema carries the required auditable fields', () => {
  const runner = read('scripts/outcome-reconciler-release-dag.mjs');
  for (const field of [
    'targetSha', 'commandDigest', 'startedAt', 'finishedAt', 'exitCode',
    'testCount', 'skipCount', 'environmentIdentity', 'toolVersions', 'artifactDigest',
  ]) {
    assert.match(runner, new RegExp(`\\b${field}\\b`, 'u'), field);
  }
  assert.match(read('scripts/outcome-reconciler-release-dag-aggregate.mjs'), /skipCount, 0/u);
  assert.match(read('scripts/outcome-reconciler-release-dag-publish.mjs'), /receiptCutDigest/u);
});

test('a skip in any declared node artifact cannot be hidden by a larger report', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'orbit-release-dag-metrics-'));
  try {
    const complete = path.join(fixture, 'complete.json');
    const skipped = path.join(fixture, 'skipped.json');
    writeFileSync(complete, JSON.stringify({
      numTotalTests: 100,
      numPassedTests: 100,
      numFailedTests: 0,
      numPendingTests: 0,
    }));
    writeFileSync(skipped, JSON.stringify({
      summary: { tests: 1, passed: 0, failed: 0, skipped: 1 },
    }));
    assert.throws(() => metricsForNode(
      { id: 'synthetic-node', testBearing: true }, [complete, skipped],
    ), /published 1 skips/u);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('the inbox repair is integrated and frozen-target verification is mandatory', () => {
  const ownerDelivery = plan.integratedDeliveries.find(
    (delivery) => delivery.taskId === '34FvZL9JNez5O9vLVYd8h',
  );
  assert.ok(ownerDelivery);
  assert.deepEqual(ownerDelivery.commits, [
    'b9d27c8d2561ebedc05bc367466302389a4685e6',
    '7eb3eb3628186b89a2c8e869da66deff5bbb6473',
  ]);
  for (const [index, commit] of ownerDelivery.commits.entries()) {
    assert.doesNotThrow(() => git('merge-base', '--is-ancestor', commit, 'HEAD'));
    assert.equal(git('show', '-s', '--format=%s', commit), ownerDelivery.requiredSubjects[index]);
  }
  assert.equal(authoritative.taskId, plan.builderTaskId);
  assert.equal(authoritative.sourceBranch, plan.builder.sourceBranch);
  assert.equal(authoritative.historicalEvidencePolicy,
    'ANCESTRY_INVENTORY_ONLY_NOT_CURRENT_RELEASE_EVIDENCE');
  assert.equal(plan.target.resolution, 'BUILDER_AGENT_MERGE_RECEIPT');
  assert.equal(plan.target.requiredReceipt.sessionDatabaseId, plan.builder.sessionDatabaseId);
  assert.equal(plan.target.requiredReceipt.sourceBranch, plan.builder.sourceBranch);
  assert.equal(plan.target.requiredReceipt.recordedBy, 'AGENT');
  assert.equal(plan.target.remoteMustRemainExactlyTarget, true);
  assert.equal(packageJson.scripts['test:outcome-reconciler:owner-ratification-inbox-routing'],
    'bash scripts/outcome-reconciler-owner-ratification-inbox-routing.sh');
  assert.match(read('scripts/outcome-reconciler-release-dag-regression-rebind.sh'),
    /outcome-reconciler-release-dag-target-check\.mjs/u);
  const runner = read('scripts/outcome-reconciler-release-dag.mjs');
  assert.match(runner, /session_merge_receipt/u);
  assert.match(runner, /checkout differs from the builder receipt target/u);
  assert.match(runner, /origin\/main changed between fetch and remote observation/u);
});

// The Full API shard regression, modelled on the real full-api-shard-3 run that died at
// [228/338] build/sessions/session-current-work-routing.pg.spec.js with 42P01: cases 229..338 were
// never executed, so a 15-minute shard produced exactly one fact.
const shardBinding = 'a'.repeat(64);
const shardAttempt = '0123456789ab';
const passingCaseTap = (name) => `TAP version 13
# Subtest: ${name}
ok 1 - ${name}
  ---
  duration_ms: 12.1
  ...
1..1
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;
const undefinedTableTap = `TAP version 13
# Subtest: routes the session's current work
not ok 1 - routes the session's current work
  ---
  duration_ms: 41.2
  location: 'build/sessions/session-current-work-routing.pg.spec.js:88:1'
  failureType: 'testCodeFailure'
  error: |-
    relation "session_current_work" does not exist
  code: '42P01'
  ...
1..1
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
`;
// exit=124 with tests=0: the per-case timeout fired before the spec reported a single subtest.
const timedOutTap = `TAP version 13
# Subtest: reaches the migration frontier
`;
// exit=1 with tests=0: the spec never loaded, so nothing ran and nothing could fail.
const neverLoadedTap = `TAP version 13
Error: Cannot find module '/orbit/src/apiserver/build/sessions/session-current-work-routing.pg.spec.js'
`;

function stageShardFixture(root, cases) {
  const caseRoot = path.join(root, 'full-api-cases');
  mkdirSync(caseRoot, { recursive: true });
  const specs = cases.map(({ caseIndex, spec }) => ({
    index: caseIndex, path: spec, class: 'serial',
  }));
  const inventoryPath = path.join(root, 'inventory.json');
  writeFileSync(inventoryPath, JSON.stringify({
    bindingDigest: shardBinding, shardCount: 4, totalSpecs: specs.length, specs,
  }));
  for (const { caseIndex, tap, exitCode } of cases) {
    const padded = String(caseIndex).padStart(4, '0');
    const summary = tapMetrics(tap);
    const identity = fullApiCaseIdentity({
      bindingDigest: shardBinding,
      attemptToken: shardAttempt,
      partitionClass: 'serial',
      partitionIndex: 0,
      caseIndex,
    });
    writeFileSync(path.join(caseRoot, `${padded}.tap`), tap);
    writeFileSync(path.join(caseRoot, `${padded}.json`), JSON.stringify({
      outcome: classifyCase({ exitCode, cleanupCode: 0, summary }),
      caseIndex,
      summary,
      ...identity,
      cleanup: { resourcesRemaining: 0 },
    }));
    writeFileSync(path.join(caseRoot, `${padded}.exit`), String(exitCode));
  }
  const executedLog = path.join(root, 'executed.log');
  const caseScript = path.join(root, 'stub-full-api-case.sh');
  writeFileSync(caseScript, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$1" >> ${JSON.stringify(executedLog)}
exit "$(cat ${JSON.stringify(caseRoot)}/$(printf '%04d' "$1").exit)"
`);
  chmodSync(caseScript, 0o755);
  return { caseRoot, caseScript, executedLog, inventoryPath };
}

function driveShard(root, cases) {
  const { caseRoot, caseScript, executedLog, inventoryPath } = stageShardFixture(root, cases);
  const resultsPath = path.join(root, 'results.json');
  const driven = spawnSync(process.execPath, [
    path.join(repo, 'scripts/outcome-reconciler-release-dag-full-api-shard.mjs'),
    'run', inventoryPath, 'serial', '0', '1', caseRoot, resultsPath, caseScript,
  ], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      OUTCOME_RELEASE_DAG_BINDING_DIGEST: shardBinding,
      OUTCOME_RELEASE_DAG_ATTEMPT_TOKEN: shardAttempt,
    },
  });
  return {
    exitCode: driven.status,
    report: `${driven.stdout}${driven.stderr}`,
    executed: readFileSync(executedLog, 'utf8').trim().split('\n').map(Number),
    results: JSON.parse(readFileSync(resultsPath, 'utf8')),
  };
}

test('a Full API shard runs every case it owns and reports all of the failures', (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'orbit-full-api-shard-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const broken = new Map([
    [228, { tap: undefinedTableTap, exitCode: 1 }],
    [301, { tap: undefinedTableTap, exitCode: 1 }],
    [337, { tap: timedOutTap, exitCode: 124 }],
  ]);
  const cases = Array.from({ length: 338 }, (_, offset) => {
    const caseIndex = offset + 1;
    const spec = caseIndex === 228
      ? 'src/apiserver/build/sessions/session-current-work-routing.pg.spec.js'
      : `src/apiserver/build/sessions/case-${caseIndex}.spec.js`;
    return { caseIndex, spec, tap: passingCaseTap(`case ${caseIndex}`), exitCode: 0,
      ...(broken.get(caseIndex) ?? {}) };
  });
  const shard = driveShard(fixture, cases);

  // The first failing case no longer ends the shard: every declared case is executed, in order.
  assert.equal(shard.results.executedCases, 338);
  assert.equal(shard.results.declaredCases, 338);
  assert.equal(shard.executed.length, 338);
  assert.deepEqual(shard.executed.slice(227, 231), [228, 229, 230, 231]);
  assert.equal(shard.executed.at(-1), 338);

  // More than one failure survives to the report, and every one of them is locatable.
  assert.ok(shard.results.failures.length > 1,
    `the shard reported ${shard.results.failures.length} failing cases`);
  assert.deepEqual(shard.results.failures.map((failure) => failure.caseIndex), [228, 301, 337]);
  for (const failure of shard.results.failures) {
    assert.ok(Number.isInteger(failure.caseIndex) && failure.caseIndex >= 1);
    assert.ok(failure.spec.length > 0, 'a failing case reported no spec path');
    assert.ok(failure.diagnostic.length > 0, 'a failing case reported no diagnostic');
    assert.match(shard.report, new RegExp(`\\[${failure.caseIndex}\\] ${failure.spec}`, 'u'));
  }
  assert.match(shard.results.failures[0].diagnostic, /42P01/u);
  assert.match(shard.results.failures[0].diagnostic,
    /relation "session_current_work" does not exist/u);
  assert.equal(shard.results.failures[0].spec,
    'src/apiserver/build/sessions/session-current-work-routing.pg.spec.js');

  // Collecting every failure is not forgiving one: the shard is still FAILED and still exits 1, so
  // the node it backs can never be recorded SUCCESS.
  assert.equal(shard.results.outcome, 'FAILED');
  assert.equal(shard.exitCode, 1);
  assert.equal(shard.results.passedCases, 335);

  // A crashed case costs the cases behind it nothing: its neighbour still runs and still passes,
  // on its own uniquely named disposable database and role.
  const byIndex = new Map(shard.results.results.map((result) => [result.caseIndex, result]));
  assert.equal(byIndex.get(229).outcome, CASE_PASS);
  assert.equal(byIndex.get(338).outcome, CASE_PASS);
  assert.notEqual(byIndex.get(229).database, byIndex.get(228).database);
  const databases = shard.results.results.map((result) => result.database);
  const roles = shard.results.results.map((result) => result.role);
  assert.equal(new Set(databases).size, 338, 'cases behind a failure shared a database');
  assert.equal(new Set(roles).size, 338, 'cases behind a failure shared a role');
  for (const identity of [...databases, ...roles]) assert.match(identity, /^pcc[0-9a-z]*_/u);
  assert.equal(shard.results.isolation.resourcesRemaining, 0);
  assert.equal(shard.results.isolation.uniqueDatabases, true);
  assert.equal(shard.results.isolation.uniqueRoles, true);
});

test('a Full API case that never reported a test is not the same fact as one that failed', (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'orbit-full-api-tests-zero-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const shard = driveShard(fixture, [
    { caseIndex: 1, spec: 'src/apiserver/build/a.spec.js', tap: passingCaseTap('a'), exitCode: 0 },
    { caseIndex: 2, spec: 'src/apiserver/build/b.spec.js', tap: timedOutTap, exitCode: 124 },
    { caseIndex: 3, spec: 'src/apiserver/build/c.spec.js', tap: neverLoadedTap, exitCode: 1 },
    { caseIndex: 4, spec: 'src/apiserver/build/d.spec.js', tap: undefinedTableTap, exitCode: 1 },
  ]);
  const outcomeOf = (caseIndex) => shard.results.failures
    .find((failure) => failure.caseIndex === caseIndex)?.outcome;
  assert.equal(shard.results.executedCases, 4);
  assert.equal(outcomeOf(2), CASE_NO_TESTS);
  assert.equal(outcomeOf(3), CASE_NO_TESTS);
  assert.equal(outcomeOf(4), CASE_FAILED_TESTS);
  assert.notEqual(outcomeOf(2), outcomeOf(4),
    'a case that reported no test and a case that ran and failed became one conclusion');
  for (const caseIndex of [2, 3, 4]) {
    const failure = shard.results.failures.find((entry) => entry.caseIndex === caseIndex);
    assert.ok(failure.diagnostic.length > 0);
  }
  assert.equal(shard.results.failures.find((entry) => entry.caseIndex === 2).summary.tests, 0);
  assert.ok(shard.results.failures.find((entry) => entry.caseIndex === 4).summary.tests > 0);
  assert.equal(shard.results.outcome, 'FAILED');
  assert.equal(shard.exitCode, 1);
  assert.match(shard.report, new RegExp(CASE_NO_TESTS, 'u'));
  assert.match(shard.report, new RegExp(CASE_FAILED_TESTS, 'u'));
});

test('the Full API shard adapter drives the case script through the collecting driver', () => {
  const adapter = read('scripts/outcome-reconciler-release-dag-full-api.sh');
  assert.match(adapter, /outcome-reconciler-release-dag-full-api-shard\.mjs" run/u);
  assert.match(adapter, /"\$REPO\/scripts\/outcome-reconciler-full-api-case\.sh" \|\| driver_rc/u);
  assert.doesNotMatch(adapter, /for \(\(offset = 0; offset < \$\{#selected\[@\]\}/u);
  const step = read('scripts/outcome-reconciler-release-dag-step.mjs');
  assert.match(step, /full-api-partition INVENTORY parallel\|serial INDEX COUNT TAP MANIFEST RESULTS/u);
  assert.match(step, /outcome: conclusion\.outcome/u);
  const shardNodes = plan.nodes.filter((node) => node.kind === 'full-api-shard');
  assert.equal(shardNodes.length, 5);
  for (const node of shardNodes) assert.equal(node.testBearing, true);
});

test('a shard with a failing case publishes a FAILED partition manifest, never a passing one', (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'orbit-full-api-partition-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const runRoot = path.join(fixture, 'run');
  const caseRoot = path.join(runRoot, 'full-api-cases');
  mkdirSync(caseRoot, { recursive: true });
  const specs = [1, 2, 3].map((index) => ({
    index,
    path: `src/apiserver/build/sessions/case-${index}.spec.js`,
    class: 'serial',
    sha256: String(index).repeat(64),
  }));
  const inventoryPath = path.join(runRoot, 'inventory.json');
  writeFileSync(inventoryPath, JSON.stringify({
    bindingDigest: shardBinding, shardCount: 4, totalSpecs: 3, inventoryDigest: 'd'.repeat(64), specs,
  }));
  const scripted = new Map([
    [1, { tap: passingCaseTap('one'), exitCode: 0 }],
    [2, { tap: undefinedTableTap, exitCode: 1 }],
    [3, { tap: timedOutTap, exitCode: 124 }],
  ]);
  const results = specs.map((spec) => {
    const { tap, exitCode } = scripted.get(spec.index);
    const summary = tapMetrics(tap);
    const identity = fullApiCaseIdentity({
      bindingDigest: shardBinding,
      attemptToken: shardAttempt,
      partitionClass: 'serial',
      partitionIndex: 0,
      caseIndex: spec.index,
    });
    const outcome = classifyCase({ exitCode, cleanupCode: 0, summary });
    const padded = String(spec.index).padStart(4, '0');
    writeFileSync(path.join(caseRoot, `${padded}.tap`), tap);
    writeFileSync(path.join(caseRoot, `${padded}.json`), JSON.stringify({
      outcome,
      bindingDigest: shardBinding,
      releaseAttempt: { token: shardAttempt },
      partition: { class: 'serial', index: 0 },
      caseIndex: spec.index,
      spec: { sha256: spec.sha256 },
      ...identity,
      cleanup: { resourcesRemaining: 0 },
      exitCode,
      summary,
      diagnostic: outcome === CASE_PASS ? '' : `case ${spec.index} diagnostic`,
      artifactDigest: 'e'.repeat(64),
    }));
    return {
      caseIndex: spec.index, spec: spec.path, outcome, exitCode, summary,
      diagnostic: `case ${spec.index} diagnostic`, ...identity, resourcesRemaining: 0,
    };
  });
  const resultsPath = path.join(runRoot, 'results.json');
  writeFileSync(resultsPath, JSON.stringify({
    kind: 'orbit.outcome-reconciler.release-dag-full-api-shard-results',
    bindingDigest: shardBinding,
    attemptToken: shardAttempt,
    partition: { class: 'serial', index: 0, count: 1 },
    declaredCases: 3,
    executedCases: 3,
    durationMilliseconds: 4321,
    results,
  }));
  const manifestPath = path.join(runRoot, 'full-api-serial.json');
  const step = spawnSync(process.execPath, [
    path.join(repo, 'scripts/outcome-reconciler-release-dag-step.mjs'), 'full-api-partition',
    inventoryPath, 'serial', '0', '1', path.join(runRoot, 'full-api-serial.tap'), manifestPath,
    resultsPath,
  ], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      OUTCOME_RELEASE_DAG_RUN_ROOT: runRoot,
      OUTCOME_RELEASE_DAG_TARGET_SHA: zeroTarget,
      OUTCOME_RELEASE_DAG_TARGET_RECEIPT_DIGEST: targetReceiptDigest,
      OUTCOME_RELEASE_DAG_ENVIRONMENT_DIGEST: '3'.repeat(64),
      OUTCOME_RELEASE_DAG_EVALUATION_PLAN_DIGEST: '4'.repeat(64),
      OUTCOME_RELEASE_DAG_PLAN_DIGEST: '5'.repeat(64),
      OUTCOME_RELEASE_DAG_EVIDENCE_CUT_DIGEST: '6'.repeat(64),
      OUTCOME_RELEASE_DAG_BINDING_DIGEST: shardBinding,
      OUTCOME_RELEASE_DAG_ATTEMPT_TOKEN: shardAttempt,
    },
  });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(step.status, 1, 'a partition with two failing cases exited zero');
  assert.equal(manifest.outcome, 'FAILED');
  assert.equal(manifest.executedCases, 3);
  assert.equal(manifest.passedCases, 1);
  assert.deepEqual(manifest.failures.map((failure) => failure.caseIndex), [2, 3]);
  assert.deepEqual(manifest.failures.map((failure) => failure.outcome),
    [CASE_FAILED_TESTS, CASE_NO_TESTS]);
  for (const failure of manifest.failures) {
    assert.ok(failure.spec.length > 0 && failure.diagnostic.length > 0);
  }
  assert.equal(manifest.databaseIsolation.allResourcesCleaned, true);
  assert.equal(manifest.databaseIsolation.uniqueDatabases, true);
  assert.match(`${step.stdout}${step.stderr}`, /reported 2 failing cases/u);
});

test('every checkout file lands in exactly one declared scope and every node declares the catch-all', () => {
  const declared = plan.inputScopes;
  assert.equal(declared.assignment, 'FIRST_DECLARED_SELECTOR_WINS_WITH_TERMINAL_CATCH_ALL');
  assert.equal(declared.catchAllScope, declared.scopes.at(-1).name);
  const tracked = git('ls-files').split('\n').filter(Boolean);
  assert.ok(tracked.length > 0);
  const covered = new Map();
  for (const file of tracked) {
    const scope = scopeNameForPath(plan, file);
    assert.ok(scope !== null, `${file} matches no input scope`);
    covered.set(scope, (covered.get(scope) ?? 0) + 1);
  }
  // The classification is a total function, so nothing is silently outside the key.
  assert.equal([...covered.values()].reduce((total, count) => total + count, 0), tracked.length);
  assert.equal(scopeNameForPath(plan, 'src/apiserver/src/tasks/task-delete.spec.ts'), 'apiserver-spec');
  assert.equal(scopeNameForPath(plan, 'src/apiserver/src/test-support/prisma-transaction-double.ts'),
    'apiserver-test-support');
  assert.equal(scopeNameForPath(plan, 'src/apiserver/src/tasks/tasks.service.ts'), 'apiserver-src');
  assert.equal(scopeNameForPath(plan, 'package-lock.json'), 'dependency-manifest');
  assert.equal(scopeNameForPath(plan, 'docs/postgres-lock-order.md'), declared.catchAllScope);
  for (const node of plan.nodes) {
    assert.ok(node.inputs.scopes.includes(declared.catchAllScope), node.id);
    assert.ok(node.inputs.scopes.includes(declared.packageLockScope), node.id);
  }
});

test('an API-only edit keeps the heavy client and watchdog checkpoints reusable', () => {
  const projection = projectNextRound({
    'src/apiserver/src/sessions/current-work-delivery.spec.ts': 'edited-for-the-api-matrix',
  });
  for (const id of HEAVY_NODES) {
    assert.equal(projection.reusable.has(id), true,
      `${id} was invalidated by an API-only edit: ${projection.invalid.get(id)}`);
  }
  // The nodes that actually read the edited file do rerun.
  for (const id of ['prepare-build', 'full-api-inventory', 'full-api-shard-0', 'full-api-serial']) {
    assert.equal(projection.invalid.get(id), 'STALE_INPUTS', id);
  }
});

test('the transaction-double repair keeps Swift, Go, Web and the 111k watchdog reusable', () => {
  const projection = projectNextRound(TRANSACTION_DOUBLE_REPAIR);
  for (const id of HEAVY_NODES) {
    assert.equal(projection.reusable.has(id), true,
      `${id} was invalidated by the transaction-double repair: ${projection.invalid.get(id)}`);
  }
  // Every node whose artifacts do not name the round survives a round it did not change.
  const contentOnly = plan.nodes.filter((node) => node.artifactBinding === 'CONTENT_ONLY');
  assert.equal(contentOnly.length, 29);
  for (const node of contentOnly) {
    assert.equal(projection.reusable.has(node.id), true,
      `${node.id}: ${projection.invalid.get(node.id)}`);
  }
  assert.equal(projection.reusable.size, 29);
  assert.equal(projection.incomplete.length, 16);
  // Before this change the same edit discarded all 45.
  assert.equal(plan.nodes.length, 45);
});

test('an edit inside a node input set invalidates exactly that node', () => {
  const projection = projectNextRound({ 'src/web/src/App.tsx': 'edited-web-source' });
  for (const id of ['full-web', 'full-clients', 'suite-surfaces', 'suite-owner-ratification-ui',
    'suite-work-overview-readiness', 'owner-ratification-inbox-routing']) {
    assert.equal(projection.invalid.get(id), 'STALE_INPUTS', id);
    assert.equal(nodeById.get(id).inputs.scopes.includes('web-src'), true, id);
  }
  for (const id of ['full-go', 'full-swift', 'suite-watchdog-111k', 'suite-coordinator']) {
    assert.equal(nodeById.get(id).inputs.scopes.includes('web-src'), false, id);
    assert.equal(projection.reusable.has(id), true, id);
  }
  const swift = projectNextRound({
    'src/macos/OrbitKit/Sources/OrbitKit/OrbitKit.swift': 'edited-swift-source',
  });
  assert.equal(swift.invalid.get('full-swift'), 'STALE_INPUTS');
  assert.equal(swift.reusable.has('full-web'), true);
});

test('a package lock change invalidates every build-bearing node', () => {
  const projection = projectNextRound({ 'package-lock.json': 'relocked' });
  const buildBearing = plan.nodes.filter((node) => node.usesSharedBuild === true
    || ['prepare-dependencies', 'prepare-build', 'prepare-prisma'].includes(node.id));
  assert.ok(buildBearing.length > 0);
  for (const node of buildBearing) {
    assert.equal(projection.reusable.has(node.id), false, node.id);
  }
  // The lock is in every node's scope set, so nothing at all survives it.
  assert.equal(projection.reusable.size, 0);
  for (const node of plan.nodes) {
    assert.equal(['STALE_INPUTS', 'STALE_BINDING'].includes(projection.invalid.get(node.id)),
      true, `${node.id}: ${projection.invalid.get(node.id)}`);
  }
});

test('a dependency whose declaration moved invalidates its consumers', () => {
  const moved = {
    ...plan,
    nodes: plan.nodes.map((node) => (node.id === 'suite-acceptance-runtime'
      ? { ...node, command: [...node.command, '--rebound'] }
      : node)),
  };
  moved.declaredDagPlanDigest = dagPlanDigest(moved);
  const projection = projectNextRound({}, { selectedPlan: moved });
  // The moved node itself: its own declaration changed.
  assert.equal(projection.invalid.get('suite-acceptance-runtime'), 'STALE_INPUTS');
  // Its consumers: nothing they read changed, but what produced their inputs did.
  assert.equal(projection.invalid.get('suite-watchdog-111k'), 'STALE_DEPENDENCY');
  assert.equal(projection.invalid.get('suite-canary'), 'STALE_DEPENDENCY');
  assert.equal(projection.invalid.get('full-swift'), 'STALE_DEPENDENCY');
  // And a node that does not descend from it is untouched.
  assert.equal(projection.reusable.has('full-go'), true);
});

test('a node whose input set cannot be determined exactly is never reused', () => {
  const digests = scopeDigests(plan, checkout());
  const node = nodeById.get('full-go');
  const undeclared = { ...node, inputs: { scopes: [] } };
  const unknownScope = { ...node, inputs: { scopes: ['invented-scope', 'unclassified'] } };
  const withoutCatchAll = { ...node, inputs: { scopes: ['go-src', 'dependency-manifest'] } };
  for (const candidate of [undeclared, unknownScope, withoutCatchAll, { ...node, inputs: undefined }]) {
    assert.equal(nodeInputDigest({ plan, node: candidate, scopeDigests: digests,
      environmentDigest: binding.environmentDigest }), null, candidate.inputs?.scopes?.join());
    assert.equal(checkpointReuseDecision({
      receipt: successReceipt(node),
      node: candidate,
      binding,
      artifactsValid: true,
      inputDigest: nodeInputDigest({ plan, node: candidate, scopeDigests: digests,
        environmentDigest: binding.environmentDigest }),
      inputs: null,
    }).reason, 'INDETERMINATE_INPUTS');
  }
  // An unknown host is just as indeterminate as an unknown file set.
  assert.equal(nodeInputDigest({ plan, node, scopeDigests: digests, environmentDigest: undefined }),
    null);
  // A receipt written before input digests existed is reran, not trusted.
  assert.equal(checkpointReuseDecision({
    receipt: { ...successReceipt(node), inputDigest: undefined, inputs: undefined },
    node,
    binding,
    artifactsValid: true,
    inputDigest: baselineInputs.get(node.id).inputDigest,
    inputs: baselineInputs.get(node.id).inputs,
  }).reason, 'INDETERMINATE_INPUTS');
  // And a plan that omits the declaration is refused outright.
  const incomplete = { ...plan, nodes: plan.nodes.map((entry) => (entry.id === 'full-go'
    ? { ...entry, inputs: { scopes: ['go-src'] } } : entry)) };
  incomplete.declaredDagPlanDigest = dagPlanDigest(incomplete);
  assert.throws(() => validatePlan(incomplete), /does not declare an exact input scope set/u);
  const unbound = { ...plan, nodes: plan.nodes.map((entry) => (entry.id === 'full-go'
    ? { ...entry, artifactBinding: undefined } : entry)) };
  unbound.declaredDagPlanDigest = dagPlanDigest(unbound);
  assert.throws(() => validatePlan(unbound), /whether its artifacts embed the round binding/u);
});

test('the publication gate still demands every declared node under the current input set', () => {
  const publish = read('scripts/outcome-reconciler-release-dag-publish.mjs');
  const aggregate = read('scripts/outcome-reconciler-release-dag-aggregate.mjs');
  assert.equal(plan.nodes.length, 45);
  assert.equal(plan.evidenceCut.requiredNodeState, 'SUCCESS');
  assert.equal(plan.evidenceCut.membership, 'ALL_SUCCESSFUL_NODE_RECEIPTS_EXCEPT_PUBLISHER_SELF');
  assert.match(publish, /expectedReceiptIds\.length \+ 1, plan\.nodes\.length/u);
  assert.match(publish, /the evidence cut must cover every declared node/u);
  assert.match(publish, /assert\.equal\(receipt\.state, 'SUCCESS'\)/u);
  assert.match(publish, /assert\.equal\(receipt\.exitCode, 0\)/u);
  assert.match(publish, /assert\.equal\(receipt\.failCount, 0\)/u);
  assert.match(publish, /assert\.equal\(receipt\.skipCount, 0\)/u);
  assert.match(publish, /receipt is absent at publication/u);
  // Recomputed here, from this checkout, rather than read back out of the receipt.
  for (const source of [publish, aggregate]) {
    assert.match(source, /checkoutScopeDigests\(plan, repo\)/u);
    assert.match(source, /was not observed under the current input set/u);
    assert.match(source, /no exactly determined input set/u);
  }
  assert.match(publish, /was re-admitted under a different input set/u);
  assert.match(publish, /embeds its round binding and may not be re-admitted/u);
});

test('no strict SHA, binding, receipt, lock, environment, evaluator, DAG or evidence guard was relaxed', () => {
  const runner = read('scripts/outcome-reconciler-release-dag.mjs');
  const publish = read('scripts/outcome-reconciler-release-dag-publish.mjs');
  const aggregate = read('scripts/outcome-reconciler-release-dag-aggregate.mjs');
  const step = read('scripts/outcome-reconciler-release-dag-step.mjs');
  const targetCheck = read('scripts/outcome-reconciler-release-dag-target-check.mjs');

  // 1. strict SHA
  assert.match(step, /assert\.equal\(head, binding\.targetSha\)/u);
  assert.match(targetCheck, /fresh origin\/main does not equal the frozen checkout/u);
  assert.match(targetCheck, /remote refs\/heads\/main does not equal the frozen checkout/u);

  // 2. current binding
  assert.match(publish, /has stale \$\{field\}/u);
  assert.match(aggregate, /has stale \$\{field\}/u);
  assert.match(runner, /current-binding\.json/u);
  assert.equal(plan.checkpointPolicy.evidenceBindingScope,
    'EVERY_RECEIPT_ADMITTED_INTO_THE_CUT_IS_BOUND_TO_THE_CURRENT_ROUND');

  // 3. target receipt
  assert.equal(plan.target.resolution, 'BUILDER_AGENT_MERGE_RECEIPT');
  assert.match(runner, /session_merge_receipt/u);
  assert.match(publish, /assert\.deepEqual\(receipt\.target, \{/u);
  assert.match(targetCheck, /merge\/push receipt is missing/u);

  // 4. package lock
  assert.ok(plan.implementationInputs.paths.includes('package-lock.json'));
  assert.equal(plan.inputScopes.packageLockScope, 'dependency-manifest');
  assert.equal(plan.implementationInputs.digests['package-lock.json'],
    createHash('sha256').update(readFileSync(path.join(repo, 'package-lock.json'))).digest('hex'));
  for (const node of plan.nodes) assert.ok(node.inputs.scopes.includes('dependency-manifest'));

  // 5. environment
  assert.match(publish, /sha256\(canonical\(receipt\.environment\)\), binding\.environmentDigest/u);
  assert.match(aggregate, /environment payload differs from its binding/u);
  assert.notEqual(
    nodeInputDigest({
      plan,
      node: nodeById.get('full-swift'),
      scopeDigests: scopeDigests(plan, checkout()),
      environmentDigest: binding.environmentDigest,
    }),
    nodeInputDigest({
      plan,
      node: nodeById.get('full-swift'),
      scopeDigests: scopeDigests(plan, checkout()),
      environmentDigest: 'e'.repeat(64),
    }),
  );

  // 6. evaluation plan
  assert.equal(binding.evaluationPlanDigest, plan.evaluator.evaluationPlanDigest);
  assert.match(publish, /evaluationPlanDigest: required\('OUTCOME_RELEASE_DAG_EVALUATION_PLAN_DIGEST'\)/u);
  assert.throws(() => validatePlan({
    ...plan, evaluator: { ...plan.evaluator, evaluationPlanDigest: 'short' },
  }), /full SHA-256 values/u);

  // 7. DAG plan
  assert.equal(plan.declaredDagPlanDigest, dagPlanDigest(plan));
  assert.equal(plan.checkpointPolicy.invalidateOnPlanChange, true);
  assert.equal(plan.checkpointPolicy.invalidateOnTargetChange, true);
  assert.throws(() => validatePlan({ ...plan, declaredDagPlanDigest: '0'.repeat(64) }),
    /declared Release DAG plan digest is stale/u);

  // 8. evidence cut
  assert.equal(plan.checkpointPolicy.verifyArtifactDigestsOnReuse, true);
  assert.equal(plan.checkpointPolicy.reusedReceiptProvenance, 'REQUIRED');
  assert.match(publish, /artifact snapshot|digestFile\(snapshot\)/u);
  assert.match(publish, /receiptCutDigest/u);
});

test('the cache key ignores the target SHA and the evidence binding never does', () => {
  const digests = scopeDigests(plan, checkout());
  // Two rounds, two SHAs, one checkout: different binding, identical node keys.
  assert.notEqual(binding.bindingDigest, nextBinding.bindingDigest);
  assert.equal(binding.targetSha, zeroTarget);
  assert.equal(nextBinding.targetSha, oneTarget);
  for (const node of plan.nodes) {
    assert.equal(
      nodeInputDigest({ plan, node, scopeDigests: digests, environmentDigest: binding.environmentDigest }),
      nodeInputDigest({ plan, node, scopeDigests: digests, environmentDigest: nextBinding.environmentDigest }),
      node.id,
    );
  }
  // The manifest and the publication still carry the exact target SHA of this round.
  const publish = read('scripts/outcome-reconciler-release-dag-publish.mjs');
  const aggregate = read('scripts/outcome-reconciler-release-dag-aggregate.mjs');
  for (const source of [publish, aggregate]) {
    assert.match(source, /targetSha: required\('OUTCOME_RELEASE_DAG_TARGET_SHA'\)/u);
    assert.match(source, /\.\.\.binding,/u);
  }
  assert.match(publish, /aggregate manifest has stale \$\{field\}/u);
  assert.equal(plan.target.ref, 'refs/heads/main');
  assert.equal(plan.target.remoteMustRemainExactlyTarget, true);
  // A re-admitted observation is named as one, with the round that made it.
  assert.match(publish, /observedTargetSha/u);
  assert.match(publish, /declares re-admission from the round it already belongs to/u);
});

test('a checkpoint survives its round by moving the same bytes, and says which round observed them', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'release-dag-checkpoints-'));
  try {
    const node = nodeById.get('full-swift');
    const storeRoot = path.join(fixture, 'checkpoints');
    const firstRunRoot = path.join(fixture, binding.bindingDigest);
    const secondRunRoot = path.join(fixture, nextBinding.bindingDigest);
    const declaredPath = 'build/outcome-reconciler-full-swift-manifest.json';
    const snapshot = path.join(firstRunRoot, 'artifacts', node.id, '00-manifest.json');
    const logPath = path.join(firstRunRoot, 'logs', `${node.id}.log`);
    mkdirSync(path.dirname(snapshot), { recursive: true });
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(snapshot, '{"tests":128}');
    writeFileSync(logPath, 'Executed 128 tests, with 0 failures\n');
    const artifacts = [{
      declaredPath,
      snapshotPath: snapshot,
      ...digest(snapshot),
    }];
    const log = { path: logPath, ...digest(logPath) };
    const observed = {
      schemaVersion: 1,
      nodeId: node.id,
      state: 'SUCCESS',
      exitCode: 0,
      reusable: true,
      inputDigest: baselineInputs.get(node.id).inputDigest,
      inputs: baselineInputs.get(node.id).inputs,
      commandDigest: commandDigest(node.command),
      startedAt: '2026-08-31T00:00:00.000Z',
      finishedAt: '2026-08-31T00:22:00.000Z',
      target: { ref: plan.target.ref, sha: zeroTarget, receiptDigest: targetReceiptDigest },
      binding,
      releaseAttempt: { token: 'first-round' },
      testCount: 128,
      artifacts,
      log,
      artifactDigest: sha256(canonical({ artifacts, log })),
    };

    const stored = writeCheckpoint({ repo: fixture, storeRoot, receipt: observed });
    assert.equal(stored.artifacts[0].sha256, observed.artifacts[0].sha256);
    const roundTripped = readCheckpoint({
      storeRoot, nodeId: node.id, inputDigest: observed.inputDigest,
    });
    assert.deepEqual(roundTripped, JSON.parse(JSON.stringify(stored)));

    // Round two: new commit, new binding, same Swift sources.
    const nextTarget = { ref: plan.target.ref, sha: oneTarget, receiptDigest: targetReceiptDigest };
    const readmitted = readmitCheckpoint({
      repo: fixture,
      receipt: roundTripped,
      node,
      binding: nextBinding,
      target: nextTarget,
      releaseAttempt: { token: 'second-round' },
      runRoot: secondRunRoot,
      logRoot: path.join(secondRunRoot, 'logs'),
    });
    // The observation itself is untouched, and it is bound to the round asking for it.
    assert.equal(readmitted.testCount, 128);
    assert.equal(readmitted.artifacts[0].sha256, observed.artifacts[0].sha256);
    assert.equal(readmitted.log.sha256, observed.log.sha256);
    assert.deepEqual(readmitted.target, nextTarget);
    assert.equal(readmitted.binding.bindingDigest, nextBinding.bindingDigest);
    assert.equal(readmitted.artifactDigest,
      sha256(canonical({ artifacts: readmitted.artifacts, log: readmitted.log })));
    // The bytes moved into this round and are byte-identical there.
    assert.equal(digest(path.resolve(fixture, readmitted.artifacts[0].snapshotPath)).sha256,
      observed.artifacts[0].sha256);
    assert.equal(readmitted.artifacts[0].declaredPath, declaredPath);
    // And the claim is named, not smoothed over.
    assert.equal(readmitted.reuse.observedTargetSha, zeroTarget);
    assert.equal(readmitted.reuse.observedBindingDigest, binding.bindingDigest);
    assert.equal(readmitted.reuse.inputDigest, observed.inputDigest);
    assert.equal(readmitted.reuse.sourceReceiptDigest, sha256(canonical(roundTripped)));

    // A node whose artifacts name their round is refused outright.
    assert.throws(() => readmitCheckpoint({
      repo: fixture,
      receipt: roundTripped,
      node: nodeById.get('prepare-build'),
      binding: nextBinding,
      target: nextTarget,
      releaseAttempt: { token: 'second-round' },
      runRoot: secondRunRoot,
      logRoot: path.join(secondRunRoot, 'logs'),
    }), /cannot be re-admitted into another/u);

    // Same round: nothing is moved and nothing is claimed.
    assert.equal(readmitCheckpoint({
      repo: fixture,
      receipt: roundTripped,
      node,
      binding,
      target: observed.target,
      releaseAttempt: observed.releaseAttempt,
      runRoot: firstRunRoot,
      logRoot: path.join(firstRunRoot, 'logs'),
    }), roundTripped);

    // A failed or unreusable observation never enters the store.
    assert.equal(writeCheckpoint({
      repo: fixture, storeRoot, receipt: { ...observed, state: 'FAILED', exitCode: 1 },
    }), null);
    assert.equal(writeCheckpoint({
      repo: fixture, storeRoot, receipt: { ...observed, inputDigest: null },
    }), null);

    // The store stays bounded: only the most recent input sets per node survive.
    for (const [index, seed] of ['a', 'b', 'c', 'd'].entries()) {
      writeCheckpoint({
        repo: fixture,
        storeRoot,
        receipt: { ...observed, inputDigest: sha256(seed), finishedAt: `2026-09-0${index + 1}T00:00:00.000Z` },
        keep: 3,
      });
    }
    assert.equal(readdirSync(path.join(storeRoot, node.id)).length, 3);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

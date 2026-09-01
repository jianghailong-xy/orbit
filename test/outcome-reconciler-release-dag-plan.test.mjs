import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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
  CASE_MISSING_RECEIPT,
  CASE_NO_TESTS,
  CASE_PASS,
  CASE_UNCLEAN,
  classifyCase,
  partitionConclusion,
  tapMetrics,
} from '../scripts/outcome-reconciler-release-dag-full-api-shard.mjs';
import {
  MAX_AUTOMATIC_RETRIES_PER_TERMINATION,
  ReleaseDagAdmissionError,
  TERMINATION_TYPES,
  calibratedFloorSeconds,
  canonical,
  checkpointReuseDecision,
  commandDigest,
  criticalPath,
  dagPlanDigest,
  deriveBinding,
  addResources,
  metricsForNode,
  nodeInputDigest,
  nodeInputDigests,
  resourceFits,
  resumeProjection,
  retryDecision,
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

// The case receipt step is where a case's conclusion is actually decided during a release run. The
// shard fixtures above stage receipts directly, so they would stay green if this step regressed to
// throwing before it wrote one -- and a case with no receipt is exactly the case that cannot appear
// in any shard report. That regression is what made `tests=0` indistinguishable from a real
// failure, so it is asserted here against the real step rather than against a staged artifact.
test('the case receipt step records a typed conclusion instead of throwing one away', (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'orbit-full-api-receipt-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const specPath = path.join(fixture, 'case.spec.js');
  writeFileSync(specPath, '// a Full API spec\n');

  const runReceipt = ({ caseIndex, tap, exitCode, cleanupCode }) => {
    const tapPath = path.join(fixture, `${caseIndex}.tap`);
    const output = path.join(fixture, `${caseIndex}.json`);
    writeFileSync(tapPath, tap);
    const identity = fullApiCaseIdentity({
      bindingDigest: shardBinding,
      attemptToken: shardAttempt,
      partitionClass: 'serial',
      partitionIndex: 0,
      caseIndex,
    });
    const step = spawnSync(process.execPath, [
      path.join(repo, 'scripts/outcome-reconciler-release-dag-step.mjs'), 'full-api-case-receipt',
      output, String(caseIndex), specPath, 'serial', '0',
      identity.database, identity.emptyDatabase, identity.role,
      identity.database, identity.role, '13',
      tapPath, String(exitCode), String(cleanupCode),
    ], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        OUTCOME_RELEASE_DAG_TARGET_SHA: zeroTarget,
        OUTCOME_RELEASE_DAG_TARGET_RECEIPT_DIGEST: targetReceiptDigest,
        OUTCOME_RELEASE_DAG_ENVIRONMENT_DIGEST: '3'.repeat(64),
        OUTCOME_RELEASE_DAG_EVALUATION_PLAN_DIGEST: '4'.repeat(64),
        OUTCOME_RELEASE_DAG_PLAN_DIGEST: '5'.repeat(64),
        OUTCOME_RELEASE_DAG_EVIDENCE_CUT_DIGEST: '6'.repeat(64),
        OUTCOME_RELEASE_DAG_BINDING_DIGEST: shardBinding,
        OUTCOME_RELEASE_DAG_ATTEMPT_DIGEST: 'f'.repeat(64),
        OUTCOME_RELEASE_DAG_ATTEMPT_TOKEN: shardAttempt,
      },
    });
    // The receipt has to exist whatever the conclusion was: that is what lets the shard report it.
    assert.ok(existsSync(output), `case ${caseIndex} produced no receipt`);
    return { status: step.status, receipt: JSON.parse(readFileSync(output, 'utf8')) };
  };

  const passed = runReceipt({
    caseIndex: 1, tap: passingCaseTap('clean'), exitCode: 0, cleanupCode: 0,
  });
  const timedOut = runReceipt({ caseIndex: 2, tap: timedOutTap, exitCode: 124, cleanupCode: 0 });
  const failed = runReceipt({ caseIndex: 3, tap: undefinedTableTap, exitCode: 1, cleanupCode: 0 });
  const unclean = runReceipt({
    caseIndex: 4, tap: passingCaseTap('leaky'), exitCode: 0, cleanupCode: 1,
  });

  // Four different facts, four different conclusions -- not one collapsed "the case failed".
  assert.equal(passed.receipt.outcome, CASE_PASS);
  assert.equal(timedOut.receipt.outcome, CASE_NO_TESTS);
  assert.equal(failed.receipt.outcome, CASE_FAILED_TESTS);
  assert.equal(unclean.receipt.outcome, CASE_UNCLEAN);
  assert.notEqual(timedOut.receipt.outcome, failed.receipt.outcome);

  // Nothing is forgiven: every non-PASS conclusion still fails the case, and through it the shard.
  assert.equal(passed.status, 0);
  for (const observed of [timedOut, failed, unclean]) assert.equal(observed.status, 1);

  // A failing case stays locatable, and a dirty database is still reported as a surviving resource.
  assert.equal(passed.receipt.diagnostic, '');
  assert.match(failed.receipt.diagnostic, /42P01/u);
  for (const observed of [timedOut, failed, unclean]) {
    assert.ok(observed.receipt.diagnostic.length > 0);
  }
  assert.equal(passed.receipt.cleanup.resourcesRemaining, 0);
  assert.equal(unclean.receipt.cleanup.resourcesRemaining, 1);
  assert.equal(timedOut.receipt.summary.tests, 0);
  assert.ok(failed.receipt.summary.tests > 0);
});

test('a case that leaves no receipt is a distinct fact and does not stop the shard', (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'orbit-full-api-no-receipt-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const cases = [1, 2, 3].map((caseIndex) => ({
    caseIndex,
    spec: `src/apiserver/build/sessions/case-${caseIndex}.spec.js`,
    tap: passingCaseTap(`case ${caseIndex}`),
    exitCode: 0,
  }));
  const { caseRoot, caseScript, executedLog, inventoryPath } = stageShardFixture(fixture, cases);
  // Case 2 dies hard: no receipt, and on a real host no TAP either.
  rmSync(path.join(caseRoot, '0002.json'));
  rmSync(path.join(caseRoot, '0002.tap'));
  writeFileSync(path.join(caseRoot, '0002.exit'), '134');
  const resultsPath = path.join(fixture, 'results.json');
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
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const executed = readFileSync(executedLog, 'utf8').trim().split('\n').map(Number);
  const outcomeOf = (caseIndex) => results.results
    .find((entry) => entry.caseIndex === caseIndex).outcome;

  // "It never reported a receipt" is its own conclusion, distinct from both of the others.
  assert.equal(outcomeOf(2), CASE_MISSING_RECEIPT);
  assert.notEqual(outcomeOf(2), CASE_NO_TESTS);
  assert.notEqual(outcomeOf(2), CASE_FAILED_TESTS);
  // The shard kept going and still failed.
  assert.deepEqual(executed, [1, 2, 3]);
  assert.equal(results.executedCases, 3);
  assert.equal(outcomeOf(1), CASE_PASS);
  assert.equal(outcomeOf(3), CASE_PASS);
  assert.equal(results.outcome, 'FAILED');
  assert.equal(driven.status, 1);
  // A case with no receipt proves no cleanup, so it is counted as a resource left behind rather
  // than silently treated as clean.
  assert.notEqual(results.isolation.resourcesRemaining, 0);
  assert.equal(results.isolation.uniqueDatabases, false);
});

test('a shard that leaves a database behind fails even when every test passed', () => {
  const partition = { class: 'serial', index: 0, count: 1 };
  const clean = [1, 2].map((caseIndex) => ({
    caseIndex,
    spec: `case-${caseIndex}.spec.js`,
    outcome: CASE_PASS,
    exitCode: 0,
    summary: tapMetrics(passingCaseTap(`case ${caseIndex}`)),
    database: `pccrd_x_c${caseIndex}_d`,
    role: `pccrd_x_c${caseIndex}_u`,
    resourcesRemaining: 0,
  }));
  assert.equal(partitionConclusion({
    partition, declaredCases: 2, results: clean,
  }).outcome, 'PASS');

  // One surviving database is enough to fail the shard: it is what poisons whatever runs next.
  const leaky = [clean[0], { ...clean[1], resourcesRemaining: 1 }];
  const leakyConclusion = partitionConclusion({ partition, declaredCases: 2, results: leaky });
  assert.equal(leakyConclusion.outcome, 'FAILED');
  assert.equal(leakyConclusion.isolation.resourcesRemaining, 1);

  // So is two cases sharing one database, and so is a case that never ran at all.
  const shared = [clean[0], { ...clean[1], database: clean[0].database }];
  assert.equal(partitionConclusion({
    partition, declaredCases: 2, results: shared,
  }).outcome, 'FAILED');
  assert.equal(partitionConclusion({
    partition, declaredCases: 2, results: [clean[0]],
  }).outcome, 'FAILED');
});

// ---------------------------------------------------------------------------
// Critical-path feasibility admission.
//
// Before this gate the contract declared 7440s of node timeouts along its longest chain
// against a 3540s scheduler deadline -- 110% over budget -- and validatePlan admitted it,
// because it only ever asked whether each node was individually bounded. A run that cannot
// fit is not a run that fails slowly; it is one that should never have been started.

// Re-derive the digest so a mutated fixture is rejected for the reason under test rather
// than for being stale.
function sealed(mutate) {
  const draft = JSON.parse(JSON.stringify(plan));
  mutate(draft);
  delete draft.declaredDagPlanDigest;
  draft.declaredDagPlanDigest = dagPlanDigest(draft);
  return draft;
}

function admissionError(candidate) {
  try {
    validatePlan(candidate);
  } catch (error) {
    return error;
  }
  return null;
}

// The node the critical path runs through, so raising it raises the path by exactly as much.
const CRITICAL_LEAF = 'publish-evidence-cut';

test('(a)(b) an infeasible critical path is refused, typed, before anything is spawned', () => {
  const feasible = criticalPath(plan);
  const overBy = 600;
  const infeasible = sealed((draft) => {
    const leaf = draft.nodes.find((node) => node.id === CRITICAL_LEAF);
    leaf.timeoutSeconds += (plan.evaluator.schedulerDeadlineSeconds - feasible.seconds) + overBy;
  });

  const error = admissionError(infeasible);
  assert.ok(error instanceof ReleaseDagAdmissionError, 'the refusal is not a typed admission error');
  assert.equal(error.code, 'RELEASE_DAG_CRITICAL_PATH_EXCEEDS_SCHEDULER_DEADLINE');

  // (b) The refusal names the offending path and the exact overshoot -- both as structured
  // fields and in the message, because a human reads one and a caller branches on the other.
  assert.equal(error.excessSeconds, overBy);
  assert.equal(error.schedulerDeadlineSeconds, plan.evaluator.schedulerDeadlineSeconds);
  assert.equal(error.criticalPathSeconds,
    plan.evaluator.schedulerDeadlineSeconds + overBy);
  assert.deepEqual(error.criticalPath, feasible.path);
  assert.equal(error.criticalPath.at(0), 'preflight-binding');
  assert.equal(error.criticalPath.at(-1), CRITICAL_LEAF);
  assert.ok(error.message.includes(feasible.path.join(' -> ')),
    'the message omits the node sequence that overran');
  assert.match(error.message, new RegExp(`exceeds the scheduler deadline by ${overBy}s`, 'u'));

  // (a) And it costs nothing: the runner refuses in validatePlan, which is reached before
  // the target is resolved, before any node is spawned and before a receipt root exists.
  const fixture = mkdtempSync(path.join(tmpdir(), 'orbit-release-dag-admission-'));
  try {
    const planFile = path.join(fixture, 'infeasible-plan.json');
    const stateRoot = path.join(fixture, 'state');
    const shims = path.join(fixture, 'shims');
    const spawnLog = path.join(fixture, 'spawned.log');
    mkdirSync(shims, { recursive: true });
    // Anything the runner shells out to lands in this log. The shims record and refuse
    // rather than exec, so the control below observes the spawn without a real fetch.
    for (const tool of ['git', 'docker', 'npm']) {
      writeFileSync(path.join(shims, tool),
        `#!/bin/sh\necho "${tool} $*" >> ${JSON.stringify(spawnLog)}\nexit 1\n`);
      chmodSync(path.join(shims, tool), 0o755);
    }
    writeFileSync(planFile, `${JSON.stringify(infeasible, null, 2)}\n`);
    const env = {
      ...process.env,
      PATH: `${shims}${path.delimiter}${process.env.PATH}`,
      OUTCOME_RELEASE_DAG_PLAN: planFile,
      OUTCOME_RELEASE_DAG_STATE_ROOT: stateRoot,
    };
    const refused = spawnSync(process.execPath,
      [path.join(repo, 'scripts/outcome-reconciler-release-dag.mjs')],
      { cwd: repo, encoding: 'utf8', env, timeout: 120_000 });
    assert.notEqual(refused.status, 0, 'an infeasible plan was admitted');
    assert.match(refused.stderr, /RELEASE_DAG_CRITICAL_PATH_EXCEEDS_SCHEDULER_DEADLINE/u);
    assert.equal(existsSync(spawnLog), false, 'the refused plan still spawned a subprocess');
    assert.equal(existsSync(stateRoot), false, 'the refused plan still created a receipt root');

    // The negative control: the log stays empty above because nothing ran, not because the
    // shims are inert. The same runner on the same PATH, given the feasible plan, gets past
    // admission and reaches for git on its very next step.
    writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    const admitted = spawnSync(process.execPath,
      [path.join(repo, 'scripts/outcome-reconciler-release-dag.mjs'), '--print-binding'],
      { cwd: repo, encoding: 'utf8', env, timeout: 120_000 });
    assert.equal(existsSync(spawnLog), true, 'the shims never recorded anything, so they prove nothing');
    assert.match(readFileSync(spawnLog, 'utf8'), /^git fetch /mu);
    assert.doesNotMatch(admitted.stderr, /RELEASE_DAG_CRITICAL_PATH_EXCEEDS_SCHEDULER_DEADLINE/u,
      'the feasible plan was refused by the critical-path gate');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('(c) a critical path exactly equal to the scheduler deadline is admitted', () => {
  const slack = plan.evaluator.schedulerDeadlineSeconds - criticalPath(plan).seconds;
  assert.ok(slack >= 0, 'the shipped plan is already over budget');
  const exact = sealed((draft) => {
    draft.nodes.find((node) => node.id === CRITICAL_LEAF).timeoutSeconds += slack;
  });
  assert.equal(criticalPath(exact).seconds, plan.evaluator.schedulerDeadlineSeconds);
  assert.doesNotThrow(() => validatePlan(exact), 'the boundary case was refused');

  // One second past the boundary is the first refusal: the gate is `>`, not `>=`.
  const overByOne = sealed((draft) => {
    draft.nodes.find((node) => node.id === CRITICAL_LEAF).timeoutSeconds += slack + 1;
  });
  const error = admissionError(overByOne);
  assert.equal(error.code, 'RELEASE_DAG_CRITICAL_PATH_EXCEEDS_SCHEDULER_DEADLINE');
  assert.equal(error.excessSeconds, 1);
});

test('(d)(f) the shipped contract itself passes the new admission with a measured path', () => {
  // Not a fixture: the file the release actually runs. A gate the production plan cannot
  // pass is a welded door, and this assertion is what stops one from being shipped.
  const shipped = JSON.parse(
    readFileSync(path.join(repo, 'contracts/outcome-reconciler-release-dag.json'), 'utf8'),
  );
  assert.deepEqual(shipped, plan, 'this test must read the real contract, never a copy');
  const result = validatePlan(shipped);

  const longest = criticalPath(shipped);
  assert.equal(longest.seconds, 3440);
  assert.equal(shipped.evaluator.schedulerDeadlineSeconds, 3540);
  assert.ok(longest.seconds <= shipped.evaluator.schedulerDeadlineSeconds,
    `critical path ${longest.seconds}s exceeds the ${shipped.evaluator.schedulerDeadlineSeconds}s deadline`);
  assert.deepEqual(result.criticalPath, longest);
  assert.deepEqual(longest.path, [
    'preflight-binding', 'prepare-dependencies', 'prepare-prisma', 'prepare-build',
    'full-api-inventory', 'full-api-shard-0', 'full-api-serial', 'full-api',
    'manifest-aggregate', 'release-live-state-boundary', 'publish-evidence-cut',
  ]);

  // The path is a real longest chain: every node's timeout is on it exactly once, in
  // dependency order, and it sums to the reported total.
  assert.equal(new Set(longest.path).size, longest.path.length);
  assert.equal(
    longest.path.reduce((total, id) => total + nodeById.get(id).timeoutSeconds, 0),
    longest.seconds,
  );
  for (let index = 1; index < longest.path.length; index += 1) {
    assert.ok(nodeById.get(longest.path[index]).dependsOn.includes(longest.path[index - 1]),
      `${longest.path[index]} does not depend on ${longest.path[index - 1]}`);
  }

  // The calibration is what bought the headroom, and it is 110% -- not a relaxed deadline.
  assert.equal(shipped.nodes.reduce((total, node) => total + node.timeoutSeconds, 0), 14110);
});

test('(e) every node timeout clears its observed maximum times the declared margin', () => {
  const calibration = plan.timeoutCalibration;
  assert.equal(calibration.schemaVersion, 1);
  assert.equal(calibration.source, 'RELEASE_DAG_NODE_RECEIPT_DURATIONS');
  assert.equal(calibration.marginFactor, 2);
  assert.equal(calibration.minimumTimeoutSeconds, 60);
  // A run killed by its own timeout never said how long it needed. Calibrating on one would
  // ratchet the budget up every time the host was starved -- which is what retry is for.
  assert.equal(calibration.completedTerminationsOnly, true);

  const observed = calibration.observedMaximumSeconds;
  assert.equal(Object.keys(observed).length, 42);
  for (const [id, seconds] of Object.entries(observed)) {
    assert.ok(nodeById.has(id), `${id} is calibrated but is not a node`);
    assert.ok(Number.isInteger(seconds) && seconds >= 1, id);
    const required = Math.ceil(seconds * calibration.marginFactor);
    assert.equal(calibratedFloorSeconds(plan, id), required);
    assert.ok(nodeById.get(id).timeoutSeconds >= required,
      `${id} declares ${nodeById.get(id).timeoutSeconds}s, below its ${required}s calibrated floor`);
    assert.ok(nodeById.get(id).timeoutSeconds >= calibration.minimumTimeoutSeconds, id);
  }

  // Only nodes the DAG has never completed are exempt, and they are named rather than
  // silently uncalibrated.
  const uncalibrated = plan.nodes.map((node) => node.id).filter((id) => observed[id] === undefined);
  assert.deepEqual(uncalibrated.sort(), [...calibration.unobservedNodes].sort());
  assert.deepEqual(calibration.unobservedNodes,
    ['manifest-aggregate', 'publish-evidence-cut', 'release-live-state-boundary']);
  for (const id of calibration.unobservedNodes) assert.equal(calibratedFloorSeconds(plan, id), null);

  // The floor is enforced by admission, not just asserted here: a node trimmed below its
  // observed maximum is refused with the node named.
  const trimmed = sealed((draft) => {
    draft.nodes.find((node) => node.id === 'full-api-shard-0').timeoutSeconds = 1000;
  });
  const error = admissionError(trimmed);
  assert.equal(error.code, 'RELEASE_DAG_NODE_TIMEOUT_BELOW_CALIBRATED_FLOOR');
  assert.equal(error.nodeId, 'full-api-shard-0');
  assert.equal(error.observedMaximumSeconds, 926);
  assert.equal(error.requiredSeconds, 1852);
  assert.equal(error.declaredSeconds, 1000);

  // And a calibration that names a node the DAG does not have is itself refused.
  assert.equal(admissionError(sealed((draft) => {
    draft.timeoutCalibration.observedMaximumSeconds['no-such-node'] = 10;
  })).code, 'RELEASE_DAG_TIMEOUT_CALIBRATION_INCOMPLETE');
  assert.equal(admissionError(sealed((draft) => {
    draft.timeoutCalibration.completedTerminationsOnly = false;
  })).code, 'RELEASE_DAG_TIMEOUT_CALIBRATION_INCOMPLETE');
});

// ---------------------------------------------------------------------------
// Retry budgets, declared per termination type.

const INFRASTRUCTURE_TERMINATIONS = ['INFRASTRUCTURE_LOST', 'TIMED_OUT', 'SIGNALED', 'START_FAILED'];

// The two attempts that motivated this, to scale: 2026-08-31, one hour each, zero bytes out.
const STARVED_ATTEMPT = { terminalState: 'INFRASTRUCTURE_LOST', outputBytes: 0, elapsedSeconds: 3600 };

test('(g) an EXITED attempt with the wrong exit code is never retried automatically', () => {
  assert.equal(plan.evaluator.retryBudgets.byTerminationType.EXITED, 0);

  const decision = retryDecision({
    plan,
    terminations: [{ terminalState: 'EXITED', actualExitCode: 1 }],
  });
  assert.equal(decision.decision, 'STOP');
  assert.equal(decision.reasonCode, 'TERMINATION_TYPE_NOT_RETRYABLE');
  assert.equal(decision.terminalState, 'EXITED');
  assert.equal(decision.budget, 0);
  assert.equal(decision.retriesUsed, 0);

  // Not even once, and not after an infrastructure retry has already happened: the moment
  // the command actually ran, its exit code is the answer. Retrying it would turn one
  // criterion into best-of-N, which is the dilution this budget exists to prevent.
  assert.equal(retryDecision({
    plan,
    terminations: [STARVED_ATTEMPT, { terminalState: 'EXITED', actualExitCode: 7 }],
  }).decision, 'STOP');

  // A zero budget cannot be written into the contract either.
  const permissive = sealed((draft) => {
    draft.evaluator.retryBudgets.byTerminationType.EXITED = 1;
  });
  const error = admissionError(permissive);
  assert.equal(error.code, 'RELEASE_DAG_EXITED_RETRY_BUDGET_MUST_BE_ZERO');
  assert.equal(error.declared, 1);
});

test('(h)(i) every non-EXITED termination retries inside its declared budget', () => {
  const budgets = plan.evaluator.retryBudgets.byTerminationType;
  for (const terminalState of INFRASTRUCTURE_TERMINATIONS) {
    assert.ok(budgets[terminalState] >= 1, `${terminalState} has no retry budget`);
    const decision = retryDecision({ plan, terminations: [{ terminalState }] });
    assert.equal(decision.decision, 'RETRY', terminalState);
    assert.equal(decision.reasonCode, 'TYPED_INFRASTRUCTURE_TERMINATION_RETRYABLE');
    assert.equal(decision.terminalState, terminalState);
    assert.equal(decision.retryIndex, 1);
    assert.equal(decision.budget, budgets[terminalState]);

    // (h) The retry is not a bypass: admission is re-run and its verdict is reported, so a
    // caller can check that it happened instead of trusting that it did.
    assert.equal(decision.admission.outcome, 'ADMITTED');
    assert.equal(decision.admission.revalidated, true);
    assert.equal(decision.admission.criticalPathSeconds, criticalPath(plan).seconds);
    assert.equal(decision.admission.schedulerDeadlineSeconds,
      plan.evaluator.schedulerDeadlineSeconds);
  }

  // And the admission is load-bearing: against a plan that no longer fits, the very same
  // retryable termination stops instead of retrying. A bypass would still say RETRY.
  const infeasible = sealed((draft) => {
    draft.nodes.find((node) => node.id === CRITICAL_LEAF).timeoutSeconds
      += (plan.evaluator.schedulerDeadlineSeconds - criticalPath(plan).seconds) + 1;
  });
  const refused = retryDecision({ plan: infeasible, terminations: [STARVED_ATTEMPT] });
  assert.equal(refused.decision, 'STOP');
  assert.equal(refused.reasonCode, 'ADMISSION_REJECTED');
  assert.equal(refused.admission.outcome, 'REJECTED');
  assert.equal(refused.admission.revalidated, true);
  assert.equal(refused.admission.code, 'RELEASE_DAG_CRITICAL_PATH_EXCEEDS_SCHEDULER_DEADLINE');
});

test('(j) the retry budget is a real bound and its exhaustion is typed', () => {
  const budgets = plan.evaluator.retryBudgets;
  for (const terminalState of INFRASTRUCTURE_TERMINATIONS) {
    const budget = budgets.byTerminationType[terminalState];
    const history = [];
    for (let attempt = 1; attempt <= budget; attempt += 1) {
      history.push({ terminalState });
      assert.equal(retryDecision({ plan, terminations: [...history] }).decision, 'RETRY',
        `${terminalState} stopped retrying at attempt ${attempt} of ${budget}`);
    }
    history.push({ terminalState });
    const exhausted = retryDecision({ plan, terminations: history });
    assert.equal(exhausted.decision, 'STOP', terminalState);
    assert.equal(exhausted.reasonCode, 'RETRY_BUDGET_EXHAUSTED');
    assert.equal(exhausted.consumedForTerminationType, budget + 1);
    assert.equal(exhausted.retriesUsed, budget);
  }

  // Mixed types cannot add up past the total ceiling either -- otherwise a run could rotate
  // through the types forever, one budget at a time.
  assert.equal(budgets.maxTotalAutomaticRetries, 3);
  const rotated = ['INFRASTRUCTURE_LOST', 'START_FAILED', 'TIMED_OUT', 'SIGNALED']
    .map((terminalState) => ({ terminalState }));
  const ceiling = retryDecision({ plan, terminations: rotated });
  assert.equal(ceiling.decision, 'STOP');
  assert.equal(ceiling.reasonCode, 'TOTAL_RETRY_CEILING_REACHED');
  assert.equal(ceiling.retriesUsed, 3);

  // Whatever the history, the sequence terminates: no input makes it retry forever.
  let history = [];
  let steps = 0;
  for (;;) {
    history = [...history, STARVED_ATTEMPT];
    const decision = retryDecision({ plan, terminations: history });
    if (decision.decision === 'STOP') break;
    steps += 1;
    assert.ok(steps <= budgets.maxTotalAutomaticRetries, 'the retry loop is unbounded');
  }
  assert.equal(steps, budgets.byTerminationType.INFRASTRUCTURE_LOST);

  // The contract cannot declare an unbounded ceiling, or a per-type budget above the cap.
  assert.equal(MAX_AUTOMATIC_RETRIES_PER_TERMINATION, 3);
  assert.equal(admissionError(sealed((draft) => {
    draft.evaluator.retryBudgets.byTerminationType.INFRASTRUCTURE_LOST = 4;
  })).code, 'RELEASE_DAG_RETRY_BUDGETS_INCOMPLETE');
  assert.equal(admissionError(sealed((draft) => {
    draft.evaluator.retryBudgets.maxTotalAutomaticRetries = 99;
  })).code, 'RELEASE_DAG_RETRY_CEILING_UNBOUNDED');
  assert.equal(admissionError(sealed((draft) => {
    delete draft.evaluator.retryBudgets.byTerminationType.SIGNALED;
  })).code, 'RELEASE_DAG_RETRY_BUDGETS_INCOMPLETE');
  // Untyped retry stays banned: the budget must be asked for by termination type.
  assert.throws(() => validatePlan(sealed((draft) => { draft.evaluator.automaticRetries = 1; })),
    /may not retry in place/u);
});

test('(k) retries and the type that caused each one are visible on the attempt record', () => {
  const budgets = plan.evaluator.retryBudgets;
  assert.equal(budgets.observability,
    'PER_ATTEMPT_TERMINATION_TYPE_RECORDED_ON_THE_ATTEMPT_MANIFEST');
  assert.equal(budgets.admissionOnRetry, 'FULL_PLAN_REVALIDATION');
  assert.deepEqual(Object.keys(budgets.byTerminationType).sort(), [...TERMINATION_TYPES].sort());

  // Every decision carries the whole history, typed and indexed -- not just a count.
  const history = [
    STARVED_ATTEMPT,
    { terminalState: 'TIMED_OUT' },
    { terminalState: 'EXITED', actualExitCode: 3 },
  ];
  const decision = retryDecision({ plan, terminations: history });
  assert.deepEqual(decision.observedTerminations, [
    { attemptIndex: 0, terminalState: 'INFRASTRUCTURE_LOST', actualExitCode: null },
    { attemptIndex: 1, terminalState: 'TIMED_OUT', actualExitCode: null },
    { attemptIndex: 2, terminalState: 'EXITED', actualExitCode: 3 },
  ]);
  assert.equal(decision.retriesUsed, 2);
  assert.throws(() => retryDecision({ plan, terminations: [{ terminalState: 'WEDGED' }] }),
    /unknown attempt termination type: WEDGED/u);

  // The runner writes the same facts onto attempt.json, and the publication carries the
  // declared budgets alongside the evidence cut.
  const runner = read('scripts/outcome-reconciler-release-dag.mjs');
  assert.match(runner, /retryIndex: priorTerminations\.length/u);
  assert.match(runner, /priorTerminations,/u);
  assert.match(runner, /OUTCOME_RELEASE_DAG_PRIOR_TERMINATIONS/u);
  assert.match(runner,
    /priorTerminations\.length <= plan\.evaluator\.retryBudgets\.maxTotalAutomaticRetries/u);
  assert.match(read('scripts/outcome-reconciler-release-dag-publish.mjs'),
    /retryBudgets: plan\.evaluator\.retryBudgets,/u);
});

test('the two starved hour-long attempts of 2026-08-31 now retry instead of spending a quota', () => {
  // a04bd84d 08:33:44 -> 09:33:55 and e7c287ae 09:12:45 -> 10:12:58: INFRASTRUCTURE_LOST,
  // zero bytes of output, the full 3600s deadline each, on a host with 0-3 GiB free and a
  // load average of 101. Under automaticRetries: 0 they were two formal attempts spent on
  // nothing. Neither produced evidence, so neither retry can dilute any.
  const attempts = [
    { attemptId: 'a04bd84d', ...STARVED_ATTEMPT },
    { attemptId: 'e7c287ae', ...STARVED_ATTEMPT },
  ];
  for (const attempt of attempts) {
    assert.equal(attempt.outputBytes, 0);
    assert.equal(attempt.elapsedSeconds, plan.evaluator.attemptTimeoutSeconds);
  }

  const first = retryDecision({ plan, terminations: attempts.slice(0, 1) });
  assert.equal(first.decision, 'RETRY');
  assert.equal(first.retryIndex, 1);
  assert.equal(first.admission.outcome, 'ADMITTED');

  const second = retryDecision({ plan, terminations: attempts });
  assert.equal(second.decision, 'RETRY');
  assert.equal(second.retryIndex, 2);
  assert.equal(second.consumedForTerminationType, 2);
  assert.deepEqual(second.observedTerminations.map((entry) => entry.terminalState),
    ['INFRASTRUCTURE_LOST', 'INFRASTRUCTURE_LOST']);

  // A third starved hour is where the bound bites: still typed, still not an EXITED verdict.
  const third = retryDecision({ plan, terminations: [...attempts, STARVED_ATTEMPT] });
  assert.equal(third.decision, 'STOP');
  assert.equal(third.reasonCode, 'RETRY_BUDGET_EXHAUSTED');
  assert.equal(third.terminalState, 'INFRASTRUCTURE_LOST');
});

test('(j)(k) an attempt past the retry ceiling is refused at admission, before it costs an hour', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'orbit-release-dag-retry-'));
  try {
    const stateRoot = path.join(fixture, 'state');
    const shims = path.join(fixture, 'shims');
    const spawnLog = path.join(fixture, 'spawned.log');
    mkdirSync(shims, { recursive: true });
    for (const tool of ['git', 'docker', 'npm']) {
      writeFileSync(path.join(shims, tool),
        `#!/bin/sh\necho "${tool} $*" >> ${JSON.stringify(spawnLog)}\nexec /usr/bin/env ${tool} "$@"\n`);
      chmodSync(path.join(shims, tool), 0o755);
    }
    const run = (priorTerminations) => spawnSync(process.execPath,
      [path.join(repo, 'scripts/outcome-reconciler-release-dag.mjs')],
      {
        cwd: repo,
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          PATH: `${shims}${path.delimiter}${process.env.PATH}`,
          OUTCOME_RELEASE_DAG_STATE_ROOT: stateRoot,
          OUTCOME_RELEASE_DAG_PRIOR_TERMINATIONS: priorTerminations,
        },
      });

    // One retry past the declared ceiling: refused where the plan's own feasibility is
    // checked, so an over-budget retry burns nothing.
    const over = new Array(plan.evaluator.retryBudgets.maxTotalAutomaticRetries + 1)
      .fill('INFRASTRUCTURE_LOST').join(',');
    const refused = run(over);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /past the declared automatic retry ceiling/u);
    assert.equal(existsSync(spawnLog), false, 'an over-ceiling retry still spawned something');
    assert.equal(existsSync(stateRoot), false, 'an over-ceiling retry still created a receipt root');

    // An untyped termination is refused the same way rather than silently counted.
    const untyped = run('WEDGED');
    assert.notEqual(untyped.status, 0);
    assert.match(untyped.stderr, /must be one of the declared termination types/u);
    assert.equal(existsSync(spawnLog), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
// Structural gate versus formal gate.
//
// "Is this checkout the published target?" is a precondition of RUNNING the Release DAG, not of
// checking that the plan file is well formed. While the structural gate asked it too, that gate
// was unpassable for every task that produced a commit (HEAD then necessarily differs from
// origin/main) and unpassable again whenever main merely advanced. The tests below pin both
// halves at once: the structural gate must stay decidable inside an ordinary worktree, and the
// formal path must still refuse anything that is not the exact frozen target.
//
// The formal-path assertions drive the real scripts/outcome-reconciler-release-dag.mjs with git
// and docker replaced by recording shims, so they observe the shipped guards rather than a
// restatement of them. Every one of them makes a target assertion fail, so resolveTarget() always
// aborts and no node is ever scheduled.
// ---------------------------------------------------------------------------

const gateShell = read('scripts/outcome-reconciler-release-dag-plan.sh');
const gateBody = gateShell
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');
const gateSteps = gateShell
  .replace(/\\\r?\n\s*/gu, ' ')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('timeout '));
const runnerSource = read('scripts/outcome-reconciler-release-dag.mjs');
const realGit = process.env.ORBIT_SHIM_REAL_GIT
  || execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const divergentSha = 'd'.repeat(40);

const GIT_SHIM = `#!/usr/bin/env bash
set -uo pipefail
{ printf '%s ' "\$@"; printf '\\n'; } >>"\$ORBIT_SHIM_LOG"
case "\${1-}" in
  fetch) exit 0 ;;
  rev-parse)
    if [ "\${2-}" = 'HEAD' ] && [ -n "\${ORBIT_SHIM_HEAD-}" ]; then
      printf '%s\\n' "\$ORBIT_SHIM_HEAD"; exit 0
    fi
    if [ "\${2-}" = 'refs/remotes/origin/main' ] && [ -n "\${ORBIT_SHIM_TRACKING-}" ]; then
      printf '%s\\n' "\$ORBIT_SHIM_TRACKING"; exit 0
    fi
    ;;
  ls-remote)
    if [ -n "\${ORBIT_SHIM_REMOTE-}" ]; then
      printf '%s\\trefs/heads/main\\n' "\$ORBIT_SHIM_REMOTE"; exit 0
    fi
    ;;
  status)
    if [ -n "\${ORBIT_SHIM_STATUS_SET-}" ]; then
      printf '%s\\n' "\${ORBIT_SHIM_STATUS-}"; exit 0
    fi
    ;;
esac
exec "\$ORBIT_SHIM_REAL_GIT" "\$@"
`;

const DOCKER_SHIM = `#!/usr/bin/env bash
set -uo pipefail
{ printf '%s ' "\$@"; printf '\\n'; } >>"\$ORBIT_SHIM_LOG"
if [ "\${1-}" = 'exec' ]; then printf '%s' "\${ORBIT_SHIM_RECEIPT-}"; exit 0; fi
printf 'release DAG plan test shim refuses docker %s\\n' "\${1-}" >&2
exit 1
`;

function runShimmed(command, args, overrides) {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'orbit-release-dag-shim-'));
  try {
    const log = path.join(sandbox, 'invocations.log');
    writeFileSync(log, '');
    writeFileSync(path.join(sandbox, 'git'), GIT_SHIM, { mode: 0o755 });
    writeFileSync(path.join(sandbox, 'docker'), DOCKER_SHIM, { mode: 0o755 });
    const childEnv = {
      ...process.env,
      OUTCOME_RELEASE_DAG_TARGET_SHA: '',
      ORBIT_SHIM_HEAD: '',
      ORBIT_SHIM_TRACKING: '',
      ORBIT_SHIM_REMOTE: '',
      ORBIT_SHIM_STATUS_SET: '',
      ORBIT_SHIM_STATUS: '',
      ORBIT_SHIM_RECEIPT: '',
      ...overrides,
      PATH: `${sandbox}${path.delimiter}${process.env.PATH}`,
      ORBIT_SHIM_LOG: log,
      ORBIT_SHIM_REAL_GIT: realGit,
    };
    // node:test marks its own children, and an inherited mark makes a nested `node --test`
    // report to a parent runner that is not listening instead of writing TAP to stdout.
    for (const name of Object.keys(childEnv)) {
      if (name.startsWith('NODE_TEST_')) delete childEnv[name];
    }
    const result = spawnSync(command, args, {
      cwd: repo,
      encoding: 'utf8',
      timeout: 300_000,
      env: childEnv,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      log: readFileSync(log, 'utf8'),
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function refusedRelease(overrides) {
  const refusal = runShimmed('node', ['scripts/outcome-reconciler-release-dag.mjs'], overrides);
  assert.notEqual(refusal.status, 0, `the formal Release DAG admitted a rejected target\n${refusal.stdout}`);
  assert.doesNotMatch(refusal.stdout, /==> release-dag: /u, 'a node was scheduled after a refusal');
  return refusal;
}

function receiptRow(fields) {
  const required = plan.target.requiredReceipt;
  return [
    '00000000-0000-4000-8000-000000000000',
    'MERGED',
    required.sourceBranch,
    fields.sourceSha,
    required.targetBranch,
    fields.targetShaBefore,
    fields.targetShaAfter,
    required.recordedBy,
    '2026-08-31 00:00:00+00',
  ].join('\t');
}

test('the structural regression gate is exactly --check-plan plus the plan regression', () => {
  assert.equal(gateSteps.length, 2, `the structural gate runs ${gateSteps.length} steps:\n${gateShell}`);
  assert.match(gateSteps[0], /outcome-reconciler-release-dag\.mjs" --check-plan\b/u);
  assert.match(gateSteps[1], /test\/outcome-reconciler-release-dag-plan\.test\.mjs"$/u);
  assert.doesNotMatch(gateBody, /target-check/u,
    'the structural gate calls the frozen-target check again');
  assert.doesNotMatch(gateBody, /\borigin\b|ls-remote|rev-parse|\bfetch\b/u,
    'the structural gate consults the release target again');
  assert.equal(packageJson.scripts['test:outcome-reconciler:release-dag-plan'],
    'bash scripts/outcome-reconciler-release-dag-plan.sh');
});

if (!process.env.ORBIT_RELEASE_DAG_PLAN_GATE_NESTED) {
  test('the structural regression gate passes where HEAD is not origin/main', () => {
    const head = git('rev-parse', 'HEAD');
    assert.match(head, /^[0-9a-f]{40}$/u);
    assert.notEqual(head, divergentSha, 'the divergence fixture collided with the real HEAD');
    const gate = runShimmed('bash', ['scripts/outcome-reconciler-release-dag-plan.sh'], {
      ORBIT_SHIM_TRACKING: divergentSha,
      ORBIT_SHIM_REMOTE: divergentSha,
      ORBIT_RELEASE_DAG_PLAN_GATE_NESTED: '1',
    });
    assert.equal(gate.status, 0,
      `the structural gate failed in an ordinary worktree\n${gate.stdout}\n${gate.stderr}`);
    assert.match(gate.stdout, /^# fail 0$/mu);
    assert.match(gate.stdout, /^# cancelled 0$/mu);
    assert.match(gate.stdout, /^# skipped 0$/mu);
    assert.doesNotMatch(gate.log, /\borigin\b/u, 'the structural gate still asked about origin');
    assert.doesNotMatch(gate.log, /^(fetch|ls-remote)\b/mu);
  });
}

test('the formal Release DAG resolves the frozen target before it schedules anything', () => {
  const checkPlanAt = runnerSource.indexOf("process.argv.includes('--check-plan')");
  const resolveAt = runnerSource.indexOf('const targetResolution = resolveTarget();');
  const environmentAt = runnerSource.indexOf('const environment = inspectEnvironment();');
  const scheduleAt = runnerSource.indexOf('mkdirSync(receiptRoot, { recursive: true });');
  assert.ok(checkPlanAt > 0 && checkPlanAt < resolveAt, 'the plan check no longer precedes the target');
  assert.ok(resolveAt > 0 && resolveAt < environmentAt && environmentAt < scheduleAt,
    'the frozen-target resolution is no longer the first thing the formal run does');
  for (const harness of [
    'scripts/outcome-reconciler-release-dag-pcc-rebind.sh',
    'scripts/outcome-reconciler-release-dag-regression-rebind.sh',
  ]) {
    assert.match(read(harness), /outcome-reconciler-release-dag-target-check\.mjs/u, harness);
  }
  const head = git('rev-parse', 'HEAD');
  const refusal = refusedRelease({
    ORBIT_SHIM_TRACKING: head,
    ORBIT_SHIM_REMOTE: head,
    ORBIT_SHIM_STATUS_SET: '1',
  });
  assert.match(refusal.stderr, /the frozen builder merge receipt is missing/u);
  assert.match(refusal.log, /^exec orbit-postgres psql\b/mu,
    'the formal run never reached the builder receipt query');
});

test('the formal Release DAG refuses a checkout whose HEAD is not origin/main', () => {
  const refusal = refusedRelease({
    ORBIT_SHIM_TRACKING: divergentSha,
    ORBIT_SHIM_REMOTE: divergentSha,
  });
  assert.match(refusal.stderr, /checkout HEAD is not the freshly fetched origin\/main target/u);
  assert.doesNotMatch(refusal.log, /^exec orbit-postgres\b/mu,
    'a divergent checkout still reached the receipt query');
});

test('the formal Release DAG refuses a checkout with tracked changes', () => {
  const head = git('rev-parse', 'HEAD');
  const refusal = refusedRelease({
    ORBIT_SHIM_TRACKING: head,
    ORBIT_SHIM_REMOTE: head,
    ORBIT_SHIM_STATUS_SET: '1',
    ORBIT_SHIM_STATUS: ' M scripts/outcome-reconciler-release-dag.mjs',
  });
  assert.match(refusal.stderr, /release DAG requires a tracked-clean checkout/u);
  assert.doesNotMatch(refusal.log, /^exec orbit-postgres\b/mu);
});

test('the formal Release DAG refuses a remote that moved away from the fetched target', () => {
  const head = git('rev-parse', 'HEAD');
  const refusal = refusedRelease({
    ORBIT_SHIM_TRACKING: head,
    ORBIT_SHIM_REMOTE: divergentSha,
  });
  assert.match(refusal.stderr, /origin\/main changed between fetch and remote observation/u);
  assert.doesNotMatch(refusal.log, /^exec orbit-postgres\b/mu);
});

test('the formal Release DAG refuses a builder receipt bound to another target', () => {
  const head = git('rev-parse', 'HEAD');
  const refusal = refusedRelease({
    ORBIT_SHIM_TRACKING: head,
    ORBIT_SHIM_REMOTE: head,
    ORBIT_SHIM_STATUS_SET: '1',
    ORBIT_SHIM_RECEIPT: receiptRow({
      sourceSha: oneTarget,
      targetShaBefore: zeroTarget,
      targetShaAfter: head,
    }),
  });
  assert.match(refusal.stderr, /checkout differs from the builder receipt target/u);
});

const strictGuards = [
  ['exact target SHA', () => {
    assert.equal(plan.target.checkoutMustEqualTarget, true);
    assert.equal(plan.target.remoteMustRemainExactlyTarget, true);
    assert.equal(plan.target.trackedCheckoutMustBeClean, true);
    assert.match(runnerSource, /assert\.match\(value, SHA, `\$\{name\} is not a full commit SHA`\)/u);
    assert.match(runnerSource, /checkout HEAD is not the freshly fetched origin\/main target/u);
    assert.match(runnerSource, /origin\/main changed between fetch and remote observation/u);
    assert.match(runnerSource, /checkout does not equal the frozen target SHA/u);
    assert.match(runnerSource, /release DAG requires a tracked-clean checkout/u);
  }],
  ['current binding', () => {
    assert.match(runnerSource, /atomicJson\(path\.join\(stateRoot, 'current-binding\.json'\)/u);
    assert.match(runnerSource, /assert\.equal\(context\.bindingDigest, binding\.bindingDigest,/u);
    assert.match(read('scripts/lib/outcome-reconciler-release-dag.sh'),
      /stale Release DAG build binding/u);
    // Artifacts that name the round that produced them cannot be handed to another round. Since
    // per-node input digests that guard is scoped to BINDING_EMBEDDED nodes on purpose -- a
    // content-only artifact is keyed on its inputs, so a new target SHA over an identical tree
    // reuses it. The subject here is therefore an embedded node, and its input set is supplied
    // exactly, so the refusal that comes back is the binding's own.
    const node = nodeById.get('prepare-build');
    assert.equal(node.artifactBinding, 'BINDING_EMBEDDED');
    const foreignRound = { ...successReceipt(node), binding: { ...binding, targetSha: oneTarget } };
    assert.equal(checkpointReuseDecision({
      receipt: foreignRound,
      node,
      binding,
      artifactsValid: true,
      inputDigest: baselineInputs.get(node.id).inputDigest,
      inputs: baselineInputs.get(node.id).inputs,
    }).reason, 'STALE_BINDING');
    // An input set that cannot be pinned down is refused before the binding is consulted at all,
    // so neither failure can be quietly absorbed into the other.
    assert.equal(checkpointReuseDecision({
      receipt: foreignRound,
      node,
      binding,
      artifactsValid: true,
      inputDigest: undefined,
      inputs: undefined,
    }).reason, 'INDETERMINATE_INPUTS');
    assert.equal(plan.supersededAttempt.stalePolicy,
      'TARGET_OR_PLAN_CHANGE_INVALIDATES_ALL_CHECKPOINTS_AND_THE_EVIDENCE_CUT');
  }],
  ['builder target receipt', () => {
    assert.equal(plan.target.resolution, 'BUILDER_AGENT_MERGE_RECEIPT');
    assert.equal(plan.target.requiredReceipt.recordedBy, 'AGENT');
    assert.deepEqual(plan.target.requiredReceipt.results, ['MERGED', 'ALREADY_MERGED']);
    assert.match(runnerSource, /the frozen builder merge receipt is missing/u);
    assert.match(runnerSource, /checkout differs from the builder receipt target/u);
    assert.match(runnerSource, /remote target differs from the builder receipt/u);
    assert.match(runnerSource, /builder receipt is not a strict target advance/u);
    assert.match(runnerSource, /ALREADY_MERGED receipt does not describe an already-current target/u);
  }],
  ['frozen package lock', () => {
    assert.match(runnerSource,
      /installed dependency checkout does not match the frozen target package lock/u);
    assert.match(runnerSource, /fileDigest\(path\.join\(repo, 'package-lock\.json'\)\)/u);
    assert.match(runnerSource, /fileDigest\('\/root\/orbit\/package-lock\.json'\)/u);
    assert.match(runnerSource, /fileDigest\('\/root\/orbit\/node_modules\/\.package-lock\.json'\)/u);
  }],
  ['bound environment', () => {
    assert.match(runnerSource, /host platform differs from the Release DAG environment contract/u);
    assert.match(runnerSource, /required environment probe failed/u);
    assert.match(runnerSource, /required bound image is unavailable at admission/u);
    assert.equal(typeof plan.environment.identity, 'string');
    assert.notEqual(deriveBinding({
      plan,
      targetSha: zeroTarget,
      targetReceiptDigest,
      environment: { ...environment, versions: { ...environment.versions, docker: 'changed' } },
    }).bindingDigest, binding.bindingDigest);
  }],
  ['evaluation plan digest', () => {
    assert.match(plan.evaluator.evaluationPlanDigest, /^[0-9a-f]{64}$/u);
    const rebound = structuredClone(plan);
    rebound.evaluator.evaluationPlanDigest = 'a'.repeat(64);
    rebound.declaredDagPlanDigest = dagPlanDigest(rebound);
    assert.notEqual(deriveBinding({
      plan: rebound, targetSha: zeroTarget, targetReceiptDigest, environment,
    }).bindingDigest, binding.bindingDigest);
    const untyped = structuredClone(plan);
    untyped.evaluator.evaluationPlanDigest = 'not-a-digest';
    untyped.declaredDagPlanDigest = dagPlanDigest(untyped);
    assert.throws(() => validatePlan(untyped),
      /formal evaluator command and plan digests must be full SHA-256 values/u);
  }],
  ['declared DAG plan digest', () => {
    assert.equal(plan.declaredDagPlanDigest, dagPlanDigest(plan));
    assert.match(runnerSource, /const validation = validatePlan\(plan\)/u);
    const drifted = structuredClone(plan);
    drifted.resourceLimits.maxConcurrent -= 1;
    assert.throws(() => validatePlan(drifted), /declared Release DAG plan digest is stale/u);
  }],
  ['evidence cut', () => {
    assert.equal(plan.evidenceCut.membership,
      'ALL_SUCCESSFUL_NODE_RECEIPTS_EXCEPT_PUBLISHER_SELF');
    assert.deepEqual(plan.nodes.filter((node) => node.evidenceWriter === true)
      .map((node) => node.id), ['publish-evidence-cut']);
    assert.match(read('scripts/outcome-reconciler-release-dag-aggregate.mjs'), /skipCount, 0/u);
    const fixture = mkdtempSync(path.join(tmpdir(), 'orbit-release-dag-evidence-'));
    try {
      const artifact = path.join(fixture, 'skipped.json');
      writeFileSync(artifact, JSON.stringify({ summary: { tests: 2, passed: 1, failed: 0, skipped: 1 } }));
      assert.throws(() => metricsForNode({ id: 'synthetic-node', testBearing: true }, [artifact]),
        /published 1 skips/u);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }],
];

assert.equal(strictGuards.length, 8);
for (const [name, assertGuard] of strictGuards) {
  test(`the strict Release DAG guard is unweakened: ${name}`, assertGuard);
}

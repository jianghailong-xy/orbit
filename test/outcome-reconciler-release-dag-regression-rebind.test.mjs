import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  checkpointReuseDecision,
  commandDigest,
  deriveBinding,
  sha256,
} from '../scripts/outcome-reconciler-release-dag-lib.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const read = (relative) => readFileSync(path.join(repo, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const plan = readJson('contracts/outcome-reconciler-release-dag.json');
const frontier = readJson('contracts/outcome-reconciler-release-frontier.json');
const authoritative = readJson('contracts/outcome-reconciler-authoritative-target.json');
const packageJson = readJson('package.json');
const oldTarget = '2c697755bddd560e569c49470a9b45a0199a82c4';

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function atOldTarget(relative) {
  return JSON.parse(git('show', `${oldTarget}:${relative}`));
}

test('the immutable EXITED 1 attempt is classified into the four observed failure classes', () => {
  const old = plan.supersededAttempt;
  assert.deepEqual({
    taskId: old.taskId,
    sessionId: old.sessionId,
    attemptId: old.attemptId,
    diagnosisId: old.diagnosisId,
    target: old.preservedTip,
    terminalState: old.terminalState,
    actualExitCode: old.actualExitCode,
    failureFingerprint: old.failureFingerprint,
    failedNodes: old.failedNodes,
  }, {
    taskId: '34GPMWmm6WxUjmxCYvLxh',
    sessionId: '42NqmQLttJLS4kzUl6XUmX',
    attemptId: '3QLN8FBUrKS84LaoE0Vo58',
    diagnosisId: 'Hmj7440inFPxu3Bh9OVDE',
    target: oldTarget,
    terminalState: 'EXITED',
    actualExitCode: 1,
    failureFingerprint: '1a09b7ba0ad9ecf8c6b42e00eb7037e94120764ff0a658a42493838d28fbb153',
    failedNodes: [
      'full-web',
      'suite-watchdog-111k',
      'full-api-shard-0',
      'full-api-shard-1',
      'full-api-shard-2',
      'full-api-shard-3',
    ],
  });
  assert.equal(old.failedNodeCount, old.failedNodes.length);
  assert.deepEqual(old.rawOutput, {
    bytes: 1438971,
    sha256: '2fd02b34b51f220009383752f2b38b23b5a489d98fddd385f8e80f958d4da8fa',
    outputTruncated: false,
  });
  assert.equal(old.fullWebReport.failed, 1);
  assert.equal(old.fullWebReport.skipped, 0);
  assert.equal(old.fullWebReport.failingAssertion,
    'shows an actionable ready queue without the old chart/table control');
  assert.deepEqual(old.failureClasses.map(({ id, classification, nodes }) => ({
    id, classification, nodes,
  })), [
    { id: 'WATCHDOG_MANIFEST_SHA_BINDING', classification: 'MANIFEST_BINDING_ERROR', nodes: ['suite-watchdog-111k'] },
    { id: 'API_MOCK_INTERFACE_DRIFT', classification: 'STALE_TEST_FIXTURE', nodes: ['full-api-shard-0', 'full-api-shard-1'] },
    { id: 'PROJECT_ROLLUP_QUERY_BUDGET_DRIFT', classification: 'STALE_TEST_FIXTURE', nodes: ['full-api-shard-2', 'full-api-shard-3'] },
    { id: 'FULL_WEB_CONCURRENT_TIMEOUT', classification: 'CONCURRENCY_ISOLATION', nodes: ['full-web'] },
  ]);
  assert.deepEqual(old.classificationSummary.productRegression, []);
  assert.equal(old.evidenceReuse, 'NONE');
  assert.equal(old.stalePolicy,
    'TARGET_OR_PLAN_CHANGE_INVALIDATES_ALL_CHECKPOINTS_AND_THE_EVIDENCE_CUT');
});

test('the repair is on the fixture/concurrency/binding side and preserves product assertions', () => {
  const ownerFixture = read('src/apiserver/src/runner-api/runner-write-lease-owner.spec.ts');
  assert.match(ownerFixture, /conversationTurn:\s*\{[\s\S]*findMany:\s*async \(\) => \[\]/u);
  assert.match(ownerFixture, /conversationTurnStartupFragment:\s*\{[\s\S]*findMany[\s\S]*updateMany/u);

  const inboxFixture = read('src/apiserver/src/runner-api/inbox-lease-generation.spec.ts');
  assert.match(inboxFixture, /Array\.isArray\(query\)/u);
  assert.match(inboxFixture, /strings\?: readonly string\[\]/u);
  assert.match(inboxFixture, /assert\.equal\(h\.rawCalls\.length, 4\)/u);

  for (const relative of [
    'src/apiserver/src/projects/project-list-rollup.audit.pg.spec.ts',
    'src/apiserver/src/projects/project-list-rollup.pg.spec.ts',
  ]) {
    const source = read(relative);
    assert.match(source, /rawQueries,\s*9/u);
    assert.match(source, /page-wide/u);
    assert.match(source, /seven numbers|every bucket equals what the project page computes/u);
  }

  const web = read('src/web/src/components/ProjectReadyToRun.test.tsx');
  assert.match(web, /shows an actionable ready queue without the old chart\/table control/u);
  assert.match(web, /timeout:\s*15_000/u);

  const watchdog = plan.nodes.find(({ id }) => id === 'suite-watchdog-111k');
  assert.deepEqual(watchdog.environment, {
    OUTCOME_WATCHDOG_RUNTIME_CLOSURE: 'reuse',
    OUTCOME_WATCHDOG_LIVE_RELEASE_FENCE: 'offline',
  });
  assert.equal(watchdog.testBearing, true);
  assert.deepEqual(watchdog.scale, { tasks: 111000, replaySamples: 111000 });
});

test('the builder command can run only the six-node focused repair surface', () => {
  assert.equal(packageJson.scripts['test:outcome-reconciler:release-dag-regression-rebind'],
    'bash scripts/outcome-reconciler-release-dag-regression-rebind.sh');
  const harness = read('scripts/outcome-reconciler-release-dag-regression-rebind.sh');
  assert.match(harness, /--check-plan/u);
  assert.match(harness, /--focus-regression-rebind/u);
  assert.match(harness, /release-dag-target-check/u);
  assert.doesNotMatch(harness, /npm run test:outcome-reconciler:release-dag(?:\s|["'])/u);
  assert.doesNotMatch(harness, /docker compose|upgrade\.sh|git tag|release-live-state/u);

  const runner = read('scripts/outcome-reconciler-release-dag.mjs');
  assert.match(runner, /includeWithDependencies\('full-web'\)/u);
  assert.match(runner, /includeWithDependencies\('suite-watchdog-111k'\)/u);
  assert.match(runner, /FOCUSED_RELEASE_DAG_REGRESSION_REBIND/u);
  assert.match(runner, /const focusedMode = focusedModeCount === 1/u);

  const focus = read('scripts/outcome-reconciler-release-dag-regression-focus.mjs');
  for (const spec of [
    'runner-write-lease-owner.spec.js',
    'inbox-lease-generation.spec.js',
    'project-list-rollup.audit.pg.spec.js',
    'project-list-rollup.pg.spec.js',
  ]) assert.match(focus, new RegExp(spec.replaceAll('.', '\\.'), 'u'));
  assert.match(focus, /Promise\.all\(cases\.map/u);
  assert.match(focus, /resourcesRemaining, 0/u);
  assert.match(focus, /productionAccess: false/u);
  assert.match(focus, /numFailedTests, 0/u);
  assert.match(focus, /watchdog\.tests, 13/u);
});

test('tenant, zero-skip, SHA/current-binding and disposable database gates stay strict', () => {
  const pccSafety = read('src/apiserver/src/projects/coordinator-pg-test-safety.ts');
  assert.match(pccSafety, /assert\.match\(database, \/\^pcc/u);
  assert.match(pccSafety, /dedicated pcc_\* database/u);
  assert.match(pccSafety, /expectedDatabase/u);
  assert.match(pccSafety, /expectedUser/u);
  assert.match(pccSafety, /expectedSystemIdentifier/u);
  assert.match(pccSafety, /production|refus/iu);

  const caseRunner = read('scripts/outcome-reconciler-full-api-case.sh');
  assert.match(caseRunner, /COORDINATOR_PG_EXPECTED_DATABASE/u);
  assert.match(caseRunner, /COORDINATOR_PG_EXPECTED_USER/u);
  assert.match(caseRunner, /COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER/u);
  assert.match(caseRunner, /DROP DATABASE/u);
  assert.doesNotMatch(caseRunner, /orbit-postgres/u);

  const targetCheck = read('scripts/outcome-reconciler-release-dag-target-check.mjs');
  assert.match(targetCheck, /fresh origin\/main does not equal the frozen checkout/u);
  assert.match(targetCheck, /remote refs\/heads\/main does not equal the frozen checkout/u);
  assert.match(targetCheck, /source_sha = '\$\{head\}'::char\(40\)/u);
  assert.match(targetCheck, /target_sha_after = '\$\{head\}'::char\(40\)/u);
  const focus = read('scripts/outcome-reconciler-release-dag-regression-focus.mjs');
  assert.match(focus, /assert\.equal\(receipt\.summary\.skipped, 0\)/u);
  assert.match(focus, /assert\.equal\(webReport\.numPendingTests, 0\)/u);
  assert.match(focus, /assert\.equal\(watchdog\.skipped, 0\)/u);

  const previousAuthoritative = atOldTarget('contracts/outcome-reconciler-authoritative-target.json');
  const previousFrontier = atOldTarget('contracts/outcome-reconciler-release-frontier.json');
  assert.deepEqual(authoritative.immutableVerifier, previousAuthoritative.immutableVerifier);
  assert.deepEqual(frontier.ownerRatification, previousFrontier.ownerRatification);
  assert.deepEqual(frontier.canonicalBinding, previousFrontier.canonicalBinding);
});

test('the new builder identity and every implementation/package-lock digest are frozen', () => {
  assert.equal(frontier.task.publicId, plan.builder.taskId);
  assert.equal(frontier.task.databaseId, plan.builder.taskDatabaseId);
  assert.equal(frontier.task.acceptanceCommand, plan.builder.acceptanceCommand);
  assert.equal(frontier.session.publicId, plan.builder.sessionId);
  assert.equal(frontier.session.databaseId, plan.builder.sessionDatabaseId);
  assert.equal(frontier.session.sourceBranch, plan.builder.sourceBranch);
  assert.equal(authoritative.taskId, plan.builder.taskId);
  assert.equal(authoritative.sourceBranch, plan.builder.sourceBranch);
  assert.equal(authoritative.lineage.remoteMainObservedBeforeIntegration,
    '324e71018cefb982ab84667ad515917fe2b81df9');
  assert.equal(plan.implementationInputs.paths.length,
    Object.keys(plan.implementationInputs.digests).length);
  assert.equal(new Set(plan.implementationInputs.paths).size,
    plan.implementationInputs.paths.length);
  for (const relative of plan.implementationInputs.paths) {
    assert.equal(sha256(readFileSync(path.join(repo, relative))),
      plan.implementationInputs.digests[relative], relative);
  }
  assert.equal(plan.implementationInputs.digests['package-lock.json'],
    '50bc5c50f24724a9860ae8cad2fe5cfc55d4297bd79dca7cdd3bf7608642887c');
  assert.equal(sha256(readFileSync('/root/orbit/package-lock.json')),
    plan.implementationInputs.digests['package-lock.json']);
});

test('the old 2c binding is necessarily stale under the new plan and target', () => {
  const environment = {
    identity: plan.environment.identity,
    versions: { node: 'fixture' },
    imageIds: {},
    boundInputs: { PUBLIC_ORIGIN: 'fixture' },
  };
  const current = deriveBinding({
    plan,
    targetSha: '3'.repeat(40),
    targetReceiptDigest: '4'.repeat(64),
    environment,
  });
  const node = plan.nodes.find(({ id }) => id === 'full-web');
  const decision = checkpointReuseDecision({
    node,
    binding: current,
    receipt: {
      nodeId: node.id,
      state: 'SUCCESS',
      exitCode: 0,
      commandDigest: commandDigest(node.command),
      binding: plan.supersededAttempt.binding,
    },
  });
  assert.deepEqual(decision, { reusable: false, reason: 'STALE_BINDING' });
  assert.notEqual(current.dagPlanDigest, plan.supersededAttempt.binding.dagPlanDigest);
  assert.notEqual(current.bindingDigest, plan.supersededAttempt.binding.bindingDigest);
});

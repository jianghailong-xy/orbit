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
const oldTarget = '36d340cb75f048443f2130001d28f277eca5daad';

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function atOldTarget(relative) {
  return JSON.parse(git('show', `${oldTarget}:${relative}`));
}

test('the immutable route-bound EXITED 1 attempt remains the only superseded failure', () => {
  const old = plan.supersededAttempt;
  assert.deepEqual({
    taskId: old.taskId,
    sessionId: old.sessionId,
    attemptId: old.attemptId,
    continuationId: old.continuationId,
    diagnosisId: old.diagnosisId,
    target: old.preservedTip,
    terminalState: old.terminalState,
    actualExitCode: old.actualExitCode,
    failureFingerprint: old.failureFingerprint,
    receiptDigest: old.receiptDigest,
    failedNodes: old.failedNodes,
  }, {
    taskId: '34GVK9T3B4GW7UpXH6kmT',
    sessionId: '5saDXo7pdATSJ98Cd7VcdK',
    attemptId: 'Hl7cHRRDc7ZFW7i4uFF02',
    continuationId: '3cuFGpL658QhObvBo7lagT',
    diagnosisId: '6OvjkUtyXeX1CjloMwU6xl',
    target: oldTarget,
    terminalState: 'EXITED',
    actualExitCode: 1,
    failureFingerprint: '1a09b7ba0ad9ecf8c6b42e00eb7037e94120764ff0a658a42493838d28fbb153',
    receiptDigest: 'da858a9db3420711b71d0803c86d16681fd5d20cc453d20e666c36bb591253f8',
    failedNodes: [
      'full-api-shard-0',
      'full-api-shard-1',
      'full-api-shard-2',
      'full-api-shard-3',
    ],
  });
  assert.equal(old.failedNodeCount, 4);
  assert.deepEqual(old.rawOutput, {
    bytes: 1695962,
    sha256: 'cf63fa20fd2b1607e8cc20fc10f0fa1ec79ae6db0c9b44f786c53d028ef43c7f',
    outputTruncated: false,
  });
  assert.equal(old.attemptManifestDigest,
    'f62e2a144dca55e0579393ffa565e0368ea097ac882dc07ba5af3ea445913a2d');
  assert.deepEqual(old.routeDecision, {
    publicId: '64ZHShlb04BuebptQCjTnJ',
    diagnosticPath: 'ALTERNATE_DIAGNOSIS',
    reasonCode: 'TRANSIENT_EXTERNAL_EXITED',
    canonicalReasonDigest: 'bfe2fe00263c90bf08bacf35bdfac0e9d7952ecc6304447e5b4a523036b30a8c',
    decisionDigest: 'bc659e5939b414306b786eacacd206df6fe5d67d92901fd8e5a9bf62bb42ad3e',
    allowsUnchangedRetry: false,
    requiresOwnerDecision: false,
  });
  assert.deepEqual(old.failureClasses, [{
    id: 'CURRENT_WORK_TRANSACTION_DOUBLE_DRIFT',
    classification: 'ROUTE_BOUND_TEST_DOUBLE_REPAIR',
    nodes: old.failedNodes,
    markers: [
      'args[0].join is not a function',
      'tx.conversationTurn.findMany is not a function',
    ],
    canonicalReasonReclassified: false,
  }]);
  assert.equal(old.evidenceReuse, 'NONE');
  assert.equal(old.stalePolicy,
    'TARGET_OR_PLAN_CHANGE_INVALIDATES_ALL_CHECKPOINTS_AND_THE_EVIDENCE_CUT');
});

test('the repair models both raw-query forms and both exact terminal receipt delegates', () => {
  const helper = read('src/apiserver/src/test-support/prisma-transaction-double.ts');
  assert.match(helper, /Array\.isArray\(statement\)/u);
  assert.match(helper, /shape: 'tagged-template'/u);
  assert.match(helper, /Array\.isArray\(sql\.strings\).*Array\.isArray\(sql\.values\)/su);
  assert.match(helper, /shape: 'prisma-sql'/u);
  assert.match(helper, /conversationTurn:\s*\{[\s\S]*findMany:[\s\S]*updateMany:/u);
  assert.match(helper,
    /conversationTurnStartupFragment:\s*\{[\s\S]*findMany:[\s\S]*updateMany:/u);

  const delivery = read('src/apiserver/src/sessions/current-work-delivery.spec.ts');
  for (const title of [
    'the raw-query double renders a tagged-template call with its separate bindings',
    'the raw-query double renders a composed Prisma.Sql object with embedded bindings',
    'zero CURRENT_WORK candidates perform both reads and no receipt writes',
    'steer and startup candidates receive their exact terminal receipts together',
  ]) assert.ok(delivery.includes(title));
  assert.match(delivery, /assert\.deepEqual\(double\.calls\.steerWrites, \[\]\)/u);
  assert.match(delivery, /assert\.deepEqual\(double\.calls\.startupWrites, \[\]\)/u);
  assert.match(delivery, /deliveryFailureCode: CURRENT_WORK_INTERRUPTED/u);
  assert.match(delivery, /failureCode: CURRENT_WORK_INTERRUPTED/u);

  const production = read('src/apiserver/src/sessions/current-work-delivery.ts');
  assert.doesNotMatch(production, /conversationTurn\?\.|conversationTurnStartupFragment\?\./u);
  // Per line, not over the whole file: an honest `if (candidates.length > 0)` far above an honest
  // `tx.conversationTurn.findMany` is not a guard, and a dot-all scan cannot tell them apart.
  for (const line of production.split('\n')) {
    assert.doesNotMatch(line, /if\s*\(.*conversationTurn\w*\.(?:findMany|updateMany)/u, line);
    assert.doesNotMatch(line, /typeof\s+[^;]*\.(?:findMany|updateMany)/u, line);
  }
  assert.match(production, /tx\.conversationTurn\.findMany/u);
  assert.match(production, /tx\.conversationTurnStartupFragment\.findMany/u);
});

test('all transaction doubles that can cross current-work terminalization are complete', () => {
  const directTerminalizationDoubles = [
    'src/apiserver/src/runner-api/attempt-budget-turn-complete.spec.ts',
    'src/apiserver/src/runner-api/merge-source-sha.spec.ts',
    'src/apiserver/src/runner-api/run-finalize-lock.spec.ts',
    'src/apiserver/src/runner-api/steer-requeue.spec.ts',
    'src/apiserver/src/runner-api/turn-complete-scheduling.spec.ts',
    'src/apiserver/src/sessions/end-scheduling.spec.ts',
    'src/apiserver/src/sessions/interrupt-and-send.spec.ts',
    'src/apiserver/src/sessions/interrupt-scheduling.spec.ts',
    'src/apiserver/src/sessions/session-lifecycle-transaction.spec.ts',
    'src/apiserver/src/sessions/turn-error-contract.spec.ts',
  ];
  for (const relative of directTerminalizationDoubles) {
    const source = read(relative);
    const usesCompleteHelper = source.includes('currentWorkTerminalizationDouble');
    const modelsBothDelegates = source.includes('conversationTurnStartupFragment')
      && source.includes('conversationTurn');
    assert.ok(usesCompleteHelper || modelsBothDelegates,
      `${relative} omits explicit current-work delegates`);
  }

  for (const relative of [
    'src/apiserver/src/runner-api/coordinator-context-dequeue.spec.ts',
    'src/apiserver/src/runner-api/inbox-lease-generation.spec.ts',
    'src/apiserver/src/runner-api/reload-provider-env.spec.ts',
    'src/apiserver/src/runner-api/setconfig-dequeue.spec.ts',
    'src/apiserver/src/runner-api/steer-dequeue.spec.ts',
  ]) assert.match(read(relative), /renderRawQuery/u, relative);
});

test('the preparation command inventories 338 specs and runs all 19 focused doubles only', () => {
  assert.equal(packageJson.scripts['test:outcome-reconciler:release-dag-regression-rebind'],
    'bash scripts/outcome-reconciler-release-dag-regression-rebind.sh');
  const harness = read('scripts/outcome-reconciler-release-dag-regression-rebind.sh');
  assert.match(harness, /--check-plan/u);
  assert.match(harness, /--focus-regression-rebind/u);
  assert.match(harness, /release-dag-target-check/u);
  assert.doesNotMatch(harness, /npm run test:outcome-reconciler:release-dag(?:\s|["'])/u);
  assert.doesNotMatch(harness, /docker compose|upgrade\.sh|git tag|release-live-state/u);

  const runner = read('scripts/outcome-reconciler-release-dag.mjs');
  assert.match(runner, /includeWithDependencies\('full-api-inventory'\)/u);
  assert.match(runner, /FOCUSED_RELEASE_DAG_REGRESSION_REBIND/u);
  assert.match(runner, /const focusedMode = focusedModeCount === 1/u);

  const focus = read('scripts/outcome-reconciler-release-dag-regression-focus.mjs');
  const specs = [
    'attempt-budget-turn-complete.spec.js',
    'coordinator-context-dequeue.spec.js',
    'finalize-failed-run.spec.js',
    'inbox-lease-generation.spec.js',
    'merge-source-sha.spec.js',
    'reload-provider-env.spec.js',
    'run-finalize-lock.spec.js',
    'runner-write-lease-owner.spec.js',
    'setconfig-dequeue.spec.js',
    'steer-dequeue.spec.js',
    'steer-requeue.spec.js',
    'steer-turn-complete.spec.js',
    'turn-complete-scheduling.spec.js',
    'current-work-delivery.spec.js',
    'end-scheduling.spec.js',
    'interrupt-and-send.spec.js',
    'interrupt-scheduling.spec.js',
    'session-lifecycle-transaction.spec.js',
    'turn-error-contract.spec.js',
  ];
  for (const spec of specs) assert.match(focus, new RegExp(spec.replaceAll('.', '\\.'), 'u'));
  assert.match(focus, /assert\.equal\(cases\.length, 19\)/u);
  assert.match(focus, /offset \+= inventory\.shardCount/u);
  assert.match(focus, /inventory\.totalSpecs, 338/u);
  assert.match(focus, /receipt\.summary\.cancelled, 0/u);
  assert.match(focus, /receipt\.summary\.skipped, 0/u);
  assert.match(focus, /resourcesRemaining, 0/u);
  assert.match(focus, /productionAccess: false/u);
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

  const previousAuthoritative = atOldTarget('contracts/outcome-reconciler-authoritative-target.json');
  const previousFrontier = atOldTarget('contracts/outcome-reconciler-release-frontier.json');
  assert.deepEqual(authoritative.immutableVerifier, previousAuthoritative.immutableVerifier);
  assert.deepEqual(frontier.ownerRatification, previousFrontier.ownerRatification);
  assert.deepEqual(frontier.canonicalBinding, previousFrontier.canonicalBinding);
});

test('the current successor identity and every implementation/package-lock digest are frozen', () => {
  assert.equal(frontier.task.publicId, plan.builder.taskId);
  assert.equal(frontier.task.databaseId, plan.builder.taskDatabaseId);
  assert.equal(frontier.task.acceptanceCommand, plan.builder.acceptanceCommand);
  assert.equal(frontier.session.publicId, plan.builder.sessionId);
  assert.equal(frontier.session.databaseId, plan.builder.sessionDatabaseId);
  assert.equal(frontier.session.sourceBranch, plan.builder.sourceBranch);
  assert.equal(authoritative.taskId, plan.builder.taskId);
  assert.equal(authoritative.sourceBranch, plan.builder.sourceBranch);
  assert.equal(authoritative.lineage.remoteMainObservedBeforeIntegration,
    '0791fa7d01ac3c5ad96b91265373440cdddd021e');
  // The lookup branch is the one identity the authoritative-target node reads from the inventory
  // rather than from the builder, so it is the one a rebind can silently leave a generation behind.
  assert.equal(authoritative.authoritativeReceiptLookup.sourceBranch, plan.builder.sourceBranch);
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

test('the old 36d binding is necessarily stale under the successor plan and target', () => {
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
  const node = plan.nodes.find(({ id }) => id === 'full-api-shard-0');
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

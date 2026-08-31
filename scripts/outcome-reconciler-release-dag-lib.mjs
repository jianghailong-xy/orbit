import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export const SHA = /^[0-9a-f]{40}$/u;
export const DIGEST = /^[0-9a-f]{64}$/u;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const MAX_NODE_TIMEOUT_SECONDS = 3600;

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key])}`
  )).join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function commandDigest(command) {
  return sha256(canonical(command));
}

export function planMaterial(plan) {
  const { declaredDagPlanDigest: _ignored, ...material } = plan;
  return material;
}

export function dagPlanDigest(plan) {
  return sha256(canonical(planMaterial(plan)));
}

export function topologicalOrder(plan) {
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const indegree = new Map(plan.nodes.map((node) => [node.id, 0]));
  const children = new Map(plan.nodes.map((node) => [node.id, []]));
  for (const node of plan.nodes) {
    for (const dependency of node.dependsOn) {
      indegree.set(node.id, indegree.get(node.id) + 1);
      children.get(dependency).push(node.id);
    }
  }
  const ready = plan.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    ordered.push(id);
    for (const child of children.get(id)) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) ready.push(child);
    }
  }
  if (ordered.length !== nodes.size) throw new Error('release DAG contains a cycle');
  return ordered;
}

export function validatePlan(plan) {
  if (plan?.schemaVersion !== 1 || plan?.kind !== 'orbit.outcome-reconciler.release-evaluation-dag') {
    throw new Error('unsupported release DAG contract');
  }
  const postgresPolicies = plan.postgresIsolation?.nodes;
  if (plan.postgresIsolation?.schemaVersion !== 1
      || plan.postgresIsolation?.allocator
        !== 'ATTEMPT_BOUND_NODE_AND_CASE_DISPOSABLE_DATABASE_ROLE_V2'
      || plan.postgresIsolation?.concurrentShardPolicy
        !== 'UNIQUE_DATABASE_AND_ROLE_PER_GLOBAL_CASE_INDEX'
      || typeof postgresPolicies !== 'object' || postgresPolicies === null) {
    throw new Error('Release DAG PostgreSQL isolation policy is incomplete');
  }
  const postgresNodeIds = new Set(plan.nodes
    .filter((node) => node.usesSharedPostgres === true).map((node) => node.id));
  if (Object.keys(postgresPolicies).length !== postgresNodeIds.size
      || Object.keys(postgresPolicies).some((id) => !postgresNodeIds.has(id))) {
    throw new Error('Release DAG PostgreSQL isolation policies do not exactly cover its nodes');
  }
  const superseded = plan.supersededAttempt;
  const supersededBinding = superseded?.binding;
  const bindingFields = [
    'targetReceiptDigest', 'environmentDigest', 'evaluationPlanDigest', 'dagPlanDigest',
    'evidenceCutDigest', 'bindingDigest',
  ];
  const validExitedFailure = superseded?.terminalState === 'EXITED'
    && Number.isInteger(superseded.actualExitCode) && superseded.actualExitCode !== 0
    && DIGEST.test(superseded.failureFingerprint ?? '');
  const validTimedOutFailure = superseded?.terminalState === 'TIMED_OUT';
  if (!/^[0-9A-Za-z]+$/u.test(superseded?.taskId ?? '')
      || !/^[0-9A-Za-z]+$/u.test(superseded?.sessionId ?? '')
      || !SHA.test(superseded?.preservedTip ?? '')
      || (!validExitedFailure && !validTimedOutFailure)
      || superseded?.evidenceReuse !== 'NONE'
      || superseded?.stalePolicy
        !== 'TARGET_OR_PLAN_CHANGE_INVALIDATES_ALL_CHECKPOINTS_AND_THE_EVIDENCE_CUT'
      || supersededBinding?.targetSha !== superseded.preservedTip
      || bindingFields.some((field) => !DIGEST.test(supersededBinding?.[field] ?? ''))) {
    throw new Error('superseded failed attempt policy is incomplete');
  }
  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) throw new Error('release DAG has no nodes');
  if (plan.builder?.taskId !== plan.builderTaskId
      || !UUID.test(plan.builder?.taskDatabaseId)
      || !UUID.test(plan.builder?.sessionDatabaseId)
      || !/^[0-9A-Za-z]+$/u.test(plan.builder?.sessionId ?? '')
      || !/^orbit\/[a-z0-9-]+$/u.test(plan.builder?.sourceBranch ?? '')
      || !DIGEST.test(plan.builder?.commandDigest)
      || !DIGEST.test(plan.builder?.evaluationPlanDigest)
      || !Number.isInteger(plan.builder?.timeoutSeconds)
      || plan.builder.timeoutSeconds < 1
      || plan.builder.timeoutSeconds > MAX_NODE_TIMEOUT_SECONDS) {
    throw new Error('builder acceptance binding is incomplete or unbounded');
  }
  if (!Number.isInteger(plan.evaluator?.attemptTimeoutSeconds)
      || plan.evaluator.attemptTimeoutSeconds < 1
      || plan.evaluator.attemptTimeoutSeconds > MAX_NODE_TIMEOUT_SECONDS) {
    throw new Error('formal evaluator attempt must be bounded to at most 3600 seconds');
  }
  if (!Number.isInteger(plan.evaluator.schedulerDeadlineSeconds)
      || plan.evaluator.schedulerDeadlineSeconds < 1
      || plan.evaluator.schedulerDeadlineSeconds > plan.evaluator.attemptTimeoutSeconds) {
    throw new Error('scheduler deadline must fit inside the evaluator attempt');
  }
  if (!DIGEST.test(plan.evaluator.commandDigest)
      || !DIGEST.test(plan.evaluator.evaluationPlanDigest)) {
    throw new Error('formal evaluator command and plan digests must be full SHA-256 values');
  }
  if (plan.evaluator.automaticRetries !== 0) throw new Error('the formal evaluator may not retry in place');
  if (plan.evaluator.phase !== 'PREDEPLOY_EVALUATION'
      || !/^[0-9A-Za-z]+$/u.test(plan.evaluator.deploymentTaskId ?? '')
      || plan.postDeploymentBoundary?.taskId !== plan.evaluator.deploymentTaskId
      || plan.postDeploymentBoundary?.mode !== 'TYPED_DEFERRED_ASSERTIONS'
      || !Array.isArray(plan.postDeploymentBoundary?.assertions)
      || plan.postDeploymentBoundary.assertions.length === 0) {
    throw new Error('the evaluator/deployment phase boundary is incomplete');
  }
  if (!Array.isArray(plan.integratedDeliveries) || plan.integratedDeliveries.length === 0) {
    throw new Error('the DAG omits required integrated deliveries');
  }
  if (!DIGEST.test(plan.declaredDagPlanDigest ?? '')
      || plan.declaredDagPlanDigest !== dagPlanDigest(plan)) {
    throw new Error('declared Release DAG plan digest is stale');
  }
  for (const delivery of plan.integratedDeliveries) {
    if (!/^[0-9A-Za-z]+$/u.test(delivery.taskId ?? '')
        || !Array.isArray(delivery.commits)
        || delivery.commits.length === 0
        || delivery.commits.some((commit) => !SHA.test(commit))
        || !Array.isArray(delivery.requiredSubjects)
        || delivery.requiredSubjects.length !== delivery.commits.length
        || delivery.evidencePolicy !== 'RECHECK_COMMIT_ANCESTRY_AND_CURRENT_STRUCTURAL_REGRESSION') {
      throw new Error(`integrated delivery is incomplete: ${delivery.taskId ?? 'UNKNOWN'}`);
    }
  }
  const receipt = plan.target?.requiredReceipt;
  if (plan.target?.resolution !== 'BUILDER_AGENT_MERGE_RECEIPT'
      || receipt?.sessionDatabaseId !== plan.builder.sessionDatabaseId
      || receipt?.sourceBranch !== plan.builder.sourceBranch
      || receipt?.targetBranch !== plan.target.branch
      || receipt?.recordedBy !== 'AGENT'
      || !Array.isArray(receipt?.results)
      || receipt.results.length === 0
      || receipt.results.some((result) => !['MERGED', 'ALREADY_MERGED'].includes(result))
      || plan.target.remoteMustRemainExactlyTarget !== true) {
    throw new Error('the frozen target is not bound to the builder AGENT merge receipt');
  }

  const ids = new Set();
  for (const node of plan.nodes) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(node.id)) throw new Error(`invalid node id: ${node.id}`);
    if (ids.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
    ids.add(node.id);
  }
  const resourceNames = new Set(Object.keys(plan.resourceLimits)
    .filter((name) => name !== 'maxConcurrent'));
  if (!Number.isInteger(plan.resourceLimits.maxConcurrent)
      || plan.resourceLimits.maxConcurrent < 1) {
    throw new Error('resourceLimits.maxConcurrent must be positive');
  }
  const reservation = plan.hostResourceEnvelope?.persistentPostgresReservation;
  if (!reservation
      || plan.resourceLimits.cpu + reservation.cpu !== plan.hostResourceEnvelope.cpu
      || plan.resourceLimits.memoryMiB + reservation.memoryMiB
        !== plan.hostResourceEnvelope.memoryMiB) {
    throw new Error('schedulable resources and persistent PostgreSQL must fit the host envelope');
  }
  for (const node of plan.nodes) {
    if (!Array.isArray(node.dependsOn) || !Array.isArray(node.command)
        || node.command.length === 0 || !Array.isArray(node.outputs)) {
      throw new Error(`${node.id} has an incomplete execution declaration`);
    }
    if (node.usesSharedPostgres === true) {
      const policy = postgresPolicies[node.id];
      const prefix = /^[a-z][a-z0-9_]{1,24}$/u;
      if (!prefix.test(policy?.postgresDatabasePrefix ?? '')
          || !prefix.test(policy?.postgresRolePrefix ?? '')
          || typeof policy?.destructiveCoordinatorSpecs !== 'boolean') {
        throw new Error(`${node.id} omits its disposable PostgreSQL identity policy`);
      }
      if (policy.destructiveCoordinatorSpecs
          && (!/^pcc[0-9a-z]*$/u.test(policy.postgresDatabasePrefix)
            || !/^pcc[0-9a-z]*$/u.test(policy.postgresRolePrefix))) {
        throw new Error(`${node.id} weakens the destructive pcc_* PostgreSQL safety gate`);
      }
    }
    if (!Number.isInteger(node.timeoutSeconds) || node.timeoutSeconds < 1
        || node.timeoutSeconds > MAX_NODE_TIMEOUT_SECONDS
        || node.timeoutSeconds > plan.evaluator.attemptTimeoutSeconds) {
      throw new Error(`${node.id} has an invalid timeout admission`);
    }
    if (new Set(node.dependsOn).size !== node.dependsOn.length) {
      throw new Error(`${node.id} repeats a dependency`);
    }
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`${node.id} depends on unknown node ${dependency}`);
      if (dependency === node.id) throw new Error(`${node.id} depends on itself`);
    }
    for (const [resource, amount] of Object.entries(node.resources ?? {})) {
      if (!resourceNames.has(resource)) throw new Error(`${node.id} uses unknown resource ${resource}`);
      if (!Number.isInteger(amount) || amount < 0 || amount > plan.resourceLimits[resource]) {
        throw new Error(`${node.id} exceeds ${resource} capacity`);
      }
    }
  }
  topologicalOrder(plan);

  const mappings = new Set();
  const mappedNodes = new Set();
  for (const entrypoint of plan.legacyEntrypoints ?? []) {
    if (!entrypoint.name || !entrypoint.packageScript || !ids.has(entrypoint.nodeId)) {
      throw new Error('invalid legacy entrypoint mapping');
    }
    if (mappings.has(entrypoint.packageScript)) {
      throw new Error(`legacy entrypoint is mapped twice: ${entrypoint.packageScript}`);
    }
    if (mappedNodes.has(entrypoint.nodeId)) {
      throw new Error(`two legacy entrypoints map to ${entrypoint.nodeId}`);
    }
    mappings.add(entrypoint.packageScript);
    mappedNodes.add(entrypoint.nodeId);
  }
  for (const entrypoint of plan.legacyDirectEntrypoints ?? []) {
    if (!entrypoint.name || !Array.isArray(entrypoint.command) || entrypoint.command.length === 0
        || !ids.has(entrypoint.nodeId)) {
      throw new Error('invalid legacy direct entrypoint mapping');
    }
    if (mappedNodes.has(entrypoint.nodeId)) {
      throw new Error(`two legacy entrypoints map to ${entrypoint.nodeId}`);
    }
    const node = plan.nodes.find((candidate) => candidate.id === entrypoint.nodeId);
    if (canonical(node.command) !== canonical(entrypoint.command)) {
      throw new Error(`legacy direct entrypoint command changed: ${entrypoint.name}`);
    }
    mappedNodes.add(entrypoint.nodeId);
  }
  const writers = plan.nodes.filter((node) => node.evidenceWriter === true);
  if (writers.length !== 1 || writers[0].id !== plan.evidenceCut.publisherNodeId) {
    throw new Error('the release DAG must have exactly one evidence-cut writer');
  }
  if (plan.evidenceCut.membership !== 'ALL_SUCCESSFUL_NODE_RECEIPTS_EXCEPT_PUBLISHER_SELF') {
    throw new Error('the evidence cut must define its non-recursive publisher boundary');
  }
  const predeployAttestations = plan.nodes.filter((node) => node.kind === 'predeploy-attestation');
  if (predeployAttestations.length !== 2
      || predeployAttestations.some((node) => node.testBearing !== false)) {
    throw new Error('deployment-only attestations must be typed, deferred and non-test-bearing');
  }
  const releaseBoundaries = plan.nodes.filter((node) => node.kind === 'predeploy-release-boundary');
  if (releaseBoundaries.length !== 1 || releaseBoundaries[0].testBearing !== false
      || writers[0].dependsOn.length !== 1
      || writers[0].dependsOn[0] !== releaseBoundaries[0].id) {
    throw new Error('the legacy live-state boundary must precede the sole publisher');
  }
  return { nodeIds: ids, order: topologicalOrder(plan), evidenceWriter: writers[0].id };
}

export function deriveBinding({ plan, targetSha, targetReceiptDigest, environment }) {
  validatePlan(plan);
  if (!SHA.test(targetSha)) throw new Error('targetSha must be a full 40-character SHA');
  if (!DIGEST.test(targetReceiptDigest)) {
    throw new Error('targetReceiptDigest must be a full SHA-256 value');
  }
  const planDigest = dagPlanDigest(plan);
  const environmentDigest = sha256(canonical(environment));
  const cutMaterial = {
    schemaVersion: plan.evidenceCut.schemaVersion,
    kind: plan.evidenceCut.kind,
    ordering: plan.evidenceCut.ordering,
    targetRef: plan.target.ref,
    targetSha,
    targetReceiptDigest,
    environmentDigest,
    evaluationPlanDigest: plan.evaluator.evaluationPlanDigest,
    dagPlanDigest: planDigest,
    nodeIds: topologicalOrder(plan).filter((id) => id !== plan.evidenceCut.publisherNodeId),
  };
  const evidenceCutDigest = sha256(canonical(cutMaterial));
  const material = {
    schemaVersion: 1,
    targetRef: plan.target.ref,
    targetSha,
    targetReceiptDigest,
    environmentDigest,
    evaluationPlanDigest: plan.evaluator.evaluationPlanDigest,
    dagPlanDigest: planDigest,
    evidenceCutDigest,
  };
  return {
    ...material,
    bindingDigest: sha256(canonical(material)),
    environment,
    cutMaterial,
  };
}

export function expandToken(value, tokens) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/gu, (match, name) => {
    if (!(name in tokens)) throw new Error(`unknown release DAG token ${match}`);
    return String(tokens[name]);
  });
}

export function expandedNode(node, tokens) {
  return {
    ...node,
    command: node.command.map((part) => expandToken(part, tokens)),
    outputs: node.outputs.map((part) => expandToken(part, tokens)),
    environment: Object.fromEntries(Object.entries(node.environment ?? {})
      .map(([key, value]) => [key, expandToken(value, tokens)])),
  };
}

function exactBinding(receipt, binding) {
  const fields = [
    'targetSha',
    'targetReceiptDigest',
    'environmentDigest',
    'evaluationPlanDigest',
    'dagPlanDigest',
    'evidenceCutDigest',
    'bindingDigest',
  ];
  return fields.every((field) => receipt?.binding?.[field] === binding[field]);
}

export function checkpointReuseDecision({ receipt, node, binding, artifactsValid = true }) {
  if (!node.cacheable) return { reusable: false, reason: 'NODE_NOT_CACHEABLE' };
  if (!receipt) return { reusable: false, reason: 'CHECKPOINT_MISSING' };
  if (receipt.nodeId !== node.id) return { reusable: false, reason: 'NODE_MISMATCH' };
  if (receipt.state !== 'SUCCESS' || receipt.exitCode !== 0) {
    return { reusable: false, reason: 'CHECKPOINT_NOT_SUCCESSFUL' };
  }
  if (!exactBinding(receipt, binding)) return { reusable: false, reason: 'STALE_BINDING' };
  if (receipt.commandDigest !== commandDigest(node.command)) {
    return { reusable: false, reason: 'STALE_COMMAND' };
  }
  if (!artifactsValid) return { reusable: false, reason: 'ARTIFACT_MISMATCH' };
  return { reusable: true, reason: 'EXACT_SUCCESS_CHECKPOINT' };
}

export function resumeProjection({ plan, binding, receipts, artifactsValid = () => true }) {
  validatePlan(plan);
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const reusable = new Set();
  const invalid = new Map();
  const order = topologicalOrder(plan);
  for (const id of order) {
    const node = nodes.get(id);
    let decision = checkpointReuseDecision({
      receipt: receipts.get(node.id),
      node,
      binding,
      artifactsValid: artifactsValid(node.id),
    });
    if (decision.reusable && node.dependsOn.some((dependency) => !reusable.has(dependency))) {
      decision = { reusable: false, reason: 'STALE_DEPENDENCY' };
    }
    if (decision.reusable) reusable.add(node.id);
    else invalid.set(node.id, decision.reason);
  }
  const incomplete = order.filter((id) => !reusable.has(id));
  const ready = incomplete.filter((id) => nodes.get(id).dependsOn.every((dep) => reusable.has(dep)));
  return { reusable, invalid, incomplete, ready };
}

function firstNumber(value, paths) {
  for (const path of paths) {
    let current = value;
    for (const part of path) current = current?.[part];
    if (typeof current === 'number' && Number.isFinite(current)) return current;
  }
  return null;
}

function tapMetrics(raw) {
  const count = (name) => [...raw.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))]
    .reduce((total, match) => total + Number(match[1]), 0);
  return { tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped') };
}

function goMetrics(raw) {
  const terminal = raw.split('\n').filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value.Test && ['pass', 'fail', 'skip'].includes(value.Action) ? [value.Action] : [];
    } catch {
      return [];
    }
  });
  return {
    tests: terminal.length,
    passed: terminal.filter((action) => action === 'pass').length,
    failed: terminal.filter((action) => action === 'fail').length,
    skipped: terminal.filter((action) => action === 'skip').length,
  };
}

function swiftMetrics(raw) {
  const xctest = [...raw.matchAll(
    /Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?(\d+) failures?/gu,
  )].map((match) => ({
    tests: Number(match[1]), skipped: Number(match[2] ?? 0), failed: Number(match[3]),
  }));
  const swiftTesting = [...raw.matchAll(/Test run with (\d+) tests passed/giu)]
    .map((match) => ({ tests: Number(match[1]), skipped: 0, failed: 0 }));
  const widest = [...xctest, ...swiftTesting].sort((a, b) => b.tests - a.tests)[0]
    ?? { tests: 0, skipped: 0, failed: 0 };
  return { ...widest, passed: widest.tests - widest.failed - widest.skipped };
}

export function metricsFromArtifact(file) {
  const raw = readFileSync(file, 'utf8');
  if (file.endsWith('.jsonl')) return goMetrics(raw);
  if (file.endsWith('.tap')) return tapMetrics(raw);
  if (file.endsWith('.log')) return swiftMetrics(raw);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { tests: 0, passed: 0, failed: 0, skipped: 0 };
  }
  if (typeof value.numTotalTests === 'number') {
    return {
      tests: value.numTotalTests,
      passed: value.numPassedTests,
      failed: value.numFailedTests,
      skipped: value.numPendingTests,
    };
  }
  if (value.suite === 'outcome-reconciler-full-clients') {
    const parts = ['shared', 'web', 'go', 'swift'].map((name) => value[name]?.summary);
    if (parts.every((part) => part && typeof part.tests === 'number')) {
      return parts.reduce((total, part) => ({
        tests: total.tests + part.tests,
        passed: total.passed + part.passed,
        failed: total.failed + part.failed,
        skipped: total.skipped + part.skipped,
      }), { tests: 0, passed: 0, failed: 0, skipped: 0 });
    }
  }
  const tests = firstNumber(value, [
    ['tests'], ['summary', 'tests'], ['tests', 'count'], ['executions'], ['aggregate', 'tests'],
    ['regression', 'summary', 'tests'],
  ]) ?? 0;
  const passed = firstNumber(value, [
    ['passed'], ['summary', 'passed'], ['tests', 'passed'], ['results', 'passed'],
    ['regression', 'summary', 'passed'],
  ]) ?? tests;
  const failed = firstNumber(value, [
    ['failed'], ['summary', 'failed'], ['tests', 'failed'], ['results', 'failed'],
    ['regression', 'summary', 'failed'],
  ]) ?? 0;
  const skipped = firstNumber(value, [
    ['skipped'], ['skip'], ['skipCount'], ['summary', 'skipped'], ['tests', 'skipped'],
    ['tests', 'skip'], ['regression', 'summary', 'skipped'],
  ]) ?? 0;
  return { tests, passed, failed, skipped };
}

export function metricsForNode(node, outputFiles) {
  if (!node.testBearing) return { tests: 0, passed: 0, failed: 0, skipped: 0 };
  const candidates = outputFiles.filter((file) => existsSync(file));
  if (candidates.length === 0) throw new Error(`${node.id} produced no metric artifact`);
  const observed = candidates.map(metricsFromArtifact);
  const failed = observed.reduce((total, metrics) => total + metrics.failed, 0);
  const skipped = observed.reduce((total, metrics) => total + metrics.skipped, 0);
  if (failed !== 0) throw new Error(`${node.id} published ${failed} failures`);
  if (skipped !== 0) throw new Error(`${node.id} published ${skipped} skips`);
  const metrics = observed.sort((a, b) => b.tests - a.tests)[0];
  if (metrics.tests <= 0) throw new Error(`${node.id} published no positive test denominator`);
  if (metrics.passed !== metrics.tests) {
    throw new Error(`${node.id} passed ${metrics.passed}/${metrics.tests}`);
  }
  return metrics;
}

export function resourceFits(node, inUse, limits, runningCount) {
  if (runningCount >= limits.maxConcurrent) return false;
  return Object.entries(node.resources ?? {}).every(([name, amount]) => (
    (inUse[name] ?? 0) + amount <= limits[name]
  ));
}

export function addResources(inUse, node, direction = 1) {
  const next = { ...inUse };
  for (const [name, amount] of Object.entries(node.resources ?? {})) {
    next[name] = (next[name] ?? 0) + (direction * amount);
    if (next[name] < 0) throw new Error(`resource ${name} became negative`);
  }
  return next;
}

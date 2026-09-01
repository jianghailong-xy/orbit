import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const SHA = /^[0-9a-f]{40}$/u;
export const DIGEST = /^[0-9a-f]{64}$/u;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const MAX_NODE_TIMEOUT_SECONDS = 3600;

// The five ways an attempt can stop. Only EXITED carries a product verdict: it ran the
// command to completion and the exit code is the answer. The other four say the run never
// got to answer, which is a different fact and gets a different retry budget below.
export const TERMINATION_TYPES = [
  'EXITED', 'INFRASTRUCTURE_LOST', 'TIMED_OUT', 'SIGNALED', 'START_FAILED',
];
// A budget is a budget: no termination type may declare more than this many automatic
// retries, so "retry the infrastructure" can never become an unbounded loop.
export const MAX_AUTOMATIC_RETRIES_PER_TERMINATION = 3;

// Admission refusals are typed because a caller has to be able to tell "this plan cannot
// fit" from "this plan is malformed" without reading English. Every field a reader needs
// to act on -- which path, how much over -- is on the error, not only in the message.
export class ReleaseDagAdmissionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReleaseDagAdmissionError';
    this.code = code;
    Object.assign(this, details);
  }
}

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

// The longest chain of declared timeouts through the dependency graph: the wall clock a
// scheduler must be able to spend before the DAG can possibly finish, no matter how much
// concurrency it has. Nothing here models resource contention -- that can only make a run
// slower, so this is a lower bound on the worst case and an admission test can be built on
// it. Ties break on the first-declared node so the reported path is deterministic.
export function criticalPath(plan) {
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const longest = new Map();
  let worst = { seconds: 0, path: [] };
  for (const id of topologicalOrder(plan)) {
    const node = byId.get(id);
    let prefix = { seconds: 0, path: [] };
    for (const dependency of node.dependsOn) {
      const candidate = longest.get(dependency);
      if (candidate.seconds > prefix.seconds) prefix = candidate;
    }
    const here = { seconds: prefix.seconds + node.timeoutSeconds, path: [...prefix.path, id] };
    longest.set(id, here);
    if (here.seconds > worst.seconds) worst = here;
  }
  return worst;
}

// What the calibration says a node's timeout may not go below. A node with no completed
// observation is not calibrated at all: `null` means "no floor is derivable", never zero.
export function calibratedFloorSeconds(plan, nodeId) {
  const calibration = plan.timeoutCalibration;
  const observed = calibration?.observedMaximumSeconds?.[nodeId];
  if (!Number.isInteger(observed) || !Number.isFinite(calibration?.marginFactor)) return null;
  return Math.ceil(observed * calibration.marginFactor);
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
  // Untyped retry stays banned: nothing may re-run an attempt without first asking what
  // stopped it. `retryBudgets` is where that question gets answered, one budget per type.
  if (plan.evaluator.automaticRetries !== 0) throw new Error('the formal evaluator may not retry in place');
  const budgets = plan.evaluator.retryBudgets;
  const byTermination = budgets?.byTerminationType;
  if (budgets?.schemaVersion !== 1
      || budgets.admissionOnRetry !== 'FULL_PLAN_REVALIDATION'
      || budgets.observability !== 'PER_ATTEMPT_TERMINATION_TYPE_RECORDED_ON_THE_ATTEMPT_MANIFEST'
      || typeof byTermination !== 'object' || byTermination === null
      || Object.keys(byTermination).length !== TERMINATION_TYPES.length
      || TERMINATION_TYPES.some((type) => !Number.isInteger(byTermination[type])
        || byTermination[type] < 0
        || byTermination[type] > MAX_AUTOMATIC_RETRIES_PER_TERMINATION)) {
    throw new ReleaseDagAdmissionError(
      'RELEASE_DAG_RETRY_BUDGETS_INCOMPLETE',
      'every termination type must declare a bounded automatic retry budget',
      { terminationTypes: TERMINATION_TYPES, maxPerType: MAX_AUTOMATIC_RETRIES_PER_TERMINATION },
    );
  }
  // The one budget that is not a judgement call. An EXITED attempt ran the command and the
  // exit code is the product's answer; retrying it until it agrees with us would dilute the
  // criterion into "best of N". Every other type produced no answer to dilute.
  if (byTermination.EXITED !== 0) {
    throw new ReleaseDagAdmissionError(
      'RELEASE_DAG_EXITED_RETRY_BUDGET_MUST_BE_ZERO',
      'a typed EXITED attempt is a product verdict and may never be retried automatically',
      { declared: byTermination.EXITED },
    );
  }
  const totalBudget = TERMINATION_TYPES.reduce((sum, type) => sum + byTermination[type], 0);
  if (!Number.isInteger(budgets.maxTotalAutomaticRetries)
      || budgets.maxTotalAutomaticRetries < 1
      || budgets.maxTotalAutomaticRetries > totalBudget) {
    throw new ReleaseDagAdmissionError(
      'RELEASE_DAG_RETRY_CEILING_UNBOUNDED',
      'the total automatic retry ceiling must be a positive bound no looser than the per-type budgets',
      { maxTotalAutomaticRetries: budgets.maxTotalAutomaticRetries, totalBudget },
    );
  }
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

  const declaredScopes = plan.inputScopes;
  const scopeNames = new Set((declaredScopes?.scopes ?? []).map((scope) => scope.name));
  if (declaredScopes?.schemaVersion !== 1
      || !Array.isArray(declaredScopes.scopes)
      || declaredScopes.scopes.length === 0
      || scopeNames.size !== declaredScopes.scopes.length
      || declaredScopes.scopes.some((scope) => !/^[a-z][a-z0-9-]*$/u.test(scope.name ?? '')
        || !Array.isArray(scope.selectors) || scope.selectors.length === 0)) {
    throw new Error('release DAG input scopes are incomplete');
  }
  const catchAll = declaredScopes.scopes.at(-1);
  if (declaredScopes.catchAllScope !== catchAll.name
      || !catchAll.selectors.some((selector) => selector.prefix === '' && selector.suffix === undefined)) {
    throw new Error('the last input scope must be a declared catch-all over the whole checkout');
  }
  if (!scopeNames.has(declaredScopes.packageLockScope ?? '')
      || !(declaredScopes.scopes.find((scope) => scope.name === declaredScopes.packageLockScope)
        .selectors.some((selector) => selector.path === 'package-lock.json'))) {
    throw new Error('the package lock must belong to a declared input scope');
  }
  if (plan.checkpointPolicy?.reuseKey !== 'PER_NODE_INPUT_DIGEST'
      || plan.checkpointPolicy?.failClosedOnIndeterminateInputs !== true
      || plan.checkpointPolicy?.invalidateOnTargetChange !== true
      || plan.checkpointPolicy?.invalidateOnPlanChange !== true
      || plan.checkpointPolicy?.verifyArtifactDigestsOnReuse !== true) {
    throw new Error('the checkpoint policy must key reuse on fail-closed per-node input digests');
  }

  const ids = new Set();
  for (const node of plan.nodes) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(node.id)) throw new Error(`invalid node id: ${node.id}`);
    if (ids.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
    ids.add(node.id);
    const declared = node.inputs?.scopes;
    if (!Array.isArray(declared) || declared.length === 0
        || new Set(declared).size !== declared.length
        || declared.some((name) => !scopeNames.has(name))
        || !declared.includes(declaredScopes.catchAllScope)
        || !declared.includes(declaredScopes.packageLockScope)) {
      throw new Error(`${node.id} does not declare an exact input scope set`);
    }
    if (!ARTIFACT_BINDINGS.has(node.artifactBinding)) {
      throw new Error(`${node.id} does not declare whether its artifacts embed the round binding`);
    }
    // A checkpoint that outlives its round has to name the same command and the same
    // paths in the next one. Only a token-free node can: ${RUN_ROOT} resolves under the
    // round's binding digest, so a node that carries one stays inside its round.
    if (node.artifactBinding === 'CONTENT_ONLY'
        && /\$\{[A-Z0-9_]+\}/u.test(canonical([node.command, node.outputs, node.environment ?? {}]))) {
      throw new Error(`${node.id} cannot outlive its round: its declaration expands round tokens`);
    }
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
    // A timeout is the answer to "how long before this is wedged", and the only honest
    // source for that is how long the node has actually taken. The margin is a declared
    // multiple of the observed maximum, and it is a FLOOR: a node may be given more head
    // room than that, but never less, and never a number nobody measured.
    const floor = calibratedFloorSeconds(plan, node.id);
    if (floor !== null && node.timeoutSeconds < floor) {
      throw new ReleaseDagAdmissionError(
        'RELEASE_DAG_NODE_TIMEOUT_BELOW_CALIBRATED_FLOOR',
        `${node.id} declares ${node.timeoutSeconds}s but its observed maximum of `
          + `${plan.timeoutCalibration.observedMaximumSeconds[node.id]}s at margin `
          + `${plan.timeoutCalibration.marginFactor} requires at least ${floor}s`,
        {
          nodeId: node.id,
          declaredSeconds: node.timeoutSeconds,
          observedMaximumSeconds: plan.timeoutCalibration.observedMaximumSeconds[node.id],
          marginFactor: plan.timeoutCalibration.marginFactor,
          requiredSeconds: floor,
        },
      );
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

  const calibration = plan.timeoutCalibration;
  const observedMaxima = calibration?.observedMaximumSeconds;
  if (calibration?.schemaVersion !== 1
      || calibration.source !== 'RELEASE_DAG_NODE_RECEIPT_DURATIONS'
      // A run killed by its own timeout never reported how long it needed: TIMED_OUT is a
      // truncation, not an observation, and calibrating on it would ratchet the budget up
      // every time the host was starved. Starvation is what the retry budgets are for.
      || calibration.completedTerminationsOnly !== true
      || !Number.isFinite(calibration.marginFactor) || calibration.marginFactor < 1
      || typeof observedMaxima !== 'object' || observedMaxima === null
      || Object.keys(observedMaxima).length === 0
      || Object.entries(observedMaxima).some(([id, seconds]) => !ids.has(id)
        || !Number.isInteger(seconds) || seconds < 1)) {
    throw new ReleaseDagAdmissionError(
      'RELEASE_DAG_TIMEOUT_CALIBRATION_INCOMPLETE',
      'node timeouts must be calibrated against observed completed durations at a declared margin',
      { source: calibration?.source ?? null, marginFactor: calibration?.marginFactor ?? null },
    );
  }

  // The admission this DAG never performed on itself. Every node timeout can be individually
  // legal and the plan still be impossible: the longest chain of them is the earliest the run
  // can be allowed to finish, and if that exceeds the scheduler deadline the attempt is
  // already over budget before a single node is spawned. Refusing here -- before the target is
  // resolved, before any receipt directory exists -- is the whole point: an infeasible plan
  // must cost nothing.
  const longest = criticalPath(plan);
  if (longest.seconds > plan.evaluator.schedulerDeadlineSeconds) {
    const excessSeconds = longest.seconds - plan.evaluator.schedulerDeadlineSeconds;
    throw new ReleaseDagAdmissionError(
      'RELEASE_DAG_CRITICAL_PATH_EXCEEDS_SCHEDULER_DEADLINE',
      `release DAG critical path exceeds the scheduler deadline by ${excessSeconds}s: `
        + `${longest.path.join(' -> ')} declares ${longest.seconds}s of node timeouts but the `
        + `scheduler deadline admits only ${plan.evaluator.schedulerDeadlineSeconds}s`,
      {
        criticalPath: longest.path,
        criticalPathSeconds: longest.seconds,
        schedulerDeadlineSeconds: plan.evaluator.schedulerDeadlineSeconds,
        excessSeconds,
      },
    );
  }

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
  if (predeployAttestations.length !== 1
      || predeployAttestations.some((node) => node.testBearing !== false)) {
    throw new Error('deployment-only attestations must be typed, deferred and non-test-bearing');
  }
  const releaseBoundaries = plan.nodes.filter((node) => node.kind === 'predeploy-release-boundary');
  if (releaseBoundaries.length !== 1 || releaseBoundaries[0].testBearing !== false
      || writers[0].dependsOn.length !== 1
      || writers[0].dependsOn[0] !== releaseBoundaries[0].id) {
    throw new Error('the legacy live-state boundary must precede the sole publisher');
  }
  return {
    nodeIds: ids,
    order: topologicalOrder(plan),
    evidenceWriter: writers[0].id,
    criticalPath: longest,
  };
}

// ---------------------------------------------------------------------------
// Retry, decided by what stopped the attempt.
//
// Two attempts on 2026-08-31 -- a04bd84d (08:33:44 -> 09:33:55) and e7c287ae
// (09:12:45 -> 10:12:58) -- each burned the full hour and wrote zero bytes. The host had
// 0-3 GiB free and a load average of 101; nothing was learned about the release, and yet
// each one spent a formal attempt as if it had returned a verdict. That is the bug this
// answers: a budget of 0 applied to every termination type equally treats "the product
// failed" and "the machine was starved" as the same fact.
//
// They are not. Retrying an EXITED attempt whose exit code disagrees with us turns one
// criterion into best-of-N and dilutes the evidence. Retrying an INFRASTRUCTURE_LOST
// attempt that produced no output dilutes nothing -- there was no evidence to weaken.
//
// Every decision below re-runs the full admission first. A retry that skipped it could
// re-enter a plan that is no longer feasible, which is exactly what admission exists to
// stop, so "we already admitted this once" is not a reason to skip it.

// terminations: every attempt that has already ended, oldest first, each
// { terminalState } and, for EXITED, { actualExitCode }.
export function retryDecision({ plan, terminations }) {
  if (!Array.isArray(terminations) || terminations.length === 0) {
    throw new Error('a retry decision needs at least one terminated attempt');
  }
  const observedTerminations = terminations.map((termination, index) => {
    if (!TERMINATION_TYPES.includes(termination?.terminalState)) {
      throw new Error(`unknown attempt termination type: ${termination?.terminalState}`);
    }
    return {
      attemptIndex: index,
      terminalState: termination.terminalState,
      actualExitCode: termination.terminalState === 'EXITED'
        ? (termination.actualExitCode ?? null) : null,
    };
  });

  // Admission is re-evaluated on every decision, and its outcome is reported either way, so
  // a caller can prove it ran rather than take the retry on faith.
  let admission;
  try {
    const validation = validatePlan(plan);
    admission = {
      outcome: 'ADMITTED',
      revalidated: true,
      criticalPathSeconds: validation.criticalPath.seconds,
      schedulerDeadlineSeconds: plan.evaluator.schedulerDeadlineSeconds,
    };
  } catch (error) {
    return {
      decision: 'STOP',
      reasonCode: 'ADMISSION_REJECTED',
      admission: {
        outcome: 'REJECTED',
        revalidated: true,
        code: error.code ?? 'RELEASE_DAG_PLAN_INVALID',
        message: error.message,
      },
      observedTerminations,
      retriesUsed: terminations.length - 1,
    };
  }

  const budgets = plan.evaluator.retryBudgets;
  const last = observedTerminations.at(-1);
  const budget = budgets.byTerminationType[last.terminalState];
  const consumed = observedTerminations
    .filter((termination) => termination.terminalState === last.terminalState).length;
  const retriesUsed = terminations.length - 1;
  const shared = {
    admission,
    observedTerminations,
    terminalState: last.terminalState,
    retriesUsed,
    budget,
    consumedForTerminationType: consumed,
    maxTotalAutomaticRetries: budgets.maxTotalAutomaticRetries,
  };
  if (consumed > budget) {
    return {
      ...shared,
      decision: 'STOP',
      reasonCode: budget === 0 ? 'TERMINATION_TYPE_NOT_RETRYABLE' : 'RETRY_BUDGET_EXHAUSTED',
    };
  }
  if (retriesUsed >= budgets.maxTotalAutomaticRetries) {
    return { ...shared, decision: 'STOP', reasonCode: 'TOTAL_RETRY_CEILING_REACHED' };
  }
  return {
    ...shared,
    decision: 'RETRY',
    reasonCode: 'TYPED_INFRASTRUCTURE_TERMINATION_RETRYABLE',
    retryIndex: retriesUsed + 1,
  };
}

// ---------------------------------------------------------------------------
// Per-node input digests.
//
// The evidence a node carries is bound to the exact target SHA. What a node's
// RESULT depends on is not: it is the node's own declaration plus the content of
// the files it actually reads. Those are two different questions, and keying the
// checkpoint on the round-wide bindingDigest answered the second one with the
// first -- one edited spec produced a new SHA, a new binding, and 45 discarded
// receipts. The reuse key below answers only the second question.
//
// Every declared file lands in exactly one scope: the scopes are matched in
// declared order and the last one is a catch-all, so an unfiled file is not
// silently outside the key -- it lands in `unclassified`, which every node
// declares. Anything a node cannot pin down exactly makes it non-reusable.

export const INPUT_DIGEST_SCHEMA_VERSION = 1;
export const ARTIFACT_BINDINGS = new Set(['BINDING_EMBEDDED', 'CONTENT_ONLY']);

function scopeSelectors(plan) {
  const declared = plan?.inputScopes;
  if (declared?.schemaVersion !== 1 || !Array.isArray(declared.scopes)
      || declared.scopes.length === 0) {
    return null;
  }
  return declared.scopes;
}

function selectorMatches(selector, filePath) {
  if (typeof selector.path === 'string') return filePath === selector.path;
  if (typeof selector.prefix !== 'string') return false;
  if (!filePath.startsWith(selector.prefix)) return false;
  return typeof selector.suffix !== 'string' || filePath.endsWith(selector.suffix);
}

// Declared order decides, and the last scope is a catch-all, so this is a total
// function over the checkout: every file has exactly one scope.
export function scopeNameForPath(plan, filePath) {
  const scopes = scopeSelectors(plan);
  if (!scopes) return null;
  for (const scope of scopes) {
    if (scope.selectors.some((selector) => selectorMatches(selector, filePath))) return scope.name;
  }
  return null;
}

// files: [{ path, sha256 }] -- every non-ignored file in the checkout, already digested.
export function scopeDigests(plan, files) {
  const scopes = scopeSelectors(plan);
  if (!scopes) throw new Error('the release DAG plan declares no input scopes');
  const members = new Map(scopes.map((scope) => [scope.name, []]));
  for (const file of files) {
    const name = scopeNameForPath(plan, file.path);
    if (name === null) {
      throw new Error(`${file.path} matches no input scope and no catch-all is declared`);
    }
    members.get(name).push({ path: file.path, sha256: file.sha256 });
  }
  const digests = {};
  for (const [name, entries] of members) {
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    digests[name] = sha256(canonical({ scope: name, files: entries }));
  }
  return digests;
}

// Ignored paths are deliberately outside every scope: build products are node outputs and
// installed dependencies are pinned by the package lock, which is a scope of its own.
export function checkoutScopeDigests(plan, repo) {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const relativePaths = [...new Set(listed.split('\0').filter(Boolean))].sort();
  const files = relativePaths.flatMap((relative) => {
    const file = path.join(repo, relative);
    if (!existsSync(file) || !statSync(file).isFile()) return [];
    return [{ path: relative, sha256: sha256(readFileSync(file)) }];
  });
  return scopeDigests(plan, files);
}

const identityCache = new WeakMap();

// What a dependency contributes to its consumer is its SHAPE, not its content:
// the consumer already carries the content it reads through its own scopes.
// Mixing the dependency's content in here is what made a spec-only edit rebuild
// Swift -- prepare-build compiles every spec, so its content moves every round.
export function nodeIdentityDigest(plan, nodeId) {
  let cache = identityCache.get(plan);
  if (!cache) {
    cache = new Map();
    identityCache.set(plan, cache);
  }
  if (cache.has(nodeId)) return cache.get(nodeId);
  const node = plan.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`unknown release DAG node ${nodeId}`);
  cache.set(nodeId, null); // cycle guard; topologicalOrder already rejects real cycles
  const dependencies = {};
  for (const dependency of [...node.dependsOn].sort()) {
    dependencies[dependency] = nodeIdentityDigest(plan, dependency);
  }
  const digest = sha256(canonical({
    schemaVersion: INPUT_DIGEST_SCHEMA_VERSION,
    nodeId: node.id,
    kind: node.kind,
    commandDigest: commandDigest(node.command),
    outputs: node.outputs,
    environment: node.environment ?? {},
    artifactBinding: node.artifactBinding ?? null,
    dependencies,
  }));
  cache.set(nodeId, digest);
  return digest;
}

// Returns null -- never a guess -- when the node's input set cannot be pinned
// down exactly. A null key is a rerun, not a reuse.
export function nodeInputs({ plan, node, scopeDigests: digests }) {
  const declared = node?.inputs?.scopes;
  const catchAll = plan?.inputScopes?.catchAllScope;
  if (!Array.isArray(declared) || declared.length === 0 || !digests) return null;
  if (new Set(declared).size !== declared.length) return null;
  if (typeof catchAll !== 'string' || !declared.includes(catchAll)) return null;
  const scopes = {};
  for (const name of [...declared].sort()) {
    const digest = digests[name];
    if (!DIGEST.test(digest ?? '')) return null;
    scopes[name] = digest;
  }
  const dependencies = {};
  for (const dependency of [...node.dependsOn].sort()) {
    const identity = nodeIdentityDigest(plan, dependency);
    if (!DIGEST.test(identity ?? '')) return null;
    dependencies[dependency] = identity;
  }
  return { schemaVersion: INPUT_DIGEST_SCHEMA_VERSION, scopes, dependencies };
}

export function nodeInputDigest({ plan, node, scopeDigests: digests, environmentDigest }) {
  const inputs = nodeInputs({ plan, node, scopeDigests: digests });
  if (!inputs) return null;
  if (!ARTIFACT_BINDINGS.has(node.artifactBinding)) return null;
  // The host is an input too: a different Swift or PostgreSQL image, or a different
  // toolchain, is a different observation even when every source file is identical.
  if (!DIGEST.test(environmentDigest ?? '')) return null;
  return sha256(canonical({
    schemaVersion: INPUT_DIGEST_SCHEMA_VERSION,
    kind: 'orbit.outcome-reconciler.release-dag-node-input',
    nodeId: node.id,
    nodeKind: node.kind,
    commandDigest: commandDigest(node.command),
    outputs: node.outputs,
    environment: node.environment ?? {},
    timeoutSeconds: node.timeoutSeconds,
    resources: node.resources ?? {},
    partition: node.partition ?? null,
    scale: node.scale ?? null,
    postgresTemplate: node.postgresTemplate ?? null,
    postgresPolicy: plan.postgresIsolation?.nodes?.[node.id] ?? null,
    postgresAllocator: plan.postgresIsolation?.allocator ?? null,
    postgresConcurrentShardPolicy: plan.postgresIsolation?.concurrentShardPolicy ?? null,
    usesSharedBuild: node.usesSharedBuild === true,
    usesSharedPostgres: node.usesSharedPostgres === true,
    testBearing: node.testBearing === true,
    artifactBinding: node.artifactBinding,
    environmentIdentity: plan.environment.identity,
    environmentDigest,
    postgresImage: plan.environment.postgresImage,
    swiftImage: plan.environment.swiftImage,
    evaluationPlanDigest: plan.evaluator.evaluationPlanDigest,
    evaluationPhase: plan.evaluator.phase,
    resourceLimits: plan.resourceLimits,
    hostResourceEnvelope: plan.hostResourceEnvelope,
    targetRef: plan.target.ref,
    inputs,
  }));
}

export function nodeInputDigests({ plan, scopeDigests: digests, environmentDigest }) {
  const computed = new Map();
  for (const node of plan.nodes) {
    computed.set(node.id, {
      inputDigest: nodeInputDigest({ plan, node, scopeDigests: digests, environmentDigest }),
      inputs: nodeInputs({ plan, node, scopeDigests: digests }),
    });
  }
  return computed;
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

export function checkpointReuseDecision({
  receipt, node, binding, artifactsValid = true, inputDigest = undefined, inputs = undefined,
}) {
  if (!node.cacheable) return { reusable: false, reason: 'NODE_NOT_CACHEABLE' };
  if (!receipt) return { reusable: false, reason: 'CHECKPOINT_MISSING' };
  if (receipt.nodeId !== node.id) return { reusable: false, reason: 'NODE_MISMATCH' };
  if (receipt.state !== 'SUCCESS' || receipt.exitCode !== 0) {
    return { reusable: false, reason: 'CHECKPOINT_NOT_SUCCESSFUL' };
  }
  // Fail closed: an input set that could not be pinned down exactly, or a checkpoint
  // that predates input digests, is reran rather than guessed at.
  if (!DIGEST.test(inputDigest ?? '') || !inputs) {
    return { reusable: false, reason: 'INDETERMINATE_INPUTS' };
  }
  if (!DIGEST.test(receipt.inputDigest ?? '')) {
    return { reusable: false, reason: 'INDETERMINATE_INPUTS' };
  }
  if (receipt.inputDigest !== inputDigest) {
    // A dependency whose declaration moved invalidates its consumers exactly as
    // STALE_DEPENDENCY always did; anything else is this node's own input set.
    const staleDependency = canonical(receipt.inputs?.dependencies ?? null)
      !== canonical(inputs.dependencies);
    return { reusable: false, reason: staleDependency ? 'STALE_DEPENDENCY' : 'STALE_INPUTS' };
  }
  // Artifacts that carry the round's binding cannot be handed to a different round.
  if (node.artifactBinding === 'BINDING_EMBEDDED' && !exactBinding(receipt, binding)) {
    return { reusable: false, reason: 'STALE_BINDING' };
  }
  if (receipt.commandDigest !== commandDigest(node.command)) {
    return { reusable: false, reason: 'STALE_COMMAND' };
  }
  if (!artifactsValid) return { reusable: false, reason: 'ARTIFACT_MISMATCH' };
  return { reusable: true, reason: 'EXACT_SUCCESS_CHECKPOINT' };
}

export function resumeProjection({
  plan, binding, receipts, artifactsValid = () => true, scopeDigests: digests,
}) {
  validatePlan(plan);
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const computed = nodeInputDigests({
    plan,
    scopeDigests: digests,
    environmentDigest: binding?.environmentDigest,
  });
  const reusable = new Set();
  const invalid = new Map();
  const order = topologicalOrder(plan);
  for (const id of order) {
    const node = nodes.get(id);
    const { inputDigest, inputs } = computed.get(id) ?? {};
    const decision = checkpointReuseDecision({
      receipt: receipts.get(node.id),
      node,
      binding,
      artifactsValid: artifactsValid(node.id),
      inputDigest,
      inputs,
    });
    if (decision.reusable) reusable.add(node.id);
    else invalid.set(node.id, decision.reason);
  }
  const incomplete = order.filter((id) => !reusable.has(id));
  const ready = incomplete.filter((id) => nodes.get(id).dependsOn.every((dep) => reusable.has(dep)));
  return { reusable, invalid, incomplete, ready, inputDigests: computed };
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

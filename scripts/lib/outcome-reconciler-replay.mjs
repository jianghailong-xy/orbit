import assert from 'node:assert/strict';

import { canonicalJson, sha256Canonical } from './outcome-reconciler-v2.mjs';

export const REPLAY_SURFACES = Object.freeze([
  'DONE_GATE',
  'AGENT_QUEUE',
  'OWNER_DECISION_INBOX',
  'PROJECT_ATTENTION',
  'MUTATION_RESPONSE',
  'WEB',
]);

const DIGEST = /^[0-9a-f]{64}$/;

export function validateReplayCatalog(fixtures, categoryMinimums) {
  assert.ok(Array.isArray(fixtures) && fixtures.length > 0, 'replay fixture catalog is empty');
  assert.equal(new Set(fixtures.map(({ id }) => id)).size, fixtures.length,
    'replay fixture ids must be unique');
  for (const fixture of fixtures) {
    assert.match(fixture.id, /^[a-z0-9][a-z0-9-]+$/, `${fixture.id}: invalid id`);
    assert.ok(fixture.category, `${fixture.id}: category is required`);
    assert.ok(fixture.scenario, `${fixture.id}: scenario is required`);
    assert.ok(fixture.source && typeof fixture.source === 'object', `${fixture.id}: source is required`);
    assert.match(fixture.sourceHash, DIGEST, `${fixture.id}: sourceHash is invalid`);
    assert.equal(fixture.sourceHash, sha256Canonical(fixture.source),
      `${fixture.id}: sourceHash does not bind the source record`);
    assert.ok(fixture.input && typeof fixture.input === 'object', `${fixture.id}: input is required`);
    assert.ok(fixture.expectedTransition && typeof fixture.expectedTransition === 'object',
      `${fixture.id}: expected transition is required`);
    assert.ok(fixture.expectedFinalObligation && typeof fixture.expectedFinalObligation === 'object',
      `${fixture.id}: final obligation is required`);
    for (const field of ['requestedDeadlineSeconds', 'effectiveDeadlineSeconds']) {
      assert.ok(fixture[field] === null || (Number.isSafeInteger(fixture[field]) && fixture[field] > 0),
        `${fixture.id}: ${field} must be null or a positive integer`);
    }
  }
  for (const [category, minimum] of Object.entries(categoryMinimums)) {
    assert.ok(fixtures.filter((fixture) => fixture.category === category).length >= minimum,
      `${category} has fewer than ${minimum} fixtures`);
  }
  return true;
}

export function summarizeObligation(obligation, fallback) {
  if (!obligation) return { ...fallback };
  return {
    obligationId: obligation.obligationId,
    obligationRevision: obligation.obligationRevision,
    kind: obligation.kind,
    state: obligation.state,
    owner: obligation.owner,
    reasonCode: obligation.reason.code,
    bindingDigest: sha256Canonical(obligation.binding),
    blocksClosureOf: [...obligation.blocksClosureOf],
  };
}

export function projectCanonicalObligation(obligation, evaluatedThroughLogicalTime) {
  assert.ok(obligation?.obligationId, 'a canonical obligation is required');
  return Object.fromEntries(REPLAY_SURFACES.map((surface) => [surface, {
    surface,
    obligationId: obligation.obligationId,
    obligationRevision: obligation.obligationRevision,
    bindingDigest: sha256Canonical(obligation.binding),
    owner: obligation.owner,
    reasonCode: obligation.reason.code,
    evaluatedThroughLogicalTime,
  }]));
}

export function assertSurfaceAgreement(projections) {
  assert.deepEqual(Object.keys(projections), [...REPLAY_SURFACES]);
  const values = Object.values(projections);
  const canonical = values.map(({ surface: _surface, ...value }) => canonicalJson(value));
  assert.equal(new Set(canonical).size, 1, 'canonical surfaces disagree about the obligation');
  return true;
}

export function replayBoundaryDecision(input) {
  if (input.presentedRole === 'OWNER' && input.credentialProvenance !== 'OWNER_AUTHENTICATED_CHANNEL') {
    return { allowed: false, reasonCode: 'OWNER_CREDENTIAL_PROVENANCE_UNTRUSTED' };
  }
  if (input.executionEnvironment === 'ACCEPTANCE_FIXTURE'
      && input.targetEnvironment === 'PRODUCTION'
      && input.productionGrantDigest === null) {
    return { allowed: false, reasonCode: 'PRODUCTION_TARGET_OUTSIDE_FIXTURE_AUTHORITY' };
  }
  return { allowed: true, reasonCode: 'BOUNDARY_SATISFIED' };
}

export function replayActionDecision(envelope, context) {
  if (context.revokedAtLogicalTime !== null
      && BigInt(context.revokedAtLogicalTime) <= BigInt(envelope.evaluatedThroughLogicalTime)) {
    return { allowed: false, reasonCode: 'AUTHORITY_REVOKED_AT_COMMIT' };
  }
  return { allowed: true, reasonCode: 'ACTION_COMMIT_AUTHORIZED' };
}

/**
 * Reconstruct a typed replay fact without editing the historical row. Exit -1 alone is explicitly
 * insufficient: the old runner deadline, elapsed interval, truncated 12/13 TAP stream and an
 * independent watchdog deadline observation must all bind the same source attempt.
 */
export function reconstructLegacyTimedOutAttempt(observation) {
  assert.equal(observation.legacyTermination, 'UNTYPED', 'legacy audit must remain UNTYPED');
  assert.equal(observation.legacyExitCode, -1, 'the named historical observation is exit -1');
  assert.ok(Number.isSafeInteger(observation.requestedDeadlineSeconds)
    && observation.requestedDeadlineSeconds > 0, 'requested deadline is required');
  assert.ok(Number.isSafeInteger(observation.runnerHardMaxSeconds)
    && observation.runnerHardMaxSeconds > 0, 'runner hard max is required');
  assert.ok(observation.elapsedMilliseconds >= observation.runnerHardMaxSeconds * 1_000,
    'elapsed evidence does not reach the runner deadline');
  assert.equal(observation.outputStreamComplete, false,
    'a complete output stream contradicts the named legacy timeout evidence');
  assert.ok(observation.lastObservedPassingSubtest < observation.declaredSubtestCount,
    'the captured TAP is not truncated before the declared final subtest');
  assert.equal(observation.watchdog?.deadlineObserved, true,
    'independent watchdog deadline evidence is required');
  assert.equal(observation.watchdog?.sourceSessionId, observation.sourceSessionId,
    'watchdog evidence is not bound to the source attempt');
  const evidence = {
    sourceTaskId: observation.sourceTaskId,
    sourceSessionId: observation.sourceSessionId,
    legacyTermination: observation.legacyTermination,
    legacyExitCode: observation.legacyExitCode,
    requestedDeadlineSeconds: observation.requestedDeadlineSeconds,
    effectiveDeadlineSeconds: observation.runnerHardMaxSeconds,
    elapsedMilliseconds: observation.elapsedMilliseconds,
    outputStreamComplete: observation.outputStreamComplete,
    lastObservedPassingSubtest: observation.lastObservedPassingSubtest,
    declaredSubtestCount: observation.declaredSubtestCount,
    watchdogEvidenceDigest: sha256Canonical(observation.watchdog),
  };
  return {
    attemptId: sha256Canonical({ kind: 'REPLAYED_TYPED_ATTEMPT', evidence }),
    attemptGeneration: String(observation.attemptGeneration),
    status: 'CLOSED',
    outcome: 'TIMED_OUT',
    terminationKind: 'TIMED_OUT',
    requestedDeadlineSeconds: observation.requestedDeadlineSeconds,
    effectiveDeadlineSeconds: observation.runnerHardMaxSeconds,
    evidence,
    evidenceDigest: sha256Canonical(evidence),
    historicalAuditMutation: 'NONE',
  };
}

export function syntheticInputCut(fixtureId, inputBinding, material) {
  const factSetDigest = sha256Canonical(material);
  return {
    cutId: `synthetic-cut:${fixtureId}`,
    watermarkLogicalTime: '1',
    factCount: Array.isArray(material) ? material.length : 1,
    factSetDigest,
    complete: true,
    linearizable: true,
    bindingDigest: sha256Canonical(inputBinding),
  };
}

export function makeProofLeaves(entries) {
  return entries.map(([claim, value, evidence = null]) => ({
    claim,
    value,
    evidenceDigest: sha256Canonical(evidence ?? { claim, value }),
  }));
}

export function proofDigest(proofLeaves) {
  return sha256Canonical(proofLeaves);
}

export function makeTrace({
  fixture,
  targetSha,
  inputBinding,
  inputCut,
  actualTransition,
  proofLeaves,
  finalObligation,
  detail = {},
}) {
  assert.match(targetSha, /^[0-9a-f]{40}$/, `${fixture.id}: target SHA is not exact`);
  assert.deepEqual(actualTransition, fixture.expectedTransition,
    `${fixture.id}: replay transition differs from the expected transition`);
  const trace = {
    fixtureId: fixture.id,
    category: fixture.category,
    scenario: fixture.scenario,
    sourceRef: fixture.source.ref,
    sourceHash: fixture.sourceHash,
    targetSha,
    inputBinding,
    bindingDigest: sha256Canonical(inputBinding),
    inputCut,
    requestedDeadlineSeconds: fixture.requestedDeadlineSeconds,
    effectiveDeadlineSeconds: fixture.effectiveDeadlineSeconds,
    terminationKind: fixture.terminationKind,
    expectedTransition: fixture.expectedTransition,
    actualTransition,
    proofLeaves,
    proofDigest: proofDigest(proofLeaves),
    finalObligation,
    detail,
  };
  assert.equal(inputCut.bindingDigest, trace.bindingDigest,
    `${fixture.id}: input cut is not bound to the trace binding`);
  return trace;
}

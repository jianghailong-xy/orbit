#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [phase, ledgerArgument, outputArgument] = process.argv.slice(2);
assert.ok(['prebinding', 'final'].includes(phase),
  'usage: outcome-reconciler-release-frontier-manifest.mjs prebinding|final LEDGER OUTPUT');
assert.ok(ledgerArgument && outputArgument);
const repo = path.resolve(import.meta.dirname, '..');
const contract = JSON.parse(readFileSync(path.join(
  repo, 'contracts/outcome-reconciler-release-frontier.json',
), 'utf8'));
const ledgerPath = path.resolve(ledgerArgument);
const outputPath = path.resolve(outputArgument);

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key])}`
  )).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileEvidence(relative) {
  const absolute = path.join(repo, relative);
  assert.ok(existsSync(absolute) && statSync(absolute).isFile(), `${relative} is missing`);
  const raw = readFileSync(absolute);
  assert.ok(raw.byteLength > 0, `${relative} is empty`);
  return { path: relative, bytes: raw.byteLength, sha256: sha256(raw) };
}

function numericLeaves(value, names, at = '$', found = []) {
  if (value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => numericLeaves(entry, names, `${at}[${index}]`, found));
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key) && typeof child === 'number') found.push({ path: `${at}.${key}`, value: child });
    numericLeaves(child, names, `${at}.${key}`, found);
  }
  return found;
}

function positiveTestSamples(value, at = '$', found = []) {
  if (value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => positiveTestSamples(entry, `${at}[${index}]`, found));
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'tests' || key === 'executions') && typeof child === 'number' && child > 0) {
      found.push({ path: `${at}.${key}`, value: child });
    }
    positiveTestSamples(child, `${at}.${key}`, found);
  }
  return found;
}

const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repo, encoding: 'utf8',
}).trim();
assert.match(targetSha, /^[0-9a-f]{40}$/u);

const ledgerRaw = readFileSync(ledgerPath, 'utf8');
const runs = ledgerRaw.trim().split('\n').filter(Boolean).map((line) => {
  const [name, packageScript, exitCodeText, log] = line.split('\t');
  assert.ok(name && packageScript && exitCodeText && log, `invalid execution ledger line: ${line}`);
  const exitCode = Number(exitCodeText);
  assert.equal(exitCode, 0, `${name} exited ${exitCode}`);
  return { name, packageScript, exitCode, log: fileEvidence(log) };
});
const declaredSuites = [
  ...contract.namedSuites,
  ...contract.restoredSuites,
  ...contract.fullMatrices,
];
const expectedRunNames = [
  ...declaredSuites.map((suite) => suite.name),
  'authoritative-target',
  ...(phase === 'final' ? ['release-live-state'] : []),
];
assert.deepEqual(runs.map((run) => run.name), expectedRunNames,
  'execution ledger does not contain the complete declared matrix in order');
assert.equal(new Set(runs.map((run) => run.name)).size, runs.length,
  'an acceptance entrypoint was executed more than once in the ledger');

const manifestRows = declaredSuites.map((suite) => {
  const file = fileEvidence(suite.manifest);
  const value = JSON.parse(readFileSync(path.join(repo, suite.manifest), 'utf8'));
  if (value.outcome !== undefined) assert.equal(value.outcome, 'PASS', `${suite.name} is not PASS`);
  const boundTarget = value.targetSha
    ?? value.sourceSha
    ?? value.refs?.declaredTarget
    ?? value.repository?.targetSha;
  assert.equal(boundTarget, targetSha, `${suite.name} is not bound to the target SHA`);
  const failures = numericLeaves(value, new Set(['fail', 'failed', 'failedFiles']));
  const skips = numericLeaves(value, new Set(['skip', 'skipped', 'skipCount']));
  const cancelled = numericLeaves(value, new Set(['cancelled', 'todo']));
  for (const entry of [...failures, ...skips, ...cancelled]) {
    assert.equal(entry.value, 0, `${suite.name} contains ${entry.path}=${entry.value}`);
  }
  const samples = positiveTestSamples(value);
  assert.ok(samples.length > 0, `${suite.name} published no positive test denominator`);
  return {
    name: suite.name,
    packageScript: suite.packageScript,
    manifest: file,
    manifestDigest: value.manifestDigest ?? value.attestationDigest ?? file.sha256,
    samples,
    failures,
    skips,
    cancelled,
  };
});

const watchdog = JSON.parse(readFileSync(path.join(
  repo, 'build/outcome-reconciler-v2-watchdog-manifest.json',
), 'utf8'));
assert.equal(watchdog.tests, 13);
assert.equal(watchdog.passed, 13);
assert.equal(watchdog.failed, 0);
assert.equal(watchdog.skipped, 0);
assert.equal(watchdog.postgres.version, contract.postgres.version);
assert.ok(Number(watchdog.postgres.migrations) >= contract.postgres.minimumMigrations);
const capacity = JSON.parse(readFileSync(path.join(
  repo, 'build/outcome-reconciler-v2-watchdog-capacity-manifest.json',
), 'utf8'));
assert.equal(capacity.outcome, 'PASS');
assert.equal(capacity.targetSha, targetSha);
assert.ok(capacity.scale.tasks >= 110_000 && capacity.scale.tasks <= 112_000);
assert.equal(capacity.replay.samples, capacity.scale.tasks);
assert.equal(capacity.indexes.requiredCount, 9);
assert.equal(capacity.indexes.actualHitCount, 9);

const fullApi = JSON.parse(readFileSync(path.join(
  repo, 'build/outcome-reconciler-full-api-manifest.json',
), 'utf8'));
assert.equal(fullApi.outcome, 'PASS');
assert.ok(fullApi.summary.tests >= 2_800);
assert.equal(fullApi.summary.passed, fullApi.summary.tests);
assert.equal(fullApi.summary.failed, 0);
assert.equal(fullApi.summary.skipped, 0);
assert.equal(fullApi.postgres.version, contract.postgres.version);
assert.ok(fullApi.postgres.migrations >= contract.postgres.minimumMigrations);
const fullClients = JSON.parse(readFileSync(path.join(
  repo, 'build/outcome-reconciler-full-clients-manifest.json',
), 'utf8'));
assert.equal(fullClients.outcome, 'PASS');
for (const client of ['shared', 'web', 'go', 'swift']) {
  assert.ok(fullClients[client].summary.tests > 0);
  assert.equal(fullClients[client].summary.passed, fullClients[client].summary.tests);
  assert.equal(fullClients[client].summary.failed, 0);
  assert.equal(fullClients[client].summary.skipped, 0);
}

const authoritative = JSON.parse(readFileSync(path.join(
  repo, 'build/outcome-reconciler-authoritative-target-manifest.json',
), 'utf8'));
assert.equal(authoritative.outcome, 'PASS');
assert.equal(authoritative.refs.declaredTarget, targetSha);
assert.equal(authoritative.refs.originMain, targetSha);
assert.equal(authoritative.refs.remoteHeadsMain, targetSha);
assert.equal(authoritative.nonForcePushReceipt.sourceSha, targetSha);
assert.equal(authoritative.nonForcePushReceipt.targetShaAfter, targetSha);
assert.equal(authoritative.immutableVerifier.unchanged, true);

let live = null;
if (phase === 'final') {
  live = JSON.parse(readFileSync(path.join(
    repo, 'build/outcome-reconciler-release-live-state-manifest.json',
  ), 'utf8'));
  assert.equal(live.outcome, 'PASS');
  assert.equal(live.targetSha, targetSha);
  assert.notEqual(live.canonicalState.doneGate?.reason?.code, 'CURRENT_BINDING_MISSING');
  assert.equal(live.ownerRatification.effective, true);
  assert.equal(live.ownerRatification.contractDigest,
    contract.ownerRatification.contractDigest);
  assert.equal(live.runtimeBinding.state, 'HEALTHY');
}

const supportingFiles = [
  'build/outcome-reconciler-v2-watchdog-capacity-manifest.json',
  'build/outcome-reconciler-authoritative-target-manifest.json',
  ...(phase === 'final' ? ['build/outcome-reconciler-release-live-state-manifest.json'] : []),
];
const sources = [
  'contracts/outcome-reconciler-release-frontier.json',
  'package.json',
  'scripts/outcome-reconciler-release-frontier.sh',
  'scripts/outcome-reconciler-release-frontier-manifest.mjs',
  'scripts/outcome-reconciler-release-live-state.mjs',
  'scripts/outcome-reconciler-release-publish.mjs',
];
const sourceEvidence = Object.fromEntries(sources.map((relative) => [relative, fileEvidence(relative)]));
const body = {
  schemaVersion: 1,
  kind: phase === 'final'
    ? 'orbit.outcome-reconciler.release-frontier-manifest'
    : 'orbit.outcome-reconciler.release-frontier-prebinding-manifest',
  phase,
  outcome: 'PASS',
  targetSha,
  targetRef: contract.repository.targetRef,
  declared: {
    namedSuites: contract.namedSuites.length,
    restoredSuites: contract.restoredSuites.length,
    fullMatrices: contract.fullMatrices.length,
  },
  executions: runs,
  manifests: manifestRows,
  supportingManifests: supportingFiles.map(fileEvidence),
  aggregate: {
    entrypointsExecuted: contract.namedSuites.length + contract.restoredSuites.length,
    namedSuitesExecuted: contract.namedSuites.length,
    restoredSuitesExecuted: contract.restoredSuites.length,
    fullApi: fullApi.summary,
    clients: Object.fromEntries(['shared', 'web', 'go', 'swift']
      .map((name) => [name, fullClients[name].summary])),
    watchdog: {
      tests: watchdog.tests,
      passed: watchdog.passed,
      failed: watchdog.failed,
      skipped: watchdog.skipped,
      taskScale: capacity.scale.tasks,
      replaySamples: capacity.replay.samples,
      requiredIndexes: capacity.indexes.requiredCount,
      hitIndexes: capacity.indexes.actualHitCount,
    },
    postgres: {
      version: fullApi.postgres.version,
      migrations: fullApi.postgres.migrations,
      systemIdentifier: fullApi.postgres.systemIdentifier,
    },
    totalFailures: 0,
    totalSkips: 0,
  },
  authoritativeTarget: {
    manifestDigest: authoritative.manifestDigest
      ?? fileEvidence('build/outcome-reconciler-authoritative-target-manifest.json').sha256,
    mergeReceipt: authoritative.nonForcePushReceipt,
    immutableVerifierUnchanged: true,
  },
  liveState: live ? {
    manifestDigest: live.manifestDigest,
    ownerRatification: live.ownerRatification,
    bindingDigest: live.canonicalState.binding.digest,
    cutId: live.canonicalState.cut.id,
    releaseEvidenceId: live.releaseEvidence.id,
    releaseEvidenceDigest: live.releaseEvidence.evidenceDigest,
    runtimeBindingDigest: live.runtimeBinding.bindingDigest,
    doneGateReason: live.canonicalState.doneGate?.reason?.code ?? null,
  } : null,
  sourceEvidence,
  sourceDigest: sha256(canonical(sourceEvidence)),
  executionLedger: { ...fileEvidence(path.relative(repo, ledgerPath)), rows: runs.length },
  generatedAt: new Date().toISOString(),
};
const manifestDigest = sha256(canonical(body));
const manifest = { ...body, artifactDigest: manifestDigest, manifestDigest };
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));

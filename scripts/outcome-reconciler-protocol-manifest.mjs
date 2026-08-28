#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FROZEN_OBLIGATION_KINDS,
  sha256Bytes,
  sha256Canonical,
} from './lib/outcome-reconciler-v2.mjs';
import {
  analyzeProtocolGraph,
  assertProtocolRegistry,
  createBuiltinCapabilityCatalog,
  runProtocolConformanceMatrix,
} from './lib/outcome-reconciler-protocol-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tapPath, outputPath] = process.argv.slice(2);
if (!tapPath || !outputPath) {
  throw new Error('usage: outcome-reconciler-protocol-manifest.mjs TAP OUTPUT');
}

function json(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
}

function tapSummary(source) {
  const read = (field) => {
    const matches = [...source.matchAll(new RegExp(`^# ${field} (\\d+)$`, 'gm'))];
    if (matches.length !== 1) throw new Error(`expected exactly one TAP # ${field} summary`);
    return Number(matches[0][1]);
  };
  return {
    tests: read('tests'),
    passed: read('pass'),
    failed: read('fail'),
    cancelled: read('cancelled'),
    skipped: read('skipped'),
    todo: read('todo'),
  };
}

function sourceDigest(relativePaths) {
  const sources = {};
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    sources[relativePath] = sha256Bytes(readFileSync(path.join(root, relativePath)));
  }
  return {
    sources,
    digest: sha256Bytes(
      Object.entries(sources)
        .map(([relativePath, digest]) => `${relativePath}\u0000${digest}`)
        .join('\n'),
    ),
  };
}

const registryPath = 'contracts/outcome-reconciler-v2.protocol-registry.json';
const contractPath = 'contracts/outcome-reconciler-v2.contract.json';
const registry = json(registryPath);
const contract = json(contractPath);
const compiled = assertProtocolRegistry(registry, contract);
const graph = analyzeProtocolGraph(compiled);
const matrix = runProtocolConformanceMatrix(registry, contract);
const tapSource = readFileSync(tapPath, 'utf8');
const summary = tapSummary(tapSource);

if (
  summary.tests <= 0
  || summary.passed !== summary.tests
  || summary.failed !== 0
  || summary.cancelled !== 0
  || summary.skipped !== 0
  || summary.todo !== 0
) {
  throw new Error(`protocol tests are not a complete zero-skip pass: ${JSON.stringify(summary)}`);
}
if (
  matrix.registered !== FROZEN_OBLIGATION_KINDS.length
  || matrix.instantiated !== matrix.registered
  || matrix.executed !== matrix.registered
  || matrix.resolved !== matrix.registered
  || matrix.traces.some((trace) => trace.activeAfter !== false)
) {
  throw new Error(`protocol conformance matrix is incomplete: ${JSON.stringify(matrix)}`);
}

const requiredFaultTests = [
  'deleting a resolver fails build validation and becomes a runtime MODEL_GAP',
  'a declared but uncallable resolver fails build and runtime checks before the action runs',
  'a resolver unreachable from ACTIVE fails build and runtime graph admission',
  'an actor without the declared capability produces a system-owned recoverable fact',
  'a disabled owner is visible and routed to system recovery, never silently back to a person',
  'budget exhaustion is a visible bounded result and does not invoke the action',
  'revoked authority fails closed at commit and names the explicit authorization protocol',
  'policy mismatch fails closed into model diagnosis without invoking the action',
  'wrong project ownership is rejected before action execution with an actionable MODEL_GAP',
  'a closed resolver/prerequisite SCC is detected even though every field is present',
  'a resolver self-loop with no terminal is reported by no-exit analysis',
  'an unknown dynamic obligation type appends MODEL_GAP and queues agent diagnosis',
];
for (const name of requiredFaultTests) {
  if (!tapSource.includes(`- ${name}`)) throw new Error(`required protocol fault test did not execute: ${name}`);
}
for (const kind of FROZEN_OBLIGATION_KINDS) {
  if (!tapSource.includes(`- protocol conformance: ${kind}`)) {
    throw new Error(`registered type was not instantiated by the TAP run: ${kind}`);
  }
}

const sourcePaths = [
  registryPath,
  contractPath,
  'package.json',
  'scripts/lib/outcome-reconciler-v2.mjs',
  'scripts/lib/outcome-reconciler-protocol-registry.mjs',
  'scripts/outcome-reconciler-protocol.sh',
  'scripts/outcome-reconciler-protocol-manifest.mjs',
  'test/outcome-reconciler-v2.protocol.test.mjs',
];
const source = sourceDigest(sourcePaths);
const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const targetBranch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
const capabilityCount = createBuiltinCapabilityCatalog().size;
const manifest = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-protocol',
  outcome: 'PASS',
  targetSha,
  targetBranch,
  registryVersion: compiled.registryVersion,
  contractVersion: compiled.contractVersion,
  tests: summary.tests,
  passed: summary.passed,
  failed: summary.failed,
  skip: summary.skipped,
  skipped: summary.skipped,
  cancelled: summary.cancelled,
  todo: summary.todo,
  registeredTypeCount: matrix.registered,
  instantiatedTypeCount: matrix.instantiated,
  executedTypeCount: matrix.executed,
  resolvedTypeCount: matrix.resolved,
  validFactCount: matrix.validFacts,
  runtimeCapabilityCount: capabilityCount,
  graph: {
    sccCount: graph.components.length,
    prerequisiteSccCount: graph.prerequisiteComponents.length,
    closedSccCount: graph.diagnostics.filter((entry) => entry.code.includes('CLOSED')).length,
    noExitCount: graph.noExitKinds.length,
  },
  faultScenarioCount: requiredFaultTests.length,
  faultScenarios: requiredFaultTests,
  kinds: matrix.traces,
  registryDigest: matrix.registryDigest,
  contractSourceDigest: sha256Bytes(readFileSync(path.join(root, contractPath))),
  sourceDigest: source.digest,
  sources: source.sources,
  window: {
    startedAt: process.env.OUTCOME_PROTOCOL_STARTED_AT,
    finishedAt: new Date().toISOString(),
  },
  inputDigest: sha256Canonical({
    targetSha,
    registryDigest: matrix.registryDigest,
    sourceDigest: source.digest,
  }),
  resultDigest: sha256Canonical({ summary, matrix }),
};
const withDigest = { ...manifest, manifestDigest: sha256Canonical(manifest) };
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(withDigest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(withDigest)}\n`);

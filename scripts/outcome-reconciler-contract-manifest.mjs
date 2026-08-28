#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertFrozenContract,
  auditSourcePaths,
  sha256Bytes,
  sha256Canonical,
  validateSourceAudit,
} from './lib/outcome-reconciler-v2.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tapPath, outputPath] = process.argv.slice(2);
if (!tapPath || !outputPath) {
  throw new Error('usage: outcome-reconciler-contract-manifest.mjs TAP OUTPUT');
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
    const source = readFileSync(path.join(root, relativePath));
    sources[relativePath] = sha256Bytes(source);
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

const contractPath = 'contracts/outcome-reconciler-v2.contract.json';
const schemaPath = 'contracts/outcome-reconciler-v2.schema.json';
const auditPath = 'contracts/outcome-reconciler-v2-source-audit.json';
const contract = json(contractPath);
const schema = json(schemaPath);
const audit = json(auditPath);
assertFrozenContract(contract, schema);
validateSourceAudit(audit, contract, root);

const summary = tapSummary(readFileSync(tapPath, 'utf8'));
if (
  summary.tests <= 0
  || summary.passed !== summary.tests
  || summary.failed !== 0
  || summary.cancelled !== 0
  || summary.skipped !== 0
  || summary.todo !== 0
) {
  throw new Error(`contract tests are not a complete zero-skip pass: ${JSON.stringify(summary)}`);
}

const coreSources = [
  contractPath,
  schemaPath,
  auditPath,
  'package.json',
  'scripts/lib/outcome-reconciler-v2.mjs',
  'scripts/outcome-reconciler-contract.sh',
  'scripts/outcome-reconciler-contract-manifest.mjs',
  'test/outcome-reconciler-v2.contract.test.mjs',
];
const auditedSources = sourceDigest(auditSourcePaths(audit));
const allSources = sourceDigest([...coreSources, ...auditSourcePaths(audit)]);
if (Object.keys(auditedSources.sources).length < 20 || Object.keys(allSources.sources).length < 25) {
  throw new Error('source digest set is unexpectedly small; writer/reader audit may have been bypassed');
}

const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const targetBranch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
const contractSourceDigest = sha256Bytes(readFileSync(path.join(root, contractPath)));
const schemaDigest = sha256Bytes(readFileSync(path.join(root, schemaPath)));
const sourceAuditDigest = sha256Bytes(readFileSync(path.join(root, auditPath)));
const manifest = {
  schemaVersion: 2,
  suite: 'outcome-reconciler-v2-contract',
  outcome: 'PASS',
  targetSha,
  targetBranch,
  tests: summary.tests,
  passed: summary.passed,
  failed: summary.failed,
  skipped: summary.skipped,
  cancelled: summary.cancelled,
  todo: summary.todo,
  contractVersion: contract.contractVersion,
  evaluatorVersion: contract.evaluatorVersion,
  completionDimensionCount: contract.completionDimensions.length,
  completionStateCount: contract.stateAlgebra.states.length,
  obligationKindCount: contract.obligationContract.kinds.length,
  auditedSurfaceCount: audit.surfaces.length,
  sourceCount: Object.keys(allSources.sources).length,
  schemaDigest,
  contractDigest: contractSourceDigest,
  sourceAuditDigest,
  auditedSourceDigest: auditedSources.digest,
  sourceDigest: allSources.digest,
  sources: allSources.sources,
  window: {
    startedAt: process.env.OUTCOME_CONTRACT_STARTED_AT,
    finishedAt: new Date().toISOString(),
  },
  inputDigest: sha256Canonical({
    targetSha,
    schemaDigest,
    contractSourceDigest,
    sourceAuditDigest,
    sourceDigest: allSources.digest,
  }),
  resultDigest: sha256Canonical(summary),
};
const withDigest = {
  ...manifest,
  manifestDigest: sha256Canonical(manifest),
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(withDigest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(withDigest)}\n`);

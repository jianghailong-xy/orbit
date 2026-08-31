#!/usr/bin/env node
// Full API shard driver.
//
// A shard used to be a bash `for` loop under `set -e`, so the first failing case aborted the whole
// partition: a 15-minute run reported exactly one fact and every case behind the failure was never
// executed at all. This driver runs every case the partition owns and reports all of them together.
//
// It is not more permissive. One failing case still fails the shard -- collecting the rest of the
// evidence first is the only thing that changed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// A case that ran and failed, a case that never reported a test, and a case that left a database
// behind are three different facts. Collapsing them into "the shard failed" is what made a `tests=0`
// fixture signal indistinguishable from a real assertion failure.
export const CASE_PASS = 'PASS';
export const CASE_FAILED_TESTS = 'EXPECTED_FAILURE_PROPAGATED';
export const CASE_NO_TESTS = 'NO_TESTS_REPORTED';
export const CASE_SKIPPED = 'SKIPPED_OR_CANCELLED_TESTS';
export const CASE_UNCLEAN = 'RESOURCES_SURVIVED_CLEANUP';
export const CASE_UNEXPLAINED_EXIT = 'NONZERO_EXIT_WITHOUT_FAILED_TEST';
export const CASE_MISSING_RECEIPT = 'MISSING_RECEIPT';

export function caseArtifact(caseRoot, caseIndex, extension) {
  return path.join(caseRoot, `${String(caseIndex).padStart(4, '0')}.${extension}`);
}

export function tapMetrics(raw) {
  const count = (name) => [...raw.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))]
    .reduce((total, match) => total + Number(match[1]), 0);
  return {
    tests: count('tests'),
    passed: count('pass'),
    failed: count('fail'),
    cancelled: count('cancelled'),
    skipped: count('skipped'),
    todo: count('todo'),
  };
}

export function selectPartitionCases(inventory, partitionClass, index, count) {
  assert.ok(partitionClass === 'serial' || partitionClass === 'parallel');
  return inventory.specs
    .filter((spec) => (partitionClass === 'serial'
      ? spec.class === 'serial'
      : spec.class === 'parallel' && ((spec.index - 1) % count) === index))
    .map((spec) => ({ caseIndex: spec.index, spec: spec.path }));
}

// Precedence matters: a database that survived cleanup poisons whatever runs next, so it outranks
// the test result that produced it, and "no test was reported at all" outranks a failure count that
// is zero only because nothing ran.
export function classifyCase({ exitCode, cleanupCode, summary }) {
  if (cleanupCode !== 0) return CASE_UNCLEAN;
  if (summary.tests === 0) return CASE_NO_TESTS;
  if (summary.failed > 0) return CASE_FAILED_TESTS;
  if (summary.skipped > 0 || summary.cancelled > 0 || summary.todo > 0) return CASE_SKIPPED;
  if (exitCode !== 0 || summary.passed !== summary.tests) return CASE_UNEXPLAINED_EXIT;
  return CASE_PASS;
}

// The three things a reader needs to act: which subtest broke and what it said. Anything that never
// reported a subtest still has to say something locatable, so fall back to the last line it printed.
export function tapDiagnostic(raw) {
  const lines = raw.split(/\r?\n/u);
  const failureAt = lines.findIndex((line) => /^\s*not ok \d+/u.test(line));
  if (failureAt === -1) {
    const noise = lines.map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('TAP version'));
    return noise.at(-1) ?? '';
  }
  const subtest = lines[failureAt].trim();
  const yaml = lines.slice(failureAt + 1, failureAt + 40);
  const read = (field) => {
    const at = yaml.findIndex((line) => new RegExp(`^\\s*${field}:`, 'u').test(line));
    if (at === -1) return '';
    const inline = yaml[at].replace(new RegExp(`^\\s*${field}:\\s*`, 'u'), '').trim()
      .replace(/^['"]|['"]$/gu, '');
    return ['|-', '|', '>-', '>', ''].includes(inline) ? (yaml[at + 1] ?? '').trim() : inline;
  };
  const error = read('error');
  const code = read('code');
  const detail = [error, code && `(${code})`].filter(Boolean).join(' ');
  return detail ? `${subtest}: ${detail}` : subtest;
}

export function caseDiagnostic(result) {
  if (result.diagnostic) return result.diagnostic;
  return `${result.outcome} (exit=${result.exitCode}, no locatable TAP failure)`;
}

// Runs every case. Never returns early: that is the whole point of this module.
export function runPartitionCases({ cases, runCase, onResult }) {
  const results = [];
  for (const entry of cases) {
    const startedAtMs = Date.now();
    const observed = runCase(entry);
    const result = {
      caseIndex: entry.caseIndex,
      spec: entry.spec,
      durationMilliseconds: Date.now() - startedAtMs,
      ...observed,
    };
    result.diagnostic = caseDiagnostic(result);
    results.push(result);
    onResult?.(result);
  }
  return results;
}

export function partitionConclusion({ partition, declaredCases, results }) {
  const executedCases = results.length;
  const failures = results.filter((result) => result.outcome !== CASE_PASS).map((result) => ({
    caseIndex: result.caseIndex,
    spec: result.spec,
    outcome: result.outcome,
    exitCode: result.exitCode,
    summary: result.summary,
    diagnostic: caseDiagnostic(result),
  }));
  const databases = results.map((result) => result.database).filter(Boolean);
  const roles = results.map((result) => result.role).filter(Boolean);
  const resourcesRemaining = results
    .reduce((total, result) => total + (result.resourcesRemaining ?? 1), 0);
  const isolation = {
    uniqueDatabases: databases.length === executedCases
      && new Set(databases).size === executedCases,
    uniqueRoles: roles.length === executedCases && new Set(roles).size === executedCases,
    resourcesRemaining,
  };
  const complete = executedCases === declaredCases;
  const outcome = failures.length === 0 && complete && resourcesRemaining === 0
    && isolation.uniqueDatabases && isolation.uniqueRoles ? 'PASS' : 'FAILED';
  return {
    outcome,
    partition,
    declaredCases,
    executedCases,
    passedCases: executedCases - failures.length,
    failedCases: failures.length,
    complete,
    isolation,
    failures,
  };
}

export function partitionLabel(partition) {
  return partition.class === 'serial' ? 'serial' : `shard-${partition.index}`;
}

export function formatPartitionReport(conclusion) {
  const label = partitionLabel(conclusion.partition);
  const lines = [`==> full-api ${label}: ${conclusion.executedCases}/${conclusion.declaredCases}`
    + ` cases executed, ${conclusion.passedCases} passed, ${conclusion.failedCases} failed`
    + ` -> ${conclusion.outcome}`];
  if (!conclusion.complete) {
    lines.push(`!! full-api ${label} executed ${conclusion.executedCases} of its ${conclusion.declaredCases} declared cases`);
  }
  if (conclusion.isolation.resourcesRemaining !== 0) {
    lines.push(`!! full-api ${label} left ${conclusion.isolation.resourcesRemaining} disposable resources behind`);
  }
  if (!conclusion.isolation.uniqueDatabases || !conclusion.isolation.uniqueRoles) {
    lines.push(`!! full-api ${label} did not give every case its own database and role`);
  }
  if (conclusion.failures.length > 0) {
    lines.push(`!! full-api ${label} reported ${conclusion.failures.length} failing cases:`);
    for (const failure of conclusion.failures) {
      const summary = failure.summary
        ? ` tests=${failure.summary.tests} pass=${failure.summary.passed} fail=${failure.summary.failed} skip=${failure.summary.skipped}`
        : '';
      lines.push(`   [${failure.caseIndex}] ${failure.spec}`);
      lines.push(`       ${failure.outcome} exit=${failure.exitCode}${summary}`);
      lines.push(`       ${failure.diagnostic}`);
    }
  }
  return lines.join('\n');
}

// The default runner: one child process per case, reading back the artifacts the case script wrote.
export function spawnCaseRunner({ repo, caseScript, caseRoot }) {
  return ({ caseIndex, spec }) => {
    const child = spawnSync(caseScript, [String(caseIndex), path.join(repo, spec)], {
      cwd: repo,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const exitCode = child.status === null ? 1 : child.status;
    const tapPath = caseArtifact(caseRoot, caseIndex, 'tap');
    const receiptPath = caseArtifact(caseRoot, caseIndex, 'json');
    const tap = existsSync(tapPath) ? readFileSync(tapPath, 'utf8') : '';
    if (!existsSync(receiptPath)) {
      return {
        outcome: CASE_MISSING_RECEIPT,
        exitCode,
        signal: child.signal ?? null,
        summary: tapMetrics(tap),
        diagnostic: tap ? tapDiagnostic(tap) : '',
        database: null,
        role: null,
        resourcesRemaining: null,
      };
    }
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    return {
      outcome: receipt.outcome,
      exitCode,
      signal: child.signal ?? null,
      summary: receipt.summary,
      diagnostic: receipt.outcome === CASE_PASS ? '' : tapDiagnostic(tap),
      database: receipt.database,
      role: receipt.role,
      resourcesRemaining: receipt.cleanup.resourcesRemaining,
    };
  };
}

function main(argv) {
  const [action, inventoryPath, partitionClass, indexText, countText, caseRoot, resultsPath,
    caseScript] = argv;
  assert.equal(action, 'run',
    'usage: release-dag-full-api-shard.mjs run INVENTORY CLASS INDEX COUNT CASE_ROOT RESULTS CASE_SCRIPT');
  assert.ok(caseScript, 'the case script to drive is required');
  const repo = path.resolve(import.meta.dirname, '..');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const index = Number(indexText);
  const count = Number(countText);
  const cases = selectPartitionCases(inventory, partitionClass, index, count);
  assert.ok(cases.length > 0, 'full API partition selected no cases');
  const partition = { class: partitionClass, index, count };
  const startedAt = new Date().toISOString();
  const results = runPartitionCases({
    cases,
    runCase: spawnCaseRunner({ repo, caseScript, caseRoot }),
  });
  const finishedAt = new Date().toISOString();
  const conclusion = partitionConclusion({
    partition, declaredCases: cases.length, results,
  });
  const document = {
    schemaVersion: 1,
    kind: 'orbit.outcome-reconciler.release-dag-full-api-shard-results',
    // The run root is already binding-scoped, but a re-attempt inside one binding reuses it, so the
    // attempt this file describes is named here rather than inferred from where it sits.
    bindingDigest: process.env.OUTCOME_RELEASE_DAG_BINDING_DIGEST ?? null,
    attemptToken: process.env.OUTCOME_RELEASE_DAG_ATTEMPT_TOKEN ?? null,
    ...conclusion,
    inventoryTotal: inventory.totalSpecs,
    startedAt,
    finishedAt,
    durationMilliseconds: Date.parse(finishedAt) - Date.parse(startedAt),
    results,
  };
  mkdirSync(path.dirname(path.resolve(resultsPath)), { recursive: true });
  writeFileSync(resultsPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  const report = formatPartitionReport(conclusion);
  if (conclusion.outcome === 'PASS') {
    console.log(report);
    return 0;
  }
  console.error(report);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exitCode = main(process.argv.slice(2));
}

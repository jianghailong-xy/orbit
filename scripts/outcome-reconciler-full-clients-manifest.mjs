#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [sharedPath, webPath, goPath, swiftPath, outputPath] = process.argv.slice(2);
assert.ok(outputPath,
  'usage: outcome-reconciler-full-clients-manifest.mjs SHARED WEB GO SWIFT OUTPUT');
const repo = path.resolve(import.meta.dirname, '..');

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function vitest(file, floor) {
  const raw = readFileSync(file, 'utf8');
  const report = JSON.parse(raw);
  const summary = {
    tests: Number(report.numTotalTests),
    passed: Number(report.numPassedTests),
    failed: Number(report.numFailedTests),
    skipped: Number(report.numPendingTests),
    files: Number(report.numTotalTestSuites),
    failedFiles: Number(report.numFailedTestSuites),
  };
  assert.ok(summary.tests >= floor, `Vitest matrix was truncated: ${summary.tests} < ${floor}`);
  assert.equal(summary.passed, summary.tests);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.failedFiles, 0);
  return { summary, logDigest: digest(raw) };
}

function go(file) {
  const raw = readFileSync(file, 'utf8');
  const terminal = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.Test && ['pass', 'fail', 'skip'].includes(event.Action)) terminal.push(event);
  }
  const summary = {
    tests: terminal.length,
    passed: terminal.filter((event) => event.Action === 'pass').length,
    failed: terminal.filter((event) => event.Action === 'fail').length,
    skipped: terminal.filter((event) => event.Action === 'skip').length,
  };
  assert.ok(summary.tests >= 1_300, `Go matrix was truncated: ${summary.tests}`);
  assert.equal(summary.passed, summary.tests);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 0);
  return { summary, logDigest: digest(raw) };
}

function swift(file) {
  const raw = readFileSync(file, 'utf8');
  const xctest = [...raw.matchAll(
    /Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?(\d+) failures?/g,
  )].map((match) => ({
    tests: Number(match[1]),
    skipped: Number(match[2] ?? 0),
    failed: Number(match[3]),
  }));
  const swiftTesting = [...raw.matchAll(/Test run with (\d+) tests passed/gi)]
    .map((match) => ({ tests: Number(match[1]), skipped: 0, failed: 0 }));
  const widest = [...xctest, ...swiftTesting]
    .sort((a, b) => b.tests - a.tests)[0] ?? { tests: 0, skipped: 0, failed: 0 };
  const summary = {
    tests: widest.tests,
    passed: widest.tests - widest.failed - widest.skipped,
    failed: widest.failed,
    skipped: widest.skipped,
    toolchain: 'swift:6.1',
  };
  assert.ok(summary.tests >= 700, `Swift matrix was truncated: ${summary.tests}`);
  assert.equal(summary.passed + summary.failed + summary.skipped, summary.tests);
  assert.equal(summary.passed, summary.tests);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 0);
  return { summary, logDigest: digest(raw) };
}

const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const payload = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-full-clients',
  outcome: 'PASS',
  command: 'npm run test:outcome-reconciler:full-clients',
  sourceSha,
  startedAt: process.env.OUTCOME_FULL_CLIENTS_STARTED_AT,
  finishedAt: new Date().toISOString(),
  shared: vitest(sharedPath, 140),
  web: vitest(webPath, 1_200),
  go: go(goPath),
  swift: swift(swiftPath),
};
const manifest = { ...payload, manifestDigest: digest(canonical(payload)) };
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));

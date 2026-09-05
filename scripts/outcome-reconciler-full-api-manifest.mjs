#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [tapPath, outputPath, caseDirectory] = process.argv.slice(2);
assert.ok(outputPath, 'usage: outcome-reconciler-full-api-manifest.mjs TAP OUTPUT [CASES]');
const repo = path.resolve(import.meta.dirname, '..');
const tap = readFileSync(tapPath, 'utf8');

function count(name) {
  const matches = [...tap.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
  assert.ok(matches.length > 0, `TAP summary is missing ${name}`);
  return matches.reduce((total, match) => total + Number(match[1]), 0);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

const summary = {
  tests: count('tests'),
  passed: count('pass'),
  failed: count('fail'),
  cancelled: count('cancelled'),
  skipped: count('skipped'),
  todo: count('todo'),
};
assert.ok(summary.tests >= 2_800, `full API matrix was truncated: ${summary.tests}`);
assert.equal(summary.passed, summary.tests);
assert.equal(summary.failed, 0);
assert.equal(summary.cancelled, 0);
assert.equal(summary.skipped, 0);
assert.equal(summary.todo, 0);

const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.match(sourceSha, /^[0-9a-f]{40}$/);

// WHICH suites produced those numbers, and not only how many tests passed. A count cannot answer
// that question: four V2 suites were outside every full run for as long as the run existed, and no
// number in this manifest moved when they were absent or when they arrived. Each case leaves a
// receipt named for its index; this is the list of them, in the order the run scheduled them.
//
// Given a directory, never guessed at one: the run hands over the directory its cases wrote into,
// so a caller that reduces results in a process which never saw a case has none to hand over and
// publishes no census, rather than inventing one.
function census(directory) {
  const receipts = readdirSync(directory).filter((name) => /^\d{4}\.json$/u.test(name)).sort()
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), 'utf8')));
  const scheduled = Number(process.env.OUTCOME_API_CASE_TOTAL);
  assert.equal(receipts.length, scheduled,
    `${receipts.length} cases left a receipt out of ${scheduled} scheduled`);
  return receipts.map((receipt) => ({ spec: receipt.spec, tests: receipt.summary.tests }));
}
const payload = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-full-api',
  outcome: 'PASS',
  command: 'npm run test:outcome-reconciler:full-api',
  sourceSha,
  startedAt: process.env.OUTCOME_FULL_API_STARTED_AT,
  finishedAt: new Date().toISOString(),
  summary,
  ...(caseDirectory ? { cases: census(caseDirectory) } : {}),
  postgres: {
    version: process.env.OUTCOME_FULL_API_PG_VERSION,
    migrations: Number(process.env.OUTCOME_FULL_API_MIGRATIONS),
    systemIdentifier: process.env.OUTCOME_FULL_API_SYSTEM_IDENTIFIER,
  },
  tapDigest: digest(tap),
};
assert.equal(payload.postgres.version, '16.14');
assert.ok(payload.postgres.migrations >= 209);
assert.match(payload.postgres.systemIdentifier, /^\d+$/);
const manifest = { ...payload, manifestDigest: digest(canonical(payload)) };
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));

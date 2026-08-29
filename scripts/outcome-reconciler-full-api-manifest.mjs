#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [tapPath, outputPath] = process.argv.slice(2);
assert.ok(outputPath, 'usage: outcome-reconciler-full-api-manifest.mjs TAP OUTPUT');
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
const payload = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-full-api',
  outcome: 'PASS',
  command: 'npm run test:outcome-reconciler:full-api',
  sourceSha,
  startedAt: process.env.OUTCOME_FULL_API_STARTED_AT,
  finishedAt: new Date().toISOString(),
  summary,
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

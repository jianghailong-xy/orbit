import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [apiTapPath, webJsonPath, evidencePath, outputPath] = process.argv.slice(2);
assert.ok(outputPath,
  'usage: outcome-reconciler-owner-ratification-inbox-routing-manifest.mjs API_TAP WEB_JSON EVIDENCE OUTPUT');

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(file, 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function tapCounts(file) {
  const source = read(file);
  const last = (pattern, name) => {
    const matches = [...source.matchAll(pattern)];
    assert.ok(matches.length > 0, `${name} missing from ${file}`);
    return Number(matches.at(-1)[1]);
  };
  return {
    tests: last(/^# tests (\d+)$/gm, 'tests'),
    passed: last(/^# pass (\d+)$/gm, 'pass'),
    failed: last(/^# fail (\d+)$/gm, 'fail'),
    skipped: last(/^# skipped (\d+)$/gm, 'skipped'),
    cancelled: last(/^# cancelled (\d+)$/gm, 'cancelled'),
    todo: last(/^# todo (\d+)$/gm, 'todo'),
  };
}

const api = tapCounts(apiTapPath);
const webRaw = JSON.parse(read(webJsonPath));
const web = {
  tests: Number(webRaw.numTotalTests),
  passed: Number(webRaw.numPassedTests),
  failed: Number(webRaw.numFailedTests),
  skipped: Number(webRaw.numPendingTests),
  cancelled: 0,
  todo: 0,
};
for (const [name, counts] of Object.entries({ api, web })) {
  assert.ok(Number.isInteger(counts.tests) && counts.tests > 0, `${name} ran no tests`);
  assert.equal(counts.failed, 0, `${name} contains failures`);
  assert.equal(counts.skipped, 0, `${name} contains skipped tests`);
  assert.equal(counts.cancelled, 0, `${name} contains cancelled tests`);
  assert.equal(counts.todo, 0, `${name} contains todo tests`);
  assert.equal(counts.passed, counts.tests, `${name} did not pass every test`);
}

const evidence = JSON.parse(read(evidencePath));
assert.equal(evidence.suite, 'owner-ratification-inbox-routing-api');
assert.equal(evidence.postgres.required, true);
assert.equal(evidence.postgres.connected, true);
for (const [group, values] of Object.entries({
  migration: evidence.migration,
  routing: evidence.routing,
  consistency: evidence.consistency,
})) {
  for (const [name, value] of Object.entries(values)) {
    assert.equal(value, true, `${group}.${name} is not proven`);
  }
}

const sourceFiles = [
  'package.json',
  'scripts/outcome-reconciler-owner-ratification-inbox-routing.sh',
  'scripts/outcome-reconciler-owner-ratification-inbox-routing-manifest.mjs',
  'test/owner-ratification-inbox-routing.seed.mjs',
  'test/owner-ratification-inbox-routing.api.test.mjs',
  'src/apiserver/prisma/schema.prisma',
  'src/apiserver/prisma/migrations/0210_owner_ratification_inbox_eligibility/migration.sql',
  'src/apiserver/src/outcome-reconciler/outcome-surface.service.ts',
  'src/apiserver/src/projects/owner-ratification-surface.ts',
  'src/apiserver/src/projects/project-acceptance.service.ts',
  'src/web/src/components/OwnerRatificationSummary.tsx',
  'src/web/src/components/TasksSidePanel.tsx',
  'src/web/src/lib/outcomeSurfaces.ts',
  'src/web/src/lib/ownerRatification.ts',
  'src/web/src/lib/projectAttention.ts',
  'src/web/src/pages/JudgmentInboxPage.tsx',
  'src/web/src/pages/OwnerRatificationReviewPage.tsx',
  'src/web/src/pages/OwnerRatificationUi.test.tsx',
  'src/web/src/pages/ProjectsPage.tsx',
];
const sources = Object.fromEntries(sourceFiles.map((file) => {
  const value = read(path.join(root, file));
  return [file, { sha256: sha256(value), bytes: Buffer.byteLength(value) }];
}));
const sourceDigest = sha256(sourceFiles.map((file) => `${file}:${sources[file].sha256}`).join('\n'));
const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

const manifest = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-owner-ratification-inbox-routing',
  generatedBy: 'scripts/outcome-reconciler-owner-ratification-inbox-routing-manifest.mjs',
  generatedAt: new Date().toISOString(),
  targetSha,
  sourceDigest,
  sources,
  tests: {
    count: api.tests + web.tests,
    passed: api.passed + web.passed,
    failed: 0,
    skip: 0,
    suites: { apiIntegration: api, webIntegration: web },
  },
  evidence,
};
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `owner-ratification-inbox-routing manifest: tests=${manifest.tests.count} skip=0 ` +
  `target=${targetSha} source=${sourceDigest} output=${outputPath}`,
);

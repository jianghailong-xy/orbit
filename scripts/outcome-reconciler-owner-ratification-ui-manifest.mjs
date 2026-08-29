import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const [apiTapPath, unitTapPath, webJsonPath, evidencePath, outputPath] = process.argv.slice(2);
assert.ok(outputPath,
  'usage: outcome-reconciler-owner-ratification-ui-manifest.mjs API_TAP UNIT_TAP WEB_JSON API_EVIDENCE OUTPUT');

const root = path.resolve(import.meta.dirname, '..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const read = (file) => readFileSync(file, 'utf8');

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
  };
}

const api = tapCounts(apiTapPath);
const unit = tapCounts(unitTapPath);
const webRaw = JSON.parse(read(webJsonPath));
const web = {
  tests: Number(webRaw.numTotalTests),
  passed: Number(webRaw.numPassedTests),
  failed: Number(webRaw.numFailedTests),
  skipped: Number(webRaw.numPendingTests),
};
for (const [name, counts] of Object.entries({ api, unit, web })) {
  assert.ok(Number.isInteger(counts.tests) && counts.tests > 0, `${name} ran no tests`);
  assert.equal(counts.failed, 0, `${name} has failures`);
  assert.equal(counts.skipped, 0, `${name} has skipped tests`);
  assert.equal(counts.passed, counts.tests, `${name} did not pass every test`);
}

const evidence = JSON.parse(read(evidencePath));
assert.equal(evidence.suite, 'owner-ratification-ui-api');
assert.equal(evidence.postgres.required, true);
assert.equal(evidence.postgres.connected, true);
for (const [group, values] of Object.entries({
  surfaces: evidence.surfaces,
  transport: evidence.transport,
  resilience: evidence.resilience,
})) {
  for (const [name, value] of Object.entries(values)) {
    assert.equal(value, true, `${group}.${name} is not proven`);
  }
}
assert.equal(evidence.protectedProductionRequest.publicId, '4p6aWT57DodHjWYEPs2PIJ');
assert.equal(evidence.protectedProductionRequest.forbiddenAsTestTarget, true);
assert.equal(evidence.protectedProductionRequest.fixtureSentinelOnly, true);
assert.equal(evidence.protectedProductionRequest.unchanged, true);
assert.equal(evidence.protectedProductionRequest.observedInHttpUrl, false);
assert.equal(
  evidence.protectedProductionRequest.beforeDigest,
  evidence.protectedProductionRequest.afterDigest,
);

const sourceFiles = [
  'package.json',
  'scripts/outcome-reconciler-owner-ratification-ui.sh',
  'scripts/outcome-reconciler-owner-ratification-ui-manifest.mjs',
  'test/owner-ratification-ui.api.test.mjs',
  'src/apiserver/prisma/schema.prisma',
  'src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql',
  'src/apiserver/prisma/migrations/0205_task_auto_dispatch_obligation/migration.sql',
  'src/apiserver/prisma/migrations/0206_owner_ratification_ui_decision_receipt/migration.sql',
  'src/apiserver/src/common/db-write-inventory.ts',
  'src/apiserver/src/projects/owner-ratification-surface.ts',
  'src/apiserver/src/projects/project-acceptance.service.ts',
  'src/apiserver/src/projects/project-owner-ratification-ui-api.spec.ts',
  'src/apiserver/src/projects/projects.controller.ts',
  'src/apiserver/src/projects/projects.service.ts',
  'src/web/src/App.tsx',
  'src/web/src/components/OwnerRatificationSummary.tsx',
  'src/web/src/components/TasksSidePanel.tsx',
  'src/web/src/index.css',
  'src/web/src/lib/ownerRatification.ts',
  'src/web/src/lib/projectAttention.ts',
  'src/web/src/pages/JudgmentEntryPoints.test.tsx',
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

const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
assert.match(targetSha, /^[0-9a-f]{40}$/);

const manifest = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-owner-ratification-ui',
  generatedBy: 'scripts/outcome-reconciler-owner-ratification-ui-manifest.mjs',
  generatedAt: new Date().toISOString(),
  targetSha,
  sourceDigest,
  sources,
  tests: {
    count: api.tests + unit.tests + web.tests,
    passed: api.passed + unit.passed + web.passed,
    failed: 0,
    skip: 0,
    suites: { apiIntegration: api, apiUnit: unit, webIntegration: web },
  },
  evidence,
};
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `owner-ratification-ui manifest: tests=${manifest.tests.count} skip=0 ` +
  `target=${targetSha} source=${sourceDigest} output=${outputPath}`,
);

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [webPath, apiPath, e2ePath, evidencePath, manifestPath] = process.argv.slice(2);
for (const value of [webPath, apiPath, e2ePath, evidencePath, manifestPath]) assert.ok(value);

const repo = path.resolve(import.meta.dirname, '..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const artifact = (file) => {
  const bytes = readFileSync(file);
  return { path: path.relative(repo, file), bytes: bytes.length, sha256: sha256(bytes) };
};

function tapSummary(file) {
  const text = readFileSync(file, 'utf8');
  const value = (name) => Number(text.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? -1);
  const summary = {
    tests: value('tests'),
    pass: value('pass'),
    fail: value('fail'),
    skipped: value('skipped'),
    cancelled: value('cancelled'),
    todo: value('todo'),
  };
  assert.ok(summary.tests > 0, `${file}: tests must be > 0`);
  assert.equal(summary.pass, summary.tests, `${file}: every test must pass`);
  assert.equal(summary.fail, 0, `${file}: fail must be 0`);
  assert.equal(summary.skipped, 0, `${file}: skipped must be 0`);
  assert.equal(summary.cancelled, 0, `${file}: cancelled must be 0`);
  assert.equal(summary.todo, 0, `${file}: todo must be 0`);
  return summary;
}

const web = JSON.parse(readFileSync(webPath, 'utf8'));
const webSummary = {
  tests: Number(web.numTotalTests),
  pass: Number(web.numPassedTests),
  fail: Number(web.numFailedTests),
  skipped: Number(web.numPendingTests),
  suites: Number(web.numTotalTestSuites),
};
assert.ok(webSummary.tests > 0, 'Web tests must be > 0');
assert.ok(webSummary.suites > 0, 'Web suites must be > 0');
assert.equal(webSummary.pass, webSummary.tests, 'every Web test must pass');
assert.equal(webSummary.fail, 0, 'Web failures must be 0');
assert.equal(webSummary.skipped, 0, 'Web skips must be 0');
assert.equal(web.success, true, 'Web JSON result must be successful');

const apiSummary = tapSummary(apiPath);
const e2eSummary = tapSummary(e2ePath);
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
assert.equal(evidence.outcome, 'PASS');
assert.match(evidence.targetSha, /^[0-9a-f]{40}$/);
assert.equal(evidence.coverage.productionWrites, false);
for (const [name, proven] of Object.entries(evidence.coverage)) {
  if (name !== 'productionWrites') assert.equal(proven, true, `coverage ${name} was not proven`);
}
for (const [name, count] of Object.entries(evidence.samples)) {
  assert.ok(Number(count) > 0, `sample ${name} must be > 0`);
}
assert.ok(Number.isFinite(Date.parse(evidence.observationWindow.startedAt)));
assert.ok(Number.isFinite(Date.parse(evidence.observationWindow.finishedAt)));
assert.ok(evidence.observationWindow.durationMilliseconds >= 0);
assert.equal(process.env.FAILURE_COORDINATION_FIXTURE_CLEANED, 'true');

const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(currentSha, evidence.targetSha, 'evidence is not bound to current target SHA');
const boundSources = [
  'src/apiserver/src/common/failure-coordination-read.ts',
  'src/apiserver/src/outcome-reconciler/outcome-surface.service.ts',
  'src/apiserver/src/tasks/tasks.service.ts',
  'src/apiserver/src/projects/projects.service.ts',
  'src/web/src/components/FailureCoordinationCard.tsx',
  'src/web/src/components/ProjectPanoramaHeader.tsx',
  'src/web/src/lib/projectAttention.ts',
  'src/web/src/pages/JudgmentInboxPage.tsx',
  'test/outcome-reconciler-failure-coordination-e2e.test.mjs',
];
execFileSync('git', ['diff', '--quiet', currentSha, '--', ...boundSources], { cwd: repo });

const artifacts = [webPath, apiPath, e2ePath, evidencePath].map(artifact);
const digestInput = JSON.stringify({
  targetSha: currentSha,
  web: webSummary,
  api: apiSummary,
  e2e: e2eSummary,
  observationWindow: evidence.observationWindow,
  samples: evidence.samples,
  coverage: evidence.coverage,
  artifacts,
});
const manifest = {
  schemaVersion: 1,
  suite: 'failure-coordination-e2e-v1',
  outcome: 'PASS',
  target: {
    sha: currentSha,
    boundSources,
  },
  sampleCount: webSummary.tests + apiSummary.tests + e2eSummary.tests,
  samples: {
    web: webSummary,
    api: apiSummary,
    e2e: e2eSummary,
    domain: evidence.samples,
  },
  observationWindow: evidence.observationWindow,
  postgres: evidence.postgres,
  isolation: {
    disposableDatabaseRemoved: true,
    disposableEnvironmentRemoved: true,
    productionWrites: false,
  },
  artifacts,
  resultDigest: sha256(digestInput),
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  outcome: manifest.outcome,
  targetSha: manifest.target.sha,
  sampleCount: manifest.sampleCount,
  observationWindow: manifest.observationWindow,
  resultDigest: manifest.resultDigest,
  manifest: path.relative(repo, manifestPath),
}));


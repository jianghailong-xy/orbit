// Records what the pinned official dsh sends beside the model input, with Harness's shipped upload
// default and under Orbit's launch configuration, and keeps only the redacted structure.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGoResults, goTestPattern, runLogged } from '../test-dsh-runtime-environment.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scenarios = [
  'TestDshSessionLogUploadDisabledByDefault',
  'TestDshRealSessionLogUpload',
  'TestDshRealSessionLogUpload/upstream-default',
  'TestDshRealSessionLogUpload/orbit-default',
];
// Synthetic values the Go scenario plants; none may survive into the redacted evidence.
const planted = ['SL_USER_MARKER', 'SL_ASSISTANT_MARKER', 'SL_SYSTEM_PROMPT_MARKER', 'SL_FILE_CONTENT_MARKER',
  'SL_WRITE_CONTENT_MARKER', 'SL_BASH_OUTPUT_MARKER', 'sk-sl-synthetic-credential-5e1f', 'sl-runner-ambient-secret-77c2'];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const out = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'usage: node scripts/deepseek-harness-session-log/record.mjs <evidence-dir>');
const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-dsh-session-log-'));
// Nothing from an invoking Orbit session may reach the Go scenarios.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ORBIT_'))),
  NODE_OPTIONS: '', GOFLAGS: '', GOCACHE: process.env.GOCACHE ?? '/tmp/orbit-dsh-session-log-go-cache', TMPDIR: scratch };
let passed = false;
try {
  const p0 = path.join(root, 'scripts/deepseek-harness-p0');
  const install = path.join(scratch, 'install');
  mkdirSync(install);
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(path.join(p0, file), path.join(install, file));
  runLogged('npm', ['ci', '--prefix', install, '--cache', '/tmp/orbit-dsh-session-log-npm-cache', '--no-audit', '--no-fund'],
    path.join(scratch, 'npm.log'), { env, timeout: 10 * 60_000 });
  const binary = path.join(install, 'node_modules/.bin/dsh');
  const version = runLogged(binary, ['--version'], path.join(scratch, 'version.log'), {
    env: { PATH: env.PATH, HOME: env.HOME, DSH_HOME: path.join(scratch, 'version-home'), DSH_TELEMETRY_DISABLED: '1' },
  }).trim();
  const baseline = JSON.parse(readFileSync(path.join(root, 'docs/evidence/deepseek-harness/dsh-v0.2.0-rc.2/summary.json'), 'utf8'));
  assert.equal(version, '0.2.0-rc.2', 'unsupported dsh CLI version');
  assert.equal(sha256(binary), baseline.cliSha256, 'CLI differs from the fixed P0 artifact');
  const lock = JSON.parse(readFileSync(path.join(p0, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/@deepseek-ai/dsh']?.integrity, baseline.npmIntegrity, 'P0 lock dsh integrity differs');
  const records = path.join(scratch, 'records');
  const goJson = runLogged('go', ['test', '-json', '-count=1', '-timeout=10m', '-run', goTestPattern(scenarios), '.'],
    path.join(scratch, 'go.jsonl'), {
      cwd: path.join(root, 'src/runner-go'), timeout: 15 * 60_000,
      env: { ...env, P4_DSH_BIN: binary, P4_NODE_BIN: process.execPath, DSH_SESSION_LOG_EVIDENCE_DIR: records },
    });
  assertGoResults(goJson, scenarios);
  const goText = goJson.trim().split('\n').map((line) => JSON.parse(line).Output ?? '').join('');
  const reports = Object.fromEntries(['upstream-default', 'orbit-default'].map((variant) => {
    const text = readFileSync(path.join(records, `${variant}.json`), 'utf8');
    // The session's workspace, DSH_HOME and HOME all live under the scratch directory.
    for (const value of [...planted, scratch]) assert.ok(!text.includes(value), `${variant} evidence keeps a planted value`);
    return [variant, JSON.parse(text)];
  }));
  const upstream = reports['upstream-default'];
  const orbit = reports['orbit-default'];
  assert.equal(upstream.requestsCarryingUploadFields, upstream.modelRequests);
  assert.equal(orbit.requestsCarryingUploadFields, 0);
  assert.equal(orbit.deliveryAcceptedMarksInDshHome, 0);
  for (const report of [upstream, orbit]) {
    assert.deepEqual(report.markerFoundIn.apiKey, [], `${report.variant}: the API key left in a request body or header`);
    assert.deepEqual(report.markerFoundIn.runnerAmbientSecret, [], `${report.variant}: a runner credential reached a request`);
  }
  mkdirSync(out, { recursive: true });
  for (const [variant, report] of Object.entries(reports)) writeFileSync(path.join(out, `${variant}.json`), `${JSON.stringify(report, null, 2)}\n`);
  // The Go log names the scratch directory and the planted markers; keep only pass/fail lines.
  writeFileSync(path.join(out, 'go-test-output.txt'), `${goText.split('\n').filter((line) => /^\s*(?:=== RUN|--- (?:PASS|FAIL|SKIP)|PASS$|FAIL$|ok\s)/.test(line)).join('\n')}\n`);
  writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify({
    command: 'node scripts/deepseek-harness-session-log/record.mjs docs/evidence/deepseek-harness/session-log-upload',
    cliVersion: version, cliSha256: baseline.cliSha256, npmIntegrity: baseline.npmIntegrity, canonicalP0LockSha256: sha256(path.join(p0, 'package-lock.json')),
    sourceTag: 'dsh-v0.2.0-rc.2', sourceCommit: '639ed015397290b3745d163aafe02ffee4aa3f84', node: process.version, platform: `${process.platform}/${process.arch}`,
    scenarios,
    variants: Object.fromEntries(Object.entries(reports).map(([variant, report]) => [variant, {
      modelRequests: report.modelRequests, requestsCarryingUploadFields: report.requestsCarryingUploadFields,
      deliveryAcceptedMarksInDshHome: report.deliveryAcceptedMarksInDshHome, bashToolSawApiKey: report.bashToolSawApiKey,
    }])),
  }, null, 2)}\n`);
  process.stdout.write(`dsh ${version}: upstream default sent the upload fields on ${upstream.requestsCarryingUploadFields}/${upstream.modelRequests} requests; ` +
    `Orbit's launch on ${orbit.requestsCarryingUploadFields}/${orbit.modelRequests}; API key in no request body.\n`);
  passed = true;
} finally {
  if (passed) rmSync(scratch, { recursive: true, force: true });
  else process.stderr.write(`Logs retained at ${scratch}\n`);
}

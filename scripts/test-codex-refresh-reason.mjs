// Acceptance for the merge check's fix to TestRealCodexOnAChatGPTLogin (task 34llPSpoFay0dGmlgpE5m of project
// "Cursor CLI native", 34gyHIZv301nDWxKP9XkO; open item 34llJa6TOGWbAOgFOK3m9). From codex 0.164 on, the refresh
// codex sends the token endpoint for a 401 also names refresh_reason "unauthorized_recovery", which the test's
// refresh check, written on 0.161 (5a536273d), refused. The check (codexRefreshMismatch in
// src/runner-go/codex_chatgpt_backend_recording_test.go) now takes 0.161's three fields with or without that
// reason, and still refuses another reason and any other field. Run from the repository root:
//
//   node scripts/test-codex-refresh-reason.mjs
//
// It names the codex on PATH, which has to be codex-cli 0.164.0 or later, the CLI this fix is about. It runs the
// check alone on its own samples (TestCodexRefreshShapes), each named below and required to run and pass exactly
// once. Then it runs the real test on that codex exactly as `go test -count=1 -v -run '^TestRealCodexOnAChatGPTLogin$'`,
// whose output has to say `--- PASS: TestRealCodexOnAChatGPTLogin`: a skip (no codex on PATH), no test matched, a
// failure, or a test process that did not start is a non-zero exit. The guards are scripts/test-dsh-routing.mjs's,
// by way of scripts/test-dsh-runtime-environment.mjs and scripts/test-cursor-runner-install.mjs, reused as they are;
// they, and the one added here for `-v` output, are checked against this script's own names before they are
// trusted. Every command writes to a regular file, never a pipe. The real test signs codex in with a fake login and
// sends its turns and its refresh to a recorder on this machine, every other host to a proxy that is not there;
// nothing here installs or changes codex.
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGoResults, goTestPattern, runLogged, runnerEnvironment } from './test-dsh-runtime-environment.mjs';
import { checkGuards } from './test-cursor-runner-install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runner = path.join(root, 'src/runner-go');
const testFile = 'codex_chatgpt_backend_recording_test.go';

// The refresh check alone, on samples of its own: what each has to conclude.
export const refreshSamples = {
  'accepts-no-reason': "codex 0.161's refresh, client_id, grant_type and refresh_token alone, is taken",
  'accepts-unauthorized-recovery': 'codex 0.164\'s, with refresh_reason "unauthorized_recovery" beside them, is taken',
  'refuses-another-reason': 'refresh_reason "scheduled", another of codex\'s reasons, is refused',
  'refuses-another-field': 'a field codex has never sent is refused',
  'refuses-another-field-beside-the-reason': "the same field beside 0.164's reason is refused",
  'refuses-another-refresh-token': 'another refresh token is refused',
  'refuses-no-client-id': 'a refresh without client_id is refused',
};
const sampleTest = 'TestCodexRefreshShapes';
export const sampleNames = [sampleTest, ...Object.keys(refreshSamples).map((name) => `${sampleTest}/${name}`)];
const realTest = 'TestRealCodexOnAChatGPTLogin';
const leastCodex = [0, 164, 0];

/** The `name` Go's exec.LookPath finds on `searchPath`: the first executable file of that name, or null. */
function lookPath(name, searchPath) {
  for (const dir of searchPath.split(path.delimiter)) {
    const candidate = path.join(dir || '.', name);
    try {
      if (!statSync(candidate).isDirectory()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Not here.
    }
  }
  return null;
}

const atLeast = (version, least) => {
  for (let i = 0; i < least.length; i++) if (version[i] !== least[i]) return version[i] > least[i];
  return true;
};

/**
 * What `go test -v` printed for `name` alone says it ran and passed, once: no skip, no failure, no "no tests to
 * run", no other test, and the package's own ok at the end.
 */
export function assertGoVerbosePass(output, name) {
  goTestPattern([name]);
  assert.doesNotMatch(output, /^\s*--- (?:FAIL|SKIP): /m, 'failed or skipped Go test');
  assert.doesNotMatch(output, /no tests to run/, 'no Go test matched');
  assert.deepEqual([...output.matchAll(/^=== RUN\s+(\S+)$/gm)].map((match) => match[1]), [name], 'missing, unmatched or repeated Go test');
  assert.deepEqual([...output.matchAll(/^\s*--- PASS: (\S+) \(/gm)].map((match) => match[1]), [name], 'missing, unmatched or repeated Go pass');
  assert.match(output, /^PASS\nok\s+orbit\s/m, 'missing Go package pass');
}

// The `-v` guard, held to the real test's name: its passing run is taken, and a skip (no codex on PATH), a failure,
// no test matched, another test, the test twice, a run cut off before the package's ok, and no output are refused.
export function checkVerboseGuard(name) {
  const ran = (test) => [`=== RUN   ${test}`, `=== PAUSE ${test}`, `=== CONT  ${test}`];
  const ok = ['PASS', 'ok  \torbit\t12.345s'];
  const lines = (...parts) => `${parts.flat().join('\n')}\n`;
  assertGoVerbosePass(lines(ran(name), `--- PASS: ${name} (12.34s)`, ok), name);
  const refused = (label, output) => assert.throws(() => assertGoVerbosePass(output, name), undefined, `the -v guard accepted ${label}`);
  refused('a skip', lines(ran(name), `    ${testFile}:548: no codex on PATH; this recording needs a real app-server`,
    `--- SKIP: ${name} (0.00s)`, ok));
  refused('a failure', lines(ran(name), `--- FAIL: ${name} (0.66s)`, 'FAIL', 'exit status 1', 'FAIL\torbit\t0.669s'));
  refused('no test matched', lines('testing: warning: no tests to run', 'PASS', 'ok  \torbit\t0.010s [no tests to run]'));
  refused('another test', lines(ran(`${name}Again`), `--- PASS: ${name}Again (12.34s)`, ok));
  refused('the test twice', lines(ran(name), `--- PASS: ${name} (12.34s)`, ran(name), `--- PASS: ${name} (12.34s)`, ok));
  refused('a run cut off before the package said ok', lines(ran(name), `--- PASS: ${name} (12.34s)`));
  refused('no output', '');
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-codex-refresh-reason-'));
  try {
    assert.ok(existsSync(path.join(runner, testFile)), `missing required Go test source: ${testFile}`);
    // The invoking PATH, so the codex named here is the one the test's exec.LookPath finds.
    const env = runnerEnvironment(process.env, scratch, process.env.PATH ?? '');
    const codex = lookPath('codex', env.PATH);
    assert.ok(codex, `no codex on PATH (${env.PATH}): ${realTest} would only skip`);
    const said = runLogged(codex, ['--version'], path.join(scratch, 'codex-version.log'), { env, timeout: 60_000 }).trim();
    const version = /^codex-cli (\d+)\.(\d+)\.(\d+)/m.exec(said);
    assert.ok(version, `${codex} --version said ${JSON.stringify(said)}, which names no codex-cli version`);
    assert.ok(atLeast(version.slice(1).map(Number), leastCodex),
      `${codex} is ${said}, older than codex-cli ${leastCodex.join('.')}, the CLI this fix is about`);
    process.stdout.write(`PASS the codex on PATH is ${codex} (${realpathSync(codex)}): ${said}, at least ${leastCodex.join('.')}.\n`);

    checkGuards(sampleNames, scratch);
    checkVerboseGuard(realTest);
    process.stdout.write('PASS the guards refuse missing, unmatched, repeated, skipped, failed and unstarted tests, and a run that matched none.\n');

    const samples = runLogged('go', ['test', '-json', '-count=1', '-timeout=120s', '-run', goTestPattern(sampleNames), '.'],
      path.join(scratch, 'samples.json'), { cwd: runner, env, timeout: 900_000 });
    process.stdout.write(samples);
    assertGoResults(samples, sampleNames);
    for (const [name, verdict] of Object.entries(refreshSamples)) process.stdout.write(`PASS ${sampleTest}/${name}: ${verdict}.\n`);

    const real = runLogged('go', ['test', '-count=1', '-v', '-run', `^${realTest}$`], path.join(scratch, 'real.log'),
      { cwd: runner, env, timeout: 900_000 });
    process.stdout.write(real);
    assertGoVerbosePass(real, realTest);
    process.stdout.write(`PASS ${realTest} on ${said}.\n`);
    process.stdout.write(`codex refresh_reason acceptance passed: ${said} on PATH, ${sampleNames.length} named sample scenarios and ${realTest}, none missing, unmatched or skipped.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAcceptance();

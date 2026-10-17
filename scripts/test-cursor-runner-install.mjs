// Acceptance for project P3 (Cursor CLI native, 34gyHIZv301nDWxKP9XkO): the runner installs the pinned
// Cursor CLI build itself — the tarball for its platform, checked against the SHA-256 the contract
// measured — never updates it on its own or behind a running session, tells its health states apart,
// reports the model catalogue with each model's parameters, prepares every session's process with
// directories of its own and an allowlisted environment, never touches the runner user's ~/.cursor or
// ~/.config/cursor, and declares provider:cursor only while it can run Cursor CLI sessions. Run from the
// repository root:
//
//   node scripts/test-cursor-runner-install.mjs
//
// Every named Go scenario below runs in one `go test -run` that matches exactly these names, and each is
// required to run and pass exactly once: a scenario missing, renamed, unmatched, skipped or failing, or a
// test process that did not start, is a non-zero exit (Go has no todo; anything but run, pass and output
// is refused). The guards are scripts/test-dsh-routing.mjs's and scripts/test-dsh-runtime-environment.mjs's,
// reused as they are, and checked here against this script's own names before they are trusted. The tests
// run with every real engine CLI, Cursor's own commands and the download tools replaced on PATH by stubs
// that fail, and the runner user's real ~/.cursor, ~/.config/cursor, Cursor's own install tree, the links
// its installer adds and its compile cache are fingerprinted before and after: any change fails the run.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGoResults, goTestPattern, harnessDirectoryFingerprint, runLogged, runnerEnvironment } from './test-dsh-runtime-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// Exact mandatory scenario names, independent of what `go test` happens to discover.
export const mandatoryGoCases = {
  'cursor_install_test.go': [
    // Installed from the pinned tarball, checked against its size and SHA-256; a mismatch is refused.
    'TestCursorInstallPublishesPinnedTarball',
    'TestCursorInstallPublishesPinnedTarball/on-demand-install-needs-consent',
    'TestCursorInstallPublishesPinnedTarball/install',
    'TestCursorInstallPublishesPinnedTarball/published-directory-is-never-written-again',
    'TestCursorInstallRejectsChecksumMismatch',
    'TestCursorInstallRejectsChecksumMismatch/tampered',
    'TestCursorInstallRejectsChecksumMismatch/truncated',
    'TestCursorInstallRejectsChecksumMismatch/padded',
    'TestCursorInstallRejectsChecksumMismatch/another-build',
    'TestCursorInstallRejectsChecksumMismatch/not-found',
    'TestCursorInstallRejectsChecksumMismatch/pinned-hash-of-another-version',
    'TestCursorInstallRejectsChecksumMismatch/link-in-package',
    'TestCursorInstallRejectsChecksumMismatch/path-outside-package',
    // It never updates itself, and an update never interrupts a running session.
    'TestCursorNeverUpdatesItself',
    'TestCursorNeverUpdatesItself/told-not-to',
    'TestCursorNeverUpdatesItself/updating-anyway',
    'TestCursorNeverUpdatesItself/update-pass-follows-the-pin',
    'TestCursorUpgradeLeavesRunningSessionsAlone',
  ],
  'cursor_health_test.go': [
    // The four health states, and signed in only on the CLI's own answer, never the ACP handshake.
    'TestCursorHealthStates',
    'TestCursorHealthStates/not-installed',
    'TestCursorHealthStates/version-mismatch',
    'TestCursorHealthStates/platform-unsupported',
    'TestCursorHealthStates/signed-out',
    'TestCursorHealthStates/signed-in',
    'TestCursorHealthStates/handshake-is-not-a-credential',
    // provider:cursor only while the pinned build is ready and the binary can run its sessions.
    'TestCursorProviderDeclaredOnlyWhenAvailable',
    'TestCursorProviderDeclaredOnlyWhenAvailable/not-installed',
    'TestCursorProviderDeclaredOnlyWhenAvailable/installed-and-signed-out',
    'TestCursorProviderDeclaredOnlyWhenAvailable/version-mismatch',
    'TestCursorProviderDeclaredOnlyWhenAvailable/platform-unsupported',
    'TestCursorProviderDeclaredOnlyWhenAvailable/no-session-driver',
    'TestCursorProviderDeclaredOnlyWhenAvailable/withdrawn-when-the-build-goes',
    'TestCursorSessionWithoutDriverStartsNothing',
  ],
  'cursor_models_test.go': [
    // The catalogue as ACP lists it, with every model's parameters.
    'TestCursorModelCatalogParsesVariants',
    'TestCursorModelCatalogProbe',
    'TestCursorModelCatalogProbe/signed-out',
    'TestCursorModelCatalogProbe/default-account',
    'TestCursorModelCatalogProbe/login-refused',
    'TestCursorModelCatalogProbe/not-installed',
  ],
  'cursor_launch_test.go': [
    // Each session's own directories and an allowlisted environment; the real ~/.cursor is never written.
    'TestCursorLaunchSpecIsolatesSessionDirectories',
    'TestCursorLaunchSpecWhitelistsEnvironment',
    'TestCursorNeverWritesRealCursorHome',
  ],
  'user_credential_env_test.go': [
    // The session launch is one of the environments held to the runner's credential rule.
    'TestAgentEnvironmentsWithholdUserCredentials',
    'TestAgentEnvironmentsWithholdUserCredentials/census',
    'TestAgentEnvironmentsWithholdUserCredentials/cursor',
  ],
};

// What a Cursor CLI, or Cursor's installer, writes into the runner user's home.
export function userCursorPaths(home) {
  return ['.cursor', '.config/cursor', '.local/share/cursor-agent', '.local/bin/agent', '.local/bin/cursor-agent',
    '.local/bin/cursor', '.cache/cursor-compile-cache'].map((rel) => path.join(home, rel));
}

function goEvents(names) {
  return [{ Action: 'start', Package: 'orbit' },
    ...names.flatMap((Test) => [{ Action: 'run', Package: 'orbit', Test }, { Action: 'pass', Package: 'orbit', Test }]),
    { Action: 'pass', Package: 'orbit' }];
}

function json(events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

// The reused guards, held to this script's names: a complete run passes, and a missing, skipped, failed,
// repeated or unmatched scenario, a package that only says pass, no output, a test process that cannot
// start and one that exits non-zero are each refused.
export function checkGuards(names, scratch) {
  const events = goEvents(names);
  assertGoResults(json(events), names);
  const refused = (label, output) => assert.throws(() => assertGoResults(output, names), undefined, `the guard accepted ${label}`);
  const first = names[0];
  refused('a missing scenario', json(events.filter((event) => event.Test !== first)));
  refused('a skipped scenario', json(events.map((event) => (event.Test === first && event.Action === 'pass' ? { ...event, Action: 'skip' } : event))));
  refused('a failed scenario', json(events.map((event) => (event.Test === first && event.Action === 'pass' ? { ...event, Action: 'fail' } : event))));
  refused('a scenario that never finished', json(events.filter((event) => !(event.Test === first && event.Action === 'pass'))));
  refused('a repeated scenario', json([...events.slice(0, -1), ...goEvents([first]).slice(1, -1), events.at(-1)]));
  refused('an unmatched test', json([...events.slice(0, -1), { Action: 'run', Package: 'orbit', Test: 'TestNotNamedHere' },
    { Action: 'pass', Package: 'orbit', Test: 'TestNotNamedHere' }, events.at(-1)]));
  refused('a package that only says pass', json([{ Action: 'start', Package: 'orbit' }, { Action: 'pass', Package: 'orbit' }]));
  refused('no output', '');
  const selector = new RegExp(goTestPattern(names));
  assert.ok(names.every((name) => selector.test(name.split('/')[0])), 'the -run pattern misses a named scenario');
  assert.ok(!selector.test(`${names[0]}Extra`) && !selector.test('TestCursor'), 'the -run pattern matches more than the named scenarios');
  const log = path.join(scratch, 'guard.log');
  assert.throws(() => runLogged(path.join(scratch, 'no-such-go'), ['test'], log), /startup or execution failed/);
  assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(3)'], log), /exit 3/);
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-runner-install-'));
  const home = process.env.HOME ?? homedir();
  const watched = userCursorPaths(home);
  const before = watched.map((entry) => harnessDirectoryFingerprint(entry));
  const changed = () => watched.filter((entry, i) => harnessDirectoryFingerprint(entry) !== before[i]);
  try {
    for (const file of Object.keys(mandatoryGoCases)) {
      assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: ${file}`);
    }
    const names = Object.values(mandatoryGoCases).flat();
    checkGuards(names, scratch);
    process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, failed and unstarted scenarios.\n');

    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx']) {
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "P3 tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
    }
    // serviceLoginPath appends the engine installers' own directories; keep them behind the stubs.
    const loginHome = userInfo().homedir;
    const toolPath = [blockedBin, path.dirname(process.execPath), '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin',
      path.join(loginHome, '.local/bin'), path.join(loginHome, '.opencode/bin'), path.join(loginHome, '.kimi-code/bin')].join(path.delimiter);
    const output = runLogged('go', ['test', '-json', '-count=1', '-timeout=300s', '-run', goTestPattern(names), '.'], path.join(scratch, 'runner.json'), {
      cwd: path.join(root, 'src/runner-go'), env: runnerEnvironment(process.env, scratch, toolPath), timeout: 600_000,
    });
    process.stdout.write(output);
    assertGoResults(output, names);
    for (const name of names) process.stdout.write(`PASS ${name}\n`);

    assert.deepEqual(changed(), [], 'the runner user\'s Cursor CLI directories changed');
    process.stdout.write(`PASS the runner user's ${watched.map((entry) => `~/${path.relative(home, entry)}`).join(', ')} are unchanged.\n`);
    process.stdout.write(`P3 acceptance passed: ${names.length} named runner scenarios, none missing, unmatched or skipped.\n`);
  } finally {
    if (changed().length !== 0) {
      process.stderr.write(`The runner user's Cursor CLI directories changed (${changed().join(', ')}); logs kept at ${scratch}\n`);
      process.exitCode = 1;
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAcceptance();

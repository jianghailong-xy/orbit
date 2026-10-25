// Acceptance for macOS runner support of Cursor CLI (project 34gyHIZv301nDWxKP9XkO, task 34lk6zafdNyu67SiAD3q9;
// docs/cursor-runtime-contract.md §18.9). Against the scripted Cursor CLI, run as the macOS build on a runner
// whose platform the tests stand in:
//   - darwin/arm64 has the pinned build's own tarball (2026.10.14-941492e, SHA-256 c6d9e2ea…cc77), and a
//     platform nobody measured, darwin/amd64 among them, is still refused with CURSOR_PLATFORM_UNSUPPORTED;
//   - a darwin runner declares provider:cursor, cursor-account-login/v1 and cursor-account-remove/v1, and a
//     Linux runner declares what it did;
//   - on darwin a sign-in, its status, a session borrowing it, its expiry and its removal all go by
//     <account>/home/.cursor/auth.json, and on Linux by xdg-config/cursor/auth.json as before;
//   - every place the runner starts Cursor CLI names AGENT_CLI_CREDENTIAL_STORE (file for `agent login`,
//     memory for the rest), so on macOS none falls back to the Keychain.
// Then the runner builds and vets for darwin/arm64, and vets with -tags cursor_real on Linux and on darwin —
// with the real-CLI accounts test (cursor_accounts_real_test.go) among the files each of those compiles.
// Run from the repository root:
//
//   node scripts/test-cursor-macos-runner.mjs
//
// Every named Go scenario below runs in one `go test -run` that matches exactly these names, and each is
// required to run and pass exactly once: a scenario missing, renamed, unmatched, skipped or failing, or a test
// process that did not start, is a non-zero exit (Go has no todo; anything but run, pass and output is
// refused). The guards are scripts/test-dsh-routing.mjs's and scripts/test-dsh-runtime-environment.mjs's, held
// to this script's own names before they are trusted (scripts/test-cursor-runner-install.mjs checkGuards).
// Every command writes to a file of its own, never a pipe. The tests run with every real engine CLI, Cursor's
// own commands, macOS's `security` and the download tools replaced on PATH by stubs that fail, and the runner
// user's real ~/.cursor, ~/.config/cursor, Cursor's own install tree, its compile caches and Orbit's own Cursor
// CLI accounts are fingerprinted before and after: any change fails the run.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGoResults, goTestPattern, harnessDirectoryFingerprint, runLogged, runnerEnvironment } from './test-dsh-runtime-environment.mjs';
import { checkGuards, userCursorPaths } from './test-cursor-runner-install.mjs';
import { orbitCursorAccountPaths } from './test-cursor-accounts-runner.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runnerDir = path.join(root, 'src/runner-go');

// The real-CLI accounts test the Mac follow-up runs: built only with -tags cursor_real, on Linux and macOS alike.
const realAccountsTest = 'cursor_accounts_real_test.go';

// Exact mandatory scenario names, independent of what `go test` happens to discover.
export const mandatoryGoCases = {
  'cursor_macos_runner_test.go': [
    // The pinned build per platform: darwin/arm64's tarball beside Linux x64's; anything else unsupported.
    'TestCursorPinnedBuildPerPlatform',
    // A darwin/arm64 runner installs from macOS's download path and declares provider:cursor and both account
    // capabilities; an Intel Mac declares no provider:cursor and installs nothing; Linux as it was.
    'TestCursorMacRunnerDeclaresCursor',
    'TestCursorMacRunnerDeclaresCursor/darwin-arm64',
    'TestCursorMacRunnerDeclaresCursor/darwin-amd64',
    'TestCursorMacRunnerDeclaresCursor/linux-amd64',
    // macOS's login layout: a sign-in lands in <account>/home/.cursor/auth.json, nothing under xdg-config/.
    'TestCursorMacSignInSavesUnderHome',
    // Sign-in status and expiry by each platform's layout.
    'TestCursorMacLoginStatusFollowsTheLayout',
    'TestCursorMacLoginStatusFollowsTheLayout/darwin',
    'TestCursorMacLoginStatusFollowsTheLayout/linux',
    // A session borrows its account's login from home/.cursor; expired and misplaced logins are refused.
    'TestCursorMacSessionBorrowsItsAccountsLogin',
    // Removal takes the account and its login; refused while a session uses it.
    'TestCursorMacAccountRemoval',
    // Usage and the model catalogue read the login where macOS keeps it.
    'TestCursorMacUsageAndCatalogueReadTheHomeLogin',
    // Every Cursor CLI start names its credential store; on macOS none reaches the Keychain.
    'TestCursorEveryCLIStartNamesItsCredentialStore',
    'TestCursorEveryCLIStartNamesItsCredentialStore/darwin',
    'TestCursorEveryCLIStartNamesItsCredentialStore/linux',
    'TestCursorEveryCLIStartNamesItsCredentialStore/census',
  ],
  'cursor_account_slot_test.go': [
    // D4: approach A measured on Linux and macOS alike, so both keep accounts beside Default and declare both
    // capabilities; elsewhere Default alone.
    'TestCursorAccountsAreKeptOnLinuxAndMacOS',
    // Linux's accounts as they were: sign-in, report, Re-sign in, removal, a session borrowing its login.
    'TestCursorAddAccountRelaysTheSignInLink',
    'TestCursorDefaultSignInUsesOrbitsDirectory',
    'TestCursorEngineReportsEveryAccountsSignIn',
    'TestCursorReSignInReplacesTheAccountsLogin',
    'TestCursorAccountRemovalRefusedWhileASessionUsesIt',
    'TestCursorSessionBorrowsItsAccountAndCommandsKeepTheirEnvironment',
    'TestCursorSessionOnAnAccountWithoutALoginIsRefused',
    'TestCursorDefaultAccountDirectoryIsUnchanged',
  ],
  'cursor_health_test.go': [
    // Linux's engine report and provider:cursor declaration as they were.
    'TestCursorHealthStates',
    'TestCursorHealthStates/platform-unsupported',
    'TestCursorHealthStates/signed-in',
    'TestCursorProviderDeclaredOnlyWhenAvailable',
    'TestCursorProviderDeclaredOnlyWhenAvailable/installed-and-signed-out',
    'TestCursorProviderDeclaredOnlyWhenAvailable/platform-unsupported',
  ],
  'cursor_install_test.go': [
    // Linux's install as it was: the linux/x64 tarball, checked and unpacked into Orbit's version directory.
    'TestCursorInstallPublishesPinnedTarball',
    'TestCursorInstallRejectsChecksumMismatch',
  ],
};

// assertMachOArm64 fails unless file is a 64-bit Mach-O executable for arm64: magic 0xfeedfacf and CPU type
// CPU_TYPE_ARM64 (0x0100000c), both little-endian.
function assertMachOArm64(file) {
  const head = readFileSync(file).subarray(0, 8);
  assert.equal(head.readUInt32LE(0), 0xfeedfacf, `${file} is not a 64-bit Mach-O binary`);
  assert.equal(head.readUInt32LE(4), 0x0100000c, `${file} is not built for arm64`);
}

// goTestFiles is the _test.go files `go test` compiles for goos/goarch with tags, by `go list`.
function goTestFiles(env, scratch, label, tags) {
  const args = ['list', ...(tags ? ['-tags', tags] : []), '-f', '{{join .TestGoFiles "\\n"}}', '.'];
  return runLogged('go', args, path.join(scratch, `list-${label}.txt`), { cwd: runnerDir, env, timeout: 300_000 })
    .split('\n').map((line) => line.trim()).filter(Boolean);
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-macos-runner-'));
  const home = process.env.HOME ?? homedir();
  const watched = [...userCursorPaths(home), path.join(home, 'Library/Caches/cursor-compile-cache'), ...orbitCursorAccountPaths(home)];
  const before = watched.map((entry) => harnessDirectoryFingerprint(entry));
  const changed = () => watched.filter((entry, i) => harnessDirectoryFingerprint(entry) !== before[i]);
  try {
    for (const file of [...Object.keys(mandatoryGoCases), realAccountsTest]) {
      assert.ok(existsSync(path.join(runnerDir, file)), `missing required Go test source: ${file}`);
    }
    const realSource = readFileSync(path.join(runnerDir, realAccountsTest), 'utf8');
    assert.ok(realSource.startsWith('//go:build cursor_real\n'), `${realAccountsTest} must build with the cursor_real tag alone, on Linux and macOS`);
    assert.match(realSource, /^func TestCursorRealAccounts\(t \*testing\.T\) \{$/m, `${realAccountsTest} has no TestCursorRealAccounts`);
    const names = Object.values(mandatoryGoCases).flat();
    checkGuards(names, scratch);
    process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, failed and unstarted scenarios.\n');

    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'security', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx']) {
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "macOS runner tests started a real CLI, downloader or the Keychain\\n" >&2\nexit 97\n', { mode: 0o700 });
    }
    // serviceLoginPath appends the engine installers' own directories; keep them behind the stubs.
    const loginHome = userInfo().homedir;
    const toolPath = [blockedBin, path.dirname(process.execPath), '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin',
      path.join(loginHome, '.local/bin'), path.join(loginHome, '.opencode/bin'), path.join(loginHome, '.kimi-code/bin')].join(path.delimiter);
    const env = runnerEnvironment(process.env, scratch, toolPath);
    const output = runLogged('go', ['test', '-json', '-count=1', '-timeout=300s', '-run', goTestPattern(names), '.'], path.join(scratch, 'runner.json'), {
      cwd: runnerDir, env, timeout: 600_000,
    });
    process.stdout.write(output);
    assertGoResults(output, names);
    for (const name of names) process.stdout.write(`PASS ${name}\n`);

    // The runner for darwin/arm64: it builds, it is an arm64 Mach-O, and every package vets.
    const darwin = { ...env, GOOS: 'darwin', GOARCH: 'arm64' };
    const linux = { ...env, GOOS: 'linux', GOARCH: 'amd64' };
    const binary = path.join(scratch, 'orbit-darwin-arm64');
    runLogged('go', ['build', '-o', binary, '.'], path.join(scratch, 'build-darwin.log'), { cwd: runnerDir, env: darwin, timeout: 600_000 });
    assertMachOArm64(binary);
    process.stdout.write('PASS GOOS=darwin GOARCH=arm64 go build: an arm64 Mach-O runner.\n');
    runLogged('go', ['vet', './...'], path.join(scratch, 'vet-darwin.log'), { cwd: runnerDir, env: darwin, timeout: 600_000 });
    process.stdout.write('PASS GOOS=darwin GOARCH=arm64 go vet ./...\n');

    // The real-CLI accounts test compiles where the Mac follow-up and Linux run it, and only with its tag.
    for (const [label, platform] of [['linux', linux], ['darwin', darwin]]) {
      const tagged = goTestFiles(platform, scratch, `${label}-cursor-real`, 'cursor_real');
      assert.ok(tagged.includes(realAccountsTest), `-tags cursor_real on ${label} does not compile ${realAccountsTest}: ${tagged.join(', ')}`);
      assert.ok(tagged.includes('cursor_macos_runner_test.go'), `${label} does not compile cursor_macos_runner_test.go`);
      const untagged = goTestFiles(platform, scratch, `${label}-default`, '');
      assert.ok(!untagged.includes(realAccountsTest), `${realAccountsTest} compiles on ${label} without -tags cursor_real`);
      runLogged('go', ['vet', '-tags', 'cursor_real', './...'], path.join(scratch, `vet-${label}-cursor-real.log`), { cwd: runnerDir, env: platform, timeout: 600_000 });
      process.stdout.write(`PASS GOOS=${platform.GOOS} GOARCH=${platform.GOARCH} go vet -tags cursor_real ./... (with ${realAccountsTest}).\n`);
    }

    assert.deepEqual(changed(), [], 'the runner user\'s Cursor CLI directories or Orbit\'s Cursor CLI accounts changed');
    process.stdout.write(`PASS unchanged: ${watched.map((entry) => `~/${path.relative(home, entry)}`).join(', ')}.\n`);
    process.stdout.write(`macOS runner acceptance passed: ${names.length} named runner scenarios, none missing, unmatched or skipped; ` +
      'darwin/arm64 build and vet; cursor_real vet on Linux and darwin.\n');
  } finally {
    if (changed().length !== 0) {
      process.stderr.write(`Cursor CLI directories changed (${changed().join(', ')}); logs kept at ${scratch}\n`);
      process.exitCode = 1;
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAcceptance();

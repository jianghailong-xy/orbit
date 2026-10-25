// Acceptance for project P4b (Cursor CLI native, 34gyHIZv301nDWxKP9XkO): a runner keeps several Cursor CLI
// accounts and runs each session on the one it was dispatched onto (docs/cursor-runtime-contract.md §8.4,
// §9, §16). Against a scripted Cursor CLI: Add account signs a new account in, in a directory of its own,
// and relays the link `agent login` prints; every account's sign-in is reported on its own; Re-sign in
// replaces an account's login in place; Remove takes one account, and is refused while a session uses it;
// a session borrows its account's login while the commands the agent runs see the environment any other
// engine's session gives them; and Default's directory hashes the same before and after. Run from the
// repository root:
//
//   node scripts/test-cursor-accounts-runner.mjs
//
// Every named Go scenario below runs in one `go test -run` that matches exactly these names, and each is
// required to run and pass exactly once: a scenario missing, renamed, unmatched, skipped or failing, or a
// test process that did not start, is a non-zero exit (Go has no todo; anything but run, pass and output
// is refused). The guards are scripts/test-dsh-routing.mjs's and scripts/test-dsh-runtime-environment.mjs's,
// held to this script's own names before they are trusted (scripts/test-cursor-runner-install.mjs
// checkGuards). The tests run with every real engine CLI, Cursor's own commands and the download tools
// replaced on PATH by stubs that fail, and the runner user's real ~/.cursor, ~/.config/cursor, Cursor's own
// install tree, its compile cache and Orbit's own Cursor CLI accounts — Default's directory among them — are
// fingerprinted before and after: any change fails the run.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGoResults, goTestPattern, harnessDirectoryFingerprint, runLogged, runnerEnvironment } from './test-dsh-runtime-environment.mjs';
import { checkGuards, userCursorPaths } from './test-cursor-runner-install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// Exact mandatory scenario names, independent of what `go test` happens to discover.
export const mandatoryGoCases = {
  'cursor_account_slot_test.go': [
    // Add account and the sign-in link relay: a directory of its own, `agent login` run there, the link
    // relayed as the CLI prints it with when it expires; Default signs in the same way, into Orbit's own
    // directory for it, and no other engine's CLI is started for a Cursor CLI sign-in.
    'TestCursorAddAccountRelaysTheSignInLink',
    'TestCursorDefaultSignInUsesOrbitsDirectory',
    // The link running out is reported as expired, apart from every other failure (T0 board, Web 3 / iOS 3).
    'TestCursorExpiredSignInLinkIsReportedAsExpired',
    'TestCursorExpiredSignInLinkIsReportedAsExpired/cli-gives-up-after-its-wait',
    'TestCursorExpiredSignInLinkIsReportedAsExpired/cli-gives-up-early',
    'TestCursorExpiredSignInLinkIsReportedAsExpired/login-error',
    'TestCursorExpiredSignInLinkIsReportedAsExpired/relay-deadline',
    // Each account's sign-in reported on its own; an expired login is signed out and never refreshed.
    'TestCursorEngineReportsEveryAccountsSignIn',
    // Re-sign in.
    'TestCursorReSignInReplacesTheAccountsLogin',
    // Remove, and refused while a session uses the account.
    'TestCursorAccountRemovalRefusedWhileASessionUsesIt',
    // A session borrows its account's login; the commands the agent runs keep their environment.
    'TestCursorSessionBorrowsItsAccountAndCommandsKeepTheirEnvironment',
    'TestCursorSessionOnAnAccountWithoutALoginIsRefused',
    'TestCursorSessionOnAnAccountWithoutALoginIsRefused/expired',
    'TestCursorSessionOnAnAccountWithoutALoginIsRefused/not-signed-in',
    'TestCursorSessionOnAnAccountWithoutALoginIsRefused/workspace-key',
    'TestCursorSessionOnAnAccountWithoutALoginIsRefused/not-this-runners',
    'TestCursorShellWrapperPathNamesBashNotZsh',
    // Default's directory hashes the same after another account is added, reported, signed in again, run
    // a session on and removed.
    'TestCursorDefaultAccountDirectoryIsUnchanged',
    // D4: approach A measured on Linux and macOS alike, so both keep accounts beside Default and declare both capabilities; elsewhere Default alone.
    'TestCursorAccountsAreKeptOnLinuxAndMacOS',
  ],
  'cursor_launch_test.go': [
    // The session's launch: the allowlist, the workspace's variables, the contract's over both, the
    // credential Orbit chose; the runner's own XDG_CONFIG_HOME given back to commands.
    'TestCursorLaunchSpecWhitelistsEnvironment',
    'TestCursorLaunchEnvironmentLayers',
    'TestCursorLaunchEnvironmentLayers/workspace-key-without-a-login',
    'TestCursorLaunchEnvironmentLayers/dispatched-key-wins',
    'TestCursorLaunchEnvironmentLayers/default-login-only-without-a-credential-of-its-own',
    'TestCursorLaunchEnvironmentLayers/contract-variables-win',
    'TestCursorLaunchEnvironmentLayers/workspace-variables-reach-commands',
  ],
};

// What the runner keeps of Cursor CLI accounts under Orbit's own home: Default's directory and the added
// accounts. The tests run on homes of their own, so the runner's own must not change.
export function orbitCursorAccountPaths(home) {
  const orbitHome = process.env.ORBIT_HOME ?? path.join(home, '.orbit');
  return [path.join(orbitHome, 'cursor', 'default'), path.join(orbitHome, 'cursor-accounts')];
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-accounts-runner-'));
  const home = process.env.HOME ?? homedir();
  const watched = [...userCursorPaths(home), ...orbitCursorAccountPaths(home)];
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
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "P4b tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
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

    assert.deepEqual(changed(), [], 'the runner user\'s Cursor CLI directories or Orbit\'s Cursor CLI accounts changed');
    process.stdout.write(`PASS unchanged: ${watched.map((entry) => `~/${path.relative(home, entry)}`).join(', ')}.\n`);
    process.stdout.write(`P4b acceptance passed: ${names.length} named runner scenarios, none missing, unmatched or skipped.\n`);
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

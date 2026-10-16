// Acceptance for project P5a (Cursor CLI native, 34gyHIZv301nDWxKP9XkO): the runner drives one resident
// Cursor CLI `agent acp` per session — initialize, then session/new, its runtime session id kept — and maps
// what it streams onto Orbit's transcript: text, thinking, tools under the names and inputs of the Orbit
// tools they are, plans, sub-agents, the session's title and its slash commands. Each turn settles exactly
// once, no context reading is ever reported, images go in as Cursor's promptCapabilities allow, and the
// providerRuntimes entry is json-rpc and declares no mid-turn steer. The CLI is a fake replaying the P0
// recordings in src/runner-go/testdata/cursor/. Run from the repository root:
//
//   node scripts/test-cursor-acp-driver.mjs
//
// Every named Go scenario below runs in one `go test -run` that matches exactly these names, and each is
// required to run and pass exactly once: a scenario missing, renamed, unmatched, skipped or failing, or a
// test process that did not start, is a non-zero exit (Go has no todo; anything but run, pass and output
// is refused). The guards are scripts/test-dsh-routing.mjs's, by way of scripts/test-dsh-runtime-environment.mjs
// and scripts/test-cursor-runner-install.mjs, reused as they are and checked against this script's own
// names before they are trusted. Every real engine CLI and Cursor's own commands are replaced on PATH by
// stubs that fail, and the runner user's real ~/.cursor family is fingerprinted before and after.
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
  'cursor_acp_test.go': [
    // Initialization and the new session: the handshake the contract settled on, then session/new in the
    // session's checkout, on the session's credential.
    'TestCursorACPInitializeAndNewSession',
    'TestCursorACPInitializeAndNewSession/handshake',
    'TestCursorACPInitializeAndNewSession/dispatched-key',
    'TestCursorACPInitializeAndNewSession/default-account-login',
    'TestCursorACPInitializeAndNewSession/signed-out',
    'TestCursorACPInitializeAndNewSession/model-and-effort',
    // Every kind of update the recordings hold, as the Orbit event it is.
    'TestCursorACPEventMapping',
    'TestCursorACPEventMapping/text-and-thinking',
    'TestCursorACPEventMapping/tools',
    'TestCursorACPEventMapping/plan',
    'TestCursorACPEventMapping/subagent',
    'TestCursorACPEventMapping/title',
    'TestCursorACPEventMapping/title-not-asked-for',
    'TestCursorACPEventMapping/slash-commands',
    // Tool names and inputs, as the Orbit tools they are.
    'TestCursorACPToolNameNormalization',
    'TestCursorACPToolNameNormalization/recorded',
    'TestCursorACPToolNameNormalization/rules',
    // Two turns, each settled exactly once.
    'TestCursorACPTwoTurnsSettleOnce',
    'TestCursorACPTwoTurnsSettleOnce/two-turns',
    'TestCursorACPTwoTurnsSettleOnce/second-message-waits-for-the-first-turn',
    'TestCursorACPTwoTurnsSettleOnce/late-session-updates',
    // The runtime session id, kept and never replaced by a new conversation.
    'TestCursorACPRuntimeSessionIDPersisted',
    'TestCursorACPRuntimeSessionIDPersisted/persisted',
    'TestCursorACPRuntimeSessionIDPersisted/never-replaced-by-a-new-session',
    // The providerRuntimes entry: json-rpc, no mid-turn steer.
    'TestCursorACPProviderRuntimeDeclaresNoSteer',
    'TestCursorACPProviderRuntimeDeclaresNoSteer/table',
    'TestCursorACPProviderRuntimeDeclaresNoSteer/steer-refused',
    // Images as promptCapabilities allow.
    'TestCursorACPImageAttachments',
    'TestCursorACPImageAttachments/prompt-capabilities',
    'TestCursorACPImageAttachments/no-image-capability',
    'TestCursorACPShellTurns',
  ],
  'cursor_launch_test.go': [
    // The CLI's environment: the runner's allowlist, the workspace's variables, the contract's over both.
    'TestCursorLaunchEnvironmentLayers',
    'TestCursorLaunchEnvironmentLayers/workspace-key-without-a-login',
    'TestCursorLaunchEnvironmentLayers/dispatched-key-wins',
    'TestCursorLaunchEnvironmentLayers/default-login-only-without-a-credential-of-its-own',
    'TestCursorLaunchEnvironmentLayers/contract-variables-win',
    'TestCursorLaunchEnvironmentLayers/workspace-variables-reach-commands',
  ],
  'provider_runtime_test.go': [
    // Every engine, Cursor CLI's included, has its transport and its driver.
    'TestProviderRuntimesDeclareOneTransportPerEngine',
    'TestRuntimeProviderResolvesEveryDeclaredRuntime',
  ],
  'provider_steer_refusal_test.go': [
    // A loop that cannot steer refuses a steer; nothing declares one it cannot deliver.
    'TestEverySessionLoopThatCannotSteerRefusesOne',
    'TestOnlyAnImplementedSteerIsDeclaredToTheControlPlane',
    'TestOnlyEnginesWithAMidTurnMethodClaimToSteer',
  ],
};

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-acp-driver-'));
  const home = process.env.HOME ?? homedir();
  const watched = userCursorPaths(home);
  const before = watched.map((entry) => harnessDirectoryFingerprint(entry));
  const changed = () => watched.filter((entry, i) => harnessDirectoryFingerprint(entry) !== before[i]);
  try {
    for (const file of Object.keys(mandatoryGoCases)) {
      assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: ${file}`);
    }
    assert.ok(existsSync(path.join(root, 'src/runner-go/testdata/cursor/multi-turn-tools-default/turns/stdout.jsonl')),
      'missing the P0 recordings the fake Cursor CLI replays');
    const names = Object.values(mandatoryGoCases).flat();
    checkGuards(names, scratch);
    process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, failed and unstarted scenarios.\n');

    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx']) {
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "P5a tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
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
    process.stdout.write(`P5a acceptance passed: ${names.length} named runner scenarios, none missing, unmatched or skipped.\n`);
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

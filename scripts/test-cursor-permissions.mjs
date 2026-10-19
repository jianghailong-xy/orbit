// Acceptance for project P5c (Cursor CLI native, 34gyHIZv301nDWxKP9XkO): Orbit's MCP server in a Cursor CLI
// session, the approvals Cursor CLI asks for answered through Orbit's cards, every permission mode the
// control plane admits held to what it says, and the checkout's own .cursor/ configuration kept from
// getting around Orbit. The runner side runs on the pinned CLI's recordings — P0's and P5c's own of the
// runner on the real CLI (src/runner-go/testdata/cursor/p5c/) — replayed by the fake in
// src/runner-go/fake_cursor_acp_test.go; the shared and API server sides on their own specs. Run from the
// repository root:
//
//   node scripts/test-cursor-permissions.mjs
//
// Every named scenario below is required to run and pass exactly once: a scenario missing, renamed,
// unmatched, skipped, marked todo or failing, or a test process that did not start, is a non-zero exit.
// The guards are scripts/test-dsh-routing.mjs's, by way of scripts/test-dsh-runtime-environment.mjs,
// scripts/test-dsh-mcp-approval.mjs and scripts/test-cursor-runner-install.mjs, reused as they are and
// checked against this script's own names before they are trusted. Every real engine CLI and Cursor's own
// commands are replaced on PATH by stubs that fail, and the runner user's real ~/.cursor family is
// fingerprinted before and after.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults, assertVitestResults } from './test-dsh-routing.mjs';
import { assertGoResults, goTestPattern, harnessDirectoryFingerprint, runLogged, runnerEnvironment } from './test-dsh-runtime-environment.mjs';
import { assertNamedTap } from './test-dsh-mcp-approval.mjs';
import { checkGuards, userCursorPaths } from './test-cursor-runner-install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

const modes = ['accept-edits', 'auto', 'bypass', 'plan', 'dont-ask'];

// Exact mandatory Go scenario names, independent of what `go test` happens to discover.
export const mandatoryGoCases = {
  'cursor_permissions_test.go': [
    // Each declared mode, on the six permission requests P0 recorded in one conversation: allowed and
    // refused as the mode says; a person asked only where the mode asks one.
    'TestCursorPermissionModes',
    'TestCursorPermissionModes/accept-edits/allow',
    'TestCursorPermissionModes/accept-edits/deny',
    'TestCursorPermissionModes/auto/allow',
    'TestCursorPermissionModes/auto/deny',
    'TestCursorPermissionModes/bypass/team-veto-allow',
    'TestCursorPermissionModes/bypass/team-veto-deny',
    'TestCursorPermissionModes/plan/allow',
    'TestCursorPermissionModes/plan/deny',
    'TestCursorPermissionModes/dont-ask/allow',
    'TestCursorPermissionModes/dont-ask/deny',
    // The runner keeps exactly the modes the control plane admits; each starts the CLI as it must; a mode
    // it cannot be held to, and a denylist, are refused before the CLI starts; a mode change moves the
    // session's Cursor mode or starts a new process.
    'TestCursorPermissionModes/mode-table',
    'TestCursorPermissionModes/launch-flags',
    'TestCursorPermissionModes/unsupported-mode-refused',
    'TestCursorPermissionModes/denylist-refused',
    'TestCursorPermissionModes/mode-change',
    // Stopped and disconnected while a person was being asked, in every declared mode: the request is
    // answered cancelled, the card withdrawn, the turn settled once, and a late answer goes nowhere.
    'TestCursorApprovalInterrupted',
    ...modes.flatMap((mode) => [`TestCursorApprovalInterrupted/${mode}/stop`, `TestCursorApprovalInterrupted/${mode}/disconnect`]),
    'TestCursorApprovalInterrupted/control-plane-lost',
    // The bridge's own rules: no option Orbit does not know is ever chosen, a late answer has no effect,
    // nothing is answered outside a turn but cancelled, a web fetch is matched to its card.
    'TestCursorPermissionBridge',
    'TestCursorPermissionBridge/unknown-options-never-allowed',
    'TestCursorPermissionBridge/late-answer-has-no-effect',
    'TestCursorPermissionBridge/request-outside-a-turn',
    'TestCursorPermissionBridge/web-fetch-matched-to-its-card',
    'TestCursorPermissionBridge/auto-classifier',
    // Orbit's MCP server: injected with the session's identity on session/new and session/load, its tools
    // allowed unasked and shown under their Orbit names; the agent's own servers checked.
    'TestCursorOrbitMCP',
    'TestCursorOrbitMCP/injected-with-session-identity',
    'TestCursorOrbitMCP/recorded-call',
    'TestCursorOrbitMCP/agent-servers',
    // A person's "always allow": answered once, never with Cursor CLI's allow-always, which only the
    // session's own directory could hold.
    'TestCursorAllowAlways',
    'TestCursorAllowAlways/answered-once',
    'TestCursorAllowAlways/recorded',
    'TestCursorAllowAlways/landing',
    // Cursor CLI's blocking questions: cursor/ask_question and cursor/create_plan always answered.
    'TestCursorExtensionRequests',
    'TestCursorExtensionRequests/ask-question-answered',
    'TestCursorExtensionRequests/ask-question-skipped',
    'TestCursorExtensionRequests/ask-question-dont-ask',
    'TestCursorExtensionRequests/ask-question-stop',
    'TestCursorExtensionRequests/create-plan-accepted',
    'TestCursorExtensionRequests/create-plan-rejected',
    'TestCursorExtensionRequests/create-plan-stop',
    // Plan held when the model switches Cursor's mode itself.
    'TestCursorPlanModeSwitch',
    'TestCursorPlanModeSwitch/recorded',
    // The checkout's .cursor/ configuration in a protected mode, and the session's own directories.
    'TestCursorRepoConfig',
    'TestCursorRepoConfig/malicious-repo-protected',
    'TestCursorRepoConfig/user-config-refused',
    'TestCursorRepoConfig/session-config-owned',
    // Orbit's agent instructions ahead of a new conversation's first prompt only.
    'TestCursorAgentInstructions',
    'TestCursorAgentInstructions/first-prompt',
    'TestCursorAgentInstructions/loaded-conversation',
  ],
  'cursor_acp_test.go': [
    // P5a's scenarios whose code paths P5c changed: the approvals, the plan and the opening of a conversation.
    'TestCursorACPInitializeAndNewSession',
    'TestCursorACPInitializeAndNewSession/handshake',
    'TestCursorACPEventMapping',
    'TestCursorACPEventMapping/tools',
    'TestCursorACPEventMapping/plan',
    'TestCursorACPToolNameNormalization',
    'TestCursorACPToolNameNormalization/recorded',
    'TestCursorACPToolNameNormalization/rules',
  ],
};

// Shared: the permission table every client and the server describe a Cursor CLI session with.
export const sharedCases = {
  'src/cursor-engine.spec.ts': [
    'P1 cursor is the seventh engine under its CLI name, with an opaque model space defaulting to Auto',
    'P1 a runner sign-in to cursor runs on cursor alone, and no other credential runs on cursor',
    'P1 cursor is one resident JSON-RPC process per session with no mid-turn steer and no fast lane',
    'P5c cursor keeps Accept Edits, Plan, Auto, Don’t Ask and Bypass, and refuses Default with a note',
    'P1 the six existing engines keep their names, transports, steer and permission tables',
  ],
};

// The API server: admission refuses a mode Cursor CLI cannot be held to, at create, resume and
// reconfiguration, and a person's "always allow" is answered from the workspace's rule. The first file is
// required whole, so every engine's permission semantics stay covered.
export const apiCases = {
  'common/permission-semantics': null,
  'common/permission-rules': [
    "P5c Cursor CLI's cards are answered from the same rules, and its own allowlist never gets them",
    "antigravity's approval hook is answered from the same rules, as Kimi's bridge is",
    'claude is never answered here — its own matcher already had the rules',
    'syntax a prefix cannot describe is never auto-allowed',
  ],
  'common/cursor-runtime-routing': [
    'P1 the server admits exactly the Cursor CLI modes the picker calls kept, and defaults to Accept Edits',
  ],
  'sessions/cursor-session-preflight': [
    'P1 cursor preflight: a new session nobody named a mode for starts in one Cursor CLI keeps',
    'P1 cursor preflight: a mode the caller names has to be one Cursor CLI keeps',
    'P1 cursor preflight: resume and reconfiguration refuse a runner that withdrew the declaration, or a mode Cursor CLI refuses',
  ],
};

// Every test of a file required whole, as its TAP output names them.
function tapNames(output) {
  return [...output.matchAll(/^\s*ok \d+ - (.+)$/gm)].map((match) => match[1]);
}

function runTypeScript(scratch) {
  const api = path.join(root, 'src/apiserver');
  assert.ok(existsSync(path.join(root, 'node_modules/.bin/tsc')), 'missing root node_modules; run bash scripts/worktree-overlay.sh first');
  runLogged('npm', ['run', 'build', '-w', '@orbit/shared'], path.join(scratch, 'shared-build.log'), { cwd: root, timeout: 10 * 60_000 });
  for (const [file, names] of Object.entries(sharedCases)) {
    assert.ok(existsSync(path.join(root, 'src/shared', file)), `missing required test file: src/shared/${file}`);
    const report = path.join(scratch, `${path.basename(file)}.json`);
    const output = runLogged(path.join(root, 'node_modules/.bin/vitest'), ['run', file, '--reporter=json', `--outputFile=${report}`],
      path.join(scratch, 'vitest.log'), { cwd: path.join(root, 'src/shared') });
    process.stdout.write(output);
    assertVitestResults(JSON.parse(readFileSync(report, 'utf8')), names);
    for (const name of names) process.stdout.write(`PASS ${name}\n`);
  }
  rmSync(path.join(api, 'build'), { recursive: true, force: true });
  runLogged(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.test.json'], path.join(scratch, 'api-tsc.log'), { cwd: api, timeout: 10 * 60_000 });
  let count = Object.values(sharedCases).flat().length;
  for (const [file, names] of Object.entries(apiCases)) {
    assert.ok(existsSync(path.join(api, `src/${file}.spec.ts`)), `missing required test source: ${file}`);
    const spec = path.join(api, `build/${file}.spec.js`);
    assert.ok(existsSync(spec), `missing compiled test: ${spec}`);
    const output = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', spec],
      path.join(scratch, `${path.basename(file)}.tap`), { cwd: api });
    process.stdout.write(output);
    if (names === null) {
      // Required whole: every test the file holds runs and passes, and the P5c one is among them.
      const whole = tapNames(output);
      assert.ok(whole.includes('P5c cursor: the server admits exactly the modes the picker describes as kept, Auto among them'),
        `${file} lost its P5c scenario`);
      assertTapResults(output, whole);
      count += whole.length;
    } else {
      assertNamedTap(output, names);
      count += names.length;
    }
  }
  return count;
}

function runGo(scratch) {
  const names = Object.values(mandatoryGoCases).flat();
  for (const file of Object.keys(mandatoryGoCases)) {
    assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: ${file}`);
  }
  for (const recording of ['multi-turn-tools-default/turns', 'p5c/fixtures/malicious-repo/README.md']) {
    assert.ok(existsSync(path.join(root, 'src/runner-go/testdata/cursor', recording)), `missing the recording or fixture ${recording}`);
  }
  checkGuards(names, scratch);
  process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, failed and unstarted scenarios.\n');
  const blockedBin = path.join(scratch, 'blocked-bin');
  mkdirSync(blockedBin, { mode: 0o700 });
  for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx', 'direnv']) {
    writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "P5c tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
  }
  // serviceLoginPath appends the engine installers' own directories; keep them behind the stubs.
  const loginHome = userInfo().homedir;
  const toolPath = [blockedBin, path.dirname(process.execPath), '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin',
    path.join(loginHome, '.local/bin'), path.join(loginHome, '.opencode/bin'), path.join(loginHome, '.kimi-code/bin')].join(path.delimiter);
  const output = runLogged('go', ['test', '-json', '-count=1', '-timeout=600s', '-run', goTestPattern(names), '.'], path.join(scratch, 'runner.json'), {
    cwd: path.join(root, 'src/runner-go'), env: runnerEnvironment(process.env, scratch, toolPath), timeout: 900_000,
  });
  process.stdout.write(output);
  assertGoResults(output, names);
  for (const name of names) process.stdout.write(`PASS ${name}\n`);
  return names.length;
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-permissions-'));
  const home = process.env.HOME ?? homedir();
  const watched = userCursorPaths(home);
  const before = watched.map((entry) => harnessDirectoryFingerprint(entry));
  const changed = () => watched.filter((entry, i) => harnessDirectoryFingerprint(entry) !== before[i]);
  try {
    const runner = runGo(scratch);
    const typescript = runTypeScript(scratch);
    assert.deepEqual(changed(), [], 'the runner user\'s Cursor CLI directories changed');
    process.stdout.write(`PASS the runner user's ${watched.map((entry) => `~/${path.relative(home, entry)}`).join(', ')} are unchanged.\n`);
    process.stdout.write(`P5c acceptance passed: ${runner} named runner scenarios and ${typescript} shared and API server scenarios, ` +
      'none missing, unmatched or skipped.\n');
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

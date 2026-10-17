// Acceptance for the P5b follow-up of project "Cursor CLI native" (34gyHIZv301nDWxKP9XkO): every Cursor CLI
// session runs in a process scope of its own (docs/cursor-runtime-contract.md §3.4), so nothing the session
// started outlives it — not the commands Cursor runs detached in process groups of their own, not what those
// commands detach in turn, not what is orphaned when the CLI is killed. On Linux the recorded CLI
// (src/runner-go/fake_cursor_acp_test.go) starts a helper in its own process group, a detached command with
// a child, a process the command moved into a session of its own and a daemon orphaned at once; and after
// Orbit stops the session mid-turn (the person's Stop the CLI never answers, the engine stopped, the runner
// stopping), after an answered Stop and then the session's end, after the session's end mid-turn and after a
// turn, after the CLI is SIGKILLed mid-turn, after the lease is lost and after the runner goes away, none of
// the session's processes is left, while another Cursor session's processes, a runner-hosted bg_run job and a
// process tree started the way every other engine starts its own carry on. Every other engine keeps the
// process-group teardown it had: the runner never becomes a subreaper, their processes still start under it
// directly, and only the Cursor driver starts one in a scope. Run from the repository root:
//
//   node scripts/test-cursor-process-scope.mjs
//
// Every named Go scenario below runs in one `go test -run` that matches exactly these names, and each is
// required to run and pass exactly once: a scenario missing, renamed, unmatched, skipped or failing, or a
// test process that did not start, is a non-zero exit (Go has no todo; anything but run, pass and output is
// refused). The guards are scripts/test-dsh-routing.mjs's, by way of scripts/test-dsh-runtime-environment.mjs
// and scripts/test-cursor-runner-install.mjs, reused as they are and checked against this script's own names
// before they are trusted. Every real engine CLI and Cursor's own commands are replaced on PATH by stubs that
// fail, the runner user's real ~/.cursor family is fingerprinted before and after, and once the tests are
// done no process this run marked may be running anywhere on the machine.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGoResults, goTestPattern, harnessDirectoryFingerprint, runLogged, runnerEnvironment } from './test-dsh-runtime-environment.mjs';
import { checkGuards, userCursorPaths } from './test-cursor-runner-install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// Exact mandatory scenario names, independent of what `go test` happens to discover.
export const mandatoryGoCases = {
  'cursor_process_scope_test.go': [
    // However a Cursor session's process ends, none of its processes is left; the neighbours are untouched.
    'TestCursorProcessScope',
    'TestCursorProcessScope/stop-mid-turn',
    'TestCursorProcessScope/stop-engine-mid-turn',
    'TestCursorProcessScope/stop-runner-mid-turn',
    'TestCursorProcessScope/answered-stop-then-session-end',
    'TestCursorProcessScope/session-end-mid-turn',
    'TestCursorProcessScope/session-end-after-turn',
    'TestCursorProcessScope/cli-sigkill-mid-turn',
    'TestCursorProcessScope/lease-loss-mid-turn',
    'TestCursorProcessScope/runner-gone-mid-turn',
    // Every other engine keeps what it had.
    'TestSessionProcessScopeOtherEngines',
    'TestSessionProcessScopeOtherEngines/runner-not-a-subreaper',
    'TestSessionProcessScopeOtherEngines/engine-process-starts-directly',
    'TestSessionProcessScopeOtherEngines/scope-only-in-the-cursor-driver',
  ],
  'session_process_tree_test.go': [
    // The process-group teardown every other engine's process gets, unchanged.
    'TestSessionProcessTreeCancellationKillsShellDescendant',
    'TestSessionProcessTreeWaitKillsDescendantAfterLeaderExit',
  ],
};

// The variable each test session's processes carry (cursorScopeMarkerVar), and the one that makes every
// marker of this run begin with the run's own id.
const markerVar = 'ORBIT_TEST_PROCESS_SCOPE';
const runVar = 'ORBIT_TEST_PROCESS_SCOPE_RUN';

// Every process still running on the machine whose environment carries one of this run's markers.
function markedProcesses(runId) {
  const marked = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let environ;
    let stat;
    try {
      environ = readFileSync(`/proc/${entry}/environ`, 'latin1');
      stat = readFileSync(`/proc/${entry}/stat`, 'latin1');
    } catch {
      continue; // gone, or not ours to read
    }
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    if (state !== 'Z' && environ.split('\0').some((variable) => variable.startsWith(`${markerVar}=${runId}-`))) {
      marked.push(`${entry} ${stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))} (${state})`);
    }
  }
  return marked;
}

function runAcceptance() {
  assert.equal(process.platform, 'linux', 'the per-session process scope is Linux\'s (PR_SET_CHILD_SUBREAPER); elsewhere a session keeps the process-group teardown (contract §3.4)');
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-process-scope-'));
  const runId = randomBytes(6).toString('hex');
  const home = process.env.HOME ?? homedir();
  const watched = userCursorPaths(home);
  const before = watched.map((entry) => harnessDirectoryFingerprint(entry));
  const changed = () => watched.filter((entry, i) => harnessDirectoryFingerprint(entry) !== before[i]);
  try {
    for (const file of Object.keys(mandatoryGoCases)) {
      assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: ${file}`);
    }
    for (const recording of ['crash-recover-and-move/crash', 'cancel-mid-tool/cancel', 'multi-turn-tools-default/turns']) {
      assert.ok(existsSync(path.join(root, 'src/runner-go/testdata/cursor', recording, 'stdout.jsonl')),
        `missing the P0 recording the fake Cursor CLI replays: ${recording}`);
    }
    const names = Object.values(mandatoryGoCases).flat();
    checkGuards(names, scratch);
    process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, failed and unstarted scenarios.\n');

    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx']) {
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "process-scope tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
    }
    // serviceLoginPath appends the engine installers' own directories; keep them behind the stubs.
    const loginHome = userInfo().homedir;
    const toolPath = [blockedBin, path.dirname(process.execPath), '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin',
      path.join(loginHome, '.local/bin'), path.join(loginHome, '.opencode/bin'), path.join(loginHome, '.kimi-code/bin')].join(path.delimiter);
    const output = runLogged('go', ['test', '-json', '-count=1', '-timeout=300s', '-run', goTestPattern(names), '.'], path.join(scratch, 'runner.json'), {
      cwd: path.join(root, 'src/runner-go'), env: { ...runnerEnvironment(process.env, scratch, toolPath), [runVar]: runId }, timeout: 900_000,
    });
    process.stdout.write(output);
    assertGoResults(output, names);
    for (const name of names) process.stdout.write(`PASS ${name}\n`);

    const left = markedProcesses(runId);
    assert.deepEqual(left, [], `processes the tests started are still running: ${left.join(', ')}`);
    process.stdout.write('PASS no process this run started is left running anywhere on the machine.\n');
    assert.deepEqual(changed(), [], 'the runner user\'s Cursor CLI directories changed');
    process.stdout.write(`PASS the runner user's ${watched.map((entry) => `~/${path.relative(home, entry)}`).join(', ')} are unchanged.\n`);
    process.stdout.write(`P5b follow-up acceptance passed: ${names.length} named runner scenarios, none missing, unmatched or skipped.\n`);
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

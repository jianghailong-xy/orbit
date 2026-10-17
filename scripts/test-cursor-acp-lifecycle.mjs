// Acceptance for project P5b (Cursor CLI native, 34gyHIZv301nDWxKP9XkO): a Cursor CLI session's interrupts,
// mid-turn messages, recovery and failures come out right. A message that arrives mid-turn waits for the next
// turn and never becomes a second session/prompt (which would cancel the running turn), and a steer is
// refused; a stop is a session/cancel and settles the turn interrupted, the card it left in progress closed;
// a later process continues the conversation with session/load under the same id and writes none of what
// Cursor replays, and a conversation it cannot find is never replaced by a new one; every turn settles once —
// on Cursor's answer, then Orbit's own stop, the process exiting, the connection closing, the lease moving —
// and a turn whose prompt may have run is never sent again; not signed in, an expired credential, the usage
// limit, a rate limit, the network down and a model the account is not offered are classified by the shapes
// P0a recorded; and no turn reads out a context or a cost. The CLI is a fake replaying the P0 recordings in
// src/runner-go/testdata/cursor/. Run from the repository root:
//
//   node scripts/test-cursor-acp-lifecycle.mjs
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
  'cursor_acp_lifecycle_test.go': [
    // A message that arrives mid-turn waits for the next turn, with no second session/prompt; a steer is refused.
    'TestCursorACPMidTurnMessages',
    'TestCursorACPMidTurnMessages/queued-to-the-next-turn',
    'TestCursorACPMidTurnMessages/no-second-prompt-while-busy',
    'TestCursorACPMidTurnMessages/steer-refused',
    // A stop is a session/cancel: the turn settles interrupted, the card it left in progress closed as an error.
    'TestCursorACPInterrupt',
    'TestCursorACPInterrupt/cancel-settles-interrupted',
    'TestCursorACPInterrupt/unanswered-cancel-ends-the-process',
    // session/load continues the conversation, its replay written nowhere; nothing is prompted twice or replaced.
    'TestCursorACPResume',
    'TestCursorACPResume/load-replays-nothing',
    'TestCursorACPResume/crash-then-load-continues',
    'TestCursorACPResume/redelivered-turn-not-prompted-again',
    'TestCursorACPResume/load-not-found-is-not-replaced',
    'TestCursorACPResume/unspoken-conversation-reopens',
    // Each settlement path settles a turn once, by precedence.
    'TestCursorACPSettlement',
    'TestCursorACPSettlement/precedence',
    'TestCursorACPSettlement/prompt-answer',
    'TestCursorACPSettlement/process-exit',
    'TestCursorACPSettlement/eof-without-result',
    'TestCursorACPSettlement/lease-loss',
    // The failures Cursor reports, by their recorded shapes; none of them a success.
    'TestCursorACPErrorClassification',
    'TestCursorACPErrorClassification/not-signed-in',
    'TestCursorACPErrorClassification/credential-expired',
    'TestCursorACPErrorClassification/usage-limit',
    'TestCursorACPErrorClassification/rate-limit',
    'TestCursorACPErrorClassification/network-down',
    'TestCursorACPErrorClassification/model-unavailable',
    'TestCursorACPErrorClassification/content-refused',
    'TestCursorACPErrorClassification/protocol-error-not-success',
    'TestCursorACPErrorClassification/turn-failure-sentences',
    // No context reading and no cost, whatever a turn settles on.
    'TestCursorACPContextUnavailable',
  ],
};

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-acp-lifecycle-'));
  const home = process.env.HOME ?? homedir();
  const watched = userCursorPaths(home);
  const before = watched.map((entry) => harnessDirectoryFingerprint(entry));
  const changed = () => watched.filter((entry, i) => harnessDirectoryFingerprint(entry) !== before[i]);
  try {
    for (const file of Object.keys(mandatoryGoCases)) {
      assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: ${file}`);
    }
    for (const recording of ['prompt-while-busy/busy', 'cancel-mid-tool/cancel', 'crash-recover-and-move/crash',
      'crash-recover-and-move/moved', 'crash-continue-and-shell-wrapper/continue', 'multi-turn-tools-default/load',
      'background-shell-and-commit/background', 'failure-shapes-without-prompt/offline', 'signed-out-handshake/acp']) {
      assert.ok(existsSync(path.join(root, 'src/runner-go/testdata/cursor', recording, 'stdout.jsonl')),
        `missing the P0 recording the fake Cursor CLI replays: ${recording}`);
    }
    const names = Object.values(mandatoryGoCases).flat();
    checkGuards(names, scratch);
    process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, failed and unstarted scenarios.\n');

    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx']) {
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "P5b tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
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
    process.stdout.write(`P5b acceptance passed: ${names.length} named runner scenarios, none missing, unmatched or skipped.\n`);
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

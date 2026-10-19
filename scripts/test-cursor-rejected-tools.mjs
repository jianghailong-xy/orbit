// Acceptance for D-P8-1 of project "Cursor CLI native" (34gyHIZv301nDWxKP9XkO): a tool call a Cursor CLI session
// refused is never shown as a success. Cursor CLI completes a command or an edit the runner answered reject-once
// with no output at all — P8's recording off the wire (src/runner-go/testdata/cursor/p8/) and P5c's
// accept-edits-allow-deny — which the runner read as a success with nothing to show. It now
// remembers every call it did not allow while the turn ran, from a person's card in Accept Edits or unasked in
// Don't Ask, and settles its card isError:true, "Not run: the tool call was rejected.". An allowed call keeps the
// exit code, stdout and stderr Cursor reported; an MCP call Cursor reports {rejected:true} for reads as before;
// a card a Stop or a lost connection withdrew still settles as P5c settles it; and the answers themselves are
// unchanged. The runner side runs on the pinned CLI's recordings, replayed by the fake in
// src/runner-go/fake_cursor_acp_test.go. Run from the repository root:
//
//   node scripts/test-cursor-rejected-tools.mjs
//
// Every named Go scenario below runs in one `go test -run` that matches exactly these names, and each is
// required to run and pass exactly once: a scenario missing, renamed, unmatched, skipped or failing, or a test
// process that did not start, is a non-zero exit (Go has no todo; anything but run, pass and output is
// refused). The guards are scripts/test-dsh-routing.mjs's, by way of scripts/test-dsh-runtime-environment.mjs
// and scripts/test-cursor-runner-install.mjs, reused as they are and checked against this script's own names
// before they are trusted. The P8 sample is checked to carry no credential, every real engine CLI and Cursor's
// own commands are replaced on PATH by stubs that fail, and the runner user's real ~/.cursor family is
// fingerprinted before and after.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGoResults, goTestPattern, harnessDirectoryFingerprint, runLogged, runnerEnvironment } from './test-dsh-runtime-environment.mjs';
import { checkGuards, userCursorPaths } from './test-cursor-runner-install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

const modes = ['accept-edits', 'auto', 'bypass', 'plan', 'dont-ask'];

// Exact mandatory scenario names, independent of what `go test` happens to discover.
export const mandatoryGoCases = {
  'cursor_permissions_test.go': [
    // A call the runner did not allow settles as not run: on P8's recording (a command refused on the card), on
    // P5c's (a command and a write outside the workspace refused on the card; a command refused unasked in Don't
    // Ask), and request by request (refused, unfiled, unknown options, allowed, withdrawn). An allowed call keeps
    // its exit code, stdout and stderr; an MCP call Cursor reports {rejected:true} for reads as before.
    'TestCursorRefusedToolCards',
    'TestCursorRefusedToolCards/p8-shell-rejected',
    'TestCursorRefusedToolCards/p5c-accept-edits-allow-deny',
    'TestCursorRefusedToolCards/p5c-dont-ask',
    'TestCursorRefusedToolCards/mcp-rejected-unchanged',
    'TestCursorRefusedToolCards/rules',
    // Stopped and disconnected while a request waited, in every declared mode, by P5c's rules: answered cancelled,
    // the card withdrawn, the turn settled once — and the withdrawn card's call settled as the turn's end settles
    // a call it cut short.
    'TestCursorApprovalInterrupted',
    ...modes.flatMap((mode) => [`TestCursorApprovalInterrupted/${mode}/stop`, `TestCursorApprovalInterrupted/${mode}/disconnect`]),
    'TestCursorApprovalInterrupted/control-plane-lost',
    // The answers themselves are what they were: each mode allows and refuses as before, the bridge keeps its own
    // rules, and Cursor CLI's questions and plans are answered as before.
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
    'TestCursorPermissionModes/mode-table',
    'TestCursorPermissionModes/launch-flags',
    'TestCursorPermissionModes/unsupported-mode-refused',
    'TestCursorPermissionModes/denylist-refused',
    'TestCursorPermissionModes/mode-change',
    'TestCursorPermissionBridge',
    'TestCursorPermissionBridge/unknown-options-never-allowed',
    'TestCursorPermissionBridge/late-answer-has-no-effect',
    'TestCursorPermissionBridge/request-outside-a-turn',
    'TestCursorPermissionBridge/web-fetch-matched-to-its-card',
    'TestCursorPermissionBridge/auto-classifier',
    'TestCursorExtensionRequests',
    'TestCursorExtensionRequests/ask-question-answered',
    'TestCursorExtensionRequests/ask-question-skipped',
    'TestCursorExtensionRequests/ask-question-dont-ask',
    'TestCursorExtensionRequests/ask-question-stop',
    'TestCursorExtensionRequests/create-plan-accepted',
    'TestCursorExtensionRequests/create-plan-rejected',
    'TestCursorExtensionRequests/create-plan-stop',
  ],
  'cursor_acp_test.go': [
    // Cards named and filled in from what Cursor streamed, as before: an allowed command's exit code, stdout and
    // stderr, a failed one's, and an MCP call's {rejected:true}.
    'TestCursorACPToolNameNormalization',
    'TestCursorACPToolNameNormalization/recorded',
    'TestCursorACPToolNameNormalization/rules',
  ],
};

// The recordings the scenarios replay, each a process directory under src/runner-go/testdata/cursor.
const recordings = ['p8/key-allow-reject/session', 'p5c/accept-edits-allow-deny/session', 'p5c/dont-ask/session',
  'p5c/accept-edits-stop/session', 'p5c/synthetic/ask-question/session', 'multi-turn-tools-default/turns',
  'plan-and-ask-modes-concurrent/modes'];

// The P8 sample carries nothing that looks like a credential — a Cursor key, a JWT, a bearer value, an e-mail
// address, a long run of base64 — no value under an environment variable whose name says it is secret but the
// redaction mark, and none of P8's stack paths or UUIDs, which were replaced. Returns the lines it read.
export function assertSampleRedacted(dir) {
  const suspects = [/key_[A-Za-z0-9]{12,}/, /crsr_[A-Za-z0-9]{12,}/, /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    /bearer\s+[A-Za-z0-9._~+/=-]{8,}/i, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /[A-Za-z0-9+/_-]{40,}/,
    /\/mnt\/data\//, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/];
  const secretName = /token|secret|key|password|cookie|auth/i;
  let lines = 0;
  for (const file of ['stdin.jsonl', 'stdout.jsonl']) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      lines++;
      const where = `${file}:${index + 1}`;
      const visit = (value, at, env) => {
        if (typeof value === 'string') {
          for (const pattern of suspects) assert.doesNotMatch(value, pattern, `${where} ${at} looks like a credential or an unredacted value`);
        } else if (Array.isArray(value)) {
          value.forEach((item, i) => visit(item, `${at}[${i}]`, env));
        } else if (value && typeof value === 'object') {
          if (env && typeof value.name === 'string' && secretName.test(value.name)) {
            assert.ok(value.value === '' || value.value === '<redacted>', `${where} ${at}: ${value.name} carries a value`);
          }
          for (const [key, item] of Object.entries(value)) visit(item, `${at}.${key}`, key === 'env');
        }
      };
      visit(JSON.parse(line), '', false);
    }
  }
  return lines;
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-rejected-tools-'));
  const home = process.env.HOME ?? homedir();
  const watched = userCursorPaths(home);
  const before = watched.map((entry) => harnessDirectoryFingerprint(entry));
  const changed = () => watched.filter((entry, i) => harnessDirectoryFingerprint(entry) !== before[i]);
  try {
    for (const file of Object.keys(mandatoryGoCases)) {
      assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: ${file}`);
    }
    for (const recording of recordings) {
      assert.ok(existsSync(path.join(root, 'src/runner-go/testdata/cursor', recording, 'stdout.jsonl')),
        `missing the recording the fake Cursor CLI replays: ${recording}`);
    }
    const sample = path.join(root, 'src/runner-go/testdata/cursor/p8/key-allow-reject/session');
    const lines = assertSampleRedacted(sample);
    // The check itself refuses a sample that leaks: a secret-named variable's value, a Cursor key, a stack path.
    for (const [label, file, line] of [
      ['a token', 'stdin.jsonl', { params: { mcpServers: [{ env: [{ name: 'ORBIT_BG_TOKEN', value: 'b7f0c1d2e3' }] }] } }],
      ['a Cursor key', 'stdout.jsonl', { params: { update: { title: 'key_0123456789abcdefABCDEF' } } }],
      ['a stack path', 'stdin.jsonl', { params: { cwd: '/mnt/data/p8-cursor-e2e/runners/p8-new/home/worktrees/w' } }],
    ]) {
      const leak = mkdtempSync(path.join(scratch, 'leak-'));
      for (const name of ['stdin.jsonl', 'stdout.jsonl']) writeFileSync(path.join(leak, name), name === file ? `${JSON.stringify(line)}\n` : '');
      assert.throws(() => assertSampleRedacted(leak), undefined, `the redaction check accepted ${label}`);
    }
    process.stdout.write(`PASS the P8 sample (${lines} lines) carries no key, token or unredacted path, and the check refuses one that does.\n`);

    const names = Object.values(mandatoryGoCases).flat();
    checkGuards(names, scratch);
    process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, failed and unstarted scenarios.\n');

    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx', 'direnv']) {
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "D-P8-1 tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
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

    assert.deepEqual(changed(), [], 'the runner user\'s Cursor CLI directories changed');
    process.stdout.write(`PASS the runner user's ${watched.map((entry) => `~/${path.relative(home, entry)}`).join(', ')} are unchanged.\n`);
    process.stdout.write(`D-P8-1 acceptance passed: ${names.length} named runner scenarios, none missing, unmatched or skipped.\n`);
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

// Acceptance for the D-P8-1 follow-up of project "Cursor CLI native" (34gyHIZv301nDWxKP9XkO): a tool call the
// runner answered with anything but an allow settles as "Not run: the tool call was rejected." (isError:true)
// even when the turn ends before Cursor CLI completes it — stopped, the CLI killed, or its connection closed
// (EOF). Cursor CLI waits on the answer before it runs a call and runs none it was refused (docs/
// cursor-runtime-contract.md §5.2), so "it may have run" was never true of such a card. An allowed card still
// settles as P5c settles it — one withdrawn unanswered when the turn ended now settles as not run as well
// (scripts/test-cursor-withdrawn-approval.mjs) — and a refused call Cursor did complete (D-P8-1) settles as
// before. The runner side runs on the pinned CLI's
// recordings — P8's (src/runner-go/testdata/cursor/p8/key-allow-reject) and P5c's — replayed by the fake in
// src/runner-go/fake_cursor_acp_test.go, held right after the runner's answer reached it. The contract's §5.2
// 「拒绝」 entry and its §16.4 tool_call / tool_call_update row are read last: both cite P8's recording. Run from
// the repository root:
//
//   node scripts/test-cursor-refusal-settle.mjs
//
// Every named Go scenario below runs in one `go test -run` that matches exactly these names, and each is
// required to run and pass exactly once: a scenario missing, renamed, unmatched, skipped or failing, or a test
// process that did not start, is a non-zero exit (Go has no todo; anything but run, pass and output is
// refused). The guards are scripts/test-dsh-routing.mjs's, by way of scripts/test-dsh-runtime-environment.mjs
// and scripts/test-cursor-runner-install.mjs, reused as they are and checked against this script's own names
// before they are trusted. Every real engine CLI and Cursor's own commands are replaced on PATH by stubs that
// fail, and the runner user's real ~/.cursor family is fingerprinted before and after.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGoResults, goTestPattern, harnessDirectoryFingerprint, runLogged, runnerEnvironment } from './test-dsh-runtime-environment.mjs';
import { checkGuards, userCursorPaths } from './test-cursor-runner-install.mjs';
import { markdownSection } from './test-cursor-session-title-prefix.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

const modes = ['accept-edits', 'auto', 'bypass', 'plan', 'dont-ask'];

// Exact mandatory scenario names, independent of what `go test` happens to discover.
export const mandatoryGoCases = {
  'cursor_permissions_test.go': [
    'TestCursorRefusedToolCards',
    // Refused, and the turn over before Cursor CLI completed the call: P8's turn as P8 answered it, `date -u >
    // notes-when.txt` refused on Orbit's card, then a Stop, the CLI killed, or its connection closed. And the
    // mapper alone, for every way a turn ends: Cursor's end_turn, a stop, an unknown stop reason, a failure.
    'TestCursorRefusedToolCards/p8-refused-then-stop',
    'TestCursorRefusedToolCards/p8-refused-then-disconnect',
    'TestCursorRefusedToolCards/p8-refused-then-eof',
    'TestCursorRefusedToolCards/turn-end-rules',
    // In a turn that refused a command earlier, a write allowed and then stopped settles as P5c settles it: it may
    // have run. The same write withdrawn from the card unanswered by the stop settles as not run.
    'TestCursorRefusedToolCards/p5c-allowed-then-stop',
    'TestCursorRefusedToolCards/p5c-withdrawn-then-stop',
    // D-P8-1 unchanged: a refused call Cursor CLI completed with nothing at all is not run, an allowed one keeps its
    // exit code, stdout and stderr, an MCP call Cursor reports {rejected:true} for reads as before, and the bridge's
    // own rules request by request.
    'TestCursorRefusedToolCards/p8-shell-rejected',
    'TestCursorRefusedToolCards/p5c-accept-edits-allow-deny',
    'TestCursorRefusedToolCards/p5c-dont-ask',
    'TestCursorRefusedToolCards/mcp-rejected-unchanged',
    'TestCursorRefusedToolCards/rules',
    // P5c's rule for a card still waiting on a request when the turn is stopped or the CLI is lost, in every
    // declared mode: answered cancelled, withdrawn, settled once, and a withdrawn permission card's call settled
    // as not run.
    'TestCursorApprovalInterrupted',
    ...modes.flatMap((mode) => [`TestCursorApprovalInterrupted/${mode}/stop`, `TestCursorApprovalInterrupted/${mode}/disconnect`]),
    'TestCursorApprovalInterrupted/control-plane-lost',
  ],
};

// The recordings the scenarios replay, each a process directory under src/runner-go/testdata/cursor.
const recordings = ['p8/key-allow-reject/session', 'p5c/accept-edits-allow-deny/session', 'p5c/dont-ask/session',
  'p5c/accept-edits-stop/session', 'multi-turn-tools-default/turns', 'plan-and-ask-modes-concurrent/modes'];

const p8Recording = 'testdata/cursor/p8/key-allow-reject';

/** What §5.2's 「拒绝」 entry has to say, word for word. */
export const refusalFacts = [
  p8Recording,
  'MCP：rawOutput `{rejected:true}`',
  'shell 和编辑：只有 `{status:"completed"}`，没有 rawOutput',
  '`p5c/accept-edits-allow-deny`',
  'Orbit 以自己回过的应答为准',
  '"Not run: the tool call was rejected."',
  'Stop、断连、进程退出或 EOF',
];

/** What §16.4's tool_call / tool_call_update row has to say, word for word. */
export const rowFacts = [
  p8Recording,
  '只有 MCP 被拒时有',
  '被拒以 Orbit 自己回过的应答为准',
  '"Not run: the tool call was rejected."',
  '`completed` 没到这一轮就结束也一样',
];

// What the contract said before D-P8-1 found it wrong: that a refused call completes with rawOutput {rejected:true},
// and that a refusal is read off rawOutput.
const retired = [
  '选 `reject-once` 后工具卡仍以 `completed` 结束，rawOutput `{rejected:true}`',
  'rawOutput 带 `rejected`、`exitCode≠0` 或 `error` 时标为失败或被拒',
];

/** §5.2's 「拒绝」 entry with its nested lines, and §16.4's tool_call / tool_call_update row. */
export function contractRefusal(text) {
  const lines = markdownSection(text, '### 5.2').split('\n');
  const starts = lines.flatMap((line, index) => (line.startsWith('- **拒绝**') ? [index] : []));
  assert.equal(starts.length, 1, 'missing or duplicate §5.2 「拒绝」 entry');
  let end = starts[0] + 1;
  while (end < lines.length && lines[end].startsWith('  ')) end++;
  const rows = markdownSection(text, '### 16.4').split('\n').filter((line) => line.startsWith('| `tool_call` / `tool_call_update` |'));
  assert.equal(rows.length, 1, 'missing or duplicate §16.4 tool_call / tool_call_update row');
  return { refusal: lines.slice(starts[0], end).join('\n'), row: rows[0] };
}

/** Both places cite P8's recording, say how Orbit settles a refused call, and the retired claims are gone. */
export function assertContract(text) {
  const { refusal, row } = contractRefusal(text);
  assert.match(refusal, /^- \*\*拒绝\*\*【实测】/, '§5.2 「拒绝」 is not marked as measured');
  for (const fact of refusalFacts) assert.ok(refusal.includes(fact), `§5.2 「拒绝」 does not say ${JSON.stringify(fact)}`);
  for (const fact of rowFacts) assert.ok(row.includes(fact), `§16.4 tool_call / tool_call_update does not say ${JSON.stringify(fact)}`);
  for (const claim of retired) assert.ok(!text.includes(claim), `the contract still says ${JSON.stringify(claim)}`);
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-refusal-settle-'));
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

    const names = Object.values(mandatoryGoCases).flat();
    checkGuards(names, scratch);
    // The contract check refuses a contract without any one of its facts, with a retired claim, or without either place.
    const contract = readFileSync(path.join(root, 'docs/cursor-runtime-contract.md'), 'utf8');
    const refused = (label, check) => assert.throws(check, undefined, `the contract check accepted ${label}`);
    for (const fact of new Set([...refusalFacts, ...rowFacts])) refused(`a contract without ${fact}`, () => assertContract(contract.split(fact).join('')));
    for (const claim of retired) refused(`a contract that says ${claim}`, () => assertContract(`${contract}\n${claim}\n`));
    refused('a 「拒绝」 entry not marked as measured', () => assertContract(contract.replace('- **拒绝**【实测】', '- **拒绝**')));
    refused('a contract without §16.4', () => assertContract(contract.replace('### 16.4 ', '### 16.9 ')));
    refused('a contract without the 「拒绝」 entry', () => assertContract(contract.replace('- **拒绝**', '- **拒**')));
    process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, failed and unstarted scenarios, and the contract check refuses a contract that lacks what it reads.\n');

    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx', 'direnv']) {
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "the refusal settlement tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
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

    assertContract(contract);
    process.stdout.write(`PASS docs/cursor-runtime-contract.md §5.2 「拒绝」 and §16.4 tool_call / tool_call_update cite ${p8Recording} and say how Orbit settles a refused call.\n`);

    assert.deepEqual(changed(), [], 'the runner user\'s Cursor CLI directories changed');
    process.stdout.write(`PASS the runner user's ${watched.map((entry) => `~/${path.relative(home, entry)}`).join(', ')} are unchanged.\n`);
    process.stdout.write(`D-P8-1 follow-up acceptance passed: ${names.length} named runner scenarios, none missing, unmatched or skipped, and the contract's two places.\n`);
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

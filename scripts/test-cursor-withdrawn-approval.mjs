// Acceptance for "withdrawn approval cards" of project "Cursor CLI native" (34gyHIZv301nDWxKP9XkO), task
// 34iTwiTCaIxwfXdQlHvIR: a Cursor CLI tool call whose approval card nobody had answered when its turn ended
// settles isError:true as not run — "Not run: the turn was stopped before this tool call was approved." when
// Orbit stopped the turn, "Not run: the turn ended before this tool call was approved." when it ended any other
// way (the CLI killed, exited, or its connection closed). The card is withdrawn and its request answered
// cancelled, which Cursor CLI takes as a refusal: P5c measured on the real CLI that the command never ran
// (src/runner-go/testdata/cursor/p5c/accept-edits-stop and accept-edits-disconnect), where Orbit used to say it
// "may have run". An allowed call the turn's end overtakes still settles as P5c settles it, and a call Orbit
// refused still settles as "Not run: the tool call was rejected.". The runner side runs on P5c's and P8's
// recordings, replayed by the fake in src/runner-go/fake_cursor_acp_test.go. The contract's §5.2 「拒绝」 entry
// is read next: its 【约定】 settles a withdrawn approval card as not run, cites both recordings, and keeps one
// exception only, the turn ledger's recovery. Last, the two acceptance scripts for refused calls run again as
// they are, and have to exit 0. Run from the repository root:
//
//   node scripts/test-cursor-withdrawn-approval.mjs
//
// Every named Go scenario below runs in one `go test -run` that matches exactly these names, and each is
// required to run and pass exactly once: a scenario missing, renamed, unmatched, skipped or failing, or a test
// process that did not start, is a non-zero exit (Go has no todo; anything but run, pass and output is
// refused). The guards are scripts/test-dsh-routing.mjs's, by way of scripts/test-dsh-runtime-environment.mjs
// and scripts/test-cursor-runner-install.mjs, reused as they are and checked against this script's own names
// before they are trusted. Every test command writes to a regular file, never a pipe. Every real engine CLI and
// Cursor's own commands are replaced on PATH by stubs that fail, and the runner user's real ~/.cursor family is
// fingerprinted before and after.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGoResults, goTestPattern, harnessDirectoryFingerprint, runLogged, runnerEnvironment } from './test-dsh-runtime-environment.mjs';
import { checkGuards, userCursorPaths } from './test-cursor-runner-install.mjs';
import { contractRefusal } from './test-cursor-refusal-settle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

const modes = ['accept-edits', 'auto', 'bypass', 'plan', 'dont-ask'];

// Exact mandatory scenario names, independent of what `go test` happens to discover.
export const mandatoryGoCases = {
  'cursor_permissions_test.go': [
    // The approval card still open, nobody having answered it, when the turn ends — on P5c's recordings, each
    // answered as P5c answered it: Orbit stops the turn (accept-edits-stop), the CLI is killed as P5c killed it
    // (accept-edits-disconnect), exits by itself (status 143), or closes its connection and runs on (EOF). Then
    // the mapper alone, for every way a turn ends — also when Cursor CLI completes the withdrawn call before the
    // turn settles — and the bridge alone: the withdrawal marks the card before the turn settles, before the
    // cancelled answer has gone out, and a card answered before the withdrawal is not marked by it; a request
    // that comes once the stop has closed the bridge is answered cancelled, unasked, and marked the same way.
    'TestCursorWithdrawnApprovals',
    'TestCursorWithdrawnApprovals/accept-edits-stop',
    'TestCursorWithdrawnApprovals/accept-edits-disconnect',
    'TestCursorWithdrawnApprovals/process-exit',
    'TestCursorWithdrawnApprovals/eof',
    'TestCursorWithdrawnApprovals/turn-end-rules',
    'TestCursorWithdrawnApprovals/marked-before-settle',
    'TestCursorWithdrawnApprovals/asked-after-the-stop',
    // The D-P8-1 follow-up's turn: the write withdrawn from the card by a stop now settles as not run; the same
    // write allowed and then stopped still settles as P5c settles it, and so does an unmarked card in the mapper.
    'TestCursorRefusedToolCards',
    'TestCursorRefusedToolCards/p5c-withdrawn-then-stop',
    'TestCursorRefusedToolCards/p5c-allowed-then-stop',
    'TestCursorRefusedToolCards/turn-end-rules',
    'TestCursorRefusedToolCards/rules',
    // A call Orbit refused is still "Not run: the tool call was rejected.": completed by Cursor (D-P8-1), or
    // overtaken by a stop, the CLI killed or its connection closed (the D-P8-1 follow-up); an allowed call keeps
    // its exit code, stdout and stderr, and an MCP call Cursor reports {rejected:true} for reads as before.
    'TestCursorRefusedToolCards/p8-refused-then-stop',
    'TestCursorRefusedToolCards/p8-refused-then-disconnect',
    'TestCursorRefusedToolCards/p8-refused-then-eof',
    'TestCursorRefusedToolCards/p8-shell-rejected',
    'TestCursorRefusedToolCards/p5c-accept-edits-allow-deny',
    'TestCursorRefusedToolCards/p5c-dont-ask',
    'TestCursorRefusedToolCards/mcp-rejected-unchanged',
    // Stopped or disconnected while a request waited, in every declared mode: answered cancelled, the card
    // withdrawn, the turn settled once, and a withdrawn permission card's call settled as not run.
    'TestCursorApprovalInterrupted',
    ...modes.flatMap((mode) => [`TestCursorApprovalInterrupted/${mode}/stop`, `TestCursorApprovalInterrupted/${mode}/disconnect`]),
    'TestCursorApprovalInterrupted/control-plane-lost',
  ],
  'cursor_acp_lifecycle_test.go': [
    // P0a's own stop: the command allowed as P0a allowed it, then stopped while it runs, settles as P5c settles a
    // call the turn cut short.
    'TestCursorACPInterrupt',
    'TestCursorACPInterrupt/cancel-settles-interrupted',
  ],
};

// The recordings the scenarios replay, each a process directory under src/runner-go/testdata/cursor.
const recordings = ['p5c/accept-edits-stop/session', 'p5c/accept-edits-disconnect/session', 'p5c/accept-edits-allow-deny/session',
  'p5c/dont-ask/session', 'p8/key-allow-reject/session', 'multi-turn-tools-default/turns', 'plan-and-ask-modes-concurrent/modes',
  'cancel-mid-tool/cancel'];

// The P5c runs the copy rests on: the card withdrawn unanswered, and the command found not to have run.
const measured = ['accept-edits-stop', 'accept-edits-disconnect'];

// The acceptance scripts for refused calls, run again as they are.
const siblings = ['scripts/test-cursor-refusal-settle.mjs', 'scripts/test-cursor-rejected-tools.mjs'];

/** What §5.2's 【约定】 has to say about a withdrawn approval card, word for word. */
export const withdrawnFacts = [
  '**撤回的审批卡按没有运行结算**',
  '`p5c/accept-edits-stop`',
  '`p5c/accept-edits-disconnect`',
  '命令都没有执行',
  '「撤回」标记',
  '赶在这一轮结算之前',
  '这一轮正在结束时才到的权限请求',
  '带撤回标记的卡按这一轮的终态结算，`isError:true`',
  '"Not run: the turn was stopped before this tool call was approved."',
  '"Not run: the turn ended before this tool call was approved."',
  '其他终态（断连、进程退出、EOF、出错）',
  '`withdraw`',
];

// What the contract said before: that a card the turn's end withdrew is left unmarked, to say it may have run.
const retired = ['轮次结束、Stop、断连、租约丢失时撤回的卡'];

/** §5.2's 【约定】 settles a withdrawn approval card as not run and cites P5c's two runs; its one exception is the ledger. */
export function assertContract(text) {
  const { refusal } = contractRefusal(text);
  const convention = refusal.indexOf('**Orbit 以自己回过的应答为准**【约定');
  const withdrawn = refusal.indexOf('**撤回的审批卡按没有运行结算**');
  assert.ok(convention >= 0, '§5.2 「拒绝」 has no 【约定】 on how Orbit settles a call');
  assert.ok(withdrawn > convention, '§5.2 does not settle a withdrawn approval card within its 【约定】');
  for (const fact of withdrawnFacts) assert.ok(refusal.includes(fact), `§5.2 「拒绝」 does not say ${JSON.stringify(fact)}`);
  const exceptions = refusal.split('\n').filter((line) => /^\s+- 例外/.test(line));
  assert.equal(exceptions.length, 1, '§5.2 「拒绝」 does not keep exactly one exception');
  assert.ok(exceptions[0].includes('只剩一种') && exceptions[0].includes('`recoverTurn`'), 'the one exception left is not the turn ledger\'s recovery');
  for (const claim of retired) assert.ok(!text.includes(claim), `the contract still says ${JSON.stringify(claim)}`);
}

/** P5c's own run of scenario withdrew the card unanswered and found the command not run (summary.json). */
function assertMeasured(scenario) {
  const summary = JSON.parse(readFileSync(path.join(root, 'src/runner-go/testdata/cursor/p5c', scenario, 'summary.json'), 'utf8'));
  const check = summary.checks.find((entry) => entry.name === 'command-did-not-run');
  assert.ok(check?.pass === true, `P5c's ${scenario} run did not find the command unrun`);
  assert.ok(summary.cards.length === 1 && summary.cards[0].withdrawn === true, `P5c's ${scenario} run did not withdraw its one card`);
  return check.detail;
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-withdrawn-approval-'));
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
    for (const sibling of siblings) assert.ok(existsSync(path.join(root, sibling)), `missing acceptance script: ${sibling}`);
    for (const scenario of measured) process.stdout.write(`PASS P5c's ${scenario} run withdrew its card unanswered and found the command not run (${assertMeasured(scenario)}).\n`);

    const names = Object.values(mandatoryGoCases).flat();
    checkGuards(names, scratch);
    // The contract check refuses a contract without any one of its facts, with the retired claim, with the
    // withdrawn card outside the 【约定】 or no 【约定】 at all, with a second exception, or with an exception that is
    // not the ledger's.
    const contract = readFileSync(path.join(root, 'docs/cursor-runtime-contract.md'), 'utf8');
    const refused = (label, check) => assert.throws(check, undefined, `the contract check accepted ${label}`);
    for (const fact of withdrawnFacts) refused(`a contract without ${fact}`, () => assertContract(contract.split(fact).join('')));
    for (const claim of retired) refused(`a contract that says ${claim}`, () => assertContract(`${contract}\n${claim}\n`));
    refused('a 「拒绝」 entry without its 【约定】', () => assertContract(contract.replace('**Orbit 以自己回过的应答为准**【约定', '**Orbit 以自己回过的应答为准**【')));
    refused('a withdrawn card ahead of the 【约定】', () => assertContract(contract.replace('**撤回的审批卡按没有运行结算**', '撤回的审批卡')
      .replace('- **拒绝**【实测】', '- **拒绝**【实测】**撤回的审批卡按没有运行结算**')));
    refused('a second exception', () => assertContract(contract.replace('    - 例外只剩一种：', '    - 例外：撤回的卡。\n    - 例外只剩一种：')));
    refused('an exception that is not the ledger\'s', () => assertContract(contract.replace('`cursor_acp.go` 的 `recoverTurn`', '`cursor_acp.go`')));
    process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, failed and unstarted scenarios, and the contract check refuses a contract that lacks what it reads.\n');

    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx', 'direnv']) {
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "the withdrawn approval tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
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
    process.stdout.write('PASS docs/cursor-runtime-contract.md §5.2 settles a withdrawn approval card as not run, cites p5c/accept-edits-stop and p5c/accept-edits-disconnect, and keeps the turn ledger\'s recovery as its one exception.\n');

    for (const sibling of siblings) {
      const log = path.join(scratch, `${path.basename(sibling, '.mjs')}.log`);
      const said = runLogged(process.execPath, [path.join(root, sibling)], log, { cwd: root, env: process.env, timeout: 1_200_000 });
      process.stdout.write(`${said.trimEnd().split('\n').slice(-3).join('\n')}\nPASS node ${sibling} exited 0\n`);
    }

    assert.deepEqual(changed(), [], 'the runner user\'s Cursor CLI directories changed');
    process.stdout.write(`PASS the runner user's ${watched.map((entry) => `~/${path.relative(home, entry)}`).join(', ')} are unchanged.\n`);
    process.stdout.write(`Withdrawn approval acceptance passed: ${names.length} named runner scenarios, none missing, unmatched or skipped; the contract's §5.2; and ${siblings.length} acceptance scripts for refused calls.\n`);
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

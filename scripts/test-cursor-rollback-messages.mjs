// Acceptance for "rollback messages" of project "Cursor CLI native" (34gyHIZv301nDWxKP9XkO), task
// 34ltROe2XUZ3rkfuS7F1h: the two problems P9's rollback drill found (its report §8.1 and §8.2).
//   - Web (§8.1): a conversation that has talked, whose next message waits in the queue with a reason in
//     the session's `error` — no runner can run its engine — gets the explanation card on its page: what
//     it waits for, and how that ends. It used to show only "Queued" and a "Working for …" that never
//     stopped, because the card asked for an `engineStartedAt` only a claim clears. A follow-up merely
//     waiting for a slot, and a turn that is running, still get no card.
//   - API server (§8.2): a runner whose release knows Cursor CLI — its engine report names it, or it
//     declares Cursor CLI's account sign-in — but that does not declare provider:cursor is missing the
//     CLI, so a Cursor CLI session refused there is told to install Cursor CLI on that runner, not to
//     update it; only a runner that predates Cursor CLI is still told to update. Antigravity's, DeepSeek
//     Harness's and OpenCode's notices are unchanged.
//   - The new copy is English: src/web/src/copyLanguage.test.ts passes.
// Run from the repository root (after `bash scripts/worktree-overlay.sh` in a fresh worktree):
//
//   node scripts/test-cursor-rollback-messages.mjs
//
// Every named scenario below is required to run and pass exactly once: a scenario missing, renamed,
// unmatched, skipped, marked todo or failing, or a test process that did not start, is a non-zero exit.
// The guards are scripts/test-dsh-routing.mjs's (TAP and Vitest), by way of
// scripts/test-dsh-runtime-environment.mjs, scripts/test-dsh-mcp-approval.mjs and
// scripts/test-dsh-failure-semantics.mjs, reused as they are and checked here against this script's own
// names before they are trusted. Every test process writes to a regular file, never into a pipe. No real
// engine CLI runs and no prompt is sent: the API server scenarios run on doubles, the web ones in jsdom.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';
import { runLogged } from './test-dsh-runtime-environment.mjs';
import { assertNamedTap } from './test-dsh-mcp-approval.mjs';
import { assertVitestNamed } from './test-dsh-failure-semantics.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// Exact mandatory scenario names, independent of what the test runners happen to discover.

// The API server, required whole: the refusal's words at every door, and what stays as it was.
export const apiCases = {
  'runner-api/cursor-rollback-messages': [
    'Rollback messages: a runner that knows Cursor CLI but does not declare it is told to install it, and only an older one to update',
    'Rollback messages: creating a Cursor CLI session on a runner without the CLI says to install it there, and on an older runner to update it',
    'Rollback messages: reviving or switching a session onto Cursor CLI on a runner without the CLI says to install it there',
    'Rollback messages: a queued Cursor CLI session waits with the install notice on a runner that knows Cursor CLI, and with the upgrade notice on an older one',
    'Rollback messages: a claim clears the install notice once a runner takes the session',
    'Rollback messages: the Antigravity, DeepSeek Harness and OpenCode notices are unchanged, on a runner that knows Cursor CLI too',
  ],
};

// The doors as P1 and the Install follow-up left them, for a runner that does not know Cursor CLI: still
// the upgrade notice; and DeepSeek Harness's own gate, as it was.
export const apiRegressions = {
  'sessions/cursor-session-preflight': [
    'P1 cursor preflight: a Cursor CLI session is created only on a runner whose heartbeat declares it',
    'P1 cursor preflight: resume and reconfiguration refuse a runner that withdrew the declaration, or a mode Cursor CLI refuses',
  ],
  'runner-api/cursor-runner-gate': [
    'P1 cursor rows on a runner that has not declared Cursor CLI carry the upgrade notice',
    'P1 the claim statement and the database guard are told whether the runner declared Cursor CLI',
  ],
  'runner-api/runner-provider-support': [
    'the gated runtimes are exactly the runtimes a legacy runner would start as Claude',
  ],
  'runners/cursor-install-relay': [
    'Install relay: a runner that does not know Cursor CLI is refused the start with the upgrade notice, and nothing is written',
    'Install relay: the heartbeat of a process that does not know Cursor CLI settles a pending Cursor CLI install as failed and hands it nothing',
  ],
  'sessions/dsh-install-preflight': [
    'dsh install gate: creating a Harness session on a declaring runner that cannot start it is refused with why',
    'dsh install gate: a runner that does not declare dsh still gets the upgrade notice first',
  ],
};

// The web, in one Vitest run: every test of these files passes, and the named ones among them.
export const webCases = {
  files: [
    'src/components/RunNeverStartedCard.test.tsx',
    'src/components/WorkspaceView.neverStarted.test.tsx',
    'src/copyLanguage.test.ts',
  ],
  names: [
    // The card, for a queued follow-up of a conversation that has talked (§8.1).
    'explains a queued message on a conversation that has talked, whatever an earlier run’s engine said',
    'names a Cursor CLI that is not installed on a runner that knows it, and says the queued run starts once it is',
    'reads the same causes on every engine’s queued follow-up',
    // …on the session page itself: below the last turn, in place of the queued note, Install included.
    'explains a queued message on a Cursor CLI conversation that has talked, below its last turn',
    'names a Cursor CLI that is not installed on the runner, and installs it from the card',
    // What stays as it was: no card for a plain wait or a running turn.
    'says nothing about a queued message that is merely waiting for a slot',
    'leaves a turn that is running, or a run whose engine spoke, to the cards that cover it',
    'keeps the ordinary queued note, and no card, for a follow-up merely waiting for a slot',
    'draws no card under a turn that is running',
    'says nothing at all about a session that is merely waiting to be claimed',
    'leaves a run whose engine spoke to the cards that already cover it',
    'names an engine that is not installed, with Install',
    'waits for a newer runner instead of promising a start that is seconds away',
    'draws nothing of the sort for a run whose engine spoke',
    // Product copy in English.
    'holds Chinese only in the files ALLOWED lists, at exactly their counts',
  ],
};

/**
 * The reused guards, held to this script's names before they are trusted: a complete report passes, and a
 * missing, failed, skipped, todo, renamed or repeated scenario, an empty report, one that did not succeed,
 * output without its summary, no output, and a test process that does not start or exits non-zero are
 * each refused.
 */
export function checkGuards(scratch) {
  const refused = (label, check) => assert.throws(check, undefined, `the guard accepted ${label}`);
  const tap = (rows) => {
    const failed = rows.filter(([, result]) => result === 'not ok').length;
    return `TAP version 13\n${rows.map(([title, result = 'ok'], i) => `${result} ${i + 1} - ${title}\n`).join('')}` +
      `1..${rows.length}\n# tests ${rows.length}\n# pass ${rows.length - failed}\n# fail ${failed}\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  };
  for (const [guard, names, others] of [
    [assertTapResults, Object.values(apiCases).flat(), []],
    [assertNamedTap, Object.values(apiRegressions).flat(), ['another test of the file']],
  ]) {
    const [first, ...rest] = names;
    const rows = (list) => [...list, ...others].map((title) => [title]);
    guard(tap(rows(names)), names);
    for (const name of names) {
      const others2 = names.filter((other) => other !== name);
      refused(`a missing ${name}`, () => guard(tap(rows(others2)), names));
      refused(`a skipped ${name}`, () => guard(tap(rows([...others2, `${name} # SKIP`])), names));
      refused(`a todo ${name}`, () => guard(tap(rows([...others2, `${name} # TODO`])), names));
    }
    refused('a failed scenario', () => guard(tap([[first, 'not ok'], ...rows(rest)]), names));
    refused('a renamed scenario', () => guard(tap(rows([`${first} (renamed)`, ...rest])), names));
    refused('a repeated scenario', () => guard(tap(rows([first, ...names])), names));
    refused('output without its summary', () => guard(tap(rows(names)).replace(/^# pass \d+\n/m, ''), names));
    refused('a skipped count', () => guard(tap(rows(names)).replace('# skipped 0', '# skipped 1'), names));
    refused('a todo count', () => guard(tap(rows(names)).replace('# todo 0', '# todo 1'), names));
    refused('no output', () => guard('', names));
  }
  // The whole-file guard also refuses a file that ran a test this script does not name.
  refused('an unnamed extra test', () => assertTapResults(tap([...apiCases['runner-api/cursor-rollback-messages'], 'unnamed'].map((t) => [t])),
    apiCases['runner-api/cursor-rollback-messages']));

  const vitest = (cases) => ({
    success: cases.every((entry) => entry.status === 'passed'),
    numTotalTests: cases.length,
    numPassedTests: cases.filter((entry) => entry.status === 'passed').length,
    numFailedTests: cases.filter((entry) => entry.status === 'failed').length,
    numPendingTests: cases.filter((entry) => entry.status === 'skipped' || entry.status === 'pending').length,
    numTodoTests: cases.filter((entry) => entry.status === 'todo').length,
    testResults: [{ assertionResults: cases }],
  });
  const passing = (names) => names.map((title) => ({ title, status: 'passed' }));
  const names = webCases.names;
  assertVitestNamed(vitest(passing(names)), names);
  for (const name of names) {
    const rest = names.filter((other) => other !== name);
    refused(`a missing ${name}`, () => assertVitestNamed(vitest(passing(rest)), names));
    for (const status of ['failed', 'skipped', 'pending', 'todo']) {
      refused(`a ${status} ${name}`, () => assertVitestNamed(vitest([{ title: name, status }, ...passing(rest)]), names));
    }
  }
  refused('a renamed scenario', () => assertVitestNamed(vitest(passing([`${names[0]} (renamed)`, ...names.slice(1)])), names));
  refused('a repeated scenario', () => assertVitestNamed(vitest(passing([names[0], ...names])), names));
  refused('an empty report', () => assertVitestNamed(vitest([]), names));
  refused('a report that did not succeed', () => assertVitestNamed({ ...vitest(passing(names)), success: false }, names));
  refused('another test of the files failing', () => assertVitestNamed(vitest([...passing(names), { title: 'another', status: 'failed' }]), names));

  const log = path.join(scratch, 'guard.log');
  assert.throws(() => runLogged(path.join(scratch, 'no-such-executable'), [], log), /startup or execution failed/);
  assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(3)'], log), /exit 3/);

  // Each file named once, each scenario once, and every file where the script looks for it.
  for (const table of [apiCases, apiRegressions]) {
    for (const [file, list] of Object.entries(table)) {
      assert.ok(list.length > 0, `${file} names no scenario`);
      assert.equal(new Set(list).size, list.length, `${file} names a scenario twice`);
      assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing src/apiserver/src/${file}.spec.ts`);
    }
  }
  assert.equal(new Set(names).size, names.length, 'the web names a scenario twice');
  for (const file of webCases.files) assert.ok(existsSync(path.join(root, 'src/web', file)), `missing src/web/${file}`);
}

/** The web scenarios feed the card the server's own sentences, word for word. */
function checkServerWords() {
  const support = path.join(root, 'src/apiserver/build/runner-api/runner-provider-support.js');
  assert.ok(existsSync(support), `missing compiled ${support}`);
  const { CURSOR_NOT_INSTALLED_ERROR, CURSOR_RUNNER_UPGRADE_ERROR } = require(support);
  assert.equal(typeof CURSOR_NOT_INSTALLED_ERROR, 'string', 'the API server has no Cursor CLI install notice');
  assert.doesNotMatch(CURSOR_NOT_INSTALLED_ERROR, /requires a newer Orbit runner|update this runner first/, 'the install notice still asks for an update');
  assert.match(CURSOR_NOT_INSTALLED_ERROR, /install/i, 'the install notice does not say to install');
  for (const file of webCases.files.slice(0, 2)) {
    const source = readFileSync(path.join(root, 'src/web', file), 'utf8');
    for (const sentence of [CURSOR_NOT_INSTALLED_ERROR, CURSOR_RUNNER_UPGRADE_ERROR]) {
      assert.ok(source.includes(sentence), `src/web/${file} does not feed the card the server's own sentence: ${sentence}`);
    }
  }
}

function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-rollback-messages-'));
  let total = 0;
  try {
    checkGuards(scratch);
    process.stdout.write('PASS the reused TAP and Vitest guards refuse missing, renamed, repeated, failed, skipped, todo and unstarted scenarios.\n');

    const api = path.join(root, 'src/apiserver');
    const tsc = path.join(root, 'node_modules/.bin/tsc');
    const vitest = path.join(root, 'node_modules/.bin/vitest');
    assert.ok(existsSync(tsc) && existsSync(vitest), 'missing root node_modules; run bash scripts/worktree-overlay.sh first');
    // Shared first: the API server and the web read it from its build.
    runLogged('npm', ['run', 'build', '-w', '@orbit/shared'], path.join(scratch, 'shared-build.log'), { cwd: root, timeout: 10 * 60_000 });
    rmSync(path.join(api, 'build'), { recursive: true, force: true });
    runLogged(tsc, ['-p', 'tsconfig.test.json'], path.join(scratch, 'api-tsc.log'), { cwd: api, timeout: 15 * 60_000 });
    for (const [cases, guard] of [[apiCases, assertTapResults], [apiRegressions, assertNamedTap]]) {
      for (const [file, names] of Object.entries(cases)) {
        const spec = path.join(api, `build/${file}.spec.js`);
        assert.ok(existsSync(spec), `missing compiled test: ${spec}`);
        // In-process, so the named cases are visible (Node 26 process isolation can report a file wrapper).
        const output = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', spec],
          path.join(scratch, `${path.basename(file)}.tap`), { cwd: api });
        process.stdout.write(output);
        guard(output, names);
        for (const name of names) process.stdout.write(`PASS ${name}\n`);
        total += names.length;
      }
    }
    checkServerWords();
    process.stdout.write('PASS the web scenarios feed the card the API server\'s own Cursor CLI sentences, and the install notice asks for no update.\n');

    const report = path.join(scratch, 'web.json');
    runLogged(vitest, ['run', ...webCases.files, '--reporter=json', `--outputFile=${report}`], path.join(scratch, 'web-vitest.log'),
      { cwd: path.join(root, 'src/web'), timeout: 20 * 60_000 });
    assert.ok(existsSync(report), 'Vitest wrote no web report');
    const web = JSON.parse(readFileSync(report, 'utf8'));
    assertVitestNamed(web, webCases.names);
    // Every file ran: a file that failed to load reports no case of its own.
    const ran = new Set(web.testResults.map((suite) => path.relative(path.join(root, 'src/web'), suite.name)));
    for (const file of webCases.files) assert.ok(ran.has(file), `the web run has no result for ${file}`);
    for (const name of webCases.names) process.stdout.write(`PASS ${name}\n`);
    process.stdout.write(`PASS every one of the ${web.numTotalTests} web tests in ${webCases.files.length} files.\n`);
    total += webCases.names.length;
    process.stdout.write(`Cursor rollback messages acceptance passed: ${total} named scenarios, none missing, unmatched, skipped or failing.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAcceptance();

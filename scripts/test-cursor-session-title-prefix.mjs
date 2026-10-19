// Acceptance for D-P8-2 (Cursor CLI native, 34gyHIZv301nDWxKP9XkO): a Cursor CLI session opened without a title
// keeps the title cut from the person's first message, not the name Cursor CLI gives a conversation whose first
// prompt leads with Orbit's agent instructions ("Orbit Agent Instructions" in P8). Cursor CLI names a
// conversation from the first prompt it is sent (docs/cursor-runtime-contract.md §3.2). The runner reports no
// title for a conversation it opened with those instructions, whatever its words, and reports a loaded
// conversation's title as before (src/runner-go/cursor_acp.go). Run from the repository root:
//
//   node scripts/test-cursor-session-title-prefix.mjs
//
// Every scenario below is named, and each is required to run and pass exactly once: a scenario missing,
// renamed, unmatched, skipped, marked todo, failing, or a test process that did not start, is a non-zero
// exit. The guards are scripts/test-dsh-routing.mjs's (TAP), scripts/test-dsh-provider-gate.mjs's runLogged
// and scripts/test-dsh-runtime-environment.mjs's (Go), reused as they are and checked here against this
// script's own names before they are trusted. The PostgreSQL scenarios run through scripts/run-pg-spec.sh on a
// throwaway server, which also compiles the API server's test tree the application scenarios then run from.
// The Go scenarios run with every real engine CLI, Cursor's own commands and the download tools replaced on
// PATH by stubs that fail, and the runner user's real ~/.cursor family is fingerprinted before and after.
// The contract's §14.4 is read last for the commit trailer P8 recorded.
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';
import { runLogged } from './test-dsh-provider-gate.mjs';
import {
  assertGoResults,
  goTestPattern,
  harnessDirectoryFingerprint,
  runLogged as runGoLogged,
  runnerEnvironment,
} from './test-dsh-runtime-environment.mjs';
import { userCursorPaths } from './test-cursor-runner-install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// Exact mandatory scenario names, independent of what the test runners happen to discover. The task's three
// scenarios, and where each is shown:
//   1. a Cursor CLI session opened without a title, whose first turn leads with Orbit's instructions, ends up
//      titled from the person's first message: the server's title cut from P8's message and the claim that
//      asks against it; the runner's first prompt carrying the instructions; and the runner reporting none of
//      the names Cursor CLI gave such conversations in P5c's and P0's recordings — "Orbit Agent Instructions",
//      "Agent Instructions" and titles that read like summaries, in the turn or after it, in a new conversation
//      or one reopened in place of an unspoken one — so the session keeps the title it was created with;
//   2. a task's title, a person's rename and DeepSeek's title are not replaced, by the P5a follow-up's rules:
//      the rule, the real claim and report on PostgreSQL, the report's compare-and-set, and the runner
//      reporting nothing when its claim did not ask;
//   3. a session resumed with session/load, whose prompts carry no instructions, is unchanged: its prompts are
//      the person's alone, its replay names nothing, and a title Cursor CLI gives it is reported when asked.
export const pgCases = {
  'sessions/cursor-session-naming': [
    'P5a a Cursor CLI session nothing else names is claimed with naming, and the title its runner reports lands',
    "P5a a Cursor CLI session that runs a task keeps the task's title",
    "P5a a person's rename stands over Cursor CLI's title, made before the claim or after it",
    "P5a DeepSeek's title stands: a Cursor CLI session the server names is claimed without naming",
    'P5a Claude Code and Codex sessions are claimed with naming as before, and their titles land',
    'P5a Cursor CLI session titles on PostgreSQL',
  ],
};

export const apiCases = {
  // P8's untitled session: the title cut from its message, and the claim that asks for a name against it.
  'sessions/cursor-session-title-prefix': [
    'D-P8-2 an untitled Cursor CLI session carries the title cut from its first message, and its claim asks for a name against it',
  ],
  // The rule the claim asks by, engine by engine.
  'sessions/cursor-session-naming': [
    'P5a Cursor CLI is asked to name a session nothing else names, as Claude Code and Codex are, and no other engine is',
    'P5a a title a task, a project, a person or DeepSeek gave is not handed to Cursor CLI, Claude Code or Codex to replace',
  ],
  // The report's compare-and-set: the title the claim carried, or nothing.
  'runner-api/session-naming': [
    'the title lands while the session still carries the one its claim did',
    'a rename made since, or a project that owns the title, stands',
    "an engine's title is kept to one clean line, and no title is no write",
    "another runner's session is refused before anything is written",
  ],
};

export const goCases = {
  // The runner withholds the title of a conversation it opened with Orbit's instructions, and reports a loaded
  // conversation's when asked.
  'cursor_session_title_test.go': [
    'TestCursorSessionTitlePrefix',
    'TestCursorSessionTitlePrefix/orbit-agent-instructions',
    'TestCursorSessionTitlePrefix/agent-instructions',
    'TestCursorSessionTitlePrefix/any-wording',
    'TestCursorSessionTitlePrefix/late-title',
    'TestCursorSessionTitlePrefix/reopened-conversation',
    'TestCursorSessionTitlePrefix/loaded-conversation',
    'TestCursorSessionTitlePrefix/loaded-conversation-not-asked',
  ],
  // The instructions go ahead of a new conversation's first prompt, and nowhere in a loaded one's (P5c).
  'cursor_permissions_test.go': [
    'TestCursorAgentInstructions',
    'TestCursorAgentInstructions/first-prompt',
    'TestCursorAgentInstructions/loaded-conversation',
  ],
  // The runner reports Cursor CLI's title against the claimed one when the claim asks, and nothing otherwise.
  'cursor_acp_test.go': [
    'TestCursorACPEventMapping',
    'TestCursorACPEventMapping/title',
    'TestCursorACPEventMapping/title-not-asked-for',
  ],
  // A load replays the conversation without naming it or writing any of it again.
  'cursor_acp_lifecycle_test.go': [
    'TestCursorACPResume',
    'TestCursorACPResume/load-replays-nothing',
  ],
};

/** The recordings the Go scenarios replay: Cursor CLI's real answers, P5c's through Orbit's own runner. */
const recordings = [
  'p5c/mcp-orbit/session', 'p5c/accept-edits-stop/session', 'multi-turn-tools-default/turns',
  'background-shell-and-commit/background', 'subagent-and-todos/subagent', 'crash-continue-and-shell-wrapper/continue',
];

/** What §14.4 has to say about P8's commits, word for word. */
export const contractFacts = [
  'Co-authored-by: Cursor <cursoragent@cursor.com>',
  'git commit --trailer',
  '`5c4e79a`',
  '`030410d`',
  '`grok-4.7-high`',
  '因模型而异',
  '【实测 `p0c/background-shell-and-commit`】没有 trailer',
  '【实测 P8（`34h05gNODW63XwtyJ4Lno`），2026-10-19】有 trailer',
  '沿用默认（作业指导 D2，不变）',
  '界面和文档仍不承诺提交里会出现 Cursor 的署名',
];

/** The text of one `### ` section of a Markdown file, up to the next heading of its level or above. */
export function markdownSection(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${heading} `) || line === heading);
  assert.ok(start >= 0, `missing section: ${heading}`);
  assert.equal(lines.filter((line) => line.startsWith(`${heading} `) || line === heading).length, 1, `section ${heading} appears twice`);
  const end = lines.findIndex((line, index) => index > start && /^#{1,3} /.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** §14.4 states P8's trailer and that whether there is one depends on the model. */
export function assertContract(text) {
  const section = markdownSection(text, '### 14.4');
  assert.match(section, /^### 14\.4 提交署名（D2）/, 'section 14.4 is not the commit attribution section');
  for (const fact of contractFacts) assert.ok(section.includes(fact), `§14.4 does not say ${JSON.stringify(fact)}`);
}

/** The TAP log run-pg-spec.sh keeps for the n-th spec it is given (0-based index). */
export function pgLogName(index, file) {
  return `${index + 1}-${path.basename(file)}.pg.spec.tap`;
}

function tap(names) {
  return `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n`
    + `# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

function goEvents(names) {
  return [{ Action: 'start', Package: 'orbit' },
    ...names.flatMap((Test) => [{ Action: 'run', Package: 'orbit', Test }, { Action: 'pass', Package: 'orbit', Test }]),
    { Action: 'pass', Package: 'orbit' }];
}

const json = (events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

/**
 * The reused guards, held to this script's names before they are trusted: a complete run passes, and a
 * missing, unmatched, skipped, todo, failed or repeated scenario, an absent or inconsistent summary, a file
 * wrapper that passed, a test process that cannot start and one that exits non-zero are each refused; so is a
 * contract that leaves out any of §14.4's facts.
 */
export function checkGuards(scratch) {
  const refused = (label, run) => assert.throws(run, undefined, `the guard accepted ${label}`);
  for (const names of [...Object.values(pgCases), ...Object.values(apiCases)]) {
    assertTapResults(tap(names), names);
    for (const name of names) {
      refused(`a missing ${name}`, () => assertTapResults(tap(names.filter((other) => other !== name)), names));
      refused(`an unmatched ${name}`, () => assertTapResults(tap(names).replace(`- ${name}\n`, '- unmatched\n'), names));
      refused(`a skipped ${name}`, () => assertTapResults(tap(names).replace(`- ${name}\n`, `- ${name} # SKIP\n`), names));
      refused(`a todo ${name}`, () => assertTapResults(tap(names).replace(`- ${name}\n`, `- ${name} # TODO\n`), names));
    }
  }
  const one = tap(['required']);
  for (const [label, invalid] of [
    ['no output', ''],
    ['a failed scenario', one.replace('ok 1', 'not ok 1')],
    ['a file wrapper that passed', one.replace('required', 'src/apiserver/build/sessions/cursor-session-title-prefix.spec.js')],
    ['a missing summary', one.replace('# pass 1\n', '')],
    ['a duplicate summary', `${one}# pass 1\n`],
    ['an inconsistent count', one.replace('# tests 1', '# tests 2')],
    ['a skipped count', one.replace('# skipped 0', '# skipped 1')],
    ['a todo count', one.replace('# todo 0', '# todo 1')],
    ['a cancelled count', one.replace('# cancelled 0', '# cancelled 1')],
  ]) refused(label, () => assertTapResults(invalid, ['required']));
  refused('no declared scenario', () => assertTapResults(one, []));

  const goNames = Object.values(goCases).flat();
  const events = goEvents(goNames);
  assertGoResults(json(events), goNames);
  for (const name of goNames) {
    refused(`a missing ${name}`, () => assertGoResults(json(events.filter((event) => event.Test !== name)), goNames));
    refused(`a skipped ${name}`, () => assertGoResults(json(events.map((event) => (event.Test === name && event.Action === 'pass' ? { ...event, Action: 'skip' } : event))), goNames));
    refused(`a failed ${name}`, () => assertGoResults(json(events.map((event) => (event.Test === name && event.Action === 'pass' ? { ...event, Action: 'fail' } : event))), goNames));
    refused(`an unfinished ${name}`, () => assertGoResults(json(events.filter((event) => !(event.Test === name && event.Action === 'pass'))), goNames));
  }
  refused('a repeated Go scenario', () => assertGoResults(json([...events.slice(0, -1), ...goEvents([goNames[0]]).slice(1, -1), events.at(-1)]), goNames));
  refused('an unmatched Go test', () => assertGoResults(json([...events.slice(0, -1), { Action: 'run', Package: 'orbit', Test: 'TestNotNamedHere' },
    { Action: 'pass', Package: 'orbit', Test: 'TestNotNamedHere' }, events.at(-1)]), goNames));
  refused('a Go package that only says pass', () => assertGoResults(json([{ Action: 'start', Package: 'orbit' }, { Action: 'pass', Package: 'orbit' }]), goNames));
  refused('no Go output', () => assertGoResults('', goNames));
  const selector = new RegExp(goTestPattern(goNames));
  assert.ok(goNames.every((name) => selector.test(name.split('/')[0])), 'the -run pattern misses a named scenario');
  assert.ok(!selector.test(`${goNames[0]}Extra`) && !selector.test('TestCursor'), 'the -run pattern matches more than the named scenarios');

  const log = path.join(scratch, 'guard.log');
  for (const run of [runLogged, runGoLogged]) {
    assert.throws(() => run(path.join(scratch, 'no-such-executable'), [], log), /startup or execution failed/);
    assert.throws(() => run(process.execPath, ['-e', 'process.exit(3)'], log), /exit 3/);
  }

  // The contract check refuses a §14.4 without any one of its facts, a missing section and a second one.
  const contract = readFileSync(path.join(root, 'docs/cursor-runtime-contract.md'), 'utf8');
  assertContract(contract);
  for (const fact of contractFacts) refused(`a §14.4 without ${fact}`, () => assertContract(contract.split(fact).join('')));
  refused('a contract without §14.4', () => assertContract(contract.replace('### 14.4 ', '### 14.9 ')));
  refused('a contract with two §14.4', () => assertContract(`${contract}\n### 14.4 提交署名（D2）\n`));

  // Each file named once, each scenario once, and every file where the script looks for it.
  for (const table of [pgCases, apiCases, goCases]) {
    for (const [file, names] of Object.entries(table)) {
      assert.ok(names.length > 0, `${file} names no scenario`);
      assert.equal(new Set(names).size, names.length, `${file} names a scenario twice`);
    }
  }
  for (const file of Object.keys(pgCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.pg.spec.ts`)), `missing ${file}.pg.spec.ts`);
  for (const file of Object.keys(apiCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing ${file}.spec.ts`);
  for (const file of Object.keys(goCases)) assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing src/runner-go/${file}`);
  for (const recording of recordings) {
    assert.ok(existsSync(path.join(root, 'src/runner-go/testdata/cursor', recording, 'stdout.jsonl')), `missing the recording ${recording}`);
  }
  assert.equal(pgLogName(0, 'sessions/cursor-session-naming'), '1-cursor-session-naming.pg.spec.tap');
}

async function prismaEngineEnvironment() {
  if (process.env.PRISMA_SCHEMA_ENGINE_BINARY) return {};
  // Reuse an installed or version-matched cached engine on offline worktrees, as
  // scripts/test-dsh-provider-gate.mjs does; otherwise leave Prisma's own discovery alone.
  const platform = await require('@prisma/get-platform').getBinaryTargetForCurrentPlatform();
  const version = require('@prisma/engines-version').enginesVersion;
  const candidates = [
    path.join(path.dirname(require.resolve('@prisma/engines/package.json')), `schema-engine-${platform}`),
    path.join(homedir(), '.cache/prisma/master', version, platform, 'schema-engine'),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return { PRISMA_SCHEMA_ENGINE_BINARY: candidate };
    } catch { /* Prisma can use its normal discovery if this candidate is absent. */ }
  }
  return {};
}

async function runAcceptance() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-session-title-prefix-'));
  const home = process.env.HOME ?? homedir();
  const watched = userCursorPaths(home);
  const before = watched.map((entry) => harnessDirectoryFingerprint(entry));
  const changed = () => watched.filter((entry, i) => harnessDirectoryFingerprint(entry) !== before[i]);
  let total = 0;
  try {
    checkGuards(scratch);
    process.stdout.write('PASS the reused guards refuse missing, unmatched, skipped, todo, failed and unstarted scenarios.\n');

    const pgFiles = Object.keys(pgCases);
    const output = runLogged('bash', ['scripts/run-pg-spec.sh', ...pgFiles.map((file) => `src/apiserver/src/${file}.pg.spec.ts`)],
      path.join(scratch, 'postgres.log'), {
        env: { ...await prismaEngineEnvironment(), RUN_PG_SPEC_LOG_DIR: scratch, RUN_PG_SPEC_TEST_ISOLATION: 'none' },
        timeout: 1_800_000,
      });
    process.stdout.write(output);
    pgFiles.forEach((file, index) => {
      const log = path.join(scratch, pgLogName(index, file));
      assert.ok(existsSync(log), `PostgreSQL runner produced no scenario log for ${file}`);
      assertTapResults(readFileSync(log, 'utf8'), pgCases[file]);
      for (const name of pgCases[file]) process.stdout.write(`PASS ${name}\n`);
      total += pgCases[file].length;
    });

    // From the test tree run-pg-spec.sh just compiled, in the package directory `npm test` runs them from.
    for (const [file, names] of Object.entries(apiCases)) {
      const spec = path.join(root, `src/apiserver/build/${file}.spec.js`);
      assert.ok(existsSync(spec), `missing compiled test file: ${spec}`);
      // In-process, so the named cases are visible (Node 26 process isolation can report a file wrapper).
      const result = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', spec],
        path.join(scratch, 'node.log'), { cwd: path.join(root, 'src/apiserver') });
      process.stdout.write(result);
      assertTapResults(result, names);
      total += names.length;
    }

    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx']) {
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "the session title tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
    }
    // serviceLoginPath appends the engine installers' own directories; keep them behind the stubs.
    const loginHome = userInfo().homedir;
    const toolPath = [blockedBin, path.dirname(process.execPath), '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin',
      path.join(loginHome, '.local/bin'), path.join(loginHome, '.opencode/bin'), path.join(loginHome, '.kimi-code/bin')].join(path.delimiter);
    const goNames = Object.values(goCases).flat();
    const goOutput = runGoLogged('go', ['test', '-json', '-count=1', '-timeout=300s', '-run', goTestPattern(goNames), '.'], path.join(scratch, 'runner.json'), {
      cwd: path.join(root, 'src/runner-go'), env: runnerEnvironment(process.env, scratch, toolPath), timeout: 600_000,
    });
    process.stdout.write(goOutput);
    assertGoResults(goOutput, goNames);
    for (const name of goNames) process.stdout.write(`PASS ${name}\n`);
    total += goNames.length;

    assertContract(readFileSync(path.join(root, 'docs/cursor-runtime-contract.md'), 'utf8'));
    process.stdout.write('PASS docs/cursor-runtime-contract.md §14.4 states the trailer P8 recorded and that it depends on the model.\n');

    assert.deepEqual(changed(), [], 'the runner user\'s Cursor CLI directories changed');
    process.stdout.write(`PASS the runner user's ${watched.map((entry) => `~/${path.relative(home, entry)}`).join(', ')} are unchanged.\n`);
    process.stdout.write(`D-P8-2 acceptance passed: ${total} named scenarios, none missing, unmatched, skipped or failing, and the contract's §14.4.\n`);
  } finally {
    if (changed().length !== 0) {
      process.stderr.write(`The runner user's Cursor CLI directories changed (${changed().join(', ')}); logs kept at ${scratch}\n`);
      process.exitCode = 1;
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();

// Acceptance for the P6b follow-up of project Cursor CLI native (34gyHIZv301nDWxKP9XkO): a Cursor CLI session
// that has talked stays on the identity its conversation was opened on. D5 (owner, 2026-10-17): until two real
// identities show that Cursor continues a conversation under another, only a session that has not talked moves
// to another account or key. P6b refused the doors that move one; a session that follows its workspace — no
// account of its own (session.cursor_account NULL), or the workspace's own CURSOR_API_KEY / CURSOR_AUTH_TOKEN —
// moved with every edit of the workspace. Now the runner keeps the identity in the session's record (meta.json:
// an account's id, or a key's or token's P2 fingerprint, never the key) and refuses, in D5's words, a start that
// would continue the conversation on another, unless it declares cursor-account-move/v1. Run from the
// repository root:
//
//   node scripts/test-cursor-identity-pin.mjs
//
// Every scenario below is named, and each is required to run and pass exactly once: a scenario missing, renamed,
// unmatched, skipped, marked todo, failing, or a test process that did not start, is a non-zero exit. The guards
// are scripts/test-dsh-routing.mjs's (node:test TAP) and scripts/test-dsh-runtime-environment.mjs's (go test
// -json), each shown the reports it has to refuse before anything runs. The PostgreSQL scenarios run through
// scripts/run-pg-spec.sh on a throwaway server, which also compiles the API server's test tree the application
// scenario then runs from. The Go scenarios run with every real engine CLI and downloader replaced on PATH by a
// stub that fails, so no real prompt is sent, each session in a HOME of the test's own.
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';
import { runLogged } from './test-dsh-provider-gate.mjs';
import { assertGoResults, goTestPattern, runLogged as runIsolated, runnerEnvironment } from './test-dsh-runtime-environment.mjs';
import { checkGuards as checkGoGuards } from './test-cursor-runner-install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// Exact mandatory scenario names, independent of what the test runners happen to discover. The task's cases, and
// where each is shown:
//   1. a talked session that follows its workspace's account (session.cursor_account NULL) is refused its next
//      turn, in D5's words, once the workspace picked another account, and is not continued there — PostgreSQL
//      (the claim names the new account and still carries the conversation: nothing on the server stops it) and
//      Go (the runner refuses that start before Cursor CLI is started, and keeps the record as it was);
//   2. the same when the workspace's CURSOR_API_KEY is replaced by another key — PostgreSQL and Go (a token, a
//      key taken away for the runner's sign-in, and a saved key replaced, too; the record holds no key);
//   3. a session that has not talked follows the new settings — PostgreSQL and Go;
//   4. a runner that declares cursor-account-move/v1 lets it go — Go, the identity unchanged continuing too;
//   5. every other engine as before — PostgreSQL (a Kimi Code session's claim) and Go (no other engine's record
//      holds an identity; Kimi Code, Claude Code and Codex still carry a conversation to another account).
// Beside them: the runner refuses in the control plane's own words, CURSOR_CONVERSATION_MOVE_REFUSAL
// (application), it declares no cursor-account-move/v1, and Cursor's own resume rules hold — a conversation it
// cannot find is never replaced by a new one, one never prompted is reopened (Go).
export const pgCases = {
  'sessions/cursor-identity-pin': [
    'P6b follow-up a talked Cursor CLI session that follows its workspace is handed the account the workspace was edited to, with its conversation',
    'P6b follow-up a talked Cursor CLI session is handed the key its workspace’s env was edited to, with its conversation',
    'P6b follow-up a Cursor CLI session that has not talked is handed the workspace’s new account and no conversation',
    'P6b follow-up another engine’s session is handed what its workspace was edited to, as before',
    'P6b follow-up a Cursor CLI session’s claim across a workspace edit, on PostgreSQL',
  ],
};

export const apiCases = {
  'providers/cursor-identity-pin': [
    'P6b follow-up the runner refuses a talked Cursor CLI session’s start on another identity in the control plane’s words',
  ],
};

export const goCases = {
  'cursor_identity_pin_test.go': [
    'TestCursorIdentityPinRefusesAnotherAccount',
    'TestCursorIdentityPinRefusesAnotherAccount/workspace-account-to-another-account',
    'TestCursorIdentityPinRefusesAnotherAccount/default-to-an-added-account',
    'TestCursorIdentityPinRefusesAnotherAccount/added-account-to-default',
    'TestCursorIdentityPinRefusesAnotherKey',
    'TestCursorIdentityPinRefusesAnotherKey/workspace-key-replaced',
    'TestCursorIdentityPinRefusesAnotherKey/workspace-token-replaced',
    'TestCursorIdentityPinRefusesAnotherKey/workspace-key-to-the-runner-sign-in',
    'TestCursorIdentityPinRefusesAnotherKey/saved-key-replaced',
    'TestCursorIdentityPinRefusesAnotherKey/record-holds-no-key',
    'TestCursorIdentityPinFollowsAnUnspokenSession',
    'TestCursorIdentityPinFollowsAnUnspokenSession/no-conversation-yet',
    'TestCursorIdentityPinFollowsAnUnspokenSession/opened-but-never-prompted',
    'TestCursorIdentityPinContinuesOnTheSameIdentity',
    'TestCursorIdentityPinContinuesOnTheSameIdentity/same-account-signed-in-again',
    'TestCursorIdentityPinContinuesOnTheSameIdentity/same-key',
    'TestCursorIdentityPinContinuesOnTheSameIdentity/default',
    'TestCursorIdentityPinMovesOnARunnerThatCarriesIt',
    'TestCursorIdentityPinMovesOnARunnerThatCarriesIt/another-account',
    'TestCursorIdentityPinMovesOnARunnerThatCarriesIt/another-key',
    'TestCursorIdentityPinLeavesOtherEnginesAlone',
    'TestCursorIdentityPinLeavesOtherEnginesAlone/claude',
    'TestCursorIdentityPinLeavesOtherEnginesAlone/codex',
    'TestCursorIdentityPinLeavesOtherEnginesAlone/kimi',
    'TestCursorIdentityPinLeavesOtherEnginesAlone/antigravity',
    'TestCursorIdentityPinLeavesOtherEnginesAlone/opencode',
    'TestCursorIdentityPinLeavesOtherEnginesAlone/dsh',
  ],
  'cursor_account_slot_test.go': ['TestCursorRunnerDoesNotDeclareAccountMove'],
  'cursor_acp_lifecycle_test.go': ['TestCursorACPResume'],
  'kimi_account_move_test.go': ['TestKimiSessionRecordMovesWithTheConversation', 'TestKimiConversationFollowsASessionToAnotherAccount'],
  'claude_account_move_test.go': ['TestClaudeConversationFollowsASessionToAnotherAccount'],
  'codex_account_dispatch_test.go': ['TestCodexAccountDispatchMovesASessionToTheSignedInAccountItsClaimNames'],
};

/** The TAP log run-pg-spec.sh keeps for the n-th spec it is given (0-based index). */
export function pgLogName(index, file) {
  return `${index + 1}-${path.basename(file)}.pg.spec.tap`;
}

/**
 * The guards are only worth their green if they go red: before anything runs, each is shown reports it has to
 * refuse — a scenario missing, unmatched, skipped, todo or failing, a summary absent, doubled or wrong, a Go
 * scenario skipped, failed, repeated or never finished, a test process that never started or exited non-zero —
 * and the tables are checked to name every file once, every scenario once, and only files that exist.
 */
export function checkGuard(scratch) {
  const tap = (names) =>
    `TAP version 13\n${names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('')}1..${names.length}\n` +
    `# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;

  for (const names of [...Object.values(pgCases), ...Object.values(apiCases)]) {
    const output = tap(names);
    assertTapResults(output, names);
    for (const name of names) {
      assert.throws(() => assertTapResults(tap(names.filter((other) => other !== name)), names), undefined, `missing: ${name}`);
      assert.throws(() => assertTapResults(output.replace(name, 'unmatched'), names), undefined, `unmatched: ${name}`);
      assert.throws(() => assertTapResults(output.replace(name, `${name} # SKIP`), names), undefined, `skipped: ${name}`);
      assert.throws(() => assertTapResults(output.replace(name, `${name} # TODO`), names), undefined, `todo: ${name}`);
    }
  }
  process.stdout.write('PASS guard: every PostgreSQL and application scenario is required, and none may be unmatched, skipped or todo\n');

  const one = tap(['required']);
  for (const invalid of [
    '',
    one.replace('ok 1', 'not ok 1'),
    // A file wrapper that passed is not its scenarios.
    one.replace('required', 'src/apiserver/build/sessions/cursor-identity-pin.pg.spec.js'),
    one.replace('# pass 1\n', ''),
    `${one}# pass 1\n`,
    one.replace('# tests 1', '# tests 0'),
    one.replace('# pass 1', '# pass 2'),
    one.replace('# skipped 0', '# skipped 1'),
    one.replace('# todo 0', '# todo 1'),
    one.replace('# cancelled 0', '# cancelled 1'),
  ]) assert.throws(() => assertTapResults(invalid, ['required']));
  assert.throws(() => assertTapResults(one, []));
  process.stdout.write('PASS guard: failed scenarios and absent, duplicate or inconsistent summaries are refused\n');

  checkGoGuards(Object.values(goCases).flat(), scratch);
  process.stdout.write('PASS guard: a Go scenario missing, skipped, failed, repeated, unfinished or unmatched is refused\n');

  const log = path.join(scratch, 'guard.log');
  assert.throws(() => runLogged(path.join(scratch, 'missing-executable'), [], log), /startup or execution failed/);
  assert.throws(() => runLogged(process.execPath, ['-e', 'process.exit(17)'], log), /exit 17/);
  assert.equal(runLogged(process.execPath, ['-e', 'process.stdout.write("started")'], log), 'started');
  process.stdout.write('PASS guard: missing executables and startup failures are refused\n');

  for (const table of [pgCases, apiCases, goCases]) {
    for (const [file, names] of Object.entries(table)) {
      assert.ok(names.length > 0, `${file} names no scenario`);
      assert.equal(new Set(names).size, names.length, `${file} names a scenario twice`);
    }
  }
  const goNames = Object.values(goCases).flat();
  assert.equal(new Set(goNames).size, goNames.length, 'a Go scenario is named under two files');
  for (const file of Object.keys(pgCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.pg.spec.ts`)), `missing required test file: ${file}.pg.spec.ts`);
  for (const file of Object.keys(apiCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing required test file: ${file}.spec.ts`);
  for (const file of Object.keys(goCases)) assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: ${file}`);
  // run-pg-spec.sh keeps the n-th spec's TAP as `<n>-<file name>.tap`.
  assert.equal(pgLogName(0, 'sessions/cursor-identity-pin'), '1-cursor-identity-pin.pg.spec.tap');
  process.stdout.write('PASS guard: the scenario tables name each file once, each scenario once, and only files that exist\n');
}

async function prismaEngineEnvironment() {
  if (process.env.PRISMA_SCHEMA_ENGINE_BINARY) return {};
  // Reuse an installed or version-matched cached engine on offline worktrees, as
  // scripts/test-cursor-accounts-server.mjs does; otherwise leave Prisma's own discovery alone.
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-identity-pin-'));
  let total = 0;
  try {
    checkGuard(scratch);

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
      const tap = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', spec],
        path.join(scratch, 'node.log'), { cwd: path.join(root, 'src/apiserver'), timeout: 600_000 });
      process.stdout.write(tap);
      assertTapResults(tap, names);
      for (const name of names) process.stdout.write(`PASS ${name}\n`);
      total += names.length;
    }

    // The runner, with every real engine CLI and downloader replaced on PATH by a stub that fails.
    const names = Object.values(goCases).flat();
    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx']) {
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "P6b follow-up tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
    }
    const toolPath = [blockedBin, path.dirname(process.execPath), '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);
    const goOutput = runIsolated('go', ['test', '-json', '-count=1', '-timeout=600s', '-run', goTestPattern(names), '.'], path.join(scratch, 'runner.json'), {
      cwd: path.join(root, 'src/runner-go'), env: runnerEnvironment(process.env, scratch, toolPath), timeout: 1_200_000,
    });
    process.stdout.write(goOutput);
    assertGoResults(goOutput, names);
    for (const name of names) process.stdout.write(`PASS ${name}\n`);
    total += names.length;

    process.stdout.write(`P6b follow-up acceptance passed: ${total} named scenarios, none missing, unmatched, skipped or failing.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();

// Acceptance for project P6b (Cursor CLI native, 34gyHIZv301nDWxKP9XkO): moving a Cursor CLI session to another
// account or API key. P0 could not show that Cursor continues a conversation under another identity
// (docs/cursor-runtime-contract.md §13.2), and the owner decided D5 on 2026-10-17: until two real identities show
// it does, only a session that has not talked moves. So this is the branch where the control plane refuses — a
// session that has talked is refused another account, the runner's sign-in, a Cursor key or another key, in words
// that say why, unless its runner declares cursor-account-move/v1, which no runner does yet; one that has not
// talked moves on any runner. Run from the repository root:
//
//   node scripts/test-cursor-account-move.mjs
//
// Every scenario below is named, and each is required to run and pass exactly once: a scenario missing, renamed,
// unmatched, skipped, marked todo, failing, or a test process that did not start, is a non-zero exit. The guards
// are scripts/test-dsh-routing.mjs's (node:test TAP) and scripts/test-dsh-runtime-environment.mjs's (go test
// -json), each shown reports it has to refuse before anything runs. The PostgreSQL scenarios run through
// scripts/run-pg-spec.sh on a throwaway server, which also compiles the API server's test tree the application
// scenarios then run from.
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

// Exact mandatory scenario names, independent of what the test runners happen to discover. The task's named
// scenarios for this branch, and where each is shown:
//   1. the refusal and its words — PostgreSQL (another account; a key, the runner's sign-in and another key, live or
//      revived; nothing written), and what "talked" is and the refusal itself (application);
//   2. a session that has not talked moves to another account or key — PostgreSQL (waiting, live and ended);
//   3. an older runner is refused — PostgreSQL (every runner in the field refused, only one that declares
//      cursor-account-move/v1 handed the move, every other engine on its own rule), and no runner of this version
//      declares it (Go).
// Beside them, a move to another workspace keeps a Cursor CLI session on the account it runs on (application).
export const pgCases = {
  'sessions/cursor-account-move': [
    'P6b a talked Cursor CLI session is refused another account, and told why',
    'P6b a talked Cursor CLI session is refused a key, the runner’s sign-in and another key, live or revived',
    'P6b a Cursor CLI session that has not talked moves to another account or key',
    'P6b an older runner is refused the move of a talked Cursor CLI session; only one that declares cursor-account-move/v1 is handed it',
    'P6b Cursor CLI account and key moves on PostgreSQL',
  ],
};

export const apiCases = {
  'providers/cursor-account-move': [
    'P6b a Cursor CLI session has talked once a turn settled, once Cursor opened its conversation, or while a turn runs',
    'P6b a talked Cursor CLI session moves only on a runner that declares cursor-account-move/v1, and is told why anywhere else',
  ],
  // Every case of the file runs: a workspace move's account columns, beside the merge target it always had.
  'sessions/session-move': [
    'project code tasks default their merge target to the integration branch',
    'an explicit session merge target still overrides the project line',
    'sessions without a project line retain workspace and runner fallbacks',
    'P6b a workspace move keeps a Cursor CLI session on the account it runs on, and clears it on another runner',
  ],
};

export const goCases = {
  'cursor_account_slot_test.go': ['TestCursorRunnerDoesNotDeclareAccountMove'],
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
    one.replace('required', 'src/apiserver/build/sessions/cursor-account-move.pg.spec.js'),
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
  for (const file of Object.keys(pgCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.pg.spec.ts`)), `missing required test file: ${file}.pg.spec.ts`);
  for (const file of Object.keys(apiCases)) assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing required test file: ${file}.spec.ts`);
  for (const file of Object.keys(goCases)) assert.ok(existsSync(path.join(root, 'src/runner-go', file)), `missing required Go test source: ${file}`);
  // run-pg-spec.sh keeps the n-th spec's TAP as `<n>-<file name>.tap`.
  assert.equal(pgLogName(0, 'sessions/cursor-account-move'), '1-cursor-account-move.pg.spec.tap');
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-account-move-'));
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

    // The runner's own declaration, with every real engine CLI and downloader replaced on PATH by a stub that fails.
    const names = Object.values(goCases).flat();
    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx']) {
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "P6b tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
    }
    const toolPath = [blockedBin, path.dirname(process.execPath), '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);
    const goOutput = runIsolated('go', ['test', '-json', '-count=1', '-timeout=300s', '-run', goTestPattern(names), '.'], path.join(scratch, 'runner.json'), {
      cwd: path.join(root, 'src/runner-go'), env: runnerEnvironment(process.env, scratch, toolPath), timeout: 900_000,
    });
    process.stdout.write(goOutput);
    assertGoResults(goOutput, names);
    for (const name of names) process.stdout.write(`PASS ${name}\n`);
    total += names.length;

    process.stdout.write(`P6b acceptance passed: ${total} named scenarios, none missing, unmatched, skipped or failing.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();

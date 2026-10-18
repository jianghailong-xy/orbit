// Acceptance for the Install follow-up of project Cursor CLI native (34gyHIZv301nDWxKP9XkO): Cursor CLI's
// Install and Reinstall from Orbit. POST /runners/:id/install takes {engine: cursor} — the same request for
// both — and relays it on the heartbeat only to a runner that knows Cursor CLI (it declares provider:cursor
// or reports the engine); the runner downloads the pinned build 2026.10.14-941492e, checks it against its
// pinned size and SHA-256, publishes it, and reports the outcome once its engine report already says what
// the install left, sending the heartbeat that carries it at once. A Reinstall over another build in the
// pinned build's directory replaces it. A runner that does not know Cursor CLI is refused with the notice
// to update it, at the start and again at the heartbeat, and is never handed the request. Every other
// engine's install is what it was. Run from the repository root:
//
//   node scripts/test-cursor-install-relay.mjs
//
// Every scenario below is named, and each is required to run and pass exactly once: a scenario missing,
// renamed, unmatched, skipped, marked todo, failing, or a test process that did not start, is a non-zero
// exit. The guards are scripts/test-dsh-routing.mjs's (TAP), scripts/test-dsh-provider-gate.mjs's runLogged
// and scripts/test-dsh-runtime-environment.mjs's (Go), reused as they are and checked here against this
// script's own names before they are trusted. The PostgreSQL scenarios run through scripts/run-pg-spec.sh
// on a throwaway server, which also compiles the API server's test tree the application scenarios then run
// from. The Go scenarios download from a local stand-in for the release, never the network, with every
// real engine CLI, Cursor's own commands and the download tools replaced on PATH by stubs that fail; the
// runner user's real ~/.cursor family is fingerprinted before and after, and any change fails the run.
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

// Exact mandatory scenario names, independent of what the test runners happen to discover.
export const pgCases = {
  'runners/cursor-install-relay': [
    // Accepted, relayed to a runner that knows Cursor CLI, settled by the runner's reports and retired by
    // the heartbeat that reports the pinned build.
    'Cursor install relay: POST /runners/:id/install takes cursor and relays it to a runner that knows Cursor CLI, which reports the pinned build installed',
    // A runner that does not know it: refused with the notice to update it, never handed the install.
    'Cursor install relay: a runner that does not know Cursor CLI is refused with the upgrade notice and never handed the install',
    'Cursor install relay: a heartbeat from a process that no longer knows Cursor CLI settles the install as failed instead of handing it over',
    // Reinstall: the same request, over another build.
    'Cursor install relay: Reinstall is the same request, and replaces another build once the runner reports the pinned one',
    // Every other engine as it was.
    'Cursor install relay: every other engine is installed exactly as before, with or without Cursor CLI on the runner',
    'Cursor install relay on PostgreSQL',
  ],
};

export const apiCases = {
  'runners/cursor-install-relay': [
    'Install relay: POST /runners/:id/install takes engine cursor, and the six engines it always took, and nothing else',
    'Install relay: a runner knows Cursor CLI when it declares provider:cursor or reports the engine, installed or not',
    'Install relay: Cursor CLI is relayed to a runner that knows it, and settled by what the runner reports',
    'Install relay: a runner that does not know Cursor CLI is refused the start with the upgrade notice, and nothing is written',
    'Install relay: the heartbeat of a process that does not know Cursor CLI settles a pending Cursor CLI install as failed and hands it nothing',
    'Install relay: every other engine is started and handed over as before, whatever the runner knows of Cursor CLI',
  ],
  // P1's identity of the engine on the server, where Cursor CLI now has an install action.
  'common/cursor-runtime-routing': [
    'P1 cursor is a built-in engine slug, unambiguous since migration 0426, and its guard row is never a provider',
    'P1 a Cursor CLI sign-in session is built for the runner on Cursor CLI alone',
    'P1 Cursor CLI effort values are opaque and the live catalogue decides them',
    'P1 the server admits exactly the Cursor CLI modes the picker calls kept, and defaults to Accept Edits',
  ],
  // The relay slot every engine's install and the machine's update share, as it was.
  'runner-api/engine-update-relay': [
    'a relay row reports which of the two jobs it is running',
    'a row written before updates shared this relay reads as an install',
    'an idle slot claims neither job',
    'starting an update clears the engine an earlier install left behind',
    'an offline machine is refused rather than queued',
    'another owner\'s machine is not found',
    'a pending update is delivered naming no engine',
    'an install still names its engine',
    'a finished install is retired once the probe confirms it',
    'a finished update outlives the probe, because its summary lives nowhere else',
    'an abandoned relay is swept, and says which job it was',
  ],
  // The census every database write is held to, the heartbeat's new refusal among them.
  'common/db-write-inventory': [
    'every database write in the tree is in the inventory, and nothing else is',
    'every transaction unit matches its declared retry shape, and every statement has a class',
    'every retry names the operation it is retrying',
    '40P01, 40001 and P2034 are decided in one place',
    'a transaction writes through its own client and no other',
    'nothing outside the database happens inside a retried transaction',
    'the installed triggers are the ones the inventory describes',
    'task-list writes are absent from the live acceptance-trigger inventory',
    'every excluded source still exists and every class is still used',
  ],
};

export const goCases = {
  'cursor_install_relay_test.go': [
    // A person's Install: the pinned build downloaded once, checked, published, reported; the engine report
    // already has it when the outcome arrives, and the heartbeat right after carries it.
    'TestCursorInstallRelayInstallsThePinnedBuild',
    // Reinstall over another build, or a pinned directory with no entry point; a ready build is left alone.
    'TestCursorReinstallReplacesAnotherBuild',
    'TestCursorReinstallReplacesAnotherBuild/another-version',
    'TestCursorReinstallReplacesAnotherBuild/no-entry-point',
    'TestCursorReinstallReplacesAnotherBuild/pinned-build-ready',
    // What it cannot prove is another build, or cannot replace, stays as it was, and the failure is said.
    'TestCursorReinstallKeepsWhatItCannotReplace',
    'TestCursorReinstallKeepsWhatItCannotReplace/download-refused',
    'TestCursorReinstallKeepsWhatItCannotReplace/no-version-answer',
    // Every other engine keeps its own installer through the same relay.
    'TestInstallRelayKeepsEveryOtherEngineOnItsOwnInstaller',
  ],
  'cursor_install_test.go': [
    // P3's install of the pinned build, which the relay runs: checked, and never written again.
    'TestCursorInstallPublishesPinnedTarball',
    'TestCursorInstallPublishesPinnedTarball/on-demand-install-needs-consent',
    'TestCursorInstallPublishesPinnedTarball/install',
    'TestCursorInstallPublishesPinnedTarball/published-directory-is-never-written-again',
    'TestCursorInstallRejectsChecksumMismatch',
    'TestCursorInstallRejectsChecksumMismatch/tampered',
    'TestCursorInstallRejectsChecksumMismatch/truncated',
    'TestCursorInstallRejectsChecksumMismatch/padded',
    'TestCursorInstallRejectsChecksumMismatch/another-build',
    'TestCursorInstallRejectsChecksumMismatch/not-found',
    'TestCursorInstallRejectsChecksumMismatch/pinned-hash-of-another-version',
    'TestCursorInstallRejectsChecksumMismatch/link-in-package',
    'TestCursorInstallRejectsChecksumMismatch/path-outside-package',
  ],
  'cursor_health_test.go': [
    // The engine report the relay's outcome waits on, and provider:cursor only while the build is ready.
    'TestCursorHealthStates',
    'TestCursorHealthStates/not-installed',
    'TestCursorHealthStates/version-mismatch',
    'TestCursorHealthStates/platform-unsupported',
    'TestCursorHealthStates/signed-out',
    'TestCursorHealthStates/signed-in',
    'TestCursorHealthStates/handshake-is-not-a-credential',
    'TestCursorProviderDeclaredOnlyWhenAvailable',
    'TestCursorProviderDeclaredOnlyWhenAvailable/not-installed',
    'TestCursorProviderDeclaredOnlyWhenAvailable/installed-and-signed-out',
    'TestCursorProviderDeclaredOnlyWhenAvailable/version-mismatch',
    'TestCursorProviderDeclaredOnlyWhenAvailable/platform-unsupported',
    'TestCursorProviderDeclaredOnlyWhenAvailable/no-session-driver',
    'TestCursorProviderDeclaredOnlyWhenAvailable/withdrawn-when-the-build-goes',
  ],
  'engineinstall_test.go': [
    // The Install button of every other engine, as it was.
    'TestInstallEngineNowRepairsAnEngineThatDoesNotRun',
  ],
  'engineupdate_relay_test.go': [
    // The machine's update, which shares the relay slot, as it was.
    'TestUpdateRelayReportsProgressThenOutcome',
    'TestUpdateRelayNamesEveryEngineItSkipped',
    'TestUpdateRelayRefusesToRunTwice',
    'TestUpdateRelayRefusesWhileAnInstallHoldsTheSlot',
    'TestUpdateRelayReportsAFailedEngineAsAFailedRun',
    'TestUpdateRelayReportsADeliberateSkipAsASuccessfulRun',
    'TestUpdateRunFailedReadsTheVerdictOffTheLines',
  ],
};

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
 * wrapper that passed, a test process that cannot start and one that exits non-zero are each refused.
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
      refused(`a repeated ${name}`, () => assertTapResults(tap([...names, name]), names));
    }
  }
  const one = tap(['required']);
  for (const [label, invalid] of [
    ['no output', ''],
    ['a failed scenario', one.replace('ok 1', 'not ok 1')],
    ['a file wrapper that passed', one.replace('required', 'src/apiserver/build/runners/cursor-install-relay.pg.spec.js')],
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
  for (const name of [goNames[0], 'TestCursorReinstallReplacesAnotherBuild/another-version']) {
    refused(`a missing ${name}`, () => assertGoResults(json(events.filter((event) => event.Test !== name)), goNames));
    refused(`a skipped ${name}`, () => assertGoResults(json(events.map((event) => (event.Test === name && event.Action === 'pass' ? { ...event, Action: 'skip' } : event))), goNames));
    refused(`a failed ${name}`, () => assertGoResults(json(events.map((event) => (event.Test === name && event.Action === 'pass' ? { ...event, Action: 'fail' } : event))), goNames));
    refused(`an unfinished ${name}`, () => assertGoResults(json(events.filter((event) => !(event.Test === name && event.Action === 'pass'))), goNames));
    refused(`a repeated ${name}`, () => assertGoResults(json([...events.slice(0, -1), ...goEvents([name]).slice(1, -1), events.at(-1)]), goNames));
  }
  refused('an unmatched Go test', () => assertGoResults(json([...events.slice(0, -1), { Action: 'run', Package: 'orbit', Test: 'TestNotNamedHere' },
    { Action: 'pass', Package: 'orbit', Test: 'TestNotNamedHere' }, events.at(-1)]), goNames));
  refused('a Go package that only says pass', () => assertGoResults(json([{ Action: 'start', Package: 'orbit' }, { Action: 'pass', Package: 'orbit' }]), goNames));
  refused('no Go output', () => assertGoResults('', goNames));
  const selector = new RegExp(goTestPattern(goNames));
  assert.ok(goNames.every((name) => selector.test(name.split('/')[0])), 'the -run pattern misses a named scenario');
  assert.ok(!selector.test(`${goNames[0]}Extra`) && !selector.test('TestCursorInstall') && !selector.test('TestCursorReinstall'),
    'the -run pattern matches more than the named scenarios');

  const log = path.join(scratch, 'guard.log');
  for (const run of [runLogged, runGoLogged]) {
    assert.throws(() => run(path.join(scratch, 'no-such-executable'), [], log), /startup or execution failed/);
    assert.throws(() => run(process.execPath, ['-e', 'process.exit(3)'], log), /exit 3/);
  }

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
  assert.equal(pgLogName(0, 'runners/cursor-install-relay'), '1-cursor-install-relay.pg.spec.tap');
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-install-relay-'));
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
      assert.ok(existsSync(spec), `missing required test file: ${spec}`);
      // In-process, so the named cases are visible (Node 26 process isolation can report a file wrapper).
      const tapOutput = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', spec], path.join(scratch, 'node.log'),
        { cwd: path.join(root, 'src/apiserver') });
      process.stdout.write(tapOutput);
      assertTapResults(tapOutput, names);
      total += names.length;
    }

    const blockedBin = path.join(scratch, 'blocked-bin');
    mkdirSync(blockedBin, { mode: 0o700 });
    for (const tool of ['agent', 'cursor-agent', 'cursor', 'curl', 'wget', 'claude', 'codex', 'kimi', 'opencode', 'agy', 'dsh', 'npm', 'npx']) {
      writeFileSync(path.join(blockedBin, tool), '#!/bin/sh\nprintf "Install follow-up tests started a real CLI or downloader\\n" >&2\nexit 97\n', { mode: 0o700 });
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

    assert.deepEqual(changed(), [], 'the runner user\'s Cursor CLI directories changed');
    process.stdout.write(`PASS the runner user's ${watched.map((entry) => `~/${path.relative(home, entry)}`).join(', ')} are unchanged.\n`);
    process.stdout.write(`Install follow-up acceptance passed: ${total} named scenarios, none missing, unmatched, skipped or failing.\n`);
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

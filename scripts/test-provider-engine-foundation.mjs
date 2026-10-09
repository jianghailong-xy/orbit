import assert from 'node:assert/strict';
import { accessSync, closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';
import { mandatoryApiCases as dshGateApiCases, mandatoryPgNames as dshGatePgNames } from './test-dsh-provider-gate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// T2 of the provider/engine split (docs/provider-engine-contract.md): the session's engine is recorded
// and backfilled, the database refuses it to a transaction that does not read it, and every run path
// reads it. Exact names, independent of test discovery: a renamed, missing or skipped scenario is red.
export const foundationPgSource = 'src/apiserver/src/queue/session-engine-foundation.pg.spec.ts';
export const foundationPgNames = [
  'T2 provider-engine foundation on PostgreSQL',
  // Backfill: every shape of session, and the task pins.
  'T2 backfill records built-in sign-ins, OpenCode own config and the built-in dsh as themselves',
  'T2 backfill records a key session on every protocol as its row runtime, disabled and out-of-reach rows included',
  'T2 backfill records own and shared account pools as the pool engine',
  'T2 backfill records an OpenCode session on a key and a DeepSeek Harness row session',
  'T2 backfill reads a deleted key from the init event, Claude Code without a provider, and leaves the rest unresolved',
  'T2 backfill prefers the init event over a key runtime edited since',
  'T2 backfill gives pinned tasks the engine their pin dispatches on today',
  'T2 backfill is idempotent',
  // The database: the column, the acquisition guard, the runtime gates, the task pin.
  'T2 a recorded engine never changes and a missing one may be recorded once',
  'T2 a claim that does not declare reading the engine is skipped for a session that has one',
  'T2 a lease takeover or activation that does not declare it is refused, before the dsh guard can skip it',
  'T2 the DeepSeek Harness capability gate follows the session engine, not the key runtime',
  'T2 the OpenCode and Antigravity gates follow the session engine',
  "T2 an older replica's run on the pinned credential takes the task's engine pin",
  // The run paths.
  'T2 the claim records the engine of a session an older replica wrote',
  'T2 one DeepSeek key runs Claude Code, OpenCode and DeepSeek Harness sessions, each in its own variables',
  'T2 changing a key protocol, disabling it or deleting it never changes a session engine',
  'T2 reclaim, lease takeover and activation rebuild a session on its recorded engine',
  'T2 meta reports the recorded engine',
  'T2 new sessions record their engine at creation',
  'T2 resume normalizes effort for the session engine and records a missing engine before a switch',
  'T2 the inbox hands a mid-turn steer by the session engine',
  'T2 a provider reload builds the environment for the recorded engine',
  'T2 steer and move judge the session engine',
];

// The PostgreSQL specs whose claim gates, trigger censuses or migrations this task rewrote: they ran
// green before it, and must run green after it, every case passing and none skipped.
export const regressionPgSources = [
  'src/apiserver/src/queue/dsh-provider-gate.pg.spec.ts',
  'src/apiserver/src/queue/gemini-claim-gate.pg.spec.ts',
  'src/apiserver/src/queue/dsh-install-gate.pg.spec.ts',
  'src/apiserver/src/providers/shared-provider-admin-only.pg.spec.ts',
  'src/apiserver/src/providers/antigravity-runtime-migration.pg.spec.ts',
  'src/apiserver/src/providers/gemini-antigravity-migration.pg.spec.ts',
  'src/apiserver/src/tasks/verification-subject-guard-removal.pg.spec.ts',
  'src/apiserver/src/tasks/executable-acceptance-runtime-removal.pg.spec.ts',
  'src/apiserver/src/tasks/failure-continuation-removal.pg.spec.ts',
];

export const foundationApiCases = {
  'providers/session-engine': [
    'T2 legacy derivation: built-in slugs name themselves, kimi and dsh only when built-in',
    'T2 legacy derivation: a disabled or out-of-reach key answers its row runtime, a deleted one is unknown, never Claude',
    'T2 legacy derivation: own and shared pools answer the pool engine',
    'T2 a recorded engine wins over the credential',
    'T2 dispatch injects a key in the variables of the session engine',
    'T2 dispatch refuses a credential the session engine cannot run instead of switching CLI',
    'T2 standing grants are judged by the session engine',
    'T2 the reaper watches a configured non-Claude session initialize',
  ],
  // The specs that pinned the old coupling, rewritten for the recorded engine (named in the delivery
  // notes, old name → new name): every case of each, by name.
  ...dshGateApiCases,
  'runner-api/runner-provider-gate': [
    'legacy claim explains the pending OpenCode stall without stranding other work',
    'an OpenCode-capable runner that does not name Antigravity has its Antigravity rows explained',
    'a Gemini key borrows Antigravity, so a runner that does not name it has that row explained too',
    'a row already carrying the notice is not written again on every long poll',
    'current claim advertises OpenCode and Antigravity directly to the atomic queue gate',
    'legacy reclaim omits OpenCode rows and keeps every other checkout',
    'a capable reclaim keeps the OpenCode row in the snapshot',
    'a reclaim that does not name Antigravity omits its rows and explains the pending ones',
    "a reclaim that does not name Antigravity omits a Gemini key's rows too",
    'a capable reclaim keeps the Antigravity row in the snapshot, on its own runtime',
  ],
  'runner-api/reclaim-open-sessions': [
    'runner restart reclaims every open session so cold checkouts remain protected',
    'reclaim preserves lease state and snapshots an inherited runtime model once',
    'a concurrent Session model edit wins reclaim materialization',
    'session meta preserves the OpenCode runtime provider',
    'session meta preserves the Antigravity runtime provider',
  ],
  'realtime/reaper-dynamic-runtime': [
    'reaper keeps the short runtime-initialization watchdog for Kimi',
    'reaper leaves a slow dynamic runtime inside the shared-state initialization window',
    'reaper still finalizes Codex after the shared-state backstop expires',
  ],
  // These two read the migrations by path, from the apiserver package (MIGRATION_SPECS below).
  'queue/opencode-migration-guard': [
    'OpenCode migration permanently reserves a protected compatibility provider row',
    'the provider fence blocks removal/rename without breaking table-wide maintenance',
    'OpenCode migration blocks legacy control-plane claims without a transaction capability',
    'the silent claim skip stays narrowed to PENDING -> RUNNING, on the recorded engine first',
    'OpenCode compatibility provider makes legacy reclaim fail before Claude dispatch',
  ],
  'queue/antigravity-migration-guard': [
    'Antigravity migration permanently reserves a protected compatibility provider row',
    'the provider fence blocks removal/rename without breaking table-wide maintenance',
    'Antigravity migration blocks legacy control-plane claims without a transaction capability',
    'the silent claim skip stays narrowed to PENDING -> RUNNING, on the recorded engine first',
    'Antigravity compatibility provider makes legacy reclaim fail before Claude dispatch',
    'whatever already held the slug moves aside first, in both halves of the namespace',
    'every stored dispatch reference moves with it',
  ],
};

/** The named specs that read prisma/migrations relative to the working directory. */
const MIGRATION_SPECS = new Set(['queue/opencode-migration-guard', 'queue/antigravity-migration-guard']);

const guardNames = [
  'T2 acceptance guard requires every named PostgreSQL and application scenario',
  'T2 acceptance guard rejects skips todos failures and wrapper-only TAP',
  'T2 acceptance guard rejects a regression run that failed, skipped or ran nothing',
  'T2 acceptance guard rejects missing executables and startup failures',
  'T2 acceptance runs node:test with regular-file output and visible scenario names',
];

/**
 * A whole spec, or the whole unit suite, run for regression rather than for named scenarios: green only
 * when its single summary says something ran, everything that ran passed, and nothing was skipped,
 * left todo or cancelled.
 */
export function assertCleanRun(output, label) {
  const count = (key) => {
    const summaries = [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    assert.equal(summaries.length, 1, `${label}: missing or duplicate ${key} summary`);
    return Number(summaries[0][1]);
  };
  const tests = count('tests');
  assert.ok(tests > 0, `${label}: nothing ran`);
  assert.equal(count('pass'), tests, `${label}: not every test passed`);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(count(key), 0, `${label}: ${key}`);
  assert.doesNotMatch(output, /^\s*(?:not ok\b|ok \d+ - .*#\s*(?:SKIP|TODO)\b)/im, `${label}: failed, skipped or todo case`);
  return tests;
}

export function runLogged(command, args, log, { cwd = root, env = {}, timeout = 120_000 } = {}) {
  const fd = openSync(log, 'w');
  let result;
  try {
    // Regular files for both streams: node:test never writes its IPC/output into a pipe.
    result = spawnSync(command, args, { cwd, stdio: ['ignore', fd, fd], env: { ...process.env, NODE_OPTIONS: '', ...env }, timeout });
  } finally {
    closeSync(fd);
  }
  const output = readFileSync(log, 'utf8');
  if (result.error || result.signal || result.status !== 0) {
    process.stderr.write(output.slice(-20_000));
    // A long run's tail need not reach its failures: name every one, with the lines that say why.
    const lines = output.split('\n');
    const failures = lines.flatMap((line, index) => /^\s*not ok\b/.test(line) ? [lines.slice(index, index + 25).join('\n')] : []);
    if (failures.length) process.stderr.write(`\nFAILED CASES (${failures.length}):\n${failures.join('\n')}\n`);
    throw new Error(`test startup or execution failed: ${command} (exit ${result.status}, signal ${result.signal}, ${result.error?.message ?? ''})`);
  }
  return output;
}

async function prismaEngineEnvironment() {
  if (process.env.PRISMA_SCHEMA_ENGINE_BINARY) return {};
  // As scripts/test-dsh-provider-gate.mjs: an installed or version-matched cached engine on an
  // offline worktree, else Prisma's own discovery.
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-provider-engine-foundation-'));
  const summary = [];
  try {
    const runTap = (file, names, cwd = root) => {
      assert.ok(existsSync(file), `missing required test file: ${file}`);
      // Serial in-process execution exposes the named cases; the validator rejects a wrapper-only result.
      const output = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], path.join(scratch, 'node.log'), { cwd });
      process.stdout.write(output);
      assertTapResults(output, names);
      return names.length;
    };
    summary.push(['guard', runTap(path.join(root, 'test/test-provider-engine-foundation.test.mjs'), guardNames)]);
    for (const file of Object.keys(foundationApiCases)) {
      assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing required test source: ${file}`);
    }

    // PostgreSQL: the named foundation spec first, then the specs it must not regress. One server, one
    // migrated template, a database per spec (scripts/run-pg-spec.sh); this also builds the test tree.
    const pgSources = [foundationPgSource, ...regressionPgSources];
    for (const source of pgSources) assert.ok(existsSync(path.join(root, source)), `missing required test source: ${source}`);
    const output = runLogged('bash', ['scripts/run-pg-spec.sh', ...pgSources], path.join(scratch, 'postgres.log'), {
      env: { ...await prismaEngineEnvironment(), RUN_PG_SPEC_LOG_DIR: scratch, RUN_PG_SPEC_TEST_ISOLATION: 'none' },
      timeout: 2_400_000,
    });
    process.stdout.write(output);
    const tapOf = (index, source) => {
      const log = path.join(scratch, `${index + 1}-${path.basename(source, '.ts')}.tap`);
      assert.ok(existsSync(log), `PostgreSQL runner produced no log for ${source}`);
      return readFileSync(log, 'utf8');
    };
    assertTapResults(tapOf(0, foundationPgSource), foundationPgNames);
    summary.push(['postgres foundation', foundationPgNames.length]);
    for (const [index, source] of regressionPgSources.entries()) {
      const tap = tapOf(index + 1, source);
      // The DeepSeek Harness gate keeps its own named scenarios (scripts/test-dsh-provider-gate.mjs).
      if (source.endsWith('/dsh-provider-gate.pg.spec.ts')) assertTapResults(tap, dshGatePgNames);
      summary.push([`postgres ${path.basename(source)}`, assertCleanRun(tap, source)]);
    }

    // The named application scenarios, from the tree run-pg-spec.sh just built.
    for (const [file, names] of Object.entries(foundationApiCases)) {
      const cwd = MIGRATION_SPECS.has(file) ? path.join(root, 'src/apiserver') : root;
      summary.push([file, runTap(path.join(root, `src/apiserver/build/${file}.spec.js`), names, cwd)]);
    }

    // Every existing apiserver unit spec, as `npm test -w @orbit/apiserver` runs them: none regresses.
    const build = path.join(root, 'src/apiserver/build');
    const specs = readdirSync(build, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .flatMap((entry) => readdirSync(path.join(build, entry.name))
        .filter((name) => name.endsWith('.spec.js') && !name.endsWith('.pg.spec.js'))
        .map((name) => `build/${entry.name}/${name}`))
      .sort();
    assert.ok(specs.length > 0, 'no apiserver unit specs were built');
    const unit = runLogged(process.execPath, ['--test', '--test-reporter=tap', ...specs], path.join(scratch, 'unit.log'), {
      cwd: path.join(root, 'src/apiserver'),
      timeout: 1_500_000,
    });
    summary.push(['apiserver unit suite', assertCleanRun(unit, 'apiserver unit suite')]);
    process.stdout.write(unit.split('\n').filter((line) => /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(line)).join('\n') + '\n');

    for (const [label, count] of summary) process.stdout.write(`PASS ${label}: ${count}\n`);
    process.stdout.write('T2 provider-engine foundation acceptance passed: every named scenario ran and passed, none missing or skipped, and the existing apiserver tests did not regress.\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();

import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';
import { assertCleanRun, runLogged } from './test-provider-engine-foundation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// T4 of the provider/engine split (docs/provider-engine-contract.md §7.2–§7.6): the data migration the API
// server runs when it starts — every deepseek-harness row folded into a DeepSeek key, what names it
// rewritten, the old OpenCode spelling and the built-in dsh moved onto keys — with every session resolving
// as before and a per-row report. Exact names, independent of test discovery: a renamed, missing or skipped
// scenario is red.
export const migrationPgSource = 'src/apiserver/src/providers/provider-engine-migration.pg.spec.ts';
export const migrationPgNames = [
  'T4 provider-engine migration on PostgreSQL',
  "T4 a DeepSeek Harness row merges into the same owner's enabled DeepSeek key holding the same key on the same endpoint",
  'T4 a row with another key, on another endpoint, or with either side turned off converts where it stands, and one turned off stays off',
  'T4 several DeepSeek Harness rows of one owner each become a key, and the ones holding the same key become one',
  'T4 sessions, task pins, preferences, Wiki maintenance settings and workspace fallbacks naming an old slug name the key after, and nothing open names a retired slug',
  'T4 a retired slug resolves to its key on DeepSeek Harness at every door that takes a provider',
  'T4 the old OpenCode spelling becomes the key on OpenCode in sessions, task pins and preferences',
  'T4 built-in dsh sessions move to the first enabled DeepSeek key, keep a workspace key, and are listed without one',
  "T4 the backfill's leftovers are listed, and account pools and managed runners are left as they are",
  'T4 every fixture session resolves to the same engine, key, endpoint, model and runtime id before and after, and dispatch agrees',
  'T4 running it again changes nothing, and a start after the marker folds only the rows an older replica made',
  'T4 two replicas starting together: one migrates, the other waits for it and finds nothing left',
  'T4 a row whose key cannot be read is left as it is, and the run stays incomplete until a start can read it',
  'T4 a rehearsal reports what a run would do and writes nothing',
  'T4 the report lists every row it touched, in its table and in the log, and holds no key material',
];

/** Application specs (src/apiserver/src/<file>.spec.ts) and their named T4 scenarios. */
export const apiCases = {
  'providers/provider-engine-migration': [
    'T4 endpoints compare with scheme and host lowercased and trailing slashes dropped, and nothing else',
    "T4 a key fingerprint is a prefix of the trimmed key's SHA-256, never the key",
    'T4 two resolutions are the same exactly when engine, key, endpoint, model, runtime id and dispatch are',
    'T4 a start never fails on the migration: it logs why and the server comes up',
    'T4 the API server runs the migration when it starts, and the Wiki worker never does',
  ],
};

// The PostgreSQL specs that start the whole API server — AppModule in the spec's process, or build/main.js
// as a child — and so run the migration on their way up now: they run green after it, every case passing
// and none skipped.
export const regressionPgSources = [
  'src/apiserver/src/auth/access-tokens.pg.spec.ts',
];

/** Each acceptance criterion of the task, and the named scenarios that prove it. */
export const criteria = {
  'merged only when the same key is on the same endpoint and both are enabled': [migrationPgNames[1], migrationPgNames[2], migrationPgNames[12], apiCases['providers/provider-engine-migration'][0]],
  'every other row converts where it stands, and a turned-off one stays off': [migrationPgNames[2]],
  'several DeepSeek Harness rows of one owner': [migrationPgNames[3]],
  'sessions, task pins, preferences and Wiki settings are rewritten': [migrationPgNames[4]],
  'an old slug resolves as an alias to the key on DeepSeek Harness': [migrationPgNames[5], migrationPgNames[2]],
  'the old OpenCode spelling is rewritten': [migrationPgNames[6], migrationPgNames[4]],
  'running it again changes nothing': [migrationPgNames[10], migrationPgNames[11]],
  'every fixture session resolves the same before and after (engine, key fingerprint, endpoint, model, runtime id)': [
    migrationPgNames[9], apiCases['providers/provider-engine-migration'][1], apiCases['providers/provider-engine-migration'][2],
  ],
  'a per-row report': [migrationPgNames[14], migrationPgNames[8], migrationPgNames[13]],
};

export const guardNames = [
  'T4 acceptance guard requires every named PostgreSQL and application scenario',
  'T4 acceptance guard maps every acceptance criterion to a scenario it runs',
  'T4 acceptance guard rejects skips todos failures and wrapper-only TAP',
  'T4 acceptance guard rejects missing executables and startup failures',
];

async function prismaEngineEnvironment() {
  if (process.env.PRISMA_SCHEMA_ENGINE_BINARY) return {};
  // As scripts/test-provider-engine-foundation.mjs: an installed or version-matched cached engine on an
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-provider-engine-migration-'));
  const summary = [];
  try {
    const runTap = (file, cwd = root) => {
      assert.ok(existsSync(file), `missing required test file: ${file}`);
      // Serial in-process execution exposes the named cases; the validators reject a wrapper-only result.
      const output = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], path.join(scratch, 'node.log'), { cwd });
      process.stdout.write(output);
      return output;
    };
    assertTapResults(runTap(path.join(root, 'test/test-provider-engine-migration.test.mjs')), guardNames);
    summary.push(['guard', guardNames.length]);
    for (const file of Object.keys(apiCases)) {
      assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing required test source: ${file}`);
    }

    // PostgreSQL: the named spec, then the specs that must not regress. One server, one migrated template,
    // a database per spec (scripts/run-pg-spec.sh); this also builds the test tree the application
    // scenarios run from below.
    const pgSources = [migrationPgSource, ...regressionPgSources];
    for (const source of pgSources) assert.ok(existsSync(path.join(root, source)), `missing required test source: ${source}`);
    const output = runLogged('bash', ['scripts/run-pg-spec.sh', ...pgSources], path.join(scratch, 'postgres.log'), {
      env: { ...await prismaEngineEnvironment(), RUN_PG_SPEC_LOG_DIR: scratch, RUN_PG_SPEC_TEST_ISOLATION: 'none' },
      timeout: 2_700_000,
    });
    process.stdout.write(output);
    for (const [index, source] of pgSources.entries()) {
      const log = path.join(scratch, `${index + 1}-${path.basename(source, '.ts')}.tap`);
      assert.ok(existsSync(log), `PostgreSQL runner produced no log for ${source}`);
      const tap = readFileSync(log, 'utf8');
      if (source === migrationPgSource) {
        assertTapResults(tap, migrationPgNames);
        summary.push(['postgres provider-engine migration', migrationPgNames.length]);
      } else {
        summary.push([`postgres ${path.basename(source)}`, assertCleanRun(tap, source)]);
      }
    }

    // The named application scenarios, from the tree run-pg-spec.sh just built.
    for (const [file, names] of Object.entries(apiCases)) {
      assertTapResults(runTap(path.join(root, `src/apiserver/build/${file}.spec.js`)), names);
      summary.push([file, names.length]);
    }

    // Every apiserver unit spec, as `npm test -w @orbit/apiserver` runs them: none regresses — the
    // migration census, the db-write inventory and the route walks among them.
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
    for (const [criterion, names] of Object.entries(criteria)) process.stdout.write(`COVERED ${criterion}: ${names.length} scenario(s)\n`);
    process.stdout.write('T4 provider-engine migration acceptance passed: every named scenario ran and passed, none missing or skipped, and the existing apiserver tests did not regress.\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();

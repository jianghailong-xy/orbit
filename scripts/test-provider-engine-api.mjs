import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';
import { assertCleanRun, foundationPgNames, runLogged } from './test-provider-engine-foundation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// T3 of the provider/engine split (docs/provider-engine-contract.md §3, §4.4–4.5, §6): one resolver for
// every door that writes an engine and a provider, the routes and the quota gate on (engine, provider),
// the provider endpoints' engines and the key usage read. Exact names, independent of test discovery: a
// renamed, missing or skipped scenario is red.
export const apiPgSource = 'src/apiserver/src/providers/provider-engine-api.pg.spec.ts';
export const apiPgNames = [
  'T3 provider-engine API on PostgreSQL',
  'T3 one DeepSeek key runs Claude Code, OpenCode and DeepSeek Harness sessions, created, resumed and claimed each with its own variables',
  'T3 DeepSeek Harness runs on either of two DeepSeek keys, created on one and switched to the other, and on no other key',
  'T3 a provider alone, an engine alone, both, or neither each resolve to one engine and one credential',
  'T3 incompatible pairs are refused and write nothing: DeepSeek Harness on a GLM key, OpenCode on a subscription token, Claude Code on a Gemini key',
  "T3 a session's credential moves only within what its engine runs, and its engine never changes",
  'T3 a key in use cannot change its protocol, endpoint or secret out from under an engine it runs, and never becomes dsh',
  'T3 a key usage read counts open sessions and task pins per engine, and only for its owner',
  'T3 task engine and provider pins are written together and checked, one by one and in bulk',
  'T3 a run receipt is v3, and a v2 one bound before the split runs on the engine pin beside it',
  "T3 the built-in dsh is DeepSeek Harness on the first enabled DeepSeek key, or refused, and a workspace key's sessions keep theirs",
  'T3 a retired provider name resolves to its key, holds its slug in every table, and goes with the key',
  'T3 /providers, /providers/mine and /runner/providers carry the engines each credential runs on',
  'T3 the sweep runs a task on its own key while the runner reports its engine sign-in spent, and holds one on that sign-in',
];

/** PostgreSQL specs holding a named T3 scenario among others: the names pass, and so does the rest. */
export const pgCases = {
  'src/apiserver/src/wiki/wiki-maintenance-session.pg.spec.ts': [
    'T3 a maintenance run on its pinned key starts only on Claude Code, whatever else that key runs',
  ],
};

// The PostgreSQL specs whose doors, receipts, routes, trigger census or wording this task rewrote: they
// run green after it, every case passing and none skipped. T2's own spec keeps its named scenarios.
export const regressionPgSources = [
  'src/apiserver/src/queue/session-engine-foundation.pg.spec.ts',
  'src/apiserver/src/queue/dsh-install-gate.pg.spec.ts',
  'src/apiserver/src/queue/dsh-provider-gate.pg.spec.ts',
  'src/apiserver/src/providers/provider-pool.pg.spec.ts',
  'src/apiserver/src/providers/pool-security-boundary.pg.spec.ts',
  'src/apiserver/src/providers/shared-pool-doors.pg.spec.ts',
  'src/apiserver/src/providers/shared-provider-admin-only.pg.spec.ts',
  'src/apiserver/src/sessions/pool-provider-doors.pg.spec.ts',
  'src/apiserver/src/sessions/resume-routes-to-current-run.pg.spec.ts',
  'src/apiserver/src/sessions/session-message.pg.spec.ts',
  'src/apiserver/src/tasks/task-batch-pin.pg.spec.ts',
  'src/apiserver/src/runner-api/runner-task-batch-pin.pg.spec.ts',
  'src/apiserver/src/tasks/task-dispatch-refusal-visible.pg.spec.ts',
  'src/apiserver/src/tasks/task-model-hint.pg.spec.ts',
  'src/apiserver/src/tasks/task-model-routing-account-switch.pg.spec.ts',
  'src/apiserver/src/tasks/task-model-routing-apply.pg.spec.ts',
  'src/apiserver/src/tasks/task-model-routing-cross-provider.pg.spec.ts',
  'src/apiserver/src/tasks/task-model-routing-shadow.pg.spec.ts',
  // Every route, the new key usage read included, refused across accounts.
  'src/apiserver/src/auth/tenant-isolation.pg.spec.ts',
];

/** Application specs (src/apiserver/src/<file>.spec.ts) and their named T3 scenarios. */
export const apiCases = {
  'providers/engine-provider': [
    'T3 resolution: a provider alone runs on the engine it ran on before the split',
    'T3 resolution: an engine alone runs on its own credential, DeepSeek Harness on the first enabled DeepSeek key',
    'T3 resolution: an engine and a provider named together are checked against each other',
    'T3 resolution: neither named starts where the workspace last started, re-checked',
    'T3 resolution: incompatible pairs are refused, naming the engines the provider runs on',
    'T3 resolution: an old OpenCode model naming a key is written as that key on OpenCode',
    'T3 resolution: the built-in dsh is DeepSeek Harness on the default DeepSeek key, or refused DEEPSEEK_KEY_REQUIRED',
    'T3 resolution: a retired provider name resolves to its key, on its engine unless one is named',
    'T3 switch: a session engine never changes, and its credential moves only within what that engine runs',
    'T3 task pins: the engine and the provider are written together, each three-state',
    'T3 preferences: a new key is checked, an old one kept as written and mirrored under the key it means',
    'T3 receipts: v3 is read as written, v1 and v2 with no engine, the engine pin read back beside a mixed-window one, v4 refused',
    'T3 routing: a run moved to another engine keeps a key that engine can run, and otherwise takes its sign-in',
    "T3 routing: a run on a key is never moved off its engine by the runner's report on its sign-in",
    'T3 quota gate: a run on a key is neither held by the runner report nor blind for want of one',
    'T3 providers: /providers, /providers/mine and /runner/providers carry the engines each key runs on',
    'T3 providers: a DeepSeek key is connection-tested on Anthropic Messages whatever engine it runs on',
    'T3 providers: an older client connecting DeepSeek Harness gets a DeepSeek key, named for the vendor',
  ],
  'providers/dsh-provider': [
    'T3 the retired Harness preset creates a DeepSeek key, which DeepSeek Harness runs on with its dedicated API key',
    'T3 a key never becomes dsh, leaves it unless that strands what uses it, and is deleted whatever its history',
    "T3 a Harness-shaped create keeps DeepSeek's own models, and a legacy dsh row edits like any key",
    'T3 the dsh runtime is still accepted by the DTOs, and a DeepSeek key is probed on Anthropic Messages',
  ],
  'sessions/dsh-session-routing': [
    'dsh compatibility: Claude and Harness histories switch between DeepSeek keys on their own engine and refuse any other',
  ],
};

/** Each acceptance criterion of the task, and the named scenarios that prove it. */
export const criteria = {
  'one DeepSeek key runs on three engines: create, resume and the injected credentials': [apiPgNames[1]],
  'DeepSeek Harness on two keys: create on each, switch between them': [apiPgNames[2], apiCases['sessions/dsh-session-routing'][0]],
  'provider only, engine only, both and neither resolve': [apiPgNames[3], ...apiCases['providers/engine-provider'].slice(0, 4)],
  'incompatible pairs are refused (DSH + GLM key, OpenCode + subscription token, Claude Code + Gemini key)': [apiPgNames[4], apiCases['providers/engine-provider'][4]],
  'a switch stays within what the session engine runs': [apiPgNames[5], apiCases['providers/engine-provider'][8]],
  'a key protocol change is refused while it is used incompatibly': [apiPgNames[6], apiCases['providers/dsh-provider'][1]],
  'task engine pins and batch-pin validation': [apiPgNames[8], apiCases['providers/engine-provider'][9]],
  'run receipt v3, and old receipts read': [apiPgNames[9], apiCases['providers/engine-provider'][11]],
  'model routing keeps the original key when the engine can run it': [apiCases['providers/engine-provider'][12], apiCases['providers/engine-provider'][13]],
  'the quota gate does not block a key': [apiPgNames[13], apiCases['providers/engine-provider'][14]],
  '/providers returns engines': [apiPgNames[12], apiCases['providers/engine-provider'][15]],
  'a DeepSeek key is connection-tested': [apiCases['providers/engine-provider'][16], apiCases['providers/dsh-provider'][3]],
  'the built-in dsh resolves to the default DeepSeek key, or refuses explicitly': [apiPgNames[10], apiCases['providers/engine-provider'][6]],
  'the key usage read: per engine, unreadable across accounts': [apiPgNames[7], 'src/apiserver/src/auth/tenant-isolation.pg.spec.ts'],
};

export const guardNames = [
  'T3 acceptance guard requires every named PostgreSQL and application scenario',
  'T3 acceptance guard maps every acceptance criterion to a scenario it runs',
  'T3 acceptance guard requires named scenarios inside a larger spec, and the rest of it clean',
  'T3 acceptance guard rejects skips todos failures and wrapper-only TAP',
  'T3 acceptance guard rejects missing executables and startup failures',
];

/**
 * A spec that holds the named scenarios among others: each name passed exactly once, and the whole
 * run is clean — everything that ran passed, nothing skipped, left todo or cancelled.
 */
export function assertNamedWithin(output, names, label) {
  assert.ok(names.length > 0, `${label}: no named scenarios declared`);
  const passed = [...output.matchAll(/^\s*ok \d+ - (.+)$/gm)].map((match) => match[1]);
  for (const name of names) {
    assert.equal(passed.filter((value) => value === name).length, 1, `${label}: missing or unmatched scenario: ${name}`);
  }
  return assertCleanRun(output, label);
}

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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-provider-engine-api-'));
  const summary = [];
  try {
    const runTap = (file, cwd = root) => {
      assert.ok(existsSync(file), `missing required test file: ${file}`);
      // Serial in-process execution exposes the named cases; the validators reject a wrapper-only result.
      const output = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], path.join(scratch, 'node.log'), { cwd });
      process.stdout.write(output);
      return output;
    };
    assertTapResults(runTap(path.join(root, 'test/test-provider-engine-api.test.mjs')), guardNames);
    summary.push(['guard', guardNames.length]);
    for (const file of Object.keys(apiCases)) {
      assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing required test source: ${file}`);
    }

    // PostgreSQL: the named spec, the specs holding named scenarios, then the specs that must not
    // regress. One server, one migrated template, a database per spec (scripts/run-pg-spec.sh); this
    // also builds the test tree the application scenarios run from below.
    const pgSources = [apiPgSource, ...Object.keys(pgCases), ...regressionPgSources];
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
    for (const [index, source] of pgSources.entries()) {
      const tap = tapOf(index, source);
      if (source === apiPgSource) {
        assertTapResults(tap, apiPgNames);
        summary.push(['postgres provider-engine API', apiPgNames.length]);
        continue;
      }
      if (pgCases[source]) {
        summary.push([`postgres ${path.basename(source)}`, assertNamedWithin(tap, pgCases[source], source)]);
        continue;
      }
      // T2's spec, which this task rewrote two of: every scenario of it still named and passing.
      if (source.endsWith('/session-engine-foundation.pg.spec.ts')) assertTapResults(tap, foundationPgNames);
      summary.push([`postgres ${path.basename(source)}`, assertCleanRun(tap, source)]);
    }

    // The named application scenarios, from the tree run-pg-spec.sh just built.
    for (const [file, names] of Object.entries(apiCases)) {
      const tap = runTap(path.join(root, `src/apiserver/build/${file}.spec.js`));
      summary.push([file, file === 'providers/engine-provider' ? (assertTapResults(tap, names), names.length) : assertNamedWithin(tap, names, file)]);
    }

    // Every apiserver unit spec, as `npm test -w @orbit/apiserver` runs them: none regresses.
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
    process.stdout.write('T3 provider-engine API acceptance passed: every named scenario ran and passed, none missing or skipped, and the existing apiserver tests did not regress.\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();

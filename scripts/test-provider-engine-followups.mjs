import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';
import { assertNamedWithin } from './test-provider-engine-api.mjs';
import { assertCleanRun, runLogged } from './test-provider-engine-foundation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// The T3 follow-up of the provider/engine split (docs/provider-engine-contract.md §4.5, §6.2, §6.4, §10;
// the coordinator's ruling on T3, task comment 34cyudiXaHl11u51vxITa): a key holding a Claude subscription
// token is blind in the quota gate, an API key still is not, and a crossing's digest binds the engine pin
// beside the provider pin. Exact names, independent of test discovery: a renamed, missing or skipped
// scenario is red.
export const followupPgSource = 'src/apiserver/src/tasks/provider-engine-followups.pg.spec.ts';
export const followupPgNames = [
  'T3 follow-up on PostgreSQL',
  'T3 follow-up: a task on a key holding a Claude subscription token that hits its usage limit waits out the brake a sign-in nobody reports gets, and is not re-dispatched every minute',
  'T3 follow-up: a task on an API key is held neither by the runner report on its engine sign-in nor by its own usage-limit failure, as before',
  'T3 follow-up: a crossing binds the engine pin beside the provider pin, and the task lands on the engine and key that were approved',
];

/** PostgreSQL specs holding a named scenario among others: the names pass, and so does the rest. */
export const pgCases = {
  // T3's own spec: a key is not held by the runner's report on its engine's sign-in, as T3 left it.
  'src/apiserver/src/providers/provider-engine-api.pg.spec.ts': [
    'T3 the sweep runs a task on its own key while the runner reports its engine sign-in spent, and holds one on that sign-in',
  ],
};

// The PostgreSQL specs over the doors this task changed — the sweep's retry policy and quota gate, and
// crossings filed, answered, spent and moved: they run green after it, every case passing and none skipped.
export const regressionPgSources = [
  'src/apiserver/src/tasks/task-auto-run-retry-after-run-ended.pg.spec.ts',
  'src/apiserver/src/tasks/project-handoff.pg.spec.ts',
  // Pins the v6 digest of a plan with no engine, byte for byte.
  'src/apiserver/src/tasks/task-model-hint.pg.spec.ts',
  'src/apiserver/src/tasks/task-move-request.pg.spec.ts',
];

/** Application specs (src/apiserver/src/<file>.spec.ts) and their named scenarios. */
export const apiCases = {
  'tasks/quota-gate-subscription-key': [
    "T3 follow-up quota gate: a key holding a Claude subscription token is blind, its key read once a pass and only on Anthropic's protocol",
    'T3 follow-up quota gate: a usage limit on a subscription-token key holds its task for the blind brake, and one on an API key is not held, as before',
  ],
  'projects/project-handoff': [
    'T3 follow-up handoff: the identity binds the engine pin beside the provider pin, and a plan that pins no engine keeps its identity',
    'the identity binds every field an approval authorises, not just the prose',
  ],
  'providers/engine-provider': [
    'T3 quota gate: a run on a key is neither held by the runner report nor blind for want of one',
  ],
};

export const guardNames = [
  'T3 follow-up acceptance guard requires every named PostgreSQL and application scenario',
  'T3 follow-up acceptance guard maps every acceptance criterion to a scenario it runs',
  'T3 follow-up acceptance guard rejects skips todos failures and wrapper-only TAP',
  'T3 follow-up acceptance guard rejects missing executables and startup failures',
  'T3 follow-up acceptance guard finds the ruling written into the contract: §3.6, §4.5, §6.2, §6.4 and §10',
];

/** A named scenario, by its name: a name the lists above do not hold is refused here, not later. */
function named(list, name) {
  assert.ok(list.includes(name), `not a named scenario: ${name}`);
  return name;
}
const pg = (name) => named([...followupPgNames, ...Object.values(pgCases).flat()], name);
const api = (file, name) => named(apiCases[file], name);

/** Each acceptance criterion of the task, and the named scenarios that prove it. */
export const criteria = {
  'a key holding a Claude subscription token that hits its usage limit waits for the reset, and is not re-dispatched every minute': [
    pg(followupPgNames[1]),
    api('tasks/quota-gate-subscription-key', apiCases['tasks/quota-gate-subscription-key'][0]),
    api('tasks/quota-gate-subscription-key', apiCases['tasks/quota-gate-subscription-key'][1]),
  ],
  "an API key's quota gate behaves as before": [
    pg(followupPgNames[2]),
    pg(pgCases['src/apiserver/src/providers/provider-engine-api.pg.spec.ts'][0]),
    api('providers/engine-provider', apiCases['providers/engine-provider'][0]),
    api('tasks/quota-gate-subscription-key', apiCases['tasks/quota-gate-subscription-key'][1]),
  ],
  'the project handoff digest binds both the engine and the provider': [
    pg(followupPgNames[3]),
    api('projects/project-handoff', apiCases['projects/project-handoff'][0]),
    api('projects/project-handoff', apiCases['projects/project-handoff'][1]),
  ],
  'the contract carries the ruling: §4.5, §6.4 and §10, and the §3.6 window': [
    named(guardNames, 'T3 follow-up acceptance guard finds the ruling written into the contract: §3.6, §4.5, §6.2, §6.4 and §10'),
  ],
};

/** One `###` section of a markdown document, heading to the next heading of the same or a higher level. */
export function markdownSection(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.ok(start >= 0, `no section: ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  const end = lines.findIndex((line, index) => index > start && /^#+ /.test(line) && line.match(/^#+/)[0].length <= level);
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/**
 * The coordinator's ruling as the contract has to carry it: §4.5 the subscription-token exception beside
 * keys never being blind, §6.4 `route.provider` as the sign-in's slug, §3.6 the check-then-write window
 * and what it leads to, §6.2 the engine the handoff digest binds, and §10 each ruled item with its date.
 */
export function assertContractCarriesRuling(markdown) {
  const quota = markdownSection(markdown, '### 4.5 额度闸门');
  assert.match(quota, /sk-ant-oat/, '§4.5 does not name the subscription token');
  assert.match(quota, /例外[^\n]*Claude 订阅 token[^\n]*blind/, '§4.5 does not make the subscription-token key blind');
  assert.match(quota, /普通 API key 也不再记为 blind/, '§4.5 no longer keeps an API key out of blind');
  assert.match(quota, /QUOTA_BLIND_RETRY_BACKOFF_MS/, '§4.5 does not say how long the brake holds');
  assert.match(quota, /不每分钟重派/, '§4.5 does not rule out the once-a-minute re-dispatch');
  const receipt = markdownSection(markdown, '### 6.4 任务运行回执 v3');
  assert.doesNotMatch(receipt, /or null for the\s+\*\s+engine's own runner sign-in/, '§6.4 still says a sign-in is written as null');
  assert.match(receipt, /written as the sign-in's slug/, "§6.4 does not say route.provider is the sign-in's slug");
  assert.match(receipt, /e\.g\. `codex`/);
  const keys = markdownSection(markdown, '### 3.6 key 的新建、编辑、停用与删除');
  assert.match(keys, /先查后写/, '§3.6 does not record the PROVIDER_DIALECT_IN_USE check-then-write window');
  assert.match(keys, /领取时不派发[^\n]*凭据不可用[^\n]*绝不换成另一个 CLI/, '§3.6 does not say what a session created in the window meets');
  const tasks = markdownSection(markdown, '### 6.2 任务');
  assert.match(tasks, /handoffPayloadDigest[^\n]*engine pin/, '§6.2 does not say the handoff digest binds the engine pin');
  const rulings = markdownSection(markdown, '## 10. 裁决记录');
  assert.match(rulings, /2026-10-09，协调会话对 T3 交付说明（任务评论 `34cvbthCe6ZL1QJAHzEKS`）/, '§10 does not date the T3 ruling');
  assert.match(rulings, /34cyudiXaHl11u51vxITa/, '§10 does not name the ruling comment');
  for (const [row, section] of [[8, '§4.5'], [9, '§6.4'], [10, '§3.6'], [12, '§6.2']]) {
    assert.match(rulings, new RegExp(`^\\| ${row} \\|[^\\n]*\\| ${section.replace('.', '\\.')}[^\\n]*\\|$`, 'm'), `§10 has no row ${row} landing in ${section}`);
  }
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-provider-engine-followups-'));
  const summary = [];
  try {
    // A fresh worktree has no node_modules until scripts/worktree-overlay.sh lays them out, and the
    // Prisma engine below is looked up there: lay them out before anything else (run-pg-spec.sh runs it
    // again and finds everything in place).
    process.stdout.write(runLogged('bash', ['scripts/worktree-overlay.sh'], path.join(scratch, 'overlay.log'), { timeout: 600_000 }));
    const runTap = (file, cwd = root) => {
      assert.ok(existsSync(file), `missing required test file: ${file}`);
      // Serial in-process execution exposes the named cases; the validators reject a wrapper-only result.
      const output = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], path.join(scratch, 'node.log'), { cwd });
      process.stdout.write(output);
      return output;
    };
    assertTapResults(runTap(path.join(root, 'test/test-provider-engine-followups.test.mjs')), guardNames);
    summary.push(['guard', guardNames.length]);
    for (const file of Object.keys(apiCases)) {
      assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing required test source: ${file}`);
    }

    // PostgreSQL: the named spec, the spec holding a named scenario, then the specs that must not regress.
    // One server, one migrated template, a database per spec (scripts/run-pg-spec.sh); this also builds the
    // test tree the application scenarios run from below.
    const pgSources = [followupPgSource, ...Object.keys(pgCases), ...regressionPgSources];
    for (const source of pgSources) assert.ok(existsSync(path.join(root, source)), `missing required test source: ${source}`);
    const output = runLogged('bash', ['scripts/run-pg-spec.sh', ...pgSources], path.join(scratch, 'postgres.log'), {
      env: { ...await prismaEngineEnvironment(), RUN_PG_SPEC_LOG_DIR: scratch, RUN_PG_SPEC_TEST_ISOLATION: 'none' },
      timeout: 1_800_000,
    });
    process.stdout.write(output);
    for (const [index, source] of pgSources.entries()) {
      const log = path.join(scratch, `${index + 1}-${path.basename(source, '.ts')}.tap`);
      assert.ok(existsSync(log), `PostgreSQL runner produced no log for ${source}`);
      const tap = readFileSync(log, 'utf8');
      if (source === followupPgSource) {
        assertTapResults(tap, followupPgNames);
        summary.push(['postgres provider-engine follow-ups', followupPgNames.length]);
      } else if (pgCases[source]) {
        summary.push([`postgres ${path.basename(source)}`, assertNamedWithin(tap, pgCases[source], source)]);
      } else {
        summary.push([`postgres ${path.basename(source)}`, assertCleanRun(tap, source)]);
      }
    }

    // The named application scenarios, from the tree run-pg-spec.sh just built.
    for (const [file, names] of Object.entries(apiCases)) {
      const tap = runTap(path.join(root, `src/apiserver/build/${file}.spec.js`));
      summary.push([file, file === 'tasks/quota-gate-subscription-key' ? (assertTapResults(tap, names), names.length) : assertNamedWithin(tap, names, file)]);
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
      timeout: 900_000,
    });
    summary.push(['apiserver unit suite', assertCleanRun(unit, 'apiserver unit suite')]);
    process.stdout.write(unit.split('\n').filter((line) => /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(line)).join('\n') + '\n');

    for (const [label, count] of summary) process.stdout.write(`PASS ${label}: ${count}\n`);
    for (const [criterion, names] of Object.entries(criteria)) process.stdout.write(`COVERED ${criterion}: ${names.length} scenario(s)\n`);
    process.stdout.write('T3 follow-up acceptance passed: every named scenario ran and passed, none missing or skipped, the contract carries the ruling, and the existing apiserver tests did not regress.\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();

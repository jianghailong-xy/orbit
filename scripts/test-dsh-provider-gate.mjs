import assert from 'node:assert/strict';
import { accessSync, closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// Keep this independent of test discovery: a renamed, missing or skipped scenario is red.
export const mandatoryPgNames = [
  'P1b DeepSeek Harness provider gate on PostgreSQL',
  'P1b direct dsh requires request and heartbeat declarations',
  'P1b configured providers borrowing dsh require the same declarations',
  'P1b missing and withdrawn heartbeats fence claims and reclaims',
  'P1b old control plane raw claims cannot bypass the database barrier',
  'P1b concurrent claims and reclaims obey runtime gates and capacity',
  'P1b existing engines and legacy dsh identities still dispatch',
  'P1b unavailable and unknown providers never dispatch as Claude',
];
export const mandatoryApiCases = {
  'runner-api/dsh-provider-gate': [
    'P1b dsh claim requires request and persisted heartbeat declarations',
    'P1b dsh reclaim withholds unsupported Harness while retaining legacy checkouts',
    'P1b dsh provider notices distinguish native and legacy colliding identities',
    'P1b dsh heartbeat omission withdraws provider declaration',
  ],
  'queue/queue-provider-capability': [
    'the atomic claim selection receives a false OpenCode capability for legacy runners',
    'the atomic claim selection and database guard receive a true OpenCode capability for current runners',
    'a runner that advertises OpenCode but not Antigravity is withheld Antigravity rows',
    "a runner that does not name Antigravity is withheld a Gemini key's rows too",
    'the atomic claim selection and database guard admit Antigravity for a runner that names it',
    'a claim clears the upgrade notice of every runtime gate it just passed',
    'P1b dsh queue negotiates transaction gate and clears upgrade notices',
  ],
  'sessions/dsh-runner-preflight': [
    'P1b dsh preflight: direct Harness creation requires a heartbeat capability',
    'P1b dsh preflight: configured Harness credentials cannot bypass the runner gate',
    'P1b dsh preflight: resume and config reject withdrawn direct and borrowed capabilities',
    'P1b dsh preflight: capable runners still reject unverified Harness permissions',
    'P1b dsh preflight: existing engines and legacy DeepSeek routes remain available',
    'P1b dsh preflight: unresolved and disabled provider identities fail closed',
    'P1b dsh dispatch: unknown runtimes and unavailable providers never resolve to Claude',
    'P1b dsh dispatch: capability filters preserve configured dsh keyword collisions',
  ],
};
const guardNames = [
  'P1b acceptance guard requires every mandatory PostgreSQL and application scenario',
  'P1b acceptance guard rejects skips todos failures and wrapper-only TAP',
  'P1b acceptance guard rejects absent duplicate and inconsistent summaries',
  'P1b acceptance guard rejects missing executables and startup failures',
  'P1b acceptance runs node:test with regular-file output and visible scenario names',
];

export function runLogged(command, args, log, { cwd = root, env = {}, timeout = 120_000 } = {}) {
  const fd = openSync(log, 'w');
  let result;
  try {
    result = spawnSync(command, args, { cwd, stdio: ['ignore', fd, fd], env: { ...process.env, NODE_OPTIONS: '', ...env }, timeout });
  } finally {
    closeSync(fd);
  }
  const output = readFileSync(log, 'utf8');
  if (result.error || result.signal || result.status !== 0) {
    process.stderr.write(output);
    throw new Error(`test startup or execution failed: ${command} (exit ${result.status}, signal ${result.signal}, ${result.error?.message ?? ''})`);
  }
  return output;
}

async function prismaEngineEnvironment() {
  if (process.env.PRISMA_SCHEMA_ENGINE_BINARY) return {};
  // Reuse an installed or version-matched cached engine on offline worktrees. Leave Prisma's
  // normal discovery intact when neither exists; never pin this script to one machine or version.
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-dsh-provider-gate-'));
  try {
    const runTap = (file, names) => {
      assert.ok(existsSync(file), `missing required test file: ${file}`);
      const output = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], path.join(scratch, 'node.log'));
      process.stdout.write(output);
      assertTapResults(output, names);
    };
    runTap(path.join(root, 'test/test-dsh-provider-gate.test.mjs'), guardNames);
    for (const file of Object.keys(mandatoryApiCases)) {
      assert.ok(existsSync(path.join(root, `src/apiserver/src/${file}.spec.ts`)), `missing required test source: ${file}`);
    }
    const pgSource = 'src/apiserver/src/queue/dsh-provider-gate.pg.spec.ts';
    assert.ok(existsSync(path.join(root, pgSource)), `missing required test source: ${pgSource}`);
    const output = runLogged('bash', ['scripts/run-pg-spec.sh', pgSource], path.join(scratch, 'postgres.log'), {
      env: { ...await prismaEngineEnvironment(), RUN_PG_SPEC_LOG_DIR: scratch, RUN_PG_SPEC_TEST_ISOLATION: 'none' },
      timeout: 1_200_000,
    });
    process.stdout.write(output);
    const pgLog = path.join(scratch, '1-dsh-provider-gate.pg.spec.tap');
    assert.ok(existsSync(pgLog), 'PostgreSQL runner produced no mandatory scenario log');
    assertTapResults(readFileSync(pgLog, 'utf8'), mandatoryPgNames);
    for (const [file, names] of Object.entries(mandatoryApiCases)) {
      runTap(path.join(root, `src/apiserver/build/${file}.spec.js`), names);
    }
    const total = mandatoryPgNames.length + Object.values(mandatoryApiCases).reduce((sum, names) => sum + names.length, 0);
    process.stdout.write(`P1b acceptance passed: ${total} named PostgreSQL and application tests, none missing or skipped.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();

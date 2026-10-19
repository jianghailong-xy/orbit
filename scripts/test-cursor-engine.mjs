// Acceptance for project P1 (Cursor CLI native, 34gyHIZv301nDWxKP9XkO): `cursor` registered as the seventh
// engine in shared and the API server, and kept away from every runner and API replica that does not know
// it (migration 0426). Run from the repository root:
//
//   node scripts/test-cursor-engine.mjs
//
// Every scenario below is named, and each is required to run and pass exactly once: a scenario missing,
// renamed, skipped, marked todo, failing, or a test process that did not start, is a non-zero exit. The
// guard is scripts/test-dsh-routing.mjs's, reused as it is. The PostgreSQL scenarios run through
// scripts/run-pg-spec.sh on a throwaway server; it also compiles the API server's test tree the
// application scenarios then run from. Besides Cursor CLI's own, the existing OpenCode, Antigravity and
// DeepSeek Harness gates and the engine compatibility table are required whole.
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults, assertVitestResults } from './test-dsh-routing.mjs';
import { runLogged } from './test-dsh-provider-gate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// Exact mandatory scenario names, independent of what the test runners happen to discover.
export const sharedCases = {
  // Cursor CLI's own: identity, compatibility table, transport and permission semantics.
  'src/cursor-engine.spec.ts': [
    'P1 cursor is the seventh engine under its CLI name, with an opaque model space defaulting to Auto',
    'P1 a runner sign-in to cursor runs on cursor alone, and no other credential runs on cursor',
    'P1 cursor is one resident JSON-RPC process per session with no mid-turn steer and no fast lane',
    'P5c cursor keeps Accept Edits, Plan, Auto, Don’t Ask and Bypass, and refuses Default with a note',
    'P1 the six existing engines keep their names, transports, steer and permission tables',
  ],
  // The compatibility table every client and the server share (docs/provider-engine-contract.md §2.1).
  'src/providerEngines.spec.ts': [
    'lists every engine once, each under its CLI name',
    'runs a sign-in, a pool and OpenCode config on their own engine only',
    'runs a key on its dialect’s own engine first, then OpenCode',
    'adds DeepSeek Harness for a DeepSeek key, preset or custom host alike',
    'keeps a row still on the dsh runtime on DeepSeek Harness by default',
    'runs a Claude subscription token on Claude Code alone',
    'runs a key on a protocol no engine speaks nowhere',
    'is the engine the credential ran on before the split',
    'pairs an engine with a credential only where the table allows it',
    'is the two presets, else a custom endpoint on api.deepseek.com',
  ],
};

export const pgCases = {
  'providers/cursor-engine-migration': [
    'P1 a database every migration ran on carries the cursor fence',
    'P1 a key named cursor moves aside with its sessions, tasks, preferences and every other reference',
    'P1 an account pool or a retired name holding cursor moves aside, and the guard row then takes it',
    'P1 a reference whose holder was deleted keeps meaning it, not Cursor CLI',
    'P1 on a database where nothing held cursor, the migration only adds the fence',
    'P1 the reserved cursor row refuses removal, renaming and disabling, and no new key, pool or name can take cursor',
    'P1 the engine checks accept cursor on sessions and tasks and refuse an unknown engine',
    'P1 cursor engine migration on PostgreSQL',
  ],
  'queue/cursor-runner-gate': [
    'P1 a runner without provider:cursor cannot claim a Cursor CLI session',
    'P1 a runner without provider:cursor cannot reclaim a Cursor CLI session',
    'P1 a runner without provider:cursor cannot take over or activate a Cursor CLI lease',
    'P1 missing and withdrawn heartbeats fence Cursor CLI claims and reclaims',
    'P1 an API replica that does not read session engines or know Cursor CLI cannot claim or lease one',
    'P1 every other engine still dispatches beside a waiting Cursor CLI session',
    'P1 Cursor CLI runner gate on PostgreSQL',
  ],
  // DeepSeek Harness: request and heartbeat declarations, the raw-claim barrier.
  'queue/dsh-provider-gate': [
    'P1b direct dsh requires request and heartbeat declarations',
    'P1b configured providers borrowing dsh require the same declarations',
    'P1b missing and withdrawn heartbeats fence claims and reclaims',
    'P1b old control plane raw claims cannot bypass the database barrier',
    'P1b concurrent claims and reclaims obey runtime gates and capacity',
    'P1b existing engines and legacy dsh identities still dispatch',
    'P1b unavailable and unknown providers never dispatch as Claude',
    'P1b DeepSeek Harness provider gate on PostgreSQL',
  ],
  // DeepSeek Harness: the install gate.
  'queue/dsh-install-gate': [
    'IG-PG1 an upgraded runner without the pinned CLI keeps declaring dsh and reports it not installed',
    'IG-PG2 creating a Harness session there is refused with the not-installed notice and writes nothing',
    'IG-PG3 a persisted Harness session keeps its follow-up queued with the notice and is never claimed',
    'IG-PG4 a Claude session on the same runner is not held behind the Harness install',
    'IG-PG5 after the install the next heartbeat hands the same sessions over and new ones are created',
    'IG-PG6 platform and version reports refuse with their own notices',
    'IG-PG7 a runner that does not declare dsh still waits for an upgrade first (P1b)',
    'dsh install gate on PostgreSQL',
  ],
  // Antigravity: a Gemini key at claim and reclaim.
  'queue/gemini-claim-gate': [
    '(1) a runner that does not advertise antigravity is not handed the session',
    '(2) its reclaim leaves the session out, so it is not rebuilt as Claude either',
    '(3) a runner that advertises antigravity claims it as an antigravity job on the row’s key',
    '(4) and its reclaim keeps the session, on the antigravity runtime',
    '(5) a switched-off Gemini row is unavailable instead of dispatching as Claude',
    'a Gemini key at claim time, on real PostgreSQL',
  ],
  // Antigravity: 0367, the slug reservation this migration follows.
  'providers/antigravity-runtime-migration': [
    'a database every migration ran on carries the fence',
    'a configured provider called antigravity moves aside with every reference to it',
    'the reserved row cannot be removed, renamed, disabled or shadowed',
    'only a claim that declares the Antigravity capability starts an Antigravity row',
    'an account pool holding the slug moves aside, and the guard row then takes it',
    'a reference whose provider was deleted keeps meaning that provider, not agy',
    'on a database where nothing held the slug, the migration only adds the fence',
    '0367 moves whatever held `antigravity` aside and reserves the name',
  ],
  // The recorded engine: 0414, its claim barrier and the OpenCode, Antigravity and dsh gates on it.
  'queue/session-engine-foundation': [
    'T2 backfill records built-in sign-ins, OpenCode own config and the built-in dsh as themselves',
    'T2 backfill records a key session on every protocol as its row runtime, disabled and out-of-reach rows included',
    'T2 backfill records own and shared account pools as the pool engine',
    'T2 backfill records an OpenCode session on a key and a DeepSeek Harness row session',
    'T2 backfill reads a deleted key from the init event, Claude Code without a provider, and leaves the rest unresolved',
    'T2 backfill prefers the init event over a key runtime edited since',
    'T2 backfill gives pinned tasks the engine their pin dispatches on today',
    'T2 backfill is idempotent',
    'T2 a recorded engine never changes and a missing one may be recorded once',
    'T2 a claim that does not declare reading the engine is skipped for a session that has one',
    'T2 a lease takeover or activation that does not declare it is refused, before the dsh guard can skip it',
    'T2 the DeepSeek Harness capability gate follows the session engine, not the key runtime',
    'T2 the OpenCode and Antigravity gates follow the session engine',
    'T2 an older replica\'s run on the pinned credential takes the task\'s engine pin',
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
    'T2 provider-engine foundation on PostgreSQL',
  ],
};

export const apiCases = {
  'common/cursor-runtime-routing': [
    'P1 cursor is a built-in engine slug, unambiguous since migration 0426, and its guard row is never a provider',
    'P1 a Cursor CLI sign-in session is built for the runner on Cursor CLI alone',
    'P1 Cursor CLI effort values are opaque and the live catalogue decides them',
    'P1 the server admits exactly the Cursor CLI modes the picker calls kept, and defaults to Accept Edits',
  ],
  'runner-api/cursor-runner-gate': [
    'P1 cursor claim requires the request and the persisted heartbeat to declare Cursor CLI',
    'P1 cursor rows on a runner that has not declared Cursor CLI carry the upgrade notice',
    'P1 cursor reclaim withholds Cursor CLI sessions from a runner that has not declared it',
    'P1 the claim statement and the database guard are told whether the runner declared Cursor CLI',
    'P1 cursor heartbeat declarations are exact and an omitted header withdraws them',
  ],
  'sessions/cursor-session-preflight': [
    'P1 cursor preflight: a Cursor CLI session is created only on a runner whose heartbeat declares it',
    'P1 cursor preflight: a new session nobody named a mode for starts in one Cursor CLI keeps',
    'P1 cursor preflight: a mode the caller names has to be one Cursor CLI keeps',
    'P1 cursor preflight: resume and reconfiguration refuse a runner that withdrew the declaration, or a mode Cursor CLI refuses',
    'P1 cursor preflight: a Cursor CLI session does not move to another workspace',
  ],
  // OpenCode: 0080 and its claim guard.
  'queue/opencode-migration-guard': [
    'OpenCode migration permanently reserves a protected compatibility provider row',
    'the provider fence blocks removal/rename without breaking table-wide maintenance',
    'OpenCode migration blocks legacy control-plane claims without a transaction capability',
    'the silent claim skip stays narrowed to PENDING -> RUNNING, on the recorded engine first',
    'OpenCode compatibility provider makes legacy reclaim fail before Claude dispatch',
  ],
  // OpenCode and Antigravity: claim and reclaim gates.
  'runner-api/runner-provider-gate': [
    'legacy claim explains the pending OpenCode stall without stranding other work',
    'an OpenCode-capable runner that does not name Antigravity has its Antigravity rows explained',
    'a Gemini key borrows Antigravity, so a runner that does not name it has that row explained too',
    'a row already carrying the notice is not written again on every long poll',
    'current claim advertises OpenCode and Antigravity directly to the atomic queue gate',
    'legacy reclaim omits OpenCode rows and keeps every other checkout',
    'a capable reclaim keeps the OpenCode row in the snapshot',
    'a reclaim that does not name Antigravity omits its rows and explains the pending ones',
    'a reclaim that does not name Antigravity omits a Gemini key\'s rows too',
    'a capable reclaim keeps the Antigravity row in the snapshot, on its own runtime',
  ],
  // The advertised runtimes.
  'runner-api/runner-provider-support': [
    'runner provider advertisements are exact, normalized, and ignore unknown values',
    'Antigravity is advertised only by a runner that names it',
    'the gated runtimes are exactly the runtimes a legacy runner would start as Claude',
  ],
  // The claim transaction's capability declarations.
  'queue/queue-provider-capability': [
    'the atomic claim selection receives a false OpenCode capability for legacy runners',
    'the atomic claim selection and database guard receive a true OpenCode capability for current runners',
    'a runner that advertises OpenCode but not Antigravity is withheld Antigravity rows',
    'a runner that does not name Antigravity is withheld a Gemini key\'s rows too',
    'the atomic claim selection and database guard admit Antigravity for a runner that names it',
    'a claim clears the upgrade notice of every runtime gate it just passed',
    'P1b dsh queue negotiates transaction gate and clears upgrade notices',
  ],
  // Antigravity: 0367 and its claim guard.
  'queue/antigravity-migration-guard': [
    'Antigravity migration permanently reserves a protected compatibility provider row',
    'the provider fence blocks removal/rename without breaking table-wide maintenance',
    'Antigravity migration blocks legacy control-plane claims without a transaction capability',
    'the silent claim skip stays narrowed to PENDING -> RUNNING, on the recorded engine first',
    'Antigravity compatibility provider makes legacy reclaim fail before Claude dispatch',
    'whatever already held the slug moves aside first, in both halves of the namespace',
    'every stored dispatch reference moves with it',
  ],
  // DeepSeek Harness: the claim, reclaim and notice gates.
  'runner-api/dsh-provider-gate': [
    'P1b dsh claim requires request and persisted heartbeat declarations',
    'P1b dsh reclaim withholds unsupported Harness while retaining legacy checkouts',
    'P1b dsh provider notices distinguish native and legacy colliding identities',
    'P1b dsh heartbeat omission withdraws provider declaration',
  ],
  // DeepSeek Harness: the session preflight.
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
  // DeepSeek Harness: the install gate.
  'queue/dsh-install-gate': [
    'dsh install gate: the engine report decides whether a declaring runner can start dsh',
    'dsh install gate: a declaring runner without the CLI keeps its declaration and the queue is told why it cannot start dsh',
    'dsh install gate: an installed CLI is handed dsh rows, and a runner without the declaration still waits for an upgrade',
    'dsh install gate: the queue holds the runner\'s dsh rows with the notice and leaves its other rows alone',
    'dsh install gate: the claim statement and database guard withhold dsh while the CLI is not ready, and a claim clears the notice',
  ],
  // Engine compatibility: one resolution for every door.
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
    'T3 routing: a run on a key is never moved off its engine by the runner\'s report on its sign-in',
    'T3 quota gate: a run on a key is neither held by the runner report nor blind for want of one',
    'T3 providers: /providers, /providers/mine and /runner/providers carry the engines each key runs on',
    'T3 providers: a DeepSeek key is connection-tested on Anthropic Messages whatever engine it runs on',
    'T3 providers: an older client connecting DeepSeek Harness gets a DeepSeek key, named for the vendor',
  ],
  // Engine compatibility: the recorded session engine.
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
  // The compatibility guard rows.
  'providers/opencode-compatibility-provider': [
    'the guard rows are the OpenCode, Antigravity and Cursor CLI compatibility fences, and only those',
    'provider catalogs hide the OpenCode, Antigravity and Cursor CLI rolling-compatibility rows',
    'legacy custom-provider resolution rejects the OpenCode compatibility ciphertext',
    'legacy custom-provider resolution rejects the Antigravity compatibility ciphertext',
    'legacy custom-provider resolution rejects the Cursor CLI compatibility ciphertext',
  ],
};

export const guardNames = [
  'P1 acceptance guard requires every mandatory shared, PostgreSQL and application scenario',
  'P1 acceptance guard rejects missing, unmatched, skipped, todo and failed scenarios',
  'P1 acceptance guard rejects absent, duplicate and inconsistent summaries',
  'P1 acceptance guard rejects failed, skipped and empty Vitest reports',
  'P1 acceptance guard rejects missing executables and startup failures',
  'P1 acceptance scenario tables name each file once and each scenario once',
];

/** The TAP log run-pg-spec.sh keeps for the n-th spec it is given (1-based). */
export function pgLogName(index, file) {
  return `${index + 1}-${path.basename(file)}.pg.spec.tap`;
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-cursor-engine-'));
  let total = 0;
  try {
    const runTap = (file, names, cwd = root) => {
      assert.ok(existsSync(file), `missing required test file: ${file}`);
      // In-process, so the named cases are visible (Node 26 process isolation can report a file wrapper).
      const output = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], path.join(scratch, 'node.log'), { cwd });
      process.stdout.write(output);
      assertTapResults(output, names);
      total += names.length;
    };
    runTap(path.join(root, 'test/test-cursor-engine.test.mjs'), guardNames);

    for (const [file, names] of Object.entries(sharedCases)) {
      assert.ok(existsSync(path.join(root, 'src/shared', file)), `missing required test file: src/shared/${file}`);
      const report = path.join(scratch, `${path.basename(file)}.json`);
      const output = runLogged(path.join(root, 'node_modules/.bin/vitest'), ['run', file, '--reporter=json', `--outputFile=${report}`],
        path.join(scratch, 'vitest.log'), { cwd: path.join(root, 'src/shared') });
      process.stdout.write(output);
      assertVitestResults(JSON.parse(readFileSync(report, 'utf8')), names);
      for (const name of names) process.stdout.write(`PASS ${name}\n`);
      total += names.length;
    }

    for (const source of [
      ...Object.keys(pgCases).map((file) => `src/apiserver/src/${file}.pg.spec.ts`),
      ...Object.keys(apiCases).map((file) => `src/apiserver/src/${file}.spec.ts`),
    ]) {
      assert.ok(existsSync(path.join(root, source)), `missing required test source: ${source}`);
    }
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
      total += pgCases[file].length;
    });

    // From the test tree run-pg-spec.sh just compiled, in the package directory `npm test` runs them from
    // (the migration guards read prisma/migrations relative to it).
    for (const [file, names] of Object.entries(apiCases)) {
      runTap(path.join(root, `src/apiserver/build/${file}.spec.js`), names, path.join(root, 'src/apiserver'));
    }
    process.stdout.write(`P1 acceptance passed: ${total} named scenarios, none missing, skipped or failing.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();

import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapResults } from './test-dsh-routing.mjs';
import { runLogged } from './test-provider-engine-foundation.mjs';
import { assertNamedWithin } from './test-provider-engine-api.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// The follow-up to T3 of the provider/engine split (docs/provider-engine-contract.md §5.2). Since migration
// 0414 a session with a recorded engine is claimed — PENDING -> RUNNING, or a new inbox lease owner or
// generation — only inside a transaction that declares `orbit.claim_reads_session_engine`: any other claim is
// dropped in silence, or refused. Seven of these PostgreSQL specs claimed sessions by hand without saying so
// (cause A), and steer-dequeue's own session table had no `engine` column for the inbox to read (cause B).
// Every spec runs whole and clean, and the cases 0414 turned red are named — a parent test with the subtests
// that took it down — so a renamed, missing or skipped one is red.
export const claimSpecs = {
  // Cause A: a hand-written claim with no declaration of reading the session engine.
  'src/apiserver/src/projects/project-coordinator-end-to-end.pg.spec.ts': [
    'T8 replays create → auto-dispatch → failed attempt → judgment work → settlement → acceptance',
  ],
  'src/apiserver/src/projects/project-exception-todos.pg.spec.ts': [
    "items opened while the coordinator is down stay the coordinator's, and reach it once a retry brings it back",
    "a queued item turn drained by the coordinator's failed turn is returned, stays the coordinator's, and is queued afresh once it is back",
  ],
  'src/apiserver/src/sessions/auto-retry-startup-failure.pg.spec.ts': [
    'a failure that produced nothing enters the auto-retry ladder',
    '(6) the sweep spends a step and the message goes back out — once',
    '(7) the next failure continues the ladder — one step further out',
  ],
  'src/apiserver/src/sessions/background-wake-steer-retry.pg.spec.ts': [
    "a transient failure of the turn a job's exit was steered into re-sends that turn",
    "the turn a job's exit was steered into fails, the steer written off unread: the retry re-sends that turn",
    "the turn a job's exit was steered into fails after the engine read it: the retry re-sends that turn",
  ],
  'src/apiserver/src/sessions/session-reply-steer.pg.spec.ts': [
    'an outcome handed back to an asker running a turn is written into that turn, and is never lost on the way',
    'a transient failure of the turn a reply steer joined re-sends that turn, and the re-sent turn says the outcome',
  ],
  'src/apiserver/src/sessions/session-request.pg.spec.ts': [
    'a session asks another for a reply, and every request comes to exactly one outcome, handed back once',
    'a reply turn that fails on a transient error is retried as a reply turn, and says its outcome again',
    "a reply turn its run ends with in flight is not taken for read: the asker's next turn says it",
    'a request the auto-retry re-sends goes with it: asked again on the new turn, and not judged while the retry is armed',
    'a failure that produced nothing keeps its request for the retry that re-sends it (§8 criterion 18)',
    'an asker a transient failure stopped with its retry armed has not ended: the outcome waits for the retry, and its task is told nothing',
    'a retry claimed but not yet re-sent still counts as coming (§8 criterion 20)',
    'a re-sent reply turn whose outcome another turn said first is not sent empty',
    'a failure with no echo — Claude’s own delivery failure — is re-sent as itself, and the request goes with it (§8 criterion 23)',
    'the owner takes over from a retry: what was kept for its re-send is settled at once — unread, UNDELIVERED; read, judged as read (§8 criterion 26)',
    'a run that ends with its runner holding a message it never echoed: the retry re-sends that message with its request, and one it cannot find is UNDELIVERED at once (§8 criterion 27)',
    'what a run’s end keeps for the retry is what the retry re-sends: a message echoed and put back, and a steer put back unread (§8 criteria 18, 26, 27)',
  ],
  'src/apiserver/src/tasks/task-source-refusal-visible.pg.spec.ts': [
    '(a) a start whose integration line does not exist is refused at resolution, recorded on the task, and delivered to the coordinator naming the task',
    "(b) a start whose line exists and holds the prerequisite's work resolves normally, and leaves no refusal and no delivery",
    '(c) the same refusal reported twice leaves one fact: a lost compare-and-set records nothing',
    'a refused resolution under a switched-off coordinator is recorded on the task and wakes nobody',
  ],
  // Cause B: a schema of its own whose session table had no `engine` column, which the inbox reads.
  'src/apiserver/src/runner-api/steer-dequeue.pg.spec.ts': [
    'a steer is handed over mid-turn while the message behind it keeps waiting',
    'explicit CURRENT_WORK is exact-targeted and may still be filed back if never read',
    'old poller still dequeues legacy Claude steer but withholds explicit CURRENT_WORK',
    'a steer waits while nothing is running, and the ordinary message goes first',
    'an expired lease is not a running turn, so a steer stays put',
    'a `!cmd` shell turn is not an engine turn, so a steer does not ride along with it',
    'a delivered steer is never leased a second time',
    'an interrupt still overtakes a steer',
    'the interrupt goes first and its follow-up waits for the turn it is replacing',
    'the follow-up is handed over once the interrupted turn is out of flight',
    'a follow-up filed as an ordinary message can never ride into the running turn',
    'a poller that does not know the kind is handed no steer, and the queue is not stuck on it',
    'a codex steer waits for a poller that can deliver one, and is not lost meanwhile',
    'a claude steer is never gated on the codex declaration',
    'withholding a codex steer withholds nothing else on that session',
    'withholding a steer does not withhold anything else',
    'a re-filed steer is handed over as an ordinary message once its turn ends',
    'a steer stranded by a dead runner is never handed to the next one',
    'a setconfig lands mid-turn, while the reload of the same session waits',
    'an effort change is handed over in the same poll, mid-turn, like the rest of its kind',
    'a reload sent during the same running turn stays queued until that turn is over',
    'a setconfig takes no slot: the message queued behind it still goes next',
    'one patch that moved both halves is handed over setconfig first, reload after',
    'a setconfig abandoned by a dead runner is re-delivered, unlike a steer',
    'an interrupt still overtakes a setconfig',
  ],
};

export const guardNames = [
  'claims acceptance guard names the eight specs and the cases 0414 turned red in each',
  'claims acceptance guard requires every named case once, in a spec that ran clean',
  'claims acceptance guard rejects skips todos failures and wrapper-only TAP',
  'claims acceptance guard rejects missing executables and startup failures',
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-provider-engine-claims-'));
  const summary = [];
  try {
    // Serial in-process execution exposes the named cases; the validators reject a wrapper-only result.
    const guard = runLogged(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', path.join(root, 'test/test-provider-engine-claims.test.mjs')], path.join(scratch, 'guard.log'));
    process.stdout.write(guard);
    assertTapResults(guard, guardNames);
    summary.push(['guard', guardNames.length]);

    const sources = Object.keys(claimSpecs);
    for (const source of sources) assert.ok(existsSync(path.join(root, source)), `missing required test source: ${source}`);
    // The Prisma engine is looked up in node_modules, which a fresh worktree does not have until
    // scripts/worktree-overlay.sh lays them out: lay them out first (run-pg-spec.sh runs it again and finds
    // them in place).
    process.stdout.write(runLogged('bash', ['scripts/worktree-overlay.sh'], path.join(scratch, 'overlay.log'), { timeout: 900_000 }));
    // One server, one migrated template, a database per spec (scripts/run-pg-spec.sh), every case by name.
    const output = runLogged('bash', ['scripts/run-pg-spec.sh', ...sources], path.join(scratch, 'postgres.log'), {
      env: { ...await prismaEngineEnvironment(), RUN_PG_SPEC_LOG_DIR: scratch, RUN_PG_SPEC_TEST_ISOLATION: 'none' },
      timeout: 2_700_000,
    });
    process.stdout.write(output);
    for (const [index, source] of sources.entries()) {
      const log = path.join(scratch, `${index + 1}-${path.basename(source, '.ts')}.tap`);
      assert.ok(existsSync(log), `PostgreSQL runner produced no log for ${source}`);
      summary.push([`postgres ${path.basename(source)}`, assertNamedWithin(readFileSync(log, 'utf8'), claimSpecs[source], source)]);
    }

    for (const [label, count] of summary) process.stdout.write(`PASS ${label}: ${count}\n`);
    const named = Object.values(claimSpecs).flat().length;
    process.stdout.write(`Provider-engine claims acceptance passed: all ${sources.length} specs ran clean, and the ${named} cases migration 0414 turned red passed by name, none missing or skipped.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcceptance();

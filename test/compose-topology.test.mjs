// The deployment topology this repository is allowed to run.
//
// The account owner removed the four sidecars (watchdog, both outcome-coordinator peers and the
// executable dead-man) from Compose on 2026-09-01, taking the stack from nine services to five.
// Two of those services also carried a production hazard this file fences off: postgres bind-mounts
// a RELATIVE ./data/postgres path and gateway a relative ./gateway/nginx.conf, so an edit to either
// block — or a Compose run from a worktree — has already once replaced the live database with an
// empty one. Both blocks are therefore compared byte-for-byte against fixed historical commits,
// not merely inspected for shape. The removal proof and later approved configuration stay separate.
//
// On 2026-10-07 the account owner approved one service back: wiki-worker, the wiki's server-side executor
// (docs/wiki-server-execution-design.md §4.1, project 34bmzOkov3xN2yLPrnsCk). It runs the apiserver's image
// with another entry point, serves no port, mounts nothing and runs no migration, and it is the only
// service given the System model's address and key. The stack is therefore six services: the five
// survivors, which every guard below still holds exactly as before, and this one, whose whole definition
// is pinned by (l) below. Any other addition is still what (a) and (c) exist to refuse.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = 'docker-compose.yml';

// The commit the sidecar removal was based on: nine services, all four sidecars present. Keep this
// pin: it proves the removal and still fences gateway, whose definition has not changed.
const BASELINE_SHA = 'ac1b16e752fb11c7230052e5c7ffbbc0096e3e22';

// Fixed configuration after the approved PG timeout change landed on main, not HEAD or the file
// being tested. The complete Compose history from BASELINE_SHA accounts for these later changes:
// 7334a09c: obsolete apiserver env removed; 5969060e: web comment only.
// ef932ff2: Watch env; edc0bba9: Wiki env; 1c241c89: both read the host's *_MODE names.
// fea8580c: apiserver PUBLIC_ORIGIN forwarding.
// c8ba68cd: pg_stat_statements preload/max/track and log_temp_files=1024.
// 4d443784: logging (already normalized below).
// 030ca7f9, merged by this pin: statement_timeout=300s, lock_timeout=30s and
// idle_in_transaction_session_timeout=300s. docs/postgres-runtime-settings.md records approval;
// work_mem and shared_buffers were NOT changed. New settings still require an explicit review.
const CONFIGURATION_SHA = '0022dd5f9f8c6b3dae4f0a625509e2b48ef24c37';

// a68a3fe8 adds exactly four apiserver FCM env forwards after CONFIGURATION_SHA, and was merged
// into main by 4652d58d. Pin its definitions for pgbackup/apiserver/web; postgres keeps its earlier
// approved configuration and gateway keeps the removal baseline. No FCM prefix is exempted.
const SURVIVING_CONFIGURATION_SHA = 'a68a3fe8774e4f181b9584443bfaeb1dca39547e';

const EXPECTED_SERVICES = ['postgres', 'pgbackup', 'apiserver', 'web', 'gateway'];
// Added by the account owner on 2026-10-07 (see the top of this file), after every pinned commit above.
const WIKI_WORKER = 'wiki-worker';
const APPROVED_ADDITIONS = [WIKI_WORKER];
const REMOVED_SERVICES = [
  'watchdog', 'outcome-coordinator', 'outcome-coordinator-secondary', 'executable-dead-man',
];

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

const current = readFileSync(path.join(repo, COMPOSE), 'utf8');
const baseline = git('show', `${BASELINE_SHA}:${COMPOSE}`);
const configuration = git('show', `${CONFIGURATION_SHA}:${COMPOSE}`);
const survivingConfiguration = git('show', `${SURVIVING_CONFIGURATION_SHA}:${COMPOSE}`);

/**
 * Split a Compose document into its top-level `services:` blocks, in file order. Blank lines and
 * top-level comments trailing a block introduce the NEXT service, so they are dropped rather than
 * attributed to the previous one — otherwise removing a service would look like an edit to the
 * service that happened to precede it.
 */
function services(source) {
  const body = source.match(/^services:\n([\s\S]*?)(?=^\S|\Z)/m)?.[1] ?? '';
  const blocks = new Map();
  let name = null;
  let lines = [];
  const close = () => {
    while (lines.length && /^( {2}#|\s*$)/.test(lines[lines.length - 1])) lines.pop();
    blocks.set(name, lines.join('\n'));
  };
  for (const line of body.split('\n')) {
    const header = line.match(/^ {2}([a-z][a-z0-9_-]*):$/);
    if (header) {
      if (name) close();
      name = header[1];
      lines = [line];
    } else if (name) {
      lines.push(line);
    }
  }
  if (name) close();
  return blocks;
}

// Log rotation is the one line every service gained in 4d443784, on purpose: an uncapped
// json-file log is how orbit-gateway's access log reached 1GB. It sets a driver option, not a mount
// or a process, so it is set aside before any comparison below rather than moving the pin.
const LOGGING = '    logging: *logging';
const withoutLogging = (block) => block.split('\n').filter((line) => line !== LOGGING).join('\n');

const currentServices = new Map(
  [...services(current)].map(([name, block]) => [name, withoutLogging(block)]));
const baselineServices = services(baseline);
const configurationServices = new Map(
  [...services(configuration)].map(([name, block]) => [name, withoutLogging(block)]));
const survivingConfigurationServices = new Map(
  [...services(survivingConfiguration)].map(([name, block]) => [name, withoutLogging(block)]));

test('the baseline commit really is the nine-service stack this change removes from', () => {
  assert.deepEqual([...baselineServices.keys()],
    [...EXPECTED_SERVICES.slice(0, 3), ...REMOVED_SERVICES, ...EXPECTED_SERVICES.slice(3)]);
});

test('the approved configuration commits still have exactly the five surviving services', () => {
  assert.deepEqual([...configurationServices.keys()], EXPECTED_SERVICES);
  assert.deepEqual([...survivingConfigurationServices.keys()], EXPECTED_SERVICES);
});

test('(a) Compose declares exactly the five surviving services and the wiki worker', () => {
  assert.deepEqual([...currentServices.keys()].sort(), [...EXPECTED_SERVICES, ...APPROVED_ADDITIONS].sort());
  assert.equal(currentServices.size, 6);
});

test('(b) no removed sidecar is named anywhere in Compose', () => {
  for (const removed of REMOVED_SERVICES) {
    assert.equal(current.includes(removed), false,
      `docker-compose.yml still mentions ${removed}`);
  }
});

test('(c) nothing was added back: no new service, no new always-on process, no init job', () => {
  // Every surviving service already existed at the baseline — a replacement observer cannot hide
  // behind a new name. The one exception is the service the owner added on 2026-10-07, by its name.
  for (const name of currentServices.keys()) {
    if (APPROVED_ADDITIONS.includes(name)) continue;
    assert.ok(baselineServices.has(name), `${name} is a service the baseline did not have`);
  }
  const alwaysOn = (blocks) => [...blocks]
    .filter(([, block]) => /^\s+restart: unless-stopped$/m.test(block))
    .map(([name]) => name);
  // No resident process beyond the ones the five surviving services already ran, and the wiki worker:
  // a resident process too (restart: unless-stopped), which is what the owner approved.
  assert.deepEqual(alwaysOn(currentServices).sort(),
    [...alwaysOn(baselineServices).filter((name) => currentServices.has(name)), ...APPROVED_ADDITIONS].sort());
  // No one-shot substitute: nothing may declare a run-once profile or a restart policy that
  // re-runs a job, and no service may be introduced solely to be `docker compose run`.
  assert.doesNotMatch(current, /^\s+profiles:/m);
  assert.doesNotMatch(current, /^\s+restart: (on-failure|always)$/m);
  assert.doesNotMatch(current, /\bexecutable-acceptance-dead-man\b/);
});

test('(i) the postgres service definition matches the approved configuration, byte for byte', () => {
  assert.equal(currentServices.get('postgres'), configurationServices.get('postgres'));
  // The bind mount whose relative path once served production an empty database.
  assert.match(currentServices.get('postgres'), /- \.\/data\/postgres:\/var\/lib\/postgresql\/data/);
});

test('(j) the gateway service definition is unchanged and still mounts ./gateway/nginx.conf', () => {
  assert.equal(currentServices.get('gateway'), baselineServices.get('gateway'));
  assert.match(currentServices.get('gateway'),
    /- \.\/gateway\/nginx\.conf:\/etc\/nginx\/conf\.d\/default\.conf:ro/);
});

/** What Compose acts on: comments and blank lines document a block, they cannot run a process. */
function directives(block) {
  return block.split('\n').filter((line) => !/^\s*(#|$)/.test(line));
}

/**
 * The directives of a service block the baseline block does not account for. Both are walked in
 * order, each directive claiming the earliest baseline line that still matches it, so a directive
 * the current block no longer has just moves the pointer along and costs nothing, while one that is
 * added, duplicated, or moved earlier in the block finds nothing left to claim. An unmatched
 * directive leaves the pointer where it was, so a single addition is reported as a single line.
 */
function directivesNotInBaseline(block, baselineBlock) {
  const baselineLines = directives(baselineBlock);
  const unaccounted = [];
  let i = 0;
  for (const line of directives(block)) {
    const at = baselineLines.indexOf(line, i);
    if (at === -1) unaccounted.push(line);
    else i = at + 1;
  }
  return unaccounted;
}

// Unlike postgres and gateway, these three carry no relative bind mount to fence off, so the
// guarantee here is one-directional on purpose: nothing beyond the fixed configuration may be
// added to a surviving service, while
// a directive the repository has genuinely stopped needing is free to leave and the prose around
// it is free to be rewritten. Byte equality made both of those look like the thing this file exists
// to catch, and left this test red on main: 7334a09c dropped a rollout-gate env the apiserver had
// stopped reading, and 5969060e reworded a comment in web. Neither can start a resident observer,
// which is the one thing being fenced off here.
//
// That env is cited by its SHA rather than spelled out on purpose. 0225's removal census
// (src/apiserver/src/sessions/session-current-work-startup-removal.spec.ts, case (c)) asserts the
// repository holds no mention of that identifier outside the migration that dropped it, and it
// cannot tell a READER of the flag from prose about its removal — which is exactly why it carves
// out the migration's own comment. Naming it here put main's only red on the board.
//
// The one exception is the wiki executor switch (docs/wiki-server-execution-design.md §2.1 and §10, P3,
// 2026-10-08): two variables the apiserver and the wiki worker both read, defaulting to the path that has
// always run. They are listed here as directives — comments explaining them do not count — so a line added
// anywhere else still turns this red exactly as it did before.
const APPROVED_APISERVER_ADDITIONS = [
  '      ORBIT_WIKI_EXECUTOR: "${ORBIT_WIKI_EXECUTOR:-runner}"',
  '      ORBIT_WIKI_EXECUTOR_CANARY_OWNERS: "${ORBIT_WIKI_EXECUTOR_CANARY_OWNERS:-}"',
];
test('nothing beyond the approved configuration was added to pgbackup, apiserver or web', () => {
  for (const name of ['pgbackup', 'apiserver', 'web']) {
    assert.deepEqual(
      directivesNotInBaseline(currentServices.get(name), survivingConfigurationServices.get(name)),
      name === 'apiserver' ? APPROVED_APISERVER_ADDITIONS : [],
      `${name} declares something the baseline did not: adding to a surviving service is forbidden`);
  }
});

/**
 * `source` without the service `name` and the comment lines that introduce it, as the file read before
 * that service was added: the blank line before its comment stays, the one after its block goes.
 */
function withoutService(source, name) {
  const lines = source.split('\n');
  const header = lines.indexOf(`  ${name}:`);
  assert.ok(header > 0, `docker-compose.yml has no ${name} service`);
  let from = header;
  while (/^ {2}#/.test(lines[from - 1])) from -= 1;
  let to = header + 1;
  while (to < lines.length && !/^ {0,2}\S/.test(lines[to])) to += 1;
  return [...lines.slice(0, from), ...lines.slice(to)].join('\n');
}

/**
 * `source` without the approved additions to a surviving service and the comment block that introduces
 * them, the way `withoutService` sets the wiki worker aside: (k) proves what the SIDECAR REMOVAL did, and
 * a pinned addition explained by five lines of prose must not move that proof by six. Everything else in
 * the file still weighs in, so a line added anywhere unapproved still turns this red.
 */
function withoutApprovedAdditions(source) {
  const lines = source.split('\n');
  const first = lines.indexOf(APPROVED_APISERVER_ADDITIONS[0]);
  assert.ok(first > 0, 'docker-compose.yml no longer has the approved executor switch');
  const last = lines.lastIndexOf(APPROVED_APISERVER_ADDITIONS[APPROVED_APISERVER_ADDITIONS.length - 1]);
  let from = first;
  while (from > 0 && /^\s*#/.test(lines[from - 1])) from -= 1;
  return [...lines.slice(0, from), ...lines.slice(last + 1)].join('\n');
}

// The sidecar removal stays subtraction. The wiki worker the owner added on 2026-10-07 is a service of
// its own, whose every line (l) pins, and the executor switch added on 2026-10-08 is pinned beside it;
// both are set aside here, so that a line added anywhere else still turns this red exactly as it did
// before those decisions.
test('(k) removing the sidecars is subtraction: setting the approved wiki worker aside, Compose lost more lines than it gained', () => {
  const rest = withoutApprovedAdditions(withoutService(current, WIKI_WORKER));
  const scratch = mkdtempSync(path.join(tmpdir(), 'compose-topology-'));
  try {
    writeFileSync(path.join(scratch, 'baseline.yml'), baseline);
    writeFileSync(path.join(scratch, 'current.yml'), rest);
    // --no-index exits 1 when the files differ, which they do: read its output, not its status.
    const diff = spawnSync('git', ['diff', '--no-index', '--numstat', 'baseline.yml', 'current.yml'],
      { cwd: scratch, encoding: 'utf8' });
    assert.ok([0, 1].includes(diff.status), diff.stderr);
    const [added, deleted] = diff.stdout.trim() ? diff.stdout.trim().split(/\s+/).map(Number) : [0, 0];
    assert.ok(deleted > added, `docker-compose.yml, less the wiki worker, added ${added} and deleted ${deleted} lines`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.ok(rest.split('\n').length < baseline.split('\n').length);
  // And only the wiki worker and the approved additions were set aside: every other service — the
  // apiserver's own added lines are what the test above pins, line by line — reads exactly as it does in
  // the file, so this test cannot pass by quietly rewriting something else.
  const aside = services(withoutService(current, WIKI_WORKER));
  assert.deepEqual(
    new Map([...services(rest)].filter(([name]) => name !== 'apiserver')),
    new Map([...aside].filter(([name]) => name !== 'apiserver' && name !== WIKI_WORKER)));
});

// The definition the owner approved on 2026-10-07 (docs/wiki-server-execution-design.md §4.1), every
// directive of it in order: the apiserver's image with the worker's entry point, no port, no mount, no
// build of its own, no migration — it waits for the apiserver, which applies them — and the System
// model's four variables. Changing any of it is a new decision, made here. The executor switch's two
// variables joined it on 2026-10-08 (P3, §2.1): the same pair the apiserver reads, so the process that
// queues a job and the one that runs it decide the same about an account, defaulting to runner.
test('(l) the wiki worker is exactly the service the owner approved on 2026-10-07', () => {
  assert.deepEqual(directives(currentServices.get(WIKI_WORKER)), [
    '  wiki-worker:',
    '    image: orbit-apiserver:local',
    '    container_name: orbit-wiki-worker',
    '    restart: unless-stopped',
    '    command: node src/apiserver/dist/wiki-worker/main.js',
    '    stop_grace_period: 30s',
    '    environment:',
    '      DATABASE_URL: "postgresql://orbit:orbit@postgres:5432/orbit?schema=public"',
    '      ORBIT_WIKI_MODEL_BASE_URL: "${ORBIT_WIKI_MODEL_BASE_URL:-}"',
    '      ORBIT_WIKI_MODEL_API_KEY: "${ORBIT_WIKI_MODEL_API_KEY:-}"',
    '      ORBIT_WIKI_MODEL: "${ORBIT_WIKI_MODEL:-}"',
    '      ORBIT_WIKI_MODEL_CONCURRENCY: "${ORBIT_WIKI_MODEL_CONCURRENCY:-4}"',
    '      ORBIT_WIKI_EXECUTOR: "${ORBIT_WIKI_EXECUTOR:-runner}"',
    '      ORBIT_WIKI_EXECUTOR_CANARY_OWNERS: "${ORBIT_WIKI_EXECUTOR_CANARY_OWNERS:-}"',
    '    depends_on:',
    '      apiserver:',
    '        condition: service_healthy',
  ]);
});

test('(l) the System model\'s address and key are given to the wiki worker and to no other service', () => {
  for (const [name, block] of currentServices) {
    const given = directives(block).join('\n').match(/\bORBIT_WIKI_MODEL(?:_[A-Z]+)*\b/g) ?? [];
    if (name === WIKI_WORKER) assert.equal(new Set(given).size, 4, `${name} lacks a System model variable`);
    else assert.deepEqual(given, [], `${name} is given the System model's ${given.join(', ')}`);
  }
  // None of them is a name an agent session carries: Compose prefers the shell's environment to .env.
  assert.doesNotMatch(directives(currentServices.get(WIKI_WORKER)).join('\n'), /ANTHROPIC_/);
});

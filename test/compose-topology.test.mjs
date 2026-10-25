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
//
// On 2026-10-17 the account owner decided that a new deployment runs managed runners on this host's Docker
// (project 34ZteKCnYMpKY46f63Leb, second phase): root Compose may carry what the Docker backend needs, its
// services in a Compose profile that is off by default and that a fresh install switches on, and nothing of
// Kubernetes, Rook, Ceph or CSI. That is one more service, docker-channel — the restricted Docker channel,
// the only holder of the Docker socket — whose whole definition (m) pins, and four lines of the apiserver's,
// pinned below. An existing deployment's .env names neither, so it runs the same six services as before,
// its apiserver with the switch off.
//
// On 2026-10-19 the account owner decided that a fresh install also firewalls the managed runners' network on the
// host, the rules applied again after Docker or the host restarts, unless the deployer turns that off (ask_owner
// 34hXDEryfBDt3Dq5b95wD; task D9, 34iSiGtPrJ0LWSqn17esR). That is one more service, managed-runner-firewall: the host's
// network and NET_ADMIN, never the Docker socket, under a profile of its own that only the install switches on, whose
// whole definition (n) pins. A deployment whose .env does not name that profile, every one installed before it
// included, runs exactly what it ran.
//
// On 2026-10-25 the runner link's connection tokens (project 34bc0CsOzPh9KshG7H3DW, task A3, whose plan the account
// owner confirmed; its coordinator approved this pin) added three lines to the apiserver's environment: the token
// signing key, the gateway's address and the gateway's secret, each empty unless the host's .env sets it. No service,
// mount or port is added, and a deployment whose .env names none of them runs with the link off, as before.
//
// On 2026-10-25 the runner link's gateway (project 34bc0CsOzPh9KshG7H3DW, task A4, of the plan the account owner
// confirmed: design D1 and section 11.5 put the gateway in Compose, its coordinator filed the service) added one more
// service, link-gateway: the WebSocket endpoint runners connect to directly, on a port of its own. It is given the token
// signing key's public half and the gateway's secret, never the signing key itself, and no database, Docker socket or
// host network, under a profile of its own that no install switches on, whose whole definition (o) pins. A deployment
// whose .env does not name that profile runs exactly what it ran.
//
// On 2026-10-25 the runner link's hints (project 34bc0CsOzPh9KshG7H3DW, task B1, of the plan the account owner confirmed:
// design section 6.3 puts NATS beside the gateway and section 11.5 in Compose; its coordinator approved this pin) added one
// more service, nats: core NATS with no JetStream, no volume and no port on the host, run from flags alone so that the
// image's own configuration file never opens its cluster port, under the gateway's runner-link profile, whose whole
// definition (p) pins. The gateway gains the line naming it, and the apiserver one line of its environment: where it
// publishes the hints, read only while the link is configured. A deployment whose .env names neither the profile nor the
// link runs exactly what it ran, and its apiserver connects to nothing.
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

// e223d8ee adds exactly one postgres directive after CONFIGURATION_SHA, shm_size: "256m", and the six
// comment lines that explain it: Docker's default 64MB /dev/shm made a manual VACUUM die with ENOSPC on
// 2026-10-09. docs/postgres-runtime-settings.md §9 records the account owner's approval. Postgres alone
// is compared with this pin; every other service keeps the pin it had. New settings still require an
// explicit review.
const POSTGRES_CONFIGURATION_SHA = 'e223d8eede64cb71bb6efa5cf712b96f3b3af79b';

const EXPECTED_SERVICES = ['postgres', 'pgbackup', 'apiserver', 'web', 'gateway'];
// Added by the account owner on 2026-10-07 (see the top of this file), after every pinned commit above.
const WIKI_WORKER = 'wiki-worker';
// Decided by the account owner on 2026-10-17 (see the top of this file): started only under its profile.
const DOCKER_CHANNEL = 'docker-channel';
const MANAGED_RUNNERS_PROFILE = 'managed-runners-docker';
// Decided by the account owner on 2026-10-19 (see the top of this file): started only under its own profile.
const MANAGED_RUNNER_FIREWALL = 'managed-runner-firewall';
const FIREWALL_PROFILE = 'managed-runner-firewall';
// Added by the runner link project on 2026-10-25 (see the top of this file): started only under its own profile.
const LINK_GATEWAY = 'link-gateway';
const LINK_PROFILE = 'runner-link';
// Added by the runner link project on 2026-10-25 (see the top of this file): started only under the gateway's profile.
const NATS = 'nats';
const APPROVED_ADDITIONS = [WIKI_WORKER, DOCKER_CHANNEL, MANAGED_RUNNER_FIREWALL, LINK_GATEWAY, NATS];
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
const postgresConfiguration = git('show', `${POSTGRES_CONFIGURATION_SHA}:${COMPOSE}`);

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
const postgresConfigurationServices = new Map(
  [...services(postgresConfiguration)].map(([name, block]) => [name, withoutLogging(block)]));

test('the baseline commit really is the nine-service stack this change removes from', () => {
  assert.deepEqual([...baselineServices.keys()],
    [...EXPECTED_SERVICES.slice(0, 3), ...REMOVED_SERVICES, ...EXPECTED_SERVICES.slice(3)]);
});

test('the approved configuration commits still have exactly the five surviving services', () => {
  assert.deepEqual([...configurationServices.keys()], EXPECTED_SERVICES);
  assert.deepEqual([...survivingConfigurationServices.keys()], EXPECTED_SERVICES);
});

test('(a) Compose declares exactly the five surviving services, the wiki worker, the Docker channel, the managed runners\' firewall, the runner link gateway and its NATS', () => {
  assert.deepEqual([...currentServices.keys()].sort(), [...EXPECTED_SERVICES, ...APPROVED_ADDITIONS].sort());
  assert.equal(currentServices.size, 10);
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
  // No resident process beyond the ones the five surviving services already ran, the wiki worker and
  // the Docker channel: resident processes too (restart: unless-stopped), which is what the owner approved.
  assert.deepEqual(alwaysOn(currentServices).sort(),
    [...alwaysOn(baselineServices).filter((name) => currentServices.has(name)), ...APPROVED_ADDITIONS].sort());
  // No one-shot substitute: nothing may declare a run-once profile or a restart policy that
  // re-runs a job, and no service may be introduced solely to be `docker compose run`. The three
  // profiles are the Docker channel's, the managed runners' firewall's and the runner link's, which the gateway
  // and its NATS share, and they keep each off where a deployment's .env does not name it.
  const profiled = [...currentServices]
    .filter(([, block]) => /^\s+profiles:/m.test(block))
    .map(([name, block]) => [name, block.match(/^\s+profiles:.*$/gm)]);
  assert.deepEqual(profiled, [
    [DOCKER_CHANNEL, [`    profiles: [${MANAGED_RUNNERS_PROFILE}]`]],
    [MANAGED_RUNNER_FIREWALL, [`    profiles: [${FIREWALL_PROFILE}]`]],
    [LINK_GATEWAY, [`    profiles: [${LINK_PROFILE}]`]],
    [NATS, [`    profiles: [${LINK_PROFILE}]`]],
  ]);
  assert.equal(current.match(/^\s+profiles:/gm).length, 4);
  assert.doesNotMatch(current, /^\s+restart: (on-failure|always)$/m);
  assert.doesNotMatch(current, /\bexecutable-acceptance-dead-man\b/);
});

test('(i) the postgres service definition matches the approved configuration, byte for byte', () => {
  assert.equal(currentServices.get('postgres'), postgresConfigurationServices.get('postgres'));
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
// The exception is an approved block of the apiserver's. It is listed here as directives — comments
// explaining it do not count — so a line added anywhere else still turns this red exactly as it did before.
const APPROVED_APISERVER_BLOCKS = [
  // The runner link's connection tokens (2026-10-25, the top of this file): the Ed25519 signing key, the link
  // gateway's address and the secret the gateway reads revocations with, each empty unless the host's .env sets it.
  // Listed first because the lines come before the managed runners' in the file.
  [
    '      RUNNER_LINK_SIGNING_KEY: "${RUNNER_LINK_SIGNING_KEY:-}"',
    '      RUNNER_LINK_URL: "${RUNNER_LINK_URL:-}"',
    '      RUNNER_LINK_GATEWAY_TOKEN: "${RUNNER_LINK_GATEWAY_TOKEN:-}"',
  ],
  // The runner link's hints (2026-10-25, the top of this file): where the apiserver publishes them, the nats service unless
  // the host's .env names another server, and read only while the link above is configured. It comes after the link's
  // lines in the file, and before the managed runners'.
  [
    '      RUNNER_LINK_NATS_URL: "${RUNNER_LINK_NATS_URL:-nats://nats:4222}"',
  ],
  // Managed runners on this host's Docker (2026-10-17, the top of this file): the switch, off unless the
  // host's .env says true; the profile's fixed path; and the directory holding the profile and the Docker
  // channel's token and socket, read-only, with /dev/null standing in where .env names none, so that an
  // existing deployment gains nothing on its disk.
  [
    '      ORBIT_MANAGED_RUNNERS_ENABLED: "${ORBIT_MANAGED_RUNNERS_ENABLED:-false}"',
    '      ORBIT_MANAGED_RUNNERS_PROFILE: /var/lib/orbit-managed-runners/profile.json',
    '    volumes:',
    '      - "${ORBIT_MANAGED_RUNNERS_DIR:-/dev/null}:/var/lib/orbit-managed-runners:ro"',
  ],
];
const APPROVED_APISERVER_ADDITIONS = APPROVED_APISERVER_BLOCKS.flat();
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
 * `source` without the approved additions to a surviving service and the comment blocks that introduce
 * them, the way `withoutService` sets the wiki worker aside: (k) proves what the SIDECAR REMOVAL did, and
 * a pinned addition explained by five lines of prose must not move that proof by six. Each block is set
 * aside on its own, and holds exactly its pinned directives, so everything else in the file still weighs
 * in: a line added anywhere unapproved still turns this red.
 */
function withoutApprovedAdditions(source) {
  let lines = source.split('\n');
  for (const block of APPROVED_APISERVER_BLOCKS) {
    const first = lines.indexOf(block[0]);
    assert.ok(first > 0, `docker-compose.yml no longer has the approved ${block[0].trim()}`);
    const last = lines.indexOf(block[block.length - 1], first);
    assert.ok(last >= first, `docker-compose.yml no longer ends the approved block with ${block[block.length - 1].trim()}`);
    assert.deepEqual(directives(lines.slice(first, last + 1).join('\n')), block);
    let from = first;
    while (from > 0 && /^\s*#/.test(lines[from - 1])) from -= 1;
    lines = [...lines.slice(0, from), ...lines.slice(last + 1)];
  }
  return lines.join('\n');
}

// The sidecar removal stays subtraction. The wiki worker the owner added on 2026-10-07 and the Docker
// channel of 2026-10-17 are services of their own, whose every line (l) and (m) pin, and the apiserver's
// approved blocks are pinned beside them; all are set aside here, so that a line added anywhere else still
// turns this red exactly as it did before those decisions.
test('(k) removing the sidecars is subtraction: setting the approved wiki worker aside, Compose lost more lines than it gained', () => {
  const rest = withoutApprovedAdditions(withoutService(withoutService(
    withoutService(withoutService(withoutService(current, WIKI_WORKER), DOCKER_CHANNEL), MANAGED_RUNNER_FIREWALL),
    LINK_GATEWAY), NATS));
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
  // And only the two approved services and the approved additions were set aside: every other service —
  // the apiserver's own added lines are what the test above pins, line by line — reads exactly as it does in
  // the file, so this test cannot pass by quietly rewriting something else.
  assert.deepEqual(
    new Map([...services(rest)].filter(([name]) => name !== 'apiserver')),
    new Map([...services(current)].filter(([name]) => !['apiserver', ...APPROVED_ADDITIONS].includes(name))));
});

// The definition the owner approved on 2026-10-07 (docs/wiki-server-execution-design.md §4.1), every
// directive of it in order: the apiserver's image with the worker's entry point, no port, no mount, no
// build of its own, no migration — it waits for the apiserver, which applies them — and the System
// model's four variables. Changing any of it is a new decision, made here.
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

// The definition the owner's decision of 2026-10-17 allows (see the top of this file), every directive of it in
// order: the restricted Docker channel built from its own Dockerfile, under the one profile a fresh install switches
// on, with no network, no port and two mounts — the Docker socket, which no other service is given, and the managed
// runners' directory it shares with the apiserver. Changing any of it is a new decision, made here.
//
// Amended on 2026-10-17 for task D8 (34hXCWEWAgHqtrxZsMBOh) of the same project, filed from D5's finding that the
// storage budget measured the disk under the managed runners' directory instead of the one Docker's volumes live on:
// a third mount, an anonymous volume, read-only, which Docker keeps beside every runner's data volume, and the command
// naming it to the channel as the disk to measure. The channel gains no write access and no view of Docker's data
// root, and nothing is declared outside this service, so a deployment without the profile has nothing new.
test('(m) the Docker channel is exactly the service the owner allowed on 2026-10-17, off unless its profile is on', () => {
  assert.deepEqual(directives(currentServices.get(DOCKER_CHANNEL)), [
    '  docker-channel:',
    `    profiles: [${MANAGED_RUNNERS_PROFILE}]`,
    '    build:',
    '      context: .',
    '      dockerfile: deploy/managed-runner/docker-channel/Dockerfile',
    '    image: orbit-docker-channel:local',
    '    container_name: orbit-docker-channel',
    '    restart: unless-stopped',
    '    network_mode: none',
    '    command: ["serve", "--config", "/var/lib/orbit-managed-runners/channel.json", "--disk-probe-path", "/var/lib/orbit-docker-volumes"]',
    '    volumes:',
    '      - /var/run/docker.sock:/var/run/docker.sock',
    '      - "${ORBIT_MANAGED_RUNNERS_DIR:-/dev/null}:/var/lib/orbit-managed-runners"',
    '      - type: volume',
    '        target: /var/lib/orbit-docker-volumes',
    '        read_only: true',
    '    healthcheck:',
    '      test: ["CMD", "python3", "-c", "import socket; socket.socket(socket.AF_UNIX).connect(\'/var/lib/orbit-managed-runners/channel.sock\')"]',
    '      interval: 5s',
    '      timeout: 5s',
    '      retries: 6',
    '      start_period: 10s',
  ]);
});

test('(m) Docker\'s socket is given to the Docker channel and to no other service', () => {
  for (const [name, block] of currentServices) {
    const given = directives(block).filter((line) => line.includes('docker.sock'));
    assert.deepEqual(given, name === DOCKER_CHANNEL ? ['      - /var/run/docker.sock:/var/run/docker.sock'] : [],
      `${name} is given the Docker socket`);
  }
});

test('(m) Compose names nothing of Kubernetes, Rook, Ceph or CSI', () => {
  assert.doesNotMatch(directives(current).join('\n'),
    /kube|rook|ceph|\bcsi\b|deploy\/managed-runner\/(?!docker-channel\/|firewall\/)|runner-pod|pod-admission|managed-runner-lab/i);
});

// The definition the owner's decision of 2026-10-19 allows (see the top of this file), every directive of it in order:
// the managed runners' host firewall built from its own Dockerfile, under the one profile the install switches on for
// it, in the host's network namespace — where the rules it keeps live — with every capability dropped but NET_ADMIN
// and NET_RAW, no privilege escalation and a read-only root filesystem. Two mounts: its directory in the managed
// runners' (its configuration, and the status the Docker channel reads), and the host's xtables lock, which only the
// legacy iptables backend takes, /dev/null unless the install names it and never made on the host. No Docker socket and
// no port. Changing any of it is a new decision, made here.
test('(n) the managed runners\' firewall is exactly the service the owner allowed on 2026-10-19, off unless its profile is on', () => {
  assert.deepEqual(directives(currentServices.get(MANAGED_RUNNER_FIREWALL)), [
    '  managed-runner-firewall:',
    `    profiles: [${FIREWALL_PROFILE}]`,
    '    build:',
    '      context: .',
    '      dockerfile: deploy/managed-runner/firewall/Dockerfile',
    '    image: orbit-managed-runner-firewall:local',
    '    container_name: orbit-managed-runner-firewall',
    '    restart: unless-stopped',
    '    network_mode: host',
    '    cap_drop: [ALL]',
    '    cap_add: [NET_ADMIN, NET_RAW]',
    '    security_opt: ["no-new-privileges:true"]',
    '    read_only: true',
    '    volumes:',
    '      - "${ORBIT_MANAGED_RUNNERS_DIR:-/dev/null}/firewall:/var/lib/orbit-managed-runner-firewall"',
    '      - type: bind',
    '        source: "${ORBIT_MANAGED_RUNNER_FIREWALL_XTABLES_LOCK:-/dev/null}"',
    '        target: /run/xtables.lock',
    '        bind:',
    '          create_host_path: false',
    '    healthcheck:',
    '      test: ["CMD", "python3", "-I", "/opt/orbit-managed-runner-firewall/firewall.py", "status"]',
    '      interval: 10s',
    '      timeout: 5s',
    '      retries: 3',
    '      start_period: 10s',
  ]);
});

test('(n) the host\'s network and NET_ADMIN are given to the managed runners\' firewall and to no other service', () => {
  for (const [name, block] of currentServices) {
    const given = directives(block).filter((line) => /network_mode: host|NET_ADMIN|NET_RAW|privileged/.test(line));
    assert.deepEqual(given, name === MANAGED_RUNNER_FIREWALL ? ['    network_mode: host', '    cap_add: [NET_ADMIN, NET_RAW]'] : [],
      `${name} is given ${given.join(', ')}`);
  }
});

// The definition the runner link project's task A4 added on 2026-10-25 (see the top of this file), every directive of it
// in order: the gateway built from src/link-gateway, under the one profile no install switches on; a read-only root, every
// capability dropped and no privilege escalation; time to drain before Docker stops it; the token signing key's public
// half, the gateway's secret, and the apiserver's and NATS's addresses inside this network (NATS's added by task B1 on
// the same day); certificates from files in its directory or
// over ACME; the runners' port published as RUNNER_LINK_PORT and its metrics on the host's loopback only; and one mount,
// its own directory, /dev/null unless .env names one. No database, no Docker socket, no host network. Changing any of it
// is a new decision, made here.
test('(o) the runner link gateway is exactly the service the runner link project added on 2026-10-25, off unless its profile is on', () => {
  assert.deepEqual(directives(currentServices.get(LINK_GATEWAY)), [
    '  link-gateway:',
    `    profiles: [${LINK_PROFILE}]`,
    '    build:',
    '      context: src/link-gateway',
    '      args:',
    '        ORBIT_SOURCE_SHA: "${ORBIT_SOURCE_SHA:-}"',
    '    image: orbit-link-gateway:local',
    '    container_name: orbit-link-gateway',
    '    restart: unless-stopped',
    '    stop_grace_period: 90s',
    '    read_only: true',
    '    cap_drop: [ALL]',
    '    security_opt: ["no-new-privileges:true"]',
    '    environment:',
    '      LINK_PUBLIC_KEYS: "${RUNNER_LINK_PUBLIC_KEY:-}"',
    '      LINK_GATEWAY_TOKEN: "${RUNNER_LINK_GATEWAY_TOKEN:-}"',
    '      LINK_API_URL: http://apiserver:3000',
    '      LINK_NATS_URL: nats://nats:4222',
    '      LINK_TLS_CERT_FILE: /var/lib/orbit-link-gateway/tls/fullchain.pem',
    '      LINK_TLS_KEY_FILE: /var/lib/orbit-link-gateway/tls/privkey.pem',
    '      LINK_ACME_DOMAINS: "${RUNNER_LINK_ACME_DOMAINS:-}"',
    '      LINK_ACME_EMAIL: "${RUNNER_LINK_ACME_EMAIL:-}"',
    '      LINK_ACME_CACHE_DIR: /var/lib/orbit-link-gateway/acme',
    '    ports:',
    '      - "${RUNNER_LINK_PORT:-8443}:8443"',
    '      - "127.0.0.1:${RUNNER_LINK_METRICS_PORT:-9464}:9464"',
    '    volumes:',
    '      - "${RUNNER_LINK_GATEWAY_DIR:-/dev/null}:/var/lib/orbit-link-gateway"',
    '    depends_on:',
    '      apiserver:',
    '        condition: service_healthy',
    '    healthcheck:',
    '      test: ["CMD", "/link-gateway", "health"]',
    '      interval: 5s',
    '      timeout: 5s',
    '      retries: 6',
    '      start_period: 10s',
  ]);
});

test('(o) the link token signing key is given to the apiserver alone, and the gateway secret to the apiserver and the link gateway', () => {
  for (const [name, block] of currentServices) {
    const text = directives(block).join('\n');
    assert.equal(/RUNNER_LINK_SIGNING_KEY/.test(text), name === 'apiserver', `${name} and the token signing key`);
    assert.equal(/RUNNER_LINK_PUBLIC_KEY/.test(text), name === LINK_GATEWAY, `${name} and the signing key's public half`);
    assert.equal(/RUNNER_LINK_GATEWAY_TOKEN/.test(text), ['apiserver', LINK_GATEWAY].includes(name), `${name} and the gateway secret`);
  }
});

// The definition the runner link project's task B1 added on 2026-10-25 (see the top of this file), every directive of it in
// order: the official NATS image on its 2.15 line, under the gateway's profile; a read-only root, every capability dropped
// and no privilege escalation; the server from flags alone, the client port and the monitoring port its health check
// reads, so the image's configuration file and the cluster port it opens are never loaded, and no -js: nothing is stored;
// the client port exposed to this project's network and published nowhere. No volume, no secret, no host network.
// Changing any of it is a new decision, made here.
test('(p) the runner link\'s NATS is exactly the service the runner link project added on 2026-10-25, off unless its profile is on', () => {
  assert.deepEqual(directives(currentServices.get(NATS)), [
    '  nats:',
    `    profiles: [${LINK_PROFILE}]`,
    '    image: nats:2.15-alpine',
    '    container_name: orbit-nats',
    '    restart: unless-stopped',
    '    read_only: true',
    '    cap_drop: [ALL]',
    '    security_opt: ["no-new-privileges:true"]',
    '    command: ["--http_port", "8222"]',
    '    expose:',
    '      - "4222"',
    '    healthcheck:',
    '      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8222/healthz"]',
    '      interval: 5s',
    '      timeout: 5s',
    '      retries: 6',
    '      start_period: 5s',
  ]);
});

test('(p) NATS is named to the apiserver and the link gateway alone, and stores nothing', () => {
  for (const [name, block] of currentServices) {
    const text = directives(block).join('\n');
    assert.equal(/RUNNER_LINK_NATS_URL/.test(text), name === 'apiserver', `${name} and where hints are published`);
    assert.equal(/nats:\/\/nats:4222/.test(text), [LINK_GATEWAY, 'apiserver'].includes(name), `${name} and the NATS address`);
  }
  assert.doesNotMatch(directives(currentServices.get(NATS)).join('\n'), /jetstream|-js\b|store_dir|volumes:|ports:|--config/i);
});

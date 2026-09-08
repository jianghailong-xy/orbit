// The deployment topology this repository is allowed to run.
//
// The account owner removed the four sidecars (watchdog, both outcome-coordinator peers and the
// executable dead-man) from Compose on 2026-09-01, taking the stack from nine services to five.
// Two of those services also carried a production hazard this file fences off: postgres bind-mounts
// a RELATIVE ./data/postgres path and gateway a relative ./gateway/nginx.conf, so an edit to either
// block — or a Compose run from a worktree — has already once replaced the live database with an
// empty one. Both blocks are therefore compared byte-for-byte against the commit this removal was
// based on, not merely inspected for shape.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = 'docker-compose.yml';

// The commit the sidecar removal was based on: nine services, all four sidecars present. Comparing
// against a fixed commit rather than a fixture means postgres/gateway cannot drift silently, and a
// deliberate future change to either has to move this pin on purpose.
const BASELINE_SHA = 'ac1b16e752fb11c7230052e5c7ffbbc0096e3e22';

const EXPECTED_SERVICES = ['postgres', 'pgbackup', 'apiserver', 'web', 'gateway'];
const REMOVED_SERVICES = [
  'watchdog', 'outcome-coordinator', 'outcome-coordinator-secondary', 'executable-dead-man',
];

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

const current = readFileSync(path.join(repo, COMPOSE), 'utf8');
const baseline = git('show', `${BASELINE_SHA}:${COMPOSE}`);

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

const currentServices = services(current);
const baselineServices = services(baseline);

test('the baseline commit really is the nine-service stack this change removes from', () => {
  assert.deepEqual([...baselineServices.keys()],
    [...EXPECTED_SERVICES.slice(0, 3), ...REMOVED_SERVICES, ...EXPECTED_SERVICES.slice(3)]);
});

test('(a) Compose declares exactly the five surviving services', () => {
  assert.deepEqual([...currentServices.keys()].sort(), [...EXPECTED_SERVICES].sort());
  assert.equal(currentServices.size, 5);
});

test('(b) no removed sidecar is named anywhere in Compose', () => {
  for (const removed of REMOVED_SERVICES) {
    assert.equal(current.includes(removed), false,
      `docker-compose.yml still mentions ${removed}`);
  }
});

test('(c) nothing was added back: no new service, no new always-on process, no init job', () => {
  // Every surviving service already existed at the baseline — a replacement observer cannot hide
  // behind a new name.
  for (const name of currentServices.keys()) {
    assert.ok(baselineServices.has(name), `${name} is a service the baseline did not have`);
  }
  const alwaysOn = (blocks) => [...blocks]
    .filter(([, block]) => /^\s+restart: unless-stopped$/m.test(block))
    .map(([name]) => name);
  // No resident process beyond the ones the five surviving services already ran.
  assert.deepEqual(alwaysOn(currentServices),
    alwaysOn(baselineServices).filter((name) => currentServices.has(name)));
  // No one-shot substitute: nothing may declare a run-once profile or a restart policy that
  // re-runs a job, and no service may be introduced solely to be `docker compose run`.
  assert.doesNotMatch(current, /^\s+profiles:/m);
  assert.doesNotMatch(current, /^\s+restart: (on-failure|always)$/m);
  assert.doesNotMatch(current, /\bexecutable-acceptance-dead-man\b/);
});

test('(i) the postgres service definition is unchanged, byte for byte', () => {
  assert.equal(currentServices.get('postgres'), baselineServices.get('postgres'));
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
// guarantee here is one-directional on purpose: nothing may be added to a surviving service, while
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
test('nothing was added to pgbackup, apiserver or web: their definitions only lost lines', () => {
  for (const name of ['pgbackup', 'apiserver', 'web']) {
    assert.deepEqual(
      directivesNotInBaseline(currentServices.get(name), baselineServices.get(name)), [],
      `${name} declares something the baseline did not: adding to a surviving service is forbidden`);
  }
});

test('(k) removing the sidecars is subtraction: Compose lost more lines than it gained', () => {
  const stat = git('diff', '--numstat', BASELINE_SHA, '--', COMPOSE).trim();
  const [added, deleted] = stat ? stat.split(/\s+/).map(Number) : [0, 0];
  assert.ok(deleted > added, `docker-compose.yml added ${added} and deleted ${deleted} lines`);
  assert.ok(current.split('\n').length < baseline.split('\n').length);
});

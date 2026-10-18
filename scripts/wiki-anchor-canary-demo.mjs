#!/usr/bin/env node
/**
 * The local demonstration for the 2026-10-08 wiki canary incident's read-only verification, end to
 * end on a throwaway PostgreSQL this script creates and destroys:
 *
 *   1. build the window's writes — checks the server path laid during the canary window, on two
 *      entries of one space, mixed path / symbol / commit;
 *   2. run the verification script against it: it must list every one of them, counted by space,
 *      entry and type;
 *   3. play the runner path's next maintenance run, which re-verifies every anchor on its own and
 *      overwrites the window's checks with its own ref and time;
 *   4. run the verification again: the count must be zero, and an entry nobody re-checked (another
 *      owner's) must never have appeared in either run.
 *
 *   node scripts/wiki-anchor-canary-demo.mjs
 *
 * Docker must be available, as for scripts/run-pg-spec.sh. Nothing outside the throwaway
 * container and a temp directory is touched.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import path from 'node:path';
import pg from 'pg';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const IMAGE = process.env.RUN_PG_SPEC_IMAGE ?? 'postgres:16-alpine';
const OWNER = randomUUID();
const OTHER = randomUUID();
const SPACE = randomUUID();
const T0 = '2026-10-08T14:03:04.000Z';
const UNTIL = '2026-10-08T16:26:00.000Z';
const WINDOW_AT = '2026-10-08T15:03:00.000Z';
const REDONE_AT = '2026-10-09T01:00:00.000Z';
const OLD_REF = createHash('sha1').update('origin/main before the window').digest('hex');
const REDONE_REF = createHash('sha1').update('origin/main after the rollback').digest('hex');
const SNAP = createHash('sha1').update('the snapshot the server job read').digest('hex');
const GOOD_COMMIT = createHash('sha1').update('the commit the repository holds').digest('hex');
const GONE_COMMIT = createHash('sha1').update('a commit the repository never held').digest('hex');
const REGION_MAIN = createHash('sha256').update('region of main').digest('hex');
const REGION_SERVE = createHash('sha256').update('region of serve').digest('hex');
const SERVE_BASELINE = createHash('sha256').update('the baseline the serve anchor named').digest('hex');

const E1 = randomUUID();
const E2 = randomUUID();
const E3 = randomUUID();
const FOREIGN = randomUUID();

const check = (state, ref, at, extra = {}) => ({ state, ref, at, ...extra });
function entry(id, ownerId, anchors) {
  return { id, ownerId, spaceId: SPACE, title: `entry ${id.slice(0, 8)}`, status: 'active', currentRevision: 1, anchors };
}

/** The window's writes: six checks on two entries, mixed path / symbol / commit, all `verified`. */
const WINDOWED = [
  entry(E1, OWNER, [
    { type: 'path', path: 'src/app.go', check: check('verified', SNAP, WINDOW_AT) },
    { type: 'symbol', path: 'src/app.go', symbol: 'main', check: check('verified', SNAP, WINDOW_AT, { regionSha256: REGION_MAIN, baselineSha256: REGION_MAIN }) },
    { type: 'commit', sha: GOOD_COMMIT, check: check('verified', SNAP, WINDOW_AT) },
  ]),
  entry(E2, OWNER, [
    { type: 'path', path: 'src/gone.go', check: check('verified', SNAP, WINDOW_AT) },
    { type: 'symbol', path: 'src/app.go', symbol: 'serve', regionSha256: SERVE_BASELINE, check: check('verified', SNAP, WINDOW_AT, { regionSha256: REGION_SERVE }) },
    { type: 'commit', sha: GONE_COMMIT, check: check('verified', SNAP, WINDOW_AT) },
  ]),
  // Checked long before the window: never a finding.
  entry(E3, OWNER, [{ type: 'path', path: 'docs/untouched.md', check: check('verified', OLD_REF, '2026-10-08T13:00:00.000Z') }]),
  // Another owner's window-time write: not this verification's without --owner, and never with it.
  entry(FOREIGN, OTHER, [{ type: 'path', path: 'docs/foreign.md', check: check('verified', SNAP, WINDOW_AT) }]),
];

let passed = 0;
function assertEqual(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`DEMO FAIL: ${what}\n  actual   ${JSON.stringify(actual)}\n  expected ${JSON.stringify(expected)}`);
    throw new Error(`demo assertion failed: ${what}`);
  }
  passed += 1;
  console.log(`  ok: ${what}`);
}

// ── the throwaway database ──────────────────────────────────────────────────────────────────────
const port = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const chosen = probe.address().port;
    probe.close(() => resolve(chosen));
  });
});
const container = `wiki-anchor-demo-${randomUUID().slice(0, 8)}`;
console.log(`==> postgres ${IMAGE} as ${container} on 127.0.0.1:${port}`);
spawnSync('docker', ['pull', '-q', IMAGE], { stdio: 'ignore' });
const docker = spawn('docker', ['run', '--rm', '--name', container, '-p', `127.0.0.1:${port}:5432`, '-e', 'POSTGRES_PASSWORD=demo', '-e', 'POSTGRES_DB=demo', IMAGE], { stdio: 'ignore' });
const stop = async () => {
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  docker.kill('SIGKILL');
};
process.on('SIGINT', () => { void stop().then(() => process.exit(130)); });
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) {
    await delay(500);
    up = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { stdio: 'pipe' }).status === 0;
  }
  if (!up) throw new Error('postgres did not come up');
  const url = `postgres://postgres:demo@127.0.0.1:${port}/demo`;
  let sql;
  for (let attempt = 0; ; attempt += 1) {
    try {
      sql = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
      await sql.connect();
      break;
    } catch (error) {
      if (attempt >= 20) throw new Error(`could not connect to the throwaway postgres: ${error.message}`);
      await delay(500);
    }
  }

  await sql.query(`CREATE TABLE "wiki_repo_snapshot"("space_id" uuid NOT NULL, "owner_id" uuid NOT NULL, "sha" char(40) NOT NULL, "created_at" timestamptz)`);
  await sql.query(
    `CREATE TABLE "wiki_entry"("id" uuid NOT NULL PRIMARY KEY, "owner_id" uuid NOT NULL, "space_id" uuid NOT NULL, "title" text,
       "status" text, "current_revision" int, "anchors" jsonb, "anchor_state" text DEFAULT 'unchecked')`,
  );
  await sql.query(`INSERT INTO "wiki_repo_snapshot"("space_id","owner_id","sha","created_at") VALUES ($1,$2,$3,now())`, [SPACE, OWNER, SNAP]);
  for (const row of WINDOWED) {
    await sql.query(
      `INSERT INTO "wiki_entry"("id","owner_id","space_id","title","status","current_revision","anchors") VALUES ($1,$2,$3,$4,'active',1,$5::jsonb)`,
      [row.id, row.ownerId, row.spaceId, row.title, JSON.stringify(row.anchors)],
    );
  }
  mkdtempSync(path.join(tmpdir(), 'wiki-anchor-demo-'));

  const run = (extra) => {
    const child = spawnSync('node', [path.join(REPO_ROOT, 'scripts', 'wiki-anchor-canary-verify.mjs'), '--url', url, '--since', T0, '--until', UNTIL, ...extra], { encoding: 'utf8' });
    console.log(`\n$ wiki-anchor-canary-verify.mjs ${extra.join(' ')}\n${child.stdout.trim()}`);
    if (child.status !== 0) {
      console.error(child.stderr);
      throw new Error(`verify exited ${child.status}`);
    }
    return child.stdout;
  };

  // 2. The verification lists everything the window wrote, counted by space, entry and type.
  console.log('\n==> 1. verify over the windowed database (scoped to the canary owner)');
  const before = run(['--owner', OWNER, '--refs', SNAP]);
  assertEqual(/(\d+) anchor check\(s\) the server path wrote/.exec(before)?.[1], '6', 'all six window-written checks are listed');
  assertEqual((before.match(/space [0-9a-f-]{36}: 6 check\(s\) across 2 entr\(ies\) — 2 path, 2 symbol, 2 commit/) ?? []).length, 1,
    'the space count names two entries and two of each type');
  assertEqual((before.match(/^  entry /gm) ?? []).length, 2, 'one line per affected entry');

  // 3. The runner path's next maintenance run re-verifies every anchor on its own ref and time.
  console.log('\n==> 2. the runner path re-checks every anchor');
  const redone = (anchor) => {
    if (anchor.type === 'path') return check(anchor.path === 'src/app.go' ? 'verified' : 'missing', REDONE_REF, REDONE_AT);
    if (anchor.type === 'commit') return check(anchor.sha === GOOD_COMMIT ? 'verified' : 'missing', REDONE_REF, REDONE_AT);
    const region = anchor.symbol === 'main' ? REGION_MAIN : REGION_SERVE;
    const baseline = anchor.regionSha256 ?? region;
    return check(region === baseline ? 'verified' : 'changed', REDONE_REF, REDONE_AT,
      { regionSha256: region, ...(anchor.regionSha256 ? {} : { baselineSha256: baseline }) });
  };
  for (const row of WINDOWED.filter((one) => one.ownerId === OWNER)) {
    await sql.query(`UPDATE "wiki_entry" SET "anchors"=$2::jsonb WHERE "id"=$1`, [row.id, JSON.stringify(row.anchors.map((anchor) => ({ ...anchor, check: redone(anchor) })))]);
  }

  // 4. The count is zero — and the untouched and foreign entries never appeared.
  console.log('\n==> 3. verify again: the window has been re-checked away');
  const after = run(['--owner', OWNER, '--refs', SNAP]);
  assertEqual(/(\d+) anchor check\(s\) the server path wrote/.exec(after)?.[1], '0', 'the count is zero once the runner path has re-checked');
  assertEqual((after.match(/nothing left of the window/) ?? []).length, 1, 'and it says so');
  for (const output of [before, after]) {
    assertEqual((output.match(/untouched/) ?? []).length, 0, 'the pre-window entry is never a finding');
    assertEqual((output.match(/foreign/) ?? []).length, 0, 'another owner\'s entry is never a finding when scoped');
  }
  console.log(`\nDEMO PASS: ${passed} assertions — the verification lists every window-written check by space, entry and type, and the count comes back zero once the runner path has re-checked them.`);
  await sql.end();
} finally {
  await stop();
}

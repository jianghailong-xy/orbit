#!/usr/bin/env node
/**
 * The local demonstration for the 2026-10-08 wiki canary incident's repair, end to end on a
 * throwaway PostgreSQL this script creates and destroys:
 *
 *   1. build the same corruption the incident wrote — a window of server-path checks laid on the
 *      wrong entry, and a symbol anchor adopting a page-mate's region as its baseline;
 *   2. run the read-only triage against it: it must find every touched anchor and flag the
 *      mis-adopted baseline;
 *   3. run the repair DRY: the plan must say which checks are restored to the pre-T0 capture and
 *      which are cleared;
 *   4. run the repair --apply, and read the rows back: restored where the capture has a check,
 *      cleared where it has none;
 *   5. play the NEXT correct check the way the fixed server job lays one down, and assert every
 *      conclusion and every baseline is right — the re-adopted baseline is the region the symbol
 *      itself holds now.
 *
 *   node scripts/wiki-anchor-canary-demo.mjs
 *
 * Docker must be available, as for scripts/run-pg-spec.sh. Nothing outside the throwaway
 * container and a temp directory is touched.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
const UNTIL = '2026-10-08T15:45:00.000Z';
const PRE_T0_AT = '2026-10-08T13:00:00.000Z';
const WINDOW_AT = '2026-10-08T15:03:00.000Z';
const OLD_REF = createHash('sha1').update('origin/main before the window').digest('hex');
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

function entry(id, anchors) {
  return { id, spaceId: SPACE, ownerId: OWNER, title: `entry ${id.slice(0, 8)}`, status: 'active', currentRevision: 1, anchors };
}
const check = (state, ref, at, extra = {}) => ({ state, ref, at, ...extra });

/** The state before the window: E1's path and commit verified by the runner path, its symbol never
 * checked; E2 never checked at all. The window is the first check E1's symbol ever gets — the
 * incident's poisoned case: it adopts whatever region the page-mate's verdict carries. */
const BEFORE = [
  entry(E1, [
    { type: 'path', path: 'src/app.go', check: check('verified', OLD_REF, PRE_T0_AT) },
    { type: 'symbol', path: 'src/app.go', symbol: 'main' },
    { type: 'commit', sha: GOOD_COMMIT, check: check('verified', OLD_REF, PRE_T0_AT) },
  ]),
  entry(E2, [
    { type: 'path', path: 'src/gone.go' },
    { type: 'symbol', path: 'src/app.go', symbol: 'serve', regionSha256: SERVE_BASELINE },
    { type: 'commit', sha: GONE_COMMIT },
  ]),
  // Never touched by anything: must come through untouched.
  entry(E3, [{ type: 'path', path: 'docs/untouched.md', check: check('verified', OLD_REF, PRE_T0_AT) }]),
  { ...entry(FOREIGN, [{ type: 'path', path: 'docs/foreign.md', check: check('verified', OLD_REF, PRE_T0_AT) }]), ownerId: OTHER },
];

/** What the buggy window run wrote: E1 took E2's verdicts, E2 took E1's; E1's symbol adopted E2's region. */
const WINDOWED = [
  entry(E1, [
    { type: 'path', path: 'src/app.go', check: check('missing', SNAP, WINDOW_AT) },
    { type: 'symbol', path: 'src/app.go', symbol: 'main', check: check('verified', SNAP, WINDOW_AT, { regionSha256: REGION_SERVE, baselineSha256: REGION_SERVE }) },
    { type: 'commit', sha: GOOD_COMMIT, check: check('missing', SNAP, WINDOW_AT) },
  ]),
  entry(E2, [
    { type: 'path', path: 'src/gone.go', check: check('verified', SNAP, WINDOW_AT) },
    { type: 'symbol', path: 'src/app.go', symbol: 'serve', regionSha256: SERVE_BASELINE, check: check('changed', SNAP, WINDOW_AT, { regionSha256: REGION_MAIN }) },
    { type: 'commit', sha: GONE_COMMIT, check: check('verified', SNAP, WINDOW_AT) },
  ]),
  BEFORE[2],
  BEFORE[3],
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
    const chosen = (probe.address() ).port;
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
  const sql = new pg.Client({ connectionString: url });
  for (let attempt = 0; ; attempt += 1) {
    try {
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
       "status" text, "current_revision" int, "anchors" jsonb, "anchor_state" text DEFAULT 'unchecked',
       "anchor_checked_ref" char(40), "anchor_checked_at" timestamptz)`,
  );
  await sql.query(`INSERT INTO "wiki_repo_snapshot"("space_id","owner_id","sha","created_at") VALUES ($1,$2,$3,now())`, [SPACE, OWNER, SNAP]);
  for (const row of BEFORE) {
    await sql.query(
      `INSERT INTO "wiki_entry"("id","owner_id","space_id","title","status","current_revision","anchors") VALUES ($1,$2,$3,$4,'active',1,$5::jsonb)`,
      [row.id, row.ownerId, row.spaceId, row.title, JSON.stringify(row.anchors)],
    );
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'wiki-anchor-demo-'));
  const capture = path.join(dir, 'pre-t0-capture.json');
  // The capture a person takes before flipping the switch: the anchors as they stood at T0.
  writeFileSync(capture, JSON.stringify({ entries: BEFORE.slice(0, 2).map(({ id, anchors }) => ({ entryId: id, anchors })) }));

  const run = (script, extra) => {
    const child = spawnSync('node', [path.join(REPO_ROOT, 'scripts', script), '--url', url, '--owner', OWNER, '--since', T0, '--until', UNTIL, ...extra], { encoding: 'utf8' });
    console.log(`\n$ ${script} ${extra.join(' ')}\n${child.stdout.trim()}`);
    if (child.status !== 0) {
      console.error(child.stderr);
      throw new Error(`${script} exited ${child.status}`);
    }
    return child.stdout;
  };

  // 1. The incident's writes land.
  for (const row of WINDOWED) {
    await sql.query(`UPDATE "wiki_entry" SET "anchors"=$2::jsonb WHERE "id"=$1`, [row.id, JSON.stringify(row.anchors)]);
  }
  const readAnchors = async (id) => (await sql.query(`SELECT "anchors" FROM "wiki_entry" WHERE "id"=$1`, [id])).rows[0].anchors;

  // 2. The triage finds every touched anchor and flags the borrowed baseline.
  console.log('\n==> 1. triage over the windowed database');
  const triage = run('wiki-anchor-canary-triage.mjs', ['--pre-t0', capture]);
  assertEqual((triage.match(/window check:/g) ?? []).length, 6, 'the triage lists all six window-written checks');
  assertEqual((triage.match(/!! baseline adopted in the window/g) ?? []).length, 1, 'exactly the borrowed baseline is flagged');

  // 3. The dry run plans the restores and the clears.
  console.log('\n==> 2. repair, dry-run');
  const dry = run('wiki-anchor-canary-repair.mjs', ['--pre-t0', capture]);
  assertEqual((dry.match(/restored to the pre-T0 check/g) ?? []).length, 2, 'E1\'s path and commit are restored from the capture');
  assertEqual((dry.match(/cleared: the capture shows no check/g) ?? []).length, 4, 'E1\'s symbol and E2\'s three checks are cleared: the capture shows none');
  assertEqual((dry.match(/2 would be restored, 4 cleared/g) ?? []).length, 1, 'the dry-run says so plainly');
  assertEqual((await readAnchors(E1))[0].check.state, 'missing', 'the dry run wrote nothing');

  // 4. The apply restores and clears, and nothing else moves.
  console.log('\n==> 3. repair, --apply');
  run('wiki-anchor-canary-repair.mjs', ['--pre-t0', capture, '--apply']);
  assertEqual((await readAnchors(E1)).map((a) => a.check?.state), ['verified', undefined, 'verified'], 'E1\'s path and commit read their pre-T0 checks, its symbol none');
  assertEqual((await readAnchors(E2)).map((a) => a.check), [undefined, undefined, undefined], 'E2 has no checks: the next correct check re-adopts baselines');
  assertEqual((await readAnchors(E3))[0].check.state, 'verified', 'the window never touched E3, and the repair does not either');
  assertEqual((await readAnchors(FOREIGN))[0].check.state, 'verified', 'another owner\'s entry is not this owner\'s to repair');
  const rollup = (await sql.query(`SELECT "anchor_state" FROM "wiki_entry" WHERE "id"=$1`, [E1])).rows[0];
  assertEqual(rollup.anchor_state, 'unchecked', 'E1\'s rolled-up anchor state follows its restored checks');

  // 5. The next correct check — the fixed mapping, laid down the way a written check is.
  console.log('\n==> 4. the next correct check, as the fixed server job lays it down');
  const correctCheck = (anchor) => {
    if (anchor.type === 'path') return check(anchor.path === 'src/app.go' ? 'verified' : 'missing', OLD_REF, '2026-10-09T01:00:00.000Z');
    if (anchor.type === 'commit') return check(anchor.sha === GOOD_COMMIT ? 'verified' : 'missing', OLD_REF, '2026-10-09T01:00:00.000Z');
    const region = anchor.symbol === 'main' ? REGION_MAIN : REGION_SERVE;
    const baseline = anchor.regionSha256 ?? region;
    return check(region === baseline ? 'verified' : 'changed', OLD_REF, '2026-10-09T01:00:00.000Z',
      { regionSha256: region, ...(anchor.regionSha256 ? {} : { baselineSha256: baseline }) });
  };
  for (const id of [E1, E2]) {
    const anchors = await readAnchors(id);
    await sql.query(`UPDATE "wiki_entry" SET "anchors"=$2::jsonb WHERE "id"=$1`, [id, JSON.stringify(anchors.map((anchor) => ({ ...anchor, check: correctCheck(anchor) })))]);
  }
  const e1 = await readAnchors(E1);
  assertEqual(e1[0].check.state, 'verified', 'E1\'s path holds');
  assertEqual(e1[1].check.state, 'verified', 'E1\'s symbol is verified again');
  assertEqual(e1[1].check.baselineSha256, REGION_MAIN, 'and the baseline it adopts now is its own region, not the page-mate\'s');
  const e2 = await readAnchors(E2);
  assertEqual(e2[0].check.state, 'missing', 'E2\'s gone path is missing again');
  assertEqual(e2[1].check.state, 'changed', 'E2\'s serve symbol moved against the baseline it named');
  assertEqual(e2[1].regionSha256, SERVE_BASELINE, 'and that baseline is the one the anchor itself names, untouched');
  assertEqual(e2[1].check.regionSha256, REGION_SERVE, 'the changed check carries the region the symbol holds now');
  assertEqual(e2[2].check.state, 'missing', 'E2\'s unheld commit is missing again');
  console.log(`\nDEMO PASS: ${passed} assertions, the triage found everything, the repair restored and cleared, and the next correct check reads every anchor right.`);
  await sql.end();
} finally {
  await stop();
}

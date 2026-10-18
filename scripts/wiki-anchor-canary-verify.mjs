#!/usr/bin/env node
/**
 * READ-ONLY verification for the 2026-10-08 wiki canary incident: of the anchor checks the
 * SERVER-side maintenance path wrote while the executor switch stood at canary, which ones has the
 * runner path not re-checked yet?
 *
 * The server-side job wrote its checks into `wiki_entry.anchors[i].check` with the snapshot's sha
 * as the check's `ref` and the check's `at` inside the window; the runner path that re-verifies
 * every anchor on its own run overwrites them with its own `at`. So an anchor check that STILL
 * names a snapshot sha and an `at` inside the window is one the runner has not got back to — the
 * count this prints is the count P10 re-runs after the next runner maintenance run and watches go
 * to zero.
 *
 *   node scripts/wiki-anchor-canary-verify.mjs --url "$DATABASE_URL" \
 *     [--owner 5ccdf9b9-...] [--since 2026-10-08T14:03:04Z] [--until 2026-10-08T16:26:00Z] \
 *     [--refs 0eaf4007..,80a96ad9..,721e4827..] [--json out.json]
 *
 * The refs default to every sha the owner's spaces hold snapshots of (which on the incident
 * deployment are exactly 0eaf40074…, 80a96ad97…, 721e48275…); --owner narrows the entries, and
 * with no --owner every owner's entries are read. Counts are given per space, per entry and per
 * anchor type. It writes nothing to the database; exit 0 either way, exit 3 when it cannot connect.
 */
import { writeFileSync } from 'node:fs';
import pg from 'pg';

function arg(name, fallback = undefined) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const url = arg('url', process.env.DATABASE_URL);
const owner = arg('owner');
const since = arg('since', '2026-10-08T14:03:04.000Z');
const until = arg('until', '2026-10-08T16:26:00.000Z');
const refsArg = arg('refs');
const jsonOut = arg('json');
if (!url) {
  console.error('usage: node scripts/wiki-anchor-canary-verify.mjs --url <postgres> [--owner <uuid>] [--since ..] [--until ..] [--refs sha,sha] [--json out.json]');
  process.exit(2);
}

const sql = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
try {
  await sql.connect();
} catch (error) {
  console.error(`verify: could not connect: ${error.message}`);
  process.exit(3);
}

const SHA = /^[0-9a-f]{40}$/;
let snapshotShas = new Set((refsArg ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => SHA.test(s)));
if (snapshotShas.size === 0) {
  const rows = await sql.query(`SELECT DISTINCT "sha" FROM "wiki_repo_snapshot"${owner ? ' WHERE "owner_id" = $1::uuid' : ''}`, owner ? [owner] : []);
  for (const row of rows.rows) snapshotShas.add(String(row.sha).trim().toLowerCase());
}

const rows = await sql.query(
  `SELECT e."id" AS "entryId", e."space_id" AS "spaceId", e."owner_id" AS "ownerId", e."title", e."current_revision" AS "revision",
          e."anchors" AS "anchors", e."anchor_state" AS "anchorState"
     FROM "wiki_entry" e
    WHERE e."status" = 'active'${owner ? ' AND e."owner_id" = $1::uuid' : ''}`,
  owner ? [owner] : [],
);

const found = [];
for (const row of rows.rows) {
  const anchors = Array.isArray(row.anchors) ? row.anchors : [];
  for (const [index, anchor] of anchors.entries()) {
    const check = anchor?.check;
    if (!check || typeof check.at !== 'string') continue;
    const at = Date.parse(check.at);
    if (Number.isNaN(at) || at < Date.parse(since) || at > Date.parse(until)) continue;
    if (!snapshotShas.has(String(check.ref ?? '').trim().toLowerCase())) continue;
    found.push({
      entryId: row.entryId,
      spaceId: row.spaceId,
      ownerId: row.ownerId,
      title: row.title,
      revision: row.revision,
      anchorState: row.anchorState,
      index,
      type: anchor.type,
      identity: anchor.type === 'commit'
        ? `commit ${anchor.sha}`
        : anchor.type === 'symbol'
          ? `symbol ${anchor.symbol} in ${anchor.path}`
          : `path ${anchor.path}`,
      check,
    });
  }
}
found.sort((a, b) => a.spaceId.localeCompare(b.spaceId) || a.entryId.localeCompare(b.entryId) || a.index - b.index);

const countBy = (key) => {
  const map = new Map();
  for (const item of found) {
    const k = typeof key === 'function' ? key(item) : item[key];
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
};
const perSpace = countBy('spaceId');
const perEntry = countBy('entryId');
const perType = countBy('type');

console.log(`window ${since} .. ${until}`);
console.log(`${found.length} anchor check(s) the server path wrote in the window and the runner has not re-checked yet.`);
for (const [spaceId, n] of perSpace) {
  const inSpace = found.filter((f) => f.spaceId === spaceId);
  const entryN = new Set(inSpace.map((f) => f.entryId)).size;
  const typeBits = [...inSpace.reduce((map, f) => map.set(f.type, (map.get(f.type) ?? 0) + 1), new Map())]
    .map(([type, m]) => `${m} ${type}`).join(', ');
  console.log(`  space ${spaceId}: ${n} check(s) across ${entryN} entr(ies) — ${typeBits}`);
}
for (const [entryId, n] of perEntry) {
  const first = found.find((f) => f.entryId === entryId);
  console.log(`  entry ${entryId} (${first.title}): ${n} — ${found.filter((f) => f.entryId === entryId).map((f) => `${f.type} @${f.index} ${f.check.state}`).join(', ')}`);
}
if (found.length === 0) {
  console.log('nothing left of the window: every written check has been re-checked by the runner path.');
}
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ since, until, refs: [...snapshotShas], total: found.length, perSpace: Object.fromEntries(perSpace), perEntry: Object.fromEntries(perEntry), perType: Object.fromEntries(perType), found }, null, 2));
  console.log(`JSON written to ${jsonOut}`);
}
await sql.end();

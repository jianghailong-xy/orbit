#!/usr/bin/env node
/**
 * READ-ONLY triage for the 2026-10-08 wiki canary incident: which anchors did the SERVER-side
 * maintenance path check while the executor switch stood at canary (T0 = 2026-10-08T14:03:04Z,
 * rolled back to `runner` later that hour)?
 *
 * The server-side job wrote its checks into `wiki_entry.anchors[i].check` with the snapshot's sha
 * as the check's `ref` and the check's `at` inside the window; the runner path reports the sha its
 * own fetch named, so within the window a check whose `ref` is one of the space's snapshot shas is
 * the server's. For every anchor checked that way this prints:
 *
 *   - the entry and the anchor's identity (index, type, path / symbol / sha),
 *   - the check the window wrote (state, ref, at, region and baseline),
 *   - the check the anchor held BEFORE the window — read from `--pre-t0 <file>` when given (a JSON
 *     capture of the entries' anchors made before T0; without a capture, an anchor the window
 *     touched holds no surviving pre-T0 check and the repair clears it so the next correct check
 *     re-adopts its baseline),
 *   - a flag on the symbol anchors that adopted a `baselineSha256` out of the window: the borrowed
 *     region a page-mate's verdict carried, which would read `changed` against every later correct
 *     check until it is cleared.
 *
 * Usage:
 *   node scripts/wiki-anchor-canary-triage.mjs --url "$DATABASE_URL" \
 *     --owner 5ccdf9b9-... [--since 2026-10-08T14:03:04Z] [--until 2026-10-08T15:45:00Z] \
 *     [--pre-t0 capture.json] [--json out.json]
 *
 * It writes nothing to the database. Exit 0 with findings printed either way; exit 3 when the
 * connection fails. The window defaults to the incident's: T0 to 90 minutes after it.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

function arg(name, fallback = undefined) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const url = arg('url', process.env.DATABASE_URL);
const owner = arg('owner');
const since = arg('since', '2026-10-08T14:03:04.000Z');
const until = arg('until', '2026-10-08T15:45:00.000Z');
const preT0File = arg('pre-t0');
const jsonOut = arg('json');
if (!url || !owner) {
  console.error('usage: node scripts/wiki-anchor-canary-triage.mjs --url <postgres> --owner <uuid> [--since ..] [--until ..] [--pre-t0 capture.json] [--json out.json]');
  process.exit(2);
}

const preT0 = new Map();
if (preT0File) {
  const captured = JSON.parse(readFileSync(preT0File, 'utf8'));
  for (const row of captured.entries ?? captured) {
    for (const [index, anchor] of (row.anchors ?? []).entries()) {
      preT0.set(`${row.entryId}:${index}`, anchor.check ?? null);
    }
  }
}

const sql = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
try {
  await sql.connect();
} catch (error) {
  console.error(`triage: could not connect: ${error.message}`);
  process.exit(3);
}

// The snapshot shas a check may name: one per space, the commit the server read the tree at.
const snapshots = await sql.query(
  `SELECT "space_id" AS "spaceId", "sha" FROM "wiki_repo_snapshot" WHERE "owner_id" = $1::uuid`,
  [owner],
);
const snapshotShasBySpace = new Map();
for (const row of snapshots.rows) {
  const set = snapshotShasBySpace.get(row.spaceId) ?? new Set();
  set.add(row.sha);
  snapshotShasBySpace.set(row.spaceId, set);
}

// Every live entry of the owner whose anchors carry a check written inside the window.
const rows = await sql.query(
  `SELECT e."id" AS "entryId", e."space_id" AS "spaceId", e."title", e."current_revision" AS "revision",
          e."anchors" AS "anchors", e."anchor_state" AS "anchorState"
     FROM "wiki_entry" e
    WHERE e."owner_id" = $1::uuid AND e."status" = 'active'`,
  [owner],
);

const findings = [];
for (const row of rows.rows) {
  const anchors = Array.isArray(row.anchors) ? row.anchors : [];
  for (const [index, anchor] of anchors.entries()) {
    const check = anchor?.check;
    if (!check || typeof check.at !== 'string') continue;
    const at = Date.parse(check.at);
    if (Number.isNaN(at) || at < Date.parse(since) || at > Date.parse(until)) continue;
    const shas = snapshotShasBySpace.get(row.spaceId);
    if (!shas || !shas.has(check.ref)) continue;
    const key = `${row.entryId}:${index}`;
    const before = preT0.get(key) ?? null;
    const identity = anchor.type === 'commit'
      ? `commit ${anchor.sha}`
      : anchor.type === 'symbol'
        ? `symbol ${anchor.symbol} in ${anchor.path}`
        : `path ${anchor.path}`;
    const adoptedInWindow = anchor.type === 'symbol'
      && !anchor.regionSha256
      && !before?.baselineSha256
      && (check.state === 'verified' || check.state === 'changed')
      && typeof check.regionSha256 === 'string';
    findings.push({
      entryId: row.entryId,
      spaceId: row.spaceId,
      title: row.title,
      revision: row.revision,
      anchorState: row.anchorState,
      index,
      type: anchor.type,
      identity,
      anchorOwnRegion: anchor.regionSha256 ?? null,
      windowCheck: check,
      preT0Check: before,
      preT0Known: preT0.has(key),
      misadoptedBaseline: adoptedInWindow,
    });
  }
}

findings.sort((a, b) => a.entryId.localeCompare(b.entryId) || a.index - b.index);

const flagged = findings.filter((f) => f.misadoptedBaseline);
console.log(`window ${since} .. ${until}, owner ${owner}`);
console.log(`${findings.length} anchor(s) checked by the server path in the window, ` +
  `${flagged.length} of them a symbol that adopted its baseline there${preT0File ? '' : ' (no --pre-t0 capture: pre-T0 checks unknown where the window overwrote them)'}.`);
for (const f of findings) {
  const check = f.windowCheck;
  console.log(
    `- ${f.identity} @${f.index} of ${f.title} (${f.entryId})`
    + `\n    window check: ${check.state} ref ${String(check.ref).slice(0, 12)} at ${check.at}`
    + `${check.regionSha256 ? ` region ${check.regionSha256.slice(0, 12)}` : ''}`
    + `${check.baselineSha256 ? ` baseline ${check.baselineSha256.slice(0, 12)}` : ''}`
    + (f.preT0Known
      ? `\n    pre-T0 check: ${f.preT0Check ? `${f.preT0Check.state} ref ${String(f.preT0Check.ref).slice(0, 12)} at ${f.preT0Check.at}` : 'none'}`
      : '\n    pre-T0 check: unknown (overwritten in place; pass --pre-t0 for a captured copy)')
    + (f.misadoptedBaseline ? '\n    !! baseline adopted in the window: borrowed from a page-mate, will read changed against later correct checks' : ''),
  );
}

if (jsonOut) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(jsonOut, JSON.stringify({ owner, since, until, findings }, null, 2));
  console.log(`JSON written to ${jsonOut}`);
}
await sql.end();

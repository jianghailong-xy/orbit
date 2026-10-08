#!/usr/bin/env node
/**
 * Repair for the 2026-10-08 wiki canary incident's written checks, DRY-RUN unless `--apply` is given.
 *
 * For every anchor whose check the server-side maintenance path wrote inside the canary window
 * (see wiki-anchor-canary-triage.mjs for how the window and the server path are recognised), the
 * check is put back to what it was before the window:
 *
 *   - `--pre-t0 <capture.json>` names the check the anchor held at T0 (a JSON capture of the
 *     entries' anchors made before T0 — the same file the triage reads): it is restored verbatim.
 *   - An affected anchor the capture does not cover — or covers with no check — gets its check
 *     CLEARED: the window's verdict is dropped and the next correct check re-adopts the region the
 *     anchor truly holds (this is the only repair for a symbol that adopted a page-mate's region as
 *     its baseline, which no later check would otherwise move).
 *
 * Nothing else of the entry is touched: no other anchor, no field, no revision. The entry's
 * derived rollups (`anchor_state`, `anchor_checked_ref`, `anchor_checked_at`) are recomputed from
 * the anchors that remain, exactly as a written check would leave them. Each write is a
 * compare-and-swap on the anchors the row held when it was read: a row that moved in between is
 * skipped and reported, never overwritten.
 *
 * Usage:
 *   node scripts/wiki-anchor-canary-repair.mjs --url "$DATABASE_URL" --owner <uuid> \
 *     [--since ..] [--until ..] [--pre-t0 capture.json] [--apply]
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

function arg(name, fallback = undefined) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}
const apply = process.argv.includes('--apply');

const url = arg('url', process.env.DATABASE_URL);
const owner = arg('owner');
const since = arg('since', '2026-10-08T14:03:04.000Z');
const until = arg('until', '2026-10-08T15:45:00.000Z');
const preT0File = arg('pre-t0');
if (!url || !owner) {
  console.error('usage: node scripts/wiki-anchor-canary-repair.mjs --url <postgres> --owner <uuid> [--since ..] [--until ..] [--pre-t0 capture.json] [--apply]');
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
  console.error(`repair: could not connect: ${error.message}`);
  process.exit(3);
}

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

const rows = await sql.query(
  `SELECT e."id" AS "entryId", e."space_id" AS "spaceId", e."anchors" AS "anchors"
     FROM "wiki_entry" e
    WHERE e."owner_id" = $1::uuid AND e."status" = 'active'`,
  [owner],
);

/** The rollups a written check leaves behind, from the anchors that remain — every anchor without a
 * check reads unchecked, exactly as `entryAnchorState` adds the entry's anchors up. */
function rollups(anchors) {
  const states = anchors.map((anchor) => (anchor?.check && typeof anchor.check.state === 'string' ? anchor.check.state : 'unchecked'));
  const anchorState = states.includes('missing') ? 'missing'
    : states.includes('changed') ? 'changed'
      : states.length === 0 || states.some((state) => state !== 'verified') ? 'unchecked'
        : 'verified';
  let latest = null;
  for (const anchor of anchors) {
    const check = anchor?.check;
    if (!check || typeof check.state !== 'string') continue;
    if (!latest || String(check.at ?? '') > String(latest.at ?? '')) latest = check;
  }
  return { anchorState, anchorCheckedRef: latest?.ref ?? null, anchorCheckedAt: latest?.at ?? null };
}

const plans = [];
for (const row of rows.rows) {
  const anchors = Array.isArray(row.anchors) ? row.anchors : [];
  const touched = [];
  for (const [index, anchor] of anchors.entries()) {
    const check = anchor?.check;
    if (!check || typeof check.at !== 'string') continue;
    const at = Date.parse(check.at);
    if (Number.isNaN(at) || at < Date.parse(since) || at > Date.parse(until)) continue;
    const shas = snapshotShasBySpace.get(row.spaceId);
    if (!shas || !shas.has(check.ref)) continue;
    touched.push(index);
  }
  if (touched.length === 0) continue;
  const next = anchors.map((anchor) => ({ ...anchor }));
  const actions = [];
  for (const index of touched) {
    const key = `${row.entryId}:${index}`;
    const restore = preT0.get(key);
    if (restore) {
      next[index].check = restore;
      actions.push(`#${index} restored to the pre-T0 check (${restore.state} at ${restore.at})`);
    } else if (preT0.has(key)) {
      delete next[index].check;
      actions.push(`#${index} cleared: the capture shows no check before the window`);
    } else {
      delete next[index].check;
      actions.push(`#${index} cleared: no pre-T0 capture for it, so the next correct check re-adopts its baseline`);
    }
  }
  plans.push({ entryId: row.entryId, before: anchors, after: next, actions });
}

console.log(`${plans.length} entr(ies) hold ${plans.reduce((n, p) => n + p.actions.length, 0)} anchor check(s) the window wrote. ` +
  `${apply ? 'APPLYING' : 'DRY-RUN'} (pass --apply to write).`);
let restored = 0;
let cleared = 0;
let skipped = 0;
for (const plan of plans) {
  console.log(`- ${plan.entryId}: ${plan.actions.join('; ')}`);
  if (!apply) continue;
  const { anchorState, anchorCheckedRef, anchorCheckedAt } = rollups(plan.after);
  // Compare-and-swap on the anchors the row held when read: a row that moved since is skipped.
  const written = await sql.query(
    `UPDATE "wiki_entry"
        SET "anchors" = $2::jsonb,
            "anchor_state" = $3,
            "anchor_checked_ref" = $4,
            "anchor_checked_at" = $5
      WHERE "id" = $1::uuid AND "owner_id" = $6::uuid AND "anchors" = $7::jsonb`,
    [plan.entryId, JSON.stringify(plan.after), anchorState, anchorCheckedRef, anchorCheckedAt, owner, JSON.stringify(plan.before)],
  );
  if (written.rowCount !== 1) {
    skipped += 1;
    console.log(`  !! skipped: the entry moved while the repair read it — re-run on a settled database`);
    continue;
  }
  for (const action of plan.actions) {
    if (action.includes('restored')) restored += 1;
    else cleared += 1;
  }
}
console.log(apply
  ? `done: ${restored} restored, ${cleared} cleared, ${skipped} skipped.`
  : `dry-run only: ${plans.reduce((n, p) => n + p.actions.filter((a) => a.includes('restored')).length, 0)} would be restored, `
    + `${plans.reduce((n, p) => n + p.actions.filter((a) => a.includes('cleared')).length, 0)} cleared. Re-run with --apply to write.`);
await sql.end();
if (apply && skipped > 0) process.exit(4);

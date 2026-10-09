/**
 * `run_event`'s high-water mark is read with raw SQL, never through the `runEvent.aggregate`
 * delegate.
 *
 * Prisma compiles an aggregate to `SELECT MAX("seq") FROM (SELECT "seq" … WHERE session_id = $1
 * OFFSET $2) AS "sub"`. That OFFSET is a bind parameter — always 0 — and it stops the planner
 * flattening the subquery, so MAX cannot be pushed down: the plan scans every event the session
 * has, one heap visit each. Measured against a 5125-event session, that is 5125 heap blocks and
 * 5172 buffers, where `coalesce(max("seq"), 0)` reads one index tuple in 4 buffers; cold, it is
 * seconds of scattered page reads per claim, and the IO it spends saturates the disk for the whole
 * deployment (a claim burst is one of these per newly started session, a reclaim one per open
 * session).
 *
 * This half of the guarantee needs no database: it decides what ships, and runs wherever the suite
 * runs. The plan itself is pinned by the raw SQL these two sites must keep.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/** build/common -> build -> apiserver -> src -> repository root. */
const ROOT = path.resolve(__dirname, '../../../..');
const SOURCES = path.join(ROOT, 'src/apiserver/src');

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return productionSources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

test('no production source reads run_event through the aggregate delegate', () => {
  // The call itself, not the prose: comments in both call sites name the delegate to say why it
  // is not used, and they are not what this fails on.
  const offenders = productionSources(SOURCES)
    .filter((file) => /\.runEvent\.aggregate\s*\(/.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file));
  assert.deepEqual(offenders, [], 'read max("seq") with $queryRaw instead — see this file\'s header');
});

test("claim and reclaim both read this session's max(seq) with raw SQL", () => {
  const sites = [
    'src/apiserver/src/queue/queue.service.ts',
    'src/apiserver/src/runner-api/runner-api.controller.ts',
  ];
  for (const site of sites) {
    const source = readFileSync(path.join(ROOT, site), 'utf8');
    // The shape both sites must keep: the aggregate the planner can push down, scoped to one
    // session, coalesced so a session with no events reads 0 the way `?? 0` used to.
    assert.match(source, /SELECT\s+coalesce\(max\("seq"\), 0\)\s+AS "max"\s+FROM "run_event"\s+WHERE "session_id" = \$\{[A-Za-z_.]+\}::uuid/, site);
  }
});

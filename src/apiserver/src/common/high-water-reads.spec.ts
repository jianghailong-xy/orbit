/**
 * The high-water reads on the hot paths are raw SQL, never a Prisma aggregate.
 *
 * Prisma compiles `aggregate` into a `MAX(…)` over an OFFSET subquery —
 * `SELECT MAX("seq") FROM (SELECT "seq" … WHERE session_id = $1 OFFSET $2) AS "sub"`. That OFFSET
 * is a bind parameter (always 0) and it stops the planner flattening the subquery, so MAX cannot
 * be pushed down and no covering index can be used for the ordering: the read becomes every row of
 * the filtered set, one heap visit each. Measured, per site:
 *
 *   run_event (claim, reclaim)   5125 events → 5125 heap blocks, 5172 buffers, 16.0 s cold
 *   conversation_turn (shell)    1500 turns → 1260 heap blocks, 1263 buffers, 1.2 s cold
 *   task (public page)          200k tasks  → sequential scan, 3087 buffers
 *
 * `max(seq)` / `max(updated_at)` over the same indexes is one index tuple in ~4 buffers, so these
 * four sites read it that way. The shape below is what keeps them doing so — and the delegates are
 * banned outright on the two tables whose every aggregate is a per-scope scan, so a new call site
 * cannot quietly reintroduce it.
 *
 * This half of the guarantee needs no database: it decides what ships, and runs wherever the suite
 * runs. What these reads must return (0 for a session with no events, the newest task activity) is
 * proved against real PostgreSQL by the pg specs of the paths themselves.
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

test('no production source reads run_event or conversation_turn through the aggregate delegate', () => {
  // The call itself, not the prose: the call sites' comments name the delegate to say why it is
  // not used, and they are not what this fails on.
  const offenders = productionSources(SOURCES)
    .filter((file) => /\.(runEvent|conversationTurn)\.aggregate\s*\(/.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file));
  assert.deepEqual(offenders, [], 'read the max with $queryRaw instead — see this file\'s header');
});

test('every high-water read keeps the raw shape the planner can push down', () => {
  const sites = [
    {
      file: 'src/apiserver/src/queue/queue.service.ts',
      shape: /SELECT\s+coalesce\(max\("seq"\), 0\)\s+AS "max"\s+FROM "run_event"\s+WHERE "session_id" = \$\{[A-Za-z_.]+\}::uuid/,
    },
    {
      file: 'src/apiserver/src/runner-api/runner-api.controller.ts',
      shape: /SELECT\s+coalesce\(max\("seq"\), 0\)\s+AS "max"\s+FROM "run_event"\s+WHERE "session_id" = \$\{[A-Za-z_.]+\}::uuid/,
    },
    {
      file: 'src/apiserver/src/runner-api/runner-api.controller.ts',
      shape: /SELECT\s+max\("seq"\)\s+AS "seq"\s+FROM "conversation_turn"\s+WHERE "session_id" = \$\{[A-Za-z_.]+\}::uuid/,
    },
    {
      file: 'src/apiserver/src/share-links/public-project.ts',
      shape: /SELECT\s+max\("updated_at"\)\s+AS "at"\s+FROM "task"\s+WHERE "owner_id" = \$\{[A-Za-z_.]+\}::uuid\s+AND "project_id" = \$\{[A-Za-z_.]+\}::uuid/,
    },
  ];
  for (const { file, shape } of sites) {
    assert.match(readFileSync(path.join(ROOT, file), 'utf8'), shape, file);
  }
});

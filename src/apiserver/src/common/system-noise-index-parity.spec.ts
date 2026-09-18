import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { notNoiseSql } from './system-noise';

/**
 * The noise predicate's third copy, and the only one nothing guarded.
 *
 * `isNoiseSystemEvent` and `notNoiseSql` are held in step by system-noise.spec.ts. The partial
 * index `run_event_renderable_idx` (migration 0069) is that same predicate materialised again, and
 * a drift there is invisible: Postgres uses a partial index only when it can prove the query's
 * predicate implies the index's, and the four read paths interpolate `notNoiseSql` verbatim
 * (sessions.controller.ts:779, sessions.service.ts:2881/2954, runner-api.controller.ts:5150). So a
 * predicate the index no longer covers returns the right rows and raises nothing — the planner
 * just abandons the index and the tail scan wades back through the ~92% of run_event that is
 * `system` pings. 0069 measured that at 104 ms against 0.8 ms, and `idx_scan` on the index stands
 * at 357,172, so this is a hot path rather than a theoretical one.
 *
 * WHY TEXT AND NOT pg_get_expr
 * ============================
 * The command that judges a change here is `npm --prefix src/apiserver test`, whose script compiles
 * the specs into `build/` and hands them to `node --test` after filtering out every `*.pg.spec.js`.
 * A `.pg.spec.ts` is excluded from that lane by construction — a guard written there would not run
 * where this one has to — and it needs a live database besides. Nothing is lost by comparing text:
 * 0069's own comment states the invariant as
 * character-identity ("The WHERE clause must stay character-identical to `notNoiseSql`"), which is
 * the honest form of it, because the expression is interpolated into the query rather than rebuilt
 * — the tree Postgres parses on the query side comes from exactly this string.
 *
 * The comparison normalizes whitespace and nothing else. Case and quotes stay significant, so a
 * subtype literal turning into `'INIT'` — a real semantic change, subtypes are lowercase — is red
 * rather than a formatting difference. That is stricter than the planner's implication proof,
 * which tolerates a rewrite, and the strictness is the point: the failure being guarded is silent,
 * so a spurious red on a reworded-but-equivalent predicate costs far less than a missed one.
 */
const INDEX_NAME = 'run_event_renderable_idx';
const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');

/** Collapse runs of whitespace. Case, quotes and every other character are left alone. */
const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

/**
 * The `WHERE` of the most recent migration creating `INDEX_NAME`, and the file it came from.
 *
 * An applied migration is immutable to Prisma, so a later one can only change the predicate by
 * dropping and re-creating the index — which is why the last `CREATE INDEX` wins instead of 0069
 * being hard-coded. `where` is null when such a statement carries no `WHERE` at all: that is the
 * index losing its partial-ness, a drift this guard should be as loud about as any other.
 */
function indexPredicate(): { file: string; where: string | null } {
  // Zero-padded numeric prefixes, so lexical order is chronological order.
  const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let found: { file: string; where: string | null } | null = null;
  for (const dir of dirs) {
    const file = path.join(MIGRATIONS, dir, 'migration.sql');
    let sql: string;
    try {
      sql = readFileSync(file, 'utf8');
    } catch {
      continue; // a migration directory without its SQL says nothing about the index
    }
    // Strip `--` comments before looking for the clause: 0069's header talks *about* the WHERE,
    // and would otherwise be where the search finds one.
    for (const statement of sql.replace(/--[^\n]*/g, '').split(';')) {
      if (!/CREATE\s+INDEX/i.test(statement) || !statement.includes(INDEX_NAME)) continue;
      found = { file, where: /\bWHERE\b([\s\S]*)$/i.exec(statement)?.[1] ?? null };
    }
  }

  assert.ok(found, `no migration creates ${INDEX_NAME} — this guard has lost its subject`);
  return found;
}

test('run_event_renderable_idx WHERE stays in step with notNoiseSql', () => {
  const { file, where } = indexPredicate();

  assert.ok(
    where,
    `${file} creates ${INDEX_NAME} without a WHERE: the partial index the read paths plan ` +
      'against is gone, and every transcript page scans the ping rows again.',
  );

  assert.equal(
    normalize(where),
    normalize(notNoiseSql.sql),
    `${file} and \`notNoiseSql\` (src/common/system-noise.ts) have drifted apart. Postgres matches ` +
      'the index to the query by proving one predicate implies the other, so a mismatch never ' +
      'fails — it silently stops using the index. Change both, or neither.',
  );
});

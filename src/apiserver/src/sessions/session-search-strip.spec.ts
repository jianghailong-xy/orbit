import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { SessionsService } from './sessions.service';

/**
 * ⌘K searches markdown SOURCE, and the user searches for what they read. A reply stored as
 * "**`tool_call`** 历史行结果永远是 NULL" renders without its marks, and pasting that line into the
 * palette used to match nothing at all.
 *
 * Both halves of the fix are asserted here — the corpus (in SQL) and the query (before it becomes
 * a LIKE pattern) — because stripping only one is worse than stripping neither: it looks correct
 * and quietly matches less.
 */

const OWNER_ID = 'c111a556-1094-4e98-90d0-f5f7fa74544c';

/** The strip's tail, as both the service and migration 0095 must spell it. */
const STRIP_TAIL = ", '*', ''), '`', '')";
const stripped = (col: string): string => `replace(replace(${col}${STRIP_TAIL}`;

const captureSearch = async (query: string): Promise<Prisma.Sql> => {
  let captured: Prisma.Sql | undefined;
  const prisma = {
    $queryRaw: async (sql: Prisma.Sql) => {
      captured = sql;
      return [];
    },
  };
  const service = new SessionsService(prisma as never, {} as never, {} as never);
  await service.search(OWNER_ID, query, 20);
  assert.ok(captured);
  return captured;
};

const migration = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0095_search_strip_markdown/migration.sql'),
  'utf8',
);

test('every text tier is matched with its markdown marks removed', async () => {
  const { sql } = await captureSearch('the **merge** button');
  // Session columns, stripped once into the sub-select whose projection the CASEs read.
  for (const col of ['s.title', 's.prompt', 's.last_assistant_text', 's.branch', 'a.name', 't.title']) {
    assert.ok(sql.includes(stripped(col)), `${col} is compared raw`);
  }
  // The joined-name branches admit rows on their own, so they strip on their own side too — a
  // branch that admits by the raw name would be dropped again by the stripped re-test.
  assert.ok(sql.includes(`${stripped('name')} ILIKE`), 'workspace name is compared raw');
  assert.ok(sql.includes(`${stripped('title')} ILIKE`), 'task title is compared raw');
  // Conversation text: the tier the reported miss was actually in.
  assert.ok(sql.includes(`${stripped(`e.payload->>'text'`)} ILIKE`), 'message text is compared raw');
});

test('the query is stripped the same way, so the phrase as read is the phrase matched', async () => {
  const { values } = await captureSearch('the **merge** button');
  assert.ok(values.includes('%the merge button%'));
  assert.ok(!values.some((v) => typeof v === 'string' && v.includes('*')));
});

test('a query of nothing but marks answers with recents, not with every row', async () => {
  // '***' strips to empty, which normalizes to null — the same path an empty palette takes.
  const { sql } = await captureSearch('***');
  assert.match(sql, /'recent'::text AS "matchField"/);
});

test('the stripped columns are computed once, behind the optimization fence', async () => {
  const { sql } = await captureSearch('merge');
  // Without OFFSET 0 the planner folds the sub-select into the CASEs above it and re-runs every
  // strip once per branch — measured 584ms against 346ms. It reads like leftover paging; it isn't.
  assert.match(sql, /OFFSET 0\s*\)\s*x/);
});

test('both trigram indexes are built on the expression the search re-states', () => {
  // A trigram index over an expression is only used by a query repeating that expression exactly.
  // Spelled differently in the two places, the search still returns the right rows — by scanning
  // every one of them (450ms against 5ms on the session tier), with nothing failing loudly.
  const [sessionIndex, eventIndex] = ['session_search_trgm', 'run_event_text_trgm'].map((name) => {
    const stmt = migration.split(';').find((s) => s.includes(`CREATE INDEX "${name}"`));
    assert.ok(stmt, `${name} is not created by 0095`);
    // Collapsed, so the migration stays free to wrap the long concatenation across lines.
    return stmt.replace(/\s+/g, ' ');
  });
  assert.ok(sessionIndex.includes(STRIP_TAIL) && sessionIndex.includes('gin_trgm_ops'));
  assert.ok(eventIndex.includes(STRIP_TAIL) && eventIndex.includes('gin_trgm_ops'));
  // The event index stays partial: user + assistant rows are a low single-digit percentage of an
  // append-only log, and indexing the rest would be a write-path tax on every event ingested.
  assert.match(eventIndex, /WHERE "type" IN \('user', 'assistant'\)/);
});

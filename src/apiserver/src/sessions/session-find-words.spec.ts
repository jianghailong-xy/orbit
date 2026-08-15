import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { SessionsService } from './sessions.service';

/**
 * Both searches match the phrase first and every word of it only as a fallback — see `broaden`
 * for why that order is forced (precision, and a trigram index that a two-character Chinese word
 * cannot use).
 *
 * Both ask the cheap question first and the expensive one only when it came back empty. For the
 * palette that is because its phrase query is index-driven; for in-session find it is because the
 * words of a query admit far more of a session than the phrase does, and everything they admit is
 * carried through a sort and a window count (13.1s against 2.0s on a 111k-event session).
 */

const OWNER_ID = 'c111a556-1094-4e98-90d0-f5f7fa74544c';
const SESSION_ID = '915d27d1-b92f-4cc6-819f-174ff5be13a9';

/** Capture every statement a search issues, answering each with `results`. */
const capture = async (
  run: (s: SessionsService) => Promise<unknown>,
  results: unknown[][] = [],
): Promise<Prisma.Sql[]> => {
  const sql: Prisma.Sql[] = [];
  const prisma = {
    session: { findFirst: async () => ({ id: SESSION_ID }) },
    $queryRaw: async (q: Prisma.Sql) => {
      sql.push(q);
      return results[sql.length - 1] ?? [];
    },
  };
  await run(new SessionsService(prisma as never, {} as never, {} as never));
  return sql;
};

const findIn = (query: string, results?: unknown[][], limit?: number) =>
  capture((s) => s.searchEvents(OWNER_ID, SESSION_ID, query, limit), results);

/** The response rather than the statements, for the cases about what the count reports. */
const findResult = async (query: string, results: unknown[][], limit: number) => {
  let out: Awaited<ReturnType<SessionsService['searchEvents']>> | undefined;
  await capture(async (s) => {
    out = await s.searchEvents(OWNER_ID, SESSION_ID, query, limit);
  }, results);
  return out!;
};

/** `n` rows shaped like the page query's projection. */
const page = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ seq: i, type: 'user', toolName: null, ts: new Date(), snippet: 'x' }));

const palette = (query: string, results?: unknown[][]) =>
  capture((s) => s.search(OWNER_ID, query, 20), results);

// ── in-session find (⌘F) ──────────────────────────────────────────────────────────────────────

test('find asks for the phrase first, and a hit costs nothing more', async () => {
  // The regression this pins: a widened scan that also evaluates the phrase makes the common
  // case — the phrase is right there — pay for every row the words admit.
  const sql = await findIn('confirm directory', [[{ seq: 1, total: 1 }]]);
  assert.equal(sql.length, 1);
  assert.ok(sql[0].values.includes('%confirm directory%'));
  assert.ok(!sql[0].values.includes('%confirm%'));
  assert.doesNotMatch(sql[0].sql, /AND \(text ILIKE/, 'the phrase pass is one ILIKE');
});

test('find broadens to words only once the phrase found nothing', async () => {
  const sql = await findIn('confirm directory');
  assert.equal(sql.length, 2);
  assert.match(sql[1].sql, /\(text ILIKE \?\) AND \(text ILIKE \?\)/);
  assert.ok(sql[1].values.includes('%confirm%'));
  assert.ok(sql[1].values.includes('%directory%'));
  assert.ok(!sql[1].values.includes('%confirm directory%'));
});

test('find segments a Chinese query into words', async () => {
  const [, wide] = await findIn('会话列表排序');
  assert.ok(wide.values.includes('%会话%'));
  assert.ok(wide.values.includes('%列表%'));
  assert.ok(wide.values.includes('%排序%'));
});

test('a one-word find runs once and is a single ILIKE, as it always was', async () => {
  const sql = await findIn('merge');
  assert.equal(sql.length, 1, 'nothing broader to try');
  assert.doesNotMatch(sql[0].sql, /AND \(text ILIKE/);
  assert.ok(sql[0].values.includes('%merge%'));
});

test("find's snippet prefers the whole phrase and falls back to the longest word", async () => {
  // strpos returns 0 when the phrase isn't there verbatim, which is exactly the row the word
  // fallback admitted — so the window has to be cut around a word instead of at character 1.
  const [, wide] = await findIn('the working directory');
  assert.match(wide.sql, /coalesce\(\s*nullif\(strpos\(lower\(text\), lower\(\?\)\), 0\),/);
  assert.ok(wide.values.includes('the working directory'), 'phrase anchor');
  assert.ok(wide.values.includes('directory'), 'longest-word anchor');
});

test('find strips markdown marks from the query before splitting it', async () => {
  // What the user read is "the merge button"; what is stored is the markdown source.
  const [phrase, wide] = await findIn('the **merge** button');
  assert.ok(phrase.values.includes('%the merge button%'));
  assert.ok(wide.values.includes('%merge%'));
  assert.ok(!wide.values.some((v) => typeof v === 'string' && v.includes('*')));
});

test('a query of nothing but marks or whitespace runs no search at all', async () => {
  assert.equal((await findIn('***')).length, 0);
  assert.equal((await findIn('   ')).length, 0);
});

// ── how many matched ──────────────────────────────────────────────────────────────────────────

test('a short page is its own total, and costs no second statement', async () => {
  // The ordinary search: fewer hits than the limit, so the LIMIT cut nothing and there is
  // nothing left to count.
  const sql = await findIn('merge', [page(3)], 10);
  assert.equal(sql.length, 1);
  const r = await findResult('merge', [page(3)], 10);
  assert.equal(r.total, 3);
  assert.equal(r.totalCapped, undefined);
});

test('a full page is counted separately, with the count able to stop early', async () => {
  const sql = await findIn('merge', [page(10)], 10);
  assert.equal(sql.length, 2, 'page, then count');
  // The LIMIT inside the count is the whole point: a query matching most of a huge session stops
  // at the ceiling instead of scanning all of it. Without it the count cannot stop early at all
  // (9038ms against 162ms on the 111k-event session).
  assert.match(sql[1].sql, /SELECT 1 FROM body WHERE .* LIMIT \?/s);
  assert.match(sql[1].sql, /count\(\*\)::int AS n/);
  assert.ok(sql[1].values.includes(1001), 'ceiling + 1, so overflow is visible');
});

test('a count that hit the ceiling reports a floor, not a number', async () => {
  const exact = await findResult('merge', [page(10), [{ n: 240 }]], 10);
  assert.equal(exact.total, 240);
  assert.equal(exact.totalCapped, undefined);

  const over = await findResult('merge', [page(10), [{ n: 1001 }]], 10);
  assert.equal(over.total, 1000, 'the ceiling itself, so the client shows "1000+"');
  assert.equal(over.totalCapped, true);
});

test('the count asks the same question the page did, broadened or not', async () => {
  // A count over a corpus or a predicate the page didn't use is just a wrong number.
  const [, wide, count] = await findIn('confirm directory', [[], page(10)], 10);
  assert.ok(wide.values.includes('%confirm%'));
  assert.ok(count.values.includes('%confirm%'), 'counts the words, not the phrase');
  assert.ok(!count.values.includes('%confirm directory%'));
});

// ── the ⌘K palette ────────────────────────────────────────────────────────────────────────────

test('the palette asks for the phrase first, and stops there when it finds anything', async () => {
  const sql = await palette('confirm directory', [[{ id: SESSION_ID, total: 1 }]]);
  assert.equal(sql.length, 1, 'a hit must not cost a second query');
  assert.ok(sql[0].values.includes('%confirm directory%'));
  assert.ok(!sql[0].values.includes('%confirm%'));
});

test('the palette broadens to words only once the phrase found nothing', async () => {
  const sql = await palette('confirm directory');
  assert.equal(sql.length, 2);
  assert.ok(sql[1].values.includes('%confirm%'));
  assert.ok(sql[1].values.includes('%directory%'));
  assert.ok(!sql[1].values.includes('%confirm directory%'));
});

test('the broadened palette query ANDs the words in every tier', async () => {
  const [, wide] = await palette('the merge button');
  // Conversation text, the session-side predicate, and the joined name tiers each have to ask
  // the same question, or a row admitted by one tier is dropped by the re-test in another.
  const ands = wide.sql.match(/ILIKE \?\) AND \(/g) ?? [];
  assert.ok(ands.length >= 6, `expected every tier to AND its words, saw ${ands.length}`);
  assert.equal(wide.values.filter((v) => v === '%merge%').length >= 3, true);
});

test('a palette query with nothing broader to try runs once', async () => {
  assert.equal((await palette('merge')).length, 1);
  assert.equal((await palette('的')).length, 1);
});

test("the palette's snippet falls back to the longest word too", async () => {
  const [, wide] = await palette('the working directory');
  assert.match(
    wide.sql,
    /coalesce\(\s*nullif\(strpos\(lower\(h\.match_text\), lower\(\?\)\), 0\),/,
  );
  assert.ok(wide.values.includes('directory'));
});

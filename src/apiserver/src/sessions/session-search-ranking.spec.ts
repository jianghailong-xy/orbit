import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { SessionsService } from './sessions.service';

/**
 * The ⌘K palette's ordering. Every property here replaced a lexicographic `ORDER BY match_field
 * bucket, last_turn_at` whose failure mode was invisible: on this owner's data a query for
 * "runner" matched 31 titles and ~640 conversations, and the 20-row page — which has no second
 * page to ask for — was 20 titles. The hits weren't ranked low, they were unreachable.
 *
 * Asserted against the generated SQL rather than a database, like the other search specs: the
 * shapes below are exactly the ones a well-meaning edit flattens back out.
 */

const OWNER_ID = 'c111a556-1094-4e98-90d0-f5f7fa74544c';

const captureSearch = async (query: string, limit = 20): Promise<Prisma.Sql> => {
  let captured: Prisma.Sql | undefined;
  const prisma = {
    $queryRaw: async (sql: Prisma.Sql) => {
      captured = sql;
      return [];
    },
  };
  const service = new SessionsService(prisma as never, {} as never, {} as never);
  await service.search(OWNER_ID, query, limit);
  assert.ok(captured);
  return captured;
};

/** Collapsed, so the assertions don't depend on how the template wraps. */
const flat = async (query: string): Promise<string> =>
  (await captureSearch(query)).sql.replace(/\s+/g, ' ');

test('the three conversation fields carry one weight, not three ranks', async () => {
  const sql = await flat('merge');
  // prompt is the first user message and reply is the last assistant one, both copied onto the
  // session row from run_event. Ranking them above 'message' ranked message #1 above message #2 —
  // a fact about the schema, not the search.
  assert.match(sql, /WHEN 'prompt' THEN 2 WHEN 'reply' THEN 2 WHEN 'message' THEN 2/);
  // And the ordering must not reintroduce the ranking it replaced.
  assert.ok(!/ORDER BY CASE/.test(sql), 'ordering fell back to a lexicographic bucket');
  assert.match(sql, /ORDER BY score DESC, "lastTurnAt" DESC NULLS LAST, "createdAt" DESC LIMIT/);
});

test('recency is summed into the score, so it can outweigh a staler but better-placed match', async () => {
  const sql = await flat('merge');
  // A title hit is 4 and a conversation hit is 2, so the 3-point same-day bonus is what lets a
  // conversation from this morning (2+3=5) pass a title untouched for a year (4+0=4). Lexicographic
  // ordering gave the field infinite priority and could never do that.
  assert.match(sql, /WHEN 'title' THEN 4/);
  assert.match(sql, /interval '1 day' THEN 3/);
  assert.match(sql, /interval '7 days' THEN 2/);
  assert.match(sql, /interval '30 days' THEN 1/);
});

test('an exact match outranks a prefix, which outranks a match buried mid-text', async () => {
  const sql = await captureSearch('deploy');
  const flattened = sql.sql.replace(/\s+/g, ' ');
  assert.match(flattened, /length\(h\.match_text\) = length\(\?\)/);
  assert.match(flattened, /h\.match_text ILIKE \? THEN 2/);
  // The anchored pattern is bound alongside the containing one, and escaped the same way.
  assert.ok(sql.values.includes('deploy%'), 'no anchored pattern bound for the prefix bonus');
  assert.ok(sql.values.includes('%deploy%'));
});

test('LIKE metacharacters stay literal in the prefix bonus too', async () => {
  const sql = await captureSearch('100%_done');
  assert.ok(sql.values.includes('100\\%\\_done%'), 'the anchored pattern escapes % and _');
});

test('an exact id match still wins outright', async () => {
  // Weight, not bucket, means id has to be weighted past anything the bonuses can add: the most a
  // recent exact-title hit can reach is 4+3+3.
  const sql = await flat('915d27d1');
  assert.match(sql, /WHEN 'id' THEN 1000/);
});

test('the name tier cannot take the whole page when there are conversation hits', async () => {
  const sql = await flat('merge');
  assert.match(sql, /PARTITION BY is_conversation/);
  // Half the page is reserved for conversation, and only as much of it as there is to reserve —
  // with no conversation hits, LEAST() is 0 and the name tier keeps every slot.
  assert.match(
    sql,
    /WHERE is_conversation OR group_rn <= \?::int - LEAST\(conv_total, \?::int \/ 2\)/,
  );
});

test('the match count is taken before the quota and the limit', async () => {
  const sql = await flat('merge');
  // count(*) OVER () in `ranked` sees every matching session; counting after the WHERE would
  // report the quota's own effect back as the total and always look consistent.
  assert.match(sql, /count\(\*\) OVER \(\) AS total/);
  assert.match(sql, /total::int AS "total"/);
});

test('an empty query answers with recents and reports its own length as the total', async () => {
  const prisma = {
    $queryRaw: async () => [
      { id: 'a', matchField: 'recent' },
      { id: 'b', matchField: 'recent' },
    ],
  };
  const service = new SessionsService(prisma as never, {} as never, {} as never);
  const res = await service.search(OWNER_ID, '', 20);
  // Recents isn't a search: the window count would be "every session you own", which reads as a
  // match count in the footer.
  assert.equal(res.total, 2);
  assert.equal(res.hits.length, 2);
});

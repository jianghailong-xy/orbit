/**
 * Did this help? / Did this answer it? and Admin → Help feedback (docs/mocks/help-center board 03, decision 3;
 * help/help-feedback.ts, migration 0880), held against the production apiserver — `build/main.js`, the whole
 * AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/help/help-feedback.pg.spec.ts
 *
 * Accounts: `admin` (ADMIN) and `member` (MEMBER). Against one server:
 *
 *   1. `help_feedback` has exactly the columns user_id, kind, item_id, helpful, created_at — no text column;
 *   2. a vote is stored as those five and nothing else, even when the body carries text beside them;
 *   3. a second vote on the same item replaces the first: one row, the later answer and time;
 *   4. an unknown article, an ill-formed answer id or a kind other than article / answer is refused, nothing written;
 *   5. signed out, a vote is a 401;
 *   6. the read is 403 to a member and a signed-out 401; to the admin, per-article Yes / No most No first, and the Ask
 *      answers as two totals — and no question, answer or person in the reply.
 *
 * Not destructive: every row belongs to accounts this run creates; counts are compared before and after.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const ARTICLE = 'machine-offline';
const OTHER = 'add-a-machine';

test('Help feedback: a vote is kind, id, Yes / No, time and person; the last one stands; admins read counts only', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await sql.end().catch(() => undefined);
  });

  const account = async (name: string, role: 'ADMIN' | 'MEMBER') => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    const email = `${name}-${RUN}@help-feedback.invalid`;
    await sql.query(
      `INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5)`,
      [id, email, `${name} ${RUN}`, hashPassword(password), role],
    );
    return { id, email, password };
  };
  const admin = await account('admin', 'ADMIN');
  const member = await account('member', 'MEMBER');

  server = await startApiserver(url, `help-feedback-${randomUUID()}`);
  const api = (method: string, route: string, bearer?: string, body?: unknown): Promise<Reply> =>
    call(server!, method, route, bearer, body);
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const adminToken = await signIn(admin);
  const memberToken = await signIn(member);
  const rowsOf = async (userId: string) =>
    (await sql.query(`SELECT * FROM "help_feedback" WHERE "user_id" = $1::uuid ORDER BY kind, item_id`, [userId])).rows;
  const vote = (bearer: string | undefined, body: unknown) => api('POST', '/api/help/feedback', bearer, body);
  const read = async () => {
    const reply = await api('GET', '/api/admin/help-feedback', adminToken);
    assert.equal(reply.status, 200, reply.text);
    return reply.json as { articles: { slug: string; title: string | null; yes: number; no: number }[]; answers: { yes: number; no: number } };
  };
  const countsOf = (summary: Awaited<ReturnType<typeof read>>, slug: string) =>
    summary.articles.find((a) => a.slug === slug) ?? { yes: 0, no: 0 };
  const answerId = `Ask${RUN}x:7`;
  const before = await read();

  await t.test('1. the table holds the five columns and no text column', async () => {
    const columns = (await sql.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'help_feedback' ORDER BY column_name`,
    )).rows.map((r) => `${r.column_name}:${r.data_type}`);
    assert.deepEqual(columns, [
      'created_at:timestamp without time zone',
      'helpful:boolean',
      'item_id:text',
      'kind:text',
      'user_id:uuid',
    ]);
  });

  await t.test('2. a vote is stored as kind, id, the boolean, its time and its person, and text beside it is not', async () => {
    const reply = await vote(memberToken, { kind: 'article', id: ARTICLE, helpful: false, text: 'the article is wrong', question: 'why?' });
    assert.equal(reply.status, 204, reply.text);
    const answered = await vote(memberToken, { kind: 'answer', id: answerId, helpful: true });
    assert.equal(answered.status, 204, answered.text);
    const rows = await rowsOf(member.id);
    assert.equal(rows.length, 2);
    for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['created_at', 'helpful', 'item_id', 'kind', 'user_id']);
    assert.deepEqual(rows.map((r) => [r.kind, r.item_id, r.helpful, r.user_id]), [
      ['answer', answerId, true, member.id],
      ['article', ARTICLE, false, member.id],
    ]);
    assert.ok(rows.every((r) => r.created_at instanceof Date));
    assert.equal(JSON.stringify(rows).includes('the article is wrong'), false);
  });

  await t.test('3. a repeat vote replaces the earlier one: one row, the later answer and time', async () => {
    const first = (await rowsOf(member.id)).find((r) => r.kind === 'article')!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await vote(memberToken, { kind: 'article', id: ARTICLE, helpful: true })).status, 204);
    const rows = (await rowsOf(member.id)).filter((r) => r.kind === 'article');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].helpful, true);
    assert.ok(rows[0].created_at.getTime() > first.created_at.getTime());
    // And back to No, which is what it will be counted as.
    assert.equal((await vote(memberToken, { kind: 'article', id: ARTICLE, helpful: false })).status, 204);
    assert.equal((await rowsOf(member.id)).filter((r) => r.kind === 'article' && r.helpful === false).length, 1);
  });

  await t.test('4. an unknown article, an ill-formed answer id or another kind writes nothing', async () => {
    const was = (await rowsOf(member.id)).length;
    assert.equal((await vote(memberToken, { kind: 'article', id: 'no-such-article', helpful: true })).status, 404);
    assert.equal((await vote(memberToken, { kind: 'answer', id: 'not an answer', helpful: true })).status, 400);
    assert.equal((await vote(memberToken, { kind: 'answer', id: 'session-without-seq', helpful: true })).status, 404);
    assert.equal((await vote(memberToken, { kind: 'question', id: ARTICLE, helpful: true })).status, 400);
    assert.equal((await vote(memberToken, { kind: 'article', id: ARTICLE, helpful: 'yes' })).status, 400);
    assert.equal((await rowsOf(member.id)).length, was);
  });

  await t.test('5. signed out, a vote is refused', async () => {
    assert.equal((await vote(undefined, { kind: 'article', id: ARTICLE, helpful: true })).status, 401);
  });

  await t.test('6. the read is 403 to a member; to the admin, counts per article most No first and the Ask totals', async () => {
    assert.equal((await api('GET', '/api/admin/help-feedback', memberToken)).status, 403);
    assert.equal((await api('GET', '/api/admin/help-feedback')).status, 401);
    // The admin's own votes: Yes on another article, No on the member's article, No on an answer.
    for (const body of [
      { kind: 'article', id: OTHER, helpful: true },
      { kind: 'article', id: ARTICLE, helpful: false },
      { kind: 'answer', id: `Adm${RUN}y:3`, helpful: false },
    ]) assert.equal((await vote(adminToken, body)).status, 204);
    const after = await read();
    assert.deepEqual(
      { yes: countsOf(after, ARTICLE).yes - countsOf(before, ARTICLE).yes, no: countsOf(after, ARTICLE).no - countsOf(before, ARTICLE).no },
      { yes: 0, no: 2 },
    );
    assert.equal(countsOf(after, OTHER).yes - countsOf(before, OTHER).yes, 1);
    assert.deepEqual({ yes: after.answers.yes - before.answers.yes, no: after.answers.no - before.answers.no }, { yes: 1, no: 1 });
    const article = after.articles.find((a) => a.slug === ARTICLE)!;
    assert.deepEqual(Object.keys(article).sort(), ['category', 'no', 'slug', 'title', 'yes']);
    assert.equal(typeof article.title, 'string');
    assert.deepEqual(Object.keys(after).sort(), ['answers', 'articles']);
    assert.deepEqual(Object.keys(after.answers).sort(), ['no', 'yes']);
    const nos = after.articles.map((a) => a.no);
    assert.deepEqual(nos, [...nos].sort((a, b) => b - a), 'most No first');
    const text = JSON.stringify(after);
    for (const leak of [answerId, `Adm${RUN}y:3`, member.id, admin.id, member.email]) assert.equal(text.includes(leak), false, leak);
  });
});

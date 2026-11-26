/**
 * The help center's Ask, answered on the server's DeepSeek key (docs/mocks/help-center board 02; help/help-ask.ts,
 * help/help-ask-answer.ts, migration 1668), held against the production apiserver — `build/main.js`, the whole
 * AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, with DeepSeek played by a
 * stub on 127.0.0.1 (DEEPSEEK_BASE_URL):
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/help/help-ask.pg.spec.ts
 *
 * Two accounts, MEMBERs; the owner has a machine, `build-box`. Against one server:
 *
 *   1. a question that says nothing, is too long, or comes with a page of the wrong shape is refused, and nothing is
 *      written;
 *   2. asking writes the Ask working and returns at once; the server asks DeepSeek on its own key with the rules,
 *      every article a member may read (no administrators' one), the account read (the machine by name) and the page,
 *      then the question; the answer lands on the Ask, answered;
 *   3. a follow-up is asked with the conversation so far; while it is being answered, another is refused;
 *   4. DeepSeek failing leaves the Ask failed with why, and the person can ask again;
 *   5. /help → Your questions lists the Ask with the page it came from; another account sees none of it;
 *   6. another account: the Ask is not there to read or to follow up, and nothing is written or asked;
 *   7. a server with no DeepSeek key refuses a question HELP_ASK_NO_KEY, and writes nothing.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { startDeepSeekStub, type DeepSeekStubCall } from '../test-support/deepseek-stub';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const KEY = 'test-deepseek-key';
const PAGE = { route: '/settings/machines', label: 'Settings → Machines', errors: ['build-box is offline'] };
const QUESTION = 'Why is build-box offline?';
const ANSWER = 'build-box last checked in 2 h ago, so it reads Offline [1].\n\nSources:\n[1] [A machine shows Offline](orbit:/help/machines-and-engines/machine-offline)';
const FOLLOW_UP = 'It is awake now. What next?';

const lastUser = (c: DeepSeekStubCall) => [...(c.body.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';

test('Ask: the server answers on its DeepSeek key, from the articles and the account', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  let release: () => void = () => undefined;
  const held = () => new Promise<void>((resolve) => { release = resolve; });
  let hold: Promise<void> | null = null;
  const deepSeek = await startDeepSeekStub(async (c) => {
    const question = lastUser(c);
    if (question.includes('FAIL')) return 503;
    if (question.includes('SLOW') && hold) await hold;
    return question === QUESTION ? ANSWER : `Answer to: ${question}`;
  });
  const servers: Apiserver[] = [];
  t.after(async () => {
    release();
    for (const s of servers) await s.stop();
    await deepSeek.stop();
    await sql.end().catch(() => undefined);
  });

  const account = async (name: string) => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    const email = `${name}-${RUN}@help-ask.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [id, email, name, hashPassword(password)]);
    return { id, email, password };
  };
  const owner = await account('owner');
  const stranger = await account('stranger');

  const server = await startApiserver(url, `help-ask-${randomUUID()}`, { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: deepSeek.url });
  servers.push(server);
  const api = (method: string, route: string, bearer?: string, body?: unknown, on: Apiserver = server): Promise<Reply> =>
    call(on, method, route, bearer, body);
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const ownerToken = await signIn(owner);
  const strangerToken = await signIn(stranger);

  const boxName = `build-box-${RUN}`;
  const minted = await api('POST', '/api/runners/enrollment-tokens', ownerToken, { label: `help ask ${RUN}` });
  assert.equal(minted.status, 201, minted.text);
  const registered = await api('POST', '/api/runner/register', undefined, { enrollmentToken: minted.json.token, name: boxName, hostname: boxName });
  assert.equal(registered.status, 201, registered.text);

  const asksOf = async (ownerId: string) =>
    Number((await sql.query(`SELECT count(*) AS n FROM "help_ask_conversation" WHERE "owner_id" = $1::uuid`, [ownerId])).rows[0].n);
  /** The Ask once it is not working, read as the drawer reads it. */
  const settled = async (id: string, bearer = ownerToken) => {
    for (let i = 0; i < 100; i++) {
      const reply = await api('GET', `/api/help/ask/${uuidToBase62(id)}`, bearer);
      assert.equal(reply.status, 200, reply.text);
      if (reply.json.status !== 'working') return reply.json;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Ask ${id} still working`);
  };
  let askId = '';

  await t.test('1. a question that says nothing, is too long, or has a malformed page is refused', async () => {
    for (const [what, body] of [
      ['no question', { content: '   ' }],
      ['no body', null],
      ['too long', { content: 'x'.repeat(4_001) }],
      ['a page of the wrong shape', { content: QUESTION, page: { route: 'x' } }],
    ] as const) {
      const reply = await api('POST', '/api/help/ask', ownerToken, body);
      assert.equal(reply.status, 400, `${what}: ${reply.text}`);
    }
    assert.equal(await asksOf(owner.id), 0, 'nothing written');
    assert.equal(deepSeek.calls.length, 0, 'and DeepSeek not asked');
  });

  await t.test('2. asking: written working, answered on the server\'s key from the articles and the account', async () => {
    const made = await api('POST', '/api/help/ask', ownerToken, { content: ` ${QUESTION} `, page: PAGE });
    assert.equal(made.status, 201, made.text);
    askId = toUuid(made.json.id);
    const ask = await settled(askId);
    assert.equal(ask.status, 'answered', JSON.stringify(ask));
    assert.equal(ask.title, QUESTION);
    assert.deepEqual(ask.page, PAGE);
    assert.deepEqual(ask.messages.map((m: { role: string; text: string }) => [m.role, m.text]), [['user', QUESTION], ['assistant', ANSWER]]);

    assert.equal(deepSeek.calls.length, 1);
    const [sent] = deepSeek.calls;
    assert.equal(sent.authorization, `Bearer ${KEY}`, 'on the server\'s own key');
    const [library, context, ...conversation] = sent.body.messages!;
    assert.equal(library.role, 'system');
    assert.match(library.content, /You are Orbit's help assistant/u, 'the rules');
    assert.match(library.content, /Link: orbit:\/help\/machines-and-engines\/machine-offline/u, 'the articles, each with its link');
    assert.doesNotMatch(library.content, /orbit:\/help\/admin-and-self-hosting\//u, 'no administrators\' article for a member');
    assert.equal(context.role, 'system');
    assert.ok(context.content.includes(boxName), `the account read names the machine: ${context.content.slice(0, 400)}`);
    assert.ok(context.content.includes(PAGE.label) && context.content.includes(PAGE.errors[0]), 'and the page it was asked from');
    assert.deepEqual(conversation, [{ role: 'user', content: QUESTION }]);
  });

  await t.test('3. a follow-up carries the conversation; another while it is answered is refused', async () => {
    hold = held();
    const slow = `${FOLLOW_UP} SLOW`;
    const followed = await api('POST', `/api/help/ask/${uuidToBase62(askId)}/messages`, ownerToken, { content: slow });
    assert.equal(followed.status, 201, followed.text);
    assert.equal(followed.json.status, 'working');
    const second = await api('POST', `/api/help/ask/${uuidToBase62(askId)}/messages`, ownerToken, { content: 'and another' });
    assert.deepEqual([second.status, second.json?.code], [409, 'HELP_ASK_WORKING'], second.text);
    release();
    hold = null;
    const ask = await settled(askId);
    assert.equal(ask.status, 'answered');
    assert.deepEqual(ask.messages.map((m: { text: string }) => m.text), [QUESTION, ANSWER, slow, `Answer to: ${slow}`]);
    const last = deepSeek.calls.at(-1)!;
    assert.deepEqual(last.body.messages!.slice(2), [
      { role: 'user', content: QUESTION },
      { role: 'assistant', content: ANSWER },
      { role: 'user', content: slow },
    ]);
  });

  await t.test('4. DeepSeek failing leaves the Ask failed with why, and it can be asked again', async () => {
    const failing = await api('POST', `/api/help/ask/${uuidToBase62(askId)}/messages`, ownerToken, { content: 'FAIL now' });
    assert.equal(failing.status, 201, failing.text);
    const failed = await settled(askId);
    assert.equal(failed.status, 'failed');
    const last = failed.messages.at(-1);
    assert.equal(last.role, 'assistant');
    assert.match(last.error, /503/u);
    const again = await api('POST', `/api/help/ask/${uuidToBase62(askId)}/messages`, ownerToken, { content: 'Once more' });
    assert.equal(again.status, 201, again.text);
    assert.equal((await settled(askId)).status, 'answered');
    // The failed exchange's empty answer is not sent as something DeepSeek said.
    const sent = deepSeek.calls.at(-1)!.body.messages!.slice(2);
    assert.deepEqual(sent.slice(-2), [{ role: 'user', content: 'FAIL now' }, { role: 'user', content: 'Once more' }]);
  });

  await t.test('5. Your questions lists the Ask; another account sees none of it', async () => {
    const list = await api('GET', '/api/help/ask/conversations', ownerToken);
    assert.equal(list.status, 200, list.text);
    assert.equal(list.json.questions.length, 1, list.text);
    const [row] = list.json.questions;
    assert.deepEqual([toUuid(row.id), row.title, row.origin, row.outcome, row.sentTo], [askId, QUESTION, PAGE.label, 'answered', null]);
    const theirs = await api('GET', '/api/help/ask/conversations', strangerToken);
    assert.deepEqual(theirs.json.questions, []);
  });

  await t.test('6. another account: not there to read or to follow up, and nothing written or asked', async () => {
    const before = (await api('GET', `/api/help/ask/${uuidToBase62(askId)}`, ownerToken)).json;
    const calls = deepSeek.calls.length;
    const read = await api('GET', `/api/help/ask/${uuidToBase62(askId)}`, strangerToken);
    assert.equal(read.status, 404, read.text);
    const followed = await api('POST', `/api/help/ask/${uuidToBase62(askId)}/messages`, strangerToken, { content: 'mine now' });
    assert.equal(followed.status, 404, followed.text);
    assert.deepEqual((await api('GET', `/api/help/ask/${uuidToBase62(askId)}`, ownerToken)).json, before, 'the owner\'s Ask unchanged');
    assert.equal(deepSeek.calls.length, calls, 'DeepSeek not asked');
    assert.equal(await asksOf(stranger.id), 0);
  });

  await t.test('7. a server with no DeepSeek key refuses a question, and writes nothing', async () => {
    const keyless = await startApiserver(url, `help-ask-keyless-${randomUUID()}`, { DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: deepSeek.url });
    servers.push(keyless);
    const login = await api('POST', '/api/auth/login', undefined, { email: owner.email, password: owner.password }, keyless);
    const before = await asksOf(owner.id);
    const refused = await api('POST', '/api/help/ask', login.json.accessToken, { content: QUESTION }, keyless);
    assert.deepEqual([refused.status, refused.json?.code], [503, 'HELP_ASK_NO_KEY'], refused.text);
    const follow = await api('POST', `/api/help/ask/${uuidToBase62(askId)}/messages`, login.json.accessToken, { content: QUESTION }, keyless);
    assert.deepEqual([follow.status, follow.json?.code], [503, 'HELP_ASK_NO_KEY'], follow.text);
    assert.equal(await asksOf(owner.id), before);
  });
});

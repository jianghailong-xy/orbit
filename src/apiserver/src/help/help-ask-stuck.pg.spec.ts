/**
 * Still stuck (docs/mocks/help-center board 02 ② right frame, side note 5; help/help-ask.ts#stuck and #askAdmin,
 * migration 0890), held against the production apiserver — `build/main.js`, the whole AppModule — over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/help/help-ask-stuck.pg.spec.ts
 *
 * Accounts: `admin` (ADMIN, the instance's longest-standing), `member` and `stranger` (MEMBER). The member and the
 * admin each ask on their own machine. Against one server, started with ORBIT_RELEASE_REPOSITORY set:
 *
 *   1. what Still stuck offers a member: the admin by name, the release repository, the machine's runner version, OS
 *      and last heartbeat, and the member's own workspace and repository names for a report to leave out;
 *   2. an admin is offered no Ask your admin, and is refused one: nothing is written;
 *   3. another account's Ask is the 404 of one that is not there, on both routes: no task, no hand-off row;
 *   4. Ask your admin makes an ordinary task in the admin's own task list — theirs, in no workspace, not started —
 *      holding the question, the answer and a link to the Ask; the admin's event stream is told, the member's is not;
 *      and nothing goes through the Waiting on you inbox (no owner request);
 *   5. asked again, it answers with the same task and makes no other;
 *   6. /help → Your questions says With your admin, and who it was sent to.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HELP_ASK_V1, toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const ENGINES = [{ engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' }];
const QUESTION = 'Why is build-box offline?';
const ANSWER = 'build-box went to sleep [1]. Wake it, then turn off sleep while plugged in.';
const REPOSITORY = 'acme/orbit-fork';

/** Everything `GET /api/events` sends one account for `ms`, as text. */
function listen(port: number, bearer: string, ms: number): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { authorization: `Bearer ${bearer}` } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
    });
    req.on('error', () => undefined);
    setTimeout(() => { req.destroy(); resolve(text); }, ms);
  });
}

test('Still stuck: Ask your admin is a task in an admin\'s list, and a report carries the machine and no names', {
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

  const account = async (name: string, role: 'ADMIN' | 'MEMBER', createdAt?: string) => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    const email = `${name}-${RUN}@help-stuck.invalid`;
    await sql.query(
      `INSERT INTO "user" (id, email, name, password_hash, role, created_at) VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamp, now()))`,
      [id, email, `${name} ${RUN}`, hashPassword(password), role, createdAt ?? null],
    );
    return { id, email, password, name: `${name} ${RUN}` };
  };
  // The longest-standing admin of the instance, whatever else this database holds.
  const admin = await account('admin', 'ADMIN', '1990-01-01T00:00:00Z');
  const member = await account('member', 'MEMBER');
  const stranger = await account('stranger', 'MEMBER');

  server = await startApiserver(url, `help-stuck-${randomUUID()}`, { ORBIT_RELEASE_REPOSITORY: `https://github.com/${REPOSITORY}.git` });
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, route, bearer, body, headers);
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const adminToken = await signIn(admin);
  const memberToken = await signIn(member);
  const strangerToken = await signIn(stranger);

  const machine = async (bearer: string, name: string) => {
    const minted = await api('POST', '/api/runners/enrollment-tokens', bearer, { label: `help stuck ${RUN}` });
    assert.equal(minted.status, 201, minted.text);
    const registered = await api('POST', '/api/runner/register', undefined, { enrollmentToken: minted.json.token, name, hostname: name, version: '0.1.255' });
    assert.equal(registered.status, 201, registered.text);
    const beat = await api('POST', '/api/runner/heartbeat', registered.json.runnerToken, { status: 'ONLINE', engines: ENGINES, version: '0.1.255' },
      { 'x-orbit-runner-capabilities': HELP_ASK_V1, 'x-orbit-runner-os': 'linux' });
    assert.equal(beat.status < 300, true, beat.text);
    return { runnerId: toUuid(registered.json.runnerId), name };
  };
  const ask = async (bearer: string, runnerId: string) => {
    const reply = await api('POST', '/api/help/ask', bearer, { content: QUESTION, runnerId: uuidToBase62(runnerId), engine: 'claude' });
    assert.equal(reply.status, 201, reply.text);
    return toUuid(reply.json.sessionId);
  };
  const memberBox = await machine(memberToken, `build-box-${RUN}`);
  const adminBox = await machine(adminToken, `admin-box-${RUN}`);
  const memberAsk = await ask(memberToken, memberBox.runnerId);
  const adminAsk = await ask(adminToken, adminBox.runnerId);
  // The member's code, by the names a report must leave out.
  await sql.query(
    `INSERT INTO "workspace" (id, name, owner_id, runner_id, work_dir, repo_url) VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), `payments-${RUN}`, member.id, memberBox.runnerId, `/srv/billing-worker-${RUN}`, `git@github.com:acme-corp/payments-api-${RUN}.git`],
  );

  const tasksOf = async (ownerId: string) =>
    (await sql.query(`SELECT * FROM "task" WHERE "owner_id" = $1::uuid ORDER BY created_at`, [ownerId])).rows;
  const handoffs = async () =>
    (await sql.query(`SELECT * FROM "help_ask_admin_request" WHERE "session_id" IN ($1::uuid, $2::uuid)`, [memberAsk, adminAsk])).rows;
  const ownerRequests = async (ownerId: string) =>
    Number((await sql.query(`SELECT count(*) AS n FROM "owner_request" WHERE "owner_id" = $1::uuid`, [ownerId])).rows[0].n);
  const body = { exchanges: [{ question: QUESTION, answer: ANSWER }] };

  await t.test('1. a member is offered the admin by name, and a report its machine and the names to leave out', async () => {
    const reply = await api('GET', `/api/help/ask/${uuidToBase62(memberAsk)}/stuck`, memberToken);
    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(reply.json.admin, { name: admin.name });
    assert.equal(reply.json.sentToAdmin, null);
    assert.equal(reply.json.report.repository, REPOSITORY, 'the release repository as ORBIT_RELEASE_REPOSITORY names it');
    const m = reply.json.report.machine;
    assert.equal(m.name, memberBox.name);
    assert.equal(m.runnerVersion, '0.1.255');
    assert.equal(m.os, 'linux');
    assert.ok(Date.now() - Date.parse(m.lastHeartbeatAt) < 10 * 60_000, `a recent heartbeat: ${m.lastHeartbeatAt}`);
    const names = reply.json.report.privateNames as string[];
    for (const name of [`payments-${RUN}`, `billing-worker-${RUN}`, `acme-corp/payments-api-${RUN}`, `payments-api-${RUN}`]) {
      assert.ok(names.includes(name), `${name} in ${JSON.stringify(names)}`);
    }
  });

  await t.test('2. an admin is offered no Ask your admin, and is refused one with nothing written', async () => {
    const reply = await api('GET', `/api/help/ask/${uuidToBase62(adminAsk)}/stuck`, adminToken);
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.json.admin, null);
    const before = (await tasksOf(admin.id)).length;
    const refused = await api('POST', `/api/help/ask/${uuidToBase62(adminAsk)}/admin`, adminToken, body);
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.json.code, 'HELP_ASK_NO_ADMIN');
    assert.equal((await tasksOf(admin.id)).length, before);
    assert.deepEqual(await handoffs(), []);
  });

  await t.test('3. another account: the Ask is not there, on both routes, and nothing is written', async () => {
    const read = await api('GET', `/api/help/ask/${uuidToBase62(memberAsk)}/stuck`, strangerToken);
    assert.equal(read.status, 404, read.text);
    const before = (await tasksOf(admin.id)).length;
    const sent = await api('POST', `/api/help/ask/${uuidToBase62(memberAsk)}/admin`, strangerToken, body);
    assert.equal(sent.status, 404, sent.text);
    assert.equal((await tasksOf(admin.id)).length, before);
    assert.equal((await tasksOf(stranger.id)).length, 0);
    assert.deepEqual(await handoffs(), []);
    // An ordinary session is not an Ask either.
    const malformed = await api('POST', `/api/help/ask/${uuidToBase62(memberAsk)}/admin`, memberToken, { exchanges: [] });
    assert.equal(malformed.status, 400, malformed.text);
  });

  let taskId = '';
  await t.test('4. Ask your admin: a task in the admin\'s own list, announced to the admin, with no Waiting on you', async () => {
    const requestsBefore = await ownerRequests(admin.id);
    const adminHears = listen(server!.port, adminToken, 4_000);
    const memberHears = listen(server!.port, memberToken, 4_000);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const reply = await api('POST', `/api/help/ask/${uuidToBase62(memberAsk)}/admin`, memberToken, body);
    assert.equal(reply.status, 201, reply.text);
    assert.equal(reply.json.adminName, admin.name);
    taskId = toUuid(reply.json.taskId);

    const [task] = (await sql.query(`SELECT * FROM "task" WHERE "id" = $1::uuid`, [taskId])).rows;
    assert.equal(task.owner_id, admin.id, 'the admin\'s task');
    assert.equal(task.assignee_id, null, 'in no workspace: a person\'s task');
    assert.equal(task.status, 'OPEN');
    assert.equal(task.auto_run_when_ready, false, 'not started by itself');
    assert.equal(task.creator_type, 'USER');
    assert.equal(task.creator_id, member.id, 'written by the member');
    assert.equal(task.title, `Help: ${QUESTION}`);
    assert.match(task.description, new RegExp(`${member.name} \\(${member.email}\\) asked Orbit's help`));
    assert.ok(task.description.includes(QUESTION), 'the question');
    assert.ok(task.description.includes(ANSWER), 'the answer');
    assert.ok(task.description.includes(`/help/questions/${uuidToBase62(memberAsk)}`), 'a link to the Ask');

    // In the admin's task list, as every task of theirs is; not in the member's.
    const adminList = await api('GET', '/api/tasks', adminToken);
    assert.equal(adminList.status, 200, adminList.text);
    const rows = (Array.isArray(adminList.json) ? adminList.json : adminList.json.items ?? adminList.json.tasks) as Array<{ id: string }>;
    assert.ok(rows.some((r) => toUuid(r.id) === taskId), 'in the admin\'s task list');
    const memberList = await api('GET', '/api/tasks', memberToken);
    const memberRows = (Array.isArray(memberList.json) ? memberList.json : memberList.json.items ?? memberList.json.tasks) as Array<{ id: string }>;
    assert.ok(!memberRows.some((r) => toUuid(r.id) === taskId), 'not in the member\'s');

    // The usual new-task notification: the admin's stream hears of a task change; the member's does not.
    const [heardByAdmin, heardByMember] = await Promise.all([adminHears, memberHears]);
    assert.match(heardByAdmin, /task[._]changed/u, `the admin's stream: ${heardByAdmin.slice(0, 400)}`);
    assert.doesNotMatch(heardByMember, /task[._]changed/u, 'the member is not told of the admin\'s task');

    // Nothing goes through the Waiting on you inbox.
    assert.equal(await ownerRequests(admin.id), requestsBefore);
    assert.equal(await ownerRequests(member.id), 0);
    const rowsAfter = await handoffs();
    assert.equal(rowsAfter.length, 1);
    assert.deepEqual([rowsAfter[0].owner_id, rowsAfter[0].admin_id, rowsAfter[0].task_id], [member.id, admin.id, taskId]);
  });

  await t.test('5. asked again, the same task, and no other', async () => {
    const count = (await tasksOf(admin.id)).length;
    const reply = await api('POST', `/api/help/ask/${uuidToBase62(memberAsk)}/admin`, memberToken, body);
    assert.equal(reply.status, 201, reply.text);
    assert.equal(toUuid(reply.json.taskId), taskId);
    assert.equal((await tasksOf(admin.id)).length, count);
    const stuck = await api('GET', `/api/help/ask/${uuidToBase62(memberAsk)}/stuck`, memberToken);
    assert.equal(stuck.json.sentToAdmin.adminName, admin.name);
  });

  await t.test('6. Your questions says With your admin, and who it went to', async () => {
    // Answered, as an Ask is by the time its person says it did not help: no machine runs in this spec, so the
    // session is settled the way its runner would leave it. Still PENDING, it reads Working, which outranks this.
    await sql.query(`UPDATE "session" SET "turn_state" = NULL WHERE "id" IN ($1::uuid, $2::uuid)`, [memberAsk, adminAsk]);
    const reply = await api('GET', '/api/help/ask/sessions', memberToken);
    assert.equal(reply.status, 200, reply.text);
    const row = (reply.json.questions as Array<{ sessionId: string; outcome: string; sentTo: string | null }>)
      .find((q) => toUuid(q.sessionId) === memberAsk)!;
    assert.equal(row.outcome, 'with-admin');
    assert.equal(row.sentTo, admin.name);
    const adminRows = (await api('GET', '/api/help/ask/sessions', adminToken)).json.questions as Array<{ outcome: string; sentTo: string | null }>;
    assert.ok(adminRows.every((q) => q.outcome !== 'with-admin' && q.sentTo === null), 'the admin\'s own Ask was sent nowhere');
  });
});

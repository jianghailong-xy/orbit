/**
 * The session-based Ask made before migration 1668 (help/help-ask-reads.ts, migration 0850), held against the
 * production apiserver — `build/main.js`, the whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/help/help-ask-session.pg.spec.ts
 *
 * A new Ask is answered on the server's DeepSeek key (help-ask.pg.spec.ts) and is no session; one made before is a
 * session marked by `help_ask` on one of the person's machines, and what keeps it read-only still holds. Two accounts;
 * the owner's machines: `ask` (online, declares help-ask/v1), `old` (online, does not), `asleep` (never beats). The Ask
 * session is written as 0850's Ask was. Against one server:
 *
 *   1. `help_ask` is written by the INSERT alone: an UPDATE that sets, changes or clears it is refused;
 *   2. the four reads answer an Ask session of the runner's own, and 404 everyone else;
 *   3. the fence: an Ask's tools (the runner credential, `x-orbit-runner-caller`, its session header) are refused
 *      HELP_ASK_READ_ONLY at EVERY other runner door the app mounts, read or write; an ordinary session is not fenced.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { HELP_ASK_V1, toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { handlersOf, mountedControllers } from '../auth/route-census';
import { hashPassword } from '../common/crypto.util';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { HELP_ASK_ALLOWED_RUNNER_ROUTES } from './help-ask-reads';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const ENGINES = [
  { engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' },
  { engine: 'codex', installed: true, auth: 'yes', version: '0.169.0' },
];
const PAGE = { route: '/settings/machines', label: 'Settings → Machines', errors: ['build-box is offline'] };

test('a session-based Ask stays read-only', {
  skip: !URL_, concurrency: 1, timeout: 900_000,
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

  server = await startApiserver(url, `help-ask-${randomUUID()}`);
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, route, bearer, body, headers);
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const ownerToken = await signIn(owner);
  const strangerToken = await signIn(stranger);

  const register = async (bearer: string, name: string) => {
    const minted = await api('POST', '/api/runners/enrollment-tokens', bearer, { label: `help ask ${RUN}` });
    assert.equal(minted.status, 201, minted.text);
    const registered = await api('POST', '/api/runner/register', undefined, { enrollmentToken: minted.json.token, name, hostname: name });
    assert.equal(registered.status, 201, registered.text);
    return { runnerId: toUuid(registered.json.runnerId), token: registered.json.runnerToken as string, name };
  };
  const beat = async (machine: { token: string }, capabilities: string) => {
    const reply = await api('POST', '/api/runner/heartbeat', machine.token, { status: 'ONLINE', engines: ENGINES },
      { 'x-orbit-runner-capabilities': capabilities });
    assert.equal(reply.status < 300, true, reply.text);
  };
  const ask = await register(ownerToken, `ask-${RUN}`);
  const old = await register(ownerToken, `old-${RUN}`);
  const asleep = await register(ownerToken, `asleep-${RUN}`);
  const theirs = await register(strangerToken, `theirs-${RUN}`);
  await beat(ask, `source-pin/v1,${HELP_ASK_V1}`);
  await beat(old, 'source-pin/v1');
  await beat(theirs, HELP_ASK_V1);
  const pub = (id: string) => uuidToBase62(id);

  // An ordinary session in a workspace on the same machine, to tell the lists apart.
  const workspaceId = randomUUID();
  await sql.query(
    `INSERT INTO "workspace" (id, name, owner_id, runner_id, work_dir) VALUES ($1, $2, $3, $4, $5)`,
    [workspaceId, `ws-${RUN}`, owner.id, ask.runnerId, `/srv/ws-${RUN}`],
  );
  const ordinary = await api('POST', '/api/sessions', ownerToken, { prompt: 'an ordinary session', workspaceId: pub(workspaceId) });
  assert.equal(ordinary.status, 201, ordinary.text);
  const ordinaryId = toUuid(ordinary.json.id);

  // The Ask, as 0850's Ask was written: a session on the owner's machine with `help_ask`, in no workspace. A run that
  // succeeded, in the facts it is written with since deploy D3 (migration 1671 stores the word SUCCEEDED from them).
  const askId = randomUUID();
  await sql.query(
    `INSERT INTO "session" ("id", "title", "prompt", "owner_id", "creator_id", "updated_at", "started_at", "finished_at",
                            "end_reason", "assigned_runner_id", "engine", "help_ask")
     VALUES ($1, 'Why is build-box offline?', 'Why is build-box offline?', $2, $2, now(), now(), now(), 'task_done', $3, 'claude', $4::jsonb)`,
    [askId, owner.id, ask.runnerId, JSON.stringify({ page: PAGE })],
  );

  await t.test('1. help_ask is written by the INSERT alone', async () => {
    for (const [what, id, value] of [
      ['clearing it', askId, null],
      ['changing it', askId, JSON.stringify({ page: null })],
      ['setting it on an ordinary session', ordinaryId, JSON.stringify({ page: null })],
    ] as const) {
      await assert.rejects(
        sql.query(`UPDATE "session" SET "help_ask" = $2::jsonb WHERE "id" = $1::uuid`, [id, value]),
        /HELP_ASK_IMMUTABLE/u,
        what,
      );
    }
  });

  await t.test('2. the four reads answer an Ask session of the runner\'s own, and nobody else', async () => {
    const asAsk = { 'x-orbit-session-id': pub(askId), 'x-orbit-runner-caller': 'mcp' };
    const machines = await api('GET', '/api/runner/help-ask/machines', ask.token, undefined, asAsk);
    assert.equal(machines.status, 200, `${machines.text}\n${server!.output().slice(-4000)}`);
    const named = new Map((machines.json.machines as Array<Record<string, unknown>>).map((m) => [m.name, m]));
    assert.deepEqual([named.get(ask.name)?.online, named.get(asleep.name)?.online], [true, false], machines.text);
    assert.equal(typeof named.get(ask.name)?.lastHeartbeatAt, 'string', 'with its last heartbeat');
    const sessions = await api('GET', '/api/runner/help-ask/sessions', ask.token, undefined, asAsk);
    assert.equal(sessions.status, 200, `${sessions.text}\n${server!.output().slice(-4000)}`);
    const listed = (sessions.json.sessions as Array<{ id: string; status: string }>).map((s) => toUuid(s.id));
    assert.ok(listed.includes(ordinaryId) && !listed.includes(askId), 'the account\'s sessions with their status, Asks left out');
    assert.ok(!('prompt' in sessions.json.sessions[0]), 'and never what was said in them');
    for (const read of ['tasks', 'quota']) {
      const reply = await api('GET', `/api/runner/help-ask/${read}`, ask.token, undefined, asAsk);
      assert.equal(reply.status, 200, `${read}: ${reply.text}\n${server!.output().slice(-4000)}`);
    }
    const refusals: Array<[string, string, Record<string, string>]> = [
      ['an ordinary session', ask.token, { 'x-orbit-session-id': pub(ordinaryId) }],
      ['no session', ask.token, {}],
      ['another machine of the owner\'s', old.token, asAsk],
      ["another account's machine", theirs.token, asAsk],
    ];
    for (const [what, token, headers] of refusals) {
      const reply = await api('GET', '/api/runner/help-ask/machines', token, undefined, headers);
      assert.equal(reply.status, 404, `${what}: ${reply.text}`);
    }
    // No fifth read: the fence refuses it before any door is looked for.
    const fifth = await api('GET', '/api/runner/help-ask/files', ask.token, undefined, asAsk);
    assert.deepEqual([fifth.status, fifth.json?.code], [403, 'HELP_ASK_READ_ONLY'], 'no fifth read');
  });

  await t.test('3. an Ask\'s tools reach no other runner door, read or write', async () => {
    const asAsk = { 'x-orbit-session-id': pub(askId), 'x-orbit-runner-caller': 'mcp' };
    const asOrdinary = { 'x-orbit-session-id': pub(ordinaryId), 'x-orbit-runner-caller': 'mcp' };
    const allowed = new Set(HELP_ASK_ALLOWED_RUNNER_ROUTES.map((r) => `${r.method} ${r.path}`));
    const routes: Array<[string, string]> = [];
    for (const controller of await mountedControllers()) {
      const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
      for (const [, handler] of handlersOf(controller)) {
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
        const paths = ([] as string[]).concat(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
        for (const sub of paths) {
          const full = ('/' + [base, sub].map((p) => p.replace(/^\/+|\/+$/gu, '')).filter(Boolean).join('/'));
          if (full === '/runner' || full.startsWith('/runner/')) routes.push([method, full]);
        }
      }
    }
    assert.ok(routes.length > 100, `the census found the runner doors (${routes.length})`);
    const id = pub(randomUUID());
    let fenced = 0;
    for (const [method, route] of routes) {
      const concrete = route.replace(/:[A-Za-z]+/gu, id).replace(/\*[A-Za-z]*/gu, 'x');
      if (method === 'ALL') continue;
      const reply = await api(method, `/api${concrete}`, ask.token, method === 'GET' || method === 'DELETE' ? undefined : {}, asAsk);
      if (allowed.has(`${method} ${route}`)) {
        assert.notEqual(reply.json?.code, 'HELP_ASK_READ_ONLY', `${method} ${route} is one of the four reads`);
        continue;
      }
      assert.equal(reply.status, 403, `${method} ${route}: ${reply.status} ${reply.text.slice(0, 200)}`);
      assert.equal(reply.json?.code, 'HELP_ASK_READ_ONLY', `${method} ${route}`);
      fenced += 1;
    }
    assert.equal(fenced, routes.filter(([m, r]) => m !== 'ALL' && !allowed.has(`${m} ${r}`)).length);
    // An ordinary session's tools are not fenced: the same door answers it as it always did.
    const ordinaryRead = await api('GET', '/api/runner/tasks', ask.token, undefined, asOrdinary);
    assert.notEqual(ordinaryRead.json?.code, 'HELP_ASK_READ_ONLY', ordinaryRead.text);
    // Nor is the runner daemon, which names no caller: its own calls for the Ask (events, turn-complete) go through.
    const daemon = await api('GET', '/api/runner/tasks', ask.token, undefined, { 'x-orbit-session-id': pub(askId) });
    assert.notEqual(daemon.json?.code, 'HELP_ASK_READ_ONLY', daemon.text);
  });
});

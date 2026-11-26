/**
 * The help center's Ask (docs/mocks/help-center board 02 §1–§4; help/help-ask.ts, help/help-ask-reads.ts, migration
 * 0850), held against the production apiserver — `build/main.js`, the whole AppModule — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/help/help-ask.pg.spec.ts
 *
 * Two accounts; the owner's machines: `ask` (online, declares help-ask/v1), `old` (online, does not), `asleep` (never
 * beats). Against one server:
 *
 *   1. the Runs on picker: every machine, online first, which can answer, and Claude Code askable;
 *   2. asking: an Ask is an ordinary session on the picked machine with `help_ask` holding the page, no workspace, no
 *      branch, titled by its first question; the machine and engine are remembered; an old runner, an offline machine,
 *      an engine an Ask cannot run read-only and another account's machine are refused, and nothing is made;
 *   3. an Ask is in no session list — flat, a workspace's, any view — and is in /help → Your questions, with its origin
 *      page, outcome and cost; another account sees none of it;
 *   4. `help_ask` is written by the INSERT alone: an UPDATE that sets, changes or clears it is refused;
 *   5. the claim hands an Ask to a runner that declares help-ask/v1 only, with `helpAsk` and no workDir;
 *   6. the four reads answer an Ask session of the runner's own, and 404 everyone else;
 *   7. the fence: an Ask's tools (the runner credential, `x-orbit-runner-caller`, its session header) are refused
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
const QUESTION = 'Why is build-box offline?';

test('Ask is a read-only session on a machine the person picks, in no workspace\'s list', {
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

  const sessionRow = async (id: string) => (await sql.query(`SELECT * FROM "session" WHERE "id" = $1::uuid`, [id])).rows[0];
  const sessionsOf = async (ownerId: string) =>
    Number((await sql.query(`SELECT count(*) AS n FROM "session" WHERE "owner_id" = $1::uuid`, [ownerId])).rows[0].n);
  let askId = '';

  await t.test('1. the Runs on picker lists every machine, online first, and which of them can answer', async () => {
    const reply = await api('GET', '/api/help/ask/choices', ownerToken);
    assert.equal(reply.status, 200, reply.text);
    const byName = new Map((reply.json.machines as Array<Record<string, unknown>>).map((m) => [m.name, m]));
    assert.deepEqual([...byName.keys()].sort(), [ask.name, asleep.name, old.name].sort(), 'the owner\'s machines, and only theirs');
    assert.equal(reply.json.machines.at(-1).name, asleep.name, 'an offline machine after the online ones');
    assert.deepEqual([byName.get(ask.name)!.online, byName.get(ask.name)!.supported], [true, true]);
    assert.deepEqual([byName.get(old.name)!.online, byName.get(old.name)!.supported], [true, false]);
    assert.equal(byName.get(asleep.name)!.online, false);
    assert.deepEqual(
      (byName.get(ask.name)!.engines as Array<{ engine: string; askable: boolean }>).map((e) => [e.engine, e.askable]),
      [['claude', true], ['codex', false]],
      'Claude Code is the engine an Ask runs on read-only; Codex is shown, and not offered',
    );
    assert.equal(reply.json.remembered, null, 'nothing remembered before the first Ask');
  });

  await t.test('2. asking makes an ordinary session on the machine, in no workspace, and remembers the pick', async () => {
    const before = await sessionsOf(owner.id);
    const refusals: Array<[string, Record<string, unknown>, number, string | undefined, string | undefined]> = [
      ['an old runner', { runnerId: pub(old.runnerId), engine: 'claude' }, 409, 'HELP_ASK_RUNNER_UPGRADE', ownerToken],
      ['an offline machine', { runnerId: pub(asleep.runnerId), engine: 'claude' }, 409, undefined, ownerToken],
      ['an engine an Ask cannot run read-only', { runnerId: pub(ask.runnerId), engine: 'codex' }, 400, undefined, ownerToken],
      ["another account's machine", { runnerId: pub(theirs.runnerId), engine: 'claude' }, 404, undefined, ownerToken],
      ['a blank machine', { runnerId: '  ', engine: 'claude' }, 400, undefined, ownerToken],
      ['no question', { runnerId: pub(ask.runnerId), engine: 'claude', content: ' ' }, 400, undefined, ownerToken],
      ['a page of the wrong shape', { runnerId: pub(ask.runnerId), engine: 'claude', page: { route: 'x' } }, 400, undefined, ownerToken],
    ];
    for (const [what, body, status, code, bearer] of refusals) {
      const reply = await api('POST', '/api/help/ask', bearer, { content: QUESTION, ...body });
      assert.equal(reply.status, status, `${what}: ${reply.text}`);
      if (code) assert.equal(reply.json.code, code, what);
    }
    // A machine that never beat is offline before it is anything else.
    const offline = await api('POST', '/api/help/ask', ownerToken, { content: QUESTION, runnerId: pub(asleep.runnerId), engine: 'claude' });
    assert.equal(offline.json.code, 'HELP_ASK_MACHINE_OFFLINE', offline.text);
    assert.equal(await sessionsOf(owner.id), before, 'nothing was made by a refusal');
    assert.equal((await api('GET', '/api/help/ask/choices', ownerToken)).json.remembered, null, 'and nothing remembered');

    const made = await api('POST', '/api/help/ask', ownerToken, {
      content: `${QUESTION} It was fine yesterday.`, runnerId: pub(ask.runnerId), engine: 'claude', page: PAGE,
    });
    assert.equal(made.status, 201, made.text);
    askId = toUuid(made.json.sessionId);
    const row = await sessionRow(askId);
    assert.deepEqual(row.help_ask, { page: PAGE }, 'the page it was asked from, on the row');
    assert.equal(row.workspace_id, null, 'an Ask belongs to no workspace');
    assert.equal(row.branch, null, 'and has no branch: it runs in no repository');
    assert.equal(row.assigned_runner_id, ask.runnerId, 'on the machine picked');
    assert.equal(row.engine, 'claude');
    assert.equal(row.title, `${QUESTION} It was fine yesterday.`, 'titled by its first question, by no model');
    assert.equal(row.status, 'PENDING', 'an ordinary session, waiting for its runner');
    const remembered = (await api('GET', '/api/help/ask/choices', ownerToken)).json.remembered;
    assert.deepEqual({ runnerId: remembered?.runnerId, engine: remembered?.engine },
      { runnerId: pub(ask.runnerId), engine: 'claude' }, 'the machine and engine, remembered for the next Ask');
    const pat = await api('POST', '/api/help/ask', strangerToken, { content: QUESTION, runnerId: pub(ask.runnerId), engine: 'claude' });
    assert.equal(pat.status, 404, "another account cannot ask on the owner's machine");
  });

  await t.test('3. an Ask is in no session list, and is in Your questions', async () => {
    const ids = (reply: Reply) => {
      assert.equal(reply.status, 200, reply.text);
      const rows = (Array.isArray(reply.json) ? reply.json : reply.json.sessions ?? reply.json.items ?? []) as Array<{ id: string }>;
      return rows.map((r) => toUuid(r.id));
    };
    const flat = ids(await api('GET', '/api/sessions', ownerToken));
    assert.ok(flat.includes(ordinaryId), 'the flat list reads (the ordinary session is in it)');
    assert.ok(!flat.includes(askId), 'the flat list leaves the Ask out');
    const ws = ids(await api('GET', `/api/sessions?workspaceId=${pub(workspaceId)}`, ownerToken));
    assert.ok(ws.includes(ordinaryId) && !ws.includes(askId), "the workspace's list leaves it out");
    const onMachine = ids(await api('GET', `/api/sessions?runnerId=${pub(ask.runnerId)}`, ownerToken));
    assert.ok(onMachine.includes(ordinaryId) && !onMachine.includes(askId), "the machine's list leaves it out");
    for (const view of ['completed', 'trash']) {
      assert.ok(!ids(await api('GET', `/api/sessions?view=${view}`, ownerToken)).includes(askId), `${view} leaves it out`);
    }

    const questions = await api('GET', '/api/help/ask/sessions', ownerToken);
    assert.equal(questions.status, 200, questions.text);
    assert.equal(questions.json.questions.length, 1, questions.text);
    const [one] = questions.json.questions;
    assert.deepEqual(
      [toUuid(one.sessionId), one.title, one.origin, one.outcome, one.costUsd, one.runner, one.engine],
      [askId, `${QUESTION} It was fine yesterday.`, PAGE.label, 'working', 0, ask.name, 'claude'],
    );
    const theirList = await api('GET', '/api/help/ask/sessions', strangerToken);
    assert.deepEqual(theirList.json.questions, [], 'another account sees none of it');
    // The session reads as a session: opening it from Your questions continues it.
    const read = await api('GET', `/api/sessions/${pub(askId)}`, ownerToken);
    assert.equal(read.status, 200, read.text);
  });

  await t.test('4. help_ask is written by the INSERT alone', async () => {
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

  await t.test('5. the claim hands an Ask only to a runner that declares help-ask/v1, read-only, with no workDir', async () => {
    // The ordinary session is claimed first by its own machine; take it out of the way.
    await sql.query(`UPDATE "session" SET "turn_state" = NULL, "finished_at" = COALESCE("finished_at", now()), "completed_at" = now() WHERE "id" = $1::uuid`, [ordinaryId]);
    // The runner stops declaring it (a downgrade): the Ask waits.
    await sql.query(`UPDATE "runner" SET "capabilities" = '{source-pin/v1}' WHERE "id" = $1::uuid`, [ask.runnerId]);
    const refused = await api('GET', '/api/runner/sessions/claim', ask.token, undefined, { 'x-orbit-runner-capabilities': 'source-pin/v1' });
    assert.notEqual(refused.json?.sessionId && toUuid(refused.json.sessionId), askId, 'not handed to a runner without help-ask/v1');
    assert.equal((await sessionRow(askId)).status, 'PENDING');

    await beat(ask, `source-pin/v1,${HELP_ASK_V1}`);
    const claim = await api('GET', '/api/runner/sessions/claim', ask.token, undefined, { 'x-orbit-runner-capabilities': `source-pin/v1,${HELP_ASK_V1}` });
    assert.equal(claim.status, 200, claim.text);
    assert.equal(toUuid(claim.json.sessionId), askId, claim.text.slice(0, 400));
    assert.deepEqual(claim.json.helpAsk, { page: PAGE }, 'the runner is told it is an Ask, and the page');
    assert.equal(claim.json.workDir, undefined, 'and is handed no folder to work in');
    assert.equal(claim.json.branch, undefined);
    // Titled by its first question and by no model (board 03): the engine is not asked to name it either.
    assert.equal(claim.json.naming, undefined, 'and is not asked to name the Ask');
  });

  await t.test('6. the four reads answer an Ask session of the runner\'s own, and nobody else', async () => {
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

  await t.test('7. an Ask\'s tools reach no other runner door, read or write', async () => {
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

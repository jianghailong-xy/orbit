/**
 * A personal access token confined to workspaces (docs/personal-access-token-design.md §6.3 v1),
 * through the production apiserver — `build/main.js`, the whole AppModule — against a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty. One user with three workspaces, a
 * token confined to one of them, and what it is held to:
 *
 *   (1) it reads and writes the tasks and sessions in its workspace, and the workspace itself —
 *       a task created there, a task edited and commented on, a session made, renamed and read;
 *   (2) anything outside is 403 PAT_WORKSPACE_OUT_OF_SCOPE and writes nothing: another workspace's
 *       task and session, a task assigned nowhere, moving its own task out, creating one elsewhere
 *       or nowhere, naming a project;
 *   (3) the lists — tasks, sessions, workspaces — answer only what sits in its workspace;
 *   (4) a route the census marks `workspaceConfinable: false` refuses it 403
 *       PAT_ROUTE_NOT_WORKSPACE_CONFINABLE, whatever its scope;
 *   (5) a token confined to nothing, and a login, do all of the above as before: every object, every
 *       list whole, every route.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/pat-workspace-confinement.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PAT_SCOPES, PatService } from './pat.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
/** build/auth → build/main.js, the apiserver's production entry point. */
const MAIN = path.resolve(__dirname, '..', 'main.js');
const API_DIR = path.resolve(__dirname, '..', '..');

interface Apiserver {
  port: number;
  child: ChildProcess;
  stop(): Promise<void>;
}

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  text: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** One request on a connection of its own. A 200 stream is answered once its headers arrive, and closed. */
function call(server: Apiserver, method: string, route: string, bearer: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: route,
        method,
        agent: false,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        res.on('error', () => undefined);
        if (res.statusCode === 200 && String(res.headers['content-type']).startsWith('text/event-stream')) {
          resolve({ status: 200, json: null, text: '' });
          req.destroy();
          return;
        }
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${route} timed out`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** `node build/main.js`, as the container starts it, on a port of its own; resolves once it answers. */
async function startApiserver(databaseUrl: string, jwtSecret: string): Promise<Apiserver> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    PORT: String(port),
    NO_COLOR: '1',
    CORS_ORIGINS: 'http://127.0.0.1',
  };
  delete env.NODE_TEST_CONTEXT;
  let log = '';
  const child = spawn(process.execPath, [MAIN], { cwd: API_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (chunk: Buffer) => {
    log = (log + chunk.toString('utf8')).slice(-400_000);
  };
  child.stdout!.on('data', collect);
  child.stderr!.on('data', collect);
  const server: Apiserver = {
    port,
    child,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(20_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) assert.fail(`the apiserver exited ${child.exitCode} before answering:\n${log.slice(-6_000)}`);
    const reply = await call(server, 'GET', '/api/auth/setup-status', '').catch(() => null);
    if (reply?.status === 200) return server;
    if (Date.now() > deadline) assert.fail(`the apiserver did not answer within 150s:\n${log.slice(-6_000)}`);
    await sleep(250);
  }
}

test('a token confined to a workspace: its tasks, sessions and workspace and nothing else; non-confinable routes refused; unconfined tokens and logins as before', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  const userId = randomUUID();
  const email = `confined-${RUN}-${userId}@personal-access-token.invalid`;
  await db.user.create({ data: { id: userId, email, name: 'Confined', passwordHash: 'x' } });
  // A runner that has never been seen: a session made on it waits to be claimed.
  const runnerId = randomUUID();
  await db.runner.create({ data: { id: runnerId, ownerId: userId, name: 'a runner', tokenHash: `confined-${runnerId}` } });
  const workspace = async (name: string) =>
    (await db.workspace.create({ data: { ownerId: userId, runnerId, name: `${name} ${RUN}`, enabled: true } })).id;
  const mine = await workspace('mine');
  const theirs = await workspace('elsewhere');
  const third = await workspace('third');

  const task = async (title: string, assigneeId: string | null) =>
    (await db.task.create({
      data: {
        ownerId: userId,
        creatorType: 'USER',
        creatorId: userId,
        title,
        assigneeId,
        completionCriterion: 'EXECUTABLE',
        acceptanceCommand: 'true',
        acceptanceExpectedExitCode: 0,
      },
    })).id;
  const taskMine = await task('in my workspace', mine);
  const taskTheirs = await task('in another workspace', theirs);
  const taskNowhere = await task('assigned nowhere', null);
  const session = async (title: string, workspaceId: string) =>
    (await db.session.create({
      data: { ownerId: userId, creatorId: userId, workspaceId, assignedRunnerId: runnerId, title, prompt: 'hello' },
    })).id;
  const sessionMine = await session('session in my workspace', mine);
  const sessionTheirs = await session('session in another workspace', theirs);

  const pats = new PatService(db as unknown as PrismaService);
  const issue = async (name: string, workspaceIds: string[]) =>
    (await pats.issue(userId, { name, scopes: [...PAT_SCOPES], workspaceIds, expiresInDays: 90, createdVia: 'WEB' })).token;
  const confined = await issue('confined to mine', [mine]);
  const unconfined = await issue('every workspace', []);
  const jwtSecret = `pat-workspace-spec-${randomUUID()}`;
  const login = await new JwtService({ secret: jwtSecret }).signAsync({ sub: userId, email });
  server = await startApiserver(url, jwtSecret);
  const api = (method: string, route: string, bearer: string, body?: unknown) => call(server!, method, route, bearer, body);

  const outOfScope = (reply: Reply, fields: string[], what: string) => {
    assert.equal(reply.status, 403, `${what}: ${reply.status} ${reply.text}`);
    assert.equal(reply.json?.code, 'PAT_WORKSPACE_OUT_OF_SCOPE', `${what}: ${reply.text}`);
    assert.deepEqual(reply.json?.fields, fields, what);
  };
  const newTask = (title: string, extra: Record<string, unknown> = {}) => ({
    title,
    // Outside a project, the one criterion this door takes without more: a command and its exit code.
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
    ...extra,
  });
  /** Responses spell ids as public ids; the columns key by uuid. */
  const idOf = (id: string | null) => (id === null ? null : toUuid(id));
  /** A session list row names its workspace as `workspace: { id, … }`. */
  const placeOf = (row: { workspace: { id: string } | null }) => idOf(row.workspace?.id ?? null);
  const titleOf = async (id: string) => (await sql.query('SELECT title, assignee_id FROM task WHERE id = $1', [id])).rows[0];
  const countWhere = async (table: 'task' | 'session', title: string) =>
    (await sql.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id = $1 AND title = $2`, [userId, title])).rows[0].n;

  await t.test('(1) it reads and writes the tasks and sessions in its workspace, and the workspace itself', async () => {
    const read = await api('GET', `/api/tasks/${taskMine}`, confined);
    assert.equal(read.status, 200, read.text);
    assert.equal(read.json.title, 'in my workspace');
    // As the clients spell ids in URLs, too.
    assert.equal((await api('GET', `/api/tasks/${uuidToBase62(taskMine)}`, confined)).status, 200);
    assert.equal((await api('GET', `/api/tasks/${taskMine}/row`, confined)).status, 200);

    const edited = await api('PATCH', `/api/tasks/${taskMine}`, confined, { title: 'edited by the confined token' });
    assert.equal(edited.status, 200, edited.text);
    assert.deepEqual(await titleOf(taskMine), { title: 'edited by the confined token', assignee_id: mine });
    const commented = await api('POST', `/api/tasks/${taskMine}/comments`, confined, { body: 'a comment from a script' });
    assert.equal(commented.status, 201, commented.text);

    const created = await api('POST', '/api/tasks', confined, newTask('created by the confined token', { assigneeId: mine }));
    assert.equal(created.status, 201, created.text);
    assert.equal((await titleOf(idOf(created.json.id)!)).assignee_id, mine);

    const opened = await api('POST', '/api/sessions', confined, { workspaceId: mine, prompt: 'hello from a script', title: 'opened by the confined token' });
    assert.equal(opened.status, 201, opened.text);
    assert.equal(idOf(opened.json.workspaceId), mine);
    assert.equal((await api('GET', `/api/sessions/${sessionMine}`, confined)).status, 200);
    const renamed = await api('PATCH', `/api/sessions/${sessionMine}`, confined, { title: 'renamed by the confined token' });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(await countWhere('session', 'renamed by the confined token'), 1);

    for (const route of [`/api/workspaces/${mine}`, `/api/agents/${mine}`]) {
      const answer = await api('GET', route, confined);
      assert.equal(answer.status, 200, `${route}: ${answer.text}`);
      assert.equal(idOf(answer.json.id), mine);
    }
  });

  await t.test('(2) anything outside its workspace is 403 PAT_WORKSPACE_OUT_OF_SCOPE, and nothing is written', async () => {
    outOfScope(await api('GET', `/api/tasks/${taskTheirs}`, confined), [':id'], "another workspace's task");
    outOfScope(await api('GET', `/api/tasks/${taskNowhere}`, confined), [':id'], 'a task assigned nowhere');
    outOfScope(await api('GET', `/api/tasks/${randomUUID()}`, confined), [':id'], 'a task that does not exist');
    outOfScope(await api('PATCH', `/api/tasks/${taskTheirs}`, confined, { title: 'hijacked' }), [':id'], "editing another workspace's task");
    outOfScope(await api('POST', `/api/tasks/${taskTheirs}/comments`, confined, { body: 'hijacked' }), [':id'], 'commenting there');
    outOfScope(await api('DELETE', `/api/tasks/${taskTheirs}`, confined), [':id'], 'deleting it');
    // Its own task may not be moved out of its workspace, or into none.
    outOfScope(await api('PATCH', `/api/tasks/${taskMine}`, confined, { assigneeId: theirs }), ['assigneeId'], 'moving its task out');
    outOfScope(await api('PATCH', `/api/tasks/${taskMine}`, confined, { assigneeId: null }), ['assigneeId'], 'unassigning its task');
    // A new task is made in its workspace, or not at all; and it names nothing the workspace cannot vouch for.
    outOfScope(await api('POST', '/api/tasks', confined, newTask('hijacked', { assigneeId: theirs })), ['assigneeId'], 'a task elsewhere');
    outOfScope(await api('POST', '/api/tasks', confined, newTask('hijacked')), ['assigneeId'], 'a task assigned nowhere');
    outOfScope(
      await api('POST', '/api/tasks', confined, newTask('hijacked', { assigneeId: mine, projectId: randomUUID() })),
      ['projectId'],
      'a task filed under a project',
    );

    outOfScope(await api('GET', `/api/sessions/${sessionTheirs}`, confined), [':id'], "another workspace's session");
    outOfScope(await api('GET', `/api/sessions/${sessionTheirs}/events/page?tail=5`, confined), [':id'], 'its transcript');
    outOfScope(await api('PATCH', `/api/sessions/${sessionTheirs}`, confined, { title: 'hijacked' }), [':id'], 'renaming it');
    outOfScope(
      await api('POST', '/api/sessions', confined, { workspaceId: theirs, prompt: 'hello', title: 'hijacked' }),
      ['workspaceId'],
      'a session elsewhere',
    );
    outOfScope(await api('GET', `/api/workspaces/${theirs}`, confined), [':id'], 'another workspace');
    outOfScope(await api('PATCH', `/api/workspaces/${theirs}`, confined, { name: 'hijacked' }), [':id'], 'renaming it');

    assert.deepEqual(await titleOf(taskTheirs), { title: 'in another workspace', assignee_id: theirs });
    assert.deepEqual(await titleOf(taskMine), { title: 'edited by the confined token', assignee_id: mine });
    assert.equal(await countWhere('task', 'hijacked'), 0);
    assert.equal(await countWhere('session', 'hijacked'), 0);
    const untouched = await sql.query(
      `SELECT (SELECT title FROM session WHERE id = $1) AS session,
              (SELECT name FROM workspace WHERE id = $2) AS workspace,
              (SELECT count(*)::int FROM task_comment WHERE task_id = $3) AS comments`,
      [sessionTheirs, theirs, taskTheirs],
    );
    assert.deepEqual(untouched.rows, [{ session: 'session in another workspace', workspace: `elsewhere ${RUN}`, comments: 0 }]);
  });

  await t.test('(3) the lists answer only what sits in its workspace', async () => {
    const tasks = await api('GET', '/api/tasks', confined);
    assert.equal(tasks.status, 200, tasks.text);
    assert.ok(tasks.json.length >= 2, tasks.text);
    assert.deepEqual([...new Set(tasks.json.map((row: { assigneeId: string }) => idOf(row.assigneeId)))], [mine]);
    assert.ok(tasks.json.some((row: { id: string }) => idOf(row.id) === taskMine));

    const sessions = await api('GET', '/api/sessions', confined);
    assert.equal(sessions.status, 200, sessions.text);
    assert.ok(sessions.json.length >= 2, sessions.text);
    assert.deepEqual([...new Set(sessions.json.map(placeOf))], [mine]);
    // Asking for another workspace's sessions narrows to nothing rather than widening.
    const filtered = await api('GET', `/api/sessions?workspaceId=${theirs}`, confined);
    assert.equal(filtered.status, 200, filtered.text);
    assert.deepEqual(filtered.json, []);
    // The Open list's delta shape and its ETag are the confined list's too.
    const delta = await api('GET', '/api/sessions?since=', confined);
    assert.equal(delta.status, 200, delta.text);
    assert.deepEqual([...new Set(delta.json.sessions.map(placeOf))], [mine]);

    for (const route of ['/api/workspaces', '/api/agents']) {
      const workspaces = await api('GET', route, confined);
      assert.equal(workspaces.status, 200, workspaces.text);
      assert.deepEqual(workspaces.json.map((row: { id: string }) => idOf(row.id)), [mine]);
    }
  });

  await t.test('(4) a route the census marks workspaceConfinable: false refuses it, whatever its scope', async () => {
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/projects'],
      ['GET', '/api/tasks/page'],
      ['GET', '/api/tasks/counts'],
      ['GET', `/api/tasks/${taskMine}/dependency-graph`],
      ['GET', '/api/sessions/search?q=hello'],
      ['GET', '/api/runners'],
      ['GET', '/api/events'],
      ['POST', '/api/workspaces', { name: 'made by a confined token' }],
      ['POST', '/api/tasks/batch-delete', { taskIds: [taskMine] }],
    ];
    for (const [method, route, body] of routes) {
      const answer = await api(method, route, confined, body);
      assert.equal(answer.status, 403, `${method} ${route}: ${answer.status} ${answer.text}`);
      assert.equal(answer.json?.code, 'PAT_ROUTE_NOT_WORKSPACE_CONFINABLE', `${method} ${route}: ${answer.text}`);
    }
    const kept = await sql.query(
      `SELECT (SELECT count(*)::int FROM workspace WHERE owner_id = $1) AS workspaces,
              (SELECT count(*)::int FROM task WHERE id = $2) AS task`,
      [userId, taskMine],
    );
    assert.deepEqual(kept.rows, [{ workspaces: 3, task: 1 }]);
  });

  await t.test('(5) a token confined to nothing, and a login, reach everything as before', async () => {
    for (const [who, bearer] of [['an unconfined token', unconfined], ['a login', login]] as const) {
      for (const id of [taskMine, taskTheirs, taskNowhere]) {
        assert.equal((await api('GET', `/api/tasks/${id}`, bearer)).status, 200, `${who}: task ${id}`);
      }
      for (const id of [sessionMine, sessionTheirs]) {
        assert.equal((await api('GET', `/api/sessions/${id}`, bearer)).status, 200, `${who}: session ${id}`);
      }
      assert.equal((await api('GET', `/api/workspaces/${theirs}`, bearer)).status, 200, who);
      const edited = await api('PATCH', `/api/tasks/${taskTheirs}`, bearer, { title: `edited by ${who}` });
      assert.equal(edited.status, 200, `${who}: ${edited.text}`);
      assert.equal((await titleOf(taskTheirs)).title, `edited by ${who}`);
      const created = await api('POST', '/api/tasks', bearer, newTask(`created by ${who}`));
      assert.equal(created.status, 201, `${who}: ${created.text}`);

      const tasks = await api('GET', '/api/tasks', bearer);
      const assignees = new Set(tasks.json.map((row: { assigneeId: string | null }) => idOf(row.assigneeId)));
      assert.ok(assignees.has(mine) && assignees.has(theirs) && assignees.has(null), `${who}: ${[...assignees]}`);
      const sessions = await api('GET', '/api/sessions', bearer);
      const places = new Set(sessions.json.map(placeOf));
      assert.ok(places.has(mine) && places.has(theirs), `${who}: ${[...places]}`);
      const workspaces = await api('GET', '/api/workspaces', bearer);
      assert.deepEqual(workspaces.json.map((row: { id: string }) => idOf(row.id)).sort(), [mine, theirs, third].sort(), who);

      for (const route of ['/api/projects', '/api/tasks/page', '/api/tasks/counts', '/api/runners']) {
        const answer = await api('GET', route, bearer);
        assert.equal(answer.status, 200, `${who}: GET ${route} ${answer.status} ${answer.text}`);
      }
    }
  });
});

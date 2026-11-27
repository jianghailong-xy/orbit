/**
 * GitHub-backed workspaces, P1 (docs/github-workspace-design.md §5.3, §5.4, §6's dispatch gate, §7), held against the
 * production apiserver — `build/main.js`, the whole AppModule, run as a child process — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty. Only GitHub is not real: the in-process fake (test-support/fake-github.ts)
 * answers it over HTTP, through the preload test-support/fake-github-over-http.ts puts in the child, and nothing reaches
 * the network.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/github/github-workspace.pg.spec.ts
 *
 * Three accounts: the owner and a stranger, each connected to a GitHub account of their own through the real code flow,
 * and a loner who never connected. What it is held to:
 *
 *   1. POST /sessions `newWorkspace.github` refuses in the documented order, and no refusal writes a workspace or a
 *      session: 400 (shape, folder, ref, two sources), then 409 GITHUB_NOT_CONNECTED (even on a runner that cannot
 *      clone), then 403 GITHUB_REPO_FORBIDDEN (even on a runner that cannot clone), then 409 CLONE_UNSUPPORTED (no
 *      clone-workdir/v1, or no reposRoot), then the refusals any new workspace meets (an engine signed out);
 *   2. accepted, one transaction writes the workspace at <reposRoot>/<folder> with repoUrl, githubRepoId,
 *      githubInstallationId, cloneRef and cloneState PENDING, and its session;
 *   3. the heartbeat lists every PENDING and CLONING workspace of the runner in cloneRequests (only to a runner that
 *      declares clone-workdir/v1, never another runner's), and cloneReports move the state — only the runner's own;
 *      a FAILED error is redacted;
 *   4. the dispatch gate: a session of a PENDING, CLONING or FAILED workspace is not claimed, and the session list says
 *      WORKSPACE_CLONING or WORKSPACE_CLONE_FAILED; Retry moves FAILED → PENDING only (another account's is 404, a
 *      second Retry 409); once READY the session is claimed;
 *   5. POST /runner/git-credential mints an installation token restricted to repository_ids [repoId] with
 *      contents:write and metadata:read, only for the workspace's own repository on github.com and only to the runner
 *      that owns the workspace: another runner of the same owner, another account's runner, another account's
 *      workspace, a different host and a different path are all refused with nothing minted; a token is handed again
 *      until five minutes before it expires; a repository the owner can no longer see is 403 and an uninstalled App 409;
 *   6. no token is stored in any table, nor written to the apiserver's log.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
process.env.PROVIDER_SECRET_KEY = process.env.PROVIDER_SECRET_KEY || `github-p1-pg-${Math.random()}`;
process.env.PUBLIC_ORIGIN = 'https://orbit.example.test';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ENGINE_SIGNED_OUT, toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import '../test-support/daemon-routes-over-http';
import { FakeGithub, type FakeGithubUser, type FakeRepo } from '../test-support/fake-github';
import { serveFakeGithub } from '../test-support/fake-github-over-http';
import { wordSql } from '../test-support/session-word';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const CLONE = 'clone-workdir/v1';

interface Machine {
  runnerId: string;
  token: string;
}

const repo = (id: number, fullName: string): FakeRepo => ({
  id, fullName, private: true, defaultBranch: 'main', pushedAt: new Date(Date.UTC(2026, 10, 1) - id * 1000).toISOString(), branches: ['main'],
});

test('GitHub P1 on PostgreSQL: create from GitHub, the clone reconcile, the dispatch gate and the git credential', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const github = new FakeGithub();
  const fakeServer = await serveFakeGithub(github);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await fakeServer.close();
    await sql.end().catch(() => undefined);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = async (query: string, values: unknown[] = []): Promise<any[]> => (await sql.query(query, values)).rows;

  // The deployment's App, as an administrator's save leaves it (P0).
  await sql.query(
    `INSERT INTO "github_app_config" ("id", "enabled", "app_id", "slug", "client_id", "client_secret_enc", "private_key_enc", "updated_at")
     VALUES ('github', true, $1, $2, $3, $4, $5, now())
     ON CONFLICT ("id") DO UPDATE SET "enabled" = true, "app_id" = EXCLUDED."app_id", "slug" = EXCLUDED."slug",
       "client_id" = EXCLUDED."client_id", "client_secret_enc" = EXCLUDED."client_secret_enc", "private_key_enc" = EXCLUDED."private_key_enc"`,
    [github.appId, github.slug, github.clientId, encryptSecret(github.clientSecret), encryptSecret(github.privateKey)],
  );

  const account = async (name: string) => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    const email = `${name}-${RUN}@github-p1.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [id, email, name, hashPassword(password)]);
    return { id, email, password };
  };
  const owner = await account('owner');
  const stranger = await account('stranger');
  const loner = await account('loner');

  server = await startApiserver(url, `github-p1-${randomUUID()}`);
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>) =>
    call(server!, method, route, bearer, body, headers);
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const ownerToken = await signIn(owner);
  const strangerToken = await signIn(stranger);
  const lonerToken = await signIn(loner);

  // GitHub's side: the owner's account with two repositories under one installation, the stranger's with one.
  const OWNER_INSTALLATION = 7_100_000 + Math.floor(Math.random() * 1000);
  const STRANGER_INSTALLATION = OWNER_INSTALLATION + 5000;
  const base = 900_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
  const APP_REPO = base + 1;
  const LIB_REPO = base + 2;
  const GONE_REPO = base + 3;
  const SECRET_REPO = base + 4;
  const octo: FakeGithubUser = {
    id: base + 11, login: `octo-${RUN}`,
    installations: [{
      id: OWNER_INSTALLATION, account: `octo-${RUN}`, type: 'User', selection: 'selected',
      repos: [repo(APP_REPO, `octo-${RUN}/app`), repo(LIB_REPO, `octo-${RUN}/lib`), repo(GONE_REPO, `octo-${RUN}/gone`)],
    }],
  };
  const mallory: FakeGithubUser = {
    id: base + 12, login: `mallory-${RUN}`,
    installations: [{ id: STRANGER_INSTALLATION, account: `mallory-${RUN}`, type: 'User', selection: 'selected', repos: [repo(SECRET_REPO, `mallory-${RUN}/secret`)] }],
  };
  /** The real code flow (P0): /start, GitHub's approval, the callback from the same browser. */
  const connect = async (bearer: string, user: FakeGithubUser) => {
    const started = await api('GET', '/api/integrations/github/start?return=/settings', bearer);
    assert.equal(started.status, 200, started.text);
    const cookie = String(started.headers['set-cookie'] ?? '').split(';')[0];
    const back = github.authorize(started.json.authorizationUrl, user);
    const done = await api('GET', back, undefined, undefined, { cookie });
    assert.equal(done.status, 302, done.text);
    assert.match(String(done.headers.location), /github=connected/);
  };
  await connect(ownerToken, octo);
  await connect(strangerToken, mallory);

  // ── machines ──────────────────────────────────────────────────────────────────────────────────────────────────
  const register = async (bearer: string, name: string): Promise<Machine> => {
    const minted = await api('POST', '/api/runners/enrollment-tokens', bearer, { label: `github-p1 ${RUN}` });
    assert.equal(minted.status, 201, minted.text);
    const registered = await api('POST', '/api/runner/register', undefined, { enrollmentToken: minted.json.token, name, hostname: name });
    assert.equal(registered.status, 201, registered.text);
    return { runnerId: toUuid(registered.json.runnerId), token: registered.json.runnerToken };
  };
  const heartbeat = (machine: Machine, capabilities: string, body: Record<string, unknown> = {}, auth = 'yes') =>
    api('POST', '/api/runner/heartbeat', machine.token, {
      status: 'ONLINE',
      idleCapacity: 4,
      engines: [{ engine: 'claude', installed: true, auth, version: '2.3.0' }],
      ...body,
    }, { 'x-orbit-runner-capabilities': capabilities });
  const beat = async (machine: Machine, capabilities: string, body: Record<string, unknown> = {}, auth = 'yes') => {
    const reply = await heartbeat(machine, capabilities, body, auth);
    assert.equal(reply.status, 201, reply.text);
    return reply.json;
  };
  const ROOT = '/home/orbit/orbit-repos';
  const cloner = await register(ownerToken, `cloner-${RUN}`);
  const second = await register(ownerToken, `second-${RUN}`);
  const old = await register(ownerToken, `old-${RUN}`);
  const rootless = await register(ownerToken, `rootless-${RUN}`);
  const signedOut = await register(ownerToken, `signed-out-${RUN}`);
  const theirs = await register(strangerToken, `theirs-${RUN}`);
  const lonely = await register(lonerToken, `lonely-${RUN}`);
  await beat(cloner, `create-workdir/v1,${CLONE}`, { reposRoot: ROOT });
  await beat(second, `create-workdir/v1,${CLONE}`, { reposRoot: '/srv/second' });
  await beat(old, 'create-workdir/v1', { reposRoot: '/srv/old' });
  await beat(rootless, CLONE);
  await beat(signedOut, CLONE, { reposRoot: '/srv/signed-out' }, 'no');
  await beat(theirs, CLONE, { reposRoot: '/srv/theirs' });
  await beat(lonely, CLONE, { reposRoot: '/srv/lonely' });

  const openSession = (bearer: string, machine: Machine, newWorkspace: unknown, extra: Record<string, unknown> = {}) =>
    api('POST', '/api/sessions', bearer, {
      prompt: 'Look around this repository', engine: 'claude', assignedRunnerId: uuidToBase62(machine.runnerId), newWorkspace, ...extra,
    });
  const written = async () => ({
    workspaces: Number((await rows(`SELECT count(*)::int AS n FROM "workspace" WHERE "owner_id" = ANY($1::uuid[])`, [[owner.id, stranger.id, loner.id]]))[0].n),
    sessions: Number((await rows(`SELECT count(*)::int AS n FROM "session" WHERE "owner_id" = ANY($1::uuid[])`, [[owner.id, stranger.id, loner.id]]))[0].n),
  });
  const workspaceRow = async (id: string) => (await rows(
    `SELECT "name", "runner_id"::text AS "runnerId", "work_dir" AS "workDir", "repo_url" AS "repoUrl",
            "github_repo_id"::text AS "repoId", "github_installation_id"::text AS "installationId", "clone_ref" AS "cloneRef",
            "clone_state" AS "cloneState", "clone_error" AS "cloneError", "auto_create_work_dir" AS "autoCreateWorkDir",
            "clone_started_at" IS NOT NULL AS "started", "clone_finished_at" IS NOT NULL AS "finished"
       FROM "workspace" WHERE "id" = $1::uuid`, [id]))[0];

  // ── 1. the refusals, in order ─────────────────────────────────────────────────────────────────────────────────
  await t.test('1. newWorkspace.github refuses in the documented order and writes nothing', async () => {
    const before = await written();
    const expect = async (what: string, reply: Awaited<ReturnType<typeof api>>, status: number, code?: string) => {
      assert.equal(reply.status, status, `${what}: ${reply.text}`);
      if (code) assert.equal(reply.json.code, code, `${what}: ${reply.text}`);
    };
    // 400 first: a malformed request is refused before anything about GitHub is asked — even of one never connected.
    const malformed: Array<[string, unknown]> = [
      ['not an object', { github: 'octo/app' }],
      ['a repo id that is not a number', { github: { repoId: 'octo/app' } }],
      ['a negative repo id', { github: { repoId: -4 } }],
      ['a folder that is a path', { github: { repoId: APP_REPO, folder: 'a/b' } }],
      ['a folder of ..', { github: { repoId: APP_REPO, folder: '..' } }],
      ['a ref that is an option', { github: { repoId: APP_REPO, ref: '--upload-pack=x' } }],
      ['a ref with ..', { github: { repoId: APP_REPO, ref: 'a..b' } }],
      ['an unknown field', { github: { repoId: APP_REPO, url: 'https://evil.example/x.git' } }],
      ['two sources', { github: { repoId: APP_REPO }, newFolder: 'app' }],
    ];
    for (const [what, newWorkspace] of malformed) {
      await expect(`${what} (owner)`, await openSession(ownerToken, cloner, newWorkspace), 400);
      await expect(`${what} (never connected)`, await openSession(lonerToken, lonely, newWorkspace), 400);
    }
    // Another account's machine is the 403 any new workspace meets, before GitHub is asked.
    await expect('another account\'s machine', await openSession(strangerToken, cloner, { github: { repoId: APP_REPO } }), 403);
    // 409 GITHUB_NOT_CONNECTED next, on a runner that clones and on one that does not.
    await expect('never connected', await openSession(lonerToken, lonely, { github: { repoId: APP_REPO } }), 409, 'GITHUB_NOT_CONNECTED');
    // 403 GITHUB_REPO_FORBIDDEN next: the stranger's repository, and one that does not exist — even on a runner that
    // could not clone it, which is a later refusal.
    for (const machine of [cloner, old, rootless]) {
      await expect('the stranger\'s repository', await openSession(ownerToken, machine, { github: { repoId: SECRET_REPO } }), 403, 'GITHUB_REPO_FORBIDDEN');
      await expect('no such repository', await openSession(ownerToken, machine, { github: { repoId: base + 99 } }), 403, 'GITHUB_REPO_FORBIDDEN');
    }
    // The owner's repository the stranger asks for is just as forbidden to them.
    await expect('the owner\'s repository, asked by the stranger', await openSession(strangerToken, theirs, { github: { repoId: APP_REPO } }), 403, 'GITHUB_REPO_FORBIDDEN');
    // 409 CLONE_UNSUPPORTED next: a runner without clone-workdir/v1, and one that has not reported a reposRoot.
    await expect('a runner too old to clone', await openSession(ownerToken, old, { github: { repoId: APP_REPO } }), 409, 'CLONE_UNSUPPORTED');
    await expect('a runner with no reposRoot', await openSession(ownerToken, rootless, { github: { repoId: APP_REPO } }), 409, 'CLONE_UNSUPPORTED');
    // Then what any new workspace meets.
    await expect('the engine signed out', await openSession(ownerToken, signedOut, { github: { repoId: APP_REPO } }), 409, ENGINE_SIGNED_OUT);
    assert.deepEqual(await written(), before, 'no refusal wrote a workspace or a session');
  });

  // ── 2. made ───────────────────────────────────────────────────────────────────────────────────────────────────
  let appWorkspace = '';
  let appSession = '';
  let libWorkspace = '';
  let goneWorkspace = '';
  let theirWorkspace = '';
  let plainWorkspace = '';
  await t.test('2. accepted: the workspace at <reposRoot>/<folder>, its repository and clone PENDING, and its session, together', async () => {
    const made = await openSession(ownerToken, cloner, { github: { repoId: String(APP_REPO), ref: 'main' } });
    assert.equal(made.status, 201, made.text);
    appWorkspace = toUuid(made.json.workspaceId);
    appSession = toUuid(made.json.id);
    assert.deepEqual(await workspaceRow(appWorkspace), {
      name: 'app', runnerId: cloner.runnerId, workDir: `${ROOT}/app`, repoUrl: `https://github.com/octo-${RUN}/app.git`,
      repoId: String(APP_REPO), installationId: String(OWNER_INSTALLATION), cloneRef: 'main', cloneState: 'PENDING', cloneError: null,
      autoCreateWorkDir: false, started: false, finished: false,
    });
    assert.equal((await rows(`SELECT ${wordSql()} AS status FROM "session" WHERE "id" = $1::uuid`, [appSession]))[0].status, 'PENDING');
    // A clone's point is landing back to the repository (P2): the workspace isolates its sessions, and this one has its branch.
    assert.equal((await rows(`SELECT "enable_worktree" FROM "workspace" WHERE "id" = $1::uuid`, [appWorkspace]))[0].enable_worktree, true);
    assert.ok((await rows(`SELECT "branch" FROM "session" WHERE "id" = $1::uuid`, [appSession]))[0].branch, 'the first session runs on its own branch');
    const lib = await openSession(ownerToken, cloner, { github: { repoId: LIB_REPO, folder: 'lib-two' } });
    assert.equal(lib.status, 201, lib.text);
    libWorkspace = toUuid(lib.json.workspaceId);
    const libRow = await workspaceRow(libWorkspace);
    assert.deepEqual([libRow.workDir, libRow.cloneRef, libRow.cloneState], [`${ROOT}/lib-two`, null, 'PENDING'], 'the folder asked for, the default branch');
    const gone = await openSession(ownerToken, cloner, { github: { repoId: GONE_REPO } });
    assert.equal(gone.status, 201, gone.text);
    goneWorkspace = toUuid(gone.json.workspaceId);
    const mine = await openSession(strangerToken, theirs, { github: { repoId: SECRET_REPO } });
    assert.equal(mine.status, 201, mine.text);
    theirWorkspace = toUuid(mine.json.workspaceId);
    // On another runner: its session is claimable, and must not stand in for the gated ones on `cloner`.
    const plain = await openSession(ownerToken, second, { workDir: '/home/orbit/plain' });
    assert.equal(plain.status, 201, plain.text);
    plainWorkspace = toUuid(plain.json.workspaceId);
    assert.equal((await workspaceRow(plainWorkspace)).cloneState, null, 'a workspace not from GitHub has no clone');
  });

  // ── 3 + 4. reconcile and the gate ─────────────────────────────────────────────────────────────────────────────
  const listed = (answer: { cloneRequests?: Array<{ workspaceId: string }> }) => (answer.cloneRequests ?? []).map((c) => toUuid(c.workspaceId)).sort();
  const queuedReason = async (sessionId: string) => {
    const list = await api('GET', '/api/sessions?view=open', ownerToken);
    assert.equal(list.status, 200, list.text);
    const found = (list.json as Array<Record<string, unknown>>).find((x) => toUuid(String(x.id)) === sessionId);
    assert.ok(found, 'the queued session is in the list');
    return found.queuedReason;
  };
  const claim = async (machine: Machine) => {
    const reply = await api('GET', '/api/runner/sessions/claim', machine.token);
    assert.ok(reply.status === 200 || reply.status === 204, reply.text);
    return reply.json?.sessionId ? toUuid(reply.json.sessionId) : null;
  };
  const report = (machine: Machine, reports: unknown[], capabilities = `create-workdir/v1,${CLONE}`) => beat(machine, capabilities, { reposRoot: ROOT, cloneReports: reports });

  await t.test('3. the heartbeat lists every PENDING clone of the runner to it alone, and only its own reports move them', async () => {
    const answer = await beat(cloner, `create-workdir/v1,${CLONE}`, { reposRoot: ROOT });
    assert.deepEqual(listed(answer), [appWorkspace, libWorkspace, goneWorkspace].sort());
    const app = answer.cloneRequests.find((c: { workspaceId: string }) => toUuid(c.workspaceId) === appWorkspace);
    // The runner protocol's interceptor adds `workspacePublicId` and the legacy `agentId` beside every workspaceId.
    assert.deepEqual({ workspaceId: toUuid(app.workspaceId), workDir: app.workDir, url: app.url, ref: app.ref, state: app.state }, {
      workspaceId: appWorkspace, workDir: `${ROOT}/app`, url: `https://github.com/octo-${RUN}/app.git`, ref: 'main', state: 'PENDING',
    });
    assert.doesNotMatch(JSON.stringify(answer.cloneRequests), /ghs_|ghu_|x-access-token/, 'no credential in a URL');
    assert.equal('cloneRequests' in (await beat(cloner, 'create-workdir/v1', { reposRoot: ROOT })), false, 'not to a process without clone-workdir/v1');
    assert.deepEqual(listed(await beat(second, `create-workdir/v1,${CLONE}`, { reposRoot: '/srv/second' })), [], 'nor to another runner of the owner');
    assert.deepEqual(listed(await beat(theirs, CLONE, { reposRoot: '/srv/theirs' })), [theirWorkspace], 'the stranger\'s runner sees only its own');

    // Another runner's report, the same owner's or another account's, moves nothing.
    await beat(second, `create-workdir/v1,${CLONE}`, { reposRoot: '/srv/second', cloneReports: [{ workspaceId: appWorkspace, state: 'READY' }] });
    await beat(theirs, CLONE, { reposRoot: '/srv/theirs', cloneReports: [{ workspaceId: appWorkspace, state: 'FAILED', error: 'x' }] });
    assert.equal((await workspaceRow(appWorkspace)).cloneState, 'PENDING');
  });

  await t.test('4. a cloning or failed workspace\'s session is not dispatched; Retry is FAILED → PENDING only; READY dispatches', async () => {
    assert.equal(await claim(cloner), null, 'PENDING: not claimed');
    assert.equal(await queuedReason(appSession), 'WORKSPACE_CLONING');

    await report(cloner, [{ workspaceId: appWorkspace, state: 'CLONING', progress: 42, credential: 'github-app' }]);
    const cloning = await workspaceRow(appWorkspace);
    assert.deepEqual([cloning.cloneState, cloning.started, cloning.finished], ['CLONING', true, false]);
    assert.equal(await claim(cloner), null, 'CLONING: not claimed');
    assert.equal(await queuedReason(appSession), 'WORKSPACE_CLONING');
    assert.deepEqual(listed(await report(cloner, [{ workspaceId: appWorkspace, state: 'CLONING', progress: 80 }])).includes(appWorkspace), true, 'still listed while CLONING');

    const leaked = `ghs_${'A1b2C3d4'.repeat(5)}`;
    await report(cloner, [{ workspaceId: appWorkspace, state: 'FAILED', error: `fatal: Authentication failed for 'https://x-access-token:${leaked}@github.com/octo/app.git'` }]);
    const failed = await workspaceRow(appWorkspace);
    assert.equal(failed.cloneState, 'FAILED');
    assert.equal(failed.finished, true);
    assert.doesNotMatch(failed.cloneError, /ghs_/, 'the error is stored redacted');
    assert.match(failed.cloneError, /\[redacted\]/);
    assert.equal(await claim(cloner), null, 'FAILED: not claimed');
    assert.equal(await queuedReason(appSession), 'WORKSPACE_CLONE_FAILED');
    assert.equal(listed(await beat(cloner, `create-workdir/v1,${CLONE}`, { reposRoot: ROOT })).includes(appWorkspace), false, 'a FAILED clone is no longer requested');
    // A late report about a clone that has ended moves nothing.
    await report(cloner, [{ workspaceId: appWorkspace, state: 'READY' }]);
    assert.equal((await workspaceRow(appWorkspace)).cloneState, 'FAILED', 'only Retry moves FAILED on');

    const strangerRetry = await api('POST', `/api/workspaces/${uuidToBase62(appWorkspace)}/clone/retry`, strangerToken);
    assert.equal(strangerRetry.status, 404, strangerRetry.text);
    assert.equal((await workspaceRow(appWorkspace)).cloneState, 'FAILED', 'another account\'s Retry writes nothing');
    const notFailed = await api('POST', `/api/workspaces/${uuidToBase62(libWorkspace)}/clone/retry`, ownerToken);
    assert.equal(notFailed.status, 409, notFailed.text);
    assert.equal(notFailed.json.code, 'CLONE_NOT_FAILED');
    assert.equal((await workspaceRow(libWorkspace)).cloneState, 'PENDING');
    const plainRetry = await api('POST', `/api/workspaces/${uuidToBase62(plainWorkspace)}/clone/retry`, ownerToken);
    assert.equal(plainRetry.status, 409, plainRetry.text);
    const retried = await api('POST', `/api/workspaces/${uuidToBase62(appWorkspace)}/clone/retry`, ownerToken);
    assert.equal(retried.status, 200, retried.text);
    assert.equal(retried.json.cloneState, 'PENDING');
    const pending = await workspaceRow(appWorkspace);
    assert.deepEqual([pending.cloneState, pending.cloneError, pending.started, pending.finished], ['PENDING', null, false, false]);
    const again = await api('POST', `/api/workspaces/${uuidToBase62(appWorkspace)}/clone/retry`, ownerToken);
    assert.equal(again.status, 409, again.text);
    assert.equal(listed(await beat(cloner, `create-workdir/v1,${CLONE}`, { reposRoot: ROOT })).includes(appWorkspace), true, 'requested again');
    assert.equal(await claim(cloner), null, 'PENDING again: not claimed');

    await report(cloner, [{ workspaceId: appWorkspace, state: 'CLONING' }]);
    await report(cloner, [{ workspaceId: appWorkspace, state: 'READY', credential: 'github-app' }]);
    assert.equal((await workspaceRow(appWorkspace)).cloneState, 'READY');
    assert.equal((await rows(`SELECT "clone_credential" FROM "workspace" WHERE "id" = $1::uuid`, [appWorkspace]))[0].clone_credential, 'github-app', 'the credential the clone used is kept for Settings → GitHub');
    assert.equal(listed(await beat(cloner, `create-workdir/v1,${CLONE}`, { reposRoot: ROOT })).includes(appWorkspace), false);
    assert.equal(await claim(cloner), appSession, 'READY: claimed');
  });

  // ── 5. the git credential ─────────────────────────────────────────────────────────────────────────────────────
  const credential = (machine: Machine, body: Record<string, unknown>) => api('POST', '/api/runner/git-credential', machine.token, body);
  const minted = () => github.installationTokenRequests.length;

  await t.test('5. a token for the workspace\'s own repository alone, and only to the runner that owns the workspace', async () => {
    const ok = await credential(cloner, { workspaceId: appWorkspace, host: 'github.com', path: `octo-${RUN}/app.git` });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.username, 'x-access-token');
    assert.match(ok.json.password, /^ghs_/);
    assert.ok(Date.parse(ok.json.expiresAt) > Date.now() + 50 * 60_000, 'GitHub\'s expiry, an hour out');
    assert.deepEqual(github.installationTokenRequests.at(-1), {
      installationId: OWNER_INSTALLATION, repositoryIds: [APP_REPO], permissions: { contents: 'write', metadata: 'read' },
    }, 'restricted to the one repository, contents:write and metadata:read');
    const count = minted();

    // The same token again, from memory, while it has more than five minutes left; however git spells the path.
    for (const path of [`octo-${RUN}/app.git`, `/octo-${RUN}/app`, `OCTO-${RUN}/App/`]) {
      const reused = await credential(cloner, { workspaceId: appWorkspace, host: 'github.com', path });
      assert.equal(reused.status, 200, `${path}: ${reused.text}`);
      assert.equal(reused.json.password, ok.json.password);
    }
    assert.equal(minted(), count, 'nothing minted for a cached token');

    const refusals: Array<[string, Machine, Record<string, unknown>, number]> = [
      ['another runner of the same owner', second, { workspaceId: appWorkspace, host: 'github.com', path: `octo-${RUN}/app` }, 404],
      ['another account\'s runner', theirs, { workspaceId: appWorkspace, host: 'github.com', path: `octo-${RUN}/app` }, 404],
      ['another account\'s workspace', cloner, { workspaceId: theirWorkspace, host: 'github.com', path: `mallory-${RUN}/secret` }, 404],
      ['a workspace that does not exist', cloner, { workspaceId: randomUUID(), host: 'github.com', path: `octo-${RUN}/app` }, 404],
      ['a different host', cloner, { workspaceId: appWorkspace, host: 'gitlab.com', path: `octo-${RUN}/app` }, 403],
      ['a look-alike host', cloner, { workspaceId: appWorkspace, host: 'github.com.evil.example', path: `octo-${RUN}/app` }, 403],
      ['another repository of the owner', cloner, { workspaceId: appWorkspace, host: 'github.com', path: `octo-${RUN}/lib` }, 403],
      ['the stranger\'s repository', cloner, { workspaceId: appWorkspace, host: 'github.com', path: `mallory-${RUN}/secret` }, 403],
      ['a path that walks out', cloner, { workspaceId: appWorkspace, host: 'github.com', path: `octo-${RUN}/app/../lib` }, 403],
      ['the stranger\'s runner asking its workspace for the owner\'s repository', theirs, { workspaceId: theirWorkspace, host: 'github.com', path: `octo-${RUN}/app` }, 403],
      ['a workspace not from GitHub', second, { workspaceId: plainWorkspace, host: 'github.com', path: `octo-${RUN}/app` }, 409],
      ['no workspace id', cloner, { host: 'github.com', path: `octo-${RUN}/app` }, 400],
    ];
    for (const [what, machine, body, status] of refusals) {
      const reply = await credential(machine, body);
      assert.equal(reply.status, status, `${what}: ${reply.text}`);
      assert.doesNotMatch(reply.text, /ghs_/, `${what}: no token in the refusal`);
    }
    assert.equal(minted(), count, 'no refusal minted a token');
    // A user's bearer is not a runner's.
    assert.equal((await api('POST', '/api/runner/git-credential', ownerToken, { workspaceId: appWorkspace, host: 'github.com', path: `octo-${RUN}/app` })).status, 401);

    // The stranger's own runner gets its own repository's token, from its own installation.
    const theirsOk = await credential(theirs, { workspaceId: theirWorkspace, host: 'github.com', path: `mallory-${RUN}/secret` });
    assert.equal(theirsOk.status, 200, theirsOk.text);
    assert.deepEqual(github.installationTokenRequests.at(-1)?.repositoryIds, [SECRET_REPO]);
    assert.equal(github.installationTokenRequests.at(-1)?.installationId, STRANGER_INSTALLATION);
  });

  await t.test('5b. a token close to its expiry is minted again; a repository the owner lost is 403; an uninstalled App is 409', async () => {
    github.installationTokenLifetime = 4 * 60;
    const first = await credential(cloner, { workspaceId: libWorkspace, host: 'github.com', path: `octo-${RUN}/lib` });
    assert.equal(first.status, 200, first.text);
    const count = minted();
    const second_ = await credential(cloner, { workspaceId: libWorkspace, host: 'github.com', path: `octo-${RUN}/lib` });
    assert.equal(second_.status, 200, second_.text);
    assert.equal(minted(), count + 1, 'within five minutes of its expiry a token is not handed again');
    assert.notEqual(second_.json.password, first.json.password);

    // The owner can no longer see a repository on GitHub: refused, with nothing minted.
    const installation = octo.installations[0];
    installation.repos = installation.repos.filter((r) => r.id !== GONE_REPO);
    const before = minted();
    const lost = await credential(cloner, { workspaceId: goneWorkspace, host: 'github.com', path: `octo-${RUN}/gone` });
    assert.equal(lost.status, 403, lost.text);
    assert.equal(lost.json.code, 'GITHUB_REPO_FORBIDDEN');
    assert.equal(minted(), before);

    // The App uninstalled on GitHub: the message the design gives.
    github.uninstalled.add(OWNER_INSTALLATION);
    const uninstalled = await credential(cloner, { workspaceId: libWorkspace, host: 'github.com', path: `octo-${RUN}/lib` });
    assert.equal(uninstalled.status, 409, uninstalled.text);
    assert.equal(uninstalled.json.code, 'GITHUB_APP_NOT_INSTALLED');
    assert.match(uninstalled.json.message, /no longer installed on octo-.+\/lib/);
    github.uninstalled.delete(OWNER_INSTALLATION);
    github.installationTokenLifetime = 3600;
  });

  // ── 6. never kept ─────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('6. no installation token is in any table, nor in the apiserver\'s log', async () => {
    assert.ok(github.installationTokens.length >= 3, 'tokens were minted');
    const tables = await rows(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`);
    for (const { name } of tables) {
      const hits = await rows(`SELECT count(*)::int AS n FROM "${name}" t WHERE t::text ~ $1`, [github.installationTokens.join('|')]);
      assert.equal(hits[0].n, 0, `a token is stored in ${name}`);
    }
    const log = server!.output();
    for (const token of github.installationTokens) assert.equal(log.includes(token), false, 'a token is in the apiserver log');
  });
});

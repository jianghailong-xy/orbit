/**
 * GitHub-backed workspaces, P0 (docs/github-workspace-design.md §4, §5.1, §5.2), against a real PostgreSQL
 * that `scripts/run-pg-spec.sh` migrates from empty: the GitHub controllers, the global pipe, interceptors
 * and filters main.ts installs, the real JwtAuthGuard and AdminRoleGuard, PatService and both GitHub
 * services over that database. Only GitHub is not real: the in-process fake (test-support/fake-github.ts)
 * answers it, and nothing reaches the network. What it is held to:
 *
 *   (1) 0538 made what it describes: the three tables, the seven nullable workspace columns, the CHECK on
 *       clone_state, and it runs again unchanged;
 *   (2) the admin setting: off with no row; a save GitHub does not vouch for — a key of another App, an
 *       App ID GitHub does not know, a client ID that is not the App's, a key that is not a key — is
 *       refused GITHUB_APP_CHECK_FAILED with nothing written; a good save stores the slug GitHub answered
 *       and both secrets encrypted; a save without them keeps them byte for byte; a secret the key in
 *       force cannot decrypt answers secretUnreadable and turns GitHub off for users; only an ADMIN login
 *       reaches it;
 *   (3) connecting: /start answers GitHub's authorization URL with state and an S256 challenge and sets
 *       the binding cookie, keeping only hashes; the callback trades the code with the verifier, stores
 *       both tokens encrypted, and sends the browser back to the page it came from; the flow is one use,
 *       bound to its browser, and ten minutes; a return path off this site is not taken; a GitHub account
 *       connected to another Orbit account is refused GITHUB_ACCOUNT_IN_USE with nothing written;
 *   (4) the lists: private repositories across installations, most recently pushed first, `q` and the
 *       cursor; branches, default first, and another account's repository 404 GITHUB_REPO_NOT_FOUND;
 *       an expired access token is refreshed once, and a dead refresh token or a revoked authorization
 *       answers GITHUB_NOT_CONNECTED and needsReconnect;
 *   (5) disconnecting deletes the connection and revokes the token on GitHub;
 *   (6) an access token needs workspaces:write; and no answer carries a secret or a GitHub token.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/github/github-connection.pg.spec.ts
 */
process.env.PROVIDER_SECRET_KEY = `github-pg-${Math.random()}`;
process.env.PUBLIC_ORIGIN = 'https://orbit.example.test';

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Client } from 'pg';

import { PatService } from '../auth/pat.service';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { decryptSecret, encryptSecret } from '../providers/provider-crypto';
import { FakeGithub, type FakeGithubUser, type FakeRepo } from '../test-support/fake-github';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { GithubClient } from './github-api.client';
import { GithubAdminController } from './github-admin.controller';
import { GithubAppConfigService } from './github-app-config.service';
import { GITHUB_REPO_PAGE, GithubConnectionService } from './github-connection.service';
import { GithubCallbackController, GithubController } from './github.controller';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const CALLBACK = 'https://orbit.example.test/api/integrations/github/callback';
const MIGRATION = readFileSync(path.resolve(__dirname, '../../prisma/migrations/0538_github_app_connection/migration.sql'), 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const s256 = (text: string) => createHash('sha256').update(text).digest('base64url');

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  location: string | null;
  setCookie: string | null;
}

interface Account {
  id: string;
  bearer: string;
}

/** `n` repositories of `owner`, the first pushed most recently. */
function repos(owner: string, firstId: number, n: number, options: { private?: boolean } = {}): FakeRepo[] {
  return Array.from({ length: n }, (_, i) => ({
    id: firstId + i,
    fullName: `${owner}/repo-${String(i).padStart(2, '0')}`,
    private: options.private ?? true,
    defaultBranch: 'main',
    pushedAt: new Date(Date.UTC(2026, 10, 1) - i * 3_600_000).toISOString(),
    branches: ['feature/x', 'main', 'release'],
  }));
}

test('GitHub P0 on PostgreSQL: the App setting, connecting through the code flow, the lists, refresh, disconnect, and the doors', {
  skip: !URL_, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db = prismaClientFor(url);
  const github = new FakeGithub();
  const jwt = new JwtService({ secret: `github-${RUN}`, signOptions: { expiresIn: '7d' } });
  let app: INestApplication | undefined;
  t.after(async () => {
    await app?.close();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = async (query: string, values: unknown[] = []): Promise<any[]> => (await sql.query(query, values)).rows;

  @Module({
    controllers: [GithubAdminController, GithubController, GithubCallbackController],
    providers: [
      PatService,
      AdminRoleGuard,
      GithubAppConfigService,
      GithubConnectionService,
      { provide: GithubClient, useValue: new GithubClient(github.fetch) },
      { provide: JwtService, useValue: jwt },
      { provide: PrismaService, useValue: db },
    ],
  })
  class GithubHarness {}
  app = await NestFactory.create(GithubHarness, { logger: false, abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  /** Every answer, for (6). */
  const answers: Answer[] = [];
  const call = async (method: string, route: string, options: { body?: unknown; cookie?: string; bearer?: string } = {}): Promise<Answer> => {
    const response = await fetch(`${base}${route}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(options.cookie ? { cookie: `orbit_github_flow=${options.cookie}` } : {}),
        ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const answer = { status: response.status, text, json, location: response.headers.get('location'), setCookie: response.headers.get('set-cookie') };
    answers.push(answer);
    return answer;
  };

  const account = async (name: string, role: 'ADMIN' | 'MEMBER' = 'MEMBER'): Promise<Account> => {
    const id = randomUUID();
    const email = `${name}-${RUN}@github.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, role) VALUES ($1, $2, $3, $4)`, [id, email, name, role]);
    return { id, bearer: await jwt.signAsync({ sub: id, email }) };
  };

  /** /start then GitHub then the callback, in one browser: the callback's answer. */
  const connect = async (who: Account, user: FakeGithubUser, returnTo?: string): Promise<Answer> => {
    const started = await call('GET', `/api/integrations/github/start${returnTo === undefined ? '' : `?return=${encodeURIComponent(returnTo)}`}`, { bearer: who.bearer });
    assert.equal(started.status, 200, started.text);
    const cookie = /^orbit_github_flow=([^;]+)/.exec(started.setCookie ?? '')![1];
    return call('GET', github.authorize(started.json.authorizationUrl, user), { cookie });
  };

  const admin = await account('admin', 'ADMIN');
  const ada = await account('ada');
  const bob = await account('bob');
  const octo: FakeGithubUser = {
    id: 9001,
    login: `octo-${RUN}`,
    installations: [
      { id: 71, account: `octo-${RUN}`, type: 'User', selection: 'selected', repos: repos(`octo-${RUN}`, 1000, 3) },
      { id: 72, account: `labs-${RUN}`, type: 'Organization', selection: 'all', repos: repos(`labs-${RUN}`, 2000, 40, { private: false }) },
    ],
  };
  const bobsGithub: FakeGithubUser = {
    id: 9002,
    login: `bob-${RUN}`,
    installations: [{ id: 81, account: `bob-${RUN}`, type: 'User', selection: 'selected', repos: repos(`bob-${RUN}`, 3000, 2) }],
  };
  const goodSave = { enabled: true, appId: String(github.appId), clientId: github.clientId, clientSecret: github.clientSecret, privateKey: github.privateKey };

  await t.test('(1) 0538 made the tables and columns it describes, and runs again', async () => {
    const columns = await rows(
      `SELECT column_name, udt_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'workspace' AND column_name IN
          ('github_repo_id', 'github_installation_id', 'clone_ref', 'clone_state', 'clone_error', 'clone_started_at', 'clone_finished_at')
        ORDER BY column_name`,
    );
    assert.deepEqual(columns.map((c) => `${c.column_name} ${c.udt_name} ${c.is_nullable}`), [
      'clone_error text YES', 'clone_finished_at timestamptz YES', 'clone_ref text YES', 'clone_started_at timestamptz YES',
      'clone_state text YES', 'github_installation_id int8 YES', 'github_repo_id int8 YES',
    ]);
    const tables = await rows(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()
      AND table_name IN ('github_app_config', 'github_connection', 'github_oauth_flow') ORDER BY table_name`);
    assert.deepEqual(tables.map((r) => r.table_name), ['github_app_config', 'github_connection', 'github_oauth_flow']);
    await sql.query(MIGRATION);
    const workspace = await db.workspace.create({ data: { name: `ws-${RUN}`, ownerId: ada.id } });
    await assert.rejects(sql.query(`UPDATE workspace SET clone_state = 'DONE' WHERE id = $1`, [workspace.id]), /workspace_clone_state_chk/);
    for (const state of ['PENDING', 'CLONING', 'READY', 'FAILED', null]) {
      await sql.query(`UPDATE workspace SET clone_state = $2 WHERE id = $1`, [workspace.id, state]);
    }
    await db.workspace.delete({ where: { id: workspace.id } });
  });

  await t.test('(2) the admin setting: checked with GitHub on save, secrets write-only, unreadable after a key rotation', async () => {
    const empty = await call('GET', '/api/admin/integrations/github', { bearer: admin.bearer });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, {
      enabled: false, appId: null, slug: null, clientId: '', secretSaved: false, keySaved: false, secretUnreadable: false,
      callbackUrl: CALLBACK, connectedUsers: 0, clonedWorkspaces: 0,
    });
    assert.equal((await call('GET', '/api/integrations/github', { bearer: ada.bearer })).json.available, false);
    assert.equal((await call('GET', '/api/integrations/github/start', { bearer: ada.bearer })).json.code, 'GITHUB_NOT_CONFIGURED');

    const refused = [
      { ...goodSave, privateKey: github.otherPrivateKey },
      { ...goodSave, appId: '777' },
      { ...goodSave, clientId: 'Iv23liSomeOtherApp' },
      { ...goodSave, privateKey: 'not a key' },
      { ...goodSave, privateKey: undefined },
    ];
    for (const body of refused) {
      const answer = await call('PUT', '/api/admin/integrations/github', { bearer: admin.bearer, body });
      assert.equal(answer.status, 400, answer.text);
      assert.equal(answer.json.code, 'GITHUB_APP_CHECK_FAILED', answer.text);
    }
    assert.deepEqual(await rows('SELECT id FROM github_app_config'), []);

    assert.equal((await call('PUT', '/api/admin/integrations/github', { bearer: ada.bearer, body: goodSave })).status, 403);
    assert.equal((await call('PUT', '/api/admin/integrations/github', { body: goodSave })).status, 401);
    const pats = new PatService(db as unknown as PrismaService);
    const adminPat = (await pats.issue(admin.id, { name: `all ${RUN}`, scopes: ['workspaces:write', 'workspaces:read'], expiresInDays: 30, createdVia: 'WEB' })).token;
    assert.equal((await call('PUT', '/api/admin/integrations/github', { bearer: adminPat, body: goodSave })).status, 403);
    assert.deepEqual(await rows('SELECT id FROM github_app_config'), []);

    const saved = await call('PUT', '/api/admin/integrations/github', { bearer: admin.bearer, body: goodSave });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.json, {
      enabled: true, appId: String(github.appId), slug: github.slug, clientId: github.clientId, secretSaved: true, keySaved: true,
      secretUnreadable: false, callbackUrl: CALLBACK, connectedUsers: 0, clonedWorkspaces: 0,
    });
    const [row] = await rows('SELECT * FROM github_app_config');
    assert.equal(row.slug, github.slug);
    assert.equal(row.updated_by_id, admin.id);
    assert.equal(decryptSecret(row.client_secret_enc), github.clientSecret);
    assert.equal(decryptSecret(row.private_key_enc), github.privateKey.trim());
    assert.ok(!row.client_secret_enc.includes(github.clientSecret));

    // A save without the secrets keeps them byte for byte.
    const kept = await call('PUT', '/api/admin/integrations/github', { bearer: admin.bearer, body: { enabled: true, appId: String(github.appId), clientId: github.clientId } });
    assert.equal(kept.status, 200, kept.text);
    const [after] = await rows('SELECT * FROM github_app_config');
    assert.equal(after.client_secret_enc, row.client_secret_enc);
    assert.equal(after.private_key_enc, row.private_key_enc);

    // What a PROVIDER_SECRET_KEY rotation leaves behind: GitHub is off for users until it is entered again.
    const inForce = process.env.PROVIDER_SECRET_KEY;
    process.env.PROVIDER_SECRET_KEY = `${inForce}-before-the-rotation`;
    const stale = encryptSecret(github.clientSecret);
    process.env.PROVIDER_SECRET_KEY = inForce;
    await sql.query('UPDATE github_app_config SET client_secret_enc = $1', [stale]);
    assert.equal((await call('GET', '/api/admin/integrations/github', { bearer: admin.bearer })).json.secretUnreadable, true);
    assert.equal((await call('GET', '/api/integrations/github', { bearer: ada.bearer })).json.available, false);
    const unreadable = await call('PUT', '/api/admin/integrations/github', { bearer: admin.bearer, body: { enabled: true, appId: String(github.appId), clientId: github.clientId } });
    assert.equal(unreadable.json.code, 'GITHUB_APP_CHECK_FAILED');
    const fixed = await call('PUT', '/api/admin/integrations/github', { bearer: admin.bearer, body: { ...goodSave, privateKey: undefined } });
    assert.equal(fixed.status, 200, fixed.text);
    assert.equal(fixed.json.secretUnreadable, false);
    assert.equal((await call('GET', '/api/integrations/github', { bearer: ada.bearer })).json.available, true);
  });

  await t.test('(3) connecting: state, PKCE and the browser binding, one use, ten minutes, one Orbit account per GitHub account', async () => {
    const before = await call('GET', '/api/integrations/github', { bearer: ada.bearer });
    assert.deepEqual(before.json, {
      available: true, connected: false, login: null, connectedAt: null, needsReconnect: false, installations: [],
      installUrl: `https://github.com/apps/${github.slug}/installations/new`, workspaceCount: 0,
    });
    assert.equal((await call('GET', '/api/integrations/github/repos', { bearer: ada.bearer })).json.code, 'GITHUB_NOT_CONNECTED');

    const started = await call('GET', `/api/integrations/github/start?return=${encodeURIComponent('/machines/m1?step=folder')}`, { bearer: ada.bearer });
    assert.equal(started.status, 200, started.text);
    const authorization = new URL(started.json.authorizationUrl);
    assert.equal(`${authorization.origin}${authorization.pathname}`, 'https://github.com/login/oauth/authorize');
    assert.equal(authorization.searchParams.get('client_id'), github.clientId);
    assert.equal(authorization.searchParams.get('redirect_uri'), CALLBACK);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    const state = authorization.searchParams.get('state')!;
    assert.match(started.setCookie ?? '', /^orbit_github_flow=[^;]+; HttpOnly; SameSite=Lax; Path=\/api\/integrations\/github; Max-Age=600; Secure$/);
    const cookie = /^orbit_github_flow=([^;]+)/.exec(started.setCookie!)![1];
    const [flow] = await rows('SELECT * FROM github_oauth_flow WHERE owner_id = $1', [ada.id]);
    assert.equal(flow.state_hash, sha256(state));
    assert.equal(flow.binding_hash, sha256(cookie));
    assert.equal(s256(flow.code_verifier), authorization.searchParams.get('code_challenge'));
    assert.equal(flow.return_path, '/machines/m1?step=folder');

    // Another browser cannot finish it, and trying ends it.
    const callbackPath = github.authorize(started.json.authorizationUrl, octo);
    const elsewhere = await call('GET', callbackPath, { cookie: 'someone-elses-cookie' });
    assert.equal(elsewhere.location, '/machines/m1?step=folder&github_error=GITHUB_FLOW_EXPIRED');
    assert.match(elsewhere.setCookie ?? '', /Max-Age=0/);
    assert.equal((await call('GET', callbackPath, { cookie })).location, '/settings/integrations/github?github_error=GITHUB_FLOW_EXPIRED');
    assert.deepEqual(await rows('SELECT id FROM github_connection'), []);

    // Ten minutes.
    const late = await call('GET', '/api/integrations/github/start', { bearer: ada.bearer });
    const lateCookie = /^orbit_github_flow=([^;]+)/.exec(late.setCookie!)![1];
    await sql.query(`UPDATE github_oauth_flow SET expires_at = now() - interval '1 second' WHERE owner_id = $1`, [ada.id]);
    assert.equal((await call('GET', github.authorize(late.json.authorizationUrl, octo), { cookie: lateCookie })).location,
      '/settings/integrations/github?github_error=GITHUB_FLOW_EXPIRED');

    // Declined on GitHub.
    const declined = await call('GET', '/api/integrations/github/start', { bearer: ada.bearer });
    const declinedCookie = /^orbit_github_flow=([^;]+)/.exec(declined.setCookie!)![1];
    const declinedState = new URL(declined.json.authorizationUrl).searchParams.get('state')!;
    assert.equal((await call('GET', `/api/integrations/github/callback?error=access_denied&state=${declinedState}`, { cookie: declinedCookie })).location,
      '/settings/integrations/github?github_error=GITHUB_DENIED');

    // A return path off this site is not taken.
    const offsite = await call('GET', `/api/integrations/github/start?return=${encodeURIComponent('//evil.example/x')}`, { bearer: ada.bearer });
    assert.equal(offsite.status, 200);
    assert.deepEqual((await rows('SELECT return_path FROM github_oauth_flow WHERE owner_id = $1 AND expires_at > now()', [ada.id])).map((r) => r.return_path), ['/settings/integrations/github']);

    // The flow end to end.
    const done = await connect(ada, octo, '/machines/m1?step=folder');
    assert.equal(done.status, 302);
    assert.equal(done.location, '/machines/m1?step=folder&github=connected');
    const exchange = github.tokenRequests.at(-1)!;
    assert.equal(exchange.get('redirect_uri'), CALLBACK);
    assert.ok(exchange.get('code_verifier'));
    const [connection] = await rows('SELECT * FROM github_connection WHERE owner_id = $1', [ada.id]);
    assert.equal(connection.github_user_id, String(octo.id));
    assert.equal(connection.login, octo.login);
    assert.ok(github.issued.includes(decryptSecret(connection.access_token_enc)));
    assert.ok(github.issued.includes(decryptSecret(connection.refresh_token_enc)));
    assert.ok(!github.issued.some((token) => connection.access_token_enc.includes(token)));
    assert.ok(Math.abs(new Date(connection.access_expires_at).getTime() - (Date.now() + 8 * 3600_000)) < 60_000);

    // One Orbit account per GitHub account.
    const taken = await connect(bob, octo);
    assert.equal(taken.location, '/settings/integrations/github?github_error=GITHUB_ACCOUNT_IN_USE');
    assert.deepEqual(await rows('SELECT owner_id FROM github_connection'), [{ owner_id: ada.id }]);

    // GitHub's return from an installation carries none of our state: back to the page, nothing written.
    assert.equal((await call('GET', '/api/integrations/github/callback?code=x&installation_id=5&setup_action=install')).location,
      '/settings/integrations/github?github=installed');

    const view = await call('GET', '/api/integrations/github', { bearer: ada.bearer });
    assert.equal(view.json.connected, true);
    assert.equal(view.json.login, octo.login);
    assert.equal(view.json.needsReconnect, false);
    assert.deepEqual(view.json.installations, [
      { id: 71, account: `octo-${RUN}`, type: 'User', repositorySelection: 'selected', repositoryCount: 3 },
      { id: 72, account: `labs-${RUN}`, type: 'Organization', repositorySelection: 'all', repositoryCount: 40 },
    ]);
  });

  await t.test('(4) the lists: repositories and branches from the user token, refresh, and a dead connection', async () => {
    const first = await call('GET', '/api/integrations/github/repos', { bearer: ada.bearer });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.repositories.length, GITHUB_REPO_PAGE);
    // Both installations' repositories pushed at the same hours: most recent first, either one.
    assert.deepEqual(first.json.repositories.slice(0, 2).map((r: { pushedAt: string }) => r.pushedAt), [octo.installations[0].repos[0].pushedAt, octo.installations[0].repos[0].pushedAt]);
    assert.deepEqual(Object.keys(first.json.repositories[0]).sort(), ['defaultBranch', 'fullName', 'id', 'installationId', 'private', 'pushedAt']);
    const second = await call('GET', `/api/integrations/github/repos?cursor=${first.json.nextCursor}`, { bearer: ada.bearer });
    assert.equal(second.json.repositories.length, 43 - GITHUB_REPO_PAGE);
    assert.equal(second.json.nextCursor, null);
    const privates = await call('GET', `/api/integrations/github/repos?q=${encodeURIComponent(`octo-${RUN}/`)}`, { bearer: ada.bearer });
    assert.deepEqual(privates.json.repositories.map((r: { fullName: string; private: boolean }) => [r.fullName, r.private]),
      octo.installations[0].repos.map((r) => [r.fullName, true]));
    assert.equal((await call('GET', '/api/integrations/github/repos?cursor=-3', { bearer: ada.bearer })).status, 400);

    const branches = await call('GET', '/api/integrations/github/repos/1000/branches', { bearer: ada.bearer });
    assert.deepEqual(branches.json, { defaultBranch: 'main', branches: ['main', 'feature/x', 'release'] });
    assert.deepEqual((await call('GET', '/api/integrations/github/repos/1000/branches?q=rel', { bearer: ada.bearer })).json.branches, ['release']);

    // Bob's own GitHub cannot see Ada's repository.
    assert.equal((await connect(bob, bobsGithub)).location, '/settings/integrations/github?github=connected');
    const foreign = await call('GET', '/api/integrations/github/repos/1000/branches', { bearer: bob.bearer });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.json.code, 'GITHUB_REPO_NOT_FOUND');

    // An access token past its expiry is refreshed, once, and the new pair stored.
    const [old] = await rows('SELECT * FROM github_connection WHERE owner_id = $1', [ada.id]);
    await sql.query(`UPDATE github_connection SET access_expires_at = now() - interval '1 minute' WHERE owner_id = $1`, [ada.id]);
    const refreshesBefore = github.tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token').length;
    const views = await Promise.all([1, 2, 3].map(() => call('GET', '/api/integrations/github', { bearer: ada.bearer })));
    for (const view of views) assert.equal(view.json.needsReconnect, false, view.text);
    assert.equal(github.tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token').length, refreshesBefore + 1);
    const [renewed] = await rows('SELECT * FROM github_connection WHERE owner_id = $1', [ada.id]);
    assert.notEqual(decryptSecret(renewed.access_token_enc), decryptSecret(old.access_token_enc));
    assert.ok(new Date(renewed.access_expires_at).getTime() > Date.now());

    // A refresh token past its expiry: reconnect.
    await sql.query(`UPDATE github_connection SET access_expires_at = now(), refresh_expires_at = now() WHERE owner_id = $1`, [ada.id]);
    assert.equal((await call('GET', '/api/integrations/github', { bearer: ada.bearer })).json.needsReconnect, true);
    assert.equal((await call('GET', '/api/integrations/github/repos', { bearer: ada.bearer })).json.code, 'GITHUB_NOT_CONNECTED');

    // Reconnecting the same GitHub account to the same Orbit account replaces its tokens.
    assert.equal((await connect(ada, octo)).location, '/settings/integrations/github?github=connected');
    assert.equal((await call('GET', '/api/integrations/github', { bearer: ada.bearer })).json.needsReconnect, false);

    // The user revoked Orbit's authorization on GitHub.
    github.revokeAll(bobsGithub);
    const revoked = await call('GET', '/api/integrations/github', { bearer: bob.bearer });
    assert.equal(revoked.json.needsReconnect, true);
    assert.equal(revoked.json.connected, true);
  });

  await t.test('(5) disconnecting deletes the connection and revokes its token on GitHub', async () => {
    await db.workspace.create({ data: { name: `cloned-${RUN}`, ownerId: ada.id, githubRepoId: BigInt(1000), githubInstallationId: BigInt(71), cloneState: 'READY' } });
    assert.equal((await call('GET', '/api/integrations/github', { bearer: ada.bearer })).json.workspaceCount, 1);
    assert.deepEqual(
      (({ connectedUsers, clonedWorkspaces }) => ({ connectedUsers, clonedWorkspaces }))((await call('GET', '/api/admin/integrations/github', { bearer: admin.bearer })).json),
      { connectedUsers: 2, clonedWorkspaces: 1 },
    );
    const [row] = await rows('SELECT access_token_enc FROM github_connection WHERE owner_id = $1', [ada.id]);
    const token = decryptSecret(row.access_token_enc);
    const gone = await call('DELETE', '/api/integrations/github', { bearer: ada.bearer });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(gone.json.connected, false);
    assert.equal(gone.json.workspaceCount, 1);
    assert.deepEqual(await rows('SELECT id FROM github_connection WHERE owner_id = $1', [ada.id]), []);
    assert.ok(github.revoked.includes(token));
    assert.equal((await call('DELETE', '/api/integrations/github', { bearer: ada.bearer })).status, 200);
  });

  await t.test('(6) an access token needs workspaces:write; no answer carries a secret or a GitHub token', async () => {
    const pats = new PatService(db as unknown as PrismaService);
    const read = (await pats.issue(bob.id, { name: `read ${RUN}`, scopes: ['workspaces:read'], expiresInDays: 30, createdVia: 'WEB' })).token;
    const write = (await pats.issue(bob.id, { name: `write ${RUN}`, scopes: ['workspaces:write'], expiresInDays: 30, createdVia: 'WEB' })).token;
    for (const route of ['/api/integrations/github', '/api/integrations/github/repos', '/api/integrations/github/start']) {
      const refused = await call('GET', route, { bearer: read });
      assert.equal(refused.status, 403, `${route} ${refused.text}`);
    }
    assert.equal((await call('DELETE', '/api/integrations/github', { bearer: read })).status, 403);
    assert.equal((await call('GET', '/api/integrations/github', { bearer: write })).status, 200);

    const secrets = [github.clientSecret, github.privateKey.split('\n')[1], ...github.issued];
    for (const answer of answers) {
      for (const secret of secrets) assert.ok(!answer.text.includes(secret) && !(answer.location ?? '').includes(secret), `an answer carried a secret: ${answer.text.slice(0, 200)}`);
    }
  });
});

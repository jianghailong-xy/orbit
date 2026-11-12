/**
 * The owner channel is closed to personal access tokens (docs/personal-access-token-design.md §4,
 * §5), held against the production apiserver — `build/main.js`, the whole AppModule — over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty. What it is held to:
 *
 *   (1) every door in OWNER_INTERACTIVE_ROUTES, a case each: a token holding every scope is
 *       answered 403 OWNER_INTERACTIVE_CREDENTIAL_REQUIRED with requiredAction OPEN_ORBIT, and the
 *       same request with a login is answered by the door itself, as it always was — and where the
 *       door can be stood up for real here, it does its work for the login and nothing for the token;
 *   (2) auth/*, admin/*, admitting a runner and rotating its token, and share links: a token is
 *       answered 403 PAT_FORBIDDEN with the family's reason, and a login reaches the same door;
 *   (3) on routes a token reaches with its scope, the fields that are the account owner's own
 *       decision — PATCH /projects/:id `status` (DONE, CANCELLED and OPEN), `integration` and
 *       `acceptanceCriteriaItems`; POST /projects `integration`; on both of those, the project's
 *       authorization set and coordinator (`automatic`, `coordinatorEnabled`, `maxConcurrentTasks`,
 *       `sessionBudgetPerDay`, `coordinatorAgentId`); POST /wiki/spaces `maintenance`;
 *       PATCH /wiki/spaces/:id `reviewMode`, `maintenance` and `automaticSpotChecks`;
 *       PATCH /sessions/:id/config, POST /sessions/:id/resume and POST /sessions `permissionMode`, to
 *       any value — refuse a token the whole request, 403 OWNER_INTERACTIVE_CREDENTIAL_REQUIRED naming
 *       them, and write nothing it carried; every other field is written for the token, and a session
 *       it opens without a mode opens in the account's default one; and a login writes the owner's
 *       fields as before.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/pat-owner-channel.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { hashChatTicket } from '../feishu/feishu-chat-route.service';
import { OWNER_INTERACTIVE_ROUTES } from './pat-owner-channel-routes';
import { PAT_FORBIDDEN_REASONS, type PatForbiddenReason } from './pat-scope.decorator';
import { PAT_SCOPES, PatService } from './pat.service';
import { call, startApiserver, type Apiserver, type Reply } from './pat-test-apiserver';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

/** What a door closed to every token answers one with. */
const REFUSED = (reason: PatForbiddenReason) => ({
  code: reason === 'OWNER_INTERACTIVE' ? 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED' : 'PAT_FORBIDDEN',
  reason,
  requiredAction: 'OPEN_ORBIT',
  message: PAT_FORBIDDEN_REASONS[reason],
});

/** A door, as this spec knocks on it with a token and then with a login. */
interface Door {
  /** `POST /projects/:id/pause`: the route as the census names it. */
  route: string;
  /** The request's path under /api, its parameters filled in. */
  path: string;
  body?: unknown;
  /** The status the door answers a login with. */
  login: number;
  /**
   * The door's work, where it can be stood up for real here: read before the token knocks, after it
   * (unchanged — the token wrote nothing), and after the login (changed — the door did its work).
   */
  observe?: () => Promise<unknown>;
}

const methodOf = (route: string) => route.slice(0, route.indexOf(' '));

/** Whether `path` is a path `route` answers: each `:param` one segment, everything else as written. */
function answers(route: string, path: string): boolean {
  const template = route.slice(route.indexOf(' ') + 1);
  const pattern = template.split('/').map((part) => (part.startsWith(':') ? '[^/?]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return new RegExp(`^${pattern.join('/')}(\\?.*)?$`).test(path);
}

test('the owner channel refuses a personal access token door by door and field by field, and answers a login as before', {
  skip: !URL, concurrency: 1, timeout: 600_000,
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

  // One account — an administrator, so admin/* has a login it answers — with a runner and a workspace.
  const userId = randomUUID();
  const email = `owner-channel-${RUN}-${userId}@personal-access-token.invalid`;
  await db.user.create({ data: { id: userId, email, name: 'Owner', passwordHash: hashPassword('the-first-password'), role: 'ADMIN' } });
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({ data: { id: runnerId, ownerId: userId, name: 'a runner', tokenHash: `owner-channel-${runnerId}` } });
  await db.workspace.create({ data: { id: workspaceId, ownerId: userId, runnerId, name: `orbit ${RUN}`, enabled: true } });

  const pats = new PatService(db as unknown as PrismaService);
  const token = (await pats.issue(userId, { name: 'every scope', scopes: [...PAT_SCOPES], expiresInDays: 90, createdVia: 'WEB' })).token;
  const jwtSecret = `owner-channel-${randomUUID()}`;
  const login = await new JwtService({ secret: jwtSecret }).signAsync({ sub: userId, email });
  server = await startApiserver(url, jwtSecret, { ORBIT_WIKI: 'on', PROVIDER_SECRET_KEY: `owner-channel-secrets-${RUN}` });
  const api = (method: string, path: string, bearer: string, body?: unknown): Promise<Reply> =>
    call(server!, method, `/api${path}`, bearer, body);
  const ok = (reply: Reply, what: string) => {
    assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text}`);
    return reply;
  };
  /** An id that names no row. */
  const nobody = () => randomUUID();

  // ── What the doors are knocked on: rows made through the owner's own doors, with a login ──────

  const criterion = { text: 'every owner door refuses a token', verificationMethod: 'a spec per door' };
  const project = async (title: string): Promise<string> =>
    toUuid(ok(await api('POST', '/projects', login, { title, acceptanceCriteriaItems: [criterion] }), `creating ${title}`).json.id);
  const digestOf = async (projectId: string): Promise<string> =>
    ok(await api('GET', `/projects/${projectId}/acceptance/confirmation`, login), 'reading the standard set').json.currentVersion.digest;
  const projectRow = (projectId: string) => db.project.findUniqueOrThrow({ where: { id: projectId } });

  const anyProject = await project('knocked on');
  const toConfirm = await project('to confirm');
  const toStart = await project('to start');
  const toPause = await project('to pause and resume');
  const toFinish = await project('to record done');
  const startBody = async (projectId: string) => ({
    criteriaDigest: await digestOf(projectId),
    line: 'MAIN',
    automatic: false,
    maxConcurrentTasks: 2,
    mergeCheckCommand: null,
  });
  for (const started of [toPause, toFinish]) {
    ok(await api('POST', `/projects/${started}/start`, login, await startBody(started)), 'starting a project');
  }
  const spaceId = toUuid(ok(await api('POST', '/wiki/spaces', login, { title: `space ${RUN}` }), 'creating a wiki space').json.id);
  const sessionId = toUuid(
    ok(await api('POST', '/sessions', login, { prompt: 'knocked on', workspaceId }), 'creating a session').json.id,
  );

  // Real SECRET cards on this runner: submit, cancel an undelivered grant, and revoke a delivered one.
  await db.session.update({ where: { id: sessionId }, data: { assignedRunnerId: runnerId } });
  const secretRequest = async () => (await db.ownerRequest.create({
    data: {
      ownerId: userId, askedBySessionId: sessionId, kind: 'SECRET', title: 'API key', why: 'the session needs a key',
      secretSpec: { name: 'API key', runnerId, envVar: 'OWNER_CHANNEL_KEY' },
    },
  })).id;
  const secretToSubmit = await secretRequest();
  const secretToCancel = await secretRequest();
  const secretToRevoke = await secretRequest();
  for (const requestId of [secretToCancel, secretToRevoke]) {
    ok(await api('POST', `/owner-requests/${requestId}/secret`, login, { value: 'fixture-key' }), 'preparing a secret grant');
  }
  await db.ownerRequestSecret.update({ where: { requestId: secretToRevoke }, data: { state: 'ACTIVE', deliveredAt: new Date() } });
  const grantRow = (requestId: string) => db.ownerRequestSecret.findUnique({ where: { requestId } });
  const savedSecret = await db.accountSecret.create({ data: { ownerId: userId, label: 'door fixture', valueEnc: 'to be replaced' } });
  const savedRow = () => db.accountSecret.findUnique({ where: { id: savedSecret.id } });

  // A Feishu app of the account's (switched off, so nothing connects it) with a group waiting on a live ticket, and two
  // groups connected: the three group doors (docs/feishu-bot-design.md §8.1) stood up for real.
  const feishuAppId = `cli_owner_channel_${RUN}`;
  await db.feishuApp.create({
    data: { ownerId: userId, platform: 'FEISHU', appId: feishuAppId, appSecretEnc: 'owner:channel:not-a-secret', enabled: false, ownerOpenId: 'ou_owner' },
  });
  const chatTicket = `owner-channel-ticket-${RUN}`;
  const pendingChat = await db.feishuChatRoute.create({
    data: {
      ownerId: userId, appId: feishuAppId, chatId: `oc_pending_${RUN}`,
      ticketHash: hashChatTicket(chatTicket), ticketOpenId: 'ou_owner', ticketEventId: `ev-${RUN}`, ticketExpiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });
  const connectedChat = async (chat: string) => (await db.feishuChatRoute.create({
    data: { ownerId: userId, appId: feishuAppId, chatId: `oc_${chat}_${RUN}`, workspaceId, permissionMode: 'default', enabled: true, confirmedAt: new Date() },
  })).id;
  const chatToChange = await connectedChat('to-change');
  const chatToRemove = await connectedChat('to-remove');
  const chatRow = (id: string) => db.feishuChatRoute.findUnique({ where: { id } });

  // ── (1) the owner channel, door by door ────────────────────────────────────────────────────

  const doors: Door[] = [
    {
      route: 'POST /owner-requests/:id/secret', path: `/owner-requests/${secretToSubmit}/secret`,
      body: { value: 'submitted-key', saveAs: 'submitted key' }, login: 200,
      observe: async () => ({ grant: await grantRow(secretToSubmit), saved: await db.accountSecret.findUnique({ where: { ownerId_label: { ownerId: userId, label: 'submitted key' } } }) }),
    },
    {
      route: 'POST /owner-requests/:id/secret/cancel', path: `/owner-requests/${secretToCancel}/secret/cancel`,
      login: 200, observe: () => grantRow(secretToCancel),
    },
    {
      route: 'POST /owner-requests/:id/secret/revoke', path: `/owner-requests/${secretToRevoke}/secret/revoke`,
      login: 200, observe: () => grantRow(secretToRevoke),
    },
    { route: 'GET /account-secrets', path: '/account-secrets', login: 200 },
    {
      route: 'PUT /account-secrets/:id', path: `/account-secrets/${savedSecret.id}`,
      body: { value: 'replacement-key' }, login: 204, observe: savedRow,
    },
    {
      route: 'DELETE /account-secrets/:id', path: `/account-secrets/${savedSecret.id}`,
      login: 204, observe: savedRow,
    },
    { route: 'POST /tasks/:taskId/owner-confirmation', path: `/tasks/${nobody()}/owner-confirmation`, body: { decision: 'CONFIRM' }, login: 404 },
    {
      route: 'POST /tasks/:taskId/evidence/decision',
      path: `/tasks/${nobody()}/evidence/decision`,
      body: { decision: 'CONFIRM', evidenceRevision: '1', decidingSessionId: nobody() },
      login: 404,
    },
    {
      route: 'POST /sessions/:id/approvals/:approvalId/decision',
      path: `/sessions/${sessionId}/approvals/${nobody()}/decision`,
      body: { behavior: 'allow' },
      login: 404,
    },
    {
      route: 'POST /projects/:id/acceptance/confirmation',
      path: `/projects/${toConfirm}/acceptance/confirmation`,
      body: { criteriaDigest: await digestOf(toConfirm) },
      login: 201,
      observe: () => db.projectStandardSetConfirmation.count({ where: { projectId: toConfirm } }),
    },
    {
      route: 'POST /projects/:id/acceptance/criteria-decisions/:intentId',
      path: `/projects/${anyProject}/acceptance/criteria-decisions/${nobody()}`,
      body: { commitToken: randomUUID(), decision: 'APPROVE', baseSeal: '0'.repeat(64) },
      login: 404,
    },
    ...(['confirm', 'decline', 'cancel'] as const).map((press) => ({
      route: `POST /projects/:projectId/promotions/:promotionId/${press}`,
      path: `/projects/${anyProject}/promotions/${nobody()}/${press}`,
      body: {},
      login: 404,
    })),
    {
      route: 'POST /projects/:id/handoffs/:handoffId/decision',
      path: `/projects/${anyProject}/handoffs/${nobody()}/decision`,
      body: { decision: 'APPROVE' },
      login: 404,
    },
    {
      route: 'POST /projects/:id/start',
      path: `/projects/${toStart}/start`,
      body: await startBody(toStart),
      login: 201,
      observe: async () => (await projectRow(toStart)).startedAt,
    },
    {
      route: 'POST /projects/:id/done',
      path: `/projects/${toFinish}/done`,
      body: { criteriaDigest: await digestOf(toFinish), acceptedGaps: [] },
      login: 201,
      observe: async () => (await projectRow(toFinish)).status,
    },
    {
      route: 'POST /projects/:id/pause',
      path: `/projects/${toPause}/pause`,
      login: 201,
      observe: async () => (await projectRow(toPause)).pausedAt,
    },
    {
      route: 'POST /projects/:id/resume',
      path: `/projects/${toPause}/resume`,
      login: 201,
      observe: async () => (await projectRow(toPause)).pausedAt,
    },
    // The project is OPEN, so a login is answered by the door's own refusal: PROJECT_STILL_OPEN.
    {
      route: 'POST /projects/:id/sessions/complete',
      path: `/projects/${anyProject}/sessions/complete`,
      login: 409,
    },
    {
      route: 'POST /projects/:id/done-requests/:itemId/decline',
      path: `/projects/${anyProject}/done-requests/${nobody()}/decline`,
      body: { note: 'not yet' },
      login: 409,
    },
    // The owner's DONE readiness read (a324f2397): what Record as done would be weighed against.
    { route: 'GET /projects/:id/done-check', path: `/projects/${anyProject}/done-check`, login: 200 },
    {
      route: 'GET /projects/:id/acceptance/criteria-decisions/pending',
      path: `/projects/${anyProject}/acceptance/criteria-decisions/pending`,
      login: 200,
    },
    { route: 'POST /projects/:id/fuse/:episodeId/resume', path: `/projects/${anyProject}/fuse/${nobody()}/resume`, body: {}, login: 404 },
    {
      route: 'POST /projects/:id/open-items/:itemId/answer',
      path: `/projects/${anyProject}/open-items/${nobody()}/answer`,
      body: { text: 'yes' },
      login: 404,
    },
    {
      route: 'POST /projects/:id/open-items/:itemId/return-to-coordinator',
      path: `/projects/${anyProject}/open-items/${nobody()}/return-to-coordinator`,
      login: 404,
    },
    {
      route: 'POST /projects/:id/open-items/:itemId/resolve',
      path: `/projects/${anyProject}/open-items/${nobody()}/resolve`,
      body: { note: 'handled' },
      login: 404,
    },
    {
      route: 'POST /projects/:id/open-items/:itemId/accept',
      path: `/projects/${anyProject}/open-items/${nobody()}/accept`,
      login: 404,
    },
    {
      route: 'PATCH /projects/:id/integration',
      path: `/projects/${anyProject}/integration`,
      body: { exceptionEscalationSeconds: 900 },
      login: 200,
      observe: async () => (await projectRow(anyProject)).exceptionEscalationSeconds,
    },
    // The two doors that take work off the line without retrying it (§2.2 J-T8, J-T10). The ids
    // name nothing, so a login is answered not-found — the point held here is that the token is
    // refused before either door is reached.
    {
      route: 'POST /projects/:id/integration/jobs/:jobId/abandon',
      path: `/projects/${anyProject}/integration/jobs/${nobody()}/abandon`,
      login: 404,
    },
    {
      route: 'POST /projects/:id/tasks/:taskId/integration/stop',
      path: `/projects/${anyProject}/tasks/${nobody()}/integration/stop`,
      login: 404,
    },
    // §10.8's "look again": the project has no repository bound, so a login is answered that there is
    // no line to look at — the door itself, reached.
    {
      route: 'POST /projects/:id/integration/observe',
      path: `/projects/${anyProject}/integration/observe`,
      body: { reason: 'the census' },
      login: 409,
    },
    { route: 'POST /wiki/entries/:id/reject', path: `/wiki/entries/${nobody()}/reject`, body: { reason: 'not_true' }, login: 404 },
    { route: 'POST /wiki/entries/:id/confirm', path: `/wiki/entries/${nobody()}/confirm`, login: 404 },
    {
      route: 'POST /wiki/changesets/:id/decide',
      path: `/wiki/changesets/${nobody()}/decide`,
      body: { decisions: [{ opId: nobody(), action: 'accept' }] },
      login: 404,
    },
    { route: 'POST /wiki/changesets/:id/revert', path: `/wiki/changesets/${nobody()}/revert`, login: 404 },
    { route: 'POST /wiki/spaces/:id/verifications/reopen', path: `/wiki/spaces/${spaceId}/verifications/reopen`, login: 200 },
    {
      route: 'POST /wiki/spaces/:id/workspaces',
      path: `/wiki/spaces/${spaceId}/workspaces`,
      body: { workspaceId },
      login: 200,
      observe: () => db.wikiSpaceWorkspace.count({ where: { workspaceId, spaceId, leftOutAt: null } }),
    },
    {
      route: 'DELETE /wiki/spaces/:id/workspaces/:workspaceId',
      path: `/wiki/spaces/${spaceId}/workspaces/${workspaceId}`,
      login: 200,
      observe: () => db.wikiSpaceWorkspace.count({ where: { workspaceId, spaceId, leftOutAt: null } }),
    },
    // The maintenance settings' probe and run now of a space nobody has: the plain 404, nothing asked, nothing made.
    { route: 'POST /wiki/spaces/:id/maintenance/probe', path: `/wiki/spaces/${nobody()}/maintenance/probe`, body: { workspaceId }, login: 404 },
    { route: 'POST /wiki/spaces/:id/maintenance/run', path: `/wiki/spaces/${nobody()}/maintenance/run`, body: {}, login: 404 },
    // A space nobody has: a login that got past the door would move the wiki the cases around it read to Trash.
    { route: 'DELETE /wiki/spaces/:id', path: `/wiki/spaces/${nobody()}`, login: 404 },
    // The Trash (contract `space.trash`): a restore of the wiki in use answers it as it is; a permanent delete of a wiki
    // nobody has is the 404; the Trash's list is the owner's too.
    { route: 'POST /wiki/spaces/:id/restore', path: `/wiki/spaces/${spaceId}/restore`, login: 200 },
    { route: 'DELETE /wiki/spaces/:id/purge', path: `/wiki/spaces/${nobody()}/purge`, login: 404 },
    { route: 'GET /wiki/trash', path: '/wiki/trash', login: 200 },
    { route: 'GET /wiki/changesets/:id', path: `/wiki/changesets/${nobody()}`, login: 404 },
    { route: 'GET /wiki/spaces/:id/plan', path: `/wiki/spaces/${spaceId}/plan`, login: 200 },
    { route: 'GET /wiki/spaces/:id/plan/versions', path: `/wiki/spaces/${spaceId}/plan/versions`, login: 200 },
    { route: 'GET /wiki/spaces/:id/plan/versions/:version', path: `/wiki/spaces/${spaceId}/plan/versions/1`, login: 404 },
    { route: 'POST /wiki/spaces/:id/plan/edits', path: `/wiki/spaces/${spaceId}/plan/edits`, body: {}, login: 422 },
    { route: 'POST /wiki/spaces/:id/plan/versions/:version/confirm', path: `/wiki/spaces/${spaceId}/plan/versions/1/confirm`, body: {}, login: 404 },
    { route: 'POST /wiki/spaces/:id/plan/redraft', path: `/wiki/spaces/${spaceId}/plan/redraft`, body: {}, login: 200 },
    // The space has no version 1 (its read above is a 404): the door answers a login 404, no such version of the plan.
    { route: 'POST /wiki/spaces/:id/plan/versions/:version/build', path: `/wiki/spaces/${spaceId}/plan/versions/1/build`, body: {}, login: 404 },
    { route: 'POST /wiki/plan-proposals/:id/decide', path: `/wiki/plan-proposals/${nobody()}/decide`, body: { action: 'reject' }, login: 404 },
    // A version that names nothing: the login is answered the door's 404 for another owner's version, or none.
    { route: 'POST /wiki/doc-versions/:id/restore', path: `/wiki/doc-versions/${nobody()}/restore`, login: 404 },
    // A chat that says nothing is not made: the door answers a login 400, content is the owner's first message.
    { route: 'POST /wiki/spaces/:id/chats', path: `/wiki/spaces/${spaceId}/chats`, body: {}, login: 400 },
    // A card that names nothing: the login is answered the door's 404 for another owner's card, or none — an Edit with no
    // ops is refused for its shape first, before any card is read.
    { route: 'POST /wiki/chat-drafts/:id/apply', path: `/wiki/chat-drafts/${nobody()}/apply`, login: 404 },
    { route: 'POST /wiki/chat-drafts/:id/edit', path: `/wiki/chat-drafts/${nobody()}/edit`, body: {}, login: 400 },
    { route: 'POST /wiki/chat-drafts/:id/discard', path: `/wiki/chat-drafts/${nobody()}/discard`, login: 404 },
    { route: 'POST /wiki/chat-drafts/:id/undo', path: `/wiki/chat-drafts/${nobody()}/undo`, login: 404 },
    { route: 'POST /wiki/chat-drafts/:id/retry', path: `/wiki/chat-drafts/${nobody()}/retry`, login: 404 },
    { route: 'POST /wiki/chat-drafts/:id/seen', path: `/wiki/chat-drafts/${nobody()}/seen`, login: 404 },
    // Connecting a Feishu group with a live ticket, changing a connected one, removing one.
    {
      route: 'POST /integrations/feishu/chats/confirm',
      path: '/integrations/feishu/chats/confirm',
      body: { ticket: chatTicket, workspaceId, permissionMode: 'acceptEdits', allowedOpenIds: ['ou_member'], maxConcurrentSessions: 3, sessionsPerDay: 7 },
      login: 201,
      observe: async () => (await chatRow(pendingChat.id))?.confirmedAt ?? null,
    },
    {
      route: 'PATCH /integrations/feishu/chats/:id',
      path: `/integrations/feishu/chats/${chatToChange}`,
      body: { maxConcurrentSessions: 5 },
      login: 200,
      observe: async () => (await chatRow(chatToChange))?.maxConcurrentSessions,
    },
    {
      route: 'DELETE /integrations/feishu/chats/:id',
      path: `/integrations/feishu/chats/${chatToRemove}`,
      login: 200,
      observe: async () => (await chatRow(chatToRemove)) !== null,
    },
  ];

  await t.test('every door in OWNER_INTERACTIVE_ROUTES has a case below, on a path that door answers, and nothing else has one', () => {
    assert.deepEqual(doors.map((door) => door.route).sort(), [...OWNER_INTERACTIVE_ROUTES].sort());
    assert.deepEqual(doors.filter((door) => !answers(door.route, door.path)).map((door) => `${door.route}: ${door.path}`), []);
  });

  for (const door of doors) {
    await t.test(`${door.route}: a token is refused OWNER_INTERACTIVE_CREDENTIAL_REQUIRED, a login is answered by the door`, async () => {
      const method = methodOf(door.route);
      const before = await door.observe?.();
      const byToken = await api(method, door.path, token, door.body);
      assert.equal(byToken.status, 403, `a token answered ${byToken.status}: ${byToken.text}`);
      assert.deepEqual(byToken.json, REFUSED('OWNER_INTERACTIVE'));
      if (door.observe) assert.deepEqual(await door.observe(), before, 'the token wrote nothing');

      const byLogin = await api(method, door.path, login, door.body);
      assert.equal(byLogin.status, door.login, `a login answered ${byLogin.status}: ${byLogin.text}`);
      assert.notEqual(byLogin.json?.code, 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
      if (door.observe) assert.notDeepEqual(await door.observe(), before, "the login did the door's work");
    });
  }

  // ── (2) auth/*, admin/*, runner credentials, share links ────────────────────────────────────

  const runnerRow = () => db.runner.findUniqueOrThrow({ where: { id: runnerId }, select: { tokenHash: true } });
  const families: Array<Door & { reason: PatForbiddenReason }> = [
    {
      reason: 'AUTH',
      route: 'POST /auth/change-password',
      path: '/auth/change-password',
      body: { currentPassword: 'the-first-password', newPassword: 'the-second-password' },
      login: 201,
      observe: async () => (await db.user.findUniqueOrThrow({ where: { id: userId } })).passwordHash,
    },
    { reason: 'ADMIN', route: 'GET /admin/users', path: '/admin/users', login: 200 },
    { reason: 'ADMIN', route: 'GET /admin/providers', path: '/admin/providers', login: 200 },
    {
      reason: 'RUNNER_CREDENTIALS',
      route: 'POST /runners/:id/rotate-token',
      path: `/runners/${runnerId}/rotate-token`,
      login: 201,
      observe: async () => (await runnerRow()).tokenHash,
    },
    { reason: 'RUNNER_CREDENTIALS', route: 'POST /runners/device/:userCode/approve', path: '/runners/device/ABCD-EFGH/approve', login: 404 },
    { reason: 'RUNNER_CREDENTIALS', route: 'POST /runners/device/:userCode/deny', path: '/runners/device/ABCD-EFGH/deny', login: 404 },
    {
      reason: 'RUNNER_CREDENTIALS',
      route: 'POST /runners/enrollment-tokens',
      path: '/runners/enrollment-tokens',
      body: {},
      login: 201,
      observe: () => db.enrollmentToken.count({ where: { ownerId: userId } }),
    },
    { reason: 'RUNNER_CREDENTIALS', route: 'GET /runners/enrollment-tokens', path: '/runners/enrollment-tokens', login: 200 },
    {
      reason: 'SHARE_LINK',
      route: 'PUT /projects/:id/share',
      path: `/projects/${anyProject}/share`,
      body: {},
      login: 200,
      observe: () => db.shareLink.count({ where: { projectId: anyProject } }),
    },
    { reason: 'SHARE_LINK', route: 'GET /share-links', path: '/share-links', login: 200 },
  ];
  for (const door of families) {
    await t.test(`${door.route}: a token is refused PAT_FORBIDDEN ${door.reason}, a login reaches the door`, async () => {
      assert.ok(answers(door.route, door.path), door.path);
      const method = methodOf(door.route);
      const before = await door.observe?.();
      const byToken = await api(method, door.path, token, door.body);
      assert.equal(byToken.status, 403, `a token answered ${byToken.status}: ${byToken.text}`);
      assert.deepEqual(byToken.json, REFUSED(door.reason));
      if (door.observe) assert.deepEqual(await door.observe(), before, 'the token wrote nothing');

      const byLogin = await api(method, door.path, login, door.body);
      assert.equal(byLogin.status, door.login, `a login answered ${byLogin.status}: ${byLogin.text}`);
      assert.notEqual(byLogin.json?.code, 'PAT_FORBIDDEN');
      if (door.observe) assert.notDeepEqual(await door.observe(), before, "the login did the door's work");
    });
  }

  // ── (3) field by field, on routes a token reaches with its scope ────────────────────────────

  /** The 403 a token meets for sending `fields`, and nothing it carried written. */
  const refusedFields = (reply: Reply, fields: string[]) => {
    assert.equal(reply.status, 403, reply.text);
    const { message, ...rest } = reply.json;
    assert.deepEqual(rest, {
      code: 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED',
      reason: 'OWNER_INTERACTIVE',
      requiredAction: 'OPEN_ORBIT',
      fields,
    });
    for (const field of fields) assert.ok(message.includes(field), message);
  };

  await t.test("PATCH /projects/:id: a token's status (DONE, CANCELLED, OPEN), integration and acceptance criteria are refused whole; its other fields are written; a login writes all three", async () => {
    const id = await project('fields');
    const read = async () => {
      const row = await projectRow(id);
      const criteria = await db.projectAcceptanceCriterionDefinition.count({ where: { projectId: id } });
      return {
        title: row.title,
        goal: row.goal,
        status: row.status,
        exceptionEscalationSeconds: row.exceptionEscalationSeconds,
        criteria,
      };
    };
    const original = await read();
    const items = (await api('GET', `/projects/${id}`, login)).json.acceptanceCriteriaItems
      .map((item: { id: string; text: string; verificationMethod: string }) => ({ id: item.id, text: item.text, verificationMethod: item.verificationMethod }));
    const tightened = [...items, { text: 'a second criterion', verificationMethod: 'a spec' }];
    const owners: Array<[Record<string, unknown>, string[]]> = [
      [{ status: 'DONE' }, ['status']],
      [{ status: 'CANCELLED' }, ['status']],
      [{ status: 'OPEN' }, ['status']],
      [{ integration: { exceptionEscalationSeconds: 1200 } }, ['integration']],
      [{ acceptanceCriteriaItems: tightened }, ['acceptanceCriteriaItems']],
      [
        { status: 'CANCELLED', integration: { exceptionEscalationSeconds: 1200 }, acceptanceCriteriaItems: tightened },
        ['status', 'integration', 'acceptanceCriteriaItems'],
      ],
    ];
    for (const [fields, named] of owners) {
      refusedFields(await api('PATCH', `/projects/${id}`, token, { title: 'renamed by a token', goal: 'a goal', ...fields }), named);
      assert.deepEqual(await read(), original, `${named.join(', ')}: nothing the request carried was written`);
    }

    ok(await api('PATCH', `/projects/${id}`, token, { title: 'renamed by a token', goal: 'a goal', instructions: 'by the book' }), 'the ordinary fields');
    const written = await projectRow(id);
    assert.deepEqual([written.title, written.goal, written.instructions], ['renamed by a token', 'a goal', 'by the book']);

    ok(await api('PATCH', `/projects/${id}`, login, { status: 'CANCELLED' }), 'a login writing status');
    assert.equal((await projectRow(id)).status, 'CANCELLED');
    ok(await api('PATCH', `/projects/${id}`, login, { status: 'OPEN' }), 'a login writing status back');
    assert.equal((await projectRow(id)).status, 'OPEN');
    ok(await api('PATCH', `/projects/${id}`, login, { integration: { exceptionEscalationSeconds: 1200 } }), 'a login writing integration');
    assert.equal((await projectRow(id)).exceptionEscalationSeconds, 1200);
    ok(await api('PATCH', `/projects/${id}`, login, { acceptanceCriteriaItems: tightened }), 'a login adding a criterion');
    assert.equal((await read()).criteria, original.criteria + 1);
  });

  await t.test("POST /projects: a token's integration choice is refused whole and makes no project; without it the token creates one; a login chooses one", async () => {
    const titled = (title: string) => db.project.count({ where: { ownerId: userId, title } });
    refusedFields(
      await api('POST', '/projects', token, { title: `integration by a token ${RUN}`, integration: { exceptionEscalationSeconds: 1200 } }),
      ['integration'],
    );
    assert.equal(await titled(`integration by a token ${RUN}`), 0);
    refusedFields(
      await api('POST', '/projects', token, { title: `integration by a token ${RUN}`, workspaceId, integration: { exceptionEscalationSeconds: 1200 } }),
      ['integration'],
    );
    assert.equal(await titled(`integration by a token ${RUN}`), 0);

    ok(await api('POST', '/projects', token, { title: `made by a token ${RUN}` }), 'a token creating a project');
    assert.equal(await titled(`made by a token ${RUN}`), 1);
    const chosen = ok(
      await api('POST', '/projects', login, { title: `integration by a login ${RUN}`, integration: { exceptionEscalationSeconds: 1200 } }),
      'a login choosing the integration',
    );
    assert.equal((await projectRow(toUuid(chosen.json.id))).exceptionEscalationSeconds, 1200);
  });

  /** How far a project's coordinator may act, and who it is: what a token is refused on both project doors. */
  const authorizationOf = async (projectId: string) => {
    const row = await projectRow(projectId);
    const coordinators = await db.projectMember.findMany({ where: { projectId, role: 'COORDINATOR' }, select: { agentId: true } });
    return {
      coordinatorEnabled: row.coordinatorEnabled,
      maxConcurrentTasks: row.maxConcurrentTasks,
      sessionBudgetPerDay: row.sessionBudgetPerDay,
      configRevision: row.configRevision,
      coordinators: coordinators.map((member) => member.agentId),
    };
  };

  await t.test("PATCH /projects/:id: a token's authorization set and coordinator are refused whole, to any value; its other fields are written; a login writes them", async () => {
    const id = await project('authorization');
    const read = async () => {
      const { title, goal } = await projectRow(id);
      return { title, goal, ...(await authorizationOf(id)) };
    };
    const original = await read();
    const owners: Array<[Record<string, unknown>, string[]]> = [
      [{ automatic: true }, ['automatic']],
      [{ automatic: false }, ['automatic']],
      [{ coordinatorEnabled: true }, ['coordinatorEnabled']],
      [{ maxConcurrentTasks: 7 }, ['maxConcurrentTasks']],
      [{ sessionBudgetPerDay: 5 }, ['sessionBudgetPerDay']],
      [{ sessionBudgetPerDay: null }, ['sessionBudgetPerDay']],
      [{ coordinatorAgentId: workspaceId }, ['coordinatorAgentId']],
      [{ coordinatorAgentId: null }, ['coordinatorAgentId']],
      [
        { automatic: true, maxConcurrentTasks: 7, sessionBudgetPerDay: 5, coordinatorAgentId: workspaceId },
        ['automatic', 'maxConcurrentTasks', 'sessionBudgetPerDay', 'coordinatorAgentId'],
      ],
      [{ status: 'CANCELLED', coordinatorEnabled: true }, ['status', 'coordinatorEnabled']],
    ];
    for (const [fields, named] of owners) {
      refusedFields(await api('PATCH', `/projects/${id}`, token, { title: 'renamed by a token', goal: 'a goal', ...fields }), named);
      assert.deepEqual(await read(), original, `${JSON.stringify(fields)}: nothing the request carried was written`);
    }

    ok(await api('PATCH', `/projects/${id}`, token, { title: 'renamed by a token', goal: 'a goal' }), 'the ordinary fields');
    assert.deepEqual(await read(), { ...original, title: 'renamed by a token', goal: 'a goal' });

    ok(
      await api('PATCH', `/projects/${id}`, login, { automatic: true, maxConcurrentTasks: 7, sessionBudgetPerDay: 5, coordinatorAgentId: workspaceId }),
      'a login writing the authorization set and the coordinator',
    );
    assert.deepEqual(await authorizationOf(id), {
      coordinatorEnabled: true,
      maxConcurrentTasks: 7,
      sessionBudgetPerDay: 5,
      configRevision: original.configRevision + 1n,
      coordinators: [workspaceId],
    });
    ok(await api('PATCH', `/projects/${id}`, login, { coordinatorEnabled: false, sessionBudgetPerDay: null }), 'a login turning Automatic off and clearing the budget');
    const after = await authorizationOf(id);
    assert.deepEqual([after.coordinatorEnabled, after.sessionBudgetPerDay], [false, null]);
  });

  await t.test("POST /projects: a token's authorization set and coordinator are refused whole and make no project; without them its project takes the defaults; a login sets them", async () => {
    const titled = (title: string) => db.project.count({ where: { ownerId: userId, title } });
    const owners: Array<[Record<string, unknown>, string[]]> = [
      [{ coordinatorEnabled: true }, ['coordinatorEnabled']],
      [{ automatic: true }, ['automatic']],
      [{ maxConcurrentTasks: 7 }, ['maxConcurrentTasks']],
      [{ sessionBudgetPerDay: 5 }, ['sessionBudgetPerDay']],
      [{ coordinatorAgentId: workspaceId }, ['coordinatorAgentId']],
      [{ workspaceId, coordinatorEnabled: false, maxConcurrentTasks: 7 }, ['coordinatorEnabled', 'maxConcurrentTasks']],
      [{ integration: { exceptionEscalationSeconds: 1200 }, sessionBudgetPerDay: 5 }, ['integration', 'sessionBudgetPerDay']],
    ];
    for (const [fields, named] of owners) {
      const title = `${named.join(' and ')} by a token ${RUN}`;
      refusedFields(await api('POST', '/projects', token, { title, ...fields }), named);
      assert.equal(await titled(title), 0, `${JSON.stringify(fields)}: no project was made`);
    }

    const byLogin = ok(await api('POST', '/projects', login, { title: `defaults by a login ${RUN}` }), 'a login creating a project without them');
    const byToken = ok(await api('POST', '/projects', token, { title: `defaults by a token ${RUN}` }), 'a token creating a project without them');
    assert.deepEqual(await authorizationOf(toUuid(byToken.json.id)), await authorizationOf(toUuid(byLogin.json.id)));
    const governed = ok(
      await api('POST', '/projects', login, { title: `governed by a login ${RUN}`, coordinatorEnabled: true, maxConcurrentTasks: 7, sessionBudgetPerDay: 5 }),
      'a login setting them',
    );
    const set = await authorizationOf(toUuid(governed.json.id));
    assert.deepEqual([set.coordinatorEnabled, set.maxConcurrentTasks, set.sessionBudgetPerDay], [true, 7, 5]);
  });

  /** A space's settings, as the owner reads them. */
  const settingsOf = async (id: string) => ok(await api('GET', `/wiki/spaces/${id}`, login), 'reading a space').json;

  await t.test("POST /wiki/spaces: a token's maintenance is refused whole and makes no space; without it the token creates one; a login sets it", async () => {
    const titled = (title: string) => db.wikiSpace.count({ where: { ownerId: userId, title } });
    refusedFields(await api('POST', '/wiki/spaces', token, { title: `maintained by a token ${RUN}`, maintenance: { dailyRunLimit: 2 } }), ['maintenance']);
    assert.equal(await titled(`maintained by a token ${RUN}`), 0);
    ok(await api('POST', '/wiki/spaces', token, { title: `made by a token ${RUN}` }), 'a token creating a space');
    assert.equal(await titled(`made by a token ${RUN}`), 1);
    const set = ok(await api('POST', '/wiki/spaces', login, { title: `maintained by a login ${RUN}`, maintenance: { dailyRunLimit: 2 } }), 'a login setting maintenance');
    assert.equal((await settingsOf(set.json.id)).settings.maintenance?.dailyRunLimit, 2, JSON.stringify(set.json));
  });

  await t.test("PATCH /wiki/spaces/:id: a token's review mode, maintenance and spot checks are refused whole; its other settings are written; a login writes all three", async () => {
    const id = toUuid(ok(await api('POST', '/wiki/spaces', login, { title: `settings ${RUN}` }), 'creating a space').json.id);
    const original = await settingsOf(id);
    const mode = original.settings.reviewMode === 'automatic' ? 'review' : 'automatic';
    const owners: Array<[Record<string, unknown>, string[]]> = [
      [{ reviewMode: mode }, ['reviewMode']],
      [{ maintenance: { dailyRunLimit: 2 } }, ['maintenance']],
      [{ automaticSpotChecks: !original.settings.automaticSpotChecks }, ['automaticSpotChecks']],
      [{ reviewMode: mode, maintenance: { dailyRunLimit: 2 }, automaticSpotChecks: false }, ['reviewMode', 'maintenance', 'automaticSpotChecks']],
    ];
    for (const [fields, named] of owners) {
      refusedFields(await api('PATCH', `/wiki/spaces/${id}`, token, { title: 'renamed by a token', push: !original.settings.push, ...fields }), named);
      assert.deepEqual(await settingsOf(id), original, `${named.join(', ')}: nothing the request carried was written`);
    }

    const ordinary = { title: 'renamed by a token', push: !original.settings.push, autoAcceptReinforce: !original.settings.autoAcceptReinforce };
    ok(await api('PATCH', `/wiki/spaces/${id}`, token, ordinary), 'the ordinary settings');
    const written = await settingsOf(id);
    assert.deepEqual([written.title, written.settings.push, written.settings.autoAcceptReinforce], [ordinary.title, ordinary.push, ordinary.autoAcceptReinforce]);

    ok(await api('PATCH', `/wiki/spaces/${id}`, login, { reviewMode: mode, automaticSpotChecks: !original.settings.automaticSpotChecks, maintenance: { dailyRunLimit: 2 } }), 'a login writing all three');
    const byLogin = (await settingsOf(id)).settings;
    assert.deepEqual(
      [byLogin.reviewMode, byLogin.automaticSpotChecks, byLogin.maintenance?.dailyRunLimit],
      [mode, !original.settings.automaticSpotChecks, 2],
    );
  });

  const sessionRow = () => db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { permissionMode: true, effort: true, status: true } });

  await t.test("PATCH /sessions/:id/config: a token's permission mode is refused whole, to any value; its other settings are written; a login changes the mode", async () => {
    const original = await sessionRow();
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']) {
      refusedFields(await api('PATCH', `/sessions/${sessionId}/config`, token, { effort: 'high', permissionMode: mode }), ['permissionMode']);
      assert.deepEqual(await sessionRow(), original, `${mode}: nothing the request carried was written`);
    }
    ok(await api('PATCH', `/sessions/${sessionId}/config`, token, { effort: 'high' }), 'a token setting the effort');
    assert.equal((await sessionRow()).effort, 'high');
    ok(await api('PATCH', `/sessions/${sessionId}/config`, login, { permissionMode: 'plan' }), 'a login changing the mode');
    assert.equal((await sessionRow()).permissionMode, 'plan');
  });

  await t.test("POST /sessions/:id/resume: a token's permission mode is refused whole and no turn is written; without it the token's message is taken; a login revives with a new mode", async () => {
    const turns = (clientTurnId: string) => db.conversationTurn.count({ where: { sessionId, clientTurnId } });
    // A session that has run and waits for its next message, as a runner leaves one.
    await sql.query(`UPDATE "session" SET "status" = 'AWAITING_INPUT' WHERE "id" = $1`, [sessionId]);
    const before = await sessionRow();
    const refusedTurn = randomUUID();
    refusedFields(
      await api('POST', `/sessions/${sessionId}/resume`, token, { clientTurnId: refusedTurn, content: 'from a token', permissionMode: 'bypassPermissions' }),
      ['permissionMode'],
    );
    assert.equal(await turns(refusedTurn), 0);
    assert.deepEqual(await sessionRow(), before);

    const takenTurn = randomUUID();
    ok(await api('POST', `/sessions/${sessionId}/resume`, token, { clientTurnId: takenTurn, content: 'from a token' }), 'a token sending a message');
    assert.equal(await turns(takenTurn), 1);

    // Ended after having run, so a resume revives it — the door where a mode is re-applied.
    await sql.query(
      `UPDATE "session" SET "status" = 'SUCCEEDED', "started_at" = now(), "runtime_session_id" = $2 WHERE "id" = $1`,
      [sessionId, `runtime-${RUN}`],
    );
    await db.runner.update({ where: { id: runnerId }, data: { status: 'ONLINE', lastHeartbeatAt: new Date() } });
    refusedFields(
      await api('POST', `/sessions/${sessionId}/resume`, token, { clientTurnId: randomUUID(), content: 'from a token', permissionMode: 'bypassPermissions' }),
      ['permissionMode'],
    );
    assert.deepEqual((await sessionRow()).status, 'SUCCEEDED', 'the token revived nothing');
    ok(await api('POST', `/sessions/${sessionId}/resume`, login, { clientTurnId: randomUUID(), content: 'from a login', permissionMode: 'acceptEdits' }), 'a login reviving it');
    assert.equal((await sessionRow()).permissionMode, 'acceptEdits');
  });

  await t.test("POST /sessions: a token's permission mode is refused whole, to any value, and opens no session; without it the token's session opens in the account's default mode; a login opens one in the mode it names", async () => {
    const titled = (title: string) => db.session.count({ where: { ownerId: userId, title } });
    const modeOf = async (reply: Reply) =>
      (await db.session.findUniqueOrThrow({ where: { id: toUuid(reply.json.id) }, select: { permissionMode: true } })).permissionMode;
    // The default is the owner's, set signed in; a token cannot move it (users/* is closed to tokens).
    ok(await api('PATCH', '/users/me/preferences', login, { defaultPermissionMode: 'plan' }), 'the owner choosing a default mode');
    const moved = await api('PATCH', '/users/me/preferences', token, { defaultPermissionMode: 'bypassPermissions' });
    assert.equal(moved.status, 403, moved.text);
    assert.deepEqual(moved.json, REFUSED('ACCOUNT'));

    for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']) {
      const title = `${mode} by a token ${RUN}`;
      refusedFields(await api('POST', '/sessions', token, { title, prompt: 'from a token', workspaceId, permissionMode: mode }), ['permissionMode']);
      assert.equal(await titled(title), 0, `${mode}: no session was opened`);
    }

    const byToken = ok(
      await api('POST', '/sessions', token, { title: `default mode by a token ${RUN}`, prompt: 'from a token', workspaceId }),
      'a token opening a session without a mode',
    );
    assert.equal(await modeOf(byToken), 'plan');
    const byLogin = ok(
      await api('POST', '/sessions', login, { title: `chosen mode by a login ${RUN}`, prompt: 'from a login', workspaceId, permissionMode: 'bypassPermissions' }),
      'a login choosing the mode',
    );
    assert.equal(await modeOf(byLogin), 'bypassPermissions');
  });
});

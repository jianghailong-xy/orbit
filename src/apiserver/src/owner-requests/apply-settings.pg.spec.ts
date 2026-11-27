/**
 * THE OWNER SAVES A SETTINGS CARD: PREFERENCES AND THEIR PROVENANCE (docs/settings-from-conversation-design.md §5.2, §5.3).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/owner-requests/apply-settings.pg.spec.ts
 *
 * THE CASES, each card filed through the runner door `POST /runner/settings-proposals` and answered through the owner's
 * door `POST /owner-requests/:id/apply-settings` (a personal access token on it: auth/pat-owner-channel.pg.spec.ts)
 * =========
 *   (1) Save changes merges each `to` into the account's preferences, leaves every other key as it was, marks each key
 *       `changedBy[key] = { sessionId, requestId, at, from }`, settles the card DONE with one delivery to the asking
 *       session, and a second press is refused with nothing written;
 *   (2) a card whose `from` no longer holds (the owner changed the setting since) is refused 409 SETTINGS_STALE: the
 *       preferences are as the owner left them, the card is still PENDING with no delivery, and the owner can decline it;
 *   (3) a request carrying an acting session is refused 403 SETTINGS_OWNER_CHANNEL_ONLY before anything is written;
 *   (4) PATCH /users/me/preferences ends the mark of each key it writes, and only those;
 *   (5) GET /users/me answers `changedBy` with the asking conversation's title;
 *   (6) the door answers only SETTINGS_CHANGE cards, and only the caller's own (404 for another account's).
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own account.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { Prisma, PrismaClient, RunnerStatus, SessionDispatchOrigin, type Runner } from '@prisma/client';
import { PermissionMode, RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import type { AuthUser } from '../common/current-user.decorator';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RunnerOwnerRequestsController } from '../runner-api/runner-owner-requests.controller';
import { UpdatePreferencesDto } from '../users/dto';
import { DEFAULT_PERMISSION_MODE_CHANGED_ACTIVITY } from '../users/preferences-merge';
import { UsersController } from '../users/users.controller';
import type { ProposeSettingsDto } from './dto';
import { OwnerRequestsController } from './owner-requests.controller';
import { OwnerRequestsService } from './owner-requests.service';
import { OwnerSecretsService } from './owner-secrets.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Account {
  ownerId: string;
  runner: Runner;
  sessionId: string;
}

const PREFERENCES = { theme: 'dark', subagentBlockedProviders: ['codex'], recaps: false };
const SESSION_TITLE = 'Reading replies in Chinese';

test('apply-settings: the owner saves a settings card, and each key it writes is marked', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const prisma = db as unknown as PrismaService;
  const push = { notifyOwnerRequest: async () => undefined } as unknown as PushService;
  const secrets = new OwnerSecretsService(prisma);
  const service = new OwnerRequestsService(prisma, secrets, push);
  const runnerDoor = new RunnerOwnerRequestsController(prisma, service);
  const ownerDoor = new OwnerRequestsController(service, secrets);
  const users = new UsersController(prisma);

  const authOf = (acc: Account) => ({ userId: acc.ownerId }) as unknown as AuthUser;
  const propose = async (acc: Account, changes: Record<string, unknown>) =>
    (await runnerDoor.proposeSettings(acc.runner, acc.sessionId, { changes, why: 'The person asked for it.' } as ProposeSettingsDto)).id;
  const apply = (acc: Account, id: string, headers: Record<string, string> = {}) =>
    ownerDoor.applySettings(authOf(acc), id, { headers }, 'web/1.0');
  const patch = (acc: Account, body: Record<string, unknown>) =>
    users.updatePreferences(authOf(acc), plainToInstance(UpdatePreferencesDto, body));
  const response = (error: unknown) => (error as HttpException).getResponse() as Record<string, unknown>;
  const preferences = async (acc: Account) =>
    (await db.user.findUniqueOrThrow({ where: { id: acc.ownerId }, select: { preferences: true } })).preferences as Record<string, unknown>;
  const card = (id: string) => db.ownerRequest.findUniqueOrThrow({
    where: { id },
    select: { state: true, resolvedByUserId: true, resolvedClient: true, resolvedAt: true },
  });
  const deliveries = (id: string) => db.watchDelivery.findMany({ where: { ownerRequestId: id }, select: { kind: true, action: true } });

  await t.test('(1) Save changes writes each to, marks it changedBy, and settles the card DONE with a delivery', async () => {
    const acc = await account(db, 'apply');
    const id = await propose(acc, { theme: 'light', defaultEffort: 'high', subagentBlockedProviders: ['codex', 'kimi'] });
    assert.deepEqual(await preferences(acc), PREFERENCES, 'filing wrote nothing');

    const before = Date.now();
    const answered = await apply(acc, id);
    assert.equal(answered.state, 'DONE');
    assert.equal(answered.id, id);

    const written = await preferences(acc);
    const { changedBy, ...values } = written as { changedBy: Record<string, { sessionId: string; requestId: string; at: string; from: unknown }> };
    assert.deepEqual(values, {
      theme: 'light',
      defaultEffort: 'high',
      subagentBlockedProviders: ['codex', 'kimi'],
      recaps: false,
    }, 'each to is merged, and a key the card does not name keeps its value');
    assert.deepEqual(Object.keys(changedBy).sort(), ['defaultEffort', 'subagentBlockedProviders', 'theme']);
    const froms: Record<string, unknown> = { theme: 'dark', defaultEffort: '', subagentBlockedProviders: ['codex'] };
    for (const [key, mark] of Object.entries(changedBy)) {
      assert.equal(mark.sessionId, acc.sessionId, `${key}: the asking session`);
      assert.equal(mark.requestId, id, `${key}: the card`);
      assert.deepEqual(mark.from, froms[key], `${key}: the value it replaced`);
      const at = Date.parse(mark.at);
      assert.ok(at >= before - 1_000 && at <= Date.now() + 1_000, `${key}: when (${mark.at})`);
    }

    const row = await card(id);
    assert.equal(row.state, 'DONE');
    assert.equal(row.resolvedByUserId, acc.ownerId);
    assert.equal(row.resolvedClient, 'web');
    assert.equal(changedBy.theme.at, row.resolvedAt!.toISOString(), 'marked at the moment the card settled');
    assert.deepEqual(await deliveries(id), [{ kind: 'OWNER_REQUEST', action: 'RESUME_SESSION' }], 'its ending reaches the asking session once');

    const again = await apply(acc, id).catch((e: unknown) => e);
    assert.ok(again instanceof ConflictException, 'a second press is refused');
    assert.equal(response(again).code, 'OWNER_REQUEST_NOT_PENDING');
    assert.deepEqual(await preferences(acc), written, 'and writes nothing');
    assert.equal((await deliveries(id)).length, 1);
  });

  await t.test('(2) a from that no longer holds is refused 409 SETTINGS_STALE, writes nothing, and leaves the card PENDING', async () => {
    const acc = await account(db, 'stale');
    const id = await propose(acc, { theme: 'light', recaps: true });
    // The owner changes one of the card's settings in the app before answering it.
    await patch(acc, { theme: 'system' });
    const left = await preferences(acc);
    assert.deepEqual(left, { ...PREFERENCES, theme: 'system' });

    const stale = await apply(acc, id).catch((e: unknown) => e);
    assert.ok(stale instanceof ConflictException, `refused 409, got ${String(stale)}`);
    assert.equal(stale.getStatus(), 409);
    assert.equal(response(stale).code, 'SETTINGS_STALE');
    assert.deepEqual(response(stale).settings, ['theme'], 'names the setting that changed');
    assert.deepEqual(await preferences(acc), left, 'nothing written: not the stale key, and not recaps beside it');
    assert.equal((await card(id)).state, 'PENDING', 'the card is still the owner’s to decline');
    assert.deepEqual(await deliveries(id), [], 'no ending was delivered');

    const declined = await ownerDoor.decline(authOf(acc), id, { reason: 'Already changed it.' } as never, 'web/1.0');
    assert.equal(declined.state, 'DECLINED');
    assert.deepEqual(await preferences(acc), left);
  });

  await t.test('(3) a request carrying an acting session is refused SETTINGS_OWNER_CHANNEL_ONLY, and nothing is written', async () => {
    const acc = await account(db, 'acting-session');
    const id = await propose(acc, { theme: 'light' });
    for (const header of ['x-orbit-session-id', 'X-Orbit-Session-Token']) {
      const refused = await apply(acc, id, { [header]: acc.sessionId }).catch((e: unknown) => e);
      assert.ok(refused instanceof ForbiddenException, `${header}: refused 403, got ${String(refused)}`);
      assert.equal(response(refused).code, 'SETTINGS_OWNER_CHANNEL_ONLY');
    }
    assert.deepEqual(await preferences(acc), PREFERENCES);
    assert.equal((await card(id)).state, 'PENDING');
    assert.deepEqual(await deliveries(id), []);
    // The owner's own login, with no acting session, still saves it.
    assert.equal((await apply(acc, id)).state, 'DONE');
  });

  await t.test('(4) PATCH /users/me/preferences ends the mark of each key it writes, and only those', async () => {
    const acc = await account(db, 'patch-clears');
    await apply(acc, await propose(acc, { theme: 'light', recaps: true, defaultEffort: 'high' }));
    const marked = (await preferences(acc)).changedBy as Record<string, unknown>;
    assert.deepEqual(Object.keys(marked).sort(), ['defaultEffort', 'recaps', 'theme']);

    // Undo is a plain PATCH with the card's from.
    const answered = await patch(acc, { theme: 'dark' });
    const after = await preferences(acc);
    assert.equal(after.theme, 'dark');
    assert.deepEqual(after.changedBy, { recaps: marked.recaps, defaultEffort: marked.defaultEffort }, 'only theme’s mark ended');
    assert.deepEqual(Object.keys(answered.changedBy).sort(), ['defaultEffort', 'recaps'], 'the PATCH answers as me does');

    await patch(acc, { recaps: false, defaultEffort: 'low', promptSuggestions: false });
    const cleared = await preferences(acc);
    assert.equal('changedBy' in cleared, false, 'no mark left, no changedBy');
    assert.deepEqual(cleared, { theme: 'dark', subagentBlockedProviders: ['codex'], recaps: false, defaultEffort: 'low', promptSuggestions: false });
  });

  await t.test('(5) GET /users/me answers changedBy with the conversation’s title', async () => {
    const acc = await account(db, 'me');
    const id = await propose(acc, { theme: 'light' });
    const none = await users.me(authOf(acc));
    assert.deepEqual(none!.changedBy, {}, 'nothing marked before the owner saves');

    await apply(acc, id);
    const me = await users.me(authOf(acc));
    const mark = (await preferences(acc)).changedBy as Record<string, Record<string, unknown>>;
    const theme = me!.changedBy.theme;
    assert.equal(theme.from, 'dark');
    assert.equal(theme.requestId, id);
    assert.deepEqual(me!.changedBy, { theme: { ...mark.theme, sessionTitle: SESSION_TITLE } });

    // A conversation since deleted is named by no title.
    await db.session.update({ where: { id: acc.sessionId }, data: { deletedAt: new Date() } });
    assert.equal((await users.me(authOf(acc)))!.changedBy.theme.sessionTitle, null);
  });

  await t.test('a default-mode change records the approving owner, app, previous value and time', async () => {
    const acc = await account(db, 'mode-audit');
    const before = Date.now();
    const id = await propose(acc, { defaultPermissionMode: 'default' });
    await apply(acc, id);
    await users.updatePreferences(authOf(acc), { defaultPermissionMode: PermissionMode.PLAN }, 'ios/1.0', 'iphone');
    await users.updatePreferences(authOf(acc), { defaultPermissionMode: PermissionMode.PLAN }, 'macos/1.0');
    await patch(acc, { theme: 'light' });
    assert.equal((await preferences(acc)).defaultPermissionMode, 'plan');
    const audit = await db.activity.findMany({
      where: { actorId: acc.ownerId, type: DEFAULT_PERMISSION_MODE_CHANGED_ACTIVITY },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    assert.deepEqual(audit.map(({ actorId, payload }) => ({ actorId, payload })), [
      { actorId: acc.ownerId, payload: { from: null, to: 'default', client: 'web', clientDetail: null } },
      { actorId: acc.ownerId, payload: { from: 'default', to: 'plan', client: 'ios', clientDetail: 'iphone' } },
    ]);
    for (const event of audit) {
      assert.ok(event.createdAt.getTime() >= before && event.createdAt.getTime() <= Date.now());
    }
  });

  await t.test('(6) only a SETTINGS_CHANGE card of the caller’s own is applied', async () => {
    const acc = await account(db, 'kinds');
    const other = await account(db, 'kinds-other');
    const question = await db.ownerRequest.create({
      data: { ownerId: acc.ownerId, askedBySessionId: acc.sessionId, kind: 'DECISION', title: 'Which one?', why: 'to choose' },
    });
    assert.ok(await apply(acc, question.id).catch((e: unknown) => e) instanceof BadRequestException);
    assert.equal((await card(question.id)).state, 'PENDING');

    const theirs = await propose(other, { theme: 'light' });
    assert.ok(await apply(acc, theirs).catch((e: unknown) => e) instanceof NotFoundException, 'another account’s card is not found');
    assert.equal((await card(theirs)).state, 'PENDING');
    assert.deepEqual(await preferences(other), PREFERENCES);
    assert.deepEqual(await preferences(acc), PREFERENCES);
  });
});

async function account(db: PrismaClient, label: string): Promise<Account> {
  const ownerId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `apply-settings-${ownerId}@apply-settings.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
      preferences: PREFERENCES as Prisma.InputJsonValue,
    },
  });
  const runner = await db.runner.create({
    data: {
      id: randomUUID(),
      ownerId,
      name: `apply-settings-runner-${label}`,
      tokenHash: `hash-${randomUUID()}`,
      status: RunnerStatus.ONLINE,
      lastHeartbeatAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId: runner.id, name: `apply-settings-${label}`, enabled: true } });
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runner.id,
      title: SESSION_TITLE,
      prompt: SESSION_TITLE,
      provider: 'claude',
      turnState: 'IN_FLIGHT',
      dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(),
    },
  });
  return { ownerId, runner, sessionId };
}

/**
 * SETTINGS PROPOSALS: A SESSION FILES A CARD, AND NO PREFERENCE IS WRITTEN (docs/settings-from-conversation-design.md §5.1).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/owner-requests/settings-proposals.pg.spec.ts
 *
 * THE CASES, each through the runner door `POST /runner/settings-proposals`
 * =========
 *   (1) one proposal per tier — personal, defaults for new work, and the narrowing direction of agent reach — files a
 *       PENDING SETTINGS_CHANGE with the server's title and `{ changes: [{ key, from, to, tier }] }`, the owner is told,
 *       and the account's preferences are unchanged;
 *   (2) a proposal with any key that widens agent reach (each tier-3 key, and one mixed with a personal key) is refused
 *       403 SETTING_OWNER_ONLY with the §6 body, and nothing is filed or written;
 *   (3) a proposal whose every change is already in force is refused 409 SETTINGS_ALREADY_SET and files nothing;
 *   (4) after the owner declines a card, the same changes from that session are refused 409 SETTINGS_CHANGE_DECLINED with
 *       the date and reason, while a different change, or the same one from another session, is filed;
 *   (5) a second filing withdraws the session's first card, which queues no turn, so one card per session waits; two
 *       filings at once leave one card PENDING;
 *   (6) the plain done door does not settle a SETTINGS_CHANGE;
 *   (t) a runner naming another account's session in the header is refused 403, and nothing is filed on either account.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own account.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { BadRequestException, ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { Prisma, PrismaClient, RunnerStatus, SessionDispatchOrigin, type Runner } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RunnerOwnerRequestsController } from '../runner-api/runner-owner-requests.controller';
import { OwnerRequestsService } from './owner-requests.service';
import { OwnerSecretsService } from './owner-secrets.service';
import type { ProposeSettingsDto } from './dto';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Account {
  ownerId: string;
  runner: Runner;
  sessionId: string;
  otherSessionId: string;
}

const PREFERENCES = { theme: 'dark', subagentBlockedProviders: ['codex'], enableOrchestration: false, defaultPermissionMode: 'plan' };

test('settings proposals: a session files a card, and no preference is written', {
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
  const told: string[] = [];
  const push = { notifyOwnerRequest: async (id: string) => { told.push(id); } } as unknown as PushService;
  const service = new OwnerRequestsService(prisma, new OwnerSecretsService(prisma), push);
  const door = new RunnerOwnerRequestsController(prisma, service);

  const propose = (acc: Account, changes: Record<string, unknown>, session = acc.sessionId) =>
    door.proposeSettings(acc.runner, session, { changes, why: 'The person asked for it.' } as ProposeSettingsDto);
  const response = (error: unknown) => (error as HttpException).getResponse() as Record<string, unknown>;
  const cards = (acc: Account) => db.ownerRequest.findMany({
    where: { ownerId: acc.ownerId, kind: 'SETTINGS_CHANGE' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, state: true, title: true, why: true, payload: true, askedBySessionId: true, resolutionNote: true },
  });
  const preferences = async (acc: Account) =>
    (await db.user.findUniqueOrThrow({ where: { id: acc.ownerId }, select: { preferences: true } })).preferences;
  const deliveries = (ids: string[]) => db.watchDelivery.count({ where: { ownerRequestId: { in: ids } } });

  await t.test('(1) each tier files a PENDING card with from and to, and preferences stay as they were', async () => {
    const acc = await account(db, 'tiers');
    const proposals: Array<[Record<string, unknown>, unknown[], string]> = [
      [{ theme: 'light', translationEnabled: true }, [
        { key: 'theme', from: 'dark', to: 'light', tier: 1 },
        { key: 'translationEnabled', from: false, to: true, tier: 1 },
      ], 'Change 2 settings?'],
      [{ defaultEffort: 'high' }, [{ key: 'defaultEffort', from: '', to: 'high', tier: 2 }], 'Change 1 setting?'],
      [{ subagentBlockedProviders: ['codex', 'kimi'], defaultPermissionMode: 'default' }, [
        { key: 'subagentBlockedProviders', from: ['codex'], to: ['codex', 'kimi'], tier: 3 },
        { key: 'defaultPermissionMode', from: 'plan', to: 'default', tier: 3 },
      ], 'Change 2 settings?'],
    ];
    for (const [changes, expected, title] of proposals) {
      // One session each, so no filing withdraws another's card.
      const session = await sessionOf(db, acc, `tier ${title}`);
      told.length = 0;
      const filed = await propose(acc, changes, session);
      assert.equal(filed.kind, 'SETTINGS_CHANGE');
      assert.equal(filed.state, 'PENDING');
      assert.equal(filed.title, title);
      assert.equal(filed.why, 'The person asked for it.');
      assert.equal(filed.askedBySessionId, session);
      assert.deepEqual(filed.payload, { changes: expected });
      assert.deepEqual(filed.withdrawnRequestIds, []);
      assert.deepEqual(told, [filed.id], 'the owner is told once');
      assert.deepEqual((await service.get(acc.ownerId, filed.id)).payload, { changes: expected }, 'reads back by id');
    }
    // Turning orchestration off narrows too.
    const off = await propose({ ...acc }, { enableOrchestration: false }, await sessionOf(db, acc, 'orchestration'))
      .catch((e: unknown) => e);
    assert.ok(off instanceof ConflictException, 'already off on this account');
    const on = await account(db, 'orchestration-on', {});
    const narrowed = await propose(on, { enableOrchestration: false });
    assert.deepEqual(narrowed.payload, { changes: [{ key: 'enableOrchestration', from: true, to: false, tier: 3 }] });

    assert.deepEqual(await preferences(acc), PREFERENCES, 'no preference was written');
    assert.deepEqual(await preferences(on), {}, 'no preference was written');
    assert.equal((await cards(acc)).filter((c) => c.state === 'PENDING').length, 3);
  });

  await t.test('(2) any widening key refuses the whole proposal 403 SETTING_OWNER_ONLY, and nothing is filed', async () => {
    const acc = await account(db, 'owner-only');
    const refusals: Array<[Record<string, unknown>, string[]]> = [
      [{ enableOrchestration: true }, ['enableOrchestration']],
      [{ subagentBlockedProviders: [] }, ['subagentBlockedProviders']],
      [{ subagentBlockedProviders: ['kimi'] }, ['subagentBlockedProviders']],
      [{ defaultPermissionMode: 'bypassPermissions' }, ['defaultPermissionMode']],
      [{ defaultPermissionMode: 'acceptEdits' }, ['defaultPermissionMode']],
      [{ theme: 'light', recaps: false, enableOrchestration: true, defaultPermissionMode: 'default' }, ['enableOrchestration']],
    ];
    told.length = 0;
    for (const [changes, keys] of refusals) {
      const error = await propose(acc, changes).catch((e: unknown) => e);
      assert.ok(error instanceof ForbiddenException, JSON.stringify(changes));
      const body = response(error);
      assert.equal(body.code, 'SETTING_OWNER_ONLY');
      assert.deepEqual((body.settings as Array<{ key: string }>).map((s) => s.key), keys);
    }
    const body = response(await propose(acc, { enableOrchestration: true }).catch((e: unknown) => e));
    assert.deepEqual(body, {
      code: 'SETTING_OWNER_ONLY',
      message: '"Let sessions orchestrate" gives agents more reach; only you can turn it on, in Settings.',
      settings: [{ key: 'enableOrchestration', title: 'Let sessions orchestrate', path: '/settings/general', link: 'orbit-settings:enableOrchestration' }],
    });
    assert.deepEqual(await cards(acc), [], 'nothing filed');
    assert.deepEqual(told, [], 'nobody told');
    assert.deepEqual(await preferences(acc), PREFERENCES, 'nothing written');
  });

  await t.test('(3) a proposal of what is already in force is refused 409 SETTINGS_ALREADY_SET', async () => {
    const acc = await account(db, 'already-set');
    for (const changes of [{ theme: 'dark' }, { recaps: true, enableOrchestration: false }, { subagentBlockedProviders: ['codex', 'codex'] }]) {
      const error = await propose(acc, changes).catch((e: unknown) => e);
      assert.ok(error instanceof ConflictException, JSON.stringify(changes));
      assert.equal(response(error).code, 'SETTINGS_ALREADY_SET');
    }
    // A key that is not a setting is refused before anything is read.
    const unknown = await propose(acc, { name: 'Mallory' }).catch((e: unknown) => e);
    assert.ok(unknown instanceof BadRequestException);
    assert.deepEqual(await cards(acc), []);
  });

  await t.test('(4) after a decline, the same changes from that session are refused 409 SETTINGS_CHANGE_DECLINED', async () => {
    const acc = await account(db, 'declined');
    const filed = await propose(acc, { translationEnabled: true, translationLanguage: 'ja' });
    await service.decline(acc.ownerId, filed.id, 'Not on this account.', 'web', true);
    const error = await propose(acc, { translationLanguage: 'ja', translationEnabled: true }).catch((e: unknown) => e);
    assert.ok(error instanceof ConflictException);
    const body = response(error);
    assert.equal(body.code, 'SETTINGS_CHANGE_DECLINED');
    assert.equal(body.requestId, filed.id);
    assert.equal(body.reason, 'Not on this account.');
    const declinedAt = (await db.ownerRequest.findUniqueOrThrow({ where: { id: filed.id } })).resolvedAt!;
    assert.equal(body.declinedAt, declinedAt.toISOString());
    assert.match(String(body.message), new RegExp(`declined this change on ${declinedAt.toISOString().slice(0, 10)}.*Not on this account\\.`));
    assert.equal((await cards(acc)).length, 1, 'nothing more filed');

    const different = await propose(acc, { translationEnabled: true });
    assert.equal(different.state, 'PENDING', 'a different change is filed');
    const elsewhere = await propose(acc, { translationEnabled: true, translationLanguage: 'ja' }, acc.otherSessionId);
    assert.equal(elsewhere.state, 'PENDING', 'another session is not refused by this one’s card');
  });

  await t.test('(5) a second filing withdraws the first; two at once leave one card waiting', async () => {
    const acc = await account(db, 'replace');
    const first = await propose(acc, { theme: 'light' });
    const second = await propose(acc, { theme: 'system', recaps: false });
    assert.deepEqual(second.withdrawnRequestIds, [first.id]);
    const rows = await cards(acc);
    assert.deepEqual(rows.map((r) => [r.id, r.state]), [[first.id, 'WITHDRAWN'], [second.id, 'PENDING']]);
    assert.equal(rows[0]!.resolutionNote, 'Replaced by a newer settings proposal from the same session.');
    assert.equal(await deliveries([first.id]), 0, 'the session is not woken for the card it replaced');
    // Another session's card is its own.
    const other = await propose(acc, { theme: 'light' }, acc.otherSessionId);
    assert.deepEqual(other.withdrawnRequestIds, []);
    assert.equal((await service.get(acc.ownerId, second.id)).state, 'PENDING');

    const racing = await Promise.allSettled([
      propose(acc, { notifyAgentMessage: false }),
      propose(acc, { notifySessionFinished: false }),
      propose(acc, { promptSuggestions: false }),
    ]);
    assert.deepEqual(racing.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled']);
    const pending = (await cards(acc)).filter((r) => r.state === 'PENDING' && r.askedBySessionId === acc.sessionId);
    assert.equal(pending.length, 1, 'one card per session waits');
    assert.deepEqual(await preferences(acc), PREFERENCES);
  });

  await t.test('(6) the plain done door does not settle a SETTINGS_CHANGE', async () => {
    const acc = await account(db, 'done-door');
    const filed = await propose(acc, { theme: 'light' });
    await assert.rejects(service.complete(acc.ownerId, filed.id, { text: 'ok' }), BadRequestException);
    assert.equal((await service.get(acc.ownerId, filed.id)).state, 'PENDING');
    assert.deepEqual(await preferences(acc), PREFERENCES);
  });

  await t.test('(t) another account’s session in the header is refused 403, and nothing is filed on either', async () => {
    const a = await account(db, 'tenant-a');
    const b = await account(db, 'tenant-b');
    const error = await propose(b, { theme: 'light' }, a.sessionId).catch((e: unknown) => e);
    assert.ok(error instanceof ForbiddenException);
    assert.match((error as Error).message, /names no session this runner hosts/);
    // A's runner naming B's session is refused the same way.
    assert.ok(await propose(a, { theme: 'light' }, b.sessionId).catch((e: unknown) => e) instanceof ForbiddenException);
    assert.deepEqual(await cards(a), []);
    assert.deepEqual(await cards(b), []);
    assert.deepEqual(await preferences(a), PREFERENCES);
    assert.deepEqual(await preferences(b), PREFERENCES);
  });
});

async function sessionOf(db: PrismaClient, acc: Pick<Account, 'ownerId' | 'runner'>, title: string): Promise<string> {
  const workspace = await db.workspace.findFirstOrThrow({ where: { ownerId: acc.ownerId }, select: { id: true } });
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: acc.ownerId,
      creatorId: acc.ownerId,
      workspaceId: workspace.id,
      assignedRunnerId: acc.runner.id,
      title,
      prompt: title,
      provider: 'claude',
      turnState: 'IN_FLIGHT',
      dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(),
    },
  });
  return id;
}

async function account(db: PrismaClient, label: string, preferences: Record<string, unknown> = PREFERENCES): Promise<Account> {
  const ownerId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `settings-proposals-${ownerId}@settings-proposals.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
      preferences: preferences as Prisma.InputJsonValue,
    },
  });
  const runner = await db.runner.create({
    data: {
      id: randomUUID(),
      ownerId,
      name: `settings-proposals-runner-${label}`,
      tokenHash: `hash-${randomUUID()}`,
      status: RunnerStatus.ONLINE,
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: randomUUID(), ownerId, runnerId: runner.id, name: `settings-proposals-${label}`, enabled: true } });
  const sessionId = await sessionOf(db, { ownerId, runner }, `proposer ${label}`);
  const otherSessionId = await sessionOf(db, { ownerId, runner }, `another ${label}`);
  return { ownerId, runner, sessionId, otherSessionId };
}

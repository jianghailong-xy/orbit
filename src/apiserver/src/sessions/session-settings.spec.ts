import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';
import { parseSessionSettingsPatch, sessionSettingsOf } from './session-settings';

// PATCH /sessions/:id/settings and the `settings` object GET /sessions/:id carries
// (docs/mocks/session-settings). The service runs against an in-memory session table: what is
// asserted is what the endpoint writes and answers, owner-only, on every session not in Trash.

const OWNER = '00000000-0000-4000-8000-000000000001';
const STRANGER = '00000000-0000-4000-8000-000000000002';
const SESSION = '00000000-0000-4000-8000-0000000000aa';
const WORKSPACE_ENV = { NODE_OPTIONS: '--max-old-space-size=6144', GOCACHE: '/mnt/data/gocache' };

type Row = Record<string, unknown> & { id: string; ownerId: string };

function sessionRow(over: Partial<Row> = {}): Row {
  return {
    id: SESSION,
    ownerId: OWNER,
    status: RunStatus.AWAITING_INPUT,
    cancelRequestedAt: null,
    deletedAt: null,
    sessionKind: 'CONVERSATION',
    engineStartedAt: new Date('2026-11-11T10:00:00Z'),
    env: null,
    envChangedAt: null,
    envAppliedAt: null,
    notifyTurnFinished: null,
    notifyNeedsYou: null,
    notificationsMuted: false,
    workspaceId: 'ws-1',
    ...over,
  };
}

function harness(row: Row) {
  const state = { row: { ...row }, updates: [] as Array<Record<string, unknown>>, published: [] as string[] };
  const session = {
    findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
      where.id === state.row.id && where.ownerId === state.row.ownerId
        ? { ...state.row, workspace: { env: WORKSPACE_ENV } }
        : null,
    update: async ({ data }: { data: Record<string, unknown> }) => {
      state.updates.push(data);
      const next = { ...state.row };
      for (const [k, v] of Object.entries(data)) next[k] = v === Prisma.DbNull ? null : v;
      state.row = next as Row;
      return { ...state.row };
    },
  };
  const tx = {
    session,
    // The FOR UPDATE lock: answers a row only for the owner, as the WHERE does.
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) =>
      values[0] === state.row.id && values[1] === state.row.ownerId ? [{ id: state.row.id }] : [],
  };
  const prisma = { session, $transaction: async (work: (t: typeof tx) => unknown) => work(tx) };
  const realtime = { publishSessionUpdated: (id: string) => state.published.push(id) };
  const service = new SessionsService(prisma as never, {} as never, realtime as never);
  return { service, state };
}

test('set: env replaces the session map, stamps envChangedAt, and answers the settings', async () => {
  const { service, state } = harness(sessionRow());
  const before = Date.now();
  const settings = await service.updateSettings(OWNER, SESSION, {
    env: { DEBUG: 'orbit:*', LOG_LEVEL: 'trace' },
    notifyTurnFinished: 'off',
    notifyNeedsYou: 'on',
    muted: true,
  });
  assert.deepEqual(settings, {
    env: { DEBUG: 'orbit:*', LOG_LEVEL: 'trace' },
    workspaceEnv: WORKSPACE_ENV,
    notifyTurnFinished: 'off',
    notifyNeedsYou: 'on',
    muted: true,
    // The engine is live and started before this change.
    envPendingRestart: true,
  });
  assert.deepEqual(state.row.env, { DEBUG: 'orbit:*', LOG_LEVEL: 'trace' });
  assert.ok((state.row.envChangedAt as Date).getTime() >= before);
  assert.equal(state.row.notifyTurnFinished, 'off');
  assert.equal(state.row.notifyNeedsYou, 'on');
  assert.equal(state.row.notificationsMuted, true);
  assert.deepEqual(state.published, [SESSION]);
});

test('clear: env null empties the map; inherit stores null; a resent identical env is no change', async () => {
  const changedAt = new Date('2026-11-11T09:00:00Z');
  const { service, state } = harness(sessionRow({
    env: { DEBUG: 'x' }, envChangedAt: changedAt, notifyTurnFinished: 'off', notificationsMuted: true,
  }));
  // Same map, other key order: not a change, so no restart becomes owed.
  await service.updateSettings(OWNER, SESSION, { env: { DEBUG: 'x' } });
  assert.equal(state.row.envChangedAt, changedAt);

  const settings = await service.updateSettings(OWNER, SESSION, { env: null, notifyTurnFinished: 'inherit', muted: false });
  assert.equal(state.row.env, null);
  assert.notEqual(state.row.envChangedAt, changedAt);
  assert.equal(state.row.notifyTurnFinished, null);
  assert.deepEqual(
    { env: settings.env, notifyTurnFinished: settings.notifyTurnFinished, muted: settings.muted },
    { env: {}, notifyTurnFinished: 'inherit', muted: false },
  );
});

test('invalid key, ORBIT_ key, non-string value, oversize and unknown notify values are refused', () => {
  const refused = (body: unknown, pattern: RegExp) =>
    assert.throws(() => parseSessionSettingsPatch(body), (e: unknown) =>
      e instanceof BadRequestException && pattern.test((e as Error).message));
  refused({ env: { '1BAD': 'x' } }, /not valid/);
  refused({ env: { 'HAS-DASH': 'x' } }, /not valid/);
  refused({ env: { ORBIT_TASK_ID: 'x' } }, /reserved/);
  refused({ env: { orbit_token: 'x' } }, /reserved/);
  refused({ env: { A: 1 } }, /must be a string/);
  refused({ env: ['A'] }, /object/);
  refused({ env: { A: 'x'.repeat(32 * 1024 + 1) } }, /32 KB/);
  refused({ env: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`K${i}`, 'v'])) }, /more than 100/);
  refused({ notifyTurnFinished: 'sometimes' }, /inherit, on, off/);
  refused({ muted: 'yes' }, /true or false/);
  refused({}, /nothing to update/);
  // The limits themselves are allowed.
  parseSessionSettingsPatch({ env: { A: 'x'.repeat(32 * 1024) } });
  parseSessionSettingsPatch({ env: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`K${i}`, 'v'])) });
});

test('an invalid body writes nothing', async () => {
  const { service, state } = harness(sessionRow());
  await assert.rejects(() => service.updateSettings(OWNER, SESSION, { env: { ORBIT_X: '1' } }), BadRequestException);
  assert.deepEqual(state.updates, []);
});

test('a non-owner is refused and writes nothing', async () => {
  const { service, state } = harness(sessionRow());
  await assert.rejects(() => service.updateSettings(STRANGER, SESSION, { muted: true }), NotFoundException);
  assert.deepEqual(state.updates, []);
  assert.equal(state.row.notificationsMuted, false);
});

test('a Completed session and an ended one are accepted; a trashed one is refused', async () => {
  const completed = harness(sessionRow({ status: RunStatus.SUCCEEDED, completedAt: new Date() }));
  const s1 = await completed.service.updateSettings(OWNER, SESSION, { env: { DEBUG: '1' }, muted: true });
  assert.deepEqual(s1.env, { DEBUG: '1' });
  // No engine: nothing to restart, the next start takes it.
  assert.equal(s1.envPendingRestart, false);

  const ended = harness(sessionRow({ status: RunStatus.CANCELLED }));
  assert.equal((await ended.service.updateSettings(OWNER, SESSION, { notifyNeedsYou: 'off' })).notifyNeedsYou, 'off');

  const trashed = harness(sessionRow({ deletedAt: new Date() }));
  await assert.rejects(() => trashed.service.updateSettings(OWNER, SESSION, { muted: true }), ConflictException);
  assert.deepEqual(trashed.state.updates, []);
});

test('envPendingRestart: env changed after the engine (or the last restart) started, while it is live', () => {
  const base = {
    env: { A: '1' },
    envChangedAt: new Date('2026-11-11T10:05:00Z'),
    envAppliedAt: null as Date | null,
    engineStartedAt: new Date('2026-11-11T10:00:00Z') as Date | null,
    notifyTurnFinished: null,
    notifyNeedsYou: null,
    notificationsMuted: false,
  };
  assert.equal(sessionSettingsOf(base, null, true).envPendingRestart, true);
  assert.equal(sessionSettingsOf(base, null, false).envPendingRestart, false);
  assert.equal(sessionSettingsOf({ ...base, envAppliedAt: new Date('2026-11-11T10:06:00Z') }, null, true).envPendingRestart, false);
  assert.equal(sessionSettingsOf({ ...base, engineStartedAt: new Date('2026-11-11T10:10:00Z') }, null, true).envPendingRestart, false);
  assert.equal(sessionSettingsOf({ ...base, envChangedAt: null }, null, true).envPendingRestart, false);
});

test('GET /sessions/:id carries `settings` with the stated shape, and not the raw columns', async () => {
  const row = sessionRow({
    env: { DEBUG: 'orbit:*' },
    envChangedAt: new Date('2026-11-11T10:05:00Z'),
    notifyNeedsYou: 'off',
    notificationsMuted: true,
  });
  // Every read the detail makes beyond the session row answers "nothing": what is asserted is the
  // settings it projects from the row and its workspace.
  const detailRow = {
    ...row,
    provider: 'claude',
    numTurns: 0,
    runtimeSessionId: null,
    taskId: null,
    branch: null,
    runningBgJobs: [],
    runningBgJobActivity: null,
    workspace: { id: 'ws-1', env: WORKSPACE_ENV, defaultMergeTarget: null },
    assignedRunner: null,
    tagLinks: [],
    coordinatorForProject: null,
    task: null,
    shareLinks: [],
    children: [],
  };
  const empty = (): unknown =>
    new Proxy({}, {
      get: (_t, op) => {
        if (op === 'then') return undefined;
        if (op === 'findFirst' || op === 'findUnique') return async () => null;
        if (op === 'findMany' || op === 'groupBy') return async () => [];
        if (op === 'count') return async () => 0;
        return async () => null;
      },
    });
  const prisma = new Proxy({}, {
    get: (_t, model) => {
      if (model === 'then') return undefined;
      if (model === 'session') {
        return {
          findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
            where.id === SESSION && where.ownerId === OWNER ? detailRow : null,
          findMany: async () => [],
          findUnique: async () => null,
          count: async () => 0,
        };
      }
      if (model === '$queryRaw' || model === '$queryRawUnsafe') return async () => [];
      if (model === '$transaction') {
        return async (arg: unknown) => (typeof arg === 'function' ? (arg as (t: unknown) => unknown)(prisma) : []);
      }
      return empty();
    },
  });
  const service = new SessionsService(prisma as never, {} as never, {} as never);
  const detail = await service.get(OWNER, SESSION) as unknown as Record<string, unknown>;
  assert.deepEqual(detail.settings, {
    env: { DEBUG: 'orbit:*' },
    workspaceEnv: WORKSPACE_ENV,
    notifyTurnFinished: 'inherit',
    notifyNeedsYou: 'off',
    muted: true,
    envPendingRestart: true,
  });
  for (const raw of ['env', 'envChangedAt', 'envAppliedAt', 'notifyTurnFinished', 'notifyNeedsYou', 'notificationsMuted']) {
    assert.equal(raw in detail, false, `the detail spreads the raw column ${raw}`);
  }
});

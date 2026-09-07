import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionsService } from './sessions.service';

/**
 * The effort a session starts at when its caller named none.
 *
 * Every surface a person picks effort on writes the choice back as the account default
 * (`UserPreferences.defaultEffort`, PATCHed by the web composer and by `AppModel.rememberDefaultEffort`
 * on iOS/macOS). So a request that carries no effort is not asking for the engine's own default —
 * it is not asking at all, and the answer is what that person last chose.
 *
 * That inheritance used to live in two CALLERS (`session_create` and the service-token bridge),
 * which left every other server-started session at the engine default: on 2026-09-07 the account
 * read `max` while every task run and coordinator opened that day sat at NULL. It is resolved in
 * `create` now, so the rule holds wherever a session is started from.
 *
 * The store answers each read against rows rather than returning a fixed object, because two of
 * these cases are about which of three sources wins.
 */

const OWNER = '00000000-0000-7000-8000-000000000001';
const WORKSPACE = '00000000-0000-7000-8000-0000000000d1';

function makeService(opts: { accountEffort?: string; workspaceEffort?: string | null } = {}) {
  const creates: Array<Record<string, unknown>> = [];
  /** How many times the default was LOOKED UP — the read a caller that named one must not pay. */
  let effortLookups = 0;
  const prisma = {
    workspace: {
      // Two different reads land here: the create path's own (runner, worktree, env) and
      // `resolveDefaultEffort`'s. Answered from the same row, with only the selected column
      // present — a double that returned `effort` to a caller that did not select it would hide a
      // service reading a column it never asked for.
      findFirst: async ({ select }: { select?: Record<string, boolean> }) => {
        if (!select?.effort) {
          return { id: WORKSPACE, runnerId: 'runner-1', enableWorktree: false, permissionMode: null };
        }
        effortLookups += 1;
        return { effort: opts.workspaceEffort ?? null };
      },
    },
    $queryRaw: async () => [
      { workspace_id: WORKSPACE, provider: 'claude', provider_builtin: true },
    ],
    runner: { findFirst: async () => ({ id: 'runner-1' }) },
    user: {
      findUnique: async () => ({
        preferences: opts.accountEffort === undefined ? {} : { defaultEffort: opts.accountEffort },
      }),
    },
    modelProvider: { findFirst: async () => null },
    session: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return { id: 'session-1', ...data, endReason: null, completedAt: null, archivedAt: null, deletedAt: null };
      },
      updateMany: async () => ({ count: 1 }),
    },
  };
  const queue = { notifySessionQueued: () => undefined } as never;
  const realtime = {
    publishSessionCreated: () => undefined,
    publishSessionUpdated: () => undefined,
    publishWorkspaceChanged: () => undefined,
  } as never;
  const service = new SessionsService(prisma as never, queue, realtime);
  return { service, creates, lookups: () => effortLookups };
}

async function created(
  opts: { accountEffort?: string; workspaceEffort?: string | null },
  dto: { effort?: string },
): Promise<Record<string, unknown>> {
  const { service, creates } = makeService(opts);
  await service.create(OWNER, { workspaceId: WORKSPACE, prompt: 'go', ...dto } as never);
  assert.equal(creates.length, 1);
  return creates[0];
}

test('a caller that names no effort inherits the account default', async () => {
  // The case production was failing: a task run and a coordinator name none, and the account said
  // `max` all day while every one of them started at the engine default.
  assert.equal((await created({ accountEffort: 'max' }, {})).effort, 'max');
});

test('an explicit Default is a choice, and outlives a remembered pick', async () => {
  // The empty string is what the composer's *Default* row sends. Treating it as "unasked" would
  // make that row unselectable for anyone who has ever picked an effort.
  assert.equal((await created({ accountEffort: 'max' }, { effort: '' })).effort, '');
});

test('an effort named by the caller wins over both defaults', async () => {
  assert.equal(
    (await created({ accountEffort: 'max', workspaceEffort: 'low' }, { effort: 'high' })).effort,
    'high',
  );
});

test('a workspace that still carries its own effort keeps it', async () => {
  // The per-workspace column predates the account preference. `resolveDefaultEffort` reads it
  // first, and this holds that order rather than restating it.
  assert.equal((await created({ accountEffort: 'max', workspaceEffort: 'low' }, {})).effort, 'low');
});

test('an account that has never picked one leaves the engine to decide', async () => {
  assert.equal((await created({}, {})).effort, undefined);
});

test('a caller that names one does not go looking for a default', async () => {
  // The composers always name one, so this is the common path: it must not grow a read per
  // session. Counted rather than reasoned about — `??` alone would keep the answer right while
  // the lookup happened anyway.
  const named = makeService({ accountEffort: 'max' });
  await named.service.create(OWNER, { workspaceId: WORKSPACE, prompt: 'go', effort: 'high' } as never);
  assert.equal(named.lookups(), 0);

  const unnamed = makeService({ accountEffort: 'max' });
  await unnamed.service.create(OWNER, { workspaceId: WORKSPACE, prompt: 'go' } as never);
  assert.equal(unnamed.lookups(), 1, 'and the one that names none asks exactly once');
});

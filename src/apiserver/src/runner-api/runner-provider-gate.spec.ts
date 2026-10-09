import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, SESSION_SOURCE_PIN_V1 } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';
import {
  ANTIGRAVITY_RUNNER_UPGRADE_ERROR,
  OPENCODE_RUNNER_UPGRADE_ERROR,
} from './runner-provider-support';

const RUNNER = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
};

/** The runner's owner as usableProviderScope reads them: an admin, for whom the configured rows on a runtime
 *  include the shared ones. A member's is shared-provider-admin-only.pg.spec.ts's. */
const admin = { findUnique: async () => ({ role: 'ADMIN' }) };

/**
 * The two halves of a "sessions on this runtime" query (providerDispatchWhereOn, migration 0414): the
 * sessions whose recorded engine it is, and — for a row an older replica wrote, with none — the slugs
 * that ran on it before the split.
 */
function onRuntime(where: Record<string, unknown>): { engine: unknown; provider: unknown } {
  const [recorded, unrecorded] = (where.OR as Array<Record<string, unknown>> | undefined) ?? [];
  const legacy = (unrecorded?.AND as Array<Record<string, unknown>> | undefined)?.[1];
  return { engine: recorded?.engine, provider: legacy?.provider };
}

/** Whether a session query asks for `slug`'s rows: the preflights name every slug on a runtime. */
const asksFor = (where: Record<string, unknown>, slug: string) =>
  (onRuntime(where).provider as { in?: string[] } | undefined)?.in?.includes(slug) ?? false;

test('legacy claim explains the pending OpenCode stall without stranding other work', async () => {
  let claimedFor: { supportedProviders?: readonly AgentProvider[] } | undefined;
  let storedError: string | undefined;
  const published: string[] = [];
  const prisma = {
    session: {
      // Two preflights now share this door — the OpenCode one and the SOURCE one — and they are
      // told apart by what they ask for. Answering both with the same row would make this spec
      // agree with a claim that marked the wrong sessions.
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        asksFor(where, AgentProvider.OPENCODE) ? [{ id: 'session-1', error: null }] : [],
      updateMany: async ({ data }: { data: { error: string } }) => {
        storedError = data.error;
        return { count: 1 };
      },
    },
    user: admin,
    modelProvider: { findMany: async () => [] },
  } as never;
  const queue = {
    claimSessionForRunner: async (runner: { supportedProviders?: readonly AgentProvider[] }) => {
      claimedFor = runner;
      return null;
    },
  } as never;
  const realtime = { publishSessionCreated: (id: string) => published.push(id) } as never;
  const controller = new RunnerApiController(prisma, queue, realtime, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);

  assert.equal(await controller.claim(RUNNER, undefined, 'claude,codex'), null);
  // The OpenCode row is marked so the UI can say why it is stuck...
  assert.equal(storedError, OPENCODE_RUNNER_UPGRADE_ERROR);
  assert.deepEqual(published, ['session-1']);
  // ...but this runner still gets to claim its Claude/Codex work. The queue gate (and
  // migration 0080's trigger) is what keeps the OpenCode row away from it.
  assert.deepEqual(claimedFor?.supportedProviders, [AgentProvider.CLAUDE, AgentProvider.CODEX]);
});

test('an OpenCode-capable runner that does not name Antigravity has its Antigravity rows explained', async () => {
  // Every runner in the field today sends `claude,codex,opencode` and reads `antigravity` as
  // Claude. Its pending Antigravity sessions say why they wait; nothing else about it changes.
  let claimedFor: { supportedProviders?: readonly AgentProvider[] } | undefined;
  const asked: unknown[] = [];
  const marked: Array<{ where: Record<string, unknown>; data: { error: string } }> = [];
  const published: string[] = [];
  const prisma = {
    session: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        asked.push(onRuntime(where).provider);
        return asksFor(where, AgentProvider.ANTIGRAVITY) ? [{ id: 'agy-1', error: null }] : [];
      },
      updateMany: async (args: { where: Record<string, unknown>; data: { error: string } }) => {
        marked.push(args);
        return { count: 1 };
      },
    },
    user: admin,
    modelProvider: { findMany: async () => [] },
  } as never;
  const queue = {
    claimSessionForRunner: async (runner: { supportedProviders?: readonly AgentProvider[] }) => {
      claimedFor = runner;
      return null;
    },
  } as never;
  const realtime = { publishSessionCreated: (id: string) => published.push(id) } as never;
  const controller = new RunnerApiController(prisma, queue, realtime, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);

  assert.equal(
    await controller.claim(RUNNER, SESSION_SOURCE_PIN_V1, 'claude,codex,opencode'),
    null,
  );
  // Only the runtime it did not name is asked about: OpenCode needs no preflight here.
  assert.deepEqual(asked, [{ in: [AgentProvider.ANTIGRAVITY] }, undefined]);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].data.error, ANTIGRAVITY_RUNNER_UPGRADE_ERROR);
  // Conditional on the row still being a pending, uncancelled Antigravity row of this runner, so
  // a claim or cancel racing the preflight cannot be stamped with a stale notice.
  // The sessions recorded on Antigravity, whatever credential they spend, and — for a row without an
  // engine — the slugs that ran on it.
  assert.deepEqual(marked[0].where, {
    id: { in: ['agy-1'] },
    assignedRunnerId: RUNNER.id,
    status: 'PENDING',
    OR: [
      { engine: AgentProvider.ANTIGRAVITY },
      { AND: [{ engine: null }, { provider: { in: [AgentProvider.ANTIGRAVITY] } }] },
    ],
    cancelRequestedAt: null,
  });
  assert.deepEqual(published, ['agy-1']);
  // The queue gate (and migration 0367's trigger) keeps the row away from it; the rest is claimed.
  assert.deepEqual(claimedFor?.supportedProviders, [
    AgentProvider.CLAUDE,
    AgentProvider.CODEX,
    AgentProvider.OPENCODE,
  ]);
});

test('a Gemini key borrows Antigravity, so a runner that does not name it has that row explained too', async () => {
  // The slug is the configured row's own (`gemini`), but the job it dispatches is an `antigravity`
  // one, which this runner would start as Claude. The claim SQL withholds it (and 0372's trigger
  // behind it); the preflight says why, exactly as for the built-in slug.
  const providerLookups: unknown[] = [];
  const marked: Array<{ where: Record<string, unknown>; data: { error: string } }> = [];
  const prisma = {
    session: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        asksFor(where, 'gemini') ? [{ id: 'gemini-1', error: null }] : [],
      updateMany: async (args: { where: Record<string, unknown>; data: { error: string } }) => {
        marked.push(args);
        return { count: 1 };
      },
    },
    user: admin,
    modelProvider: {
      findMany: async (args: unknown) => {
        providerLookups.push(args);
        return (args as { where: { runtime: string } }).where.runtime === AgentProvider.ANTIGRAVITY ? [{ slug: 'gemini' }] : [];
      },
    },
  } as never;
  const queue = { claimSessionForRunner: async () => null } as never;
  const realtime = { publishSessionCreated: () => undefined } as never;
  const controller = new RunnerApiController(prisma, queue, realtime, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);

  assert.equal(await controller.claim(RUNNER, SESSION_SOURCE_PIN_V1, 'claude,codex,opencode'), null);
  // The rows dispatch would resolve: enabled, this owner's or shared, on the Antigravity runtime.
  assert.deepEqual(providerLookups, [
    {
      where: {
        runtime: AgentProvider.ANTIGRAVITY,
        enabled: true,
        OR: [{ ownerId: null }, { ownerId: RUNNER.ownerId }],
      },
      select: { slug: true },
    },
    {
      where: { runtime: AgentProvider.DSH, enabled: true, OR: [{ ownerId: null }, { ownerId: RUNNER.ownerId }] },
      select: { slug: true },
    },
  ]);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].data.error, ANTIGRAVITY_RUNNER_UPGRADE_ERROR);
  assert.deepEqual(onRuntime(marked[0].where), {
    engine: AgentProvider.ANTIGRAVITY,
    provider: { in: [AgentProvider.ANTIGRAVITY, 'gemini'] },
  });
});

test('a row already carrying the notice is not written again on every long poll', async () => {
  let writes = 0;
  const prisma = {
    session: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        asksFor(where, AgentProvider.ANTIGRAVITY)
          ? [{ id: 'agy-1', error: ANTIGRAVITY_RUNNER_UPGRADE_ERROR }]
          : [],
      updateMany: async () => {
        writes += 1;
        return { count: 1 };
      },
    },
    user: admin,
    modelProvider: { findMany: async () => [] },
  } as never;
  const queue = { claimSessionForRunner: async () => null } as never;
  const controller = new RunnerApiController(prisma, queue, {} as never, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);

  assert.equal(await controller.claim(RUNNER, SESSION_SOURCE_PIN_V1, 'claude,codex,opencode'), null);
  assert.equal(writes, 0);
});

test('current claim advertises OpenCode and Antigravity directly to the atomic queue gate', async () => {
  let advertised: readonly AgentProvider[] | undefined;
  const queue = {
    claimSessionForRunner: async (runner: { supportedProviders?: readonly AgentProvider[] }) => {
      advertised = runner.supportedProviders;
      return null;
    },
  } as never;
  const controller = new RunnerApiController(
    { runner: { findUnique: async () => ({ capabilities: ['provider:dsh'], capabilitiesReportedAt: new Date() }) }, session: { findMany: async () => assert.fail('capable runner should not need a preflight') } } as never,
    queue,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );

  // Fully capable: OpenCode and Antigravity advertised AND `source-pin/v1` declared, so no
  // preflight has anything to explain and the claim goes straight to the queue.
  assert.equal(
    await controller.claim(RUNNER, SESSION_SOURCE_PIN_V1, 'claude,codex,opencode,antigravity,dsh'),
    null,
  );
  assert.deepEqual(advertised, [
    AgentProvider.CLAUDE,
    AgentProvider.CODEX,
    AgentProvider.OPENCODE,
    AgentProvider.ANTIGRAVITY,
    AgentProvider.DSH,
  ]);
});

/** Enough of a Session row for reclaim to build one ReclaimSession payload. A built-in session records
 *  the engine its slug names (Session.engine, migration 0414). */
function reclaimRow(id: string, provider: AgentProvider, status: string) {
  return {
    id,
    provider,
    providerBuiltin: true,
    engine: provider as string | null,
    status,
    cancelRequestedAt: null,
    error: null,
    workspace: null,
    ownerId: RUNNER.ownerId,
    model: 'pinned-model',
    usesRuntimeDefaultModel: true,
    inboxLeaseOwner: null,
    assignedRunner: null,
    permissionMode: null,
    effort: null,
    allowedTools: [],
    disallowedTools: [],
    // Claude is seeded with its runtime id at creation; reclaim skips a row without one.
    runtimeSessionId: provider === AgentProvider.CLAUDE ? `claude-${id}` : null,
  };
}

type UpgradeMark = { where: Record<string, unknown>; data: { error: string } };

function reclaimPrisma(
  rows: unknown[],
  onUpdate: (mark: UpgradeMark) => void,
  configured: Array<{ slug: string; runtime: string }> = [],
) {
  return {
    session: {
      findMany: async () => rows,
      updateMany: async (mark: UpgradeMark) => {
        onUpdate(mark);
        return { count: 1 };
      },
    },
    user: { findUnique: async () => null },
    modelProvider: {
      // The engine a row without one recorded ran on is its key's runtime (session-engine.ts).
      findFirst: async ({ where }: { where: { slug?: string } }) =>
        configured.find((row) => row.slug === where.slug) ?? null,
      // providerSlugsOn: the configured rows that borrow the runtime asked about.
      findMany: async ({ where }: { where: { runtime: string } }) =>
        configured.filter((row) => row.runtime === where.runtime).map(({ slug }) => ({ slug })),
    },
    providerPool: { findFirst: async () => null },
    runEvent: { aggregate: async () => ({ _max: { seq: 0 } }) },
    $executeRaw: async () => 0,
  } as never;
}

test('legacy reclaim omits OpenCode rows and keeps every other checkout', async () => {
  let upgradeMarked = false;
  const published: string[] = [];
  const prisma = reclaimPrisma(
    [
      reclaimRow('session-1', AgentProvider.OPENCODE, 'PENDING'),
      reclaimRow('session-2', AgentProvider.CLAUDE, 'AWAITING_INPUT'),
    ],
    () => {
      upgradeMarked = true;
    },
  );
  const realtime = { publishSessionCreated: (id: string) => published.push(id) } as never;
  const controller = new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);

  const res = await controller.reclaim(RUNNER, undefined, 'claude,codex');
  // A 426 here is not retryable on the runner and would stop the whole process, so the
  // undrivable row is dropped from the snapshot instead. Its checkout survives because
  // worktree GC re-asks `sessions/worktrees-removable`, which keeps non-terminal sessions.
  assert.deepEqual(
    res.sessions.map((s) => s.sessionId),
    ['session-2'],
  );
  assert.equal(upgradeMarked, true);
  assert.deepEqual(published, ['session-1']);
});

test('a capable reclaim keeps the OpenCode row in the snapshot', async () => {
  const prisma = reclaimPrisma([reclaimRow('session-1', AgentProvider.OPENCODE, 'AWAITING_INPUT')], () =>
    assert.fail('a capable runner needs no upgrade marking'),
  );
  const controller = new RunnerApiController(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);

  const res = await controller.reclaim(RUNNER, undefined, 'claude,codex,opencode');
  assert.deepEqual(
    res.sessions.map((s) => s.sessionId),
    ['session-1'],
  );
});

test('a reclaim that does not name Antigravity omits its rows and explains the pending ones', async () => {
  const marked: UpgradeMark[] = [];
  const published: string[] = [];
  const prisma = reclaimPrisma(
    [
      reclaimRow('agy-pending', AgentProvider.ANTIGRAVITY, 'PENDING'),
      // A warm agy conversation is omitted too, but it is not PENDING, so it carries no notice:
      // the claim never decides anything about a row that is not waiting for one.
      reclaimRow('agy-idle', AgentProvider.ANTIGRAVITY, 'AWAITING_INPUT'),
      reclaimRow('opencode-1', AgentProvider.OPENCODE, 'AWAITING_INPUT'),
      reclaimRow('claude-1', AgentProvider.CLAUDE, 'AWAITING_INPUT'),
    ],
    (mark) => marked.push(mark),
  );
  const realtime = { publishSessionCreated: (id: string) => published.push(id) } as never;
  const controller = new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);

  // OpenCode-capable, as every runner in the field is: its OpenCode checkout comes back, and the
  // Antigravity ones — which it would rebuild as Claude — do not.
  const res = await controller.reclaim(RUNNER, undefined, 'claude,codex,opencode');
  assert.deepEqual(
    res.sessions.map((s) => s.sessionId),
    ['opencode-1', 'claude-1'],
  );
  assert.equal(marked.length, 1);
  assert.equal(marked[0].data.error, ANTIGRAVITY_RUNNER_UPGRADE_ERROR);
  assert.deepEqual(marked[0].where.id, { in: ['agy-pending'] });
  assert.deepEqual(published, ['agy-pending']);
});

test('a reclaim that does not name Antigravity omits a Gemini key\'s rows too', async () => {
  const marked: UpgradeMark[] = [];
  // A Gemini key's sessions run on Antigravity, and say so: their engine is recorded, whatever the
  // key's slug — and the one an older replica wrote without it reads the key's runtime, as before.
  const geminiRow = {
    ...reclaimRow('gemini-pending', AgentProvider.CLAUDE, 'PENDING'),
    provider: 'gemini', providerBuiltin: false, engine: AgentProvider.ANTIGRAVITY,
  };
  const prisma = reclaimPrisma(
    [
      geminiRow,
      { ...reclaimRow('gemini-idle', AgentProvider.CLAUDE, 'AWAITING_INPUT'), provider: 'gemini', providerBuiltin: false, engine: null },
      reclaimRow('claude-1', AgentProvider.CLAUDE, 'AWAITING_INPUT'),
    ],
    (mark) => marked.push(mark),
    [{ slug: 'gemini', runtime: AgentProvider.ANTIGRAVITY }],
  );
  const realtime = { publishSessionCreated: () => undefined } as never;
  const controller = new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);

  // Rebuilt by this runner, the Gemini session would come back as a Claude one.
  const res = await controller.reclaim(RUNNER, undefined, 'claude,codex,opencode');
  assert.deepEqual(
    res.sessions.map((s) => s.sessionId),
    ['claude-1'],
  );
  assert.equal(marked.length, 1);
  assert.deepEqual(marked[0].where.id, { in: ['gemini-pending'] });
  assert.equal(marked[0].data.error, ANTIGRAVITY_RUNNER_UPGRADE_ERROR);
});

test('a capable reclaim keeps the Antigravity row in the snapshot, on its own runtime', async () => {
  const prisma = reclaimPrisma(
    [reclaimRow('agy-1', AgentProvider.ANTIGRAVITY, 'AWAITING_INPUT')],
    () => assert.fail('a capable runner needs no upgrade marking'),
  );
  const controller = new RunnerApiController(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);

  const res = await controller.reclaim(RUNNER, undefined, 'claude,codex,opencode,antigravity');
  assert.deepEqual(
    res.sessions.map((s) => s.sessionId),
    ['agy-1'],
  );
  // Rebuilt as agy, not as the Claude a stale identity would have fallen back to; agy has not
  // reported a conversation id yet, so it resumes under the Orbit session id (reclaim-runtime.ts).
  assert.equal(res.sessions[0].provider, AgentProvider.ANTIGRAVITY);
  assert.equal(res.sessions[0].agent.provider, AgentProvider.ANTIGRAVITY);
  assert.equal(res.sessions[0].sessionUuid, 'agy-1');
  assert.equal(res.sessions[0].runtimeSessionId, undefined);
});

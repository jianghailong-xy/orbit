import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { AgentProvider, PermissionMode, SESSION_SOURCE_PIN_V1 } from '@orbit/shared';
import { encryptSecret } from '../providers/provider-crypto';
import { QueueService } from '../queue/queue.service';
import { SessionsService } from '../sessions/sessions.service';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { CURSOR_ACCOUNT_LOGIN_V1, RunnerApiController } from './runner-api.controller';
import {
  ADVERTISED_RUNTIMES,
  ANTIGRAVITY_RUNNER_UPGRADE_ERROR,
  CURSOR_NOT_INSTALLED_ERROR,
  CURSOR_RUNNER_UPGRADE_ERROR,
  DSH_NOT_INSTALLED_ERROR,
  DSH_RUNNER_UPGRADE_ERROR,
  OPENCODE_RUNNER_UPGRADE_ERROR,
  cursorRunnerRefusal,
} from './runner-provider-support';

// The refusals of P9's rollback drill (§8.2): a runner whose release knows Cursor CLI but that has no CLI
// to run it — uninstalled, or never installed — is told to install it there, at every door that refused it
// with the upgrade notice; only a runner that predates Cursor CLI is still told to update. Antigravity's,
// DeepSeek Harness's and OpenCode's notices are what they were. scripts/test-cursor-rollback-messages.mjs
// runs these by name.

process.env.PROVIDER_SECRET_KEY = 'cursor-rollback-messages-test-key';

const ownerId = '22222222-2222-4222-8222-222222222222';
const id = '11111111-1111-4111-8111-111111111111';
const runnerRef = { id: '33333333-3333-4333-8333-333333333333', ownerId };
const opening = { prompt: 'Continue the project', title: 'Cursor rollback', workspaceId: 'workspace-1' };
const continuation = { clientTurnId: 'continue-1', content: 'Continue from the previous turn' };
const UPGRADE_WORDS = /requires a newer Orbit runner|update this runner first/;

/** What a release that knows Cursor CLI reports once the CLI is gone (P9 F1): the engine, not installed. */
const UNINSTALLED = [
  { engine: 'claude', installed: true, auth: 'yes' },
  { engine: 'cursor', installed: false, auth: 'unknown',
    installationError: "CURSOR_NOT_INSTALLED: Cursor CLI 2026.10.14-941492e is not installed in Orbit's version directory" },
];
/** …and what one reports with another build in the pinned build's directory. */
const ANOTHER_BUILD = [
  { engine: 'cursor', installed: true, version: '2026.10.16-e3cb207', auth: 'yes',
    installationError: 'CURSOR_VERSION_INCOMPATIBLE: Cursor CLI 2026.10.16-e3cb207 is installed, and Orbit runs exactly 2026.10.14-941492e' },
];
/** What a release from before Cursor CLI reports (P9 E1, 0.1.232): no Cursor CLI anywhere in it. */
const PREDATES = [{ engine: 'claude', installed: true, auth: 'yes' }, { engine: 'dsh', installed: false, auth: 'unknown' }];

/** The runners the drill met, as their persisted heartbeat describes them. None declares provider:cursor. */
const NEW_WITHOUT_CLI = { capabilities: ['provider:claude', CURSOR_ACCOUNT_LOGIN_V1], capabilitiesReportedAt: new Date(), engines: UNINSTALLED };
const OLD = { capabilities: ['provider:claude'], capabilitiesReportedAt: new Date(), engines: PREDATES };

function deepseekKey(slug: string) {
  return {
    slug, runtime: 'dsh', enabled: true, ownerId, label: slug,
    baseUrl: 'https://api.deepseek.com/anthropic', apiKeyEnc: encryptSecret('test-dsh-key'),
    defaultModel: null, models: [], presetSlug: null, followsPreset: false,
  };
}

/** SessionsService on one runner, with a session on `engine` assigned to it (cursor-session-preflight.spec.ts's). */
function sessions(runnerFacts: { capabilities: string[]; capabilitiesReportedAt: Date | null; engines: unknown }, options: {
  engine?: string; status?: RunStatus; keys?: unknown[];
} = {}) {
  const creates: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const turns: Array<Record<string, unknown>> = [];
  const runner = { id: runnerRef.id, name: 'r2', status: 'ONLINE', lastHeartbeatAt: new Date(), runsAsRoot: false, ...runnerFacts };
  const engine = options.engine ?? AgentProvider.CURSOR;
  const session = {
    id, ownerId, provider: engine, providerBuiltin: true, engine,
    model: engine === AgentProvider.CURSOR ? 'default[]' : null,
    permissionMode: engine === AgentProvider.CURSOR ? PermissionMode.ACCEPT_EDITS : PermissionMode.DEFAULT,
    usesRuntimeDefaultModel: true, runtimeSessionId: '55555555-5555-4555-8555-555555555555', numTurns: 3,
    startedAt: new Date(), status: options.status ?? RunStatus.FAILED,
    assignedRunnerId: runner.id, assignedRunner: runner, owner: { preferences: {} },
    workspace: null, cancelRequestedAt: null, completedAt: null, archivedAt: null,
    deletedAt: null, mergeStatus: null, commitStatus: null,
  };
  const keys = (options.keys ?? []) as Array<{ slug: string }>;
  const db = {
    user: { findUnique: async () => ({ preferences: {}, role: 'ADMIN' }) },
    workspace: { findFirst: async () => ({ runnerId: runner.id, enableWorktree: false }) },
    runner: { findFirst: async () => runner, findUnique: async () => runner },
    modelProvider: {
      findFirst: async ({ where }: { where: { slug?: string } }) => keys.find((key) => key.slug === where?.slug) ?? null,
      findMany: async () => keys,
    },
    providerPool: { findFirst: async () => null },
    providerSlugAlias: { findUnique: async () => null },
    session: {
      findFirst: async () => session,
      findUniqueOrThrow: async () => session,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return { id, ...data, endReason: null, completedAt: null, archivedAt: null, deletedAt: null };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { ...session, ...data };
      },
    },
    conversationTurn: {
      findUnique: async () => null, findFirst: async () => ({ seq: 3 }), count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        turns.push(data);
        return { id: 'resume-turn', ...data };
      },
    },
    $queryRaw: async () => [{ id, workspace_id: 'workspace-1', provider: 'claude', provider_builtin: true }],
    $executeRaw: async () => 1,
  };
  const service = new SessionsService({
    ...db, $transaction: async (fn: (tx: typeof db) => unknown) => fn(db),
  } as never, {
    notifySessionQueued: () => undefined, accountPoolRefusal: async () => null,
  } as never, {
    publishSessionCreated: () => undefined, publishSessionUpdated: () => undefined,
    publishWorkspaceChanged: () => undefined, notifyInbox: () => undefined,
  } as never);
  return { service, creates, updates, turns };
}

async function refusedWith(operation: () => Promise<unknown>, message: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ConflictException, String(error));
    assert.equal(error.getStatus(), 409);
    assert.equal(error.message, message);
    return true;
  });
}

function controller(prisma: unknown, queue: unknown) {
  return new RunnerApiController(prisma as never, queue as never,
    { publishSessionCreated() {}, notifyInbox() {} } as never, {} as never, {} as never, {} as never,
    { appendFor: async (_tx: unknown, _id: unknown, text: string) => text } as never);
}

/**
 * The claim's marking, on a runner whose persisted heartbeat is `snapshot` and whose request names
 * `request`: one waiting row per engine the runner withholds, and the notice each was marked with.
 */
async function markedOnClaim(request: string, snapshot: unknown): Promise<Map<string, string>> {
  const marked = new Map<string, string>();
  const prisma = {
    runner: { findUnique: async () => snapshot },
    user: { findUnique: async () => ({ role: 'ADMIN' }) },
    modelProvider: { findMany: async () => [] },
    session: {
      // One waiting row on each engine the marking asks about, named for it.
      findMany: async ({ where }: { where: { OR?: Array<{ engine?: string }> } }) =>
        where.OR?.[0]?.engine ? [{ id: `${where.OR[0].engine}-1`, error: null }] : [],
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: { error: string } }) => {
        for (const row of where.id.in) marked.set(row, data.error);
        return { count: where.id.in.length };
      },
    },
  };
  await controller(prisma, { claimSessionForRunner: async () => null }).claim(runnerRef, SESSION_SOURCE_PIN_V1, request);
  return marked;
}

test('Rollback messages: a runner that knows Cursor CLI but does not declare it is told to install it, and only an older one to update', () => {
  // The new sentence names the CLI and the install, and none of the upgrade's words.
  assert.equal(CURSOR_NOT_INSTALLED_ERROR, "Cursor CLI isn't installed on this runner; install it from the Machines & models page, then try again");
  assert.doesNotMatch(CURSOR_NOT_INSTALLED_ERROR, UPGRADE_WORDS);
  // A release that knows Cursor CLI: its engine report names it, installed or not, or it declares Cursor
  // CLI's account sign-in — which it does whether the CLI is there or not.
  for (const [label, runner] of [
    ['the engine reported, not installed', NEW_WITHOUT_CLI],
    ['the engine reported, and no account capability', { capabilities: [], capabilitiesReportedAt: new Date(), engines: UNINSTALLED }],
    ['another build where the pinned one belongs', { capabilities: [], capabilitiesReportedAt: new Date(), engines: ANOTHER_BUILD }],
    ['no engine report yet, the account sign-in declared', { capabilities: [CURSOR_ACCOUNT_LOGIN_V1], capabilitiesReportedAt: new Date(), engines: null }],
  ] as const) {
    assert.equal(cursorRunnerRefusal(runner), CURSOR_NOT_INSTALLED_ERROR, label);
  }
  // A release from before Cursor CLI, or nothing to go on: the upgrade notice, as before.
  for (const [label, runner] of [
    ['a report with no Cursor CLI in it', OLD],
    ['no report at all', { capabilities: [], capabilitiesReportedAt: new Date(), engines: null }],
    ['an account capability with no heartbeat behind it', { capabilities: [CURSOR_ACCOUNT_LOGIN_V1], capabilitiesReportedAt: null, engines: null }],
    ['no runner', null],
  ] as const) {
    assert.equal(cursorRunnerRefusal(runner), CURSOR_RUNNER_UPGRADE_ERROR, label);
  }
});

test('Rollback messages: creating a Cursor CLI session on a runner without the CLI says to install it there, and on an older runner to update it', async () => {
  for (const request of [{ engine: 'cursor' }, { provider: 'cursor' }]) {
    const missing = sessions(NEW_WITHOUT_CLI);
    await refusedWith(() => missing.service.create(ownerId, { ...opening, ...request }), CURSOR_NOT_INSTALLED_ERROR);
    assert.deepEqual(missing.creates, [], 'a refused session was created');
    const old = sessions(OLD);
    await refusedWith(() => old.service.create(ownerId, { ...opening, ...request }), CURSOR_RUNNER_UPGRADE_ERROR);
    assert.deepEqual(old.creates, [], 'a refused session was created');
  }
  // The same runner with the CLI back is admitted.
  const installed = sessions({ ...NEW_WITHOUT_CLI, capabilities: [...NEW_WITHOUT_CLI.capabilities, 'provider:cursor'] });
  await installed.service.create(ownerId, { ...opening, engine: 'cursor' });
  assert.equal(installed.creates.length, 1);
});

test('Rollback messages: reviving or switching a session onto Cursor CLI on a runner without the CLI says to install it there', async () => {
  for (const [runner, message] of [[NEW_WITHOUT_CLI, CURSOR_NOT_INSTALLED_ERROR], [OLD, CURSOR_RUNNER_UPGRADE_ERROR]] as const) {
    const revived = sessions(runner, { status: RunStatus.FAILED });
    await refusedWith(() => revived.service.resume(ownerId, id, continuation), message);
    assert.deepEqual(revived.updates, []);
    assert.deepEqual(revived.turns, []);
    const switched = sessions(runner, { status: RunStatus.AWAITING_INPUT });
    await refusedWith(() => switched.service.updateConfig(ownerId, id, { effort: 'high' }), message);
    assert.deepEqual(switched.updates, []);
  }
});

test('Rollback messages: a queued Cursor CLI session waits with the install notice on a runner that knows Cursor CLI, and with the upgrade notice on an older one', async () => {
  // The claim of a runner that withholds Cursor CLI — its request does not name it, as no release without
  // the CLI does (src/runner-go/cursor_health.go supportedProvidersHeader).
  const LEGACY = 'claude,codex,kimi,opencode,antigravity,dsh';
  assert.equal((await markedOnClaim(LEGACY, NEW_WITHOUT_CLI)).get('cursor-1'), CURSOR_NOT_INSTALLED_ERROR);
  assert.equal((await markedOnClaim(LEGACY, OLD)).get('cursor-1'), CURSOR_RUNNER_UPGRADE_ERROR);
  assert.equal((await markedOnClaim(LEGACY, null)).get('cursor-1'), CURSOR_RUNNER_UPGRADE_ERROR);

  // Reclaim says the same of a waiting row it withholds.
  for (const [snapshot, message] of [[NEW_WITHOUT_CLI, CURSOR_NOT_INSTALLED_ERROR], [OLD, CURSOR_RUNNER_UPGRADE_ERROR]] as const) {
    const marks: Array<{ ids: string[]; error: string }> = [];
    const waiting = {
      id: 'cursor-queued', provider: 'cursor', providerBuiltin: true, engine: 'cursor', ownerId, status: 'PENDING',
      model: 'default[]', usesRuntimeDefaultModel: true, runtimeSessionId: 'runtime-cursor', workspace: null,
      assignedRunner: null, cancelRequestedAt: null, error: null, permissionMode: 'acceptEdits', inboxLeaseOwner: null,
      sourceState: 'UNBOUND', allowedTools: [], disallowedTools: [],
    };
    const prisma = {
      runner: { findUnique: async () => snapshot },
      session: {
        findMany: async () => [waiting],
        updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: { error: string } }) => {
          marks.push({ ids: where.id.in, error: data.error });
          return { count: where.id.in.length };
        },
      },
      modelProvider: { findMany: async () => [] }, user: { findUnique: async () => null },
      $queryRaw: async () => [{ max: 0 }],
    };
    const response = await controller(prisma, {}).reclaim(runnerRef, SESSION_SOURCE_PIN_V1, `${LEGACY},cursor`);
    assert.deepEqual(response.sessions, [], 'a runner without Cursor CLI was handed a Cursor CLI session back');
    assert.deepEqual(marks, [{ ids: ['cursor-queued'], error: message }]);
  }
});

test('Rollback messages: a claim clears the install notice once a runner takes the session', async () => {
  let sql: { values: readonly unknown[] } | undefined;
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async (...args: unknown[]) => { sql = renderRawQuery(args); return []; },
  };
  const prisma = {
    session: { findMany: async () => [] },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
  await new QueueService(prisma, { publishSessionUpdated() {} } as never)
    .claimSessionForRunner({ id: runnerRef.id, supportedProviders: [AgentProvider.CLAUDE, AgentProvider.CURSOR] });
  assert.ok(sql, 'the claim did not run');
  // The notices the claim's CASE clears, beside the upgrade notice it already cleared.
  assert.ok(sql.values.includes(CURSOR_NOT_INSTALLED_ERROR), 'a claim keeps the Cursor CLI install notice');
  assert.ok(sql.values.includes(CURSOR_RUNNER_UPGRADE_ERROR), 'a claim keeps the Cursor CLI upgrade notice');
});

test('Rollback messages: the Antigravity, DeepSeek Harness and OpenCode notices are unchanged, on a runner that knows Cursor CLI too', async () => {
  // Word for word, as OrbitKit's and Android's SessionRunStart read them.
  assert.equal(ANTIGRAVITY_RUNNER_UPGRADE_ERROR, 'Antigravity requires a newer Orbit runner; update this runner first');
  assert.equal(DSH_RUNNER_UPGRADE_ERROR, 'DeepSeek Harness requires a newer Orbit runner with dsh support; update this runner first');
  assert.equal(OPENCODE_RUNNER_UPGRADE_ERROR, 'OpenCode requires Orbit runner 0.1.82 or newer; update this runner first');
  assert.equal(DSH_NOT_INSTALLED_ERROR,
    'DSH_NOT_INSTALLED: DeepSeek Harness is not installed on this runner, or the runner has not reported it yet; install it from the Machines & models page, then try again');
  assert.equal(CURSOR_RUNNER_UPGRADE_ERROR, 'Cursor CLI requires a newer Orbit runner with Cursor CLI support; update this runner first');
  assert.deepEqual(ADVERTISED_RUNTIMES.map(({ provider, upgradeError }) => [provider, upgradeError]), [
    [AgentProvider.OPENCODE, OPENCODE_RUNNER_UPGRADE_ERROR],
    [AgentProvider.ANTIGRAVITY, ANTIGRAVITY_RUNNER_UPGRADE_ERROR],
    [AgentProvider.DSH, DSH_RUNNER_UPGRADE_ERROR],
    [AgentProvider.CURSOR, CURSOR_RUNNER_UPGRADE_ERROR],
  ]);

  // A runner that withholds every gated engine marks each waiting row with its own engine's notice; only
  // Cursor CLI's says to install, because only Cursor CLI is what this runner knows and lacks.
  const marked = await markedOnClaim('claude,codex', NEW_WITHOUT_CLI);
  assert.deepEqual(Object.fromEntries(marked), {
    'opencode-1': OPENCODE_RUNNER_UPGRADE_ERROR,
    'antigravity-1': ANTIGRAVITY_RUNNER_UPGRADE_ERROR,
    'dsh-1': DSH_RUNNER_UPGRADE_ERROR,
    'cursor-1': CURSOR_NOT_INSTALLED_ERROR,
  });

  // DeepSeek Harness's door refuses a runner that does not declare it with its own notice, whatever that
  // runner knows of Cursor CLI.
  const harness = sessions(NEW_WITHOUT_CLI, { engine: AgentProvider.DSH, keys: [deepseekKey('harness-key')] });
  await refusedWith(() => harness.service.create(ownerId, { ...opening, provider: 'dsh' }), DSH_RUNNER_UPGRADE_ERROR);
  assert.deepEqual(harness.creates, []);
});

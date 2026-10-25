import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, SESSION_SOURCE_PIN_V1 } from '@orbit/shared';
import { QueueService } from '../queue/queue.service';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { RunnerApiController } from './runner-api.controller';
import {
  CURSOR_RUNNER_UPGRADE_ERROR,
  advertisedRunnerProviders,
  withProviderDeclarations,
} from './runner-provider-support';

// Migration 0426's gate on the application side (project P1); scripts/test-cursor-engine.mjs runs these
// by name, and cursor-runner-gate.pg.spec.ts runs the same routes against PostgreSQL.

const runner = { id: '11111111-1111-4111-8111-111111111111', ownerId: '22222222-2222-4222-8222-222222222222' };
const LEGACY = 'claude,codex,kimi,opencode,antigravity,dsh';
const CURRENT = `${LEGACY},cursor`;
const DECLARED = { capabilities: ['provider:dsh', 'provider:cursor'], capabilitiesReportedAt: new Date() };

function controller(prisma: unknown, queue: unknown) {
  return new RunnerApiController(prisma as never, queue as never,
    { publishSessionCreated() {}, notifyInbox() {} } as never, {} as never, {} as never, {} as never,
    { appendFor: async (_tx: unknown, _id: unknown, text: string) => text } as never);
}

/** A session row as reclaim reads it, recorded on its engine. */
function row(id: string, provider: string) {
  return {
    id, provider, providerBuiltin: true, engine: provider, ownerId: runner.ownerId, status: 'AWAITING_INPUT',
    model: 'pinned-model', usesRuntimeDefaultModel: true, runtimeSessionId: `runtime-${id}`,
    workspace: null, assignedRunner: null, cancelRequestedAt: null, error: null, permissionMode: 'acceptEdits',
    inboxLeaseOwner: null, sourceState: 'UNBOUND', allowedTools: [], disallowedTools: [],
  };
}

test('P1 cursor claim requires the request and the persisted heartbeat to declare Cursor CLI', async () => {
  for (const [request, snapshot, expected] of [
    [CURRENT, DECLARED, true],
    [LEGACY, DECLARED, false],
    [undefined, DECLARED, false],
    [CURRENT, { capabilities: ['provider:dsh'], capabilitiesReportedAt: new Date() }, false],
    [CURRENT, { capabilities: ['provider:cursor'], capabilitiesReportedAt: null }, false],
    [CURRENT, null, false],
  ] as const) {
    let providers: readonly AgentProvider[] = [];
    const prisma = {
      runner: { findUnique: async () => snapshot },
      session: { findMany: async () => [] }, modelProvider: { findMany: async () => [] },
      user: { findUnique: async () => ({ role: 'ADMIN' }) },
    };
    const queue = { claimSessionForRunner: async (value: { supportedProviders: AgentProvider[] }) => {
      providers = value.supportedProviders;
      return null;
    } };
    await controller(prisma, queue).claim(runner, SESSION_SOURCE_PIN_V1, request);
    assert.equal(providers.includes(AgentProvider.CURSOR), expected, `${request}/${JSON.stringify(snapshot)}`);
    // Nothing else the request names is taken away with it.
    if (request) assert.equal(providers.includes(AgentProvider.CLAUDE), true);
  }
});

test('P1 cursor rows on a runner that has not declared Cursor CLI carry the upgrade notice', async () => {
  for (const [request, snapshot] of [[LEGACY, DECLARED], [CURRENT, { capabilities: [], capabilitiesReportedAt: new Date() }]] as const) {
    const marked: Array<{ where: unknown; data: { error: string } }> = [];
    const prisma = {
      runner: { findUnique: async () => snapshot },
      user: { findUnique: async () => ({ role: 'ADMIN' }) },
      modelProvider: { findMany: async () => [] },
      session: {
        // Only the Cursor CLI question finds a row.
        findMany: async ({ where }: { where: { OR?: Array<{ engine?: string }> } }) =>
          where.OR?.[0]?.engine === AgentProvider.CURSOR ? [{ id: 'cursor-1', error: null }] : [],
        updateMany: async (args: { where: unknown; data: { error: string } }) => { marked.push(args); return { count: 1 }; },
      },
    };
    await controller(prisma, { claimSessionForRunner: async () => null }).claim(runner, SESSION_SOURCE_PIN_V1, request);
    assert.equal(marked.length, 1);
    assert.equal(marked[0].data.error, CURSOR_RUNNER_UPGRADE_ERROR);
    // Recorded on Cursor CLI whatever credential it spends, and — for a row without an engine — the slug.
    assert.deepEqual(marked[0].where, {
      id: { in: ['cursor-1'] }, assignedRunnerId: runner.id, status: 'PENDING',
      sessionKind: 'CONVERSATION',
      OR: [{ engine: 'cursor' }, { AND: [{ engine: null }, { provider: { in: ['cursor'] } }] }],
      cancelRequestedAt: null,
    });
  }
});

test('P1 cursor reclaim withholds Cursor CLI sessions from a runner that has not declared it', async () => {
  for (const [request, snapshot, handsBack] of [
    [undefined, DECLARED, false],
    [LEGACY, DECLARED, false],
    [CURRENT, { capabilities: ['provider:dsh'], capabilitiesReportedAt: new Date() }, false],
    [CURRENT, { capabilities: ['provider:cursor'], capabilitiesReportedAt: null }, false],
    [CURRENT, DECLARED, true],
  ] as const) {
    const prisma = {
      runner: { findUnique: async () => snapshot },
      session: { findMany: async () => [row('cursor', 'cursor'), row('claude', 'claude')], updateMany: async () => ({ count: 0 }) },
      modelProvider: { findMany: async () => [] }, user: { findUnique: async () => null },
      // run_event max(seq) for the reclaim snapshot — raw SQL, never `aggregate`.
      $queryRaw: async () => [{ max: 0 }],
    };
    const response = await controller(prisma, {}).reclaim(runner, SESSION_SOURCE_PIN_V1, request);
    assert.deepEqual(response.sessions.map((session) => session.sessionId), handsBack ? ['cursor', 'claude'] : ['claude']);
    if (handsBack) assert.equal(response.sessions[0].provider, AgentProvider.CURSOR);
  }
});

async function claimStatement(supportedProviders: AgentProvider[]) {
  let sql: { text: string; strings: readonly string[]; values: readonly unknown[] } | undefined;
  let settings: { text: string; strings: readonly string[]; values: readonly unknown[] } | undefined;
  const tx = {
    $executeRaw: async (...args: unknown[]) => {
      const rendered = renderRawQuery(args);
      if (rendered.text.includes('orbit.runner_supports_cursor')) settings = rendered;
      return 0;
    },
    $queryRaw: async (...args: unknown[]) => { sql = renderRawQuery(args); return []; },
  };
  const prisma = {
    session: { findMany: async () => [] },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
  await new QueueService(prisma, { publishSessionUpdated() {} } as never)
    .claimSessionForRunner({ id: runner.id, supportedProviders });
  assert.ok(sql && settings, 'the claim did not run, or set no Cursor CLI capability');
  // The value set_config binds for the GUC named in front of it.
  const guc = settings.values[settings.strings.findIndex((segment) => segment.includes("'orbit.runner_supports_cursor', "))];
  // The capability bound in the claim's Cursor CLI predicate, ahead of its heartbeat check.
  const gate = sql.strings.findIndex((segment, i) => i > 0 && segment.includes("<> 'cursor'"));
  return { guc, capability: sql.values[gate], sql: sql.text, values: sql.values, settings: settings.text };
}

test('P1 the claim statement and the database guard are told whether the runner declared Cursor CLI', async () => {
  const legacy = await claimStatement([AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.DSH]);
  assert.equal(legacy.guc, '0');
  assert.equal(legacy.capability, false);
  const current = await claimStatement([AgentProvider.CLAUDE, AgentProvider.CURSOR]);
  assert.equal(current.guc, '1');
  assert.equal(current.capability, true);
  // One statement, beside the other runtimes' and 0414's declaration that the claim reads engines.
  assert.match(current.settings, /set_config\('orbit\.runner_supports_dsh', .+set_config\('orbit\.runner_supports_cursor', .+set_config\('orbit\.claim_reads_session_engine', '1', true\)/s);
  // A session on Cursor CLI by its recorded engine, or without one under the slug, and the heartbeat asked again.
  assert.match(current.sql, /COALESCE\(s\."engine", s\.provider, 'claude'\) <> 'cursor'/);
  assert.match(current.sql, /'provider:cursor' = ANY\(r\.capabilities\)/);
  // Cursor CLI's own sign-in is a credential the claim can hand out, recorded or not.
  assert.match(current.sql, /s\.provider IN \('claude', 'codex', 'opencode', 'antigravity', 'cursor'\)/);
  assert.match(current.sql, /COALESCE\(s\.provider, 'claude'\) IN \('claude', 'codex', 'opencode', 'antigravity', 'cursor'\)/);
  // A claim clears the notice it just disproved.
  assert.ok(current.values.includes(CURSOR_RUNNER_UPGRADE_ERROR), 'a claim keeps the Cursor CLI upgrade notice');
});

test('P1 cursor heartbeat declarations are exact and an omitted header withdraws them', () => {
  assert.deepEqual(advertisedRunnerProviders('CURSOR,cursor-agent,cursor-cli,unknown'), [AgentProvider.CURSOR]);
  assert.deepEqual(advertisedRunnerProviders(LEGACY).includes(AgentProvider.CURSOR), false);
  assert.deepEqual(withProviderDeclarations(['source-pin/v1', 'provider:cursor'], undefined), ['source-pin/v1']);
  assert.deepEqual(withProviderDeclarations(['provider:cursor'], 'claude,codex'), ['provider:claude', 'provider:codex']);
  assert.deepEqual(withProviderDeclarations([], 'Cursor'), ['provider:cursor']);
});

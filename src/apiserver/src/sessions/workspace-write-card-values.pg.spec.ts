/**
 * A workspace write's card loses its variables' values when the reapers collect it unanswered, in the
 * transaction that collects it, against a real PostgreSQL. The owner's answer takes the other door, and
 * runner-api/runner-workspace-write.pg.spec.ts holds that one.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/workspace-write-card-values.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import {
  reapApprovalsOfEndedTurns,
  reapApprovalsOfReplacedSupervisor,
  reapApprovalsOfReturnedCalls,
  reapApprovalsOfReturnedCallsIn,
} from './abandoned-approvals';
import {
  WORKSPACE_UPDATE_APPROVAL_TOOL_NAME,
  holdsWorkspaceWriteValues,
  withoutEnvValues,
  withoutEnvValuesInToolUse,
} from './workspace-write-card-values';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const SECRET = `value-of-a-key-${RUN}`;

const cardInput = (env: Record<string, string>) => ({
  agentId: randomUUID(), name: 'target', workDir: null, runner: null, envRemoved: [], writeSalt: 's', writeDigest: 'd',
  changes: { env, workDir: '/srv/after' },
});

test('withoutEnvValues keeps the names and the rest, and leaves any other card alone', () => {
  assert.deepEqual(
    withoutEnvValues({ name: 'n', changes: { env: { B: 'x', A: 'y' }, workDir: '/w' } }),
    { name: 'n', changes: { workDir: '/w', envNames: ['A', 'B'] } },
  );
  assert.deepEqual(withoutEnvValues({ name: 'n', changes: { workDir: '/w' } }), { name: 'n', changes: { workDir: '/w' } });
  assert.deepEqual(withoutEnvValues({ command: 'true' }), { command: 'true' });
  assert.equal(withoutEnvValues(null), null);
  // An engine's own prompt holds the call's arguments as they were sent.
  assert.deepEqual(withoutEnvValues({ agentId: 'a', env: { B: 'x', A: 'y' } }), { agentId: 'a', envNames: ['A', 'B'] });
  assert.deepEqual(
    withoutEnvValues({ message: 'm', arguments: { agentId: 'a', env: { B: 'x' } } }),
    { message: 'm', arguments: { agentId: 'a', envNames: ['B'] } },
    'and Codex under `arguments`',
  );
  const untouched = { name: 'n', changes: { workDir: '/w' }, env: 'a string is no map' };
  assert.equal(withoutEnvValues(untouched), untouched, 'a card holding none comes back as it was');
});

test('every spelling of the call holds values, and no other tool does', () => {
  for (const name of ['orbit_agent_create', 'orbit_agent_update', 'mcp__orbit__agent_create', 'mcp__orbit__agent_update', 'orbit__agent_update', 'agent_update']) {
    assert.equal(holdsWorkspaceWriteValues(name), true, name);
  }
  for (const name of ['orbit_agent_delete', 'agent_list', 'Bash', 'orbit_task_create', 'agent_update_something']) {
    assert.equal(holdsWorkspaceWriteValues(name), false, name);
  }
});

test('a transcript keeps a workspace write\'s names and no value, however the engine spells it', () => {
  const masked = { A: '(set — not shown)' };
  for (const name of ['mcp__orbit__agent_update', 'orbit__agent_create', 'orbit_agent_update']) {
    const event = { seq: 1, type: 'tool_use', payload: { id: 'c', name, input: { agentId: 'a', env: { A: SECRET } } } };
    assert.deepEqual(withoutEnvValuesInToolUse(event).payload.input, { agentId: 'a', env: masked }, name);
    assert.equal(event.payload.input.env.A, SECRET, 'and it does not write on what it was handed');
  }
  const antigravity = { type: 'tool_use', payload: { name: 'call_mcp_tool', input: { ServerName: 'orbit', ToolName: 'agent_update', Arguments: { agentId: 'a', env: { A: SECRET } } } } };
  assert.deepEqual(JSON.stringify(withoutEnvValuesInToolUse(antigravity).payload.input).includes(SECRET), false);
  assert.deepEqual((withoutEnvValuesInToolUse(antigravity).payload.input as typeof antigravity.payload.input).Arguments.env, masked);
  for (const event of [
    { type: 'tool_use', payload: { name: 'bg_run', input: { command: 'x', env: { A: 'kept' } } } },
    { type: 'tool_use', payload: { name: 'call_mcp_tool', input: { ToolName: 'bg_run', Arguments: { env: { A: 'kept' } } } } },
    { type: 'tool_use', payload: { name: 'mcp__orbit__agent_update', input: null } },
    { type: 'tool_use', payload: { name: 'mcp__orbit__agent_update', input: { name: 'x' } } },
    { type: 'tool_result', payload: { name: 'mcp__orbit__agent_update', input: { env: { A: 'kept' } } } },
  ]) {
    assert.equal(withoutEnvValuesInToolUse(event), event);
  }
});

test('a reaper that collects a card takes its values with it', { skip: !URL, concurrency: 1, timeout: 120_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `values-${RUN}@workspace-write.test`, name: 'o', passwordHash: 'x' } });
  const session = async () => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, title: 'asker', prompt: 'p', provider: 'claude', providerBuiltin: true,
        status: RunStatus.AWAITING_INPUT, runtimeSessionId: randomUUID(), dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
    return id;
  };
  const input = async (id: string) => (await db.approval.findUniqueOrThrow({ where: { id }, select: { input: true } })).input;

  await t.test('an ended turn', async () => {
    const sessionId = await session();
    // The turn it was raised in has ended: no such turn is live any more.
    const collected = await db.approval.create({
      data: { sessionId, toolName: WORKSPACE_UPDATE_APPROVAL_TOOL_NAME, input: cardInput({ A: SECRET }), turnId: randomUUID() },
    });
    // Nothing says this one's reader is gone. It stays a question, values and all.
    const waiting = await db.approval.create({
      data: { sessionId, toolName: WORKSPACE_UPDATE_APPROVAL_TOOL_NAME, input: cardInput({ B: SECRET }) },
    });
    // Another kind of card keeps what it holds.
    const bash = await db.approval.create({
      data: { sessionId, toolName: 'Bash', input: { command: `echo ${SECRET}` }, turnId: randomUUID() },
    });
    const count = await db.$transaction((tx) => reapApprovalsOfEndedTurns(tx, sessionId));
    assert.equal(count, 2);
    assert.equal(JSON.stringify(await input(collected.id)).includes(SECRET), false);
    assert.deepEqual(((await input(collected.id)) as { changes: unknown }).changes, { workDir: '/srv/after', envNames: ['A'] });
    assert.equal(JSON.stringify(await input(waiting.id)).includes(SECRET), true);
    assert.equal(JSON.stringify(await input(bash.id)).includes(SECRET), true);
  });

  await t.test('a job gone', async () => {
    const sessionId = await session();
    const collected = await db.approval.create({
      data: { sessionId, toolName: WORKSPACE_UPDATE_APPROVAL_TOOL_NAME, input: cardInput({ A: SECRET }), backgroundJobId: 'bgj_gone' },
    });
    assert.equal(await db.$transaction((tx) => reapApprovalsOfEndedTurns(tx, sessionId)), 1);
    assert.equal(JSON.stringify(await input(collected.id)).includes(SECRET), false);
  });

  await t.test('its own call returned, alone and in a merged call', async () => {
    const sessionId = await session();
    const prompt = await db.approval.create({
      data: { sessionId, toolName: 'mcp__orbit__agent_update', input: { agentId: 'a', env: { A: SECRET } }, toolUseId: 'one' },
    });
    assert.deepEqual(await db.$transaction((tx) => reapApprovalsOfReturnedCalls(tx, sessionId, ['one'])), [prompt.id]);
    assert.deepEqual(await input(prompt.id), { agentId: 'a', envNames: ['A'] });

    const merged = await db.approval.create({
      data: { sessionId, toolName: 'orbit__agent_update', input: { agentId: 'a', arguments: { env: { B: SECRET } } }, toolUseId: 'two' },
    });
    await db.$transaction((tx) => reapApprovalsOfReturnedCallsIn(tx, [{ sessionId, toolUseIds: ['two'] }]));
    assert.deepEqual(await input(merged.id), { agentId: 'a', arguments: { envNames: ['B'] } });
  });

  await t.test('a supervisor replaced', async () => {
    const sessionId = await session();
    const collected = await db.approval.create({
      data: { sessionId, toolName: WORKSPACE_UPDATE_APPROVAL_TOOL_NAME, input: cardInput({ A: SECRET }) },
    });
    assert.deepEqual(await db.$transaction((tx) => reapApprovalsOfReplacedSupervisor(tx, sessionId)), [collected.id]);
    assert.equal(JSON.stringify(await input(collected.id)).includes(SECRET), false);
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { uuidToBase62 as toPublicId } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { TerminalCredentials } from './terminal-credentials';

// TerminalCredentials.confine: what an admitted TERMINAL request names must be on the credential's own runner
// (docs/terminal-session-design.md). The rows are a stub keyed by id; the pg spec holds the same against PostgreSQL.

const userId = randomUUID();
const runnerId = randomUUID();
const otherRunner = randomUUID();
const grant = { userId, runnerId };

const sessions = new Map<string, { ownerId: string; assignedRunnerId: string | null }>();
const workspaces = new Map<string, { ownerId: string; runnerId: string | null; deletedAt: Date | null }>();
const prisma = {
  session: {
    findFirst: async ({ where }: { where: { id: string; ownerId: string } }) => {
      const row = sessions.get(where.id);
      return row && row.ownerId === where.ownerId ? { assignedRunnerId: row.assignedRunnerId } : null;
    },
  },
  workspace: {
    findFirst: async ({ where }: { where: { id: string; ownerId: string } }) => {
      const row = workspaces.get(where.id);
      return row && row.ownerId === where.ownerId && row.deletedAt === null ? { runnerId: row.runnerId } : null;
    },
  },
} as unknown as PrismaService;
const terminals = new TerminalCredentials(prisma);

const ownSession = randomUUID();
const otherRunnerSession = randomUUID();
const unassignedSession = randomUUID();
const otherAccountSession = randomUUID();
sessions.set(ownSession, { ownerId: userId, assignedRunnerId: runnerId });
sessions.set(otherRunnerSession, { ownerId: userId, assignedRunnerId: otherRunner });
sessions.set(unassignedSession, { ownerId: userId, assignedRunnerId: null });
sessions.set(otherAccountSession, { ownerId: randomUUID(), assignedRunnerId: runnerId });
const ownWorkspace = randomUUID();
const otherRunnerWorkspace = randomUUID();
const runnerlessWorkspace = randomUUID();
const deletedWorkspace = randomUUID();
workspaces.set(ownWorkspace, { ownerId: userId, runnerId, deletedAt: null });
workspaces.set(otherRunnerWorkspace, { ownerId: userId, runnerId: otherRunner, deletedAt: null });
workspaces.set(runnerlessWorkspace, { ownerId: userId, runnerId: null, deletedAt: null });
workspaces.set(deletedWorkspace, { ownerId: userId, runnerId, deletedAt: new Date() });

/** The fields a refusal names, or 'admitted'. */
async function verdict(kind: Parameters<TerminalCredentials['confine']>[1], req: { params?: Record<string, unknown>; body?: unknown }) {
  try {
    await terminals.confine(req, kind, grant);
    return 'admitted';
  } catch (error) {
    assert.ok(error instanceof ForbiddenException, String(error));
    const body = error.getResponse() as { code: string; credentialKind: string; fields: string[] };
    assert.equal(body.code, 'TERMINAL_RUNNER_OUT_OF_SCOPE');
    assert.equal(body.credentialKind, 'TERMINAL');
    return body.fields;
  }
}

test('a session route admits a session of the account on the credential\'s runner, by uuid or public id, and nothing else', async () => {
  assert.equal(await verdict('SESSION', { params: { id: ownSession } }), 'admitted');
  assert.equal(await verdict('SESSION', { params: { id: toPublicId(ownSession) } }), 'admitted');
  for (const id of [otherRunnerSession, unassignedSession, otherAccountSession, randomUUID(), 'not-an-id', undefined]) {
    assert.deepEqual(await verdict('SESSION', { params: { id } }), [':id'], `session ${id}`);
  }
});

test('creating a session admits this runner and its workspaces, and refuses another machine, a task, or naming none', async () => {
  const create = (body: unknown) => verdict('CREATE_SESSION', { body });
  assert.equal(await create({ prompt: 'x', workspaceId: ownWorkspace }), 'admitted');
  assert.equal(await create({ prompt: 'x', workspaceId: toPublicId(ownWorkspace) }), 'admitted');
  assert.equal(await create({ prompt: 'x', agentId: ownWorkspace }), 'admitted');
  assert.equal(await create({ prompt: 'x', assignedRunnerId: runnerId, workspaceId: ownWorkspace }), 'admitted');
  assert.equal(await create({ prompt: 'x', assignedRunnerId: toPublicId(runnerId), newWorkspace: { workDir: '/home/me/x' } }), 'admitted');

  assert.deepEqual(await create({ prompt: 'x', workspaceId: otherRunnerWorkspace }), ['workspaceId']);
  assert.deepEqual(await create({ prompt: 'x', agentId: otherRunnerWorkspace }), ['agentId']);
  assert.deepEqual(await create({ prompt: 'x', workspaceId: runnerlessWorkspace }), ['workspaceId']);
  assert.deepEqual(await create({ prompt: 'x', workspaceId: deletedWorkspace }), ['workspaceId']);
  assert.deepEqual(await create({ prompt: 'x', workspaceId: randomUUID() }), ['workspaceId']);
  assert.deepEqual(await create({ prompt: 'x', assignedRunnerId: otherRunner, newWorkspace: { workDir: '/x' } }), ['assignedRunnerId']);
  // Our runner, another machine's workspace: still refused, whichever the session would take.
  assert.deepEqual(await create({ prompt: 'x', assignedRunnerId: runnerId, workspaceId: otherRunnerWorkspace }), ['workspaceId']);
  assert.deepEqual(await create({ prompt: 'x', workspaceId: ownWorkspace, agentId: otherRunnerWorkspace }), ['agentId']);
  assert.deepEqual(await create({ prompt: 'x', workspaceId: ownWorkspace, taskId: randomUUID() }), ['taskId']);
  assert.deepEqual(await create({ prompt: 'x' }), ['assignedRunnerId']);
  assert.deepEqual(await create(undefined), ['assignedRunnerId']);
  assert.deepEqual(await create({ prompt: 'x', assignedRunnerId: 42 }), ['assignedRunnerId']);
});

test('the terminal acting on itself and the narrowed workspace list judge nothing in the request', async () => {
  assert.equal(await verdict('SELF', { params: { id: otherRunnerSession } }), 'admitted');
  assert.equal(await verdict('WORKSPACE_LIST', { body: { workspaceId: otherRunnerWorkspace } }), 'admitted');
});

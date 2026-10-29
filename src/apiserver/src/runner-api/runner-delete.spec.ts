import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { AgentProvider, uuidToBase62 } from '@orbit/shared';
import { MANAGED_RUNNER_DELETE_REFUSED } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { RunnersService } from '../runners/runners.service';
import type { WorkspacesService } from '../workspaces/workspaces.service';
import { RunnerApiController } from './runner-api.controller';
import {
  DELETE_APPROVAL_REQUIRED,
  RUNNER_DELETE_APPROVAL_TOOL_NAME,
  RUNNER_DELETE_SELF,
  WORKSPACE_DELETE_APPROVAL_TOOL_NAME,
  WORKSPACE_DELETE_SELF,
} from './runner-delete-approval';
import { RunnerDeleteController } from './runner-delete.controller';
import type { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';

// Deleting a runner or a workspace from a session (runner_delete / agent_delete): the card the owner
// is asked on says what the server reads, and the delete goes through only on that card's yes.

const OWNER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '66666666-6666-4666-8666-666666666666';
const SESSION = '019fc086-c7c7-7c92-8215-778ad8a6280a';
const OTHER_SESSION = '019fc086-c7c7-7c92-8215-778ad8a62999';
/** The machine the asking session runs on, and the workspace it runs in. */
const OWN_RUNNER = '11111111-1111-4111-8111-111111111111';
const OWN_WORKSPACE = '33333333-3333-4333-8333-333333333333';
/** A rented machine of the account's, offline, with one workspace on it. */
const RENTED = '44444444-4444-4444-8444-444444444444';
const LOADTEST = '55555555-5555-4555-8555-555555555555';
const THEIRS = '77777777-7777-4777-8777-777777777777';
/** A managed runner of the account's: its own workflow removes it. */
const MANAGED = '88888888-8888-4888-8888-888888888888';

const HOURS_AGO = new Date(Date.now() - 6 * 3_600_000);

interface Card {
  id: string;
  sessionId: string;
  toolName: string;
  status: string;
  decidedById: string | null;
  decidedAt: Date | null;
  input: unknown;
}

const yes = (toolName: string, input: Record<string, unknown>, extra: Partial<Card> = {}): Card => ({
  id: `card-${Math.random().toString(36).slice(2)}`,
  sessionId: SESSION,
  toolName,
  status: 'ALLOWED',
  decidedById: OWNER,
  decidedAt: new Date(),
  input,
  ...extra,
});

/** The account's rows as Prisma reads them, the asks it sees, and what each door changed. */
function world(cards: Card[] = []) {
  const runners = [
    {
      id: RENTED, ownerId: OWNER, name: 'instance-20261027-071926', displayName: null, status: 'ONLINE',
      lastHeartbeatAt: HOURS_AGO, presence: null,
      workspaces: [{ id: LOADTEST, name: 'c2b-loadtest', workDir: null }],
    },
    {
      id: OWN_RUNNER, ownerId: OWNER, name: 'workstation-gpu', displayName: 'HPC', status: 'ONLINE',
      lastHeartbeatAt: new Date(), presence: null,
      workspaces: [{ id: OWN_WORKSPACE, name: 'orbit-develop', workDir: '/root/orbit' }],
    },
    { id: THEIRS, ownerId: STRANGER, name: 'not-yours', displayName: null, status: 'ONLINE', lastHeartbeatAt: null, presence: null, workspaces: [] },
    { id: MANAGED, ownerId: OWNER, name: 'managed-box', displayName: null, status: 'ONLINE', lastHeartbeatAt: null, presence: null, workspaces: [] },
  ];
  const workspaces = [
    { id: LOADTEST, ownerId: OWNER, deletedAt: null, name: 'c2b-loadtest', workDir: null, runner: { id: RENTED, name: 'instance-20261027-071926', displayName: null } },
    { id: OWN_WORKSPACE, ownerId: OWNER, deletedAt: null, name: 'orbit-develop', workDir: '/root/orbit', runner: { id: OWN_RUNNER, name: 'workstation-gpu', displayName: 'HPC' } },
  ];
  const seen = {
    runnerWheres: [] as Record<string, unknown>[],
    approvalsRead: 0,
    removedRunners: [] as string[][],
    removedWorkspaces: [] as string[][],
    published: [] as unknown[][],
  };
  const prisma = {
    runner: {
      findFirst: async ({ where }: { where: { id: string; ownerId: string } }) => {
        seen.runnerWheres.push(where);
        const row = runners.find((r) => r.id === where.id && r.ownerId === where.ownerId);
        if (!row) return null;
        const { ownerId: _ownerId, ...read } = row;
        return read;
      },
    },
    workspace: {
      findFirst: async ({ where }: { where: { id: string; ownerId: string; deletedAt: null } }) => {
        const row = workspaces.find((w) => w.id === where.id && w.ownerId === where.ownerId && w.deletedAt === null);
        if (!row) return null;
        const { ownerId: _ownerId, deletedAt: _deletedAt, ...read } = row;
        return read;
      },
    },
    session: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === SESSION ? { id: SESSION, workspaceId: OWN_WORKSPACE } : null,
    },
    managedRunner: {
      findUnique: async ({ where }: { where: { runnerId: string } }) => (where.runnerId === MANAGED ? { id: 'managed-1' } : null),
    },
    approval: {
      // The filter the route asks for, applied as Postgres would: a card is only ever read through it.
      findMany: async ({ where }: { where: { sessionId: string; toolName: string; status: string; decidedById: { not: null } } }) => {
        seen.approvalsRead += 1;
        assert.deepEqual(where.decidedById, { not: null }, 'only a card a person answered is read');
        return cards.filter((c) => c.sessionId === where.sessionId && c.toolName === where.toolName
          && c.status === where.status && c.decidedById !== null);
      },
    },
  } as unknown as PrismaService;
  return { prisma, seen };
}

function doors(cards: Card[] = [], refuse = false) {
  const { prisma, seen } = world(cards);
  const orchestration = {
    assert: async () => {
      if (refuse) throw new ForbiddenException('orchestration is not enabled for this session');
      return SESSION;
    },
  } as unknown as RunnerOrchestrationAuthorizer;
  const runners = {
    removeRunner: async (ownerId: string, id: string) => {
      seen.removedRunners.push([ownerId, id]);
      return { ok: true };
    },
  } as unknown as RunnersService;
  const workspaces = {
    remove: async (ownerId: string, id: string) => {
      seen.removedWorkspaces.push([ownerId, id]);
      return { ok: true };
    },
  } as unknown as WorkspacesService;
  const realtime = {
    publishWorkspaceChanged: (...args: unknown[]) => {
      seen.published.push(args);
    },
  } as unknown as RealtimeService;
  return { controller: new RunnerDeleteController(prisma, orchestration, runners, workspaces, realtime), seen };
}

const CALLER = { id: OWN_RUNNER, ownerId: OWNER } as never;

function codeOf(error: unknown): unknown {
  return error instanceof HttpException ? (error.getResponse() as { code?: unknown }).code : undefined;
}

test('the gate comes first: a session that may not orchestrate reads and deletes nothing', async () => {
  const { controller, seen } = doors([yes(RUNNER_DELETE_APPROVAL_TOOL_NAME, { runnerId: RENTED })], true);
  await assert.rejects(controller.deleteRunner(CALLER, SESSION, 'credential', RENTED), ForbiddenException);
  await assert.rejects(controller.deleteWorkspace(CALLER, SESSION, 'credential', LOADTEST), ForbiddenException);
  assert.deepEqual(seen.runnerWheres, []);
  assert.equal(seen.approvalsRead, 0);
  assert.deepEqual([seen.removedRunners, seen.removedWorkspaces], [[], []]);
});

test("another account's runner is not found, and no card is looked at for it", async () => {
  const { controller, seen } = doors([yes(RUNNER_DELETE_APPROVAL_TOOL_NAME, { runnerId: THEIRS })]);
  await assert.rejects(controller.deleteRunner(CALLER, SESSION, 'credential', THEIRS), NotFoundException);
  assert.deepEqual(seen.runnerWheres, [{ id: THEIRS, ownerId: OWNER }]);
  assert.equal(seen.approvalsRead, 0);
  assert.deepEqual(seen.removedRunners, []);
});

test('the runner the asking session runs on is refused, whatever its cards say', async () => {
  const { controller, seen } = doors([yes(RUNNER_DELETE_APPROVAL_TOOL_NAME, { runnerId: OWN_RUNNER })]);
  const error = await controller.deleteRunner(CALLER, SESSION, 'credential', OWN_RUNNER).catch((e: unknown) => e);
  assert.ok(error instanceof ConflictException);
  assert.equal(codeOf(error), RUNNER_DELETE_SELF);
  assert.deepEqual(seen.removedRunners, []);
});

test('a managed runner is refused before any card is looked at: its own workflow removes it', async () => {
  const { controller, seen } = doors([yes(RUNNER_DELETE_APPROVAL_TOOL_NAME, { runnerId: MANAGED })]);
  const error = await controller.deleteRunner(CALLER, SESSION, 'credential', MANAGED).catch((e: unknown) => e);
  assert.ok(error instanceof ConflictException);
  assert.equal(codeOf(error), MANAGED_RUNNER_DELETE_REFUSED);
  assert.equal(seen.approvalsRead, 0);
  assert.deepEqual(seen.removedRunners, []);
});

test('without the owner\'s yes in this conversation, about this runner, nothing is deleted', async () => {
  const unanswered: Array<[string, Card[]]> = [
    ['no card at all', []],
    ['a card about another runner', [yes(RUNNER_DELETE_APPROVAL_TOOL_NAME, { runnerId: OWN_RUNNER })]],
    ['a workspace card naming the same id', [yes(WORKSPACE_DELETE_APPROVAL_TOOL_NAME, { agentId: RENTED, runnerId: RENTED })]],
    ['a card still waiting', [yes(RUNNER_DELETE_APPROVAL_TOOL_NAME, { runnerId: RENTED }, { status: 'PENDING', decidedById: null, decidedAt: null })]],
    ['a card the owner declined', [yes(RUNNER_DELETE_APPROVAL_TOOL_NAME, { runnerId: RENTED }, { status: 'DENIED' })]],
    ['a card a standing rule allowed', [yes(RUNNER_DELETE_APPROVAL_TOOL_NAME, { runnerId: RENTED }, { decidedById: null })]],
    ['a card from another conversation', [yes(RUNNER_DELETE_APPROVAL_TOOL_NAME, { runnerId: RENTED }, { sessionId: OTHER_SESSION })]],
  ];
  for (const [what, cards] of unanswered) {
    const { controller, seen } = doors(cards);
    const error = await controller.deleteRunner(CALLER, SESSION, 'credential', RENTED).catch((e: unknown) => e);
    assert.ok(error instanceof ForbiddenException, `${what}: ${String(error)}`);
    assert.equal(codeOf(error), DELETE_APPROVAL_REQUIRED, what);
    assert.deepEqual(seen.removedRunners, [], what);
    assert.deepEqual(seen.published, [], what);
  }
});

test("the owner's yes deletes the runner, however the card spells its id, and its workspaces go with it", async () => {
  for (const spelled of [RENTED, uuidToBase62(RENTED)]) {
    const { controller, seen } = doors([yes(RUNNER_DELETE_APPROVAL_TOOL_NAME, { runnerId: spelled })]);
    const answer = await controller.deleteRunner(CALLER, SESSION, 'credential', RENTED);
    assert.deepEqual(seen.removedRunners, [[OWNER, RENTED]]);
    assert.deepEqual(seen.published, [[SESSION, LOADTEST, true]], 'the owner\'s open lists drop the workspace that went with it');
    assert.deepEqual(answer, {
      ok: true,
      deleted: {
        runnerId: RENTED,
        name: 'instance-20261027-071926',
        displayName: null,
        online: false,
        lastHeartbeatAt: HOURS_AGO.toISOString(),
        workspaces: [{ id: LOADTEST, name: 'c2b-loadtest', workDir: null }],
      },
    });
  }
});

test('a workspace: the asking session\'s own is refused, and another goes on the owner\'s yes', async () => {
  const own = doors([yes(WORKSPACE_DELETE_APPROVAL_TOOL_NAME, { agentId: OWN_WORKSPACE })]);
  const error = await own.controller.deleteWorkspace(CALLER, SESSION, 'credential', OWN_WORKSPACE).catch((e: unknown) => e);
  assert.equal(codeOf(error), WORKSPACE_DELETE_SELF);
  assert.deepEqual(own.seen.removedWorkspaces, []);

  const unasked = doors([yes(RUNNER_DELETE_APPROVAL_TOOL_NAME, { runnerId: LOADTEST })]);
  const refused = await unasked.controller.deleteWorkspace(CALLER, SESSION, 'credential', LOADTEST).catch((e: unknown) => e);
  assert.equal(codeOf(refused), DELETE_APPROVAL_REQUIRED, 'a runner card does not delete a workspace');
  assert.deepEqual(unasked.seen.removedWorkspaces, []);

  const asked = doors([yes(WORKSPACE_DELETE_APPROVAL_TOOL_NAME, { agentId: uuidToBase62(LOADTEST) })]);
  const answer = await asked.controller.deleteWorkspace(CALLER, SESSION, 'credential', LOADTEST);
  assert.deepEqual(asked.seen.removedWorkspaces, [[OWNER, LOADTEST]]);
  assert.deepEqual(asked.seen.published, [[SESSION, LOADTEST, true]]);
  assert.deepEqual(answer, {
    ok: true,
    deleted: { agentId: LOADTEST, name: 'c2b-loadtest', workDir: null, runner: { id: RENTED, name: 'instance-20261027-071926', displayName: null } },
  });
});

// ── the card, as the approvals route files it ─────────────────────────────────────────────────

/** RunnerApiController's approvals route over the same rows, on a Codex session whose workspace allows `rules`. */
function asking(rules: Array<{ toolName: string; ruleContent: string }> = []) {
  const { prisma: rows } = world();
  const created: Array<Record<string, unknown>> = [];
  const published: unknown[] = [];
  const prisma = {
    ...(rows as unknown as Record<string, unknown>),
    session: {
      findUnique: async () => ({
        id: SESSION, assignedRunnerId: OWN_RUNNER, ownerId: OWNER, provider: 'codex', providerBuiltin: true, workspaceId: OWN_WORKSPACE,
      }),
    },
    approval: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'approval-1', status: data.status ?? 'PENDING', ...data };
      },
    },
    workspacePermissionRule: { findMany: async () => rules },
    user: { findUnique: async () => ({ role: 'ADMIN' }) },
    modelProvider: { findFirst: async () => ({ runtime: AgentProvider.CODEX }) },
    conversationTurn: { findFirst: async () => null },
  } as never;
  const realtime = { publish: (_id: string, event: unknown) => void published.push(event) } as never;
  const push = { notifyApprovalRequest: async () => undefined } as never;
  const controller = new RunnerApiController(prisma, {} as never, realtime, push, {} as never, {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);
  return { controller, created, published };
}

test('a runner delete card says what the server reads, and no standing rule answers it', async () => {
  // A rule that would answer any other tool of this name: the workspace's "always allow".
  const { controller, created, published } = asking([{ toolName: RUNNER_DELETE_APPROVAL_TOOL_NAME, ruleContent: '' }]);
  const filed = await controller.createApproval({ id: OWN_RUNNER }, SESSION, {
    toolName: RUNNER_DELETE_APPROVAL_TOOL_NAME,
    // The caller's own words about it are not what the owner reads.
    input: { runnerId: uuidToBase62(RENTED), name: 'a harmless scratch box', workspaces: [] },
  } as never);
  assert.equal(filed.status, 'PENDING', 'asked, not answered by the rule');
  assert.equal(created.length, 1);
  assert.equal(created[0].status, undefined);
  assert.deepEqual(created[0].input, {
    runnerId: RENTED,
    name: 'instance-20261027-071926',
    displayName: null,
    online: false,
    lastHeartbeatAt: HOURS_AGO.toISOString(),
    workspaces: [{ id: LOADTEST, name: 'c2b-loadtest', workDir: null }],
  });
  assert.equal(published.length, 1, 'the card is put in front of the owner');
});

test('a card about a runner nobody could delete from here is never filed', async () => {
  for (const [what, runnerId, expected] of [
    ['the asking session\'s own machine', OWN_RUNNER, ConflictException],
    ['another account\'s machine', THEIRS, NotFoundException],
    ['a managed runner', MANAGED, ConflictException],
    ['no id at all', undefined, NotFoundException],
  ] as const) {
    const { controller, created, published } = asking();
    await assert.rejects(
      controller.createApproval({ id: OWN_RUNNER }, SESSION, { toolName: RUNNER_DELETE_APPROVAL_TOOL_NAME, input: { runnerId } } as never),
      expected,
      what,
    );
    assert.deepEqual([created, published], [[], []], what);
  }
});

test("a workspace delete card names the workspace's runner and folder, and never the asking session's own", async () => {
  const { controller, created } = asking();
  await controller.createApproval({ id: OWN_RUNNER }, SESSION, {
    toolName: WORKSPACE_DELETE_APPROVAL_TOOL_NAME,
    input: { agentId: LOADTEST },
  } as never);
  assert.deepEqual(created[0].input, {
    agentId: LOADTEST, name: 'c2b-loadtest', workDir: null, runner: { id: RENTED, name: 'instance-20261027-071926', displayName: null },
  });
  const own = asking();
  await assert.rejects(
    own.controller.createApproval({ id: OWN_RUNNER }, SESSION, { toolName: WORKSPACE_DELETE_APPROVAL_TOOL_NAME, input: { agentId: OWN_WORKSPACE } } as never),
    ConflictException,
  );
  assert.deepEqual(own.created, []);
});

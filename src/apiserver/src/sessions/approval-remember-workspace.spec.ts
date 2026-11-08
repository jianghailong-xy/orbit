import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reachesPastOneMcpTool } from './remember-rules';
import { SessionsService } from './sessions.service';

// "Always allow" has to outlive the session it was answered in, or it is re-taught once per
// session — which in a product built on many parallel sessions over one checkout means the
// cost of teaching trust scales with the thing the product is for. These cover the write side:
// which decisions become a standing workspace grant, and which deliberately do not.

type Row = { workspaceId: string | null };
type Created = { data: unknown[]; skipDuplicates?: boolean };

function makeService(session: Row | null, opts: { landed?: boolean } = {}) {
  const created: Created[] = [];
  const prisma = {
    session: { findFirst: async () => (session ? { id: 's1', ...session } : null) },
    approval: {
      // count 0 = the approval was already decided, so this click lost the race.
      updateMany: async () => ({ count: opts.landed === false ? 0 : 1 }),
      findFirst: async () => ({
        id: 'a1',
        sessionId: 's1',
        toolName: 'Bash',
        input: {},
        toolUseId: null,
        status: 'ALLOWED',
        message: null,
        createdAt: new Date(),
        decidedAt: new Date(),
      }),
    },
    workspacePermissionRule: {
      createMany: async (args: Created) => {
        created.push(args);
        return { count: (args.data as unknown[]).length };
      },
    },
  } as never;
  // decideApproval runs its write in a retried transaction: this fake has no other client to hand it.
  (prisma as { $transaction: unknown }).$transaction = async (fn: (tx: unknown) => unknown) => fn(prisma);
  const realtime = { publish: () => {} } as never;
  return { service: new SessionsService(prisma, {} as never, realtime), created };
}

test('an "always allow" answer becomes a standing grant on the session\'s workspace', async () => {
  const { service, created } = makeService({ workspaceId: 'w1' });

  await service.decideApproval('owner-1', 's1', 'a1', {
    behavior: 'allow',
    rememberRules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Edit' }],
  });

  assert.equal(created.length, 1);
  assert.deepEqual(created[0].data, [
    {
      workspaceId: 'w1',
      toolName: 'Bash',
      ruleContent: 'npm test:*',
      createdById: 'owner-1',
      approvalId: 'a1',
    },
    {
      workspaceId: 'w1',
      toolName: 'Edit',
      ruleContent: '',
      createdById: 'owner-1',
      approvalId: 'a1',
    },
  ]);
  // Re-approving something already granted must be a no-op, not a second row.
  assert.equal(created[0].skipDuplicates, true);
});

test('a plain allow grants nothing standing — only the "always" answer does', async () => {
  const { service, created } = makeService({ workspaceId: 'w1' });
  await service.decideApproval('owner-1', 's1', 'a1', { behavior: 'allow' });
  assert.deepEqual(created, []);
});

test('a deny never writes a grant, whatever rules ride along with it', async () => {
  const { service, created } = makeService({ workspaceId: 'w1' });
  await service.decideApproval('owner-1', 's1', 'a1', {
    behavior: 'deny',
    rememberRules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
  });
  assert.deepEqual(created, []);
});

test('a losing click on an already-decided approval widens nothing', async () => {
  const { service, created } = makeService({ workspaceId: 'w1' }, { landed: false });
  await service.decideApproval('owner-1', 's1', 'a1', {
    behavior: 'allow',
    rememberRules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
  });
  assert.deepEqual(created, []);
});

test('a session with no workspace has nothing to grant on, and still decides fine', async () => {
  const { service, created } = makeService({ workspaceId: null });
  const info = await service.decideApproval('owner-1', 's1', 'a1', {
    behavior: 'allow',
    rememberRules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
  });
  assert.equal(info.status, 'ALLOWED');
  assert.deepEqual(created, []);
});

test('a rule that would forge a second grant is not stored', async () => {
  const { service, created } = makeService({ workspaceId: 'w1' });
  await service.decideApproval('owner-1', 's1', 'a1', {
    behavior: 'allow',
    rememberRules: [{ toolName: 'Bash', ruleContent: 'npm test:*),Bash(rm -rf /:*' }],
  });
  assert.deepEqual(created, []);
});

test('an "always allow" on one MCP tool remembers that tool', async () => {
  const { service, created } = makeService({ workspaceId: 'w1' });
  await service.decideApproval('owner-1', 's1', 'a1', {
    behavior: 'allow',
    rememberRules: [{ toolName: 'mcp__orbit__bg_list' }],
  });
  assert.deepEqual(created[0].data, [
    {
      workspaceId: 'w1',
      toolName: 'mcp__orbit__bg_list',
      ruleContent: '',
      createdById: 'owner-1',
      approvalId: 'a1',
    },
  ]);
});

test('an "always allow" stores nothing that reaches past one MCP tool, and still allows', async () => {
  for (const toolName of ['mcp__orbit', 'mcp__orbit__*', 'mcp__*']) {
    const { service, created } = makeService({ workspaceId: 'w1' });
    const info = await service.decideApproval('owner-1', 's1', 'a1', {
      behavior: 'allow',
      rememberRules: [{ toolName }],
    });
    assert.equal(info.status, 'ALLOWED', toolName);
    assert.deepEqual(created, [], toolName);
  }
});

test('a rule that reaches past one MCP tool does not take the rest of the answer with it', async () => {
  const { service, created } = makeService({ workspaceId: 'w1' });
  await service.decideApproval('owner-1', 's1', 'a1', {
    behavior: 'allow',
    rememberRules: [{ toolName: 'mcp__orbit' }, { toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Edit' }],
  });
  assert.deepEqual(
    (created[0].data as { toolName: string }[]).map((rule) => rule.toolName),
    ['Bash', 'Edit'],
  );
});

test('what counts as reaching past one MCP tool', () => {
  for (const name of ['mcp__orbit', 'mcp__orbit__', 'mcp__orbit__*', 'mcp__orbit__bg*', 'mcp__*', 'mcp__*__bg_run']) {
    assert.equal(reachesPastOneMcpTool(name), true, name);
  }
  for (const name of ['mcp__orbit__bg_run', 'mcp__a__b__c', 'mcp__acme__dotted.tool', 'Bash', 'Edit', 'orbit_task_create', 'mcp', 'mcpish', 'mcp_x']) {
    assert.equal(reachesPastOneMcpTool(name), false, name);
  }
});

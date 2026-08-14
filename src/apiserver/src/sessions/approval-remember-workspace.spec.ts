import assert from 'node:assert/strict';
import { test } from 'node:test';
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

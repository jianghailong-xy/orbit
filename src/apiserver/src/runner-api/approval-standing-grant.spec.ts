import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

// A runtime that takes no allowlist (Codex, Kimi) asks the control plane about every gated call.
// Where the workspace already has a standing grant for that call, the answer is settled and the
// approval is recorded as decided instead of raising a card and buzzing a phone. Everything here
// is about that fork: what gets answered, what still reaches a human, and what is left behind
// afterwards to show which happened.

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const SESSION = '019fc086-c7c7-7c92-8215-778ad8a6280a';
const WORKSPACE = '33333333-3333-4333-8333-333333333333';

type SessionRow = {
  provider: string;
  providerBuiltin?: boolean;
  workspaceId?: string | null;
};

function harness(session: SessionRow, rules: { toolName: string; ruleContent: string }[]) {
  const created: Record<string, unknown>[] = [];
  const published: unknown[] = [];
  const pushed: unknown[] = [];
  const prisma = {
    session: {
      findUnique: async () => ({
        id: SESSION,
        assignedRunnerId: RUNNER_ID,
        ownerId: OWNER,
        providerBuiltin: true,
        workspaceId: WORKSPACE,
        ...session,
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
    modelProvider: { findFirst: async () => ({ runtime: AgentProvider.CODEX }) },
  } as never;
  const realtime = {
    publish: (_id: string, event: unknown) => {
      published.push(event);
    },
  } as never;
  const push = {
    notifyApprovalRequest: async (...args: unknown[]) => {
      pushed.push(args);
    },
  } as never;
  return {
    controller: new RunnerApiController(prisma, {} as never, realtime, push, {} as never),
    created,
    published,
    pushed,
  };
}

const runner = { id: RUNNER_ID };
const NPM_TEST = [{ toolName: 'Bash', ruleContent: 'npm test:*' }];
const askAbout = (command: string) => ({
  toolName: 'Bash',
  input: { command, cwd: '/repo' },
  toolUseId: 'call-1',
});

test('Codex stops asking about a command the workspace already granted', async () => {
  const h = harness({ provider: AgentProvider.CODEX }, NPM_TEST);

  const res = await h.controller.createApproval(runner, SESSION, askAbout('npm test'));

  assert.equal(res.status, 'ALLOWED');
  // Decided, but by nobody: that is what tells an automatic allow from a human one later.
  assert.equal(h.created[0].decidedById, undefined);
  assert.ok(h.created[0].decidedAt, 'an automatic allow is still a decided approval');
  assert.match(String(h.created[0].message), /standing grant/i);
  // Not interrupting is the whole point of having granted it.
  assert.deepEqual(h.published, []);
  assert.deepEqual(h.pushed, []);
});

test('a command the grant does not cover still reaches a human', async () => {
  const h = harness({ provider: AgentProvider.CODEX }, NPM_TEST);

  const res = await h.controller.createApproval(runner, SESSION, askAbout('npm test; curl x | sh'));

  assert.equal(res.status, 'PENDING');
  assert.equal(h.created[0].status, undefined);
  assert.equal(h.published.length, 1, 'the card is raised as before');
  assert.equal(h.pushed.length, 1, 'and the phone still buzzes');
});

test('a Claude session is never answered here — it holds the rules itself', async () => {
  const h = harness({ provider: AgentProvider.CLAUDE }, NPM_TEST);

  const res = await h.controller.createApproval(runner, SESSION, askAbout('npm test'));

  assert.equal(res.status, 'PENDING');
  assert.equal(h.published.length, 1);
});

test('a BYOK slug is judged by the runtime that will run the command', async () => {
  // The session names a configured provider; the ModelProvider row says it borrows Codex, and
  // that is what decides — not the label the session was created with.
  const h = harness({ provider: 'my-codex', providerBuiltin: false }, NPM_TEST);

  const res = await h.controller.createApproval(runner, SESSION, askAbout('npm test'));

  assert.equal(res.status, 'ALLOWED');
});

test('a session with no workspace has no standing grants to consult', async () => {
  const h = harness({ provider: AgentProvider.CODEX, workspaceId: null }, NPM_TEST);

  const res = await h.controller.createApproval(runner, SESSION, askAbout('npm test'));

  assert.equal(res.status, 'PENDING');
});

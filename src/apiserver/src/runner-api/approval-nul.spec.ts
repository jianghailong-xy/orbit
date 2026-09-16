import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

// Postgres stores no U+0000 anywhere: a `text` or `jsonb` write carrying one fails the whole
// statement (22P05), and the runner retries a 5xx without a ceiling. When the statement that
// fails is `approval.create`, no card is ever raised and the agent waits forever for a decision
// nobody can be shown — which is what happened on 2026-09-15, every two minutes, until the
// approval table simply stopped gaining rows.
//
// The byte arrives the ordinary way: a tool argument quoting a file that has one, or an MCP
// caller writing the JSON escape for it, which is decoded into the real byte in transit. So the
// approval path strips it exactly as the event batch does — see strip-nul.

// Built, never written literally: a source file carrying a raw NUL is itself the hazard.
const NUL = String.fromCharCode(0);

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const SESSION = '019fc086-c7c7-7c92-8215-778ad8a6280a';
const WORKSPACE = '33333333-3333-4333-8333-333333333333';

function harness() {
  const created: Record<string, unknown>[] = [];
  const lookedUp: unknown[] = [];
  const published: { payload: { toolName: string; input: unknown } }[] = [];
  const prisma = {
    session: {
      findUnique: async () => ({
        id: SESSION,
        assignedRunnerId: RUNNER_ID,
        ownerId: OWNER,
        provider: AgentProvider.CLAUDE,
        providerBuiltin: true,
        workspaceId: WORKSPACE,
      }),
    },
    approval: {
      findUnique: async ({ where }: { where: unknown }) => {
        lookedUp.push(where);
        return null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'approval-1', status: data.status ?? 'PENDING', ...data };
      },
    },
    // A Claude session holds its own allowlist, so this fork is never consulted here.
    workspacePermissionRule: { findMany: async () => [] },
    modelProvider: { findFirst: async () => null },
    conversationTurn: { findFirst: async () => null },
  } as never;
  const realtime = {
    publish: (_id: string, event: { payload: { toolName: string; input: unknown } }) => {
      published.push(event);
    },
  } as never;
  const push = { notifyApprovalRequest: async () => {} } as never;
  return {
    controller: new RunnerApiController(
      prisma,
      {} as never,
      realtime,
      push,
      {} as never,
      {} as never,
      { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
    ),
    created,
    lookedUp,
    published,
  };
}

const runner = { id: RUNNER_ID };

/** Every string reachable in `value`, so an assertion covers the nesting too. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

test('a tool call carrying NUL is written without it', async () => {
  const h = harness();

  await h.controller.createApproval(runner, SESSION, {
    toolName: `Ba${NUL}sh`,
    input: {
      command: `cat build${NUL}/app.bin`,
      // Nested, because an argument is whatever the workspace typed into it — the byte is as
      // likely to be three levels down a tool's JSON as it is at the top.
      env: { PATH: `/usr${NUL}/bin` },
      files: [`a${NUL}.txt`, 'b.txt'],
    },
    toolUseId: `call${NUL}-1`,
  });

  assert.equal(h.created.length, 1, 'the approval is still created, not refused');
  const row = h.created[0];
  assert.equal(row.toolName, 'Bash');
  assert.deepEqual(row.input, {
    command: 'cat build/app.bin',
    env: { PATH: '/usr/bin' },
    files: ['a.txt', 'b.txt'],
  });
  // The one that matters: nothing Postgres would refuse survives anywhere in the row.
  for (const s of strings(row)) {
    assert.ok(!s.includes(NUL), `a NUL reached the database in ${JSON.stringify(s)}`);
  }
});

test('the idempotency key is stripped before the lookup, not only before the insert', async () => {
  const h = harness();

  await h.controller.createApproval(runner, SESSION, {
    toolName: 'Bash',
    input: { command: 'ls' },
    toolUseId: `call${NUL}-1`,
  });

  // A retry of the same call has to find the row the first one created. Looking up the raw key
  // while storing the stripped one would miss it and try to insert a second row — which the
  // (sessionId, toolUseId) unique index then refuses, turning the retry into a 500 of its own.
  assert.equal(h.lookedUp.length, 1);
  assert.deepEqual(h.lookedUp[0], {
    sessionId_toolUseId: { sessionId: SESSION, toolUseId: 'call-1' },
  });
  assert.equal(h.created[0].toolUseId, 'call-1');
});

test('the card the human is shown carries the cleaned text', async () => {
  const h = harness();

  await h.controller.createApproval(runner, SESSION, {
    toolName: `Ba${NUL}sh`,
    input: { command: `echo ${NUL}hi` },
    toolUseId: 'call-1',
  });

  assert.equal(h.published.length, 1);
  assert.equal(h.published[0].payload.toolName, 'Bash');
  assert.deepEqual(h.published[0].payload.input, { command: 'echo hi' });
});

test('a call with nothing to strip is passed through untouched', async () => {
  const h = harness();
  const input = { command: 'npm test', cwd: '/repo' };

  await h.controller.createApproval(runner, SESSION, {
    toolName: 'Bash',
    input,
    toolUseId: 'call-1',
  });

  assert.equal(h.created[0].toolName, 'Bash');
  // Same object, not a copy: the common case must not rewrite the payload.
  assert.equal(h.created[0].input, input);
});

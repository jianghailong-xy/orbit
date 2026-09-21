import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

// What a single task create's card is stored with.
//
// The batch card has led with the server's preview of the write since it was written — how many
// runs start within the minute, how many wait, how many nothing will trigger — and one task is a
// batch of one. Attached here rather than in the runner so it lands with the server instead of
// waiting on a workspace binary's own release, which is what would leave every installed runner
// asking the old question.
//
// Everything below is about the two properties that make it safe to do inside a write: the card
// still gets filed when the preview cannot be read, and nothing else's card is touched.

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const SESSION = '019fc086-c7c7-7c92-8215-778ad8a6280a';
const WORKSPACE = '33333333-3333-4333-8333-333333333333';

const PREVIEW = { taskCount: 1, startingNow: 1, lists: [{ id: 'l1', title: 'Backlog' }] };

/** The controller plus the fake preview service, recording what the card was stored with. */
function harness(previewCreateMany: (ownerId: string, dto: unknown) => Promise<unknown>) {
  const created: Record<string, unknown>[] = [];
  const previewCalls: { ownerId: string; dto: unknown }[] = [];
  const prisma = {
    session: {
      findUnique: async () => ({
        id: SESSION,
        assignedRunnerId: RUNNER_ID,
        ownerId: OWNER,
        providerBuiltin: true,
        workspaceId: WORKSPACE,
        provider: AgentProvider.CLAUDE,
      }),
    },
    approval: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'approval-1', status: 'PENDING', ...data };
      },
    },
    workspacePermissionRule: { findMany: async () => [] },
    modelProvider: { findFirst: async () => ({ runtime: AgentProvider.CLAUDE }) },
    conversationTurn: { findFirst: async () => null },
  } as never;
  const tasks = {
    previewCreateMany: async (ownerId: string, dto: unknown) => {
      previewCalls.push({ ownerId, dto });
      return previewCreateMany(ownerId, dto);
    },
  } as never;
  const controller = new RunnerApiController(
    prisma, {} as never, { publish: () => {} } as never, { notifyApprovalRequest: async () => {} } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
    // Positions above are the optional services this case does not exercise; `tasks` is the tenth.
    tasks,
  );
  return { controller, created, previewCalls };
}

const createTask = (input: Record<string, unknown>) => ({
  toolName: 'orbit_task_create',
  input: { title: 'Fix login redirect', completionCriterion: 'EXECUTABLE', ...input },
  toolUseId: 'call-1',
});

test('a single task create carries the server’s preview of what it would do', async () => {
  const h = harness(async () => PREVIEW);

  await h.controller.createApproval({ id: RUNNER_ID }, SESSION, createTask({ description: 'why' }));

  // Asked as a batch of one, on the same function the batch card's own preview comes from — so the
  // two cards cannot come to disagree about what "starts running within the minute" means.
  assert.equal(h.previewCalls.length, 1);
  assert.equal(h.previewCalls[0].ownerId, OWNER);
  assert.deepEqual(h.previewCalls[0].dto, {
    tasks: [{ title: 'Fix login redirect', completionCriterion: 'EXECUTABLE', description: 'why' }],
  });
  const input = h.created[0].input as Record<string, unknown>;
  assert.deepEqual(input.preview, PREVIEW);
  // The rest of the input is the runner's, untouched: the card is the same body plus a reading.
  assert.equal(input.title, 'Fix login redirect');
  assert.equal(input.completionCriterion, 'EXECUTABLE');
});

test('a preview that cannot be read costs the card its pill, never the question', async () => {
  const h = harness(async () => {
    throw new Error('preview exploded');
  });

  const res = await h.controller.createApproval({ id: RUNNER_ID }, SESSION, createTask({}));

  // Filed and pending: an agent waiting on a card nobody was shown is the failure the whole path
  // exists to prevent, so a failed read must not become a failed ask.
  assert.equal(res.status, 'PENDING');
  assert.equal(h.created.length, 1);
  assert.equal((h.created[0].input as Record<string, unknown>).preview, undefined);
  assert.equal((h.created[0].input as Record<string, unknown>).title, 'Fix login redirect');
});

test('a card the preview would refuse is still raised', async () => {
  // The preview re-checks the write's own preconditions, and this is the case that decides the
  // try/catch: a body it refuses is one the write refuses too, and the refusal belongs to the
  // write's own answer (with its requiredAction), not to a card that never got drawn.
  const h = harness(async () => {
    throw new Error('CROSS_PROJECT_APPROVAL_REQUIRED');
  });

  const res = await h.controller.createApproval({ id: RUNNER_ID }, SESSION, createTask({ projectId: 'p1' }));

  assert.equal(res.status, 'PENDING');
  const input = h.created[0].input as Record<string, unknown>;
  assert.equal(input.preview, undefined);
  // The body is stored whole: the refusal, with its own requiredAction, is the write's answer to
  // give, not something this read may swallow.
  assert.equal(input.projectId, 'p1');
});

test('every other card is stored exactly as the runner sent it', async () => {
  const h = harness(async () => PREVIEW);

  await h.controller.createApproval({ id: RUNNER_ID }, SESSION, {
    toolName: 'orbit_project_create',
    input: { title: 'Checkout rewrite', goal: 'one page' },
    toolUseId: 'call-2',
  });

  assert.deepEqual(h.previewCalls, [], 'a project create has no dispatch to preview');
  assert.deepEqual(h.created[0].input, { title: 'Checkout rewrite', goal: 'one page' });
});

test('a controller built without a tasks service files the card unchanged', async () => {
  // The ~40 specs that construct this controller by hand and the deployments mid-upgrade: a card
  // without a preview is the state every client already handles.
  const created: Record<string, unknown>[] = [];
  const prisma = {
    session: {
      findUnique: async () => ({
        id: SESSION, assignedRunnerId: RUNNER_ID, ownerId: OWNER,
        providerBuiltin: true, workspaceId: WORKSPACE, provider: AgentProvider.CLAUDE,
      }),
    },
    approval: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'approval-1', status: 'PENDING', ...data };
      },
    },
    workspacePermissionRule: { findMany: async () => [] },
    modelProvider: { findFirst: async () => ({ runtime: AgentProvider.CLAUDE }) },
    conversationTurn: { findFirst: async () => null },
  } as never;
  const controller = new RunnerApiController(
    prisma, {} as never, { publish: () => {} } as never, { notifyApprovalRequest: async () => {} } as never,
    {} as never, {} as never,
  );

  const res = await controller.createApproval({ id: RUNNER_ID }, SESSION, createTask({}));

  assert.equal(res.status, 'PENDING');
  assert.equal((created[0].input as Record<string, unknown>).preview, undefined);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, uuidToBase62 } from '@orbit/shared';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  TASK_CRITERION_SHAPE_ADVICE_CODE,
  taskCriterionShapeAdvice,
  taskCriterionShapeAdviceBody,
} from '../tasks/task-criterion-shape-advice';
import { RunnerApiController } from './runner-api.controller';

// What a single task create's card is stored with.
//
// The batch card has led with the server's preview of the write since it was written — how many
// runs start within the minute, how many wait, how many nothing will trigger — and one task is a
// batch of one. Attached here rather than in the runner so it lands with the server instead of
// waiting on a workspace binary's own release, which is what would leave every installed runner
// asking the old question.
//
// Everything below is about the properties that make it safe to do inside a write: the preview
// reads the ids the runner actually sends, the card still gets filed when the preview cannot be
// read, nothing else's card is touched — and the one refusal that must NOT be filed over, because
// the answer to it is the caller's and a person's press cannot give it.

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const SESSION = '019fc086-c7c7-7c92-8215-778ad8a6280a';
const WORKSPACE = '33333333-3333-4333-8333-333333333333';
/** What a public id decodes TO: the runner sends the base62 spelling, and the preview must read it. */
const ASSIGNEE = '44444444-4444-4444-8444-444444444444';
const PREREQUISITE = '55555555-5555-4555-8555-555555555555';

const PREVIEW = { taskCount: 1, startingNow: 1, lists: [{ id: 'l1', title: 'Backlog' }] };

/** The controller plus the fake preview service, recording what the card was stored with. */
function harness(previewCreateMany: (ownerId: string, dto: unknown) => Promise<unknown>) {
  const created: Record<string, unknown>[] = [];
  const previewCalls: { ownerId: string; dto: unknown }[] = [];
  const published: unknown[] = [];
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
    prisma, {} as never, { publish: (sessionId: string, event: unknown) => published.push({ sessionId, event }) } as never,
    { notifyApprovalRequest: async () => {} } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
    // Positions above are the optional services this case does not exercise; `tasks` is the tenth.
    tasks,
  );
  return { controller, created, previewCalls, published };
}

/**
 * The item the preview was handed, as the body it came from. It is a DTO instance, and one carries
 * every field its class declares — the absent ones as `undefined`, which is how the service reads
 * them anyway — so the comparison is against the fields the runner actually sent.
 */
function previewedItem(call: { dto: unknown }): Record<string, unknown> {
  const { tasks } = call.dto as { tasks: Array<Record<string, unknown>> };
  assert.equal(tasks.length, 1);
  return Object.fromEntries(
    Object.entries(tasks[0]).filter(([, value]) => value !== undefined),
  );
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
  assert.deepEqual(previewedItem(h.previewCalls[0]), {
    title: 'Fix login redirect', completionCriterion: 'EXECUTABLE', description: 'why',
  });
  const input = h.created[0].input as Record<string, unknown>;
  assert.deepEqual(input.preview, PREVIEW);
  // The rest of the input is the runner's, untouched: the card is the same body plus a reading.
  assert.equal(input.title, 'Fix login redirect');
  assert.equal(input.completionCriterion, 'EXECUTABLE');
});

test('the preview reads the ids the runner sends, and the card keeps the spelling it sent', async () => {
  const h = harness(async () => PREVIEW);
  const assigneeId = uuidToBase62(ASSIGNEE);
  const dependsOnTaskIds = [uuidToBase62(PREREQUISITE)];

  await h.controller.createApproval(
    { id: RUNNER_ID }, SESSION, createTask({ assigneeId, dependsOnTaskIds }),
  );

  // What reaches the service is what the WRITE would use. The HTTP door is what normally decodes a
  // public id, on the way in through the DTO, and this call does not pass through it: the DTO is
  // applied here instead. Before that, every id arrived as base62 and the preview died on its first
  // query — `invalid input syntax for type uuid` — so the card was filed without a preview for
  // every create that named an assignee, which is nearly all of them.
  assert.deepEqual(previewedItem(h.previewCalls[0]), {
    title: 'Fix login redirect',
    completionCriterion: 'EXECUTABLE',
    assigneeId: ASSIGNEE,
    dependsOnTaskIds: [PREREQUISITE],
  });
  // And what is STORED is the runner's own body, id spelling included: the card renders the same
  // input it always did, plus the reading.
  const input = h.created[0].input as Record<string, unknown>;
  assert.equal(input.assigneeId, assigneeId);
  assert.deepEqual(input.dependsOnTaskIds, dependsOnTaskIds);
  assert.deepEqual(input.preview, PREVIEW);
});

test('a create whose declaration the write would refuse is refused here, and no card is raised', async () => {
  // The shape advice is a question put to the CALLER — use the suggested criterion, or record why
  // this task keeps the one it declares — and only the model can answer it. Raised as a card it asks
  // a person to approve a write that is then refused, and costs them a second press once the model
  // has answered; the runner's transport hands a tool error straight back to the model instead.
  const advice = taskCriterionShapeAdvice({
    acceptanceCriteria: 'typecheck passes',
    completionCriterion: 'EVIDENCE_JUDGMENT',
    inProject: false,
  });
  assert.ok(advice, 'the fixture has to be a body the write itself refuses');
  const body = taskCriterionShapeAdviceBody(advice);
  const h = harness(async () => {
    throw new ConflictException(body);
  });

  await assert.rejects(
    () => h.controller.createApproval({ id: RUNNER_ID }, SESSION, createTask({
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: 'typecheck passes',
    })),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      const answered = error.getResponse() as Record<string, unknown>;
      assert.equal(answered.code, TASK_CRITERION_SHAPE_ADVICE_CODE);
      // Byte for byte the write's own body: the code, the suggestion and the requiredAction the
      // model has to act on, none of it restated by this door.
      assert.deepEqual(error.getResponse(), body);
      return true;
    },
  );
  // Nothing was filed and nothing was announced: no row for the conversation's list to count, no
  // card on it, no phone buzzed.
  assert.deepEqual(h.created, []);
  assert.deepEqual(h.published, []);
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

test('a structured refusal that is not the caller’s question still files the card', async () => {
  // The rethrow is one code wide on purpose, and this is the direction it must not grow in: a
  // refusal with a code of its own is one the write gives its own answer to, and the card is where
  // that answer belongs.
  const h = harness(async () => {
    throw new BadRequestException({
      code: 'CROSS_PROJECT_APPROVAL_REQUIRED',
      kind: 'REFUSAL',
      requiredAction: 'ASK_FOR_THE_CROSSING',
      message: 'this write crosses into another project',
    });
  });

  const res = await h.controller.createApproval({ id: RUNNER_ID }, SESSION, createTask({}));

  assert.equal(res.status, 'PENDING');
  assert.equal(h.created.length, 1);
  assert.equal((h.created[0].input as Record<string, unknown>).preview, undefined);
});

test('the batch door’s refusal of `verification` still files the card', async () => {
  // The preview runs the BATCH door's validation over a SINGLE door's body, and the two are not the
  // same door: carrying `verification` is legal on the one this card is for, and the batch door
  // refuses it by construction. Rethrowing what it says there would refuse a create the write
  // accepts — which is the whole reason the list above holds one code and not a family of them.
  const h = harness(async () => {
    throw new BadRequestException(
      'tasks[0]: verification is the single-door spelling of a paired subject',
    );
  });

  const res = await h.controller.createApproval({ id: RUNNER_ID }, SESSION, createTask({
    verification: { title: 'the check on it', assigneeId: uuidToBase62(WORKSPACE) },
  }));

  assert.equal(res.status, 'PENDING');
  assert.equal(h.created.length, 1);
  assert.equal((h.created[0].input as Record<string, unknown>).preview, undefined);
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

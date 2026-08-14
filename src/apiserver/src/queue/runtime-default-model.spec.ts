import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaimedSession } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from './queue.service';

function harness(
  sessionModel: string | null,
  options: {
    workspaceModel?: string | null;
    casWinnerModel?: string;
    usesRuntimeDefaultModel?: boolean;
  } = {},
) {
  const modelWrites: string[] = [];
  const materializeQueries: string[] = [];
  let winnerReads = 0;
  const session = {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: '22222222-2222-4222-8222-222222222222',
    provider: 'codex',
    providerBuiltin: true,
    model: sessionModel,
    usesRuntimeDefaultModel: options.usesRuntimeDefaultModel ?? true,
    numTurns: 0,
    title: 'runtime default test',
    prompt: 'hello',
    runtimeSessionId: null,
    inboxLeaseOwner: null,
    branch: null,
    mergeTarget: null,
    workspaceId: '33333333-3333-4333-8333-333333333333',
    taskId: null,
    assignedRunner: {
      runtimeDefaultModels: { codex: 'gpt-runtime-default' },
      modelCatalog: { codex: [{ value: 'gpt-catalog', label: 'Catalog' }] },
    },
    workspace: {
      provider: 'codex',
      model: options.workspaceModel ?? null,
      env: null,
      workDir: null,
      autoInitGit: false,
      defaultMergeTarget: null,
      enableOrchestration: false,
      appendSystemPrompt: null,
      systemPrompt: null,
      allowedTools: [],
      disallowedTools: [],
      permissionMode: 'dontAsk',
      effort: null,
      maxTurns: null,
      maxBudgetUsd: null,
      mcpConfig: null,
    },
  };
  const tx = {
    $queryRaw: async () => [],
    conversationTurn: { findUnique: async () => ({ id: 'seed-turn' }) },
  };
  const prisma = {
    session: {
      findUniqueOrThrow: async (args?: { select?: { model?: boolean } }) => {
        if (args?.select?.model) {
          winnerReads++;
          return { model: options.casWinnerModel ?? session.model };
        }
        return session;
      },
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      materializeQueries.push(strings.join('?'));
      assert.equal(values[1], session.id);
      modelWrites.push(values[0] as string);
      return options.casWinnerModel === undefined ? 1 : 0;
    },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    runEvent: { aggregate: async () => ({ _max: { seq: null } }) },
    user: { findUnique: async () => null },
  } as unknown as PrismaService;
  return {
    queue: new QueueService(prisma),
    modelWrites,
    materializeQueries,
    winnerReads: () => winnerReads,
  };
}

async function build(queue: QueueService): Promise<ClaimedSession> {
  return (
    queue as unknown as { buildSession(id: string): Promise<ClaimedSession> }
  ).buildSession('11111111-1111-4111-8111-111111111111');
}

test('first claim uses the runner runtime default and materializes it on the session', async () => {
  const { queue, modelWrites, materializeQueries } = harness(null);
  const claimed = await build(queue);
  assert.equal(claimed.agent.model, 'gpt-runtime-default');
  assert.deepEqual(modelWrites, ['gpt-runtime-default']);
  // Compare-and-set against the exact value resolution ran on, so a concurrent PATCH wins.
  assert.match(materializeQueries[0], /"model" IS NOT DISTINCT FROM /);
});

test('a whitespace-only session model is also materialized on first claim', async () => {
  const { queue, modelWrites, materializeQueries } = harness('  \t ');
  const claimed = await build(queue);
  assert.equal(claimed.agent.model, 'gpt-runtime-default');
  assert.deepEqual(modelWrites, ['gpt-runtime-default']);
  assert.equal(materializeQueries.length, 1);
});

test('an explicit session model wins and is not rewritten during claim', async () => {
  const { queue, modelWrites } = harness('gpt-catalog');
  const claimed = await build(queue);
  assert.equal(claimed.agent.model, 'gpt-catalog');
  assert.deepEqual(modelWrites, []);
});

test('a session model the runtime retired is re-materialized to what it now runs', async () => {
  // The row still names last generation's model; the runner no longer offers it. Dispatch moves
  // to the current default AND rewrites the row, so the pickers stop showing a dead id.
  const { queue, modelWrites, materializeQueries } = harness('gpt-retired');
  const claimed = await build(queue);
  assert.equal(claimed.agent.model, 'gpt-runtime-default');
  assert.deepEqual(modelWrites, ['gpt-runtime-default']);
  assert.match(materializeQueries[0], /"model" IS NOT DISTINCT FROM /);
});

test('a legacy Workspace model is bridged once and materialized for rolling compatibility', async () => {
  const { queue, modelWrites } = harness(null, {
    workspaceModel: 'gpt-legacy-workspace',
    usesRuntimeDefaultModel: false,
  });
  const claimed = await build(queue);
  assert.equal(claimed.agent.model, 'gpt-legacy-workspace');
  assert.deepEqual(modelWrites, ['gpt-legacy-workspace']);
});

test('a concurrent Session model PATCH wins a failed materialization CAS', async () => {
  // The winner is a catalogued model: an id the runner does not offer would retire on re-resolve
  // like any other, which is a different test.
  const { queue, modelWrites, winnerReads } = harness(null, {
    casWinnerModel: 'gpt-catalog',
  });
  const claimed = await build(queue);
  assert.equal(claimed.agent.model, 'gpt-catalog');
  assert.deepEqual(modelWrites, ['gpt-runtime-default']);
  assert.equal(winnerReads(), 1);
});

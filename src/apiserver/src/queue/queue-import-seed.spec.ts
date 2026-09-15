import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaimedSession } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from './queue.service';

/**
 * How the claim treats a session that exists to import a Claude transcript.
 *
 * The import session is created PENDING with `importSourceCwd` set and `numTurns = 1`; its
 * conversation already exists, on the caller's disk, and the runner replays it as events inside
 * the claim. So the claim payload must (a) skip the lazy first-turn seed — there is no prompt to
 * seed, and an extra turn would hand the resumed engine an empty "user message" — and (b) carry
 * the marker itself, which is what makes the runner run the import step before the spawn, and
 * (c) answer `resume = true` anyway, via the `numTurns = 1` written at create, so the spawn is a
 * `--resume` that picks the conversation up.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNTIME_ID = '4e453ab7-f37c-494d-8017-bb4e9beffeef';

function harness(importSourceCwd: string | null) {
  const session = {
    id: SESSION_ID,
    ownerId: '22222222-2222-4222-8222-222222222222',
    provider: 'claude',
    providerBuiltin: true,
    model: 'claude-opus-5',
    usesRuntimeDefaultModel: false,
    numTurns: importSourceCwd === null ? 0 : 1,
    title: 'imported session',
    prompt: importSourceCwd === null ? 'hello' : '',
    runtimeSessionId: RUNTIME_ID,
    inboxLeaseOwner: null,
    importSourceCwd,
    branch: null,
    mergeTarget: null,
    effort: null,
    permissionMode: null,
    spawnDepth: 0,
    workspaceId: '33333333-3333-4333-8333-333333333333',
    taskId: null,
    assignedRunner: { runtimeDefaultModels: null, modelCatalog: null },
    workspace: {
      provider: 'claude',
      model: null,
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
      permissionRules: [],
    },
  };
  let seedLookups = 0;
  let transactions = 0;
  const tx = {
    $queryRaw: async () => [],
    conversationTurn: {
      findUnique: async () => {
        seedLookups += 1;
        return { id: 'seed-turn' };
      },
      findFirst: async () => null,
      count: async () => 0,
    },
  };
  const prisma = {
    session: { findUniqueOrThrow: async () => session },
    runEvent: {
      aggregate: async () => ({ _max: { seq: null } }),
      findFirst: async () => null,
    },
    modelProvider: { findFirst: async () => null },
    $transaction: async (fn: (client: typeof tx) => unknown) => {
      transactions += 1;
      return fn(tx);
    },
    attachment: { updateMany: async () => ({ count: 0 }) },
    user: { findUnique: async () => null },
  } as unknown as PrismaService;
  return {
    queue: new QueueService(prisma, { publishSessionUpdated() {} } as never),
    seedLookups: () => seedLookups,
    transactions: () => transactions,
  };
}

async function build(queue: QueueService): Promise<ClaimedSession> {
  return (queue as unknown as { buildSession(id: string): Promise<ClaimedSession> }).buildSession(SESSION_ID);
}

test('an import session seeds no opening turn and its claim carries the marker', async () => {
  const h = harness('/srv/work/project');
  const claimed = await build(h.queue);

  assert.equal(h.transactions(), 0, 'the seed transaction is skipped for an import session');
  assert.equal(h.seedLookups(), 0, 'and the seed turn is never looked up');
  assert.equal(claimed.importSourceCwd, '/srv/work/project');
  assert.equal(claimed.resume, true, 'the spawn resumes the conversation the transcript recorded');
  assert.equal(claimed.runtimeSessionId, RUNTIME_ID);
});

test('the same session without the marker still seeds its opening turn', async () => {
  // The paired positive: the skip is conditional on the marker, not on prompt/numTurns shape.
  const h = harness(null);
  const claimed = await build(h.queue);

  assert.equal(h.transactions(), 1, 'an ordinary session still runs the seed transaction');
  assert.equal(claimed.importSourceCwd, undefined);
});

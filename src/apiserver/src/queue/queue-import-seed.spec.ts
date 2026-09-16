import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaimedSession } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from './queue.service';

/**
 * How the claim treats a session that exists to import a Claude transcript.
 *
 * The import session is created PENDING with `importSourceCwd` set, `importedAt` recording that it
 * came in as an imported transcript, and `numTurns` an honest 0 — no turn has run, and none can
 * until the first message, because the import settles no turn and the claim it arrives on spawns
 * no engine. So the claim payload must (a) skip the lazy first-turn seed — there is no prompt to
 * seed, and an extra turn would hand the engine an empty "user message" — (b) carry the marker,
 * which is what makes the runner run the import step, and the `importOnly` that says the claim
 * ends with the import rather than warming an engine for it, and (c) answer `resume = true` off
 * the durable provenance, so the spawn is a `--resume` that picks the conversation up.
 *
 * The skip has to outlive the marker, which /import-result clears the moment the replay lands:
 * the claim a first message arrives on is the same session with the same absent prompt, and a
 * seed there would put an empty turn ahead of the person's own — at seq 1, which the message has
 * already taken.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNTIME_ID = '4e453ab7-f37c-494d-8017-bb4e9beffeef';

function harness(importSourceCwd: string | null, importedAt: Date | null) {
  const imported = importedAt !== null;
  const session = {
    id: SESSION_ID,
    ownerId: '22222222-2222-4222-8222-222222222222',
    provider: 'claude',
    providerBuiltin: true,
    model: 'claude-opus-5',
    usesRuntimeDefaultModel: false,
    numTurns: 0,
    title: 'imported session',
    prompt: imported ? '' : 'hello',
    runtimeSessionId: RUNTIME_ID,
    inboxLeaseOwner: null,
    importSourceCwd,
    importedAt,
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

test('an import session seeds no opening turn, and its claim carries the import and nothing else', async () => {
  const h = harness('/srv/work/project', new Date());
  const claimed = await build(h.queue);

  assert.equal(h.transactions(), 0, 'the seed transaction is skipped for an import session');
  assert.equal(h.seedLookups(), 0, 'and the seed turn is never looked up');
  assert.equal(claimed.importSourceCwd, '/srv/work/project');
  assert.equal(claimed.importOnly, true, 'the runner must settle this claim without spawning an engine');
  assert.equal(claimed.resume, true, 'the spawn resumes the conversation the transcript recorded');
  assert.equal(claimed.runtimeSessionId, RUNTIME_ID);
});

test('the claim a first message arrives on seeds nothing either, and does spawn', async () => {
  // The marker is gone — /import-result clears it — so the durable provenance is the only thing
  // left that knows this session has no opening prompt to lay down.
  const h = harness(null, new Date());
  const claimed = await build(h.queue);

  assert.equal(h.transactions(), 0, 'the seed transaction is skipped for a session that came in as an import');
  assert.equal(h.seedLookups(), 0, 'and the seed turn is never looked up');
  assert.equal(claimed.importSourceCwd, undefined);
  assert.equal(claimed.importOnly ?? false, false, 'this claim has a message behind it: the engine has to start');
  assert.equal(claimed.resume, true, 'and it resumes the transcript the import placed');
});

test('the same session without the provenance still seeds its opening turn', async () => {
  // The paired positive: the skip is conditional on the session having come in as an import, not
  // on the prompt/numTurns shape of an ordinary session that has simply not run yet.
  const h = harness(null, null);
  const claimed = await build(h.queue);

  assert.equal(h.transactions(), 1, 'an ordinary session still runs the seed transaction');
  assert.equal(claimed.importSourceCwd, undefined);
  assert.equal(claimed.importOnly ?? false, false);
});

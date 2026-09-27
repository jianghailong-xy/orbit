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
 * already taken. A transcript imported before `imported_at` existed is that same session with no
 * provenance at all to say so, which is why the absent prompt is the thing the seed is keyed on.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNTIME_ID = '4e453ab7-f37c-494d-8017-bb4e9beffeef';

/** A turn in the fake table, at the seq it took. */
type Turn = { id: string; seq: number; clientTurnId: string; content: string };

type HarnessOptions = {
  /**
   * The session's prompt and turn count, for a case that is not the ordinary session this
   * harness was written around. A transcript imported before `imported_at` existed is
   * `{ prompt: '', numTurns: 1 }`: `importSession` wrote the empty prompt it has always written
   * plus a fake `numTurns: 1` so the spawn would answer `--resume`, and the column that records
   * what such a row IS came later and never reached it.
   */
  shape?: { prompt: string; numTurns: number };
  /** Turns already written when the claim runs — the message that arrived first. */
  turns?: Array<{ clientTurnId: string; seq: number }>;
};

function harness(importSourceCwd: string | null, importedAt: Date | null, options: HarnessOptions = {}) {
  const imported = importedAt !== null;
  const session = {
    id: SESSION_ID,
    ownerId: '22222222-2222-4222-8222-222222222222',
    provider: 'claude',
    providerBuiltin: true,
    model: 'claude-opus-5',
    usesRuntimeDefaultModel: false,
    numTurns: options.shape?.numTurns ?? 0,
    title: 'imported session',
    prompt: options.shape?.prompt ?? (imported ? '' : 'hello'),
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
    owner: { preferences: {} },
    workspace: {
      provider: 'claude',
      model: null,
      env: null,
      workDir: null,
      autoInitGit: false,
      defaultMergeTarget: null,
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
  // The turns already in the table, and the ones the claim writes into it. The fake table enforces
  // @@unique([sessionId, seq]) the way Postgres does, so a second row at a seq already taken fails
  // the claim here exactly as it fails it in production.
  const turns: Turn[] = (options.turns ?? []).map((turn, i) => ({
    id: `turn-${i + 1}`,
    content: 'the message that arrived first',
    ...turn,
  }));
  const inserted: Turn[] = [];
  let seedLookups = 0;
  let transactions = 0;
  const tx = {
    $queryRaw: async () => [],
    conversationTurn: {
      findUnique: async (args: { where: { sessionId_clientTurnId: { clientTurnId: string } } }) => {
        seedLookups += 1;
        const { clientTurnId } = args.where.sessionId_clientTurnId;
        return turns.find((turn) => turn.clientTurnId === clientTurnId) ?? null;
      },
      findFirst: async () =>
        turns.length === 0 ? null : { seq: Math.max(...turns.map((turn) => turn.seq)) },
      create: async (args: { data: { seq: number; content: string; clientTurnId: string } }) => {
        if (turns.some((turn) => turn.seq === args.data.seq)) {
          throw Object.assign(
            new Error('Unique constraint failed on the fields: (`session_id`,`seq`)'),
            { code: 'P2002' },
          );
        }
        const row: Turn = { id: `turn-${turns.length + 1}`, ...args.data };
        turns.push(row);
        inserted.push(row);
        return { id: row.id };
      },
      count: async () => turns.length,
    },
    attachment: { updateMany: async () => ({ count: 0 }) },
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
    inserted: () => inserted,
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

test('a transcript imported before the provenance column existed seeds nothing either', async () => {
  // The rows the column never reached: `importSession` wrote `prompt: ''` and a fake
  // `numTurns: 1` so the spawn would resume, and `imported_at` did not exist yet to record what
  // the row is. The claim a first message arrives on is then the one that would seed — and seq 1
  // is exactly what the message took before it, so the seed dies on the unique key inside a claim
  // that has already flipped the session to RUNNING: no engine, a message nothing will answer, and
  // the runner's slot held by a session that cannot release it.
  const h = harness(null, null, {
    shape: { prompt: '', numTurns: 1 },
    turns: [{ clientTurnId: 'the-message-that-arrived-first', seq: 1 }],
  });
  const claimed = await build(h.queue);

  assert.equal(h.transactions(), 0, 'nothing to seed: this session has no opening prompt');
  assert.equal(h.seedLookups(), 0, 'and the seed turn is never looked up');
  assert.deepEqual(h.inserted(), [], 'and no turn is inserted, at seq 1 or at any other');
  assert.equal(claimed.resume, true, 'the transcript on disk is still what the spawn resumes');
  assert.equal(claimed.importOnly ?? false, false, 'and the engine does start: a message is behind this claim');
});

test('the seed takes the seq the table has not given out, rather than seq 1', async () => {
  // Not a shape a claim reaches in production — every path that inserts a turn lays the opening one
  // down first, under the same Session row lock — but the property is what makes that true rather
  // than lucky, and `seq: 1` was the one seq any producer of a conversation turn hardcoded. A seed
  // that assumes the number it wants is free fails the claim on the unique key whenever it is not.
  const h = harness(null, null, {
    shape: { prompt: 'hello', numTurns: 1 },
    turns: [{ clientTurnId: 'a-turn-that-got-there-first', seq: 1 }],
  });
  const claimed = await build(h.queue);

  assert.deepEqual(
    h.inserted().map((turn) => turn.seq),
    [2],
    'the opening turn goes after the one that is already there, not on top of it',
  );
  assert.equal(claimed.resume, true, 'and the claim still comes back with a session to spawn');
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

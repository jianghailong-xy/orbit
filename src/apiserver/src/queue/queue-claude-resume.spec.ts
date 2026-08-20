import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaimedSession } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from './queue.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNTIME_ID = '9d9aa83d-913b-4b6e-9016-db94b21e8671';
const SUPERSEDED_RUNTIME_ID = '00000000-0000-4000-8000-000000000000';

/**
 * `openedIds` are the runtime session ids the session's stored events carry, i.e. the
 * conversations Claude actually opened over this session's life.
 */
function harness(
  options: {
    numTurns?: number;
    runtimeSessionId?: string | null;
    openedIds?: string[];
    provider?: string;
  } = {},
) {
  const session = {
    id: SESSION_ID,
    ownerId: '22222222-2222-4222-8222-222222222222',
    provider: options.provider ?? 'claude',
    providerBuiltin: true,
    model: 'claude-opus-5',
    usesRuntimeDefaultModel: false,
    numTurns: options.numTurns ?? 0,
    title: 'resume decision',
    prompt: 'hello',
    runtimeSessionId: options.runtimeSessionId === undefined ? RUNTIME_ID : options.runtimeSessionId,
    inboxLeaseOwner: null,
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
  const opened = options.openedIds ?? [];
  const eventLookups: unknown[] = [];
  const sessionWrites: unknown[] = [];
  const tx = {
    $queryRaw: async () => [],
    conversationTurn: { findUnique: async () => ({ id: 'seed-turn' }),
      findFirst: async () => null,
      count: async () => 0,
    },
  };
  const prisma = {
    session: {
      findUniqueOrThrow: async () => session,
      update: async ({ data }: { data: unknown }) => {
        sessionWrites.push(data);
        return session;
      },
    },
    runEvent: {
      aggregate: async () => ({ _max: { seq: null } }),
      // Mirrors the JSON-path filter: only an event stamped with the id the runner is
      // about to be handed proves THAT conversation exists.
      findFirst: async (args: { where?: { payload?: { equals?: unknown } } }) => {
        eventLookups.push(args);
        const wanted = args?.where?.payload?.equals;
        return opened.includes(wanted as string) ? { id: 'event-1' } : null;
      },
    },
    modelProvider: { findFirst: async () => null },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    attachment: { updateMany: async () => ({ count: 0 }) },
    user: { findUnique: async () => null },
  } as unknown as PrismaService;
  return {
    queue: new QueueService(prisma),
    eventLookups,
    sessionWrites,
  };
}

async function build(queue: QueueService): Promise<ClaimedSession> {
  return (
    queue as unknown as { buildSession(id: string): Promise<ClaimedSession> }
  ).buildSession(SESSION_ID);
}

test('a session ended mid-turn resumes the conversation Claude already opened', async () => {
  // The wedge this guards: numTurns only advances on turn-complete, so a turn still running
  // when the session ended leaves it at 0. Dispatching that as a first spawn hands Claude a
  // --session-id it already opened, which it refuses ("Session ID ... is already in use") —
  // failing not just that run but every message sent afterwards.
  const { queue, sessionWrites } = harness({ numTurns: 0, openedIds: [RUNTIME_ID] });
  const claimed = await build(queue);
  assert.equal(claimed.resume, true);
  // The id is the conversation being resumed, so it must survive the claim untouched.
  assert.equal(claimed.runtimeSessionId, RUNTIME_ID);
  assert.deepEqual(sessionWrites, []);
});

test('a session whose runtime never started still does a first spawn', async () => {
  const { queue } = harness({ numTurns: 0, openedIds: [] });
  const claimed = await build(queue);
  assert.equal(claimed.resume, false);
  assert.equal(claimed.runtimeSessionId, RUNTIME_ID);
});

test('events from a superseded conversation do not make the new id resumable', async () => {
  // A row that was re-minted an id (numTurns reset with it) still carries the old
  // conversation's events. Resuming on those would fail with "No conversation found".
  const { queue } = harness({ numTurns: 0, openedIds: [SUPERSEDED_RUNTIME_ID] });
  const claimed = await build(queue);
  assert.equal(claimed.resume, false);
});

test('a settled turn resumes without looking events up', async () => {
  const { queue, eventLookups } = harness({ numTurns: 3, openedIds: [] });
  const claimed = await build(queue);
  assert.equal(claimed.resume, true);
  assert.deepEqual(eventLookups, []);
});

test('a Claude session with no id yet is minted one and dispatched as a first spawn', async () => {
  const { queue, sessionWrites, eventLookups } = harness({
    numTurns: 0,
    runtimeSessionId: null,
    openedIds: [RUNTIME_ID],
  });
  const claimed = await build(queue);
  assert.equal(claimed.resume, false);
  assert.notEqual(claimed.runtimeSessionId, RUNTIME_ID);
  assert.equal(sessionWrites.length, 1);
  // A freshly minted id has no conversation by construction — nothing to look up.
  assert.deepEqual(eventLookups, []);
});

test('a non-Claude runtime keeps reporting its own conversation', async () => {
  // Codex names its conversation itself and resumes by that id, so the Claude-only
  // first-spawn/--session-id collision does not apply — leave it on numTurns.
  const { queue, eventLookups } = harness({ numTurns: 0, provider: 'codex', openedIds: [RUNTIME_ID] });
  const claimed = await build(queue);
  assert.equal(claimed.resume, false);
  assert.deepEqual(eventLookups, []);
});

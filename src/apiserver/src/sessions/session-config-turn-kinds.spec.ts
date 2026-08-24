import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { encryptSecret } from '../providers/provider-crypto';
import { SessionsService } from './sessions.service';

/**
 * Which control turn a config PATCH queues, decided by what that PATCH actually moved.
 *
 * The split is not a relaxation of the inbox gate — it is a statement about the fields. Effort
 * and provider are decided when the process is built, so the only way to change them is to build
 * another one, and the gate that holds a `reload` until no message is in flight is exactly right
 * for them. Model and permission mode are not built in; they can be said to a resident engine,
 * and holding those until the turn ends was a delay with nothing behind it.
 *
 * So each case below is a claim about one direction: the live half alone must NOT produce a
 * reload, the spawn-only half alone must NOT produce a setconfig, and neither assertion means
 * anything without the other — a rule that queued both every time would satisfy either one.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

/** A live claude session with a committed model/mode/effort triple, and the turns a PATCH left. */
function serviceOn(current: {
  model?: string | null;
  permissionMode?: string | null;
  effort?: string | null;
  /** The one configured row `provider` may be switched onto, or none. */
  modelProvider?: Record<string, unknown>;
}) {
  const { modelProvider, ...row } = current;
  const turns: Array<{ kind: string; content?: string; seq: number }> = [];
  let sequence = 0;
  const tx = {
    $queryRaw: async () => [{ id: ID }],
    session: {
      findUniqueOrThrow: async () => ({
        id: ID,
        ownerId: OWNER,
        status: RunStatus.RUNNING,
        provider: 'claude',
        providerBuiltin: true,
        model: 'claude-opus-5',
        permissionMode: 'default',
        effort: null,
        usesRuntimeDefaultModel: false,
        numTurns: 3,
        workspace: null,
        assignedRunner: null,
        ...row,
      }),
      update: async () => ({ id: ID }),
    },
    conversationTurn: {
      findUnique: async () => null,
      findFirst: async () => (sequence ? { seq: sequence } : null),
      create: async ({ data }: { data: { kind: string; content?: string; seq: number } }) => {
        sequence = data.seq;
        turns.push(data);
        return { id: `turn-${sequence}`, ...data };
      },
      count: async () => 0,
    },
    modelProvider: { findFirst: async () => modelProvider ?? null },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never;
  const service = new SessionsService(prisma, {} as never, {
    notifyInbox: () => undefined,
  } as never);
  return { service, turns };
}

test('a model change is said to the live engine, not spawned into a new one', async () => {
  const { service, turns } = serviceOn({});

  await service.updateConfig(OWNER, ID, { model: 'claude-haiku-4-5' });

  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
  assert.deepEqual(JSON.parse(turns[0].content ?? '{}'), {
    model: 'claude-haiku-4-5',
    permissionMode: 'default',
  });
});

test('a permission-mode change is said to the live engine too', async () => {
  const { service, turns } = serviceOn({});

  await service.updateConfig(OWNER, ID, { permissionMode: 'auto' });

  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
  assert.equal(JSON.parse(turns[0].content ?? '{}').permissionMode, 'auto');
});

test('effort is spawn-only, so it still re-spawns and nothing else is queued', async () => {
  const { service, turns } = serviceOn({});

  await service.updateConfig(OWNER, ID, { effort: 'high' });

  // No setconfig beside it: the model/mode pair did not move, and a control frame restating it
  // would be work the re-spawn below immediately redoes.
  assert.deepEqual(turns.map((t) => t.kind), ['reload']);
  assert.deepEqual(JSON.parse(turns[0].content ?? '{}'), {
    model: 'claude-opus-5',
    permissionMode: 'default',
    effort: 'high',
  });
});

test('re-sending the effort a session already has moves nothing, so it does not re-spawn', async () => {
  const { service, turns } = serviceOn({ effort: 'high' });

  await service.updateConfig(OWNER, ID, { effort: 'high' });

  // The process was built with this flag; rebuilding it to arrive at the same flag is the
  // interruption this split exists to stop handing out.
  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
});

test('moving both halves queues both, with the re-spawn last', async () => {
  const { service, turns } = serviceOn({});

  await service.updateConfig(OWNER, ID, { permissionMode: 'auto', effort: 'high' });

  // Order is the point: a reload re-spawns with every new flag, so a setconfig ordered after it
  // would be a control frame for config the fresh process already has.
  assert.deepEqual(
    turns.map(({ kind, seq }) => ({ kind, seq })),
    [
      { kind: 'setconfig', seq: 1 },
      { kind: 'reload', seq: 2 },
    ],
  );
  assert.equal(JSON.parse(turns[0].content ?? '{}').permissionMode, 'auto');
  assert.equal(JSON.parse(turns[1].content ?? '{}').effort, 'high');
  // The live half is not repeated as a spawn-only field, nor the spawn-only half as a live one.
  assert.equal(JSON.parse(turns[0].content ?? '{}').effort, undefined);
});

test('re-sending the provider a session already declares moves nothing either', async () => {
  const { service, turns } = serviceOn({});

  await service.updateConfig(OWNER, ID, { provider: 'claude' });

  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
});

test('a provider switch alongside a permission-mode change queues both, re-spawn last', async () => {
  process.env.PROVIDER_SECRET_KEY ??= 'test-master-key';
  // A configured slug on the claude runtime: the one kind of switch a claude session may make,
  // since resolveProviderSwitch refuses to move a session across runtimes.
  const { service, turns } = serviceOn({
    modelProvider: {
      runtime: 'claude',
      baseUrl: 'https://byok.example/anthropic',
      apiKeyEnc: encryptSecret('sk-byok'),
      defaultModel: 'byok-large',
      enabled: true,
    },
  });

  await service.updateConfig(OWNER, ID, { provider: 'byok', permissionMode: 'auto' });

  assert.deepEqual(
    turns.map(({ kind, seq }) => ({ kind, seq })),
    [
      { kind: 'setconfig', seq: 1 },
      { kind: 'reload', seq: 2 },
    ],
  );
  // Only the reload names the provider: it is the one that has to rebuild the process, and the
  // identity is what tells the inbox to resolve an environment for it.
  assert.equal(JSON.parse(turns[0].content ?? '{}').provider, undefined);
  assert.equal(JSON.parse(turns[1].content ?? '{}').provider, 'byok');
  // Both carry the same committed pair — they were written under one row lock, from one read.
  const live = JSON.parse(turns[0].content ?? '{}');
  const respawn = JSON.parse(turns[1].content ?? '{}');
  assert.equal(live.model, respawn.model);
  assert.equal(live.permissionMode, respawn.permissionMode);
  assert.equal(live.permissionMode, 'auto');
});

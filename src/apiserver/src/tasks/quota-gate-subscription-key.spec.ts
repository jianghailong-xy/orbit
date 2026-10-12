/**
 * The quota gate on a key (docs/provider-engine-contract.md §4.5), as rules. A run on a key spends the
 * key's own quota, which no runner reports. An API key is metered per token, so it is neither held nor
 * blind; a key holding a Claude subscription token has the subscription's windows, so it is blind, and a
 * usage limit it hits holds the task off for QUOTA_BLIND_RETRY_BACKOFF_MS as one on a sign-in nobody
 * reports does, instead of the sweep re-dispatching it every minute. The sweep itself runs on PostgreSQL
 * in provider-engine-followups.pg.spec.ts; both are named in scripts/test-provider-engine-followups.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encryptSecret } from '../providers/provider-crypto';
import { QUOTA_BLIND_RETRY_BACKOFF_MS, TasksService } from './tasks.service';

process.env.PROVIDER_SECRET_KEY ??= 'quota-gate-subscription-key-spec';

const OWNER = 'owner-1';
const SUBSCRIPTION = 'claude-subscription';
const API_KEY = 'claude-api';
/** A subscription token on a key whose protocol is not Anthropic's: it runs on no engine at all. */
const WRONG_PROTOCOL = 'openai-oat';

type Assignee = { provider: string; login: boolean; runnerId: string; workspaceId: string };
type Gate = {
  quotaGate(tasks: Array<{ id: string; ownerId: string; assignee: Assignee }>): Promise<{ blocked: Map<string, Date>; blind: Set<string> }>;
  autoRunHoldOff(taskIds: string[], blind: ReadonlySet<string>): Promise<Map<string, Date | null>>;
  now(): Date;
};

/**
 * The service over one runner that reports nothing, its workspace and the owner's three keys, with what
 * the gate asked: each slug it looked up, and each key whose ciphertext it read to decrypt. `failedAt`
 * is when each task's one run was killed by a usage limit.
 */
function world(failedAt: Record<string, Date> = {}) {
  const lookups: string[] = [];
  const decrypted: string[] = [];
  const key = (slug: string, runtime: string, apiKey: string) => {
    const apiKeyEnc = encryptSecret(apiKey);
    return {
      runtime,
      baseUrl: runtime === 'claude' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1',
      presetSlug: null,
      get apiKeyEnc() {
        decrypted.push(slug);
        return apiKeyEnc;
      },
    };
  };
  const keys: Record<string, ReturnType<typeof key>> = {
    [SUBSCRIPTION]: key(SUBSCRIPTION, 'claude', 'sk-ant-oat01-subscription'),
    [API_KEY]: key(API_KEY, 'claude', 'sk-ant-api03-metered'),
    [WRONG_PROTOCOL]: key(WRONG_PROTOCOL, 'codex', 'sk-ant-oat01-on-another-protocol'),
  };
  const prisma = {
    runner: { findMany: async () => [{ id: 'runner-1', planUsage: null, engines: null }] },
    workspace: { findMany: async () => [{ id: 'workspace-1', env: null, codexAccount: null, claudeAccount: null }] },
    modelProvider: {
      findFirst: async ({ where }: { where: { slug: string } }) => {
        lookups.push(where.slug);
        return keys[where.slug] ?? null;
      },
    },
    session: {
      // The failure budget's count (a run with no error text or none of the markers) finds nothing: every
      // run here was killed by a usage limit. The blind brake's read finds each one asked about.
      groupBy: async ({ where }: { where: { taskId: { in: string[] }; OR: unknown[] } }) =>
        where.OR.some((clause) => (clause as { error?: unknown }).error === null)
          ? []
          : where.taskId.in.filter((id) => failedAt[id]).map((id) => ({ taskId: id, _max: { createdAt: failedAt[id] } })),
    },
  };
  const service = new TasksService(prisma as never, {} as never, {} as never) as unknown as Gate;
  return { service, lookups, decrypted };
}

const on = (id: string, provider: string, login = false) => ({
  id, ownerId: OWNER, assignee: { provider, login, runnerId: 'runner-1', workspaceId: 'workspace-1' },
});

test("T3 follow-up quota gate: a key holding a Claude subscription token is blind, its key read once a pass and only on Anthropic's protocol", async () => {
  const { service, lookups, decrypted } = world();
  const { blocked, blind } = await service.quotaGate([
    on('subscription-1', SUBSCRIPTION),
    on('subscription-2', SUBSCRIPTION),
    on('api-key', API_KEY),
    on('wrong-protocol', WRONG_PROTOCOL),
    // A sign-in its runner reports nothing for: the brake the subscription token now shares.
    on('sign-in', 'claude', true),
  ]);
  assert.deepEqual([...blind].sort(), ['sign-in', 'subscription-1', 'subscription-2']);
  assert.equal(blocked.size, 0, 'nothing reports a spent window, so nothing is held to a reset');
  // One read of each key a pass, however many tasks run on it, and a key decrypted only on the one
  // protocol a subscription token runs on.
  assert.deepEqual(lookups.sort(), [API_KEY, SUBSCRIPTION, WRONG_PROTOCOL]);
  assert.deepEqual(decrypted.sort(), [API_KEY, SUBSCRIPTION]);
});

test('T3 follow-up quota gate: a usage limit on a subscription-token key holds its task for the blind brake, and one on an API key is not held, as before', async () => {
  const failedAt = new Date('2026-10-10T08:00:00.000Z');
  const { service } = world({ subscription: failedAt, 'api-key': failedAt, 'sign-in': failedAt });
  let now = new Date(failedAt.getTime() + 60_000);
  service.now = () => now;
  const tasks = [on('subscription', SUBSCRIPTION), on('api-key', API_KEY), on('sign-in', 'claude', true)];
  const sweep = async () => {
    const { blind } = await service.quotaGate(tasks);
    return service.autoRunHoldOff(tasks.map((t) => t.id), blind);
  };
  // A minute later — the sweep's next pass — the subscription token waits exactly as the sign-in does;
  // the API key's failure holds nothing, which is what it did before.
  const brake = new Date(failedAt.getTime() + QUOTA_BLIND_RETRY_BACKOFF_MS);
  assert.deepEqual([...(await sweep())].sort(), [['sign-in', brake], ['subscription', brake]]);
  // A second before the brake ends it still holds; a second after, the task may run again.
  now = new Date(brake.getTime() - 1_000);
  assert.deepEqual([...(await sweep()).keys()].sort(), ['sign-in', 'subscription']);
  now = new Date(brake.getTime() + 1_000);
  assert.equal((await sweep()).size, 0);
});

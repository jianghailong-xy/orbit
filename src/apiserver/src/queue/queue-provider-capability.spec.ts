import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { QueueService } from './queue.service';

async function capturedClaimCapability(
  supportedProviders: AgentProvider[],
): Promise<{ capability: unknown; claimSetting: unknown; settingSql: string; sql: string }> {
  let values: unknown[] = [];
  let sql = '';
  let claimSetting: unknown;
  let settingSql = '';
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...bound: unknown[]) => {
      const statement = strings.join('?');
      if (statement.includes('orbit.runner_supports_opencode')) {
        settingSql = statement;
        claimSetting = bound[0];
      }
      return 0;
    },
    $queryRaw: async (strings: TemplateStringsArray, ...bound: unknown[]) => {
      sql = strings.join('?');
      values = bound;
      return [];
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
  const queue = new QueueService(prisma);
  await queue.claimSessionForRunner({
    id: '11111111-1111-4111-8111-111111111111',
    supportedProviders,
  });
  // UPDATE interpolations are: upgrade error, runner id, capability, then runner ids/caps.
  return { capability: values[2], claimSetting, settingSql, sql };
}

test('the atomic claim selection receives a false OpenCode capability for legacy runners', async () => {
  const captured = await capturedClaimCapability([AgentProvider.CLAUDE, AgentProvider.CODEX]);
  assert.equal(captured.capability, false);
  assert.equal(captured.claimSetting, '0');
  assert.match(captured.settingSql, /set_config\('orbit\.runner_supports_opencode'/);
  assert.match(captured.sql, /COALESCE\(s\.provider, 'claude'\) <> 'opencode'/);
  assert.match(captured.sql, /SELECT s\.id FROM "session" s/);
});

test(
  'the atomic claim selection and database guard receive a true OpenCode capability for current runners',
  async () => {
    const captured = await capturedClaimCapability([
      AgentProvider.CLAUDE,
      AgentProvider.CODEX,
      AgentProvider.OPENCODE,
    ]);
    assert.equal(captured.capability, true);
    assert.equal(captured.claimSetting, '1');
  },
);

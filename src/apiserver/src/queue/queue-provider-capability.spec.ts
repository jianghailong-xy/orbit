import assert from 'node:assert/strict';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { QueueService } from './queue.service';

async function capturedClaimCapability(
  supportedProviders: AgentProvider[],
): Promise<{ capability: unknown; claimSetting: unknown; settingSql: string; sql: string }> {
  let values: unknown[] = [];
  let segments: readonly string[] = [];
  let sql = '';
  let claimSetting: unknown;
  let settingSql = '';
  const tx = {
    $executeRaw: async (...args: unknown[]) => {
      const { text: statement, values: bound } = renderRawQuery(args);
      if (statement.includes('orbit.runner_supports_opencode')) {
        settingSql = statement;
        claimSetting = bound[0];
      }
      return 0;
    },
    // The claim composes shared cap fragments, so it hands $queryRaw one Prisma.Sql rather
    // than a tagged template: literal segments in `strings`, bound parameters in `values`.
    $queryRaw: async (...args: unknown[]) => {
      const rendered = renderRawQuery(args);
      sql = rendered.text;
      values = [...rendered.values];
      segments = rendered.strings;
      return [];
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
  const queue = new QueueService(prisma, { publishSessionUpdated() {} } as never);
  await queue.claimSessionForRunner({
    id: '11111111-1111-4111-8111-111111111111',
    supportedProviders,
  });
  // Found by the predicate it feeds, not by its position. A tagged template's values are a flat
  // list, so counting into it makes this spec fail the next time an unrelated interpolation is
  // added anywhere above — which says nothing about the capability it exists to check. `values[i]`
  // sits between `strings[i]` and `strings[i + 1]`, so the segment AFTER the value is what names it.
  const index = segments.findIndex((segment, i) =>
    i > 0 && segment.includes("COALESCE(s.provider, 'claude') <> 'opencode'"),
  );
  assert.ok(index > 0, 'the claim no longer gates OpenCode on a bound capability');
  return { capability: values[index - 1], claimSetting, settingSql, sql };
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

import assert from 'node:assert/strict';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { QueueService } from './queue.service';
import {
  ANTIGRAVITY_RUNNER_UPGRADE_ERROR,
  DSH_RUNNER_UPGRADE_ERROR,
  OPENCODE_RUNNER_UPGRADE_ERROR,
} from '../runner-api/runner-provider-support';

interface Captured {
  /** The bound capability that gates OpenCode rows in the claim selection. */
  capability: unknown;
  /** The same for Antigravity rows. */
  antigravityCapability: unknown;
  /** The same for a configured provider that borrows Antigravity (a Gemini key). */
  borrowedAntigravityCapability: unknown;
  /** The value bound for each transaction-local GUC, read off the statement that sets it. */
  claimSetting: unknown;
  antigravitySetting: unknown;
  dshSetting: unknown;
  settingSql: string;
  sql: string;
  values: unknown[];
}

async function capturedClaimCapability(supportedProviders: AgentProvider[]): Promise<Captured> {
  let values: unknown[] = [];
  let segments: readonly string[] = [];
  let sql = '';
  const seen: { settings?: { strings: readonly string[]; values: readonly unknown[] } } = {};
  let settingSql = '';
  const tx = {
    $executeRaw: async (...args: unknown[]) => {
      const rendered = renderRawQuery(args);
      if (rendered.text.includes('orbit.runner_supports_opencode')) {
        settingSql = rendered.text;
        seen.settings = rendered;
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
    session: { findMany: async () => [] },
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
  const boundBefore = (marker: string): unknown => {
    const index = segments.findIndex((segment, i) => i > 0 && segment.includes(marker));
    assert.ok(index > 0, `nothing is bound in front of ${marker}`);
    return values[index - 1];
  };
  // A GUC's name is written before the value set_config binds for it, so there it is the segment
  // in FRONT of the value that names it.
  assert.ok(seen.settings, 'the claim no longer sets the runtime capability GUCs');
  const { strings: settingStrings, values: settingValues } = seen.settings;
  const settingFor = (guc: string): unknown => {
    const index = settingStrings.findIndex((segment) => segment.includes(`'${guc}', `));
    assert.ok(index >= 0 && index < settingValues.length, `nothing sets ${guc}`);
    return settingValues[index];
  };
  // The runtime a row is gated as is its recorded engine, and — for a row an older replica wrote, with
  // none — the slug it names, as before (docs/provider-engine-contract.md §5.6).
  return {
    capability: boundBefore(`COALESCE(s."engine", s.provider, 'claude') <> 'opencode'`),
    antigravityCapability: boundBefore(`COALESCE(s."engine", s.provider, 'claude') <> 'antigravity'`),
    borrowedAntigravityCapability: boundBefore('OR NOT EXISTS ('),
    claimSetting: settingFor('orbit.runner_supports_opencode'),
    antigravitySetting: settingFor('orbit.runner_supports_antigravity'),
    dshSetting: settingFor('orbit.runner_supports_dsh'),
    settingSql,
    sql,
    values,
  };
}

test('the atomic claim selection receives a false OpenCode capability for legacy runners', async () => {
  const captured = await capturedClaimCapability([AgentProvider.CLAUDE, AgentProvider.CODEX]);
  assert.equal(captured.capability, false);
  assert.equal(captured.claimSetting, '0');
  assert.match(captured.settingSql, /set_config\('orbit\.runner_supports_opencode'/);
  // Every claim, whatever the runner, declares it reads the session's recorded engine (migration 0414).
  assert.match(captured.settingSql, /set_config\('orbit\.claim_reads_session_engine', '1', true\)/);
  assert.match(captured.sql, /COALESCE\(s\."engine", s\.provider, 'claude'\) <> 'opencode'/);
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

test('a runner that advertises OpenCode but not Antigravity is withheld Antigravity rows', async () => {
  // Every OpenCode-capable runner in the field today: it would read `antigravity` as Claude.
  const captured = await capturedClaimCapability([
    AgentProvider.CLAUDE,
    AgentProvider.CODEX,
    AgentProvider.OPENCODE,
  ]);
  assert.equal(captured.antigravityCapability, false);
  assert.equal(captured.antigravitySetting, '0');
  assert.match(captured.settingSql, /set_config\('orbit\.runner_supports_antigravity'/);
  assert.match(captured.sql, /COALESCE\(s\."engine", s\.provider, 'claude'\) <> 'antigravity'/);
  // The two gates are independent: OpenCode still passes for this runner.
  assert.equal(captured.capability, true);
});

test('a runner that does not name Antigravity is withheld a Gemini key\'s rows too', async () => {
  // The slug is the configured row's own, so the built-in slug's predicate cannot see it; the job
  // is an `antigravity` one all the same. Held to the same capability, on the rows dispatch resolves:
  // the owner's own, and a shared one only for an admin (usableProviderSql).
  // A Gemini key's session with a recorded engine is gated by it (the COALESCE above); one without
  // keeps the row lookup, which asks the key's runtime.
  const legacy = await capturedClaimCapability([AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.OPENCODE]);
  assert.equal(legacy.borrowedAntigravityCapability, false);
  assert.match(legacy.sql, /OR s\."engine" IS NOT NULL\s+OR NOT EXISTS \(/);
  assert.match(
    legacy.sql,
    /OR NOT EXISTS \(\s*SELECT 1 FROM "model_provider" mp\s+WHERE mp\."slug" = s\.provider\s+AND mp\."runtime" = 'antigravity'\s+AND NOT \(s.provider = 'dsh' AND s\."provider_builtin"\)\s+AND mp\."enabled"\s+AND \(mp\."owner_id" = s\."owner_id" OR \(mp\."owner_id" IS NULL AND EXISTS \(\s*SELECT 1 FROM "user" u WHERE u\."id" = s\."owner_id" AND u\."role" = 'ADMIN'\)\)\)/,
  );
  const current = await capturedClaimCapability([
    AgentProvider.CLAUDE,
    AgentProvider.CODEX,
    AgentProvider.OPENCODE,
    AgentProvider.ANTIGRAVITY,
  ]);
  assert.equal(current.borrowedAntigravityCapability, true);
});

test('the atomic claim selection and database guard admit Antigravity for a runner that names it', async () => {
  const captured = await capturedClaimCapability([
    AgentProvider.CLAUDE,
    AgentProvider.CODEX,
    AgentProvider.OPENCODE,
    AgentProvider.ANTIGRAVITY,
  ]);
  assert.equal(captured.antigravityCapability, true);
  assert.equal(captured.antigravitySetting, '1');
});

test('a claim clears the upgrade notice of every runtime gate it just passed', async () => {
  // The preflight wrote it because a runner could not drive the row; the row being claimed is the
  // answer, so a running session must not keep reading as blocked.
  const captured = await capturedClaimCapability([AgentProvider.ANTIGRAVITY]);
  assert.match(captured.sql, /error = CASE\s+WHEN error IN \(/);
  assert.ok(captured.values.includes(OPENCODE_RUNNER_UPGRADE_ERROR));
  assert.ok(captured.values.includes(ANTIGRAVITY_RUNNER_UPGRADE_ERROR));
});

test('P1b dsh queue negotiates transaction gate and clears upgrade notices', async () => {
  const legacy = await capturedClaimCapability([AgentProvider.CLAUDE]);
  const current = await capturedClaimCapability([AgentProvider.DSH]);
  assert.equal(legacy.dshSetting, '0');
  assert.equal(current.dshSetting, '1');
  assert.match(current.sql, /'provider:dsh' = ANY\(r.capabilities\)/);
  assert.match(current.sql, /r\."capabilities_reported_at" IS NOT NULL/);
  // Harness by its recorded engine, whatever key it spends; by the old identity for a row without one.
  assert.match(current.sql, /\(s\."engine" IS NOT NULL AND s\."engine" = 'dsh'\)/);
  assert.match(current.sql, /s.provider = 'dsh' AND s\."provider_builtin"/);
  assert.ok(current.values.includes(DSH_RUNNER_UPGRADE_ERROR));
});

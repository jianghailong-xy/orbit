import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskRouteReads } from './task-route-decision';

function fixture(rows: Array<{ slug: string; runtime: string; enabled?: boolean; presetSlug?: string; followsPreset?: boolean }> = [],
  poolEngine?: string) {
  const reads = taskRouteReads({
    // An admin, for whom a shared row resolves as any row of theirs does (usableProviderScope).
    user: { findUnique: async () => ({ role: 'ADMIN' }) },
    modelProvider: { findFirst: async ({ where }: { where: { slug: string } }) =>
      rows.find((row) => row.slug === where.slug) ?? null },
    providerPool: { findFirst: async () => poolEngine ? { shared: false, engine: poolEngine } : null },
  } as never, 'owner-1');
  return reads;
}

test('P1a new task route keeps existing DeepSeek provider on Claude', async () => {
  const rows = [{ slug: 'deepseek', runtime: 'claude', presetSlug: 'deepseek', followsPreset: true }];
  const before = structuredClone(rows);
  assert.deepEqual(await fixture(rows).engine('deepseek', false), {
    runtime: 'claude', hasOwnModelSpace: true,
  });
  assert.deepEqual(rows, before);
});

test('P1a task routing uses the explicit Harness runtime and live model space', async () => {
  assert.deepEqual(await fixture([{ slug: 'deepseek-harness', runtime: 'dsh' }])
    .engine('deepseek-harness', false), { runtime: 'dsh', hasOwnModelSpace: false });
  assert.deepEqual(await fixture().engine('dsh', true), {
    runtime: 'dsh', hasOwnModelSpace: false,
  });
});

test('P1a pinned dsh task preserves an existing provider or pool collision', async () => {
  assert.deepEqual(await fixture([{ slug: 'dsh', runtime: 'claude' }]).engine('dsh', true), {
    runtime: 'claude', hasOwnModelSpace: true,
  });
  assert.deepEqual(await fixture([], 'codex').engine('dsh', true), {
    runtime: 'codex', hasOwnModelSpace: false,
  });
  assert.deepEqual(await fixture().engine('dsh', false), {
    runtime: 'claude', hasOwnModelSpace: false,
  });
  assert.deepEqual(await fixture([{ slug: 'dsh', runtime: 'codex', enabled: false }]).engine('dsh', true), {
    runtime: 'claude', hasOwnModelSpace: true,
  });
});

test('P1a task routing preserves every other built-in engine', async () => {
  for (const runtime of ['claude', 'codex', 'kimi', 'opencode', 'antigravity']) {
    assert.deepEqual(await fixture().engine(runtime, true), {
      runtime, hasOwnModelSpace: false,
    });
  }
});

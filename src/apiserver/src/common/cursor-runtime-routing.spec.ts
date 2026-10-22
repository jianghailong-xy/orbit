import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { AgentProvider, PermissionMode } from '@orbit/shared';
import { builtinSessionEngine, isBuiltinProvider, resolveProviderExec } from '../providers/custom-provider';
import { COMPATIBILITY_GUARD_SLUGS } from '../providers/providers.service';
import { pickFreeSlug } from '../providers/provider-slug';
import { reclaimRuntimeIds } from '../runner-api/reclaim-runtime';
import { REPORTED_ENGINES, isInstallEngine, isLoginEngine, isReportedEngine } from './runner-engines';
import { cursorDefaultPermissionMode } from './permission-semantics';
import {
  initializesRuntimeDynamically,
  normalizeBuiltinPermissionMode,
  normalizeEffortForProvider,
  normalizeEffortForRuntimeModel,
  normalizeRuntimeProvider,
} from './runtime-provider';

// Cursor CLI's runtime identity on the server (project P1); scripts/test-cursor-engine.mjs runs these by name.

const MODEL = 'gpt-5.5[context=272k,reasoning=medium,fast=false]';
const incompatible = (error: unknown) =>
  error instanceof BadRequestException
  && (error.getResponse() as { code?: string }).code === 'PROVIDER_ENGINE_INCOMPATIBLE';

test('P1 cursor is a built-in engine slug, unambiguous since migration 0426, and its guard row is never a provider', () => {
  for (const builtin of [true, false]) {
    assert.equal(normalizeRuntimeProvider(AgentProvider.CURSOR, builtin), AgentProvider.CURSOR);
    assert.equal(isBuiltinProvider(AgentProvider.CURSOR, builtin), true);
    assert.equal(builtinSessionEngine(AgentProvider.CURSOR, builtin), AgentProvider.CURSOR);
  }
  // Near names are configured slugs as they always were.
  for (const slug of ['cursor-2', 'Cursor', 'cursor-agent']) {
    assert.equal(isBuiltinProvider(slug, false), false);
    assert.equal(builtinSessionEngine(slug, false), null);
    assert.equal(normalizeRuntimeProvider(slug), AgentProvider.CLAUDE);
  }
  assert.ok(COMPATIBILITY_GUARD_SLUGS.includes(AgentProvider.CURSOR));
  // A key or pool named after the engine takes the next free name, as `antigravity` does.
  assert.equal(pickFreeSlug('cursor', []), 'cursor-2');
  assert.equal(pickFreeSlug('cursor', ['cursor-2']), 'cursor-3');
  // It mints its own conversation id over ACP (`session/new`), so a reclaim before then starts fresh.
  assert.equal(initializesRuntimeDynamically(AgentProvider.CURSOR), true);
  assert.deepEqual(reclaimRuntimeIds({ provider: AgentProvider.CURSOR, sessionId: 'orbit-1', runtimeSessionId: null }), {
    sessionUuid: 'orbit-1', runtimeSessionId: undefined,
  });
  // Its health is accepted from a runner that reports it, its sign-in relayed to a runner that
  // declares cursor-account-login/v1 (runner-login-account.spec.ts), and its install to a runner that
  // knows Cursor CLI (runners/cursor-install-relay.spec.ts).
  assert.equal(REPORTED_ENGINES.at(-1), 'cursor');
  assert.equal(isReportedEngine('cursor'), true);
  assert.equal(isLoginEngine('cursor'), true);
  assert.equal(isInstallEngine('cursor'), true);
});

test('P1 a Cursor CLI sign-in session is built for the runner on Cursor CLI alone', () => {
  const exec = resolveProviderExec({
    engine: AgentProvider.CURSOR,
    declaredProvider: AgentProvider.CURSOR,
    declaredProviderBuiltin: true,
    customRow: null,
    sessionModel: MODEL,
    workspaceEnv: { FOO: 'bar' },
  });
  assert.deepEqual(exec, { provider: AgentProvider.CURSOR, model: MODEL, env: { FOO: 'bar' } });
  // No static model: a blank pick leaves Cursor CLI on its own Auto.
  assert.equal(resolveProviderExec({
    engine: AgentProvider.CURSOR, declaredProvider: AgentProvider.CURSOR, customRow: null, sessionModel: null,
  }).model, '');
  // Another vendor's model id is Cursor CLI's to run, never coerced.
  assert.equal(resolveProviderExec({
    engine: AgentProvider.CURSOR, declaredProvider: AgentProvider.CURSOR, customRow: null, sessionModel: 'claude-opus-5-5',
  }).model, 'claude-opus-5-5');
  // A sign-in runs its own engine and no other.
  assert.throws(() => resolveProviderExec({
    engine: AgentProvider.CLAUDE, declaredProvider: AgentProvider.CURSOR, customRow: null,
  }), incompatible);
  assert.throws(() => resolveProviderExec({
    engine: AgentProvider.CURSOR, declaredProvider: AgentProvider.CLAUDE, customRow: null,
  }), incompatible);
});

test('P1 Cursor CLI effort values are opaque and the live catalogue decides them', () => {
  for (const value of ['', 'low', 'medium', 'high', 'xhigh', 'max', 'reasoning=high']) {
    assert.equal(normalizeEffortForProvider(AgentProvider.CURSOR, value), value);
  }
  assert.equal(normalizeEffortForProvider(AgentProvider.CURSOR, null), undefined);
  const catalog = { cursor: [{ value: MODEL, label: 'GPT-5.5', reasoningLevels: ['low', 'medium', 'high'] }] };
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.CURSOR, 'medium', MODEL, catalog), 'medium');
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.CURSOR, 'max', MODEL, catalog), '');
  // A model the catalogue does not describe keeps its value; the runner has not spoken for it.
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.CURSOR, 'max', 'default[]', catalog), 'max');
});

test('P1 the server admits exactly the Cursor CLI modes the picker calls kept, and defaults to Accept Edits', () => {
  // Auto is the runner's own review of each request Cursor CLI asks about (P5c), on any model.
  for (const mode of [PermissionMode.ACCEPT_EDITS, PermissionMode.PLAN, PermissionMode.AUTO, PermissionMode.DONT_ASK, PermissionMode.BYPASS]) {
    // Root is no concern of Cursor CLI's: `--force` runs as root, so Bypass is not swapped for Don't Ask.
    for (const runsAsRoot of [undefined, false, true]) {
      assert.equal(normalizeBuiltinPermissionMode(AgentProvider.CURSOR, MODEL, mode, false, runsAsRoot), mode);
    }
  }
  for (const mode of [PermissionMode.DEFAULT, 'unknown-mode']) {
    assert.throws(
      () => normalizeBuiltinPermissionMode(AgentProvider.CURSOR, MODEL, mode as PermissionMode, true, false),
      /Cursor CLI cannot enforce permission mode ".+"; use Accept Edits, Plan, Auto, Don't Ask or Bypass/,
    );
  }
  // A session nobody named a mode for: the account default when Cursor CLI keeps it, else Accept Edits.
  assert.equal(cursorDefaultPermissionMode(undefined), PermissionMode.ACCEPT_EDITS);
  assert.equal(cursorDefaultPermissionMode(null), PermissionMode.ACCEPT_EDITS);
  assert.equal(cursorDefaultPermissionMode(PermissionMode.DEFAULT), PermissionMode.ACCEPT_EDITS);
  for (const kept of [PermissionMode.PLAN, PermissionMode.AUTO, PermissionMode.DONT_ASK, PermissionMode.BYPASS, PermissionMode.ACCEPT_EDITS]) {
    assert.equal(cursorDefaultPermissionMode(kept), kept);
  }
  // Nothing moves for the others: Claude Code's root fallback and Auto still apply to Claude.
  assert.equal(normalizeBuiltinPermissionMode(AgentProvider.CLAUDE, 'claude-opus-5', PermissionMode.BYPASS, false, true),
    PermissionMode.DONT_ASK);
  assert.equal(normalizeBuiltinPermissionMode(AgentProvider.CLAUDE, 'claude-opus-5', PermissionMode.DEFAULT), PermissionMode.DEFAULT);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentProvider,
  PermissionMode,
  autoAvailable,
  derivePermissionSemantics,
  runtimeApprovalSupport,
} from '@orbit/shared';
import { withSessionCapabilities } from '../sessions/session-state';

const ASK_MODES = [PermissionMode.DEFAULT, PermissionMode.ACCEPT_EDITS, PermissionMode.PLAN];

test('an ask-me mode is honored only where the runtime can reach a human', () => {
  for (const mode of ASK_MODES) {
    // Claude blocks on a real approval card.
    assert.deepEqual(
      { u: derivePermissionSemantics(AgentProvider.CLAUDE, mode).unapproved, h: derivePermissionSemantics(AgentProvider.CLAUDE, mode).honored },
      { u: 'ask', h: true },
    );
    // Kimi asks too, but only about tools it deems worth asking about.
    const kimi = derivePermissionSemantics(AgentProvider.KIMI, mode);
    assert.equal(kimi.unapproved, 'ask');
    assert.equal(kimi.honored, true);
    assert.ok(kimi.note, 'the partial guarantee must be stated, not implied');
    // OpenCode cannot ask: it refuses rather than waving the action through.
    const opencode = derivePermissionSemantics(AgentProvider.OPENCODE, mode);
    assert.equal(opencode.unapproved, 'deny');
    assert.equal(opencode.honored, false);
    // Codex now bridges its approval requests to the same card, so an ask-me mode means it.
    const codex = derivePermissionSemantics(AgentProvider.CODEX, mode);
    assert.equal(codex.unapproved, 'ask');
    assert.equal(codex.honored, true);
    assert.ok(codex.note?.includes('commands'), `codex note = ${codex.note}`);
  }
});

test("Don't Ask means deny everywhere a runtime can withhold, and is unenforced on Codex", () => {
  for (const provider of [AgentProvider.CLAUDE, AgentProvider.KIMI, AgentProvider.OPENCODE]) {
    const semantics = derivePermissionSemantics(provider, PermissionMode.DONT_ASK);
    assert.equal(semantics.unapproved, 'deny', `${provider} should deny`);
    assert.equal(semantics.honored, true);
  }
  // Codex is the exception, and says so: it takes no allowlist, so approvals stay off there.
  const codex = derivePermissionSemantics(AgentProvider.CODEX, PermissionMode.DONT_ASK);
  assert.deepEqual({ u: codex.unapproved, h: codex.honored }, { u: 'allow', h: false });
  assert.ok(codex.note?.includes('not enforced on Codex'), `codex note = ${codex.note}`);
});

test('the deliberately-permissive modes are honored everywhere, including Codex', () => {
  for (const mode of [PermissionMode.AUTO, PermissionMode.BYPASS]) {
    for (const provider of Object.values(AgentProvider)) {
      const semantics = derivePermissionSemantics(provider, mode);
      assert.deepEqual(
        { u: semantics.unapproved, h: semantics.honored },
        { u: 'allow', h: true },
        `${provider}/${mode}`,
      );
    }
  }
});

test('Auto exists on every runtime; only Claude gates it per model', () => {
  // Codex has it as `on-request` ("the model decides when to ask"), Kimi and OpenCode
  // runtime-wide. It used to be refused on Codex, which is why a Codex session was told to
  // switch to a newer Claude model to get a mode its own CLI has had all along.
  assert.equal(autoAvailable(AgentProvider.CODEX, 'gpt-5.6-sol'), true);
  assert.equal(autoAvailable(AgentProvider.KIMI, 'any-local-alias'), true);
  assert.equal(autoAvailable(AgentProvider.OPENCODE, ''), true);
  assert.equal(autoAvailable(AgentProvider.CLAUDE, 'claude-opus-5'), true);
  assert.equal(autoAvailable(AgentProvider.CLAUDE, 'claude-haiku-4-5'), false);
  // A configured provider's model space is vendor-defined; the CLI decides for itself.
  assert.equal(autoAvailable(AgentProvider.CLAUDE, 'deepseek-v4', true), true);
});

test('Auto on a Claude model without it is disclosed, not hidden', () => {
  const degraded = derivePermissionSemantics(
    AgentProvider.CLAUDE,
    PermissionMode.AUTO,
    'claude-haiku-4-5',
  );
  // It degrades toward asking (the server runs it as Default), so the guarantee is stronger
  // than the mode's plain reading rather than weaker — and it is stated either way.
  assert.deepEqual({ u: degraded.unapproved, h: degraded.honored }, { u: 'ask', h: false });
  assert.match(degraded.shortNote ?? '', /runs as Default/);
  // Omitting the model means "already normalized for dispatch" and must not invent a caveat.
  assert.equal(derivePermissionSemantics(AgentProvider.CLAUDE, PermissionMode.AUTO).honored, true);
});

test('a caveat is carried as data exactly when the mode is not honored', () => {
  // The picker renders `shortNote` verbatim instead of rebuilding the wording from
  // honored/unapproved. That is only safe if the table always supplies one — the missing pair
  // here is precisely how a greyed Auto option came to state a reason the gate did not use.
  for (const provider of Object.values(AgentProvider)) {
    for (const mode of Object.values(PermissionMode)) {
      for (const model of ['claude-opus-5', 'claude-haiku-4-5']) {
        const semantics = derivePermissionSemantics(provider, mode, model);
        assert.equal(
          semantics.shortNote !== undefined,
          !semantics.honored,
          `${provider}/${mode}/${model}: shortNote must accompany an unhonored mode, and only one`,
        );
      }
    }
  }
});

test('approval support is reported per runtime', () => {
  assert.equal(runtimeApprovalSupport(AgentProvider.CLAUDE), 'full');
  assert.equal(runtimeApprovalSupport(AgentProvider.KIMI), 'partial');
  assert.equal(runtimeApprovalSupport(AgentProvider.OPENCODE), 'none');
  // Codex gates its dangerous primitives (commands, patches) but not every tool.
  assert.equal(runtimeApprovalSupport(AgentProvider.CODEX), 'partial');
});

const ROW = {
  status: 'RUNNING',
  cancelRequestedAt: null,
  startedAt: new Date(),
  numTurns: 1,
  runtimeSessionId: 'rt-1',
  assignedRunner: null,
};

test('a session payload carries the semantics of the runtime that runs it', () => {
  const codex = withSessionCapabilities({
    ...ROW,
    provider: 'codex',
    providerBuiltin: true,
    permissionMode: PermissionMode.DONT_ASK,
  });
  assert.equal(codex.permissionSemantics?.unapproved, 'allow');
  assert.equal(codex.permissionSemantics?.honored, false);
  assert.equal(codex.permissionSemantics?.mode, PermissionMode.DONT_ASK, 'intent is echoed alongside reality');
});

test('a custom provider omits the field rather than guessing its borrowed runtime', () => {
  const byok = withSessionCapabilities({
    ...ROW,
    provider: 'my-deepseek',
    providerBuiltin: false,
    permissionMode: PermissionMode.DEFAULT,
  });
  assert.equal(byok.permissionSemantics, undefined);
  // Lifecycle capabilities are unaffected by the addition.
  assert.equal(typeof byok.capabilities.canSend, 'boolean');
});

test('a row with no provider information still derives lifecycle capabilities', () => {
  const bare = withSessionCapabilities({ ...ROW });
  assert.equal(bare.permissionSemantics, undefined);
  assert.equal(typeof bare.capabilities.canResume, 'boolean');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentProvider,
  PermissionMode,
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

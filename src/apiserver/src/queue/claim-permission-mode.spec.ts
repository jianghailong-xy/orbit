import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { AgentProvider, PermissionMode } from '@orbit/shared';

import { claimPermissionMode, claimPermissionModeLogLine } from './claim-permission-mode';

/**
 * The mode a claim hands the runner (claim-permission-mode.ts): the session's own, but for the two substitutions that
 * are not predictions, each named. Project 350NMcNDulzkqRAFFUsXZ, criterion 55f38yosCj1Nw2KIal3Sn6.
 */

test('a session that asked for Auto is claimed in Auto on every runtime, the model left to its engine', () => {
  for (const provider of [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.DSH, AgentProvider.CURSOR]) {
    for (const runsAsRoot of [true, false, null, undefined]) {
      assert.deepEqual(claimPermissionMode(provider, PermissionMode.AUTO, null, runsAsRoot), {
        mode: PermissionMode.AUTO,
        substitution: null,
      }, `${provider}, runsAsRoot=${String(runsAsRoot)}`);
    }
  }
});

test('a scheduled run on Claude Code is claimed in Auto whatever it asked for, and says why', () => {
  for (const level of ['CHECK_ONLY', 'OPEN_PR', 'LAND'] as const) {
    for (const asked of [PermissionMode.DEFAULT, PermissionMode.PLAN, PermissionMode.DONT_ASK, PermissionMode.BYPASS]) {
      assert.deepEqual(claimPermissionMode(AgentProvider.CLAUDE, asked, level, true), {
        mode: PermissionMode.AUTO,
        substitution: { requestedMode: asked, reason: 'SCHEDULED_RUN' },
      }, `${level}, asked ${asked}`);
    }
    assert.deepEqual(claimPermissionMode(AgentProvider.CLAUDE, PermissionMode.AUTO, level, false), {
      mode: PermissionMode.AUTO,
      substitution: null,
    }, 'a scheduled run that asked for Auto is no substitution');
  }
  // Claude only: every other engine's Auto has no classifier, so its scheduled run keeps the session's mode.
  assert.deepEqual(claimPermissionMode(AgentProvider.CODEX, PermissionMode.DEFAULT, 'OPEN_PR', false), {
    mode: PermissionMode.DEFAULT,
    substitution: null,
  });
});

test('Bypass on a root runner is claimed in Auto, and says why; anywhere else it is Bypass', () => {
  for (const provider of [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.KIMI, AgentProvider.OPENCODE]) {
    assert.deepEqual(claimPermissionMode(provider, PermissionMode.BYPASS, null, true), {
      mode: PermissionMode.AUTO,
      substitution: { requestedMode: PermissionMode.BYPASS, reason: 'ROOT_RUNNER' },
    }, provider);
    // A runner that has not said whether it runs as root keeps Bypass: an unknown never removes a mode.
    for (const runsAsRoot of [false, null, undefined]) {
      assert.deepEqual(claimPermissionMode(provider, PermissionMode.BYPASS, null, runsAsRoot), {
        mode: PermissionMode.BYPASS,
        substitution: null,
      }, `${provider}, runsAsRoot=${String(runsAsRoot)}`);
    }
  }
});

test('DeepSeek Harness and Cursor CLI refuse a mode they cannot enforce instead of substituting one', () => {
  assert.throws(() => claimPermissionMode(AgentProvider.DSH, PermissionMode.PLAN, null, false), BadRequestException);
  assert.throws(() => claimPermissionMode(AgentProvider.CURSOR, PermissionMode.DEFAULT, null, false), BadRequestException);
  // Cursor CLI runs Bypass as --force, root or not: its own table, no root substitution.
  assert.deepEqual(claimPermissionMode(AgentProvider.CURSOR, PermissionMode.BYPASS, null, true), {
    mode: PermissionMode.BYPASS,
    substitution: null,
  });
  assert.deepEqual(claimPermissionMode(AgentProvider.DSH, PermissionMode.DONT_ASK, 'CHECK_ONLY', true), {
    mode: PermissionMode.DONT_ASK,
    substitution: null,
  });
});

test('the substitution line names the session, model, both modes and the reason, and nothing it cannot vouch for', () => {
  const sessionId = '0193f0c2-6a6b-7c3d-8e9f-0a1b2c3d4e5f';
  assert.equal(
    claimPermissionModeLogLine({
      sessionId,
      provider: AgentProvider.CLAUDE,
      model: 'claude-opus-5-5',
      mode: PermissionMode.AUTO,
      substitution: { requestedMode: PermissionMode.BYPASS, reason: 'ROOT_RUNNER' },
    }),
    `claim-permission-mode {"sessionId":"${sessionId}","provider":"claude","model":"claude-opus-5-5",` +
      '"from":"bypassPermissions","to":"auto","reason":"ROOT_RUNNER"}',
  );
  const odd = JSON.parse(claimPermissionModeLogLine({
    sessionId: 'not a uuid',
    provider: 'somewhere',
    model: 'ya29.a0-looks-like-a-token',
    mode: 'sideways' as PermissionMode,
    substitution: { requestedMode: 'upside' as PermissionMode, reason: 'BECAUSE' as 'ROOT_RUNNER' },
  }).slice('claim-permission-mode '.length));
  assert.deepEqual(odd, {
    sessionId: '[redacted]',
    provider: '[redacted]',
    model: '[redacted]',
    from: '[redacted]',
    to: '[redacted]',
    reason: '[redacted]',
  });
});

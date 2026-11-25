import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, PermissionMode, RunStatus, derivePermissionSemantics } from '@orbit/shared';
import { factsOfWord } from './session-legacy-words.fixture';
import { withSessionCapabilities } from './session-state';
import { reportsCodexSandboxUnavailable } from '../runner-api/codex-sandbox-report';

/**
 * Codex Auto on an Orbit Cloud runner whose sandbox probe failed runs with the sandbox off
 * (runner-go codex_cloud_sandbox.go). The runner's notice reports it; the session row keeps it as
 * codexSandboxUnavailable, and the session's server-derived permissionSemantics stop claiming a
 * workspace-write sandbox. Every other session reads exactly as before.
 */

const NOW = new Date('2026-11-23T12:00:00.000Z');

function session(provider: string, permissionMode: string, codexSandboxUnavailable?: boolean) {
  return {
    ...factsOfWord(RunStatus.RUNNING),
    status: RunStatus.RUNNING,
    endReason: null,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    startedAt: NOW,
    numTurns: 1,
    runtimeSessionId: 'runtime-1',
    assignedRunnerId: 'runner-1',
    assignedRunner: { id: 'runner-1', status: 'ONLINE', lastHeartbeatAt: NOW },
    provider,
    providerBuiltin: true,
    permissionMode,
    ...(codexSandboxUnavailable === undefined ? {} : { codexSandboxUnavailable }),
  };
}

const MODES = [
  PermissionMode.DEFAULT,
  PermissionMode.ACCEPT_EDITS,
  PermissionMode.PLAN,
  PermissionMode.AUTO,
  PermissionMode.DONT_ASK,
  PermissionMode.BYPASS,
];

test('a Codex Auto session whose runner reported the sandbox unavailable is told the sandbox is off', () => {
  const semantics = withSessionCapabilities(session(AgentProvider.CODEX, PermissionMode.AUTO, true), NOW.getTime())
    .permissionSemantics;
  assert.deepEqual(semantics, {
    mode: PermissionMode.AUTO,
    unapproved: 'allow',
    approvalSupport: 'partial',
    honored: false,
    sandbox: 'off',
    note: "Codex's sandbox is unavailable on Orbit Cloud: commands run unconfined inside your Cloud runner.",
    shortNote: 'sandbox off on Orbit Cloud, commands run unconfined',
  });
  assert.doesNotMatch(JSON.stringify(semantics), /workspace-write/);
});

test('a Codex Auto session without the report keeps its current semantics', () => {
  for (const flag of [undefined, false]) {
    const semantics = withSessionCapabilities(session(AgentProvider.CODEX, PermissionMode.AUTO, flag), NOW.getTime())
      .permissionSemantics;
    assert.deepEqual(semantics, { mode: PermissionMode.AUTO, unapproved: 'allow', approvalSupport: 'partial', honored: true });
  }
});

test('every other engine and mode keeps its current semantics, reported or not', () => {
  for (const provider of Object.values(AgentProvider)) {
    for (const mode of MODES) {
      if (provider === AgentProvider.CODEX && mode === PermissionMode.AUTO) continue;
      const before = derivePermissionSemantics(provider, mode);
      for (const flag of [undefined, false, true]) {
        assert.deepEqual(
          withSessionCapabilities(session(provider, mode, flag), NOW.getTime()).permissionSemantics,
          before,
          `${provider} ${mode} reported=${String(flag)}`,
        );
      }
    }
  }
});

test('the ingest reads the report off the runner’s sandbox notice, and nothing else', () => {
  const notice = {
    sandboxUnavailable: true,
    noticeKind: 'codex-sandbox-unavailable',
    provider: 'codex',
    notice: "Codex's sandbox is unavailable on Orbit Cloud: commands run unconfined inside your Cloud runner.",
  };
  assert.equal(reportsCodexSandboxUnavailable([{ type: 'system', payload: notice }]), true);
  // The notice as a runner before this report sent it, any other system event, and a non-system event.
  const { sandboxUnavailable: _omit, ...older } = notice;
  assert.equal(reportsCodexSandboxUnavailable([{ type: 'system', payload: older }]), false);
  assert.equal(reportsCodexSandboxUnavailable([{ type: 'system', payload: { subtype: 'init' } }]), false);
  assert.equal(reportsCodexSandboxUnavailable([{ type: 'assistant', payload: { sandboxUnavailable: true } }]), false);
  assert.equal(reportsCodexSandboxUnavailable([]), false);
});

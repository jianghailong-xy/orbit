import { describe, expect, it } from 'vitest';
import { AgentProvider, PermissionMode } from './enums';
import {
  ROOT_FALLBACK_PERMISSION_MODE,
  derivePermissionSemantics,
  permissionModeAvailableOnRunner,
} from './permissionSemantics';

/**
 * The observed failure this rule exists for: a session created with Bypass landed on a runner
 * deployed as root, claude printed "--dangerously-skip-permissions cannot be used with root/sudo
 * privileges for security reasons" and exited during startup, and the session finished FAILED after
 * 5s with zero turns and an empty error column.
 */
describe('permissionModeAvailableOnRunner', () => {
  it('withdraws only Bypass, and only on a root runner', () => {
    expect(permissionModeAvailableOnRunner(PermissionMode.BYPASS, true)).toBe(false);
    expect(permissionModeAvailableOnRunner(PermissionMode.BYPASS, false)).toBe(true);
  });

  it('leaves every other mode available as root', () => {
    // Verified against claude 2.1.233 running as uid 0: each of these reaches its system/init
    // message, so withdrawing any of them would remove a mode that works.
    for (const mode of [
      PermissionMode.DEFAULT,
      PermissionMode.PLAN,
      PermissionMode.ACCEPT_EDITS,
      PermissionMode.AUTO,
      PermissionMode.DONT_ASK,
    ]) {
      expect(permissionModeAvailableOnRunner(mode, true)).toBe(true);
    }
  });

  it('treats an unreported root state as unrestricted', () => {
    // A runner too old to report it must not silently lose Bypass: "we don't know" is not "no".
    expect(permissionModeAvailableOnRunner(PermissionMode.BYPASS, null)).toBe(true);
    expect(permissionModeAvailableOnRunner(PermissionMode.BYPASS, undefined)).toBe(true);
  });

  it("substitutes a mode that is narrower, never broader", () => {
    // Don't Ask denies what Bypass would have allowed, and still never asks — so an unattended
    // session neither parks on an approval card nor gains permissions it was denied.
    expect(ROOT_FALLBACK_PERMISSION_MODE).toBe(PermissionMode.DONT_ASK);
    const asked = derivePermissionSemantics(AgentProvider.CLAUDE, PermissionMode.BYPASS);
    const substituted = derivePermissionSemantics(
      AgentProvider.CLAUDE,
      ROOT_FALLBACK_PERMISSION_MODE,
    );
    expect(asked.unapproved).toBe('allow');
    expect(substituted.unapproved).toBe('deny');
  });
});

describe('derivePermissionSemantics on a root runner', () => {
  it('reports Bypass as unhonored and says why', () => {
    const s = derivePermissionSemantics(
      AgentProvider.CLAUDE,
      PermissionMode.BYPASS,
      'claude-opus-5',
      true,
    );
    expect(s.honored).toBe(false);
    expect(s.unapproved).toBe('deny');
    expect(s.shortNote).toContain('root');
  });

  it('leaves Bypass honored on a non-root runner', () => {
    const s = derivePermissionSemantics(
      AgentProvider.CLAUDE,
      PermissionMode.BYPASS,
      'claude-opus-5',
      false,
    );
    expect(s.honored).toBe(true);
    expect(s.unapproved).toBe('allow');
  });

  it('describes an account-level default without a runner in view', () => {
    // Omitting runsAsRoot is how a fleet-wide setting is described: one root machine in the fleet
    // must not make the account's own default read as unhonored everywhere.
    const s = derivePermissionSemantics(AgentProvider.CLAUDE, PermissionMode.BYPASS);
    expect(s.honored).toBe(true);
  });

  it('still gates Auto by model, independently of root', () => {
    // The two rules are orthogonal; root must not shadow the pre-existing per-model Auto check.
    const s = derivePermissionSemantics(AgentProvider.CLAUDE, PermissionMode.AUTO, 'claude-haiku-4-5', true);
    expect(s.honored).toBe(false);
    expect(s.shortNote).toContain('model');
  });
});

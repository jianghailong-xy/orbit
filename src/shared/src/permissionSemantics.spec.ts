import { describe, expect, it } from 'vitest';
import { AgentProvider, PermissionMode } from './enums';
import {
  ROOT_FALLBACK_PERMISSION_MODE,
  autoAvailable,
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

/**
 * Where the Auto answer comes from. The static list is a fallback for a runner that has not
 * spoken, and the tests below are written so that emptying it changes none of them: every
 * assertion either names a model no list has ever contained, or is about a catalogue row
 * disagreeing with the list.
 *
 * The failure being closed: Opus 5.5 shipped, runners whose CLI could run it reported it in their
 * catalogue, and every picker still refused Auto on it because a set in this file had not been
 * edited. No error was raised anywhere — the mode simply was not offered.
 */
describe('autoAvailable reads the assigned runner’s catalogue', () => {
  const claude = (model: string, permissionModes?: string[]) => ({
    [AgentProvider.CLAUDE]: [{ value: model, label: model, permissionModes }],
  });

  it('offers Auto on a model the runner reports it for, whatever the static list says', () => {
    // A model id in neither static list. This is the whole point: a new release is usable the
    // moment a runner's own CLI reports it, with no client release in between.
    expect(
      autoAvailable(
        AgentProvider.CLAUDE,
        'claude-opus-9',
        false,
        claude('claude-opus-9', [PermissionMode.DEFAULT, PermissionMode.AUTO]),
      ),
    ).toBe(true);
  });

  it('withholds Auto when the runner’s row does, even for a model on the static list', () => {
    // The list can only fill a silence. A row that answered is the answer — including a "no"
    // that contradicts the list, which is what a downgraded CLI or a changed model looks like.
    expect(
      autoAvailable(
        AgentProvider.CLAUDE,
        'claude-opus-5',
        false,
        claude('claude-opus-5', [PermissionMode.DEFAULT, PermissionMode.PLAN]),
      ),
    ).toBe(false);
  });

  it('falls back to the static list only where the catalogue has not answered', () => {
    // Three shapes of silence, none of which may read as "no": no catalogue at all (no runner
    // assigned yet), a catalogue without this model, and a row from a runner too old to report
    // the modes. All three keep the model on the list's answer.
    const stale = { [AgentProvider.CLAUDE]: [{ value: 'claude-opus-5', label: 'Opus 5' }] };
    for (const catalog of [undefined, null, claude('claude-sonnet-5', []), stale]) {
      expect(autoAvailable(AgentProvider.CLAUDE, 'claude-opus-5', false, catalog)).toBe(true);
      expect(autoAvailable(AgentProvider.CLAUDE, 'claude-haiku-4-5', false, catalog)).toBe(false);
    }
  });

  it('never answers a Claude model from another runtime’s rows', () => {
    // The catalogue is keyed by runtime, and Codex's row for a same-named model says nothing
    // about what Claude Code would do with it.
    const codexRows = {
      [AgentProvider.CODEX]: [
        { value: 'claude-opus-9', label: 'x', permissionModes: [PermissionMode.AUTO] },
      ],
    };
    expect(autoAvailable(AgentProvider.CLAUDE, 'claude-opus-9', false, codexRows)).toBe(false);
  });

  it('leaves a configured provider’s vendor-defined model space alone', () => {
    // A BYOK slug borrows the runtime but not its model space, so neither the list nor the
    // runner's Claude rows may police it — the endpoint's own CLI decides.
    expect(
      autoAvailable(AgentProvider.CLAUDE, 'deepseek-v4', true, claude('deepseek-v4', [])),
    ).toBe(true);
  });
});

describe('derivePermissionSemantics follows the catalogue for Auto', () => {
  it('honors Auto on a model the runner reports it for', () => {
    const semantics = derivePermissionSemantics(
      AgentProvider.CLAUDE,
      PermissionMode.AUTO,
      'claude-opus-9',
      false,
      {
        [AgentProvider.CLAUDE]: [
          {
            value: 'claude-opus-9',
            label: 'Opus 9',
            permissionModes: [PermissionMode.DEFAULT, PermissionMode.AUTO],
          },
        ],
      },
    );
    expect(semantics.honored).toBe(true);
    expect(semantics.unapproved).toBe('allow');
    expect(semantics.shortNote).toBeUndefined();
  });

  it('names no models when it explains an absent Auto', () => {
    // The old copy read "Auto needs Opus 5, Fable 5 or Sonnet 5" and was being shown about
    // Opus 5.5 — a model that has Auto. Which models have it is the installed CLI's answer, so
    // the disclosure must not enumerate them.
    const degraded = derivePermissionSemantics(
      AgentProvider.CLAUDE,
      PermissionMode.AUTO,
      'claude-haiku-4-5',
    );
    expect(degraded.honored).toBe(false);
    expect(degraded.note).not.toMatch(/Opus|Sonnet|Fable|Haiku/);
    expect(degraded.shortNote).toMatch(/runs as Default/);
  });
});

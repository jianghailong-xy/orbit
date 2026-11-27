import { describe, expect, it } from 'vitest';
import type { SessionPermissionModeChange } from '@orbit/shared';
import {
  autoMenuNote,
  MODE_SWITCH_WINDOW_MS,
  modeCapsule,
  modeChangeLines,
  type ModeFacts,
} from './sessionPermissionMode';

/**
 * The Mode capsule and the transcript's mode-change lines, state by state as the approved board draws
 * them (docs/mocks/permission-mode-actual; the owner's A1, B1 and C1 of 2026-11-19).
 */

const NOW = Date.parse('2026-11-27T09:00:30Z');
const OPUS: ModeFacts = { intent: 'auto', engine: 'claude', modelHasAuto: true, modelLabel: 'Opus 5.5' };
const HAIKU: ModeFacts = { intent: 'auto', engine: 'claude', modelHasAuto: false, modelLabel: 'Haiku 4.5' };

const change = (
  cause: SessionPermissionModeChange['cause'],
  toMode: string,
  fromMode: string | null = null,
  at = '2026-11-27T09:00:00Z',
  client: string | null = null,
): SessionPermissionModeChange => ({ cause, toMode, fromMode, client, at });

/** A line as the reader sees it: the mode in brackets where it is bold. */
const said = (lines: ReturnType<typeof modeChangeLines>) => lines.map((l) => `${l.before}[${l.mode}]${l.after}${l.gap ? ' (gap)' : ''}`);

describe('the Mode capsule (A1)', () => {
  it('① shows the mode running, with no mark, when it is the one asked for', () => {
    const capsule = modeCapsule({ ...OPUS, actual: 'auto', now: NOW });
    expect(capsule).toMatchObject({ mode: 'auto', gap: 'none', label: 'Auto', to: null, reason: null });
  });

  it('① shows what the engine runs in, not the stored mode', () => {
    expect(modeCapsule({ ...OPUS, intent: 'plan', actual: 'plan', now: NOW }).label).toBe('Plan');
    expect(modeCapsule({ ...OPUS, intent: 'acceptEdits', actual: 'acceptEdits', now: NOW }).label).toBe('Accept Edits');
  });

  it('② short gap: Claude started in Default and the runner is switching it — "Default → Auto" with its reason', () => {
    const latest = change('ENGINE_REPORT', 'default', 'auto', '2026-11-27T09:00:20Z');
    const capsule = modeCapsule({ ...OPUS, actual: 'default', latest, now: NOW });
    expect(capsule).toMatchObject({ mode: 'default', gap: 'switching', label: 'Default → Auto', to: 'Auto' });
    expect(capsule.reason).toEqual({
      lead: 'Running in Default.',
      rest: 'Claude started below the Auto you asked for; the runner is switching it to Auto now.',
    });
    expect(capsule.switchingUntil).toBe(Date.parse('2026-11-27T09:00:20Z') + MODE_SWITCH_WINDOW_MS);
  });

  it('② a re-spawn that came back below Auto is switched back the same way', () => {
    const latest = change('RESPAWN', 'default', 'auto', '2026-11-27T09:00:20Z');
    expect(modeCapsule({ ...OPUS, actual: 'default', latest, now: NOW }).gap).toBe('switching');
  });

  it('② a switch that has not happened in its window is not "switching now" any more: the gap lasts, amber', () => {
    const latest = change('ENGINE_REPORT', 'default', 'auto', '2026-11-27T08:59:00Z');
    const capsule = modeCapsule({ ...OPUS, actual: 'default', latest, now: NOW });
    expect(capsule).toMatchObject({ gap: 'lasting', label: 'Default', to: null, switchingUntil: null });
    expect(capsule.reason?.rest).toBe('Claude started below the Auto you asked for, and the runner hasn’t switched it back.');
  });

  it('② lasting gap: a model with no Auto runs Default, and the reason names the model and the way back', () => {
    const latest = change('OWNER_PICK', 'default', 'auto', '2026-11-27T08:50:00Z', 'web');
    const capsule = modeCapsule({ ...HAIKU, actual: 'default', latest, now: NOW });
    expect(capsule).toMatchObject({ mode: 'default', gap: 'lasting', label: 'Default' });
    expect(capsule.reason).toEqual({
      lead: 'Running in Default.',
      rest: 'You asked for Auto, but Haiku 4.5 has no Auto. Pick a model with Auto to get it back.',
    });
  });

  it('② lasting gap: Bypass on a root runner runs as Auto, and says why', () => {
    const capsule = modeCapsule({ ...OPUS, intent: 'bypassPermissions', runsAsRoot: true, actual: 'auto', now: NOW });
    expect(capsule).toMatchObject({ gap: 'lasting', label: 'Auto' });
    expect(capsule.reason).toEqual({ lead: 'Running in Auto.', rest: 'You asked for Bypass, but Bypass can’t run on a root runner.' });
  });

  it('a pick of this client on its way to the engine reads as a switch, then as a gap if the engine never takes it', () => {
    const pickedAt = NOW - 2_000;
    const switching = modeCapsule({ ...OPUS, intent: 'plan', actual: 'auto', pickedAt, now: NOW });
    expect(switching).toMatchObject({ gap: 'switching', label: 'Auto → Plan', reason: { lead: 'Running in Auto.', rest: 'Switching to Plan now.' } });
    const late = modeCapsule({ ...OPUS, intent: 'plan', actual: 'auto', pickedAt, now: pickedAt + MODE_SWITCH_WINDOW_MS });
    expect(late).toMatchObject({ gap: 'lasting', label: 'Auto', reason: { rest: 'You asked for Plan; the engine hasn’t switched yet.' } });
  });

  it('a scheduled run on Claude runs in Auto by design: no gap', () => {
    expect(modeCapsule({ ...OPUS, intent: 'default', scheduled: true, actual: 'auto', now: NOW }).gap).toBe('none');
  });

  it('④ before it starts, a model with Auto shows Auto with no hint', () => {
    expect(modeCapsule({ ...OPUS, now: NOW })).toMatchObject({ gap: 'none', label: 'Auto', reason: null });
    expect(modeCapsule({ ...OPUS, actual: null, now: NOW }).label).toBe('Auto');
  });

  it('④ before it starts (C1), a model with no Auto shows the Default it will start in and keeps the pick', () => {
    const capsule = modeCapsule({ ...HAIKU, now: NOW });
    expect(capsule).toMatchObject({ mode: 'default', gap: 'lasting', label: 'Default' });
    expect(capsule.reason).toEqual({
      lead: 'Starts in Default.',
      rest: 'Haiku 4.5 has no Auto; your pick stays Auto and applies on a model that has it.',
    });
  });

  it('other engines run what they were handed: no guess about Auto', () => {
    expect(modeCapsule({ ...HAIKU, engine: 'codex', now: NOW }).gap).toBe('none');
  });
});

describe('the Auto row of the Mode menu (C1)', () => {
  it('names the model and what the session does instead, stays quiet where the model has Auto', () => {
    expect(autoMenuNote(HAIKU, true)).toBe('not on Haiku 4.5, runs as Default');
    expect(autoMenuNote(HAIKU, false)).toBe('not on Haiku 4.5, starts in Default');
    expect(autoMenuNote(OPUS, false)).toBeNull();
    expect(autoMenuNote({ ...HAIKU, engine: 'kimi' }, true)).toBeNull();
  });
});

describe('the transcript line for a mode change (B1), one per cause', () => {
  it('the owner, with the app they were on', () => {
    const lines = modeChangeLines(
      [
        change('OWNER_PICK', 'auto', 'plan', '2026-11-27T14:02:00Z', 'web'),
        change('OWNER_PICK', 'acceptEdits', 'auto', '2026-11-27T14:06:00Z', 'ios'),
        change('OWNER_PICK', 'plan', 'acceptEdits', '2026-11-27T14:07:00Z', 'macos'),
        change('OWNER_PICK', 'auto', 'plan', '2026-11-27T14:09:00Z', 'android'),
        change('OWNER_PICK', 'plan', 'auto', '2026-11-27T14:10:00Z', 'terminal'),
        change('OWNER_PICK', 'auto', 'plan', '2026-11-27T14:11:00Z', null),
      ],
      { ...OPUS, actual: 'auto' },
    );
    expect(said(lines)).toEqual([
      'Mode set to [Auto] by you, on the web',
      'Mode set to [Accept Edits] by you, on iOS',
      'Mode set to [Plan] by you, on the Mac',
      'Mode set to [Auto] by you, on Android',
      'Mode set to [Plan] by you, in the terminal',
      'Mode set to [Auto] by you',
    ]);
  });

  it('a runner correction says what Claude had started in, in one line with the report it corrected', () => {
    const lines = modeChangeLines(
      [
        change('CLAIM', 'auto', null, '2026-11-19T03:04:52Z'),
        change('ENGINE_REPORT', 'default', 'auto', '2026-11-19T03:04:53Z'),
        change('RUNNER_CORRECTION', 'auto', 'default', '2026-11-19T03:04:55Z'),
      ],
      { ...OPUS, actual: 'auto' },
    );
    // The first claim in the mode asked for is how every session starts: no line.
    expect(said(lines)).toEqual(['Mode set back to [Auto] by the runner — Claude had started in Default']);
  });

  it('Claude starting below Auto, before the runner has corrected it, is the gap’s line', () => {
    const lines = modeChangeLines([change('CLAIM', 'auto'), change('ENGINE_REPORT', 'default', 'auto')], { ...OPUS, actual: 'default' });
    expect(said(lines)).toEqual(['Claude started in [Default], not Auto (gap)']);
  });

  it('a re-spawn', () => {
    const lines = modeChangeLines([change('RESPAWN', 'auto', 'default', '2026-11-27T14:21:00Z')], { ...OPUS, actual: 'auto' });
    expect(said(lines)).toEqual(['Claude restarted; mode [Auto] re-applied']);
  });

  it('claim-time substitutions: Bypass on a root runner, a scheduled run, a resume', () => {
    expect(
      said(modeChangeLines([change('CLAIM', 'auto')], { ...OPUS, intent: 'bypassPermissions', runsAsRoot: true, actual: 'auto' })),
    ).toEqual(['Started in [Auto], not Bypass — Bypass can’t run on a root runner (gap)']);
    expect(said(modeChangeLines([change('CLAIM', 'auto')], { ...OPUS, intent: 'default', scheduled: true, actual: 'auto' }))).toEqual([
      'Started in [Auto] — scheduled runs always use Auto',
    ]);
    expect(said(modeChangeLines([change('CLAIM', 'plan', 'auto')], { ...OPUS, intent: 'plan', actual: 'plan' }))).toEqual(['Resumed in [Plan]']);
  });

  it('a pick of a model with no Auto says so, amber while the gap stands', () => {
    const lines = modeChangeLines(
      [change('OWNER_PICK', 'auto', null, '2026-11-27T14:02:00Z', 'web'), change('OWNER_PICK', 'default', 'auto', '2026-11-27T14:30:00Z', 'web')],
      { ...HAIKU, actual: 'default' },
    );
    expect(said(lines)).toEqual(['Mode set to [Auto] by you, on the web', 'Mode now [Default] — you picked Haiku 4.5, which has no Auto (gap)']);
  });

  it('a change Orbit made', () => {
    expect(said(modeChangeLines([change('ORBIT_CHANGE', 'auto', 'plan')], { ...OPUS, actual: 'auto' }))).toEqual(['Mode set to [Auto] by Orbit']);
  });

  it('only the change behind a gap still open is amber, and no line of a session not running is', () => {
    const changes = [change('ENGINE_REPORT', 'default', 'auto', '2026-11-27T09:00:00Z'), change('OWNER_PICK', 'plan', 'default', '2026-11-27T09:05:00Z', 'web')];
    expect(modeChangeLines(changes, { ...OPUS, intent: 'auto', actual: 'plan' }).map((l) => l.gap)).toEqual([false, true]);
    expect(modeChangeLines(changes, { ...OPUS, intent: 'auto', actual: null }).map((l) => l.gap)).toEqual([false, false]);
  });
});

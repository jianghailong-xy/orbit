import { describe, expect, it } from 'vitest';
import { AgentProvider, ALL_ENGINES, type RunnerEngineHealth, type RunnerEngineUpdate } from '@orbit/shared';
import { ENGINE_CLI_NAME, engineUpdateDismissedFor, updateNoteOf, webShowsEngine } from './runnerEngines';

const { CLAUDE, CODEX, KIMI, ANTIGRAVITY, OPENCODE, DSH, CURSOR } = AgentProvider;

const health = (engine: RunnerEngineHealth['engine'], over: Partial<RunnerEngineHealth> = {}): RunnerEngineHealth => ({
  engine,
  installed: true,
  auth: 'yes',
  ...over,
});

describe('the engines the web draws', () => {
  // A runner from before Cursor CLI: it reports the six engines it knows, and declares none of Cursor's.
  const older = { capabilities: ['provider:dsh'], engines: [health('claude'), health('codex')] };
  // A runner that knows Cursor CLI reports it whether or not it is installed there (P3).
  const knows = {
    capabilities: ['provider:dsh'],
    engines: [health('claude'), health('cursor', { installed: false, installationError: 'CURSOR_NOT_INSTALLED: …' })],
  };
  // …and declares it once the pinned build is ready (P1).
  const declares = { capabilities: ['provider:dsh', 'provider:cursor'], engines: [health('claude')] };

  it('leaves Cursor CLI out until a runner of the account knows it, and draws every other engine as before', () => {
    expect(ALL_ENGINES).toContain(CURSOR);
    for (const runners of [null, undefined, [], [older]]) {
      expect(ALL_ENGINES.filter((engine) => webShowsEngine(engine, runners))).toEqual([CLAUDE, CODEX, KIMI, ANTIGRAVITY, OPENCODE, DSH]);
    }
    // Named like every engine, so a report of it never reads as a blank, though none is drawn.
    expect(ENGINE_CLI_NAME.cursor).toBe('Cursor CLI');
  });

  it('draws Cursor CLI, last, once one runner reports it or declares it — the others then say why they can’t run it', () => {
    for (const runners of [[knows], [declares], [older, knows]]) {
      expect(ALL_ENGINES.filter((engine) => webShowsEngine(engine, runners))).toEqual([
        CLAUDE,
        CODEX,
        KIMI,
        ANTIGRAVITY,
        OPENCODE,
        DSH,
        CURSOR,
      ]);
    }
  });
});

describe('what a pinned engine says about being kept current', () => {
  const now = Date.parse('2026-10-17T07:00:00Z');
  const checked: RunnerEngineUpdate = {
    status: 'checked',
    at: '2026-10-17T06:54:00Z',
    okAt: '2026-10-17T06:54:00Z',
    message: 'Pinned to 2026.10.14-941492e; newer Cursor CLI releases are not followed.',
  } as RunnerEngineUpdate;

  it('says “pinned” before its check, as Cursor CLI’s row writes it, and leaves every other engine’s note alone', () => {
    expect(updateNoteOf(checked, now, true)).toEqual({ tone: 'quiet', text: 'pinned · checked 6m ago' });
    expect(updateNoteOf(checked, now)).toEqual({ tone: 'quiet', text: 'checked 6m ago' });
  });
});

describe('an engine update warning dismissed until the next release', () => {
  // orbit@austin's Codex: 13 days behind 0.169.0, its update failing.
  const now = Date.parse('2026-11-14T00:00:00Z');
  const behind = (latest: string): RunnerEngineUpdate => ({
    status: 'failed',
    at: '2026-11-13T23:30:00Z',
    okAt: '2026-10-31T00:00:00Z',
    latest,
    behindSince: '2026-10-31T20:00:00Z',
  });

  it('goes quiet while the dismissed release is still the latest, and keeps the drift in the version line', () => {
    expect(updateNoteOf(behind('0.169.0'), now)).toEqual({ tone: 'warn', text: '13d behind 0.169.0' });
    expect(updateNoteOf(behind('0.169.0'), now, false, '0.169.0')).toEqual({
      tone: 'quiet',
      text: '13d behind 0.169.0 · warning dismissed',
    });
  });

  it('warns again once a newer release is out, the behind clock never reset', () => {
    expect(updateNoteOf(behind('0.170.0'), now, false, '0.169.0')).toEqual({ tone: 'warn', text: '13d behind 0.170.0' });
  });

  it('leaves a note that is not a warning alone, and reads the dismissal off the runner by engine', () => {
    const current: RunnerEngineUpdate = { status: 'checked', at: '2026-11-13T23:54:00Z', okAt: '2026-11-13T23:54:00Z', latest: '0.169.0' };
    expect(updateNoteOf(current, now, false, '0.169.0')).toEqual({ tone: 'quiet', text: 'checked 6m ago' });
    const runner = { engineUpdateDismissals: { codex: '0.169.0' } };
    expect(engineUpdateDismissedFor(runner, 'codex')).toBe('0.169.0');
    expect(engineUpdateDismissedFor(runner, 'claude')).toBeNull();
    expect(engineUpdateDismissedFor({}, 'codex')).toBeNull();
  });
});

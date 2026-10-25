import { describe, expect, it } from 'vitest';
import { AgentProvider, ALL_ENGINES, type RunnerEngineHealth, type RunnerEngineUpdate } from '@orbit/shared';
import { ENGINE_CLI_NAME, updateNoteOf, webShowsEngine } from './runnerEngines';

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

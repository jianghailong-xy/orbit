import { describe, expect, it } from 'vitest';
import { AgentProvider, ALL_ENGINES } from '@orbit/shared';
import { ENGINE_CLI_NAME, webShowsEngine } from './runnerEngines';

const { CLAUDE, CODEX, KIMI, ANTIGRAVITY, OPENCODE, DSH, CURSOR } = AgentProvider;

describe('the engines the web draws', () => {
  it('leaves Cursor CLI out until its screens ship, and draws every other engine as before', () => {
    // Registered as an engine (project P1), offered by no web list until P7a.
    expect(ALL_ENGINES).toContain(CURSOR);
    expect(webShowsEngine(CURSOR)).toBe(false);
    expect(ALL_ENGINES.filter(webShowsEngine)).toEqual([CLAUDE, CODEX, KIMI, ANTIGRAVITY, OPENCODE, DSH]);
    // Named like every engine, so a report of it never reads as a blank, though none is drawn.
    expect(ENGINE_CLI_NAME.cursor).toBe('Cursor CLI');
  });
});

import { describe, expect, it } from 'vitest';
import {
  LOCAL_SLASH_ITEMS,
  isLocalSlashCommand,
  localStatusRows,
  openSlash,
  pickSlash,
  slashCommandName,
  slashMatches,
  slashToken,
} from './slashCommands';

describe('slashCommands', () => {
  it('detects an active slash token at the cursor word', () => {
    expect(slashToken('')).toBeNull();
    expect(slashToken('hello')).toBeNull();
    expect(slashToken('hello/foo')).toBeNull();
    expect(slashToken('/foo bar')).toBeNull();
    expect(slashToken('/')).toBe('');
    expect(slashToken('/status')).toBe('status');
    expect(slashToken('hello /sta')).toBe('sta');
  });

  it('parses only whole-draft slash command names', () => {
    expect(slashCommandName('hello /status')).toBeNull();
    expect(slashCommandName('/status')).toBe('status');
    expect(slashCommandName('  /status now  ')).toBe('status');
    expect(slashCommandName('/')).toBe('');
  });

  it('matches local and runner slash items with scope filtering', () => {
    const items = [
      ...LOCAL_SLASH_ITEMS,
      { name: 'commit', type: 'command' as const },
      { name: 'compose', type: 'skill' as const },
    ];
    expect(slashMatches(items, '', null).map((it) => it.name)).toEqual(['commit', 'compose', 'status']);
    expect(slashMatches(items, 'sta', null).map((it) => it.name)).toEqual(['status']);
    expect(slashMatches(items, '', 'command').map((it) => it.name)).toEqual(['commit']);
    expect(isLocalSlashCommand('STATUS')).toBe(true);
  });

  it('edits slash tokens without clobbering surrounding text', () => {
    expect(pickSlash('/sta', 'status')).toBe('/status ');
    expect(pickSlash('hello /sta', 'status')).toBe('hello /status ');
    expect(openSlash('')).toBe('/');
    expect(openSlash('hi ')).toBe('hi /');
    expect(openSlash('hi')).toBe('hi /');
  });

  it('formats status rows without inventing unreported context', () => {
    expect(
      localStatusRows({
        surface: 'Web',
        runnerName: 'dev',
        runnerOnline: true,
        activeSessions: 1,
        maxConcurrent: 2,
        sessionTitle: 'Fix bug',
        sessionStatus: 'Running',
        model: 'gpt-5.6-sol',
        effort: '',
        contextTokens: 94_500,
        contextWindow: 372_000,
        planUsageLabel: 'Primary limit',
        planUsagePercent: 41.4,
      }),
    ).toContainEqual({ label: 'Context', value: '25% (95k / 372k tokens)' });

    expect(localStatusRows({ surface: 'Web' })).toContainEqual({
      label: 'Context',
      value: 'not reported yet',
    });
  });
});

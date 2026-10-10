import { describe, expect, it } from 'vitest';
import {
  LOCAL_SLASH_ITEMS,
  isLocalSlashCommand,
  localStatusRows,
  openSlash,
  pickSlash,
  slashAssetMatchesEngine,
  slashCommandName,
  slashMatches,
  slashToken,
  supportsRunnerSlashAssets,
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

  it('treats OpenCode slash input like Codex rather than Claude assets', () => {
    expect(supportsRunnerSlashAssets('opencode')).toBe(false);
    expect(supportsRunnerSlashAssets('codex')).toBe(false);
    expect(supportsRunnerSlashAssets('claude')).toBe(true);
    expect(slashAssetMatchesEngine(undefined, 'opencode')).toBe(false);
    expect(slashAssetMatchesEngine('claude', 'opencode')).toBe(false);
  });

  it('treats Antigravity slash input as a prompt too — agy runs with its slash commands off', () => {
    expect(supportsRunnerSlashAssets('antigravity')).toBe(false);
    expect(slashAssetMatchesEngine(undefined, 'antigravity')).toBe(false);
    expect(slashAssetMatchesEngine('claude', 'antigravity')).toBe(false);
  });

  it('reads slash-led prose as text, not as a command', () => {
    expect(slashCommandName('/tmp/orbit-codex-usage-state 删掉吧')).toBeNull();
    expect(slashCommandName('/root/orbit')).toBeNull();
    expect(slashCommandName('/dev/null 是什么')).toBeNull();
    expect(slashCommandName('// TODO: fix this')).toBeNull();
    expect(slashCommandName('/删掉这个目录')).toBeNull();
    // Still a command name: dots, dashes and namespace colons are legal in one.
    expect(slashCommandName('/code-review')).toBe('code-review');
    expect(slashCommandName('/plugin:skill arg')).toBe('plugin:skill');
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

  it('keeps Kimi runner commands and skills while limiting Codex', () => {
    expect(supportsRunnerSlashAssets('codex')).toBe(false);
    expect(supportsRunnerSlashAssets('kimi')).toBe(true);
    expect(supportsRunnerSlashAssets('claude')).toBe(true);
  });

  it('keeps each engine’s slash registry to itself', () => {
    expect(slashAssetMatchesEngine(undefined, 'claude')).toBe(true);
    expect(slashAssetMatchesEngine('claude', 'claude')).toBe(true);
    expect(slashAssetMatchesEngine('kimi', 'claude')).toBe(false);

    expect(slashAssetMatchesEngine('kimi', 'kimi')).toBe(true);
    expect(slashAssetMatchesEngine(undefined, 'kimi')).toBe(false);
    expect(slashAssetMatchesEngine('claude', 'kimi')).toBe(false);

    expect(slashAssetMatchesEngine(undefined, 'codex')).toBe(false);
    expect(slashAssetMatchesEngine('kimi', 'codex')).toBe(false);
  });

  it('asks the session’s engine, never its provider’s slug', () => {
    // A key's slug names no engine. Read as one, a Moonshot key's session (on Kimi Code) got Claude's
    // commands, and a Responses key's session (on Codex) a registry Codex does not have: the caller
    // hands over the engine the session records instead.
    expect(supportsRunnerSlashAssets('kimi')).toBe(true);
    expect(slashAssetMatchesEngine('kimi', 'kimi')).toBe(true);
    expect(slashAssetMatchesEngine(undefined, 'kimi')).toBe(false);
    // DeepSeek Harness has none of its own; the same DeepSeek key on Claude Code has Claude Code's.
    expect(supportsRunnerSlashAssets('dsh')).toBe(false);
    expect(slashAssetMatchesEngine('claude', 'dsh')).toBe(false);
    expect(slashAssetMatchesEngine(undefined, 'claude')).toBe(true);
  });

  it('says which engine and which credential the session runs on in /status', () => {
    const rows = localStatusRows({ surface: 'Web', engine: 'DeepSeek Harness', provider: 'DeepSeek 2' });
    expect(rows).toContainEqual({ label: 'Engine', value: 'DeepSeek Harness' });
    expect(rows).toContainEqual({ label: 'Provider', value: 'DeepSeek 2' });
    expect(rows.findIndex((row) => row.label === 'Engine')).toBeLessThan(rows.findIndex((row) => row.label === 'Provider'));
  });

  it("ranks the CLI's built-in registry below the user's own assets", () => {
    const items = [
      { name: 'loop', type: 'skill' as const, builtin: true },
      { name: 'commit', type: 'command' as const },
      { name: 'clear', type: 'command' as const, builtin: true },
      { name: 'release', type: 'skill' as const },
    ];
    expect(slashMatches(items, '', null).map((it) => it.name)).toEqual([
      'commit',
      'release',
      'clear',
      'loop',
    ]);
    // A prefix match still wins over ownership — typing `/lo` must surface /loop.
    expect(slashMatches(items, 'lo', null).map((it) => it.name)).toEqual(['loop']);
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

  it('names the fast lane only while the session is in it', () => {
    const labels = (rows: { label: string }[]) => rows.map((r) => r.label);

    expect(labels(localStatusRows({ surface: 'Web', fastMode: true }))).toContain('Fast mode');
    // The paired negative, which is the whole reason this row is conditional: off and "this
    // runtime has no fast lane at all" arrive here as the same value, so an unconditional row
    // would name the setting on every Codex and Kimi session too.
    expect(labels(localStatusRows({ surface: 'Web', fastMode: false }))).not.toContain('Fast mode');
    expect(labels(localStatusRows({ surface: 'Web' }))).not.toContain('Fast mode');
  });
});

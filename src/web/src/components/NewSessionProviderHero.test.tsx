import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { NewSessionProviderHero, type NewSessionPlace } from './NewSessionProviderHero';
import { currentEngineChoice, draftFallback, engineChoices, type ChoiceSources } from '../lib/sessionProviderChoices';
import { defaultEngineOf, type ConfiguredProvider } from '../lib/workspaceDefaults';
import { AgentProvider, type RunnerAntigravityState, type RunnerEngineHealth } from '@orbit/shared';

const configured: ConfiguredProvider[] = [
  {
    slug: 'deepseek',
    label: 'DeepSeek',
    runtime: 'claude',
    models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
    defaultModel: 'deepseek-v4-pro',
    presetSlug: 'deepseek',
  },
  {
    slug: 'moonshot',
    label: 'Kimi (Moonshot)',
    runtime: 'kimi',
    models: [{ value: 'kimi-k3', label: 'Kimi K3' }],
    defaultModel: 'kimi-k3',
    presetSlug: 'moonshot',
  },
];
const catalog = { claude: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }] } as never;

const RUNNER_ID = '019fc086-c7c7-7c92-8215-778ad8a6280a';

function markup(
  provider: string,
  opts: {
    disabled?: boolean;
    note?: string;
    engines?: RunnerEngineHealth[];
    currentModelLabel?: string;
    projectIntent?: boolean;
    antigravity?: RunnerAntigravityState;
    region?: ChoiceSources['region'];
    place?: NewSessionPlace | null;
  } = {},
) {
  const sources: ChoiceSources = {
    configured,
    modelCatalog: catalog,
    engineHealth: opts.engines,
    antigravity: opts.antigravity,
    region: opts.region,
  };
  // As WorkspaceView builds them: each engine lands on the pick when it is that engine's, and the
  // current one is the pick's own engine on the pick itself, listed there or not.
  const engine = defaultEngineOf(provider, configured) ?? AgentProvider.CLAUDE;
  const engines = engineChoices(sources, [{ engine, provider }]);
  return renderToStaticMarkup(
    <MemoryRouter>
      <NewSessionProviderHero
        current={currentEngineChoice(engine, provider, engines, sources)}
        engines={engines}
        onPick={() => {}}
        runnerId={RUNNER_ID}
        disabled={opts.disabled}
        note={opts.note}
        currentModelLabel={opts.currentModelLabel}
        projectIntent={opts.projectIntent}
        place={opts.place}
      />
    </MemoryRouter>,
  );
}

describe('NewSessionProviderHero', () => {
  it('names Antigravity alone, by its CLI’s name, however it signs in — that is the Provider menu’s to say', () => {
    const html = markup('antigravity');
    expect(html).toContain('aria-label="Engine: Antigravity CLI"');
    expect(html).not.toContain('env key');
    expect(html).not.toContain('Google account');
    expect(html).not.toContain('Managed by the provider');
  });

  it.each([
    [{ supported: false, installed: true, version: '1.2.16', envKeyAvailable: false }, 'Update runner'],
    [{ supported: true, installed: false, version: null, envKeyAvailable: false }, 'Not installed'],
  ] as const)('links a hidden Antigravity current value to its runner installation row: %s', (state, label) => {
    const html = markup('antigravity', { antigravity: state });
    expect(html).toContain(label);
    expect(html).toContain('engine=antigravity');
  });

  it('uses the iOS empty-state hierarchy for an ordinary new session', () => {
    const html = markup('claude');

    // Under the engine and where it runs, nothing more: no instruction line (owner 2026-11-27).
    expect(html).not.toContain('Send a task to get started.');
    expect(html).not.toContain('np-empty-copy');
    // The model is said once, in the composer (docs/mocks/new-session-top ③).
    expect(html).not.toContain('np-current-model');
    expect(html).not.toContain('Claude Opus 5');
    expect(html).not.toContain('Start a new session');
    expect(html).not.toContain('Orbit remembers who runs it.');
    expect(html).not.toContain('Start a new project');
    expect(html).not.toContain('define the goal, acceptance criteria, and task breakdown together.');
  });

  it('switches only the framing copy for a project-intent session', () => {
    const html = markup('claude', { projectIntent: true });

    expect(html).toContain('<div class="np-title">Start a new project</div>');
    expect(html).toContain(
      '<div class="np-sub">Describe what you want done — define the goal, acceptance criteria, and task breakdown together.</div>',
    );
    expect(html).not.toContain('Start a new session');
    expect(html).not.toContain('Orbit remembers who runs it.');
    // Where what it runs on is managed: Infrastructure.
    expect(html).toContain(`<a href="/settings/machines/${encodeId(RUNNER_ID)}"`);
    expect(html).toMatch(/<a href="\/settings\/machines\/[^"]*"[^>]*>Manage<\/a>/);
  });

  it('shows the current engine as the collapsed identity, its CLI’s name under the mark', () => {
    const html = markup('claude');
    // Mark first, name second — the vertical order is the point of the layout.
    expect(html.indexOf('np-mark')).toBeLessThan(html.indexOf('np-name'));
    expect(html).toContain('Claude Code');
    expect(html).toContain('np-chev');
  });

  it('names the draft model rather than the provider default in the project summary', () => {
    const html = markup('claude', { currentModelLabel: 'Claude Sonnet 5', projectIntent: true });

    expect(html).toContain('Claude Sonnet 5');
    expect(html).not.toContain('Claude Opus 5');
  });

  describe('where the session runs (docs/mocks/new-session-place)', () => {
    const place = (over: Partial<NewSessionPlace> = {}): NewSessionPlace => ({
      workspace: { id: 'w1', name: 'orbit-ws01' },
      workspaces: [{ id: 'w1', name: 'orbit-ws01' }, { id: 'w2', name: 'orbit-ws02' }],
      folder: { id: 'f1', name: 'Orbit Session' },
      folders: [{ id: 'f1', name: 'Orbit Session', workspaceId: 'w1' }, { id: 'f2', name: 'Releases', workspaceId: 'w1' }],
      onPick: () => {},
      ...over,
    });

    it('says the workspace and the folder in one pill under the engine', () => {
      const html = markup('claude', { place: place() });
      expect(html.indexOf('np-name')).toBeLessThan(html.indexOf('np-place'));
      expect(html.match(/np-place-pill/g)).toHaveLength(1);
      expect(html).toContain('aria-label="Runs in: orbit-ws01 / Orbit Session"');
      expect(html).toContain('np-place-slash');
    });

    it('names the workspace alone when the draft is in no folder', () => {
      const html = markup('claude', { place: place({ folder: null }) });
      expect(html).toContain('aria-label="Runs in: orbit-ws01"');
      expect(html).not.toContain('No folder');
      expect(html).not.toContain('np-place-slash');
    });

    it('draws no place pill before the workspace is known', () => {
      expect(markup('claude')).not.toContain('np-place');
    });
  });

  it('drops the chevron when there is nothing to pick', () => {
    expect(markup('claude', { disabled: true })).not.toContain('np-chev');
  });

  it('renders the switch note when one is given', () => {
    expect(markup('deepseek', { note: 'Model → DeepSeek V4 Pro' })).toContain(
      'Model → DeepSeek V4 Pro',
    );
    expect(markup('deepseek')).not.toContain('np-note');
  });

  it('warns in the summary when the current engine has no CLI on this runner', () => {
    // The pick is sticky: without this the hero reads "Kimi · Kimi for Coding · runner login" and
    // the first hint that kimi isn't installed is a failed session minutes later.
    const html = markup('kimi', {
      engines: [{ engine: 'kimi', installed: false, auth: 'unknown' }],
    });
    // Named by the engine — it is the engine's own sign-in that cannot run.
    expect(html).toContain('<b>Kimi Code</b>');
    expect(html).toContain('Not installed on this runner');
    expect(html).toContain('engine=kimi');
    expect(html).not.toContain('runner login');
    // Its fix is that engine's row on this machine's card on the Machines & models page.
    expect(html).toContain(`<a href="/settings/machines/${encodeId(RUNNER_ID)}?engine=kimi"`);
    expect(html).toMatch(/<a href="\/settings\/machines\/[^"]*"[^>]*>Fix it<\/a>/);
  });

  it('sends a key’s fix to the engine that runs it, not to its own slug', () => {
    // Kimi (Moonshot) runs on Kimi Code, and `moonshot` has no row on the Machines & models page to land on —
    // the install that fixes it is the kimi engine's.
    const html = markup('moonshot', {
      engines: [{ engine: 'kimi', installed: false, auth: 'unknown' }],
    });
    expect(html).toContain('Not installed on this runner');
    expect(html).toContain('engine=kimi');
    expect(html).not.toContain('engine=moonshot');
  });

  it('offers OpenCode on a runner that has not got it, with the install and never a sign-in', () => {
    // Orbit installs it, so the row is listed rather than dropped — and it has no sign-in to relay,
    // so the reason must not promise one (web parity: mirror of AgentIdentity's row). A runner that
    // reports its engines and not OpenCode has not got it.
    const report = [{ engine: 'claude' as const, installed: true, auth: 'yes' as const }];
    const html = markup('opencode', { engines: report });
    const engines = engineChoices({ configured, modelCatalog: catalog, engineHealth: report }, [{ engine: 'opencode', provider: 'opencode' }]);
    const row = engines.find((engine) => engine.slug === 'opencode');
    expect(row).toMatchObject({ label: 'OpenCode', unavailable: 'Not installed', fixEngine: 'opencode' });
    expect(html).toContain('aria-label="Engine: OpenCode"');
    expect(html).toContain('Not installed');
    expect(html).toContain('engine=opencode');
    expect(html).not.toContain('sign in');
  });

  it('names the engine on the card, and not the provider of it the draft spends', () => {
    const html = markup('deepseek');
    expect(html).toContain('aria-label="Engine: Claude Code"');
    expect(html).not.toContain('DeepSeek</small>');
    expect(html).not.toContain('via ');
  });

  // Board 02 C: the draft is on Claude Code's own sign-in on a runner blocked for the Claude region.
  // Nothing on the page fixes that, so the link explains — it goes to the machine's Claude Code row.
  it('says Details, not Fix it, where the runner’s Claude region is why the pick cannot run', () => {
    const html = markup('claude', { region: { verdict: 'blocked' } });
    expect(html).toContain('<b>Claude Code</b>');
    expect(html).toContain('Region not supported on this runner');
    expect(html).toMatch(
      new RegExp(`<a href="/settings/machines/${encodeId(RUNNER_ID)}\\?engine=claude"[^>]*>Details</a>`),
    );
    expect(html).not.toContain('Fix it');
  });

  it('draws what it draws today for a runner that reads no region, or an allowed one', () => {
    expect(markup('claude', { region: null })).toBe(markup('claude'));
    expect(markup('claude', { region: { verdict: 'allowed' } })).toBe(markup('claude'));
    expect(markup('claude')).not.toContain('Region not supported');
  });
});

/**
 * The draft moved off what the workspace last ran on, because it can't run on this machine (board
 * docs/mocks/new-session-usable-default): as WorkspaceView wires it, the hero is on the fallback and
 * names what it moved from.
 */
describe('NewSessionProviderHero on a fallback', () => {
  const blocked = { verdict: 'blocked' as const };
  const claudeIn: RunnerEngineHealth = { engine: 'claude', installed: true, auth: 'yes' };
  const codexIn: RunnerEngineHealth = { engine: 'codex', installed: true, auth: 'yes' };
  const anthropic: ConfiguredProvider = {
    slug: 'anthropic',
    label: 'Personal Max',
    runtime: 'claude',
    models: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }],
    defaultModel: 'claude-opus-5',
    presetSlug: 'anthropic',
    engines: ['claude'],
  };
  function fallbackMarkup(provider: string, keys: ConfiguredProvider[], engines: RunnerEngineHealth[]) {
    const sources: ChoiceSources = { configured: keys, modelCatalog: catalog, engineHealth: engines, region: blocked };
    const engine = AgentProvider.CLAUDE;
    const choices = engineChoices(sources, [{ engine, provider }]);
    const remembered = currentEngineChoice(engine, provider, choices, sources);
    const to = draftFallback(remembered, choices, engines);
    return renderToStaticMarkup(
      <MemoryRouter>
        <NewSessionProviderHero
          current={to ? currentEngineChoice(to.engine, to.provider, choices, sources) : remembered}
          engines={choices}
          onPick={() => {}}
          runnerId={RUNNER_ID}
          fellBackFrom={to ? remembered : null}
          machine="jdcloud"
          cantRun={!to}
        />
      </MemoryRouter>,
    );
  }

  it('says which credential it uses now and why, under the same engine (board ②)', () => {
    const html = fallbackMarkup('claude', [configured[0], anthropic], [claudeIn]);
    expect(html).toContain('aria-label="Engine: Claude Code"');
    expect(html).toContain('Using <b>DeepSeek</b>');
    expect(html).toContain('Anthropic unavailable on jdcloud');
    expect(html).toMatch(new RegExp(`<a href="/settings/machines/${encodeId(RUNNER_ID)}\\?engine=claude"[^>]*>Details</a>`));
    expect(html).not.toContain('Region not supported on this runner');
    expect(html).not.toContain('can run a session yet');
  });

  it('names a reason other than the region by the credential, with Fix it', () => {
    const sources: ChoiceSources = { configured: [configured[0]], modelCatalog: catalog, engineHealth: [{ engine: 'claude', installed: true, auth: 'no' }] };
    const choices = engineChoices(sources, [{ engine: AgentProvider.CLAUDE, provider: 'claude' }]);
    const remembered = currentEngineChoice(AgentProvider.CLAUDE, 'claude', choices, sources);
    const to = draftFallback(remembered, choices, sources.engineHealth);
    expect(to).toEqual({ engine: AgentProvider.CLAUDE, provider: 'deepseek' });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NewSessionProviderHero
          current={currentEngineChoice(to!.engine, to!.provider, choices, sources)}
          engines={choices}
          onPick={() => {}}
          runnerId={RUNNER_ID}
          fellBackFrom={remembered}
          machine="jdcloud"
        />
      </MemoryRouter>,
    );
    // OrbitKit's fallbackLine says the same words (DraftFallbackTests).
    expect(html).toContain('Claude Code: Not signed in on jdcloud');
    expect(html).toContain('Fix it');
  });

  it('names the engine that could not run when it moved to another one (board ③)', () => {
    const html = fallbackMarkup('anthropic', [anthropic], [claudeIn, codexIn]);
    expect(html).toContain('aria-label="Engine: Codex"');
    expect(html).toContain('Claude Code can’t run on jdcloud: Region not supported');
  });

  it('keeps the reason and offers another provider when nothing here runs (board ④)', () => {
    const html = fallbackMarkup('claude', [anthropic], [claudeIn]);
    expect(html).toContain('Region not supported on this runner');
    expect(html).toContain('Nothing on jdcloud can run a session yet.');
    expect(html).toContain('<a href="/settings/providers"');
    expect(html).toContain('Use another provider');
  });
});

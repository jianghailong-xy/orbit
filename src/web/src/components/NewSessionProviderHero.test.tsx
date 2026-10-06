import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { NewSessionProviderHero } from './NewSessionProviderHero';
import { currentProviderChoice, engineChoiceFor, engineChoices, providerChoices } from '../lib/sessionProviderChoices';
import type { ConfiguredProvider } from '../lib/workspaceDefaults';
import type { RunnerAntigravityState, RunnerEngineHealth } from '@orbit/shared';

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

function markup(
  provider: string,
  opts: {
    disabled?: boolean;
    note?: string;
    engines?: RunnerEngineHealth[];
    currentModelLabel?: string;
    projectIntent?: boolean;
    antigravity?: RunnerAntigravityState;
  } = {},
) {
  const choices = providerChoices(configured, catalog, undefined, opts.engines, [], undefined, opts.antigravity);
  // As WorkspaceView builds them: each engine lands on the pick when it holds it, and the current one
  // is synthesized when none does.
  const engines = engineChoices(choices, configured, [provider]);
  return renderToStaticMarkup(
    <MemoryRouter>
      <NewSessionProviderHero
        current={
          engines.find((engine) => engine.provider.slug === provider) ??
          engineChoiceFor(currentProviderChoice(provider, choices, catalog, configured, undefined, opts.antigravity), configured)
        }
        engines={engines}
        onPick={() => {}}
        runnerId="019fc086-c7c7-7c92-8215-778ad8a6280a"
        disabled={opts.disabled}
        note={opts.note}
        currentModelLabel={opts.currentModelLabel}
        projectIntent={opts.projectIntent}
      />
    </MemoryRouter>,
  );
}

describe('NewSessionProviderHero', () => {
  it('names Antigravity alone, however it signs in — that is the Provider menu’s to say', () => {
    const html = markup('antigravity');
    expect(html).toContain('aria-label="Engine: Antigravity"');
    expect(html).not.toContain('env key');
    expect(html).not.toContain('Google account');
    expect(html).toContain('Gemini 3.8 Flash');
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

    expect(html).toContain('<div class="np-empty-copy">Send a task to get started.</div>');
    expect(html).toContain('<div class="np-current-model">Claude Opus 5</div>');
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
  });

  it('shows the current provider as the collapsed identity, name under the mark', () => {
    const html = markup('claude');
    // Mark first, name second — the vertical order is the point of the layout.
    expect(html.indexOf('np-mark')).toBeLessThan(html.indexOf('np-name'));
    expect(html).toContain('Claude');
    expect(html).toContain('np-chev');
  });

  it('shows the draft model rather than the provider default in the empty state', () => {
    const html = markup('claude', { currentModelLabel: 'Claude Sonnet 5' });

    expect(html).toContain('<div class="np-current-model">Claude Sonnet 5</div>');
    expect(html).not.toContain('Claude Opus 5');
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
    expect(html).toContain('Not installed on this runner');
    expect(html).toContain('engine=kimi');
    expect(html).not.toContain('runner login');
  });

  it('sends a configured provider’s fix to the engine it borrows, not to its own slug', () => {
    // Kimi (Moonshot) runs on the Kimi CLI, and `moonshot` has no row on the Providers page to
    // land on — the install that fixes it is the kimi engine's.
    const html = markup('moonshot', {
      engines: [{ engine: 'kimi', installed: false, auth: 'unknown' }],
    });
    expect(html).toContain('Not installed on this runner');
    expect(html).toContain('engine=kimi');
    expect(html).not.toContain('engine=moonshot');
  });

  it('names the engine on the card, and not the provider of it the draft spends', () => {
    const html = markup('deepseek');
    expect(html).toContain('aria-label="Engine: Claude"');
    expect(html).not.toContain('DeepSeek</small>');
    expect(html).not.toContain('via ');
  });
});

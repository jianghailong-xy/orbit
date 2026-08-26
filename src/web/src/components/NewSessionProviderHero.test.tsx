import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { NewSessionProviderHero } from './NewSessionProviderHero';
import { providerChoices, currentProviderChoice } from '../lib/sessionProviderChoices';
import type { ConfiguredProvider } from '../lib/workspaceDefaults';
import type { RunnerEngineHealth } from '@orbit/shared';

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
    projectIntent?: boolean;
  } = {},
) {
  const choices = providerChoices(configured, catalog, undefined, opts.engines);
  return renderToStaticMarkup(
    <MemoryRouter>
      <NewSessionProviderHero
        current={currentProviderChoice(provider, choices, catalog, configured)}
        choices={choices}
        onPick={() => {}}
        runnerId="019fc086-c7c7-7c92-8215-778ad8a6280a"
        disabled={opts.disabled}
        note={opts.note}
        projectIntent={opts.projectIntent}
      />
    </MemoryRouter>,
  );
}

describe('NewSessionProviderHero', () => {
  it('keeps the ordinary New Session framing word-for-word by default', () => {
    const html = markup('claude');

    expect(html).toContain('<div class="np-title">Start a new session</div>');
    expect(html).toContain(
      '<div class="np-sub">Describe the task — Orbit remembers who runs it.</div>',
    );
    expect(html).not.toContain('Start a new project');
    expect(html).not.toContain('目标、验收标准和任务拆解');
  });

  it('switches only the framing copy for a project-intent session', () => {
    const html = markup('claude', { projectIntent: true });

    expect(html).toContain('<div class="np-title">Start a new project</div>');
    expect(html).toContain(
      '<div class="np-sub">Describe what you want done — 目标、验收标准和任务拆解在对话里定。</div>',
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

  it('names the model it will run, without a funding label in the healthy state', () => {
    // The credential (subscription vs your key) is a constant the user already set and isn't
    // actionable here, so the healthy summary names only the model. Funding resurfaces solely as
    // the `unavailable` warning (covered below).
    expect(markup('claude')).toContain('Claude Opus 5');
    expect(markup('claude')).not.toContain('runner login');
    expect(markup('deepseek')).toContain('DeepSeek V4 Pro');
    expect(markup('deepseek')).not.toContain('your API key');
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

  it('labels an unknown provider truthfully instead of falling back to Claude', () => {
    const html = markup('gone-away');
    expect(html).toContain('gone-away');
    expect(html).not.toContain('>Claude<');
  });
});

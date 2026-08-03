import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { NewSessionProviderHero } from './NewSessionProviderHero';
import { providerChoices, currentProviderChoice } from '../lib/sessionProviderChoices';
import type { ConfiguredProvider } from '../lib/agentDefaults';

const configured: ConfiguredProvider[] = [
  {
    slug: 'deepseek',
    label: 'DeepSeek',
    runtime: 'claude',
    models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
    defaultModel: 'deepseek-v4-pro',
    presetSlug: 'deepseek',
  },
];
const catalog = { claude: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }] } as never;

function markup(provider: string, opts: { disabled?: boolean; note?: string } = {}) {
  const choices = providerChoices(configured, catalog);
  return renderToStaticMarkup(
    <MemoryRouter>
      <NewSessionProviderHero
        current={currentProviderChoice(provider, choices, catalog, configured)}
        choices={choices}
        onPick={() => {}}
        disabled={opts.disabled}
        note={opts.note}
      />
    </MemoryRouter>,
  );
}

describe('NewSessionProviderHero', () => {
  it('shows the current provider as the collapsed identity, name under the mark', () => {
    const html = markup('claude');
    // Mark first, name second — the vertical order is the point of the layout.
    expect(html.indexOf('np-mark')).toBeLessThan(html.indexOf('np-name'));
    expect(html).toContain('Claude');
    expect(html).toContain('np-chev');
  });

  it('says which model it will run and whose money it spends', () => {
    expect(markup('claude')).toContain('runner login');
    expect(markup('claude')).toContain('Claude Opus 5');
    // A BYOK provider must not read as a subscription.
    expect(markup('deepseek')).toContain('your API key');
    expect(markup('deepseek')).toContain('DeepSeek V4 Pro');
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

  it('labels an unknown provider truthfully instead of falling back to Claude', () => {
    const html = markup('gone-away');
    expect(html).toContain('gone-away');
    expect(html).not.toContain('>Claude<');
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import { ProviderConnectPage } from './ProviderConnectPage';

const row = (over: Partial<ProviderRow>): ProviderRow => ({
  id: 'p1',
  slug: 'anthropic',
  label: 'Anthropic (Claude)',
  runtime: 'claude',
  baseUrl: 'https://api.anthropic.com',
  models: [],
  defaultModel: null,
  presetSlug: 'anthropic',
  followsPreset: true,
  enabled: true,
  hasApiKey: true,
  ...over,
});

/** The page at `path`, with both queries it reads seeded so nothing has to be fetched. */
function render(path: string, providers: ProviderRow[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(PROVIDERS_LIST_KEY, providers);
  qc.setQueryData(['providers', 'presets'], {});
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/providers/new/:slug" element={<ProviderConnectPage />} />
          <Route path="/providers/:id" element={<ProviderConnectPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('naming a provider whose vendor is already connected', () => {
  it('leaves the first key of a vendor unnamed — the preset already knows what it is', () => {
    const html = render('/providers/new/anthropic', []);
    expect(html).not.toContain('Name this provider');
    expect(html).not.toContain('You already have');
  });

  it('asks for a name up front from the second key on, pre-filled with a free one', () => {
    const html = render('/providers/new/anthropic', [row({})]);
    expect(html).toContain('Name this provider');
    expect(html).toContain('value="Anthropic (Claude) 2"');
    expect(html).toContain('You already have one Anthropic (Claude) key');
  });

  it('counts only the same vendor, and only what the number needs', () => {
    const rows = [
      row({}),
      row({ id: 'p2', slug: 'anthropic-2', label: 'Work key' }),
      row({ id: 'p3', slug: 'deepseek', label: 'DeepSeek', presetSlug: 'deepseek' }),
    ];
    const html = render('/providers/new/anthropic', rows);
    expect(html).toContain('You already have 2 Anthropic (Claude) keys');
    // "Anthropic (Claude) 2" is free again once the second row took a name of its own.
    expect(html).toContain('value="Anthropic (Claude) 2"');
  });

  it('surfaces the name when editing one of several, so the first can be renamed too', () => {
    const rows = [row({}), row({ id: 'p2', slug: 'anthropic-2', label: 'Anthropic (Claude) 2' })];
    const html = render('/providers/p1', rows);
    expect(html).toContain('You already have one Anthropic (Claude) key');
    expect(html).toContain('value="Anthropic (Claude)"');
  });

  it('leaves an only key of its vendor as it was', () => {
    const html = render('/providers/p1', [row({})]);
    expect(html).not.toContain('You already have');
  });
});

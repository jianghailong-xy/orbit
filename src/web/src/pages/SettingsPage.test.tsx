import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { meQuery, type UserPreferences } from '../lib/queries';
import { SettingsPage } from './SettingsPage';

// The theme control reaches for localStorage and matchMedia, neither of which Node has, and it
// is not what these tests are about.
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));

/** The page with the query it reads seeded, so nothing has to be fetched. */
function render(preferences: UserPreferences) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meQuery().queryKey, { id: 'u1', email: 'a@b.c', name: 'A', preferences });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The switch in the row that names it — the page has other switches (the two alert ones). */
function switchAfter(html: string, label: string): string {
  const row = html.slice(html.indexOf(`<div>${label}</div>`));
  return row.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? '';
}

describe('session orchestration, one switch for the whole account', () => {
  it('is on for an account that never said otherwise', () => {
    // Absent means on: only turning it off is ever written.
    const html = render({});
    expect(switchAfter(html, 'Let sessions orchestrate')).toContain('aria-checked="true"');
    expect(html).toContain('Sessions in every workspace can spawn and manage other sessions');
  });

  it('reads off once the account turned it off', () => {
    const html = render({ enableOrchestration: false });
    expect(switchAfter(html, 'Let sessions orchestrate')).toContain('aria-checked="false"');
  });

  it('no longer counts or sets workspaces one by one', () => {
    const html = render({});
    expect(html).not.toContain('can orchestrate now');
    expect(html).not.toContain('Turn on for all');
  });
});

describe('the way into Settings → Shared links', () => {
  it('is a Sharing section that names the page and offers to manage it', () => {
    const html = render({});
    // Card title, then the row: what the page is, what it holds, and the button that opens it.
    expect(html).toMatch(/ant-card-head-title">Sharing</);
    expect(html).toContain('<div>Shared links</div>');
    expect(html).toContain('Everything you’ve made viewable by link');
    expect(html).toMatch(/<button[^>]*><span>Manage<\/span><\/button>/);
  });
});

describe('the order of the cards', () => {
  it('reads as Settings on iOS does: how sessions start, then the alerts and the look, then sharing', () => {
    // iOS lays the same settings out as one list (SettingsHome in OrbitKit); a card moved here alone
    // would put the two clients' pages in different orders.
    const html = render({});
    const titles = [...html.matchAll(/ant-card-head-title">([^<]+)</g)].map((m) => m[1]);
    expect(titles).toEqual(['Session defaults', 'Session orchestration', 'Notifications', 'Appearance', 'Sharing']);
  });
});

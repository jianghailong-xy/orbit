import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { meQuery, type UserPreferences } from '../../lib/queries';
import { GENERAL_HINTS, GeneralSettingsPage } from './GeneralPage';

/** The page with the account it reads seeded, so nothing has to be fetched. */
function render(preferences: UserPreferences) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meQuery().queryKey, { id: 'u1', email: 'a@b.c', name: 'A', preferences });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <GeneralSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The row that names it, up to the row after it. */
function rowOf(html: string, label: string): string {
  const from = html.indexOf(`<div class="settings-row-title">${label}</div>`);
  expect(from, `a "${label}" row`).toBeGreaterThanOrEqual(0);
  const next = html.indexOf('class="settings-row"', from);
  return html.slice(from, next < 0 ? undefined : next);
}
const switchIn = (row: string): string => row.match(/<[a-z]+[^>]*role="switch"[^>]*>/)?.[0] ?? '';
const unescape = (text: string) => text.replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

describe('Settings → General (docs/mocks/settings-redesign, board-2)', () => {
  it('is headed General, how new sessions start, with New sessions then Orchestration', () => {
    const html = render({});
    expect(html).toMatch(/<h1[^>]*>General<\/h1>/);
    expect(html).toContain('How new sessions start, account-wide.');
    const sections = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
    expect(sections).toEqual(['New sessions', 'Orchestration']);
    const rows = [...html.matchAll(/<div class="settings-row-title">([^<]+)<\/div>/g)].map((m) => m[1]);
    expect(rows).toEqual([
      'Default permission mode',
      'Smart model selection',
      'Suggested replies',
      'Session recaps',
      'Let sessions orchestrate',
    ]);
    // No way into Machines & models any more: the nav's Machines, Providers and Workspaces groups replace it.
    expect(html).not.toContain('Machines &amp; models');
    expect(html).not.toContain('Manage');
  });

  it('says each row in the one line the board shortens it to, with the full text as the control’s tooltip', () => {
    const html = render({});
    const rows: Array<[string, { short: string; full: string }]> = [
      ['Default permission mode', GENERAL_HINTS.defaultPermissionMode],
      ['Smart model selection', GENERAL_HINTS.modelRouting],
      ['Suggested replies', GENERAL_HINTS.promptSuggestions],
      ['Session recaps', GENERAL_HINTS.recaps],
      ['Let sessions orchestrate', GENERAL_HINTS.enableOrchestration],
    ];
    for (const [label, hint] of rows) {
      const row = unescape(rowOf(html, label));
      expect(row).toContain(`<div class="settings-row-description">${hint.short}</div>`);
      expect(row).toContain(`<div class="settings-row-control" title="${hint.full}">`);
    }
  });
});

describe('session orchestration, one switch for the whole account', () => {
  it('is on for an account that never said otherwise', () => {
    // Absent means on: only turning it off is ever written.
    const html = render({});
    expect(switchIn(rowOf(html, 'Let sessions orchestrate'))).toContain('aria-checked="true"');
    expect(html).toContain('Sessions can start and manage other sessions, and manage agents and runners, via the orbit MCP tools.');
  });

  it('reads off once the account turned it off', () => {
    const html = render({ enableOrchestration: false });
    expect(switchIn(rowOf(html, 'Let sessions orchestrate'))).toContain('aria-checked="false"');
  });

  it('no longer counts or sets workspaces one by one', () => {
    const html = render({});
    expect(html).not.toContain('can orchestrate now');
    expect(html).not.toContain('Turn on for all');
  });
});

describe('the other switches read the account as it was saved', () => {
  it('reads Suggested replies and Session recaps on when absent, and off when turned off', () => {
    const on = render({});
    expect(switchIn(rowOf(on, 'Suggested replies'))).toContain('aria-checked="true"');
    expect(switchIn(rowOf(on, 'Session recaps'))).toContain('aria-checked="true"');
    const off = render({ promptSuggestions: false, recaps: false });
    expect(switchIn(rowOf(off, 'Suggested replies'))).toContain('aria-checked="false"');
    expect(switchIn(rowOf(off, 'Session recaps'))).toContain('aria-checked="false"');
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../App.tsx?raw';
import { meQuery } from '../lib/queries';
import { SettingsPage } from './SettingsPage';

/**
 * The way into Settings → Access tokens (docs/personal-access-token-design.md §9): a card of its own
 * after Sharing, whose Manage opens `settings/access-tokens` — routed beside `settings/shared-links`.
 */

vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('Settings → Access tokens', () => {
  it('is a card of its own that names the page, says what it holds, and opens it', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(meQuery().queryKey, { id: 'u1', email: 'a@b.c', name: 'A', createdAt: '', preferences: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    const next = createRoot(container);
    root = next;
    await act(async () => {
      next.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/settings']}>
            <Routes>
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/settings/access-tokens" element={<div className="opened">the tokens page</div>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    // The card is a region named by its title.
    const card = [...container.querySelectorAll<HTMLElement>('section[aria-labelledby]')].find(
      (c) => document.getElementById(c.getAttribute('aria-labelledby')!)?.textContent === 'Access tokens',
    );
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain('Personal access tokens');
    expect(card!.textContent).toContain(
      'Let scripts and the orbit CLI use the Orbit API as you: what each token can reach, when it was last used, and a way to revoke it.',
    );
    const manage = [...card!.querySelectorAll('button')].find((b) => b.textContent === 'Manage');
    await act(async () => {
      manage!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.opened')?.textContent).toBe('the tokens page');
  });

  it('is routed at settings/access-tokens inside the app shell, wrapped in DocView like Shared links', () => {
    expect(app).toMatch(/path="settings\/access-tokens"\s*\n\s*element=\{\s*\n\s*<DocView>\s*\n\s*<AccessTokensPage \/>/);
    expect(app.indexOf('path="settings/access-tokens"')).toBeGreaterThan(app.indexOf('path="settings/shared-links"'));
  });
});

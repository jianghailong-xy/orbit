import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { meQuery, workspacesQuery, type UserPreferences } from '../lib/queries';
import { SettingsPage } from './SettingsPage';

// The theme control reaches for localStorage and matchMedia, neither of which Node has, and it
// is not what these tests are about.
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));

/** The page with both queries it reads seeded, so nothing has to be fetched. */
function render(preferences: UserPreferences, agents: { enableOrchestration?: boolean }[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meQuery().queryKey, { id: 'u1', email: 'a@b.c', name: 'A', preferences });
  qc.setQueryData(workspacesQuery().queryKey, agents);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('granting session orchestration across an account', () => {
  it('counts the agents that actually hold the grant, not the account default', () => {
    // The account default only governs agents made from here on. If the page reported it as the
    // fleet's state, someone would read "on" and believe their existing agents could orchestrate.
    const html = render({ defaultEnableOrchestration: true }, [
      { enableOrchestration: true },
      { enableOrchestration: false },
      {},
    ]);
    expect(html).toContain('1 of 3 can orchestrate now');
  });

  it('offers the kill switch only while something still holds the grant', () => {
    const off = render({}, [{ enableOrchestration: false }]);
    // AntD marks a disabled button on the element itself; "turn on" stays live so a fleet that
    // has never been granted anything can still be granted in one act.
    expect(off).toContain('0 of 1 can orchestrate now');
    expect(off).toMatch(/disabled[^>]*>\s*<span>Turn off for all/);
    expect(off).not.toMatch(/disabled[^>]*>\s*<span>Turn on for all/);
  });
});

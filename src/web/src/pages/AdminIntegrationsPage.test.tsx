// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeishuAdminSettings } from '@orbit/shared';

/**
 * Admin → Integrations (docs/feishu-bot-design.md §4.1): Feishu bots' one switch, "Allow accounts to connect Feishu
 * bots", on by default and saved the moment it is switched with PUT /admin/integrations/feishu, beside how many
 * apps accounts have connected. The admin area's tabs lead to it.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const { ALLOW_FEISHU_LABEL, AdminIntegrationsPage, connectedAppsText } = await import('./AdminIntegrationsPage');

let settings: FeishuAdminSettings;
let puts: unknown[];
let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/admin/integrations']}>
        <QueryClientProvider client={client}>
          <AdminIntegrationsPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(toast)) fn.mockReset();
  settings = { allowed: true, connectedApps: 2, enabledApps: 1 };
  puts = [];
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    if (path !== '/admin/integrations/feishu') throw new Error(`the stand-in server has no ${method} ${path}`);
    if (method === 'PUT') {
      puts.push(structuredClone(options.body));
      settings = { ...settings, allowed: (options.body as { allowed: boolean }).allowed };
    }
    return settings;
  });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
});

describe('Admin → Integrations', () => {
  it('shows the switch, on, with how many apps accounts connected, and switches it off with one PUT', async () => {
    await open();
    expect([...container!.querySelectorAll('.admin-nav-link')].map((a) => a.textContent)).toEqual(['Users', 'Sign-in', 'Email', 'Integrations']);
    expect(container!.querySelector('.admin-nav-link.active')?.textContent).toBe('Integrations');
    const card = container!.querySelector('.orbit-card')!;
    expect(card.querySelector('.orbit-card-title')?.textContent).toBe('Feishu bots');
    expect(card.querySelector('.orbit-badge')?.textContent).toBe('On');
    expect(card.textContent).toContain(ALLOW_FEISHU_LABEL);
    expect(card.textContent).toContain('2 apps connected, 1 of them switched on.');
    const control = card.querySelector<HTMLElement>('[role="switch"]');
    expect(control?.getAttribute('aria-checked')).toBe('true');
    expect(control?.getAttribute('aria-labelledby')).toBe(
      [...card.querySelectorAll<HTMLElement>('[id]')].find((e) => e.textContent === ALLOW_FEISHU_LABEL)?.id,
    );

    await act(async () => {
      control!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(puts).toEqual([{ allowed: false }]);
    expect(card.querySelector('.orbit-badge')?.textContent).toBe('Off');
    expect(card.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
    expect(toast.success).toHaveBeenCalledWith('Feishu bots turned off');
  });

  it('counts the apps in words', () => {
    expect(connectedAppsText({ allowed: true, connectedApps: 0, enabledApps: 0 })).toBe('No account has connected an app.');
    expect(connectedAppsText({ allowed: true, connectedApps: 1, enabledApps: 1 })).toBe('1 app connected, all switched on.');
    expect(connectedAppsText({ allowed: false, connectedApps: 3, enabledApps: 0 })).toBe('3 apps connected, 0 of them switched on.');
  });
});

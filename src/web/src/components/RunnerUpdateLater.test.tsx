// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runnerUpdateLaterOptions, runnerUpdateLaterTimes } from '../lib/runnerUpdateLater';
import { clearToasts } from '../lib/toastStore';
import { RunnerUpdateLaterMenu } from './RunnerUpdateLater';
import { ToastViewport } from './ToastViewport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: vi.fn(),
}));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// Later ▾ (docs/runner-update-drain-design.md §2, D1; board 3 ⑦).

describe('the three Later times, in the reader’s own zone', () => {
  it('an hour from now, the next 02:00, and 09:00 on the next calendar day', () => {
    const now = new Date(2026, 10, 12, 11, 57, 30);
    const at = runnerUpdateLaterTimes(now);
    expect(at.hour.getTime() - now.getTime()).toBe(3_600_000);
    expect(at.tonight).toEqual(new Date(2026, 10, 13, 2, 0));
    expect(at.tomorrow).toEqual(new Date(2026, 10, 13, 9, 0));
  });

  it('after midnight, tonight is still today’s 02:00 until it passes, and tomorrow is the next day', () => {
    expect(runnerUpdateLaterTimes(new Date(2026, 10, 13, 0, 30)).tonight).toEqual(new Date(2026, 10, 13, 2, 0));
    expect(runnerUpdateLaterTimes(new Date(2026, 10, 13, 2, 0)).tonight).toEqual(new Date(2026, 10, 14, 2, 0));
    expect(runnerUpdateLaterTimes(new Date(2026, 10, 13, 0, 30)).tomorrow).toEqual(new Date(2026, 10, 14, 9, 0));
  });

  it('reads as board 3 draws it', () => {
    const rows = runnerUpdateLaterOptions(new Date(2026, 10, 12, 11, 57));
    expect(rows.map((r) => [r.label, r.detail])).toEqual([
      ['Postpone 1 hour', 'until 12:57'],
      ['Postpone until tonight', '02:00'],
      ['Postpone until tomorrow', '09:00'],
    ]);
  });
});

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => {
    clearToasts();
    root?.unmount();
  });
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
async function mount(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<QueryClientProvider client={qc}><MemoryRouter>{node}<ToastViewport /></MemoryRouter></QueryClientProvider>));
  await settle();
}
const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];

describe('Later ▾', () => {
  it('opens the three choices and posts the one picked, with the reader’s zone; the toast names the time', async () => {
    const sent: Array<{ path: string; method?: string; body?: unknown }> = [];
    apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
      sent.push({ path, method: options?.method, body: options?.body });
      return { until: (options?.body as { until: string }).until };
    });
    await mount(<RunnerUpdateLaterMenu runnerId="34w8RunnerStudioMac0001" />);
    const trigger = host!.querySelector<HTMLButtonElement>('button.runner-update-later')!;
    expect(trigger.textContent?.trim()).toBe('Later');
    await act(async () => trigger.click());
    await settle();
    expect(items().map((i) => i.querySelector('.runner-update-later-item span')?.textContent)).toEqual([
      'Postpone 1 hour',
      'Postpone until tonight',
      'Postpone until tomorrow',
    ]);
    const before = Date.now();
    await act(async () => items()[1].click());
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe('/runners/34w8RunnerStudioMac0001/self-update/postpone');
    expect(sent[0].method).toBe('POST');
    const body = sent[0].body as { until: string; timeZone: string };
    expect(body.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const until = new Date(body.until);
    expect([until.getHours(), until.getMinutes()]).toEqual([2, 0]);
    expect(until.getTime()).toBeGreaterThan(before);
    expect(until.getTime() - before).toBeLessThanOrEqual(24 * 3_600_000);
    expect(document.body.textContent).toContain('Update postponed until 02:00 — the runner takes work again.');
  });

  it('reads Change on the postponed card, and says why when the server refuses', async () => {
    apiMock.mockRejectedValue(new Error('Runner is too old to update on request — it reports no self-update state'));
    await mount(<RunnerUpdateLaterMenu runnerId="r1" change />);
    const trigger = host!.querySelector<HTMLButtonElement>('button.runner-update-later')!;
    expect(trigger.textContent?.trim()).toBe('Change');
    await act(async () => trigger.click());
    await settle();
    await act(async () => items()[0].click());
    await settle();
    expect(document.body.textContent).toContain('Couldn’t postpone the update');
    expect(document.body.textContent).toContain('Runner is too old to update on request');
  });
});

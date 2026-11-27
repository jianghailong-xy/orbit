// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const webPush = vi.hoisted(() => ({
  getWebPushConfig: vi.fn<() => Promise<string | null>>(),
  getWebPushState: vi.fn<() => Promise<string>>(),
  enableWebPush: vi.fn<(key: string) => Promise<string>>(),
  disableWebPush: vi.fn<() => Promise<void>>(),
}));
vi.mock('../../lib/webPush', () => webPush);
vi.mock('./preferences', () => ({
  usePreferences: () => ({ prefs: {}, save: { mutate: vi.fn(), isPending: false } }),
}));

import { NotificationsSettingsPage } from './NotificationsPage';

/**
 * Settings → Notifications' This browser card (docs/web-push-design.md, board docs/mocks/web-push board-1/2): shown
 * only when the server has a VAPID key, and the four states of its one switch, each said in the row's description.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('Notification', { permission: 'default' });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

async function flush() {
  for (let i = 0; i < 3; i += 1) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}

async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <NotificationsSettingsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await flush();
}

const headings = () => [...container.querySelectorAll('h2')].map((h) => h.textContent);
const browserRow = () =>
  [...container.querySelectorAll('.settings-row')].find(
    (r) => r.querySelector('.settings-row-title')?.textContent === 'Notifications in this browser',
  );
const description = () => browserRow()?.querySelector('.settings-row-description')?.textContent;
const browserSwitch = () => browserRow()!.querySelector<HTMLElement>('[role="switch"]')!;

describe('Settings → Notifications: This browser', () => {
  it('is not there when the server sends no web push: the page looks as it did', async () => {
    webPush.getWebPushConfig.mockResolvedValue(null);
    await render();
    expect(browserRow()).toBeUndefined();
    expect(headings()).toEqual([]);
    expect(container.textContent).toContain('When a session finishes');
    expect(webPush.getWebPushState).not.toHaveBeenCalled();
  });

  it('sits above All your devices, off, and turns on from the click', async () => {
    webPush.getWebPushConfig.mockResolvedValue('KEY');
    webPush.getWebPushState.mockResolvedValue('off');
    webPush.enableWebPush.mockResolvedValue('on');
    await render();
    expect(headings()).toEqual(['This browser', 'All your devices']);
    expect(description()).toBe('Show Orbit alerts on this computer, even with no Orbit tab open.');
    expect(browserSwitch().getAttribute('aria-checked')).toBe('false');
    act(() => browserSwitch().click());
    await flush();
    expect(webPush.enableWebPush).toHaveBeenCalledWith('KEY');
    expect(browserSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it("asks you to answer the browser's prompt while it is open", async () => {
    webPush.getWebPushConfig.mockResolvedValue('KEY');
    webPush.getWebPushState.mockResolvedValue('off');
    let answer!: (s: string) => void;
    webPush.enableWebPush.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await render();
    act(() => browserSwitch().click());
    await flush();
    expect(description()).toBe("Allow notifications in the browser's prompt…");
    await act(async () => answer('blocked'));
    await flush();
    expect(description()).toBe("Blocked for this site. Allow notifications in your browser's site settings, then turn this on.");
  });

  it('turns off, and says so when that fails', async () => {
    webPush.getWebPushConfig.mockResolvedValue('KEY');
    webPush.getWebPushState.mockResolvedValue('on');
    webPush.disableWebPush.mockRejectedValue(new Error('offline'));
    await render();
    expect(browserSwitch().getAttribute('aria-checked')).toBe('true');
    act(() => browserSwitch().click());
    await flush();
    expect(webPush.disableWebPush).toHaveBeenCalled();
    expect(description()).toBe("Couldn't turn off notifications here. Try again.");
    expect(browserSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it.each([
    ['blocked', "Blocked for this site. Allow notifications in your browser's site settings, then turn this on."],
    [
      'unsupported',
      "This browser can't show Orbit notifications. On iPhone, add Orbit to the Home Screen first, or use the Orbit app.",
    ],
  ])('%s: the switch is disabled and the row says why', async (state, text) => {
    webPush.getWebPushConfig.mockResolvedValue('KEY');
    webPush.getWebPushState.mockResolvedValue(state);
    await render();
    expect(description()).toBe(text);
    expect(browserSwitch().hasAttribute('data-disabled')).toBe(true);
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const webPush = vi.hoisted(() => ({
  getWebPushConfig: vi.fn<() => Promise<string | null>>(),
  getWebPushState: vi.fn<() => Promise<string>>(),
  enableWebPush: vi.fn<(key: string) => Promise<string>>(),
  webPushSupported: vi.fn<() => boolean>(),
}));
vi.mock('../lib/webPush', () => webPush);
vi.mock('../lib/toast', () => ({ useToast: () => ({ success: vi.fn(), warning: vi.fn() }) }));

import { WebPushOffer, WEB_PUSH_OFFER_DISMISSED_KEY } from './WebPushOffer';

/**
 * The one-time offer of this browser's notifications: one copy on screen (the bar where the nav is a drawer, the
 * rail's card on desktop), and gone everywhere, remounts included, once answered.
 */

let container: HTMLDivElement;
let root: Root;
let qc: QueryClient;

function stubWidth(mobile: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: mobile && query === '(max-width: 960px)',
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  localStorage.clear();
  vi.stubGlobal('Notification', { permission: 'default' });
  webPush.webPushSupported.mockReturnValue(true);
  webPush.getWebPushConfig.mockResolvedValue('key');
  webPush.getWebPushState.mockResolvedValue('off');
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

async function render(rail = true) {
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <WebPushOffer placement="bar" />
        {rail && <WebPushOffer placement="rail" />}
      </QueryClientProvider>,
    ),
  );
  await flush();
}

const offers = () => [...container.querySelectorAll('.web-push-offer')].map((el) => el.className);

describe('WebPushOffer', () => {
  it('shows only the rail card on desktop', async () => {
    stubWidth(false);
    await render();
    expect(offers()).toEqual(['web-push-offer web-push-offer--rail']);
  });

  it('shows only the bar where the nav is a drawer', async () => {
    stubWidth(true);
    await render();
    expect(offers()).toEqual(['web-push-offer web-push-offer--bar']);
  });

  it('Turn on hides the offer everywhere, and it stays hidden when the rail mounts again', async () => {
    stubWidth(false);
    webPush.enableWebPush.mockResolvedValue('on');
    await render();
    const turnOn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Turn on')!;
    act(() => turnOn.click());
    await flush();
    expect(offers()).toEqual([]);
    expect(localStorage.getItem(WEB_PUSH_OFFER_DISMISSED_KEY)).not.toBeNull();

    await render(false);
    await render(true);
    stubWidth(true);
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(offers()).toEqual([]);
  });
});

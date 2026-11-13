// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuestSessionSummary } from '@orbit/shared';

/**
 * Shared with me, the sidebar's last group (docs/session-guests-design.md §4; board
 * docs/mocks/share-links/10-session-guests-3): the sessions GET /guest-sessions lists, each with its title, who shared
 * it and how it stands, opening its guest page; and no group at all while nothing is shared with you.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  listGuestSessions: vi.fn(),
}));
const { listGuestSessions } = await import('../api');
const { SharedWithMeGroup, guestSessionPath } = await import('./SharedWithMe');
const { encodeId } = await import('../lib/idCodec');

const RUNNING: GuestSessionSummary = {
  id: '0196f8a2-7c1e-7b3a-9d4e-5f6a7b8c9d0e', title: 'Retry budget for flaky pg specs', ownerName: 'Lin Wei',
  status: 'RUNNING', sessionState: 'RUNNING', lifecycleState: 'OPEN',
  addedAt: new Date(Date.now() - 3_600_000).toISOString(), lastTurnAt: new Date(Date.now() - 2 * 60_000).toISOString(),
};
const COMPLETED: GuestSessionSummary = {
  id: '0196f8a2-7c1e-7b3a-9d4e-5f6a7b8c9d0f', title: 'Android cold start trace', ownerName: 'Ravi Kumar',
  status: 'SUCCEEDED', sessionState: 'COMPLETED', lifecycleState: 'COMPLETED',
  addedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), lastTurnAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
};

let container: HTMLDivElement;
let root: Root;
const onOpen = vi.fn();

async function mount(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SharedWithMeGroup onOpen={onOpen} />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 4; i += 1) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(listGuestSessions).mockReset();
  onOpen.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('Shared with me', () => {
  it('lists each shared session: title and when, then who shared it and how it stands', async () => {
    vi.mocked(listGuestSessions).mockResolvedValue({ sessions: [RUNNING, COMPLETED] });
    await mount();
    expect(container.querySelector('.tp-group-name')?.textContent).toBe('Shared with me');
    expect(container.querySelector('.tp-count')?.textContent).toBe('2');
    const rows = [...container.querySelectorAll<HTMLElement>('.tp-guest-session')].map((row) => ({
      title: row.querySelector('.tp-label')?.textContent,
      when: row.querySelector('.tp-guest-session-time')?.textContent,
      sub: row.querySelector('.tp-guest-session-sub')?.textContent,
    }));
    expect(rows).toEqual([
      { title: 'Retry budget for flaky pg specs', when: '2m', sub: 'Lin Wei · Running' },
      { title: 'Android cold start trace', when: '2d', sub: 'Ravi Kumar · Completed' },
    ]);
  });

  it('opens a session’s guest page, by click or by Enter', async () => {
    vi.mocked(listGuestSessions).mockResolvedValue({ sessions: [RUNNING] });
    await mount();
    const row = container.querySelector<HTMLElement>('.tp-guest-session')!;
    expect(row.getAttribute('role')).toBe('link');
    await act(async () => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onOpen.mock.calls).toEqual([[`/g/${encodeId(RUNNING.id)}`], [`/g/${encodeId(RUNNING.id)}`]]);
    expect(guestSessionPath(RUNNING.id)).toBe(`/g/${encodeId(RUNNING.id)}`);
  });

  it('folds and unfolds from its head', async () => {
    vi.mocked(listGuestSessions).mockResolvedValue({ sessions: [RUNNING] });
    await mount();
    await act(async () => container.querySelector('.tp-group-head')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('.tp-guest-session')).toBeNull();
    await act(async () => container.querySelector('.tp-group-head')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('.tp-guest-session')).not.toBeNull();
  });

  it('is not there while nothing is shared with you', async () => {
    vi.mocked(listGuestSessions).mockResolvedValue({ sessions: [] });
    await mount();
    expect(container.innerHTML).toBe('');
    expect(vi.mocked(listGuestSessions)).toHaveBeenCalledTimes(1);
  });
});

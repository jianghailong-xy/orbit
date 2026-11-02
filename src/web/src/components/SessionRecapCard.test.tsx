// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecapOutcome } from '../api';

/**
 * The conversation's Recap card on its own: when it says the recap was written, what a refresh
 * that wrote nothing says for each reason the pass gives, that a refresh that did write reads the
 * session again rather than drawing a line of its own, and that Refresh and Hide are its ⋯'s menu.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, refreshSessionRecap: vi.fn() };
});
const toast = { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));

const { refreshSessionRecap } = await import('../api');
const { RECAP_CARD_COPY, SessionRecapCard, recapRefreshNotice, recapWhen } = await import('./SessionRecapCard');

describe('recapWhen', () => {
  const clock = (at: Date) => at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  it('says a bare clock time for a recap written today', () => {
    const now = new Date(2026, 9, 22, 18, 0);
    const at = new Date(2026, 9, 22, 9, 41);
    expect(recapWhen(at.toISOString(), now)).toBe(clock(at));
  });

  it('dates a recap from another day, where a bare clock time would mislead', () => {
    const now = new Date(2026, 9, 22, 18, 0);
    const at = new Date(2026, 9, 17, 13, 44);
    const day = at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    expect(recapWhen(at.toISOString(), now)).toBe(`${day}, ${clock(at)}`);
  });

  it('says nothing for a recap with no stamp, or one that is not a time', () => {
    expect(recapWhen(null)).toBeNull();
    expect(recapWhen(undefined)).toBeNull();
    expect(recapWhen('not a time')).toBeNull();
  });
});

describe('recapRefreshNotice', () => {
  it('says why a refresh wrote nothing, in the words the native cards use', () => {
    expect(recapRefreshNotice('no-events')).toEqual({ text: 'The recap is already up to date.', failed: false });
    expect(recapRefreshNotice('too-few-events')).toEqual({ text: "There's too little to recap yet.", failed: false });
    expect(recapRefreshNotice('no-key')).toEqual({ text: "Recaps aren't available on this server.", failed: false });
    expect(recapRefreshNotice('disabled')).toEqual({ text: "Recaps aren't available on this server.", failed: false });
    expect(recapRefreshNotice('llm-failed')).toEqual({ text: "Couldn't refresh the recap. Try again.", failed: true });
    expect(recapRefreshNotice('error')).toEqual({ text: "Couldn't refresh the recap. Try again.", failed: true });
  });

  it('says nothing when another pass wrote first: the refetch shows its line', () => {
    expect(recapRefreshNotice('cas-lost')).toBeNull();
  });
});

describe('SessionRecapCard', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const onHide = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // The open menu measures its button; jsdom has no ResizeObserver.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.mocked(refreshSessionRecap).mockReset();
    Object.values(toast).forEach((spy) => spy.mockReset());
    onHide.mockReset();
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function render(): Promise<void> {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SessionRecapCard sessionId="sess-1" text="Fixed the login flow; tests pass." recapAt={null} onHide={onHide} />
        </QueryClientProvider>,
      );
    });
  }

  const more = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('.chat-recap-more')!;
  const menu = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[role="menu"]');

  /** Press the ⋯ and answer the items of the menu it opens, by their words. */
  async function openMenu(): Promise<HTMLElement[]> {
    await act(async () => {
      more().click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(menu()).not.toBeNull(), { timeout: 5_000, interval: 10 });
    });
    return [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  }

  /** Run one of the menu's items, and wait for the menu to close behind it. */
  async function pick(label: string): Promise<void> {
    const item = (await openMenu()).find((el) => el.textContent?.trim() === label)!;
    await act(async () => {
      item.click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(menu()).toBeNull(), { timeout: 5_000, interval: 10 });
    });
  }

  async function pressRefresh(): Promise<void> {
    await pick(RECAP_CARD_COPY.refresh);
    await act(async () => {
      await vi.waitFor(() => expect(more().disabled).toBe(false), { timeout: 5_000, interval: 10 });
    });
  }

  it('draws the word, the whole recap, and no time when the recap carries none', async () => {
    await render();
    expect(container.querySelector('.chat-recap-word')?.textContent).toBe('Recap');
    expect(container.querySelector('.chat-recap-when')).toBeNull();
    expect(container.querySelector('.chat-recap-text')?.textContent).toBe('Fixed the login flow; tests pass.');
  });

  it('holds Refresh and Hide behind one ⋯ named for screen readers, and hands Hide to the conversation without asking the server anything', async () => {
    await render();
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(more().getAttribute('aria-label')).toBe('Recap actions');
    const items = await openMenu();
    expect(items.map((el) => el.textContent?.trim())).toEqual(['Refresh recap', 'Hide recap']);
    // Shown while its menu is open, though the pointer has left the card for the menu.
    expect(container.querySelector('.chat-recap')!.classList.contains('is-open')).toBe(true);
    await act(async () => {
      items[1].click();
    });
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(refreshSessionRecap).not.toHaveBeenCalled();
  });

  it('keeps its ⋯ busy while a refresh asks, so a second one cannot start', async () => {
    let answer!: (outcome: RecapOutcome) => void;
    vi.mocked(refreshSessionRecap).mockReturnValue(new Promise<RecapOutcome>((resolve) => { answer = resolve; }));
    await render();
    await pick(RECAP_CARD_COPY.refresh);
    expect(more().disabled).toBe(true);
    expect(container.querySelector('.chat-recap')!.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      answer({ written: false, reason: 'no-events' });
    });
    await act(async () => {
      await vi.waitFor(() => expect(more().disabled).toBe(false), { timeout: 5_000, interval: 10 });
    });
    expect(refreshSessionRecap).toHaveBeenCalledTimes(1);
  });

  it('reads the session again once a refresh wrote, and says nothing', async () => {
    vi.mocked(refreshSessionRecap).mockResolvedValue({ written: true, recapText: 'New.', recapEventSeq: 9 });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await render();
    await pressRefresh();
    expect(refreshSessionRecap).toHaveBeenCalledWith('sess-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session', 'sess-1'] });
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says why a refresh wrote nothing', async () => {
    vi.mocked(refreshSessionRecap).mockResolvedValue({ written: false, reason: 'no-events' });
    await render();
    await pressRefresh();
    expect(toast.info).toHaveBeenCalledWith('The recap is already up to date.');
  });

  it('says a refresh failed, whether the pass gave up or the request did', async () => {
    vi.mocked(refreshSessionRecap).mockResolvedValueOnce({ written: false, reason: 'llm-failed' });
    vi.mocked(refreshSessionRecap).mockRejectedValueOnce(new Error('offline'));
    await render();
    await pressRefresh();
    await pressRefresh();
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenNthCalledWith(1, "Couldn't refresh the recap. Try again.");
    expect(toast.error).toHaveBeenNthCalledWith(2, "Couldn't refresh the recap. Try again.");
  });
});

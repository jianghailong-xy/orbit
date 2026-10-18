// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunnerLoginState } from '@orbit/shared';
import { RunnerSignIn } from './RunnerSignIn';

/**
 * Cursor CLI's sign-in card (the owner's board, docs/mocks/cursor-engine Web 3): `agent login` prints one
 * link and waits on it for about 23–27 minutes (docs/cursor-runtime-contract.md §9). The card opens it on
 * cursor.com, offers it for another browser, counts down to when it stops working, and — once the runner
 * reports it ran out — offers a new link rather than a generic retry.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const RUNNER = 'runner-1';
const URL = 'https://cursor.com/loginDeepControl?challenge=abc&uuid=6f0c2a4e&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true';
const state = (over: Partial<RunnerLoginState>): RunnerLoginState => ({
  status: null, engine: null, url: null, userCode: null, message: null, account: null, ...over,
});
const link = (over: Partial<RunnerLoginState> = {}) =>
  state({ status: 'awaiting_approval', engine: 'cursor', url: URL, expiresAt: new Date(Date.now() + 26 * 60_000 - 5_000).toISOString(), ...over });

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let qc: QueryClient;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
});

/** What the runner's relay reports now, for the card's next read and its cache alike. */
let current: RunnerLoginState;
const report = async (next: RunnerLoginState) => {
  current = next;
  await act(async () => {
    // A read already on its way carries the state from before; this report is the news.
    await qc.cancelQueries({ queryKey: ['runner-login', RUNNER] });
    qc.setQueryData(['runner-login', RUNNER], next);
    // The query cache tells its observers on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

function mount(initial: RunnerLoginState, props: { account?: string; accountName?: string; autoStart?: boolean } = {}) {
  current = initial;
  apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === `/runners/${RUNNER}/login` && options?.method === 'POST') current = state({ status: 'pending', engine: 'cursor' });
    if (path === '/runners') return [];
    return current;
  });
  // What the runner reports is handed to the card as it arrives (report), not read back on mount.
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['runner-login', RUNNER], initial);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <RunnerSignIn runnerId={RUNNER} engine="cursor" {...props} />
      </QueryClientProvider>,
    ),
  );
  return host;
}
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('signing Cursor CLI in on a runner', () => {
  it('opens Cursor’s own link, offers it for another browser, and says how long it lasts', () => {
    const card = mount(link());
    expect(text(card.querySelector('.rsi-hint'))).toBe('Sign in on cursor.com with the account this runner should use:');
    const open = card.querySelector<HTMLAnchorElement>('a.rsi-open')!;
    expect(text(open)).toBe('Open cursor.com');
    expect(open.getAttribute('href')).toBe(URL);
    expect(text(card.querySelector('.rsi-actions .rsi-link'))).toBe('Copy sign-in link');
    expect(text(card.querySelector('.rsi-row'))).toBe('Waiting for you to sign in… · link expires in 26 min');
    // No code to enter or paste: the runner sees the sign-in finish by itself.
    expect(card.querySelector('.rsi-usercode, .rsi-input')).toBeNull();
  });

  it('names the account it signs in: one being added, or one signing in again', async () => {
    // Add account starts the sign-in as its panel opens; the link arrives a check-in later.
    const adding = mount(state({}), { accountName: 'Work', autoStart: true });
    await report(link());
    expect(text(adding.querySelector('.rsi-hint'))).toBe('Sign in on cursor.com with the account you are adding:');
    act(() => root?.unmount());
    expect(text(mount(link({ account: '5c2e91a0' }), { account: '5c2e91a0' }).querySelector('.rsi-hint'))).toBe(
      'Sign in on cursor.com with this account again:',
    );
  });

  it('says the link ran out in the runner’s words, and offers a new one', async () => {
    const card = mount(link());
    await report(state({
      status: 'failed', engine: 'cursor', message: 'The sign-in link expired before anyone signed in with it.', reason: 'expired',
    }));
    expect(text(card.querySelector('.rsi-warn'))).toBe('The sign-in link expired before anyone signed in with it.');
    const again = card.querySelector<HTMLButtonElement>('.rsi-btn')!;
    expect(text(again)).toBe('Get a new link');
    await act(async () => again.click());
    expect(apiMock).toHaveBeenCalledWith(`/runners/${RUNNER}/login`, { method: 'POST', body: { engine: 'cursor' } });
  });

  it('offers the plain sign-in before any link was asked for', () => {
    const card = mount(state({}));
    expect(text(card.querySelector('.rsi-btn'))).toBe('Sign in to Cursor CLI');
  });
});

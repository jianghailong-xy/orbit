// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOGIN_RUNNER_BROWSER_V1, type LoginEngine, type RunnerLoginState } from '@orbit/shared';
import { RunnerSignIn } from './RunnerSignIn';

/**
 * Use the runner's browser on the sign-in card (docs/runner-browser-engine-sign-in-design.md): offered while a link
 * waits, on the account's Orbit Cloud runner when its browser is on and the runner declares login-runner-browser/v1.
 * The press opens the browser's tab in control and asks the runner to open the link there; the card then follows what
 * the runner answered.
 */

vi.mock('../api', () => ({ api: vi.fn(), ApiError: class ApiError extends Error {}, getToken: () => 'token' }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const RUNNER = 'runner-1';
const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=S1';
const state = (over: Partial<RunnerLoginState>): RunnerLoginState => ({
  status: null, engine: null, url: null, userCode: null, message: null, account: null, ...over,
});
const claudeLink = (over: Partial<RunnerLoginState> = {}) =>
  state({ status: 'awaiting_code', engine: 'claude', url: CLAUDE_URL, ...over });

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let qc: QueryClient;
let opened: Array<[string | URL | undefined, string | undefined]> = [];

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
  vi.restoreAllMocks();
});

let current: RunnerLoginState;
const report = async (next: RunnerLoginState) => {
  current = next;
  await act(async () => {
    await qc.cancelQueries({ queryKey: ['runner-login', RUNNER] });
    qc.setQueryData(['runner-login', RUNNER], next);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** The card on a runner that declares the capability (or not) and whose browser answers (or is absent). */
async function mount(initial: RunnerLoginState, { engine = 'claude', declares = true, browser = true, autoStart = false }: { engine?: LoginEngine; declares?: boolean; browser?: boolean; autoStart?: boolean } = {}) {
  current = initial;
  opened = [];
  vi.spyOn(window, 'open').mockImplementation((url?: string | URL, target?: string) => {
    opened.push([url, target]);
    return null;
  });
  apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === '/runners') return [{ id: RUNNER, capabilities: declares ? [LOGIN_RUNNER_BROWSER_V1] : [] }];
    if (path === `/runners/${RUNNER}/browser`) {
      if (!browser) throw Object.assign(new (await import('../api')).ApiError('Not found'), { status: 404 });
      return { runnerId: RUNNER, state: 'IDLE' };
    }
    if (path === `/runners/${RUNNER}/login` && options?.method === 'POST') {
      current = state({ status: 'pending', engine });
      return current;
    }
    if (path === `/runners/${RUNNER}/browser/sign-in` && options?.method === 'POST') {
      current = { ...current, browser: 'requested' };
      return current;
    }
    return current;
  });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['runner-login', RUNNER], initial);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <RunnerSignIn runnerId={RUNNER} engine={engine} autoStart={autoStart} />
      </QueryClientProvider>,
    ),
  );
  await settle();
  await settle();
  return host;
}
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const useButton = (card: Element) =>
  [...card.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === "In the runner's browser");

describe("Use the runner's browser on the sign-in card", () => {
  it('is offered beside the link, saying the login stays on the runner', async () => {
    const card = await mount(claudeLink());
    expect(useButton(card)).toBeDefined();
    // Option A: one question, both ways in one row (this browser the main one), the runner's line under it ending in
    // Copy sign-in link, and a divider before the paste.
    expect(text(card.querySelector('.rsi-q'))).toBe('Where do you want to sign in?');
    expect([...card.querySelectorAll('.rsi-actions > *')].map(text)).toEqual(['In this browser', "In the runner's browser"]);
    expect(text(card.querySelector('.rsi-runner-browser .rsi-hint'))).toBe(
      "The runner's browser keeps you signed in there; agents on this runner can use it. Copy sign-in link",
    );
    expect(card.querySelector('.rsi-sep')).not.toBeNull();
    expect(text(card.querySelector('.rsi-sep + .rsi-hint'))).toBe('After you approve, paste the code the page shows:');
    expect(card.querySelector('.rsi-input')).not.toBeNull();
  });

  it('is not offered when the runner cannot do it or has no browser', async () => {
    const old = await mount(claudeLink(), { declares: false });
    expect(useButton(old)).toBeUndefined();
    // As before: the page's button with Copy sign-in link beside it, no question, no divider.
    expect([...old.querySelectorAll('.rsi-actions > *')].map(text)).toEqual(['Open the sign-in page', 'Copy sign-in link']);
    expect(old.querySelector('.rsi-q, .rsi-sep')).toBeNull();
    expect(text(old.querySelector('.rsi-hint'))).toBe('Approve it there, then paste the code the page gives you:');
    act(() => root?.unmount());
    expect(useButton(await mount(claudeLink(), { browser: false }))).toBeUndefined();
  });

  it('opens the browser tab in control on the press and asks the runner to open the link there', async () => {
    const card = await mount(claudeLink());
    await act(async () => useButton(card)!.click());
    await settle();
    expect(opened).toEqual([[`/runners/${RUNNER}/browser?control=1`, `orbit-browser-${RUNNER}`]]);
    expect(apiMock).toHaveBeenCalledWith(`/runners/${RUNNER}/browser/sign-in`, { method: 'POST' });
    expect(text(card.querySelector('.rsi-runner-browser .rsi-row'))).toBe("Opening the sign-in page in the runner's browser…");
  });

  it('for Claude Code, waits for the code from the runner’s browser, with the paste a press away', async () => {
    const card = await mount(claudeLink({ browser: 'opened' }));
    expect(text(card.querySelector('.rsi-runner-browser .rsi-row'))).toBe(
      "Finish signing in in the runner's browser. Orbit takes the code from there.",
    );
    expect(card.querySelector('.rsi-input')).toBeNull();
    // What the runner's browser does leads; this browser is a link away, not the main button any more.
    expect(card.querySelector('.rsi-actions, a.rsi-open')).toBeNull();
    const here = [...card.querySelectorAll<HTMLAnchorElement>('.rsi-runner-browser a.rsi-link')].find((a) => text(a) === 'Open it in this browser instead');
    expect(here?.getAttribute('href')).toBe(CLAUDE_URL);
    const show = [...card.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === 'Show the browser')!;
    act(() => show.click());
    expect(opened.at(-1)).toEqual([`/runners/${RUNNER}/browser?control=1`, `orbit-browser-${RUNNER}`]);
    const paste = [...card.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === 'Paste a code instead')!;
    act(() => paste.click());
    expect(card.querySelector('.rsi-input')).not.toBeNull();
  });

  it('shows the code being used once the runner took it, and the paste again if the CLI refused it', async () => {
    const card = await mount(claudeLink({ browser: 'opened' }));
    await report(claudeLink({ browser: 'code-taken' }));
    expect(text(card.querySelector('.rsi-row'))).toBe('Signing in with your code…');
    await report(claudeLink({ browser: 'code-taken', message: "That code wasn't accepted — make sure you copied all of it, then try again." }));
    expect(text(card.querySelector('.rsi-warn'))).toContain("That code wasn't accepted");
    expect(card.querySelector('.rsi-input')).not.toBeNull();
  });

  it('says so when the runner could not open it, and can be pressed again', async () => {
    const card = await mount(claudeLink({ browser: 'failed' }));
    expect(text(card.querySelector('.rsi-runner-browser .rsi-warn'))).toBe(
      "Couldn't open the sign-in page in the runner's browser. Open it in this browser instead.",
    );
    expect(useButton(card)).toBeDefined();
  });

  it('for Antigravity, also waits for the code from the runner’s browser', async () => {
    const card = await mount(
      state({ status: 'awaiting_code', engine: 'antigravity', url: 'https://accounts.google.com/o/oauth2/auth?state=G', browser: 'opened' }),
      { engine: 'antigravity' },
    );
    expect(text(card.querySelector('.rsi-runner-browser .rsi-row'))).toBe(
      "Finish signing in in the runner's browser. Orbit takes the code from there.",
    );
    expect(card.querySelector('.rsi-input')).toBeNull();
  });

  it('for a device flow keeps the one-time code on the card', async () => {
    const card = await mount(
      state({ status: 'awaiting_approval', engine: 'codex', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', browser: 'opened' }),
      { engine: 'codex' },
    );
    expect(text(card.querySelector('.rsi-usercode'))).toBe('ABCD-1234');
    expect(text(card.querySelector('.rsi-runner-browser .rsi-row'))).toBe("Finish signing in in the runner's browser.");
  });

  it('started from the row, opens no tab, and offers both browsers once the link is there', async () => {
    const card = await mount(state({}), { autoStart: true });
    expect(apiMock).toHaveBeenCalledWith(`/runners/${RUNNER}/login`, { method: 'POST', body: { engine: 'claude' } });
    expect(text(card.querySelector('.rsi-row'))).toBe('Starting sign-in on the runner…');
    expect(card.querySelector('.rsi-btn')).toBeNull();
    await report(claudeLink());
    await settle();
    await settle();
    await settle();
    expect(text(card.querySelector('a.rsi-open'))).toBe('In this browser');
    expect(useButton(card)).toBeDefined();
    expect(opened).toEqual([]);
  });

  it('opened again while its sign-in waits on the link, takes that one up instead of starting another', async () => {
    const card = await mount(claudeLink({ browser: 'opened' }), { autoStart: true });
    const starts = apiMock.mock.calls.filter(([path, options]) => path === `/runners/${RUNNER}/login` && (options as { method?: string })?.method === 'POST');
    expect(starts).toEqual([]);
    expect(text(card.querySelector('.rsi-runner-browser .rsi-row'))).toBe("Finish signing in in the runner's browser. Orbit takes the code from there.");
  });

  it('closes the viewer tab it opened once the card says Signed in', async () => {
    const card = await mount(claudeLink());
    const viewer = { closed: false, close: vi.fn() };
    vi.mocked(window.open).mockImplementation((url?: string | URL, target?: string) => {
      opened.push([url, target]);
      return viewer as unknown as Window;
    });
    await act(async () => useButton(card)!.click());
    await settle();
    await report(claudeLink({ browser: 'opened' }));
    expect(viewer.close).not.toHaveBeenCalled();
    await report(state({ status: 'done', engine: 'claude' }));
    expect(viewer.close).toHaveBeenCalledTimes(1);
    expect(text(card)).toContain('Signed in');
  });

  it('leaves the viewer tab open when the sign-in failed, or when it was never opened from the card', async () => {
    const card = await mount(claudeLink());
    const viewer = { closed: false, close: vi.fn() };
    vi.mocked(window.open).mockImplementation(() => viewer as unknown as Window);
    await act(async () => useButton(card)!.click());
    await settle();
    await report(state({ status: 'failed', engine: 'claude', message: 'sign-in did not complete' }));
    expect(viewer.close).not.toHaveBeenCalled();
    act(() => root?.unmount());

    // Signed in through this browser: no viewer was opened, so none is closed (and nothing throws).
    await mount(claudeLink());
    await report(state({ status: 'done', engine: 'claude' }));
    expect(opened).toEqual([]);
  });
});

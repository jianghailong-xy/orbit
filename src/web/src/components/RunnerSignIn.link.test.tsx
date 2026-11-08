// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginEngine, RunnerLoginState } from '@orbit/shared';
import { RunnerSignIn, signInPage, SIGN_IN_LINK_REFUSED } from './RunnerSignIn';

/**
 * Where a sign-in may send a browser. The card takes what the runner reported through one check, at
 * every door that opens it: the parked tab, and the links it draws. The server keeps nothing else
 * (RunnerApiController.loginResult); this holds for whatever a row still carries.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const RUNNER = 'runner-1';

/** The sign-in link of each engine, in the shape its CLI prints it (runner-go's own login fixtures). */
const ENGINE_LINKS: Array<[LoginEngine, 'awaiting_code' | 'awaiting_approval', string]> = [
  ['claude', 'awaiting_code', 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=frcAznfHKdQ3nNYn157q799r9SIaDMeJqq9HqdHD2JQ&code_challenge_method=S256&state=D_hsM6JpU6Uy2Ji8q0WtyOhF_Lq8iTIkuetcNISuRs'],
  ['codex', 'awaiting_approval', 'https://auth.openai.com/codex/device'],
  ['kimi', 'awaiting_approval', 'https://www.kimi.com/code/authorize_device?user_code=SHG3-0DSI'],
  ['kimi', 'awaiting_approval', 'https://www.kimi.ai/code/authorize_device?user_code=7K06-QP86'],
  ['kimi', 'awaiting_approval', 'https://auth.kimi.com/verify?user_code=WDJB-MJHT'],
  ['antigravity', 'awaiting_code', 'https://accounts.google.com/o/oauth2/auth?response_type=code&state=fixture&code_challenge=fixture'],
  ['cursor', 'awaiting_approval', 'https://cursor.com/loginDeepControl?challenge=Q2hhbGxlbmdl&uuid=7d2e0c1a-0000-4000-8000-000000000001&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true'],
];

/** Addresses no sign-in has: other schemes in the spellings a browser reads as them, and no address at all. */
const NOT_HTTPS_LINKS = [
  'javascript:void(0)', 'JAVASCRIPT:void(0)', 'JaVaScRiPt:void(0)', ' javascript:void(0)', '  JaVaScRiPt:void(0)',
  '\tjavascript:void(0)', '\njavascript:void(0)', '\x01javascript:void(0)', 'java\tscript:void(0)', 'java\nscript:void(0)',
  'java\rscript:void(0)', 'javascript\t:void(0)',
  'data:text/html,hello', 'DATA:text/html,hello', ' data:text/html,hello', 'data:text/html;base64,aGVsbG8=', 'da\tta:text/html,hello',
  'vbscript:msgbox(0)', 'VBScript:msgbox(0)', ' vbscript:msgbox(0)',
  'http://claude.com/cai/oauth/authorize?code=true', 'HTTP://claude.com/', 'http://localhost:1455/auth/callback',
  'file:///etc/hosts', 'blob:https://orbit.test/1', 'about:blank', 'ftp://claude.com/', 'mailto:someone@example.test', 'orbit-task:1',
  '/runners', 'claude.com/cai/oauth/authorize', '//claude.com/cai/oauth/authorize', 'https:', 'https://',
];

const state = (over: Partial<RunnerLoginState>): RunnerLoginState => ({
  status: null, engine: null, url: null, userCode: null, message: null, account: null, ...over,
});

/** The tab a press parks, and everything done to it, in order. */
function parkedTab() {
  const steps: string[] = [];
  const tab = {
    closed: false,
    get opener(): unknown {
      return steps.includes('opener cleared') ? null : window;
    },
    set opener(value: unknown) {
      if (value === null) steps.push('opener cleared');
    },
    document: { write: vi.fn() },
    location: { replace: (to: string) => steps.push(`sent to ${to}`) },
    close: () => {
      tab.closed = true;
      steps.push('closed');
    },
  };
  return { tab, steps };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let qc: QueryClient;
/** What the runner's relay reports now, for the card's next read and its cache alike. */
let current: RunnerLoginState;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
beforeEach(() => {
  vi.spyOn(window, 'open');
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  vi.restoreAllMocks();
});

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

function mount(engine: LoginEngine, initial: RunnerLoginState = state({})) {
  current = initial;
  apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === `/runners/${RUNNER}/login` && options?.method === 'POST') current = state({ status: 'pending', engine });
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
        <RunnerSignIn runnerId={RUNNER} engine={engine} />
      </QueryClientProvider>,
    ),
  );
  return host;
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** Press the card's own button, with the browser handing it `tab`, and wait for the start to land. */
async function press(card: HTMLElement, tab: unknown) {
  vi.mocked(window.open).mockReturnValue(tab as Window);
  await act(async () => {
    card.querySelector<HTMLButtonElement>('.rsi-btn')!.click();
    // The query cache tells its observers on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('signInPage', () => {
  it.each(ENGINE_LINKS)('takes the link of %s as its CLI printed it', (_engine, _status, link) => {
    expect(signInPage(link)).toBe(link);
  });

  it.each(NOT_HTTPS_LINKS.map((link) => [JSON.stringify(link), link]))('refuses %s', (_label, link) => {
    expect(signInPage(link)).toBeNull();
  });

  it('has nothing to open before a link is reported', () => {
    expect(signInPage(null)).toBeNull();
    expect(signInPage(undefined)).toBeNull();
    expect(signInPage('')).toBeNull();
  });

  it('hands back the address as the browser reads it, so what is checked is what is opened', () => {
    expect(signInPage('HTTPS://CLAUDE.COM/cai')).toBe('https://claude.com/cai');
  });
});

describe('the tab a press parks', () => {
  it.each([
    ['claude', ENGINE_LINKS[0][2]],
    ['antigravity', ENGINE_LINKS[5][2]],
  ] as const)('goes to the sign-in page of %s, cut off from this page first', async (engine, link) => {
    const card = mount(engine);
    const { tab, steps } = parkedTab();
    await press(card, tab);
    await report(state({ status: 'awaiting_code', engine, url: link }));

    expect(steps).toEqual(['opener cleared', `sent to ${link}`]);
    expect(card.querySelector<HTMLAnchorElement>('a.rsi-open')?.getAttribute('href')).toBe(link);
  });

  it.each(NOT_HTTPS_LINKS.map((link) => [JSON.stringify(link), link]))('closes rather than going to %s', async (_label, link) => {
    const card = mount('claude');
    const { tab, steps } = parkedTab();
    await press(card, tab);
    await report(state({ status: 'awaiting_code', engine: 'claude', url: link }));

    expect(steps).toEqual(['closed']);
    expect(text(card.querySelector('.rsi-warn'))).toBe(SIGN_IN_LINK_REFUSED);
    expect(card.querySelector('a.rsi-open')).toBeNull();
    expect(text(card)).not.toContain('Copy sign-in link');
  });

  it('closes on the failure the server reports for a link it refused, and says it in the server’s words', async () => {
    const card = mount('claude');
    const { tab, steps } = parkedTab();
    await press(card, tab);
    await report(state({ status: 'failed', engine: 'claude', message: 'From the server.' }));

    expect(steps).toEqual(['closed']);
    expect(text(card.querySelector('.rsi-warn'))).toBe('From the server.');
  });

  it('is left alone when the person closed it first', async () => {
    const card = mount('claude');
    const { tab, steps } = parkedTab();
    await press(card, tab);
    tab.closed = true;
    await report(state({ status: 'awaiting_code', engine: 'claude', url: ENGINE_LINKS[0][2] }));

    expect(steps).toEqual([]);
  });
});

describe('the links the card draws', () => {
  it.each(ENGINE_LINKS)('offers the link of %s', (engine, status, link) => {
    const card = mount(engine, state({ status, engine, url: link, userCode: status === 'awaiting_approval' ? 'ABCD-1234' : null }));

    const open = card.querySelector<HTMLAnchorElement>('a.rsi-open')!;
    expect(open.getAttribute('href')).toBe(link);
    expect(open.getAttribute('rel')).toBe('noopener noreferrer');
    expect(card.querySelector('.rsi-warn')).toBeNull();
  });

  // Every shape the card has for a link: the paste-back form, the device flow, Cursor CLI's, Kimi's.
  it.each([
    ['claude', 'awaiting_code'],
    ['antigravity', 'awaiting_code'],
    ['codex', 'awaiting_approval'],
    ['kimi', 'awaiting_approval'],
    ['cursor', 'awaiting_approval'],
  ] as const)('offers no way to %s’s link when it is not https, and says why', (engine, status) => {
    for (const url of NOT_HTTPS_LINKS) {
      const card = mount(engine, state({ status, engine, url, userCode: 'ABCD-1234' }));

      expect(text(card.querySelector('.rsi-warn')), url).toBe(SIGN_IN_LINK_REFUSED);
      expect(card.querySelector('a.rsi-open'), url).toBeNull();
      expect(text(card), url).not.toContain('ABCD-1234');
      expect(text(card), url).not.toContain('Copy sign-in link');
      act(() => root?.unmount());
      host?.remove();
    }
    root = host = null;
  });

  it('lets the sign-in start again from there', async () => {
    const card = mount('claude', state({ status: 'awaiting_code', engine: 'claude', url: 'data:text/html,hello' }));
    const again = card.querySelector<HTMLButtonElement>('.rsi-btn')!;
    expect(text(again)).toBe('Try signing in to Claude Code again');

    const { tab, steps } = parkedTab();
    await press(card, tab);
    expect(apiMock).toHaveBeenCalledWith(`/runners/${RUNNER}/login`, { method: 'POST', body: { engine: 'claude' } });
    await report(state({ status: 'awaiting_code', engine: 'claude', url: ENGINE_LINKS[0][2] }));
    expect(steps).toEqual(['opener cleared', `sent to ${ENGINE_LINKS[0][2]}`]);
    expect(card.querySelector('.rsi-warn')).toBeNull();
  });

  it('says nothing of another engine’s sign-in on the runner', () => {
    const card = mount('codex', state({ status: 'awaiting_code', engine: 'claude', url: 'data:text/html,hello' }));

    expect(card.querySelector('.rsi-warn')).toBeNull();
    expect(text(card.querySelector('.rsi-btn'))).toBe('Sign in to Codex');
  });
});

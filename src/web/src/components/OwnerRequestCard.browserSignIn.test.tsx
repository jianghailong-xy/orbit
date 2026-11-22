// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSnoozesForTest, type OwnerRequest } from '../lib/ownerRequests';
import { OwnerRequestCard, OwnerRequestResolved } from './OwnerRequestCard';

/**
 * The card an agent files when the Orbit Cloud browser needs the owner to sign in (browser_request_sign_in): the site,
 * the agent's reason quoted, the session that asked, and what signing in there means; Open browser opens the runner's
 * browser tab in control and answers nothing, Not now declines. The api mock keeps every write.
 */

vi.mock('../api', () => ({ api: vi.fn(), getToken: () => null, ApiError: class extends Error {} }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-19T09:00:00.000Z');
const RUNNER = '0196e300-0000-7000-8000-0000000000c1';

function signInRequest(over: Partial<OwnerRequest> = {}): OwnerRequest {
  return {
    id: 'req-sign-in',
    kind: 'BROWSER_SIGN_IN',
    state: 'PENDING',
    title: 'Sign in to github.com',
    why: 'I need to open a pull request on your fork.',
    blocksTaskIds: [],
    ifUnanswered: null,
    options: null,
    recommendedOption: null,
    steps: null,
    secretSpec: null,
    secretGrant: null,
    verifyHint: null,
    browserSite: 'github.com',
    browserRunnerId: RUNNER,
    askedBySessionTitle: 'Fix login redirect',
    expiresAt: null,
    askedBySessionId: '34uOqHiF7f3VmoARfQg6y',
    projectId: null,
    resolvedAt: null,
    resolvedByUserId: null,
    resolvedBySessionId: null,
    resolutionNote: null,
    answer: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

let root: Root | null = null;
let host: HTMLElement;
let writes: Array<{ path: string; body: unknown }> = [];

async function mount(node: JSX.Element) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
  });
  await flush();
}

const words = (node: Element | null | undefined): string => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const button = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((b) => words(b) === name);
  if (!found) throw new Error(`no button named ${name}: ${host.textContent}`);
  return found;
};
async function press(target: HTMLElement) {
  await act(async () => { target.click(); });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetSnoozesForTest();
  writes = [];
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (init?.method === 'POST') {
      writes.push({ path, body: init.body });
      if (path.endsWith('/decline')) {
        return signInRequest({ state: 'DECLINED', resolvedAt: new Date(NOW).toISOString(), resolvedByUserId: 'me', resolutionNote: (init.body as { reason: string }).reason }) as never;
      }
    }
    if (path === '/runners') return [] as never;
    if (path.startsWith('/owner-requests?')) return { requests: [] } as never;
    throw new Error(`unexpected ${path}`);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('the BROWSER_SIGN_IN card', () => {
  it('says what is needed, why, who asked and what signing in there means', async () => {
    await mount(<OwnerRequestCard now={NOW} request={signInRequest()} />);
    expect(words(host.querySelector('.owner-request-eyebrow'))).toBe('Sign in needed · Orbit Cloud browser');
    expect(words(host.querySelector('.owner-request-title'))).toBe('Sign in to github.com');
    expect(words(host.querySelector('.owner-request-kind'))).toBe('SIGN IN');
    expect(words(host.querySelector('.owner-request-why'))).toBe('“I need to open a pull request on your fork.”');
    const notices = [...host.querySelectorAll('.owner-request-notice')].map(words);
    expect(notices).toEqual([
      'From session Fix login redirect',
      'You sign in yourself; Orbit never sees your password. The login stays on this runner, and every agent on it can use it.',
    ]);
    expect([...host.querySelectorAll('.owner-request-actions button')].map(words)).toEqual(['Open browser', 'Not now']);
  });

  it('leaves out From session when the session has no title', async () => {
    await mount(<OwnerRequestCard now={NOW} request={signInRequest({ askedBySessionTitle: null })} />);
    expect(host.textContent).not.toContain('From session');
  });

  it('opens the runner’s browser tab in control on Open browser, and answers nothing', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await mount(<OwnerRequestCard now={NOW} request={signInRequest()} />);
    await press(button('Open browser'));
    expect(open).toHaveBeenCalledWith(`/runners/${RUNNER}/browser?control=1`, `orbit-browser-${RUNNER}`);
    expect(writes).toEqual([]);
    expect(button('Open browser')).toBeTruthy();
  });

  it('declines with Not now, and reads as Not now', async () => {
    await mount(<OwnerRequestCard now={NOW} request={signInRequest()} />);
    await press(button('Not now'));
    expect(writes).toEqual([{ path: '/owner-requests/req-sign-in/decline', body: { reason: 'Not now' } }]);
    expect(words(host.querySelector('.owner-request-resolved-outcome'))).toBe('Not now');
  });

  it('names the site once signed in', async () => {
    await mount(
      <OwnerRequestResolved
        now={NOW}
        request={signInRequest({ state: 'DONE', resolvedAt: new Date(NOW).toISOString(), resolvedByUserId: 'me' })}
      />,
    );
    expect(words(host.querySelector('.owner-request-resolved-outcome'))).toBe('Signed in to github.com');
  });

  it('reads Not now once declined', async () => {
    await mount(
      <OwnerRequestResolved
        now={NOW}
        request={signInRequest({ state: 'DECLINED', resolvedAt: new Date(NOW).toISOString(), resolvedByUserId: 'me', resolutionNote: 'Not now' })}
      />,
    );
    expect(words(host.querySelector('.owner-request-resolved-outcome'))).toBe('Not now');
  });
});

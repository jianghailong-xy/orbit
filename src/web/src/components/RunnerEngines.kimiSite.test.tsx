// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { KIMI_LOGIN_REGION_V1, type RunnerEngineHealth, type RunnerLoginState } from '@orbit/shared';
import { RunnerEngines } from './RunnerEngines';
import { clickRunnerMenuItem } from './RunnerEngines.test-helpers';
import type { Runner } from './TasksSidePanel';

/**
 * Signing Kimi Code in on the Providers page, on the site the account belongs to.
 *
 * Mounted into a real DOM and pressed through to the mocked `api()`, because what matters is the body
 * the press sends: the site a runner is told to sign in on is the site its account has to be on, and
 * a press that sent the other one would look exactly right in a static render.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// = uuidToBase62('019fc086-c7c7-7c92-8215-778ad8a6280a'): the Manage link encodes it.
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const CAN_CHOOSE = ['session-worktree-ops-v1', KIMI_LOGIN_REGION_V1];

const runner = (kimi: Partial<RunnerEngineHealth>, over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: 'hpc',
  online: true,
  capabilities: CAN_CHOOSE,
  engines: [
    { engine: 'claude', installed: true, auth: 'yes' },
    { engine: 'kimi', installed: true, version: '2.1.1', auth: 'no', ...kimi },
  ],
  ...over,
});

const IDLE: RunnerLoginState = { status: null, engine: null, url: null, userCode: null, message: null, account: null };

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  localStorage.clear();
});

/** The Providers section over this runner, its card open, with the relay reading `login`. */
function mount(r: Runner, login: RunnerLoginState = IDLE) {
  localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify([r.id]));
  apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === '/runners') return [r];
    if (path.endsWith('/login') && (options?.method ?? 'GET') === 'GET') return login;
    return { ...IDLE, status: 'pending', engine: 'kimi' };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], [r]);
  qc.setQueryData(['runner-login', r.id], login);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={['/providers']}>
        <QueryClientProvider client={qc}>
          <RunnerEngines />
        </QueryClientProvider>
      </MemoryRouter>,
    ),
  );
  return host;
}

const kimiRow = (page: ParentNode) => {
  const row = page.querySelector<HTMLElement>('[data-engine="kimi"]');
  if (!row) throw new Error('no Kimi row');
  return row;
};
const buttons = (el: ParentNode) => [...el.querySelectorAll<HTMLButtonElement>('button')];
const button = (el: ParentNode, label: string) => {
  const found = buttons(el).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no "${label}" button in ${el.textContent}`);
  return found;
};
/** A site's button, by its domain. */
const site = (el: ParentNode, domain: string) => {
  const found = [...el.querySelectorAll<HTMLButtonElement>('.rsi-site')].find(
    (b) => b.querySelector('.rsi-site-name')?.firstChild?.textContent === domain,
  );
  if (!found) throw new Error(`no ${domain} in ${el.textContent}`);
  return found;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
};
const loginPosts = () =>
  apiMock.mock.calls
    .filter(([path, options]) => path === `/runners/${RUNNER_ID}/login` && options?.method === 'POST')
    .map(([, options]) => options?.body);

describe('signing Kimi in from its row', () => {
  it.each([
    ['kimi.ai', 'global'],
    ['kimi.com', 'mainland-cn'],
  ] as const)('starts the sign-in on %s when that is pressed', async (domain, region) => {
    const page = mount(runner({}));
    await click(button(kimiRow(page), 'Sign in'));
    expect(kimiRow(page).querySelector('.rsi-q')?.textContent).toBe('Which Kimi account are you signing in with?');
    await click(site(kimiRow(page), domain));
    expect(loginPosts()).toEqual([{ engine: 'kimi', region }]);
  });

  it('names no site on a runner that cannot be told one, and keeps kimi.ai out of reach', async () => {
    const page = mount(runner({}, { capabilities: ['session-worktree-ops-v1'] }));
    await click(button(kimiRow(page), 'Sign in'));
    expect(site(kimiRow(page), 'kimi.ai').disabled).toBe(true);
    // A bare `kimi login`, as before the choice: a site in the body would be refused at the runner's
    // next heartbeat instead of signing in.
    await click(site(kimiRow(page), 'kimi.com'));
    expect(loginPosts()).toEqual([{ engine: 'kimi' }]);
  });

  it("says on the row which site the login is on, and marks it when signing in again", async () => {
    const page = mount(runner({ auth: 'yes', kimiRegion: 'global' }));
    expect(kimiRow(page).querySelector('.re-meta')?.textContent).toBe('2.1.1 · kimi.ai');
    await clickRunnerMenuItem(kimiRow(page), 'Re-sign in');
    expect(site(kimiRow(page), 'kimi.ai').querySelector('.rsi-site-tag')?.textContent).toBe('Current');
    expect(site(kimiRow(page), 'kimi.com').querySelector('.rsi-site-tag')).toBeNull();
    // Moving to the other site is the other press.
    await click(site(kimiRow(page), 'kimi.com'));
    expect(loginPosts()).toEqual([{ engine: 'kimi', region: 'mainland-cn' }]);
  });

  it('starts over on the other site from the device code', async () => {
    const page = mount(runner({}), {
      ...IDLE,
      status: 'awaiting_approval',
      engine: 'kimi',
      url: 'https://www.kimi.ai/code/authorize_device?user_code=7K06-QP86',
      userCode: '7K06-QP86',
    });
    await click(button(kimiRow(page), 'Sign in'));
    const open = kimiRow(page).querySelector<HTMLAnchorElement>('.rsi-open');
    expect(open?.textContent?.trim()).toBe('Open the kimi.ai sign-in page');
    expect(open?.getAttribute('href')).toBe('https://www.kimi.ai/code/authorize_device?user_code=7K06-QP86');
    await click(button(kimiRow(page), 'Use kimi.com instead'));
    expect(loginPosts()).toEqual([{ engine: 'kimi', region: 'mainland-cn' }]);
  });
});

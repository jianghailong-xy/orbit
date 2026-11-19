// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerBrowserState } from '@orbit/shared';
import { SessionBrowserChip } from './SessionBrowserChip';
import { RunnerBrowserSection } from './settings/RunnerBrowserSection';

/**
 * The web viewer of the Orbit Cloud runner's browser (docs/runner-browser-design.md §5, board frames 4–9): the
 * session's Browser chip and when it shows, the drawer view only by default, Take control and Hand back as shared
 * input that never reaches the session, Settings' Open browser in control with Done, Clear saved logins behind a
 * confirmation, and nothing at all while the server reports the browser off.
 *
 * noVNC is replaced by a stand-in that records what the viewer asked of it: `viewOnly` is the one switch between
 * watching and sending pointer and keys (noVNC drops every input event while it is true).
 */

const vnc = vi.hoisted(() => {
  const made: Array<{ url: string; viewOnly: boolean; scaleViewport: boolean; disconnected: boolean; target: HTMLElement }> = [];
  class FakeRFB {
    viewOnly = false;
    scaleViewport = false;
    resizeSession = true;
    focusOnClick = true;
    disconnected = false;
    private listeners: Record<string, Array<(event: Event) => void>> = {};
    constructor(
      public target: HTMLElement,
      public url: string,
    ) {
      made.push(this);
      queueMicrotask(() => this.listeners.connect?.forEach((listener) => listener(new Event('connect'))));
    }
    addEventListener(type: string, listener: (event: Event) => void) {
      (this.listeners[type] ??= []).push(listener);
    }
    disconnect() {
      this.disconnected = true;
    }
    focus() {}
  }
  return { made, FakeRFB };
});
vi.mock('@novnc/novnc', () => ({ default: vnc.FakeRFB }));

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: vi.fn(),
  getToken: () => 'web-login',
}));
const { api, ApiError } = await import('../api');
const apiMock = vi.mocked(api);

const RUNNER = '34z8OKBXxDRYsIZwzJ35R';
const SESSION = '34z8OKBXxDRYsIZwzJ35S';

const running = (over: Partial<RunnerBrowserState> = {}): RunnerBrowserState => ({
  runnerId: RUNNER,
  state: 'RUNNING',
  holderSessionId: SESSION,
  holderTitle: 'Check the signup form on the staging site',
  viewers: 0,
  reportedAt: '2026-11-18T05:00:00.000Z',
  clearRequestedAt: null,
  profileClearedAt: null,
  ...over,
});

/** What GET /runners/:id/browser answers: a state, or 'off' for the 404 a server with the switch off gives. */
let browser: RunnerBrowserState | 'off' = 'off';
/** Every request the page made, as `METHOD path`. */
let calls: string[] = [];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});
beforeEach(() => {
  browser = 'off';
  calls = [];
  vnc.made.length = 0;
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === `/runners/${RUNNER}/browser`) {
      if (browser === 'off') throw new ApiError(`Cannot GET /api/runners/${RUNNER}/browser`, 404);
      return browser;
    }
    if (path === `/runners/${RUNNER}/browser/clear` && init?.method === 'POST') return { requestedAt: '2026-11-18T05:01:00.000Z' };
    throw new Error(`no ${path} here`);
  });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root!.render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>));
  await settle();
}

const chip = () => host!.querySelector<HTMLButtonElement>('.rb-chip');
const drawer = () => document.querySelector<HTMLElement>('.rb-drawer');
const buttonNamed = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === name) ?? null;
async function press(button: HTMLElement | null) {
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  await settle();
}
/** The requests other than reading the browser's state: what the viewer sent anywhere else. */
const writes = () => calls.filter((call) => call !== `GET /runners/${RUNNER}/browser`);

describe('the session Browser chip', () => {
  it('shows when the switch is on, the session runs on the managed runner, and the browser is running', async () => {
    browser = running();
    await mount(<SessionBrowserChip managedRunnerId={RUNNER} sessionId={SESSION} />);
    expect(chip()?.textContent).toBe('Browser');
    expect(chip()?.querySelector('.rb-chip-dot')).not.toBeNull();
  });

  it('is not drawn while the browser is not running', async () => {
    browser = running({ state: 'IDLE', holderSessionId: null, holderTitle: null });
    await mount(<SessionBrowserChip managedRunnerId={RUNNER} sessionId={SESSION} />);
    expect(chip()).toBeNull();
    expect(host!.innerHTML).toBe('');
  });

  it('reads nothing and draws nothing for a session on any other runner', async () => {
    browser = running();
    await mount(<SessionBrowserChip managedRunnerId={null} sessionId={SESSION} />);
    expect(host!.innerHTML).toBe('');
    expect(calls).toEqual([]);
  });

  it('draws nothing when the server reports the browser off (404)', async () => {
    browser = 'off';
    await mount(<SessionBrowserChip managedRunnerId={RUNNER} sessionId={SESSION} />);
    expect(calls).toEqual([`GET /runners/${RUNNER}/browser`]);
    expect(host!.innerHTML).toBe('');
  });
});

describe('the drawer from a session', () => {
  it('opens view only on the runner viewer stream, saying who holds the browser', async () => {
    browser = running();
    await mount(<SessionBrowserChip managedRunnerId={RUNNER} sessionId={SESSION} />);
    await press(chip());
    expect(drawer()).not.toBeNull();
    expect(vnc.made).toHaveLength(1);
    expect(vnc.made[0].url).toBe(`ws://${window.location.host}/api/runners/${RUNNER}/browser/vnc?access_token=web-login`);
    expect(vnc.made[0].viewOnly).toBe(true);
    expect(vnc.made[0].scaleViewport).toBe(true);
    expect(drawer()!.querySelector('.orbit-overlay-title')?.textContent).toBe('Browser');
    expect(drawer()!.textContent).toContain('View only');
    expect(buttonNamed('Take control')).not.toBeNull();
    expect(drawer()!.querySelector('.rb-holder')?.textContent).toBe('Used by this session');
    expect(drawer()!.querySelector('.rb-link')?.textContent).toBe('Live');
    expect(drawer()!.classList.contains('is-controlling')).toBe(false);
  });

  it('names another session that holds the browser, and none when nobody does', async () => {
    browser = running({ holderSessionId: '34z8OKBXxDRYsIZwzJ35T', holderTitle: 'Book the venue' });
    await mount(<SessionBrowserChip managedRunnerId={RUNNER} sessionId={SESSION} />);
    await press(chip());
    expect(drawer()!.querySelector('.rb-holder')?.textContent).toBe('Used by “Book the venue” · it keeps running');
    act(() => root!.unmount());
    host!.remove();
    browser = running({ holderSessionId: null, holderTitle: null });
    await mount(<SessionBrowserChip managedRunnerId={RUNNER} sessionId={SESSION} />);
    await press(chip());
    expect(drawer()!.querySelector('.rb-holder')?.textContent).toBe('Not in use by any session');
  });

  it('Take control sends pointer and keys, says the agent keeps running, and interrupts nothing', async () => {
    browser = running();
    await mount(<SessionBrowserChip managedRunnerId={RUNNER} sessionId={SESSION} />);
    await press(chip());
    await press(buttonNamed('Take control'));
    // The same stream, now sending input: not a new one, and not closed.
    expect(vnc.made).toHaveLength(1);
    expect(vnc.made[0].viewOnly).toBe(false);
    expect(vnc.made[0].disconnected).toBe(false);
    expect(drawer()!.querySelector('.orbit-overlay-title')?.textContent).toBe(
      'You are controlling the browser · the agent keeps running',
    );
    expect(drawer()!.classList.contains('is-controlling')).toBe(true);
    expect(drawer()!.querySelector('.rb-screen.is-controlling')).not.toBeNull();
    expect(drawer()!.querySelector('.rb-holder')?.textContent).toBe("Your pointer and keys go to the runner's browser");
    expect(buttonNamed('Hand back')).not.toBeNull();
    // No interrupt, stop or message to the session: the only request ever made is reading the browser's state.
    expect(writes()).toEqual([]);
  });

  it('Hand back stops sending input and sends nothing to the agent', async () => {
    browser = running();
    await mount(<SessionBrowserChip managedRunnerId={RUNNER} sessionId={SESSION} />);
    await press(chip());
    await press(buttonNamed('Take control'));
    await press(buttonNamed('Hand back'));
    expect(vnc.made).toHaveLength(1);
    expect(vnc.made[0].viewOnly).toBe(true);
    expect(vnc.made[0].disconnected).toBe(false);
    expect(drawer()!.querySelector('.orbit-overlay-title')?.textContent).toBe('Browser');
    expect(drawer()!.classList.contains('is-controlling')).toBe(false);
    expect(buttonNamed('Take control')).not.toBeNull();
    expect(writes()).toEqual([]);
  });

  it('closing the drawer closes the stream', async () => {
    browser = running();
    await mount(<SessionBrowserChip managedRunnerId={RUNNER} sessionId={SESSION} />);
    await press(chip());
    await press(document.querySelector<HTMLButtonElement>('.orbit-overlay-close'));
    expect(vnc.made[0].disconnected).toBe(true);
    expect(writes()).toEqual([]);
  });
});

describe('Settings → Orbit Cloud runner → Browser', () => {
  it('draws nothing when the server reports the browser off (404)', async () => {
    browser = 'off';
    await mount(<RunnerBrowserSection runnerId={RUNNER} />);
    expect(host!.innerHTML).toBe('');
  });

  it('shows Open browser, the saved-logins line and Clear saved logins', async () => {
    browser = running({ state: 'IDLE', holderSessionId: null, holderTitle: null });
    await mount(<RunnerBrowserSection runnerId={RUNNER} />);
    const section = host!.querySelector('.machine-section-browser')!;
    expect(section.querySelector('.settings-section-title')?.textContent).toBe('Browser');
    expect(section.textContent).toContain('Idle · not running');
    expect(buttonNamed('Open browser')).not.toBeNull();
    expect(section.textContent).toContain(
      'Sites you sign in to here stay signed in on this runner. Agents on this runner can use them.',
    );
    expect(buttonNamed('Clear saved logins')).not.toBeNull();
  });

  it('Open browser opens the drawer already in control, with Done instead of Hand back', async () => {
    browser = running({ state: 'IDLE', holderSessionId: null, holderTitle: null });
    await mount(<RunnerBrowserSection runnerId={RUNNER} />);
    await press(buttonNamed('Open browser'));
    // Opening the viewer stream is what starts Chrome on the runner.
    expect(vnc.made).toHaveLength(1);
    expect(vnc.made[0].url).toContain(`/api/runners/${RUNNER}/browser/vnc`);
    expect(vnc.made[0].viewOnly).toBe(false);
    expect(drawer()!.querySelector('.orbit-overlay-title')?.textContent).toBe('You are controlling the browser');
    expect(drawer()!.classList.contains('is-controlling')).toBe(true);
    expect(buttonNamed('Done')).not.toBeNull();
    expect(buttonNamed('Hand back')).toBeNull();
    expect(drawer()!.querySelector('.rb-holder')?.textContent).toBe('Not in use by any session');
    expect(host!.textContent).toContain('Running · you are in control');
    // Done stops sending input and closes the drawer; nothing is sent anywhere.
    await press(buttonNamed('Done'));
    expect(vnc.made[0].viewOnly).toBe(true);
    expect(vnc.made[0].disconnected).toBe(true);
    expect(drawer()).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('says in the footer which session holds the browser, and asks nothing', async () => {
    browser = running();
    await mount(<RunnerBrowserSection runnerId={RUNNER} />);
    expect(host!.textContent).toContain('Running · used by “Check the signup form on the staging site”');
    await press(buttonNamed('Open browser'));
    expect(drawer()!.querySelector('.rb-holder')?.textContent).toBe(
      'Used by “Check the signup form on the staging site” · it keeps running',
    );
    expect(document.querySelector('.orbit-confirm')).toBeNull();
    expect(vnc.made[0].viewOnly).toBe(false);
  });

  it('Clear saved logins asks for confirmation first', async () => {
    browser = running({ state: 'IDLE', holderSessionId: null, holderTitle: null });
    await mount(<RunnerBrowserSection runnerId={RUNNER} />);
    await press(buttonNamed('Clear saved logins'));
    const dialog = document.querySelector<HTMLElement>('.orbit-confirm');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('Clear saved logins?');
    expect(writes()).toEqual([]);
    await press(buttonNamed('Cancel'));
    expect(writes()).toEqual([]);

    await press(buttonNamed('Clear saved logins'));
    await press(buttonNamed('Clear'));
    expect(writes()).toEqual([`POST /runners/${RUNNER}/browser/clear`]);
  });
});

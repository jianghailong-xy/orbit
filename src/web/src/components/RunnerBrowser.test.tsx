// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerBrowserState } from '@orbit/shared';
import type { OwnerRequest } from '../lib/ownerRequests';
import { RunnerBrowserSection } from './settings/RunnerBrowserSection';
import { RunnerBrowserPage } from '../pages/RunnerBrowserPage';

/**
 * The web viewer of the Orbit Cloud runner's browser (docs/runner-browser-design.md §5; board 02 frames ② ③):
 * Settings' Open browser opening the browser's own tab in control; the tab at /runners/:id/browser in control
 * (Fit / 100%, Done, paste) and view only (Take control); Clear saved logins behind a confirmation; and nothing at all while the server reports the browser off.
 *
 * noVNC is replaced by a stand-in that records what the viewer asked of it: `viewOnly` is the one switch between
 * watching and sending pointer and keys (noVNC drops every input event while it is true), and the keys that reach
 * its canvas. The viewer's WebSocket is a stand-in too, recording the text messages the viewer sends on it.
 */

const vnc = vi.hoisted(() => {
  /** The viewer's WebSocket: open at once; what the viewer sends, and a way to answer it. */
  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    static sockets: FakeWebSocket[] = [];
    readyState = 1;
    binaryType = 'blob';
    sent: string[] = [];
    constructor(public url: string) {
      super();
      FakeWebSocket.sockets.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
    /** The viewer's text messages, parsed. */
    messages(): Array<{ type: string; on?: boolean; id?: number; text?: string }> {
      return this.sent.map((m) => JSON.parse(m));
    }
    /** A text message from the server. */
    answer(message: object) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    }
  }
  const made: FakeRFB[] = [];
  /** When set, the next stream fails before it ever connects. */
  const failNext = { value: false };
  class FakeRFB {
    viewOnly = false;
    scaleViewport = false;
    clipViewport = true;
    resizeSession = true;
    focusOnClick = true;
    background = '';
    disconnected = false;
    /** Keys that reached noVNC's canvas. */
    keys: string[] = [];
    canvas: HTMLCanvasElement;
    private listeners: Record<string, Array<(event: Event) => void>> = {};
    constructor(
      public target: HTMLElement,
      public channel: FakeWebSocket,
    ) {
      made.push(this);
      this.canvas = document.createElement('canvas');
      this.canvas.width = 1280;
      this.canvas.height = 800;
      this.canvas.tabIndex = -1;
      // noVNC's keyboard listens on its canvas.
      this.canvas.addEventListener('keydown', (e) => this.keys.push(`${e.ctrlKey || e.metaKey ? 'mod+' : ''}${e.key}`));
      target.appendChild(this.canvas);
      const fail = failNext.value;
      failNext.value = false;
      queueMicrotask(() => this.emit(fail ? 'disconnect' : 'connect'));
    }
    emit(type: string, event: Event = new Event(type)) {
      this.listeners[type]?.forEach((listener) => listener(event));
    }
    addEventListener(type: string, listener: (event: Event) => void) {
      (this.listeners[type] ??= []).push(listener);
    }
    disconnect() {
      this.disconnected = true;
    }
    focus() {
      this.canvas.focus();
    }
  }
  return { made, FakeRFB, FakeWebSocket, failNext };
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
  savedLogins: null,
  ...over,
});

/** What GET /runners/:id/browser answers: a state, or 'off' for the 404 a server with the switch off gives. */
let browser: RunnerBrowserState | 'off' = 'off';
/** Every request the page made, as `METHOD path`. */
let calls: string[] = [];
/** The owner's open requests, as GET /owner-requests?state=open answers them. */
let openRequests: OwnerRequest[] = [];
/** GET /runners/:id/login: the runner's engine sign-in, as the sign-in card reads it. */
let login: Record<string, unknown> = { status: null, engine: null, url: null, userCode: null, message: null };
/** The last mount's query client, to re-read a list as the realtime stream would. */
let queryClient: QueryClient | null = null;

const signIn = (over: Partial<OwnerRequest> = {}): OwnerRequest => ({
  id: 'req-sign-in',
  kind: 'BROWSER_SIGN_IN',
  state: 'PENDING',
  title: 'Sign in to github.com',
  why: 'Sign in to the account that owns acme/billing, so I can export the report.',
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
  askedBySessionTitle: 'Export the monthly report from GitHub',
  expiresAt: null,
  askedBySessionId: SESSION,
  projectId: null,
  resolvedAt: null,
  resolvedByUserId: null,
  resolvedBySessionId: null,
  resolutionNote: null,
  answer: null,
  createdAt: '2026-11-18T05:00:00.000Z',
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** Every window.open, as [url, target]. */
let opened: Array<[string, string]> = [];
/** What the viewer wrote to the local clipboard. */
let clipboard: string[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('WebSocket', vnc.FakeWebSocket);
  vi.stubGlobal('open', (url: string, target: string) => {
    opened.push([url, target]);
    return null;
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => void clipboard.push(text) },
  });
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
  openRequests = [];
  login = { status: null, engine: null, url: null, userCode: null, message: null };
  opened = [];
  clipboard = [];
  vnc.made.length = 0;
  vnc.FakeWebSocket.sockets.length = 0;
  vnc.failNext.value = false;
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === `/runners/${RUNNER}/browser`) {
      if (browser === 'off') throw new ApiError(`Cannot GET /api/runners/${RUNNER}/browser`, 404);
      return browser;
    }
    if (path === `/runners/${RUNNER}/browser/clear` && init?.method === 'POST') return { requestedAt: '2026-11-18T05:01:00.000Z' };
    if (path === '/owner-requests?state=open') return { requests: openRequests };
    if (path === `/runners/${RUNNER}/login`) return login;
    const done = /^\/owner-requests\/([^/]+)\/done$/.exec(path);
    if (done && init?.method === 'POST') {
      const answered = openRequests.find((r) => r.id === decodeURIComponent(done[1]));
      openRequests = openRequests.filter((r) => r !== answered);
      return { ...answered, state: 'DONE' };
    }
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
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient = qc;
  act(() => root!.render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>));
  await settle();
}

const buttonNamed = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === name) ?? null;
async function press(button: HTMLElement | null) {
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  await settle();
}
/** The requests other than reads: what the viewer sent anywhere. */
const writes = () => calls.filter((call) => !call.startsWith('GET '));


const SECRET = '密码 Pässwörd 🔑';
const socket = (i = 0) => vnc.FakeWebSocket.sockets[i];
const pastesSent = (i = 0) => socket(i).messages().filter((m) => m.type === 'paste');
const controlSaid = (i = 0) => socket(i).messages().filter((m) => m.type === 'control').map((m) => m.on);

/** The browser's paste: the clipboard's text, as `paste` on the focused element. */
async function pasteText(target: Element, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => (type === 'text/plain' ? text : '') } });
  await act(async () => void target.dispatchEvent(event));
  await settle();
}

/** ⌘V / Ctrl+V pressed on noVNC's canvas, then the paste the browser fires on the element that has focus. */
async function pressPaste(text: string, mod: 'ctrlKey' | 'metaKey' = 'ctrlKey') {
  const canvas = vnc.made[vnc.made.length - 1].canvas;
  canvas.focus();
  await act(async () => void canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', [mod]: true, bubbles: true, cancelable: true })));
  await pasteText(document.activeElement ?? canvas, text);
  await act(async () => void canvas.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', code: 'KeyV', [mod]: true, bubbles: true })));
}

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

  it('Open browser opens the browser in a tab of its own, already in control, and no stream here', async () => {
    browser = running();
    await mount(<RunnerBrowserSection runnerId={RUNNER} />);
    expect(host!.textContent).toContain('Running · used by “Check the signup form on the staging site”');
    await press(buttonNamed('Open browser'));
    expect(opened).toEqual([[`/runners/${RUNNER}/browser?control=1`, `orbit-browser-${RUNNER}`]]);
    expect(vnc.made).toHaveLength(0);
    expect(document.querySelector('.orbit-confirm')).toBeNull();
    expect(writes()).toEqual([]);
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

describe('the browser in a tab of its own, /runners/:id/browser', () => {
  let where = '';
  function Where() {
    const location = useLocation();
    where = location.pathname + location.search;
    return null;
  }
  const openTab = (path: string) =>
    mount(
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <Routes>
          <Route path="/runners/:id/browser" element={<RunnerBrowserPage />} />
          <Route path="/sessions/:id" element={<p>the session</p>} />
        </Routes>
      </MemoryRouter>,
    );
  const bar = () => host!.querySelector<HTMLElement>('.rb-tab-bar');
  const foot = () => host!.querySelector<HTMLElement>('.rb-tab-foot');

  it('is not found while the server reports the browser off, and opens no stream', async () => {
    browser = 'off';
    await openTab(`/runners/${RUNNER}/browser?control=1`);
    expect(host!.textContent).toContain('Page not found');
    expect(vnc.made).toHaveLength(0);
    expect(vnc.FakeWebSocket.sockets).toHaveLength(0);
  });

  it('opened in control: the bar, Fit / 100% and Done; the footer with who uses it, paste, size and Live', async () => {
    browser = running({ holderSessionId: null, holderTitle: null });
    await openTab(`/runners/${RUNNER}/browser?control=1`);
    expect(document.title).toBe('Browser · Orbit Cloud');
    // The address is the tab's own.
    expect(where).toBe(`/runners/${RUNNER}/browser`);
    expect(vnc.made).toHaveLength(1);
    expect(vnc.made[0].viewOnly).toBe(false);
    expect(vnc.made[0].scaleViewport).toBe(true);
    expect(controlSaid()).toEqual([true]);
    expect(host!.querySelector('.rb-tab')!.classList.contains('is-controlling')).toBe(true);
    expect(bar()!.querySelector('.rb-tab-title')?.textContent).toBe('You are controlling the browser · the agent keeps running');
    expect(buttonNamed('Fit')?.getAttribute('aria-pressed')).toBe('true');
    expect(buttonNamed('100%')?.getAttribute('aria-pressed')).toBe('false');
    expect(buttonNamed('Done')).not.toBeNull();
    expect(buttonNamed('Take control')).toBeNull();
    expect(foot()!.querySelector('.rb-holder')?.textContent).toBe('Not in use by any session');
    expect(foot()!.querySelector('.rb-paste-hint')?.textContent).toBe('Paste with Ctrl+V');
    expect(foot()!.querySelector('.rb-size')?.textContent).toMatch(/^1280 × 800/);
    expect(foot()!.querySelector('.rb-link')?.textContent).toBe('Live');
    expect(writes()).toEqual([]);
  });

  it('100% shows the screen 1:1 to scroll, and Fit scales it back', async () => {
    browser = running();
    await openTab(`/runners/${RUNNER}/browser?control=1`);
    await press(buttonNamed('100%'));
    expect(vnc.made[0].scaleViewport).toBe(false);
    expect(vnc.made[0].clipViewport).toBe(false);
    expect(buttonNamed('100%')?.getAttribute('aria-pressed')).toBe('true');
    await press(buttonNamed('Fit'));
    expect(vnc.made[0].scaleViewport).toBe(true);
    expect(vnc.made).toHaveLength(1);
  });

  it('Done stops sending input and stays, view only, naming the session with a link; Take control takes it back', async () => {
    browser = running();
    await openTab(`/runners/${RUNNER}/browser?control=1`);
    expect(foot()!.querySelector('.rb-holder')?.textContent).toBe('Used by “Check the signup form on the staging site” · it keeps running');
    await press(buttonNamed('Done'));
    // The same stream, still open, now view only; the server is told.
    expect(vnc.made).toHaveLength(1);
    expect(vnc.made[0].viewOnly).toBe(true);
    expect(vnc.made[0].disconnected).toBe(false);
    expect(controlSaid()).toEqual([true, false]);
    expect(bar()!.querySelector('.rb-tab-title')?.textContent).toBe(
      'Watching the browser · used by “Check the signup form on the staging site”',
    );
    expect(bar()!.querySelector('a.rb-tab-session')?.getAttribute('href')).toBe(`/sessions/${SESSION}`);
    expect(foot()!.querySelector('.rb-holder')?.textContent).toBe('View only');
    expect(foot()!.querySelector('.rb-paste-hint')).toBeNull();
    expect(buttonNamed('Done')).toBeNull();
    await press(buttonNamed('Take control'));
    expect(vnc.made[0].viewOnly).toBe(false);
    expect(controlSaid()).toEqual([true, false, true]);
    expect(writes()).toEqual([]);
  });

  it('opened view only (Open in new tab): watching, with Take control, and nothing sent', async () => {
    browser = running();
    await openTab(`/runners/${RUNNER}/browser`);
    expect(vnc.made[0].viewOnly).toBe(true);
    expect(controlSaid()).toEqual([false]);
    expect(bar()!.querySelector('.rb-tab-title')?.textContent).toContain('Watching the browser');
    expect(buttonNamed('Take control')).not.toBeNull();
    // ⌘V in view only: no paste, and the key is noVNC's to drop (viewOnly), not this page's.
    await pressPaste(SECRET, 'metaKey');
    expect(pastesSent()).toEqual([]);
  });

  it('in control, ⌘V / Ctrl+V pastes the clipboard once: the keystroke never reaches noVNC, the text goes to the server', async () => {
    browser = running();
    await openTab(`/runners/${RUNNER}/browser?control=1`);
    await pressPaste(SECRET);
    expect(vnc.made[0].keys).toEqual([]);
    expect(pastesSent()).toEqual([{ type: 'paste', id: 1, text: SECRET }]);
    expect(foot()!.querySelector('.rb-paste-hint')?.textContent).toBe('Pasting…');
    // Focus is back on the screen, for the next key.
    expect(document.activeElement).toBe(vnc.made[0].canvas);
    await act(async () => socket().answer({ type: 'pasted', id: 1 }));
    await settle();
    expect(foot()!.querySelector('.rb-paste-hint')?.textContent).toBe('Paste with Ctrl+V');
    expect(bar()!.querySelector('.rb-paste-error')).toBeNull();

    // ⌘ (a Mac) too; other keys still reach noVNC.
    await pressPaste('second', 'metaKey');
    expect(pastesSent()).toHaveLength(2);
    expect(pastesSent()[1]).toEqual({ type: 'paste', id: 2, text: 'second' });
    const canvas = vnc.made[0].canvas;
    await act(async () => void canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })));
    expect(vnc.made[0].keys).toEqual(['a']);
  });

  it('a paste that fails says why in the bar; one too large is refused before it is sent', async () => {
    browser = running();
    await openTab(`/runners/${RUNNER}/browser?control=1`);
    await pressPaste(SECRET);
    await act(async () => socket().answer({ type: 'pasted', id: 1, error: 'Click a text field in the browser first' }));
    await settle();
    expect(bar()!.querySelector('.rb-paste-error')?.textContent).toBe('Click a text field in the browser first');

    await pressPaste('密'.repeat(((64 << 10) / 3) | 0) + '密');
    expect(pastesSent()).toHaveLength(1);
    expect(bar()!.querySelector('.rb-paste-error')?.textContent).toBe('The text is too long to paste (more than 64 KB)');
  });

  it('text copied in the remote reaches the local clipboard in control, and not while watching', async () => {
    browser = running();
    await openTab(`/runners/${RUNNER}/browser?control=1`);
    await act(async () => vnc.made[0].emit('clipboard', new CustomEvent('clipboard', { detail: { text: 'copied there' } })));
    await settle();
    expect(clipboard).toEqual(['copied there']);
    await press(buttonNamed('Done'));
    await act(async () => vnc.made[0].emit('clipboard', new CustomEvent('clipboard', { detail: { text: 'not this' } })));
    await settle();
    expect(clipboard).toEqual(['copied there']);
  });

  it('closing the tab closes the stream', async () => {
    browser = running();
    await openTab(`/runners/${RUNNER}/browser?control=1`);
    act(() => root!.unmount());
    root = null;
    expect(vnc.made[0].viewOnly).toBe(true);
    expect(vnc.made[0].disconnected).toBe(true);
  });

  it('tries once more when its first stream fails before it opened (the drawer letting its own go)', async () => {
    browser = running();
    vnc.failNext.value = true;
    await openTab(`/runners/${RUNNER}/browser?control=1`);
    expect(host!.querySelector('.rb-link')?.textContent).toBe('Disconnected');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600));
    });
    await settle();
    expect(vnc.made).toHaveLength(2);
    expect(host!.querySelector('.rb-link')?.textContent).toBe('Live');
  });
});

describe('a sign-in request in the browser tab (board 03-agent-tools frame ①, notes ④ ⑤)', () => {
  const openTab = (path: string) =>
    mount(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/runners/:id/browser" element={<RunnerBrowserPage />} />
        </Routes>
      </MemoryRouter>,
    );
  const banners = () => [...host!.querySelectorAll<HTMLElement>('.rb-sign-in')];
  const bannerText = () => banners().map((b) => b.querySelector('.rb-sign-in-text')?.textContent);

  it('the card’s Open browser lands in control with the banner above the bar: the site, who asked, I’m signed in', async () => {
    browser = running({ holderSessionId: null, holderTitle: null });
    openRequests = [signIn()];
    // The address the card's Open browser opens (OwnerRequestCard.browserSignIn.test.tsx).
    await openTab(`/runners/${RUNNER}/browser?control=1`);
    expect(vnc.made[0].viewOnly).toBe(false);
    expect(controlSaid()).toEqual([true]);
    expect(bannerText()).toEqual(['Sign in to github.com, asked by “Export the monthly report from GitHub”']);
    // Above the bar.
    expect(banners()[0].nextElementSibling?.classList.contains('rb-tab-bar')).toBe(true);
    expect(banners()[0].querySelector('button')?.textContent).toBe('I’m signed in');
    expect(writes()).toEqual([]);
  });

  it('I’m signed in answers the card as signed in (DONE), and the banner goes; control stays', async () => {
    browser = running({ holderSessionId: null, holderTitle: null });
    openRequests = [signIn()];
    await openTab(`/runners/${RUNNER}/browser?control=1`);
    await press(buttonNamed('I’m signed in'));
    expect(writes()).toEqual(['POST /owner-requests/req-sign-in/done']);
    expect(apiMock).toHaveBeenCalledWith('/owner-requests/req-sign-in/done', { method: 'POST', body: {} });
    expect(banners()).toEqual([]);
    expect(vnc.made[0].viewOnly).toBe(false);
    expect(controlSaid()).toEqual([true]);
  });

  it('Done only stops control: it answers nothing and the banner stays', async () => {
    browser = running({ holderSessionId: null, holderTitle: null });
    openRequests = [signIn()];
    await openTab(`/runners/${RUNNER}/browser?control=1`);
    await press(buttonNamed('Done'));
    expect(controlSaid()).toEqual([true, false]);
    expect(writes()).toEqual([]);
    expect(bannerText()).toEqual(['Sign in to github.com, asked by “Export the monthly report from GitHub”']);
    expect(buttonNamed('I’m signed in')).not.toBeNull();
  });

  it('goes when the card is answered elsewhere (Not now on the card), once the list is read again', async () => {
    browser = running();
    openRequests = [signIn()];
    await openTab(`/runners/${RUNNER}/browser?control=1`);
    expect(banners()).toHaveLength(1);
    openRequests = [];
    await act(async () => void queryClient!.invalidateQueries({ queryKey: ['owner-requests'] }));
    await settle();
    expect(banners()).toEqual([]);
  });

  it('shows only for an open sign-in request for this runner', async () => {
    browser = running();
    openRequests = [
      signIn({ id: 'other-runner', browserRunnerId: '34z8OKBXxDRYsIZwzJ35X' }),
      signIn({ id: 'no-runner', browserRunnerId: null }),
      signIn({ id: 'past-deadline', expiresAt: '2026-01-01T00:00:00.000Z' }),
      signIn({ id: 'a-decision', kind: 'DECISION', browserSite: null, browserRunnerId: null }),
    ];
    await openTab(`/runners/${RUNNER}/browser`);
    expect(banners()).toEqual([]);
    expect(buttonNamed('I’m signed in')).toBeNull();
  });

  it('with no session title names only the site; two requests are two banners, oldest first', async () => {
    browser = running();
    openRequests = [
      signIn({ id: 'later', browserSite: 'linear.app', createdAt: '2026-11-18T05:02:00.000Z' }),
      signIn({ askedBySessionTitle: null }),
    ];
    await openTab(`/runners/${RUNNER}/browser`);
    expect(bannerText()).toEqual(['Sign in to github.com', 'Sign in to linear.app, asked by “Export the monthly report from GitHub”']);
  });

  it('says so when the answer does not go through, and keeps the banner', async () => {
    browser = running();
    openRequests = [signIn()];
    const answer = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path.endsWith('/done')) {
        calls.push(`POST ${path}`);
        throw new ApiError('this request is already DECLINED', 409);
      }
      return answer(path, init as never);
    });
    await openTab(`/runners/${RUNNER}/browser?control=1`);
    await press(buttonNamed('I’m signed in'));
    expect(banners()[0].querySelector('[role="alert"]')?.textContent).toBe("Couldn't send your answer");
  });
});

describe('an engine sign-in that fails in the browser tab', () => {
  const openTab = () =>
    mount(
      <MemoryRouter initialEntries={[`/runners/${RUNNER}/browser?control=1`]}>
        <Routes>
          <Route path="/runners/:id/browser" element={<RunnerBrowserPage />} />
        </Routes>
      </MemoryRouter>,
    );
  const failure = () => host!.querySelector<HTMLElement>('.rb-sign-in.is-failed');
  const readLogin = async () => {
    await act(async () => void queryClient!.invalidateQueries({ queryKey: ['runner-login', RUNNER] }));
    await settle();
  };
  const ELIGIBILITY =
    'Google sign-in could not be verified — Antigravity answered: Eligibility check failed: Your current account is not eligible for Antigravity. Verify your account to continue.';

  it('says what the runner said once a sign-in it saw under way in the runner’s browser fails', async () => {
    browser = running({ holderSessionId: null, holderTitle: null });
    await openTab();
    expect(failure()).toBeNull();
    login = { ...login, status: 'awaiting_code', engine: 'antigravity', url: 'https://accounts.google.com/o/oauth2/auth', browser: 'code-taken' };
    await readLogin();
    expect(failure()).toBeNull();
    login = { ...login, status: 'failed', url: null, browser: undefined, message: ELIGIBILITY };
    await readLogin();
    expect(failure()?.textContent).toBe(`Couldn't sign in to Antigravity — ${ELIGIBILITY} Try again from the sign-in card.`);
    expect(writes()).toEqual([]);
    // A new attempt under way takes it down.
    login = { ...login, status: 'pending', message: null };
    await readLogin();
    expect(failure()).toBeNull();
  });

  it('shows nothing for a failure that had already happened, or one that never went through this browser', async () => {
    browser = running({ holderSessionId: null, holderTitle: null });
    login = { ...login, status: 'failed', engine: 'antigravity', message: ELIGIBILITY };
    await openTab();
    expect(failure()).toBeNull();
    login = { ...login, status: 'awaiting_code', message: null };
    await readLogin();
    login = { ...login, status: 'failed', message: ELIGIBILITY };
    await readLogin();
    expect(failure()).toBeNull();
  });
});

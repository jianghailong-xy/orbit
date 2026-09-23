// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App as AntApp } from 'antd';
import { BrowserRouter, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { encodeId } from './lib/idCodec';
import { loginDestination } from './pages/LoginPage';

/**
 * A signed-out visitor who opens an in-app page — an Orbit link clicked on a share page, a task URL
 * pasted into chat — is sent to log in, and the login sends them back to that page instead of the
 * default landing.
 *
 * Mounted under the real BrowserRouter on jsdom's own history, the way main.tsx mounts it: the
 * redirect writes the address bar and LoginPage reads `next` back out of it, so a MemoryRouter
 * would test a hand-off the browser never makes. The one thing jsdom cannot do is the full reload
 * LoginPage ends with (`location.href = …`), so `location` is swapped for a stand-in that records
 * where it was sent, and the reload is replayed by mounting the app again at that address.
 */

// Only the page the visitor is sent back to is drawn here, and only to say which page it is: the
// real shell and task list would need every query they poll answered first.
vi.mock('./components/AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return {
    AppShell: () => <Outlet />,
    DocView: ({ children }: { children: ReactNode }) => children,
    FlushView: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock('./pages/TaskListView', () => ({ TaskListView: () => <TaskPage /> }));

function TaskPage() {
  const { id } = useParams();
  return <p>{`Task page ${id}`}</p>;
}

const TASK_ID = encodeId('0195c0de-0000-7000-8000-00000000a51d');
const TASK_PAGE = `/tasks/${TASK_ID}`;
const LIST_KEY = encodeId('0195c0de-0000-7000-8000-00000000715e');

const EMAIL = 'ada@example.com';
const PASSWORD = 'correct horse battery staple';
const SESSION = { accessToken: 'access-token', refreshToken: 'refresh-token' };

let container: HTMLDivElement;
let root: Root | null = null;
/** Every request the page made, as sent: a login that never reached the server proves nothing. */
let requests: Array<{ url: string; method?: string; body: unknown }> = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); // signed out: no session stored
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      requests.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(SESSION), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  // antd's Form grid subscribes to breakpoints on mount and jsdom ships no matchMedia.
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

afterEach(async () => {
  await unmount();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

async function unmount(): Promise<void> {
  if (!root) return;
  const mounted = root;
  root = null;
  await act(async () => mounted.unmount());
  container.remove();
}

/** Open `path` the way a page load does: the address bar says it before the app first renders. */
async function visit(path: string): Promise<void> {
  await unmount();
  window.history.replaceState(null, '', path);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <AntApp>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntApp>,
    );
  });
  await settle();
}

/** The form validates, the request answers and the session is stored, each on a later tick. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const addressBar = (): string => window.location.pathname + window.location.search;

/**
 * Swaps `location` for one that reads through to jsdom's but records where it is SENT instead of
 * going there — jsdom implements no navigation, so a real `location.href = …` would just be dropped.
 */
function recordNavigation(): string[] {
  const real = window.location;
  const sentTo: string[] = [];
  vi.stubGlobal(
    'location',
    new Proxy({} as Location, {
      get: (_, key) => {
        const value: unknown = Reflect.get(real, key, real);
        return typeof value === 'function' ? value.bind(real) : value;
      },
      set: (_, key, value) => {
        if (key !== 'href') return Reflect.set(real, key, value, real);
        sentTo.push(String(value));
        return true;
      },
    }),
  );
  return sentTo;
}

/** React only hears a value typed through the native setter, followed by the input event. */
function type(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function logIn(): Promise<void> {
  const email = container.querySelector<HTMLInputElement>('input[type="email"]');
  const password = container.querySelector<HTMLInputElement>('input[type="password"]');
  expect(email, 'the login form’s email field').toBeTruthy();
  expect(password, 'the login form’s password field').toBeTruthy();
  await act(async () => {
    type(email!, EMAIL);
    type(password!, PASSWORD);
  });
  const submit = [...container.querySelectorAll('button')].find(
    (button) => (button.textContent ?? '').trim() === 'Login',
  );
  expect(submit, 'the Login button').toBeTruthy();
  await act(async () => {
    submit!.click();
  });
  await settle();
  expect(requests).toEqual([
    { url: '/api/auth/login', method: 'POST', body: { email: EMAIL, password: PASSWORD } },
  ]);
}

describe('a signed-out visitor on an in-app page', () => {
  it('is sent to log in with the page as next', async () => {
    await visit(TASK_PAGE);

    expect(addressBar()).toBe(`/login?next=${encodeURIComponent(TASK_PAGE)}`);
    expect(container.querySelector('input[type="password"]'), 'the login form').toBeTruthy();
  });

  it('comes back to that page once logged in', async () => {
    await visit(TASK_PAGE);
    const sentTo = recordNavigation();
    await logIn();

    expect(sentTo).toEqual([TASK_PAGE]);

    // The reload that assignment starts, replayed: the session the login stored carries the
    // visitor onto the task page itself, not round again into a login that sends them back.
    expect(localStorage.getItem('orbit_token')).toBe(SESSION.accessToken);
    await visit(sentTo[0]);
    expect(addressBar()).toBe(TASK_PAGE);
    expect(container.textContent).toBe(`Task page ${TASK_ID}`);
  });

  it('keeps the query string along with the path', async () => {
    const listed = `${TASK_PAGE}?list=${LIST_KEY}`;
    await visit(listed);
    expect(addressBar()).toBe(`/login?next=${encodeURIComponent(listed)}`);

    const sentTo = recordNavigation();
    await logIn();
    expect(sentTo).toEqual([listed]);
  });

  it('on the bare root gets the plain login page — the root is where login lands anyway', async () => {
    await visit('/');
    expect(addressBar()).toBe('/login');

    const sentTo = recordNavigation();
    await logIn();
    expect(sentTo).toEqual(['/']);
  });
});

describe('an off-site next', () => {
  it.each(['//evil.example/tasks/x', 'https://evil.example/tasks/x'])(
    'is ignored: %s logs in to the root',
    async (next) => {
      await visit(`/login?next=${encodeURIComponent(next)}`);
      const sentTo = recordNavigation();
      await logIn();

      expect(sentTo).toEqual(['/']);
    },
  );

  it('is anything but a single leading slash, as the browser reads it', () => {
    expect(loginDestination(TASK_PAGE)).toBe(TASK_PAGE);
    expect(loginDestination(`${TASK_PAGE}?list=${LIST_KEY}`)).toBe(`${TASK_PAGE}?list=${LIST_KEY}`);
    expect(loginDestination('/')).toBe('/');

    const offSite = [
      '//evil.example',
      '///evil.example',
      // This very host, even: a protocol-relative URL is not a path.
      `//${window.location.host}/tasks/x`,
      // A browser reads a backslash after the scheme's slashes as one more slash.
      '/\\evil.example',
      // …and drops tabs and newlines before it reads anything at all.
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r\\evil.example',
      // A host the browser cannot even parse: the root, not an "Invalid URL" after a good login.
      '/\t/[',
      'https://evil.example/tasks/x',
      'javascript:alert(1)',
      'evil.example/tasks/x',
      '',
    ];
    for (const next of offSite) {
      expect(loginDestination(next), JSON.stringify(next)).toBe('/');
    }
    expect(loginDestination(null)).toBe('/');
  });
});

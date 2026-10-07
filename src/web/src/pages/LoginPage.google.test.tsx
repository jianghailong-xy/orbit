// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

/**
 * Signing in with Google on the login page (docs/google-sign-in-design.md §3.2, §8.1): the button
 * shows only where GET /api/auth/methods says the server offers Google; pressing it keeps a PKCE
 * verifier and `next` in this tab and leaves for /api/auth/google/start with the verifier's S256
 * challenge; Google's answer comes back to /login, where a ticket is exchanged for a session that
 * goes on to `next`, and anything else ends in a sentence that says what to do.
 *
 * The page is mounted alone on jsdom's own address bar and storage, with `fetch` answered per path
 * and `location` swapped for a stand-in that records where the page SENDS the browser — jsdom
 * implements no navigation.
 */

type Answer = { status: number; body: unknown } | 'network down';

const SESSION = { accessToken: 'access-token', refreshToken: 'refresh-token', user: { id: 'u1' } };
const STARTED_KEY = 'orbit_google_sign_in';
const NEXT = '/enroll?code=WXYZ4-8K2QP';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

let methods: Answer;
let exchange: Answer;
let passwordLogin: Answer;
/** Every request the page made, and what the address bar said as it was made. */
let requests: Array<{ url: string; method: string; body: unknown; addressBar: string }>;
let container: HTMLDivElement;
let root: Root | null = null;

const ok = (body: unknown): Answer => ({ status: 200, body });
const on = (googleSignup = false): Answer => ok({ password: true, google: true, googleSignup });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sessionStorage.clear();
  requests = [];
  methods = on();
  exchange = ok(SESSION);
  passwordLogin = ok(SESSION);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      requests.push({
        url,
        method: init.method ?? 'GET',
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
        addressBar: location.pathname + location.search,
      });
      const answer =
        url === '/api/auth/methods'
          ? methods
          : url === '/api/auth/google/exchange'
            ? exchange
            : url === '/api/auth/login'
              ? passwordLogin
              : { status: 404, body: { statusCode: 404, message: `Cannot GET ${url}` } };
      if (answer === 'network down') throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

/** Load the login page at `path`: the address bar says it before the page first renders. */
async function open(path: string): Promise<void> {
  window.history.replaceState(null, '', path);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<LoginPage />));
  await settle();
}

/** Requests answer, WebCrypto digests and state lands, each on a later tick. */
async function settle(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) await settle(1);
  expect(done(), what).toBe(true);
}

/**
 * Swaps `location` for one that reads through to jsdom's but records where it is sent — by
 * `assign()`, as the button leaves for Google, or by `href`, as a signed-in page goes on.
 */
function recordNavigation(): { assigned: string[]; href: string[] } {
  const real = window.location;
  const sent = { assigned: [] as string[], href: [] as string[] };
  vi.stubGlobal(
    'location',
    new Proxy({} as Location, {
      get: (_, key) => {
        if (key === 'assign') return (url: string | URL) => sent.assigned.push(String(url));
        const value: unknown = Reflect.get(real, key, real);
        return typeof value === 'function' ? value.bind(real) : value;
      },
      set: (_, key, value) => {
        if (key !== 'href') return Reflect.set(real, key, value, real);
        sent.href.push(String(value));
        return true;
      },
    }),
  );
  return sent;
}

const googleButton = (): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(
    (button) => (button.textContent ?? '').trim() === 'Continue with Google',
  );
const signupLine = (): Element | undefined =>
  [...container.querySelectorAll('p')].find((p) => p.textContent?.includes('New to Orbit?'));
const alertText = (): string | null => container.querySelector('[role="alert"]')?.textContent ?? null;
const addressBar = (): string => window.location.pathname + window.location.search;
const exchanges = () => requests.filter((request) => request.url === '/api/auth/google/exchange');
const signedIn = (): boolean => localStorage.getItem('orbit_token') !== null;
const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

function startedHere(started: { verifier: string; next: string | null }): void {
  sessionStorage.setItem(STARTED_KEY, JSON.stringify(started));
}

async function pressGoogle(): Promise<void> {
  const button = googleButton();
  expect(button, 'the Continue with Google button').toBeTruthy();
  await act(async () => button!.click());
}

describe('the Continue with Google button', () => {
  it('is not offered while the server has Google sign-in off', async () => {
    methods = ok({ password: true, google: false, googleSignup: false });
    await open('/login');

    expect(requests.map((request) => request.url)).toEqual(['/api/auth/methods']);
    expect(container.querySelector('input[type="password"]'), 'the password form').toBeTruthy();
    expect(googleButton()).toBeUndefined();
    expect(signupLine()).toBeUndefined();
    expect(container.textContent).not.toContain('Google');
  });

  it('is not offered by a server too old to answer /auth/methods', async () => {
    methods = { status: 404, body: { statusCode: 404, message: 'Cannot GET /api/auth/methods' } };
    await open('/login');

    expect(googleButton()).toBeUndefined();
    expect(alertText()).toBeNull();
  });

  it('is offered, with Google’s four-colour G, when the server has Google sign-in on', async () => {
    await open('/login');

    const button = googleButton();
    expect(button).toBeTruthy();
    expect(button!.type, 'not a second submit of the password form').toBe('button');
    expect(button!.className).toContain('orbit-button');
    const fills = [...button!.querySelectorAll('svg path')].map((path) => path.getAttribute('fill'));
    expect(fills).toEqual(['#EA4335', '#4285F4', '#FBBC05', '#34A853']);
    // Below the password form's own button.
    const submit = container.querySelector('button[type="submit"]')!;
    expect(submit.compareDocumentPosition(button!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(signupLine(), 'no sign-up line while Google opens no accounts').toBeUndefined();
  });

  it('says under it that Google opens accounts when the server lets it', async () => {
    methods = on(true);
    await open('/login');

    const line = signupLine();
    expect(line?.textContent).toBe('New to Orbit? Continue with Google to create an account.');
    expect(googleButton()!.compareDocumentPosition(line!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('pressing Continue with Google', () => {
  it('keeps a verifier and next in this tab and leaves for /start with the verifier’s S256 challenge', async () => {
    await open(`/login?next=${encodeURIComponent(NEXT)}`);
    const sent = recordNavigation();
    await pressGoogle();
    await until(() => sent.assigned.length > 0, 'the browser sent on to Google');

    const started = JSON.parse(sessionStorage.getItem(STARTED_KEY)!) as { verifier: string; next: string | null };
    expect(started.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.next).toBe(NEXT);
    expect(sent.assigned).toEqual([`/api/auth/google/start?client=web&code_challenge=${s256(started.verifier)}`]);
    expect(sent.href).toEqual([]);
    expect(exchanges()).toEqual([]);
    expect(signedIn()).toBe(false);
  });

  it('keeps no next where the login page had none, and a fresh verifier every time', async () => {
    await open('/login');
    const sent = recordNavigation();
    await pressGoogle();
    await until(() => sent.assigned.length === 1, 'the first start');
    const first = JSON.parse(sessionStorage.getItem(STARTED_KEY)!) as { verifier: string; next: string | null };
    expect(first.next).toBeNull();

    // Back from Google's page by the browser's Back: a page restored from the back/forward cache
    // comes back as it was left, still waiting on Google, until the browser says it was restored.
    expect(googleButton()!.getAttribute('aria-busy')).toBe('true');
    const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    await act(async () => window.dispatchEvent(restored));
    expect(googleButton()!.getAttribute('aria-busy')).toBeNull();

    await pressGoogle();
    await until(() => sent.assigned.length === 2, 'the second start');
    const second = JSON.parse(sessionStorage.getItem(STARTED_KEY)!) as { verifier: string };
    expect(second.verifier).not.toBe(first.verifier);
    expect(sent.assigned[1]).toBe(`/api/auth/google/start?client=web&code_challenge=${s256(second.verifier)}`);
  });

  it('says so, and stays, where the browser cannot start one (no WebCrypto off HTTPS)', async () => {
    await open('/login');
    const sent = recordNavigation();
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes });
    await pressGoogle();
    await until(() => alertText() !== null, 'an error shown');

    expect(alertText()).toBe(
      "Couldn't start Google sign-in in this browser. Make sure Orbit is open over HTTPS, then try again.",
    );
    expect(sent.assigned).toEqual([]);
    expect(sessionStorage.getItem(STARTED_KEY)).toBeNull();
    expect(googleButton()!.getAttribute('aria-busy')).toBeNull();
  });
});

describe('back from Google with a ticket', () => {
  it('takes it off the address bar, exchanges it with this tab’s verifier, and goes on to next signed in', async () => {
    startedHere({ verifier: VERIFIER, next: NEXT });
    const sent = recordNavigation();
    await open('/login?google_ticket=T1');
    await until(() => sent.href.length > 0, 'the signed-in page sent on');

    expect(exchanges()).toEqual([
      {
        url: '/api/auth/google/exchange',
        method: 'POST',
        body: { ticket: 'T1', codeVerifier: VERIFIER },
        // Already off the address bar as the ticket goes out.
        addressBar: `/login?next=${encodeURIComponent(NEXT)}`,
      },
    ]);
    expect(localStorage.getItem('orbit_token')).toBe(SESSION.accessToken);
    expect(localStorage.getItem('orbit_refresh')).toBe(SESSION.refreshToken);
    expect(sent.href).toEqual([NEXT]);
    expect(sessionStorage.getItem(STARTED_KEY), 'a verifier is used once').toBeNull();
    expect(alertText()).toBeNull();
  });

  it('goes to the root where the login page had no next', async () => {
    startedHere({ verifier: VERIFIER, next: null });
    const sent = recordNavigation();
    await open('/login?google_ticket=T1');
    await until(() => sent.href.length > 0, 'the signed-in page sent on');

    expect(exchanges()[0].addressBar).toBe('/login');
    expect(sent.href).toEqual(['/']);
  });

  it('judges next as a password login does: an off-site one goes to the root', async () => {
    startedHere({ verifier: VERIFIER, next: '//evil.example/tasks/x' });
    const sent = recordNavigation();
    await open('/login?google_ticket=T1');
    await until(() => sent.href.length > 0, 'the signed-in page sent on');

    expect(sent.href).toEqual(['/']);
  });

  it('still presents a ticket this tab holds no verifier for — once, to spend it — and signs nobody in', async () => {
    // Even were the server to answer with a session, a ticket this tab did not ask for signs nobody in.
    const sent = recordNavigation();
    await open('/login?google_ticket=T2');
    await until(() => alertText() !== null, 'an error shown');

    expect(exchanges()).toHaveLength(1);
    const [spent] = exchanges();
    expect(spent.body).toEqual({ ticket: 'T2', codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(spent.addressBar).toBe('/login');
    expect(alertText()).toBe(
      "This Google sign-in didn't start in this browser tab, so it can't finish here. Continue with Google again from this page.",
    );
    expect(signedIn()).toBe(false);
    expect(sent.href).toEqual([]);
    expect(addressBar()).toBe('/login');
  });

  /** Every refusal the exchange answers with (§4.3, §5.2, §5.5) and the sentence it is shown as. */
  const refusals: Array<[name: string, status: number, code: string | undefined, sentence: string]> = [
    [
      'GOOGLE_FLOW_MISMATCH',
      400,
      'GOOGLE_FLOW_MISMATCH',
      'This Google sign-in expired or was already used. Continue with Google again from this page.',
    ],
    [
      'GOOGLE_NOT_CONFIGURED',
      403,
      'GOOGLE_NOT_CONFIGURED',
      'Google sign-in is turned off on this Orbit server. Sign in with your email and password, or ask an administrator to turn it on.',
    ],
    [
      'SETUP_REQUIRED',
      403,
      'SETUP_REQUIRED',
      'This Orbit server has no accounts yet. Create its first administrator at /setup with an email and password.',
    ],
    [
      'GOOGLE_EMAIL_AMBIGUOUS',
      403,
      'GOOGLE_EMAIL_AMBIGUOUS',
      'More than one Orbit account uses this email address, differing only in capital letters. Ask an administrator to remove the duplicate, or sign in with your password.',
    ],
    [
      'GOOGLE_ACCOUNT_MISMATCH',
      403,
      'GOOGLE_ACCOUNT_MISMATCH',
      'The Orbit account with this email address is connected to a different Google account. Continue with that Google account, or sign in with your password.',
    ],
    [
      'GOOGLE_EMAIL_NOT_AUTHORITATIVE',
      403,
      'GOOGLE_EMAIL_NOT_AUTHORITATIVE',
      "Google can't confirm that this email address is still yours. Sign in with your password, then connect Google on your profile page.",
    ],
    [
      'GOOGLE_ACCOUNT_NOT_FOUND',
      403,
      'GOOGLE_ACCOUNT_NOT_FOUND',
      'No Orbit account uses this Google account yet. Ask an administrator to create one for your email address, then continue with Google again.',
    ],
    [
      'ACCOUNT_DISABLED',
      403,
      'ACCOUNT_DISABLED',
      'This Orbit account is disabled. Ask an administrator to enable it again.',
    ],
    [
      'the rate limit (429, no code)',
      429,
      undefined,
      'Too many Google sign-ins from your network. Wait a minute, then continue with Google again.',
    ],
    [
      'a code this page does not know',
      500,
      undefined,
      "Couldn't sign in with Google. Continue with Google to try again, or sign in with your password.",
    ],
  ];

  it.each(refusals)('refused with %s: says what to do, signs nobody in, keeps next', async (_, status, code, sentence) => {
    exchange = {
      status,
      body: code === undefined ? { statusCode: status, message: 'slow down' } : { code, message: `server words for ${code}` },
    };
    startedHere({ verifier: VERIFIER, next: NEXT });
    const sent = recordNavigation();
    await open('/login?google_ticket=T3');
    await until(() => alertText() !== null, 'an error shown');

    expect(alertText()).toBe(sentence);
    expect(signedIn()).toBe(false);
    expect(sent.href).toEqual([]);
    expect(addressBar()).toBe(`/login?next=${encodeURIComponent(NEXT)}`);
    expect(googleButton()!.getAttribute('aria-busy'), 'the button usable again').toBeNull();
  });

  it('says what to do when the exchange never reaches the server', async () => {
    exchange = 'network down';
    startedHere({ verifier: VERIFIER, next: NEXT });
    const sent = recordNavigation();
    await open('/login?google_ticket=T3');
    await until(() => alertText() !== null, 'an error shown');

    expect(alertText()).toBe(
      "Couldn't sign in with Google. Continue with Google to try again, or sign in with your password.",
    );
    expect(signedIn()).toBe(false);
    expect(sent.href).toEqual([]);
  });

  it('leaves the password form going to next after a refusal', async () => {
    exchange = { status: 403, body: { code: 'GOOGLE_EMAIL_NOT_AUTHORITATIVE', message: '…' } };
    startedHere({ verifier: VERIFIER, next: NEXT });
    const sent = recordNavigation();
    await open('/login?google_ticket=T4');
    await until(() => alertText() !== null, 'an error shown');

    const type = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      type(container.querySelector<HTMLInputElement>('input[type="email"]')!, 'ada@example.com');
      type(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'correct horse');
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await until(() => sent.href.length > 0, 'the signed-in page sent on');

    expect(requests.at(-1)).toMatchObject({ url: '/api/auth/login', method: 'POST' });
    expect(sent.href).toEqual([NEXT]);
  });
});

describe('back from Google with google_error', () => {
  /** Every code the callback sends the browser back with (§4.1, §4.2) and the sentence it is shown as. */
  const failures: Array<[code: string, sentence: string]> = [
    [
      'GOOGLE_NOT_CONFIGURED',
      'Google sign-in is turned off on this Orbit server. Sign in with your email and password, or ask an administrator to turn it on.',
    ],
    [
      'GOOGLE_FLOW_EXPIRED',
      'That Google sign-in expired or was finished in a different browser. Continue with Google again from this page.',
    ],
    ['GOOGLE_CANCELLED', 'Google sign-in was cancelled. Continue with Google to try again, or sign in with your password.'],
    [
      'GOOGLE_EXCHANGE_FAILED',
      "Orbit couldn't confirm your sign-in with Google. Try again in a moment; if it keeps failing, ask an administrator to check this server's Google sign-in settings.",
    ],
    [
      'GOOGLE_EMAIL_UNVERIFIED',
      "Your Google account's email address isn't verified. Verify it with Google, then continue with Google again.",
    ],
    // The parameter is the URL's, so anybody can write anything in it.
    ['SOMETHING_NEW', "Couldn't sign in with Google. Continue with Google to try again, or sign in with your password."],
    ['toString', "Couldn't sign in with Google. Continue with Google to try again, or sign in with your password."],
  ];

  it.each(failures)('%s: says what to do, exchanges nothing, and clears the address bar', async (code, sentence) => {
    startedHere({ verifier: VERIFIER, next: NEXT });
    const sent = recordNavigation();
    await open(`/login?google_error=${code}`);
    await until(() => alertText() !== null, 'an error shown');

    expect(alertText()).toBe(sentence);
    expect(exchanges()).toEqual([]);
    expect(signedIn()).toBe(false);
    expect(sent.href).toEqual([]);
    expect(addressBar()).toBe(`/login?next=${encodeURIComponent(NEXT)}`);
    expect(sessionStorage.getItem(STARTED_KEY), 'the spent verifier dropped').toBeNull();
  });

  it('clears the address bar to /login where no sign-in was started here', async () => {
    await open('/login?google_error=GOOGLE_CANCELLED');
    await until(() => alertText() !== null, 'an error shown');

    expect(addressBar()).toBe('/login');
  });
});

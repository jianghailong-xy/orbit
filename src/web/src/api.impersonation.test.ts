// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  clearToken,
  getRefreshToken,
  getToken,
  impersonation,
  logoutSession,
  onImpersonationChange,
  setSession,
  startImpersonation,
  stopImpersonation,
} from './api';

/**
 * An administrator viewing Orbit as another user, read-only (Admin → Users → View as): this browser's
 * own session waits aside while the look's token is in use, nothing is refreshed, and the session
 * comes back when the look ends — by the banner's Exit, or by a 401 once the look's token is over.
 */

/** A token shaped as the server signs one; only its claims are read here. */
const jwt = (claims: Record<string, unknown>) =>
  ['header', btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'signature'].join('.');

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const ADMIN_TOKEN = jwt({ sub: 'admin-id', email: 'admin@example.com', exp: inAnHour() });
const LOOK = jwt({ sub: 'member-id', email: 'member@example.com', aud: 'orbit-impersonation', act: { sub: 'admin-id' }, exp: inAnHour() });

/** The administrator's session as it waits aside during a look: its access and refresh token. */
const waitingAside = () => [localStorage.getItem('orbit_admin_token'), localStorage.getItem('orbit_admin_refresh')];

const unauthorized = () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) }) as Response;

/** Where the app was sent: jsdom navigates nowhere, so `location.href = …` is recorded instead. */
let sentTo: string[];

beforeEach(() => {
  localStorage.clear();
  setSession({ accessToken: ADMIN_TOKEN, refreshToken: 'admin-refresh' });
  sentTo = [];
  const real = window.location;
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
});

afterEach(() => {
  clearToken();
  vi.unstubAllGlobals();
});

describe('a look at another user', () => {
  it('sets the administrator’s session aside, and brings it back when it ends', () => {
    expect(impersonation()).toBeNull();

    startImpersonation(LOOK);

    expect(getToken()).toBe(LOOK);
    expect(getRefreshToken(), 'a look is never refreshed').toBeNull();
    expect(impersonation()).toEqual({ email: 'member@example.com', expiresAt: JSON.parse(atob(LOOK.split('.')[1])).exp });

    stopImpersonation();

    expect(getToken()).toBe(ADMIN_TOKEN);
    expect(getRefreshToken()).toBe('admin-refresh');
    expect(impersonation()).toBeNull();
  });

  it('a 401 to its token brings the administrator back to the Users page, refreshing nothing and signing nobody out', async () => {
    const fetchMock = vi.fn(async () => unauthorized());
    vi.stubGlobal('fetch', fetchMock);
    startImpersonation(LOOK);

    // Two requests answered 401 at once: the second must not take the first's restored session for a dead one.
    const [first, second] = await Promise.allSettled([api('/tasks'), api('/sessions')]);

    expect(first.status).toBe('rejected');
    expect(second.status).toBe('rejected');
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain('/api/auth/refresh');
    expect(getToken()).toBe(ADMIN_TOKEN);
    expect(getRefreshToken()).toBe('admin-refresh');
    expect(sentTo).toEqual(['/admin', '/admin']);
  });

  it('every request carries its token, and a 403 it is answered is the caller’s to show', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ code: 'IMPERSONATION_READ_ONLY', message: 'You are viewing Orbit as another user, read-only: nothing can be changed' }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    startImpersonation(LOOK);

    await expect(api('/tasks', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 403, code: 'IMPERSONATION_READ_ONLY' });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${LOOK}`);
    expect(getToken(), 'a refusal ends nothing').toBe(LOOK);
    expect(sentTo).toEqual([]);
  });

  it('signing out during one signs the administrator out, revoking the session that waited aside', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    startImpersonation(LOOK);

    await logoutSession();
    clearToken();

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ body: JSON.stringify({ refreshToken: 'admin-refresh' }) }));
    expect(getToken()).toBeNull();
    expect(waitingAside(), 'nothing waits aside once signed out').toEqual([null, null]);
  });

  it('a sign-in leaves nothing waiting aside', () => {
    startImpersonation(LOOK);
    expect(waitingAside()).toEqual([ADMIN_TOKEN, 'admin-refresh']);

    setSession({ accessToken: jwt({ sub: 'someone', exp: inAnHour() }), refreshToken: 'their-refresh' });

    expect(waitingAside()).toEqual([null, null]);
    expect(impersonation()).toBeNull();
  });

  it('another tab starting or ending one is heard, and its token refreshing is not', () => {
    const heard = vi.fn();
    const stop = onImpersonationChange(heard);
    const change = (oldValue: string | null, newValue: string | null) =>
      window.dispatchEvent(new StorageEvent('storage', { key: 'orbit_token', oldValue, newValue }));

    change(ADMIN_TOKEN, jwt({ sub: 'admin-id', exp: inAnHour() + 60 }));
    expect(heard).not.toHaveBeenCalled();
    change(ADMIN_TOKEN, LOOK);
    change(LOOK, ADMIN_TOKEN);
    expect(heard).toHaveBeenCalledTimes(2);

    stop();
    change(ADMIN_TOKEN, LOOK);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

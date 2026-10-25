// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, getToken, setSession, startImpersonation } from '../api';
import { EXIT_VIEW_AS, ImpersonationBanner } from './ImpersonationBanner';

/**
 * The band over every page while an administrator views Orbit as another user: whose Orbit, read-only,
 * the time left, and Exit — which, like the time running out, brings the administrator's own session
 * back on the Users page. A look started or ended in another tab loads this one again.
 */

const jwt = (claims: Record<string, unknown>) =>
  ['header', btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'signature'].join('.');
const secondsFromNow = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;
const ADMIN_TOKEN = jwt({ sub: 'admin-id', email: 'admin@example.com', exp: secondsFromNow(3600) });
const look = (seconds: number) =>
  jwt({ sub: 'member-id', email: 'member@example.com', aud: 'orbit-impersonation', act: { sub: 'admin-id' }, exp: secondsFromNow(seconds) });

let sentTo: string[];
let reloads: number;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ImpersonationBanner />));
}

const exitButton = () => [...(container?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === EXIT_VIEW_AS);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  setSession({ accessToken: ADMIN_TOKEN, refreshToken: 'admin-refresh' });
  sentTo = [];
  reloads = 0;
  const real = window.location;
  vi.stubGlobal(
    'location',
    new Proxy({} as Location, {
      get: (_, key) => {
        if (key === 'reload') return () => (reloads += 1);
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

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  clearToken();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('the View as banner', () => {
  it('is not there for the administrator’s own session', async () => {
    await mount();
    expect(container!.innerHTML).toBe('');
  });

  it('says whose Orbit this is, that it is read-only and the time left; Exit brings the administrator back', async () => {
    startImpersonation(look(90));
    await mount();

    expect(container!.textContent).toContain('Viewing as member@example.com · read-only · 1:30 left');
    await act(async () => exitButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(getToken()).toBe(ADMIN_TOKEN);
    expect(sentTo).toEqual(['/admin']);
  });

  it('counts down, and the look ends by itself when its time runs out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    startImpersonation(look(3));
    await mount();
    expect(container!.textContent).toContain('0:03 left');

    await act(async () => vi.advanceTimersByTime(1000));
    expect(container!.textContent).toContain('0:02 left');
    expect(sentTo).toEqual([]);

    await act(async () => vi.advanceTimersByTime(3000));
    expect(getToken()).toBe(ADMIN_TOKEN);
    expect(sentTo).toEqual(['/admin']);
  });

  it('a look started in another tab loads this one again', async () => {
    await mount();
    window.dispatchEvent(new StorageEvent('storage', { key: 'orbit_token', oldValue: ADMIN_TOKEN, newValue: look(1800) }));
    expect(reloads).toBe(1);
  });
});

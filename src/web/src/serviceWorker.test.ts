import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/**
 * public/sw.js, the service worker that shows this browser's notifications (docs/web-push-design.md), run in a fake
 * worker global: what a push shows or closes, and where a click goes.
 */

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

type Listener = (event: unknown) => void;
interface FakeWindow {
  url: string;
  visibilityState: string;
  focused: boolean;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
}

function worker(windows: FakeWindow[] = []) {
  const listeners = new Map<string, Listener>();
  const shown: Array<{ close: ReturnType<typeof vi.fn>; tag: string }> = [
    { tag: 'approval-s1', close: vi.fn() },
    { tag: 'approval-s2', close: vi.fn() },
  ];
  const self = {
    location: { origin: 'https://orbitd.io' },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: vi.fn(),
    clients: {
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => null),
      claim: vi.fn(async () => undefined),
    },
    registration: {
      showNotification: vi.fn(async () => undefined),
      getNotifications: vi.fn(async ({ tag }: { tag: string }) => shown.filter((n) => n.tag === tag)),
      pushManager: { subscribe: vi.fn(async () => ({})) },
    },
  };
  runInNewContext(source, { self, URL, fetch: vi.fn() });
  const dispatch = async (type: string, event: object) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  const push = (message: unknown) => dispatch('push', { data: { json: () => message } });
  return { self, shown, dispatch, push };
}

const tab = (over: Partial<FakeWindow> = {}): FakeWindow => ({
  url: 'https://orbitd.io/sessions/x',
  visibilityState: 'visible',
  focused: false,
  focus: vi.fn(async function (this: FakeWindow) {
    return this;
  }),
  navigate: vi.fn(async () => null),
  ...over,
});

const alert = { v: 1, type: 'alert', title: 'Approval needed', body: 'Run rm?', tag: 'approval-s1', url: '/sessions/s1' };

describe('sw.js: a push', () => {
  it('shows an alert with its tag, the Orbit icon and where a click goes', async () => {
    const w = worker([tab({ visibilityState: 'hidden' })]);
    await w.push(alert);
    expect(w.self.registration.showNotification).toHaveBeenCalledWith('Approval needed', {
      body: 'Run rm?',
      tag: 'approval-s1',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: '/sessions/s1' },
      renotify: true,
    });
  });

  it('shows nothing while an Orbit tab is visible and focused (D3 = A)', async () => {
    const w = worker([tab({ focused: true })]);
    await w.push(alert);
    expect(w.self.registration.showNotification).not.toHaveBeenCalled();
    // A visible tab that is not focused (another window in front) still gets one.
    const v = worker([tab({ focused: false })]);
    await v.push(alert);
    expect(v.self.registration.showNotification).toHaveBeenCalled();
  });

  it('a sync closes the approval notifications of the sessions it names, and only those', async () => {
    const w = worker();
    await w.push({ v: 1, type: 'sync', clearSessions: ['s1'] });
    expect(w.shown[0].close).toHaveBeenCalled();
    expect(w.shown[1].close).not.toHaveBeenCalled();
    expect(w.self.registration.showNotification).not.toHaveBeenCalled();
  });

  it('ignores a message of another version', async () => {
    const w = worker();
    await w.push({ ...alert, v: 2 });
    expect(w.self.registration.showNotification).not.toHaveBeenCalled();
  });
});

describe('sw.js: a click', () => {
  const click = (url: string) => {
    const notification = { close: vi.fn(), data: { url } };
    return { notification, event: { notification } };
  };

  it('focuses an open Orbit tab and takes it to the notification’s page', async () => {
    const open = tab({ visibilityState: 'hidden' });
    const w = worker([open]);
    const { notification, event } = click('/sessions/s1');
    await w.dispatch('notificationclick', event);
    expect(notification.close).toHaveBeenCalled();
    expect(open.focus).toHaveBeenCalled();
    expect(open.navigate).toHaveBeenCalledWith('https://orbitd.io/sessions/s1');
    expect(w.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('opens a new tab when none is open', async () => {
    const w = worker();
    await w.dispatch('notificationclick', click('/tasks/t1').event);
    expect(w.self.clients.openWindow).toHaveBeenCalledWith('https://orbitd.io/tasks/t1');
  });

  it('opens a notify’s link to another site in a new tab, leaving the Orbit tab where it is', async () => {
    const open = tab({ visibilityState: 'hidden' });
    const w = worker([open]);
    await w.dispatch('notificationclick', click('https://ci.example/run/1').event);
    expect(open.navigate).not.toHaveBeenCalled();
    expect(w.self.clients.openWindow).toHaveBeenCalledWith('https://ci.example/run/1');
  });

  it('opens a new tab when the open one cannot be navigated (not controlled by the worker)', async () => {
    const open = tab({ visibilityState: 'hidden' });
    open.navigate.mockRejectedValue(new TypeError('not controlled'));
    const w = worker([open]);
    await w.dispatch('notificationclick', click('/sessions/s1').event);
    expect(w.self.clients.openWindow).toHaveBeenCalledWith('https://orbitd.io/sessions/s1');
  });
});

describe('sw.js: a changed subscription', () => {
  it('subscribes again with the old key', async () => {
    const w = worker();
    const key = new Uint8Array([1, 2]);
    await w.dispatch('pushsubscriptionchange', { oldSubscription: { options: { applicationServerKey: key } } });
    expect(w.self.registration.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: key });
  });
});

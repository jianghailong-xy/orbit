// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => vi.fn<(path: string, options?: unknown) => Promise<unknown>>());
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api }));

import { ApiError } from '../api';
import {
  disableWebPush,
  enableWebPush,
  getWebPushConfig,
  getWebPushState,
  resyncWebPush,
  unregisterWebPushOnSignOut,
  urlBase64ToUint8Array,
} from './webPush';

/** This browser's Web Push subscription (docs/web-push-design.md): what it asks the browser, and what it tells the server. */

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';

function fakeSubscription() {
  return {
    endpoint: ENDPOINT,
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'P256', auth: 'AUTH' } }),
    unsubscribe: vi.fn(async () => true),
  };
}

let sub: ReturnType<typeof fakeSubscription> | null;
let pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
let serviceWorker: { register: ReturnType<typeof vi.fn>; getRegistration: ReturnType<typeof vi.fn>; ready: Promise<unknown> };
let permission: NotificationPermission;
let requestPermission: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sub = null;
  permission = 'default';
  pushManager = {
    getSubscription: vi.fn(async () => sub),
    subscribe: vi.fn(async () => (sub = fakeSubscription())),
  };
  const registration = { pushManager };
  serviceWorker = {
    register: vi.fn(async () => registration),
    getRegistration: vi.fn(async () => registration),
    ready: Promise.resolve(registration),
  };
  requestPermission = vi.fn(async () => permission);
  vi.stubGlobal('Notification', {
    get permission() {
      return permission;
    },
    requestPermission,
  });
  vi.stubGlobal('PushManager', function PushManager() {});
  Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker, configurable: true });
  api.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  vi.resetAllMocks();
});

describe('web push config', () => {
  it('reads the public key, and takes an older server (404) for none', async () => {
    api.mockResolvedValueOnce({ publicKey: 'KEY' });
    expect(await getWebPushConfig()).toBe('KEY');
    expect(api).toHaveBeenCalledWith('/push/web-config');
    api.mockRejectedValueOnce(new ApiError('Not Found', 404));
    expect(await getWebPushConfig()).toBeNull();
  });
});

describe('web push state', () => {
  it('is unsupported without a service worker, PushManager or Notification', async () => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    expect(await getWebPushState()).toBe('unsupported');
  });

  it('is blocked when the site is denied, on only with permission and a subscription', async () => {
    permission = 'denied';
    expect(await getWebPushState()).toBe('blocked');
    permission = 'granted';
    expect(await getWebPushState()).toBe('off');
    sub = fakeSubscription();
    expect(await getWebPushState()).toBe('on');
    permission = 'default';
    expect(await getWebPushState()).toBe('off');
  });
});

describe('turning it on and off', () => {
  it('asks, registers /sw.js, subscribes with the key and registers the subscription as a web device', async () => {
    permission = 'granted';
    expect(await enableWebPush('AQAB')).toBe('on');
    expect(requestPermission).toHaveBeenCalled();
    expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    const options = pushManager.subscribe.mock.calls[0][0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(options.userVisibleOnly).toBe(true);
    expect([...options.applicationServerKey]).toEqual([1, 0, 1]);
    expect(api).toHaveBeenCalledWith('/push/register', {
      method: 'POST',
      body: { platform: 'web', token: ENDPOINT, bundleId: 'web', webKeys: { p256dh: 'P256', auth: 'AUTH' } },
    });
  });

  it('subscribes nothing when the prompt is refused', async () => {
    permission = 'denied';
    expect(await enableWebPush('AQAB')).toBe('blocked');
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });

  it('unregisters, then unsubscribes', async () => {
    const current = (sub = fakeSubscription());
    await disableWebPush();
    expect(api).toHaveBeenCalledWith('/push/unregister', { method: 'POST', body: { platform: 'web', token: ENDPOINT } });
    expect(current.unsubscribe).toHaveBeenCalled();
  });
});

describe('keeping the server in step', () => {
  it('registers an existing subscription again on load, and nothing without one', async () => {
    permission = 'granted';
    await resyncWebPush();
    expect(api).not.toHaveBeenCalled();
    sub = fakeSubscription();
    await resyncWebPush();
    expect(api).toHaveBeenCalledWith('/push/register', expect.objectContaining({ method: 'POST' }));
  });

  it('on sign-out unregisters and unsubscribes, and a failure never throws', async () => {
    const current = (sub = fakeSubscription());
    api.mockRejectedValue(new Error('offline'));
    await expect(unregisterWebPushOnSignOut()).resolves.toBeUndefined();
    expect(api).toHaveBeenCalledWith('/push/unregister', { method: 'POST', body: { platform: 'web', token: ENDPOINT } });
    expect(current.unsubscribe).toHaveBeenCalled();
  });
});

it('decodes a base64url key', () => {
  expect([...urlBase64ToUint8Array('-_8')]).toEqual([0xfb, 0xff]);
});

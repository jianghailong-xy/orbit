import type { WebPushConfig, WebPushRegistration } from '@orbit/shared';
import { api, ApiError } from '../api';

/**
 * This browser's notifications (docs/web-push-design.md): the service worker at /sw.js shows them, and the server
 * sends them to the subscription this module registers as a `web` device token.
 */
export type WebPushState = 'unsupported' | 'blocked' | 'on' | 'off';

const SW_URL = '/sw.js';

/** The server's VAPID public key; null when it sends no web push, or is older than web push (404). */
export async function getWebPushConfig(): Promise<string | null> {
  try {
    const config = await api<WebPushConfig>('/push/web-config');
    return config?.publicKey ?? null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export function webPushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration(SW_URL);
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function getWebPushState(): Promise<WebPushState> {
  if (!webPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  return (await currentSubscription()) ? 'on' : 'off';
}

export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function register(sub: PushSubscription): Promise<void> {
  const keys = sub.toJSON().keys ?? {};
  const body: WebPushRegistration = {
    platform: 'web',
    token: sub.endpoint,
    bundleId: 'web',
    webKeys: { p256dh: keys.p256dh ?? '', auth: keys.auth ?? '' },
  };
  await api('/push/register', { method: 'POST', body });
}

/**
 * Turn this browser's notifications on. Call it from the click itself: browsers show the permission prompt only
 * in answer to a user gesture. Resolves to the state it ends in ('blocked' when the prompt was refused).
 */
export async function enableWebPush(publicKey: string): Promise<WebPushState> {
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'blocked';
  if (permission !== 'granted') return 'off';
  await navigator.serviceWorker.register(SW_URL, { scope: '/' });
  const registration = await navigator.serviceWorker.ready;
  const sub =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
  await register(sub);
  return 'on';
}

/** Turn this browser's notifications off: the server forgets the subscription, then the browser drops it. */
export async function disableWebPush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/push/unregister', { method: 'POST', body: { platform: 'web', token: sub.endpoint } });
  await sub.unsubscribe();
}

/**
 * On a signed-in load: register this browser's subscription again, if it has one. Cheap, and it keeps the server in
 * step after the service worker re-subscribed (pushsubscriptionchange) or after a sign-in on the same browser.
 */
export async function resyncWebPush(): Promise<void> {
  try {
    if (!webPushSupported() || Notification.permission !== 'granted') return;
    const sub = await currentSubscription();
    if (sub) await register(sub);
  } catch {
    // best-effort: the switch in Settings shows the real state
  }
}

/** Before sign-out drops the token: unregister and drop this browser's subscription. Never throws. */
export async function unregisterWebPushOnSignOut(): Promise<void> {
  try {
    if (!webPushSupported()) return;
    const sub = await currentSubscription();
    if (!sub) return;
    await api('/push/unregister', { method: 'POST', body: { platform: 'web', token: sub.endpoint } }).catch(() => undefined);
    await sub.unsubscribe();
  } catch {
    // best-effort: the server's login-session rule covers an unregister that never arrived
  }
}

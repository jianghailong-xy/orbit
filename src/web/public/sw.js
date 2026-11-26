// Orbit's service worker: browser notifications (Web Push, docs/web-push-design.md). Served at /sw.js so its
// scope is the whole site; nginx sends it `Cache-Control: no-cache`, so a deploy's copy is picked up at once.
// A plain file, no build step: each push's data is JSON of WebPushMessage (@orbit/shared push.ts).

const WEB_PUSH_VERSION = 1;
const ICON = '/icon-192.png';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function readMessage(event) {
  try {
    return event.data ? event.data.json() : null;
  } catch {
    return null;
  }
}

/** Decision D3 = A: an Orbit tab that is visible and focused already shows the event, so no system notification. */
async function orbitTabInFront() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.some((c) => c.visibilityState === 'visible' && c.focused);
}

async function handlePush(msg) {
  if (!msg || msg.v !== WEB_PUSH_VERSION) return;
  if (msg.type === 'alert') {
    if (await orbitTabInFront()) return;
    await self.registration.showNotification(msg.title, {
      body: msg.body,
      tag: msg.tag,
      icon: ICON,
      badge: ICON,
      data: { url: msg.url },
      renotify: true,
    });
    return;
  }
  if (msg.type === 'sync' && Array.isArray(msg.clearSessions)) {
    for (const id of msg.clearSessions) {
      const shown = await self.registration.getNotifications({ tag: 'approval-' + id });
      for (const n of shown) n.close();
    }
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(readMessage(event)));
});

async function openUrl(url) {
  const origin = self.location.origin;
  const target = new URL(url || '/', origin);
  // A notify's own link to another site opens beside Orbit, never in place of an Orbit tab.
  if (target.origin !== origin) {
    await self.clients.openWindow(target.href);
    return;
  }
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const tab = windows.find((c) => new URL(c.url).origin === origin);
  if (tab) {
    try {
      const focused = await tab.focus();
      await (focused || tab).navigate(target.href);
      return;
    } catch {
      // navigate() refuses a tab this worker does not control (opened before it was installed): open a new one.
    }
  }
  await self.clients.openWindow(target.href);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(openUrl(data.url));
});

// The worker holds no login (the web app keeps its token in localStorage), so it only subscribes again; the page
// registers the new subscription with the server on its next load (lib/webPush.ts resyncWebPush).
async function resubscribe(oldSubscription) {
  let key = oldSubscription && oldSubscription.options && oldSubscription.options.applicationServerKey;
  if (!key) {
    const res = await fetch('/api/push/web-config').catch(() => null);
    const config = res && res.ok ? await res.json().catch(() => null) : null;
    key = config && config.publicKey;
  }
  if (!key) return;
  await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(resubscribe(event.oldSubscription).catch(() => undefined));
});

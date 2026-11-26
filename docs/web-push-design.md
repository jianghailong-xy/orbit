# Browser notifications (Web Push)

Status: design, 2026-11-26. Board: `docs/mocks/web-push/board.html`.

## Goal

The web client gets the same alerts the iPhone and Android apps get (an approval waiting, a session finished, an
agent asking for you, owner items, …), as system notifications. They arrive even when no Orbit tab is open, as long as
the browser is running, the way YouTube's do. Clicking one opens the session, project or task it is about.

Production (`https://orbitd.io`) comes first. It already has the two things Web Push needs: HTTPS, and outbound
internet (it reaches APNs and FCM today).

## Today

- `PushService` decides once whether and when each alert rings, then hands one APNs-shaped JSON body to `deliver()`.
  `deliver()` sends it to every live `DeviceToken` row of the owner: `ios` through APNs, `android` through FCM
  (`fcmData()` turns the APNs body into Android's payload at the transport boundary). Feishu is a separate channel.
- `targets()` picks the rows; `withLiveSession()` drops rows whose login session has ended
  (docs/push-login-session-design.md).
- The web client has a manifest, no service worker, and no use of the Notification API.

## Design

A browser becomes a third `DeviceToken` platform, `web`. Nothing upstream of `deliver()` changes, so every alert
kind, the two Settings switches (`notifySessionFinished`, `notifyAgentMessage`), and the login-session rule apply as
they are.

### Server

- **Keys.** VAPID key pair from the environment: `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY` (base64url, as
  `web-push generate-vapid-keys` prints them) and `WEB_PUSH_SUBJECT` (default `https://orbitd.io`; no email is
  needed). Unset: web push is off, logged once at boot like APNs and FCM.
- **`GET /api/push/web-config`** → `{ publicKey }` or `{ publicKey: null }`. The client shows the switch only when
  a key is configured.
- **Register.** `POST /api/push/register` takes `platform: 'web'`, `token` = the subscription's `endpoint`, and
  `webKeys: { p256dh, auth }`. `bundleId` is `web`, `environment` is `production`. The endpoint must be `https:`; it
  is the push service's URL the server will POST to, so it is checked against the known push services
  (`*.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`, `web.push.apple.com`) so a client
  cannot point the server at an arbitrary host.
- **Migration.** `device_tokens.web_keys jsonb NULL`. Only web rows use it.
- **`WebPushTransport`** (`src/apiserver/src/push/web-push-transport.ts`), next to `FcmTransport`, using the
  `web-push` npm library (RFC 8291 encryption and VAPID). `webPushData(body, type, collapseId)` turns the APNs body
  into `{ title, body, tag, url, badge, clearSessions }`:
  - `url` from the routing keys (`sessionID` → `/sessions/<id>`, `projectID` → `/projects/<id>`, `taskID` →
    `/tasks/<id>`, a notify's own `url`), the same routes as Feishu's `orbitUrl()`.
  - `tag` = the collapse id (or `approval-<session>` for an approval), so a newer alert replaces an older one in
    the same tray slot, as on the phones.
  - A `background` badge sync is sent only when it has `clearSessions`; the service worker closes those
    sessions' approval notifications.
  - 404 / 410 from the push service deletes the row, the same way APNs's 410 does. TTL 1 day; `urgency: high` for
    alerts, `low` for syncs.
- `targets()` adds `platform: 'web'` when keys are configured; `deliver()` gets a `web` branch with the same
  `isCurrent()` re-check as FCM.

### Web client

- **`/sw.js`** (`src/web/public/sw.js`, served at the root so its scope is the whole site; nginx sends it
  `Cache-Control: no-cache`). It handles three events:
  - `push`: show the notification (title, body, `tag`, the Orbit icon). With decision D3 = A, it skips this while
    an Orbit tab is visible and focused, because that tab already shows the event.
  - `notificationclick`: focus an open Orbit tab and navigate it to `url`, or open a new one.
  - `pushsubscriptionchange`: re-subscribe and re-register.
- **Settings → Notifications** gets a second card, **This browser**, with one switch, "Notifications in this
  browser". Turning it on asks the browser for permission (browsers allow the prompt only after a click),
  subscribes with the public key and registers. Turning it off unsubscribes and unregisters. States it can show:
  - on;
  - off;
  - blocked in the browser's site settings: switch disabled, with "Allowed in your browser's site settings";
  - not supported, e.g. Safari on iPhone outside the Home Screen: the card says so.
- **Sign out** unregisters this browser's subscription before the token is dropped. The login-session rule covers
  a sign-out that never reaches the server.

## Limits

- Needs HTTPS and outbound internet from the apiserver. The self-hosted deployment at 10.66.82.117 is phase 2:
  it needs HTTPS (or a host name with a certificate) and a route to the browsers' push services.
- Safari on iPhone and iPad: only for Orbit added to the Home Screen (iOS 16.4+).
- A browser that is fully closed gets nothing until it is opened again; the push service keeps alerts for the TTL.

## Decisions (board part ④)

- **D1, where it is turned on.** A: only the switch in Settings (recommended). B: also a one-time prompt strip
  after sign-in.
- **D2, which alerts.** A: the same alerts as the phones, under the same switches (recommended). B: only alerts
  that need you (approvals, agents asking, owner items).
- **D3, an Orbit tab in front.** A: no system notification while an Orbit tab is visible and focused
  (recommended). B: always show one.

## Steps (by cost)

1. Server: migration, `WebPushTransport`, `web-config`, register/unregister for `web`, with specs (the payload
   mapping, endpoint allow-list, 410 prunes the row, login-session rule).
2. Web: `sw.js`, the This browser card, sign-out unregister, nginx `/sw.js` block, with tests.
3. Production: generate VAPID keys, put them in production's `.env`, deploy, and check by hand that an approval
   rings in Chrome with every Orbit tab closed.
4. Phase 2: the self-hosted deployment, once it has HTTPS and outbound access.

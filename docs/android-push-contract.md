# Android push contract (A09, version 1)

S1 covers GMS phones in Hong Kong/Singapore, Android 10–16 (minSdk 29), using
FCM HTTP v1. There is no vendor push fallback. This is the backend/A10 integration
contract; it does not establish real-device delivery or the final iOS alignment baseline.
Types are in `src/shared/src/push.ts`; executable wire examples are in
`src/shared/src/android-push.fixture.json`.

## Registration and logout

All requests use the current account's bearer access token and JSON content type.
`POST /api/push/register`:

```json
{
  "platform": "android",
  "token": "opaque-FCM-registration-token",
  "bundleId": "io.orbitd.android.debug",
  "environment": "production",
  "installationId": "40000000-0000-4000-8000-000000000001"
}
```

`bundleId` is the actual Android applicationId. `production` is the only Android
environment, including debug builds; FCM has no APNs sandbox. Generate a random
UUID v4 per installation/server and retain it across token changes and account
switches. Keep it out of device backup/restore to another installation. Do not
use a hardware identifier. Token is opaque, nonempty, up to 4096 characters.

The response is `{ "ok": true, "registrationKey": "<opaque UUID>" }`.
Persist this key with the current server/account/token. Every registration returns
a fresh key. Registration atomically removes the previous token for this
installation/package/environment, transfers an existing FCM token to the current
account, and creates a new binding. The global token uniqueness constraint and
user cascade FK remain in force. A token cannot be transferred between platforms.
Concurrent registrations use the shared transaction retry policy (four attempts)
for transient conflicts. A permanent unique collision returns 409; register the
current token again. Exhausted transient conflicts use the existing typed 503.

Android must serialize registration, token refresh and account switching. Discard
responses belonging to a superseded login generation. On an uncertain network
result, register again and retain the new response. After a token callback,
register the current token again with the same installationId; the previous token
must no longer be targeted. Registering does not prove that this deployment has
working FCM credentials, notification permission, or a reachable device.

Before revoking the account's login, call `POST /api/push/unregister`:

```json
{
  "platform": "android",
  "token": "opaque-FCM-registration-token",
  "registrationKey": "019a0000-0000-7000-8000-000000000001"
}
```

It returns `{ "ok": true }`, including when already removed. Deletion requires
the authenticated owner, platform, token and binding key to match. An old logout
cannot remove a newly registered binding, even with the same account and token.
Always clear local notifications and discard the local binding on logout/server
switch, even if offline. A queued cloud message cannot be recalled; reject its
old registrationKey before displaying its contents. The generic auth/logout
endpoint does not implicitly unregister devices (unchanged from iOS).

Legacy iOS registration remains `{token, bundleId, environment?}` with default
platform `ios` and environment `production`; response remains `{ok:true}`. Its
token-based refresh/transfer and `{token}` logout stay compatible. The new nullable
installation column does not require rewriting existing APNs rows.

## FCM message and client behavior

The HTTP v1 `message` contains `token`, `data`, and `android` only: no automatic
`notification` block. `FirebaseMessagingService` receives the data and the app
owns display/removal. Every value in `data` is a string:

| Field | Meaning |
| --- | --- |
| `version` | `"1"`; ignore unsupported versions safely. |
| `type` | `alert` or silent `sync`. |
| `registrationKey` | Must exactly match the active server/account binding. |
| `eventId` | UUID stable across one send's retries; deduplicate within the binding. |
| `notificationKey` | Tag for replacement, scoped to the binding. Stable for an approval session, settled session, owner item, confirmation record, or watch generation. |
| `sentAt` | Server ISO timestamp for ordering/diagnostics, not proof of arrival time. |
| `payload` | JSON object of `AndroidPushPayload`; examples are in the shared fixture. |

The JSON payload carries `title`, `body`, `category`, `threadId`, `kind` and the
existing route keys (`sessionID`, `projectID`, `openItemID`, `taskID`, `recordID`,
`runnerID`, `engine`, `watchID`, `generation`, `wikiSpaceID`) when applicable.
Absent keys stay absent. These route IDs retain the existing push UUID spelling;
normalize them to the same identity as REST public IDs in Android's protocol
layer. REST accepts both spellings. `registrationKey` and `installationId` are
opaque binding values, never public-ID converted.

Alerts use HIGH priority and silent sync uses NORMAL. Both expire after 300s.
There is no FCM collapse key: its four-key storage limit could lose unrelated
sessions or a `clearSessions` delta. Retry copies retain the same `eventId` and
identical body. Semantic duplicate alerts use the same local notification tag;
replace them without alerting again (`setOnlyAlertOnce`). Do not suppress a new
approval edge after the previous one was cleared. Existing approval edge
deduplication and agent-message minute throttling remain shared/per replica;
they do not establish globally exactly-once delivery across restarts/replicas.

`sync` has no banner or sound. `badge` is the number of distinct canonical Open,
non-ending RUNNING sessions with pending approvals, plus coordinator conversations
carrying the four owner items. `clearSessions` names sessions that left that set;
remove their approval/owner-item reminders, not unrelated finished/agent-message
notifications. A zero badge is meaningful; a same-count session replacement is
also meaningful. Launcher numeric badges are not guaranteed by S1.

Push is a hint. Before showing an actionable reminder or opening its card, use
authenticated REST to verify the session/item still exists and needs this owner.
On foreground/resume, after reconnect, after receiving sync, and after deleting
messages is reported by FCM, reconcile from the authoritative session/project
snapshots. Read the same canonical session `pendingApprovals`/owner-item state
as iOS; never treat an older push as a new pending approval. Do not depend on
timestamps or `clearSessions` alone: silent messages can be delayed/lost, and
the server's diff cache is in memory. Permission denial, force-stop, OEM limits,
offline expiry, and messages already in flight require this REST fallback.
No notification button may bypass the existing authenticated business endpoints.

## Configuration and transport policy

APNs retains `APNS_KEY` (base64 PEM), `APNS_KEY_ID`, `APNS_TEAM_ID`, and
`APNS_BUNDLE_ID` (default `io.orbitd.app`). Android independently uses:

| Variable | Value |
| --- | --- |
| `FCM_PROJECT_ID` | Target Firebase project ID with Cloud Messaging HTTP v1 enabled. |
| `FCM_CLIENT_EMAIL` | Service account `client_email` authorized for that project. |
| `FCM_PRIVATE_KEY` | Base64 of its PEM `private_key`, not base64 of the whole JSON file. |
| `FCM_ANDROID_PACKAGE` | Exact permitted applicationId; default `io.orbitd.android`. Use `.debug` for the debug client. |

Supply these through the deployment's secret mechanism; do not commit credential
files or put service account material in an Android app. `.env.example` and Compose
declare only placeholders. This change does not deploy anything. One deployment
targets one FCM project/package; test and release use their corresponding isolated
configuration. Android-only operation requires no APNS variables. Missing one
FCM credential disables only Android; bad FCM credentials/failures cannot block
APNs, and bad APNs credentials cannot block Android.

OAuth uses a cached, single-flight RS256 assertion exchange at Google's fixed
token endpoint and the `firebase.messaging` scope. Send targets only the configured
platform/package/environment/owner; APNs additionally selects sandbox or production
per registration. FCM requests restrict the receiving Android package. The
registration snapshot is checked before each send/retry; invalidation deletes
only that snapshot, never a binding replaced meanwhile.

FCM has at most three attempts, each HTTP request with a 10s timeout. A 401 may
refresh OAuth once; network errors and 429/500/503 use backoff with jitter.
429 waits at least 60s. Retry-After is honored; a requested wait above 60s ends
best-effort delivery rather than retrying early. This is not a durable retry queue.
Only HTTP 404 with typed FCM `UNREGISTERED` prunes a token. Generic 404,
`INVALID_ARGUMENT`, sender mismatch, auth/quota/server errors, and oversized
payloads retain it. A payload error must not erase all otherwise healthy devices.
Logs omit credentials, registration tokens and provider error bodies.

## Local checks and remaining integration evidence

Run sequentially for the backend build directory:

```sh
bash scripts/worktree-overlay.sh
cd src/apiserver && rm -rf build && npm test
# From the repository root, after npm test has finished:
bash scripts/run-pg-spec.sh src/apiserver/src/push/push-registration.pg.spec.ts src/apiserver/src/push/owner-item-badge.pg.spec.ts
```

`fcm-transport.spec.ts` uses ephemeral RSA keys, injected HTTP responses and a fake
waiter. It tests actual JWT signatures, OAuth cache, v1 payload, retry identity,
backoff, account change while waiting, and invalid-token classification without
contacting Google. `push-routing.spec.ts` tests both channels, Android-only/APNs-only,
duplicate approvals, resolved items and clearSessions. The PostgreSQL runner
creates its own isolated database and refuses skipped tests; it checks migration
preservation, uniqueness, rotation/transfer/concurrency, delayed logout and stale
provider failure, plus the existing owner-item badge regression.

For subsequent real integration, the coordinator must provide an isolated FCM
project/service account through a secure entry, matching Android Firebase client
configuration, isolated test accounts, a target S1 GMS phone and an actual iOS
build identity. A10 must implement this binding/display/reconciliation contract.
Record backend/client SHAs, device/API/OS/GMS identity, permission state, token
rotation/logout, foreground/background/cold-open/force-stop behavior, duplicate
reminders, and another device resolving an approval. Separate provider acceptance,
device receipt, visible result and click navigation timestamps (including clock
uncertainty). No fake transport, build, or emulator shell run proves real delivery.

The A09 starting tree was `ec10c8e8b34d6c5a4b152980f7e5ee3be16c02c1`. Ordinary
merge of the fixed A02 input `a6c43ddab6461d09700a7f0fabb35759b67799d4` produced
`04a07bbc9e9cfae5b5c3093e16ad001fcf56bb40`, preserving both ancestors. Android
application/workflow sources are unchanged by A09. Compared with iOS audit source
`946b7352b83c1c7251d1a386997310366d3f833b`, Push.swift and Notifications.swift
are unchanged; APIClient.swift has unrelated provider/account management additions,
with its push methods unchanged. This is traceability, not owner confirmation of
the final installed baseline; A01/A15 retain that obligation.

A01 matrix UI-C09 (notification registration, routing and clearSessions), UI-C07
(cross-device approval state), UI-F07 (watch routing), and UI-F11/F13 (notification
settings/preferences) are the audit inputs for these preserved semantics. D09's
approved P07 method is `a01-errata-v2.md` §6 (the historical heading says unapproved;
owner decision `34ZnO6jigU87dDKZK6E1M` supersedes that status): each target phone
needs foreground/background-alive/background-not-running groups of 30 events,
30/30 arrival within 30s, visible-result P95 ≤10s, and tap-to-actionable P95 ≤3s;
foreground reconciliation of another device's resolution requires ≤3s with both
notification removal and UI evidence. None of those device/timing results is
established by A09's isolated backend checks.

Protocol references: [FCM authorization](https://firebase.google.com/docs/cloud-messaging/auth-server),
[HTTP v1 message schema](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages),
[FCM error handling](https://firebase.google.com/docs/cloud-messaging/error-codes),
[service account OAuth](https://developers.google.com/identity/protocols/oauth2/service-account).

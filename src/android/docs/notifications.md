# Android notifications (A10)

## Fixed development input and evidence boundary

The A10 starting SHA is `3cb12b3be2a38c55601786bdfa1967f60a86990a`.
An ordinary merge of the fixed A07 input produced
`8b15ce6f8bb7392762acf4f4c1528de17ff6fbc6` (a fast-forward). That tree already
contains A09 `2623d8b2ebb983ba8e223b29cc532b98fbad4976`. A09's push backend,
`src/shared/src/push.ts`, `src/shared/src/android-push.fixture.json`, and
`docs/android-push-contract.md` have no changes between that A09 SHA and the
combined input. The notification Swift files in the table below are also
unchanged between the A10 starting and combined input.

The coordinator subsequently fixed A07's 413 follow-up at
`51bbcc303cec3c64dfb217316afce9498add760d`. A10 absorbed it by ordinary merge
(fast-forward) before fixing the notification development input. Composer,
composer tests/fixture, and composer documentation inherited in that merge are
A07 work and are not A10-authored changes.

A14 `f59ab46cf223f813dbc9c0a1bed3399d8eb90649` is a separately fixed release
input, not merged into this development input. A10 must preserve its build
isolation when the platform integrates the branches; notification configuration
does not replace signing, release workflows, package isolation, or fixture
exclusion. Files inherited through the ordinary merge are upstream work, not
A10-authored changes.

S1 is Kotlin/Compose on Android 10–16 (API 29–36, minSdk 29), on GMS phones in
Hong Kong/Singapore. There is no vendor push fallback. A01's static matrix and
approved S1/D09 are implementation inputs; the actual iOS installation and final
same-data matrix remain unestablished. A05/A08 code review permits development
to proceed, without completing their device acceptance. This document records
the module contract and verification plan. Local build and controlled-test
results are separate from FCM/APNs delivery, physical-device results, and D09
timing evidence.

## Source-to-module mapping

| Fixed source | Android responsibility | Difference or limit |
| --- | --- | --- |
| `src/ios/Sources/Push.swift`, `PushRegistrar` | Buffer FCM token callbacks until authentication; register the current token through authenticated HTTP. | Android always uses `production`, including debug; installation and fresh registration binding keys are Android contract additions. |
| `src/ios/Sources/Push.swift`, silent push delegate | Receive silent sync without a banner/sound; remove stale needs-you reminders and refresh authoritative state. | Android owns every display because FCM messages contain only data. |
| `src/macos/OrbitApp/Sources/OrbitApp/NotificationManager.swift` | Notification permission, categories, display, tap routing, focused-session suppression, and removal. | Android 13+ runtime permission and API 29+ notification-channel controls replace Apple authorization/categories; an in-app Snackbar provides the foreground approval cue. |
| `src/macos/OrbitKit/Sources/OrbitKit/App/Notifications.swift` | Stable replacement identity, approval versus session semantics, authenticated session/card entry. | Inline Apple Allow/Deny/Reply must not become unauthenticated Android mutations; opening the existing authoritative card is the safe business entry. |
| `src/macos/OrbitKit/Sources/OrbitKit/App/SessionGrouping.swift` | Reconcile needs-you reminders from canonical REST state, excluding `waitingKind=START_REQUEST`. | `ownerItems` may keep an AWAITING_INPUT coordinator in needs-you; do not impose the native approval RUNNING requirement on owner items. |
| `src/apiserver/src/push/push.controller.ts`, `dto.ts` | Register/refresh/unregister wire requests with a generation-safe local binding. | Registration success proves only backend registration, not configured FCM delivery or notification permission. |
| `src/apiserver/src/push/push.service.ts`, `badge-diff.ts`, `fcm-payload.ts` | Read `version`, `type`, binding/event/tag fields, routes, `badge`, and `clearSessions` exactly as sent. | Push ordering and the in-memory server diff cache cannot substitute for REST. |
| `src/apiserver/src/projects/owner-decision-signal.ts` | Read owner-item identity and pending state from session/project snapshots. | `pendingApprovals` includes owner decisions; it is not a list of native approval records. |
| `src/shared/src/push.ts`, `android-push.fixture.json` | Preserve optional fields, test the actual serialized approval/resolved examples, normalize route IDs only. | Shared-fixture agreement establishes wire compatibility, not real cross-platform business behavior. |
| `app/navigation/OrbitRoute.kt`, `MainActivity.kt` | Reuse ACTION_VIEW, `OrbitLinks`, pending-login destination, existing back stack, and real screens. | A10 must preserve every other Destination branch and existing IME/cleanup behavior. |
| `core/realtime/RealtimeStore.kt`, `RealtimeModels.kt` | Refresh the directory and selected session after push/sync/reconnect/resume. | Only a fresh snapshot is authority; failed reads preserve stale data and do not mean resolved. |

All Android paths in the table are relative to `src/android`; shared/backend/
Swift paths are relative to the repository root. Changes to the fixed mapping
must be recorded explicitly instead of silently excluding a kind.

## Registration, notification identity, and authority

`POST /api/push/register` sends `platform=android`, the opaque FCM `token`, the
actual applicationId as `bundleId`, `environment=production`, and a UUIDv4
`installationId`. The installation ID belongs to one installation/server, survives
token rotation and account changes, and must not restore onto another device.
Persist the returned `registrationKey` with server/account/token. Every success
returns a new key. Never apply public-ID conversion to either binding UUID.

Serialize registration, refresh, and account changes. A captured `SessionHandle`
is a login generation, including repeated login as the same account. Discard
late responses for an old handle/token. When an HTTP result is uncertain,
register the current token again. A permanent registration collision is 409;
an exhausted transient retry is the existing typed 503.

Before explicitly revoking login, attempt `POST /api/push/unregister` with
`platform`, `token`, and `registrationKey` under the old authenticated handle.
Unregister is owner/key scoped and idempotent. Failure or offline state must not
prevent logout. Always clear the local binding and delivered notifications;
reject queued messages with its old key. The generic auth logout endpoint does
not unregister a device implicitly.

Validate version/type/binding before using a data message. Deduplicate `eventId`
within a binding. Scope the Android notification tag to binding and
`notificationKey`; semantic replacement uses `setOnlyAlertOnce`. Removal must
allow a later new approval edge to alert. UUID and public spelling identify the
same session; `ObjectId` normalization is for route/session/item identities only.

`sync` has no banner or sound. `clearSessions` removes only approval/owner-item
reminders for those sessions; settled runs and agent messages remain. Badge zero
and a same-count session replacement are meaningful, but launcher numeric badges
are not promised. Neither a badge nor a clear delta is final business state.

Before displaying an actionable reminder, read the authenticated session/item.
For native approvals, verify the session remains Open and non-ending, and that
`GET sessions/:id/approvals?status=PENDING` still returns an answerable item.
The fixed backend sends/counts approval pushes while RUNNING, but its pending
approval endpoint also recognizes a live background-job reader on a parked
conversation. Arrival-time authority therefore follows that endpoint instead of
reconstructing its reader rules or declaring every non-RUNNING prompt resolved.
For owner items,
verify the project open-items read still puts that exact item in `needsYou` and
routes to its bound coordinator. On tap, the existing reader/cards fetch their
own current state and use existing authenticated business endpoints.

Foreground/resume, reconnect, silent sync, and FCM deleted-message callbacks
must reconcile again. REST `pendingApprovals` counts more kinds of decisions
than native tool approvals; Swift's needs-you projection excludes a start-only
wait and includes nonempty owner items. A fresh open-list row can confirm that a
session still needs the owner, but a count alone cannot prove a specific approval
or owner item remains. A failed/offline refresh is not an empty snapshot. A
resolved/inaccessible item should render the real reader's current state or
access error, never revive a card from the push body.

`PushNoticeHost(controller, content)` wraps the existing themed MainActivity
content and observes `controller.notice: StateFlow<PushMessage?>`. A verified
foreground approval outside the focused session can display one dismissible
Material Snackbar. Open sends the same explicit ACTION_VIEW entry as a system
notification; Dismiss calls `controller.dismissNotice()`. The host pads above the
IME and navigation bars and does not change the shell's destinations or back
stack. The controller owns clearing on reconciliation, focus change, and logout.
System banners are suppressed in the foreground, keeping the existing card as
the focused session's only approval prompt. This follows the Swift separation
between an in-app foreground cue and background system display; the current
Android foreground cue does not independently play Swift's approval sound.

## Route correspondence and cross-module interfaces

| Payload | Existing product entry | Integration boundary |
| --- | --- | --- |
| `sessionID` for approval/settled/agent-message | `orbit://session/<id>` | Reader, current pending cards, and composer are inherited A06/A08/A07 work. |
| `sessionID` and `recordID` for confirmation problems | `orbit://session/<id>?at=<recordID>` | Reader requests the server's record anchor; inaccessible/deleted records use its existing error state. |
| Owner item with `sessionID` | Coordinator session | `openItemID` is not a transcript record ID; do not put it into `?at=`. Card state comes from the project snapshot. |
| Owner item without coordinator, with `projectID` | `orbit-project:<id>` | A11 owns the project product page. Its completed integration needs separate evidence. |
| `watchID` | `orbit://watch/<id>` | A12 owns the watch product page and generation interpretation. |
| `runnerID`/`engine` | `orbit://runner/<id>` | A13 owns runner/engine management; do not invent a notification-only editor. |
| `wikiSpaceID` | Existing `Destination.WIKI` can name a space, but the fixed `OrbitLinks` has no space URI | A12 was asked for `orbit://wiki/<spaceId>` → `OrbitRoute(Destination.WIKI, id=canonicalSpaceId)`. This remains a route integration gap until the minimal extension and its product destination are integrated and verified. |

The fixed Swift `Notifications.intent` handles session and watch payloads; it
does not route runner or wiki-space payloads. Extending an Android route is a
documented difference, not evidence of parity with an installed iOS client.
The existing pending-login route survives cold entry and is consumed after
authentication; account switches discard the previous account's path.

A13 owns the Settings page. A10 provides
`@Composable fun NotificationSettings(controller: PushController)` in
`app/src/main/kotlin/io/orbitd/android/push/NotificationSettings.kt`; A13 can call
`NotificationSettings(app.push)`. The component requests Android 13+ permission
on an explicit tap, reads current authorization on resume, and opens Android's
app notification settings. `controller.configured` describes SDK availability;
`controller.notifications.allowed(channel: String? = null)` checks global or
individual-channel authorization. Channel IDs are `orbit.needs-you`,
`orbit.sessions`, and `orbit.updates`. The interface was handed to A13 in a task
comment; A10 does not insert it into MainActivity's Settings branch. Settings
integration/permission-discovery remains incomplete until A13 wires that entry.
A10 owns `OrbitApplication.push` and its notification initialization. Shared-entry
changes remain minimal and preserve unrelated navigation/auth/attachment cleanup.

## Firebase client configuration

The notification integration pins `com.google.firebase:firebase-messaging:25.0.1`.
`app/build.gradle.kts` supplies generated `BuildConfig.FIREBASE_*` constants from
the following inputs. An environment value takes precedence over its Gradle
property; an absent value defaults to the empty string.

| Environment variable | Gradle property | BuildConfig field |
| --- | --- | --- |
| `ORBIT_ANDROID_FIREBASE_APP_ID` | `orbitFirebaseAppId` | `FIREBASE_APP_ID` |
| `ORBIT_ANDROID_FIREBASE_API_KEY` | `orbitFirebaseApiKey` | `FIREBASE_API_KEY` |
| `ORBIT_ANDROID_FIREBASE_PROJECT_ID` | `orbitFirebaseProjectId` | `FIREBASE_PROJECT_ID` |
| `ORBIT_ANDROID_FIREBASE_SENDER_ID` | `orbitFirebaseSenderId` | `FIREBASE_SENDER_ID` |
| `ORBIT_ANDROID_FIREBASE_ANDROID_PACKAGE` | `orbitFirebaseAndroidPackage` | `FIREBASE_ANDROID_PACKAGE` |

The supplied package must exactly match the installed `context.packageName`,
including the debug suffix. `firebaseMessaging(context)` checks all required
values and Google Play services availability before manually initializing the
default Firebase app. The manifest removes `FirebaseInitProvider` and defaults
FCM auto-initialization and Analytics collection off. Empty, incomplete,
package-mismatched, or unavailable-GMS builds expose unavailable push status;
foreground business remains independent.

The client values are the matching Firebase Android app configuration. Never
embed a service-account private key or server credential in an APK. This approach
does not add the Google services Gradle plugin or change signing. Values are
supplied for a build invocation; build debug and release with their own matching
configuration. A debug package value cannot initialize the release package
because of the runtime equality check. The A14 integration must still inspect
the combined release artifact and retain its existing fixture/signing isolation.

The deployment separately needs A09's `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`,
base64 PEM `FCM_PRIVATE_KEY`, and exact `FCM_ANDROID_PACKAGE`. These must belong to
the same isolated project/package as the client. Backend registration success
does not establish that these deployment credentials exist. No deployment,
release, purchase, or public push is authorized by this implementation task.

The FCM service makes an immediate attempt with a two-second coroutine deadline.
Slow/unavailable alert authority continues through `PushWorker`, an expiring
WorkManager request with a connected-network constraint, a fifteen-second attempt
limit, and ten-second linear retry backoff. Work is unique by binding/event;
the payload never authorizes a login restoration or an approval mutation. Worker
input expires five minutes after local enqueue and rejects backward wall-clock
movement. API 31+ high-priority messages request expedited work, falling back to
ordinary work when quota is unavailable; API 29–30 use ordinary scheduling after
the immediate attempt, without a persistent foreground service or a separate
"checking" notification. Every deferred attempt checks the current binding and
REST authority again. This follows Firebase's recommendation to continue longer
processing through WorkManager. Scheduling and the OS's execution window still
need actual-device validation; these deadlines do not prove delivery reliability.
[Firebase receiving guidance](https://firebase.google.com/docs/cloud-messaging/android/receive-messages)

## Local verification plan

The development handoff on the fixed `51bbcc3` base passed the original
`test lintDebug assembleDebug` gate and compiled the controlled instrumentation
APK: 90 core checks, 108 debug app checks, and 108 release app checks, with no
failures or skips. The 29 new notification cases run in both app variants.
Lint reported no errors. The unchanged fixed A09 push backend also passed 87
local non-Postgres regression cases. These checks do not establish device UI or
transport delivery. The first two emulator attempts retained runner/lifecycle
harness failures; their fixes and further device results are follow-up evidence.

Run the original Android gate with `--max-workers=2`; do not replace it with
only notification tests. Build and unit/HTTP checks can proceed without a device.
Use the shared fixture as input, with independent assertions about registration,
payload decoding, replacement/removal, and routes. Cover:

- Registration before/after token arrival, refresh, uncertain responses,
  same-token new binding, late old responses/logout, server/account switch,
  persistence after process restart, and installation storage exclusion.
- Binding rejection before display; duplicate event, same-tag replacement, and a
  new approval after clearing; UUID/public-ID equivalence; unsupported data.
- Native approval and exact owner-item authoritative reads; resolved, inaccessible,
  offline, and malformed responses; `clearSessions` preserving unrelated notes.
- Notification permission denied, individual channel blocked, global notifications
  blocked, missing Firebase configuration, and restored permission/channel state.
  Foreground login, reading, approvals, and sending must remain usable.
- Existing ACTION_VIEW cold entry, pending-login entry, real session/card actions,
  another device's resolution signal, foreground recovery, and account isolation.

Any emulator operation must hold `flock /var/lib/orbit/android/ui.lock`
exclusively for the whole device flow. If unavailable, continue non-device work.
Use production app/HTTP/navigation paths with a controlled server; injected
messages are transport substitutes only. Retain the APK/source/server/fixture
identities and failures. Restore settings, stop owned fixtures, remove owned adb
reverse mappings, and release the lock when finished. A fixture assertion or
shell notification injection is never an FCM receipt.

## Remaining real-device evidence and platform limits

Current resources do not include the target physical phones, matching live FCM
client/server credentials, deployment role accounts, or an installed iOS build
identity. The following steps remain even if every local check succeeds:

1. Integrate the exact A10 client commit with the fixed backend/shared inputs and
   A14 release isolation. Record each source SHA, APK hash/package/build/signature,
   deployment identity, permission/channel settings, and Firebase project/package
   identity without exposing credentials.
2. Configure the matching isolated Firebase Android client and A09 backend through
   the existing secure configuration path. Install on each agreed S1 GMS phone;
   record device model, Android/API/OS build, GMS version, network, and account role.
3. Record the actual iOS build/version/source, APNs environment, and same accounts/
   objects. Run equivalent real session, approval, owner-item, watch, and object
   flows; resolved/inaccessible taps must show the authoritative outcome.
4. Run D09 P07 on each target phone: foreground, background alive, and background
   not running groups of 30 events; 30/30 arrival within 30 seconds, visible-result
   P95 ≤10 seconds, and tap-to-actionable P95 ≤3 seconds. Record provider acceptance,
   device receipt, visible result, and tap/action timestamps separately with clock
   uncertainty. A foreground-suppressed system banner needs actual in-app evidence.
5. Resolve an approval on another actual client; after sync and independently after
   foreground recovery, record notification removal and refreshed in-app pending
   state within the required ≤3 seconds. Exercise token refresh, account/server
   switch, offline logout, stale in-flight messages, permission refusal, blocked
   channels, network recovery, and expired reminders.

The 300-second FCM TTL, NORMAL-priority silent sync, force-stop, Doze/background
limits, OEM policies, and connectivity can delay or discard messages. Local
permission and channel policy can prevent visible alerts despite provider
acceptance. Foreground REST recovery remains necessary. S1 does not promise
numeric launcher badges or delivery on phones without GMS. Local evidence must
name these limits and retain the real-resource gaps; it cannot claim the original
true FCM/APNs/physical-phone requirement or D09 P07 is complete.

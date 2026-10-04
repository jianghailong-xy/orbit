# Realtime, cache and recovery (A04)

## Development input and acceptance boundary

This implementation uses ordinary merges of A03 `0568d3f1e61c2a11df0fc5931d3897dfaad8b247`
and its delayed retry-401 fix `8647533e4d2200a6b8f76b84515c062d32a22712`, preserving
A02 `a6c43ddab6461d09700a7f0fabb35759b67799d4`. These are development inputs;
their Android physical-device acceptance is still outstanding.

S1 covers GMS phones on Android 10–16 (API 29–36), including rotation and split
screen. D09's physical R-min/R-ref/R-oem and cross-platform requirements remain.
A01's source matrix is the current implementation reference, not proof of an
installed iOS version. The actual iOS version/build/source SHA and interaction
baseline, final platform exceptions, deployment/role-account combination and
physical-device evidence are not frozen by this change. No real FCM delivery,
product transcript UI, frame-time or recovery percentile claim is made here.

## Application integration

Create one `RealtimeStore(authSession, processScope)` and one
`RealtimeLifecycle(application, store)` in `Application.onCreate`, before any
Activity starts. Registering the adapter from a lazily created Compose screen
would miss that Activity's earlier START callback. A05 owns this wiring, the
MainActivity, theme, navigation and directory UI. A04's adapter is a separate
file under `app/realtime`; it does not replace those entrypoints.

`store.state: StateFlow<RealtimeState>` exposes:

| Field | Meaning |
| --- | --- |
| `handle` | Captured A03 identity. A consumer must match it with the current `AuthState.SignedIn.handle` by identity before showing account data. |
| `directory` | Nullable full REST snapshot; non-null cached rows may be shown while stale. |
| `directoryRefreshing`, `directoryFresh`, `directoryError` | REST progress, freshness and failure. Failure retains old rows. |
| `controlConnection`, `controlError` | Account SSE status, separate from REST success. |
| `session` | Selected session's transcript, pending-state snapshot, freshness, connection and error. |
| `invalidationRevision` | Increments on control reconnect and every non-ping control event, including an empty `sessionId`. Other pages use it to reload their authority. |

`DirectorySnapshot` keeps complete `JsonObject`s, keyed by each object's `id`:
`workspaces`, `folders`, `tags`, `runners`, and `sessions` grouped under
`open`/`completed`/`trash`. Capability, permission, explicit null and unknown
fields survive REST and caching. A05 converts these to its directory DTOs.
All directory requests form one snapshot; a failed component does not silently
erase rows from another component.

`ConnectionState` has exactly `STOPPED`, `CONNECTING`, `CONNECTED`, `BACKOFF`.
`RealtimeError` has `reason: FailureReason` and `httpStatus: Int?`.
Reasons are `NETWORK`, `HTTP`, `PROTOCOL`, `STORAGE`; HTTP 403 is represented as
`HTTP` plus `403`, without leaking response bodies. A connected control stream
does not imply the directory REST read succeeded. Check `directoryFresh` and
`directoryError`; use `directory == null` for a cold loading/empty distinction.

Navigation calls `selectSession(id)` or `selectSession(null)`. Explicit
navigation wins over restoring the last session. After a mutation, call
`refreshDirectory()` and/or `refreshSession()` as appropriate. `close()` is for
disposing the process owner/tests, not each Activity recreation. UI should not
open its own SSE or persist these state objects.

## Two streams and authority

The account stream is `/api/events`. It has no replay cursor. Connecting it or
receiving any non-ping event invalidates REST data, including all directory
views, folders, tags, workspaces and runners. Raw control summaries never
overwrite full permission/capability fields from a REST snapshot.

The selected session opens `/api/sessions/:id/events?sinceSeq=...&maxPayload=2048`.
A cold open reads `events/page?tail=200`; reconnect verifies an overlap through
`events/page?after=...&limit=500`, following `after`. `hasMore` means older
history exists and is not a forward-page cursor. More than two overlap pages
or an explicit `resync` discards the old window and reseeds from a fresh tail.
The server subscribes to live events before replaying; the client reads the
REST overlap after successful SSE headers and before draining those frames.

Every connect/foreground recovery rereads session detail, PENDING approvals,
queued turns, background jobs and pending evidence decisions. Session-linked
task owner confirmation and project acceptance decisions/confirmation,
project state, open items and promotion are also read. Relevant transient or
terminal events trigger a reread. A 30-second foreground refresh catches
deadline changes without a push. Failures retain stale cards with `fresh=false`;
consumers must require freshness before offering actions. These cards are not
deserialized from disk as actionable state.

The SSE transport parses fragmented UTF-8, BOM, CR/LF/CRLF, multiline data,
comments and IDs. Unterminated EOF frames are discarded, and frames are bounded
at 4 MiB. Credentials are headers only, with `X-Orbit-Client: android/<version>`;
redirects and implicit transport retries are disabled. AuthSession owns both
streams and REST requests, including their shared refresh flight and epoch.
A delayed stream retry-401 cannot revoke newer credentials. Errors originating
from callbacks after headers are not treated as an authentication handshake.

## Transcript and persisted frontier

`Transcript.events` retains raw durable payloads, sorted and deduplicated by
sequence, in a 2,000-event window. Unknown event types remain available to
future renderers. Live-only types do not advance a cursor even if they carry a
positive sequence. The terminal `9007199254740991` sentinel also never advances
it. Text/thinking drafts are keyed by parent tool; tool output uses monotonic
whole `snapshotSeq` snapshots, including empty snapshots. Final assistant,
thinking, tool result and terminal events retire their corresponding previews.
Out-of-order old history cannot erase the current text draft.

`maxSeq` is the visible high-water mark. `resumeSeq` is a conservative frontier
proven by REST pages, not the maximum live sequence. Server sequences can have
gaps, so a live high-water cannot prove that an earlier delayed durable event
was received. Replaying an overlap after process death fills that gap and
deduplicates events already cached. On every connection, clear live drafts
before accepting the server's full current prefix; appending to a previous
connection's draft would duplicate text on mid-turn entry.

`RealtimeCache` uses A03's account/server-scoped `DataKind.CACHE` key
`realtime-v1`. One atomic record couples durable events with their cursor,
directory and last selected session. It retains up to eight sessions and
8 MiB, evicting old session windows and then an oversized optional directory.
Live animation and pending authority are excluded. Writes coalesce for 100 ms;
death before a write is recovered by the earlier persisted cursor. Corrupt,
unsupported-schema or inconsistent records fall back to a cold load.
Cache reads work without connectivity. Logout/switch uses A03's purge and
handle checks; old callbacks and writes cannot populate a new account.

## Lifecycle and connection policy

The Activity START/STOP counter supports multi-window. A configuration change
gets a 700 ms stop debounce; a real last STOP cancels both streams immediately.
Only a validated default network permits connections. A change of network
identity reconnects even without an intermediate offline callback. No service
or job keeps SSE alive in the background.

The transport has a 10-second connect and 45-second byte-read timeout, paired
with the server's 20-second ping. Cancellation closes even a blocked header or
body read. Failed connections use jittered 1/2/4/8/15-second bounded backoff;
clean EOF uses 300 ms. A ping preceding repeated resync does not reset that
failure ramp. REST reconciliation has its own retry state, so a directory
403/network error is visible even while SSE remains connected.

## Reproducible verification

Run the unchanged project gate from the repository root:

```sh
env JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk bash src/android/gradlew -p src/android --no-daemon --max-workers=2 test lintDebug assembleDebug
python3 src/android/scripts/check-test-results.py src/android
```

The core tests exercise real OkHttp against MockWebServer for fragmented SSE,
heartbeat vs silence, cancellation, redirects, mixed REST/SSE refresh and late
401 races. Store tests exercise both streams, REST invalidation, duplicate and
reordered events, persisted process restoration, resync, network identity,
selection and account/server isolation. They do not replace platform tests.

Both Kotlin and OrbitKit consume
`src/shared/src/realtime-recovery.fixture.json`, with independent expected
messages, tools, drafts and high-water. The Swift addition runs alongside
existing `SSEFrameParserTests`, `TranscriptReducerTests`, `ReconnectPolicyTests`
and `TranscriptStoreTests`. Linux Swift tests demonstrate reducer agreement;
they are not an iOS installation or interaction test.

The debug-only `RealtimeFixtureActivity` uses the production auth, transport,
store, lifecycle and Android Keystore/AtomicFile implementations with separate
fixture storage names. It talks only to a loopback synthetic server through
adb reverse. It is excluded from the release manifest and source set.

```sh
bash src/android/scripts/realtime-device-test.sh 36 \
  src/android/app/build/outputs/apk/debug/app-debug.apk /tmp/a04-api36-new
```

The wrapper holds `/var/lib/orbit/android/ui.lock` throughout, uses API36's
shared emulator or starts `orbit-ui-api29` through `orbit-ui-api35`, and restores
network/rotation settings on exit. Supply a new evidence directory each run.
It records APK hash/signature, device build, source SHA/dirty flag, JSON state,
screenshots, request/cursor history, per-process logs and command exit codes.
Probe records live in the app's internal files directory and are read through
`run-as` on debuggable builds. API30 denies shell access to the external app
directory; this is a harness access issue, not an application crash or lost cache.
The normal run requires an actual Wi-Fi default network before starting and
an actual cellular default afterward. The local API29 image produced no Wi-Fi
scan results with emulator 37.2.12 (also after separately trying the legacy
network/driver options). `A04_NETWORK_MODE=cellular-reconnect` permits the other
recovery checks to run there, but explicitly reports `PARTIAL` and a missing
Wi-Fi/cellular-switch check. It never turns that gap into PASS; its zero exit
only means the available assertions completed. Inspect `report.json` as well
as the exit code.

The ten assertions cover initial two-stream state, socket loss/catch-up,
rotation, Wi-Fi/cellular switch, offline stop, offline process/cache restore,
online reconciliation, invalid-window tail reseed, background stop and
foreground reconciliation. Before `am kill`, the driver waits for actual
`onStop`, records process state and verifies the old PID disappears. It then
requires a new PID and offline cached rows before reconnecting. This is a
controlled Android background reclaim request, not `force-stop`, data clear,
or evidence of OEM low-memory policy. Functional screenshots/probe timing do
not establish D09's product UI, release performance, 30-sample percentiles,
physical-device or actual iOS requirements. Final run identities and results
belong in the task evidence bundle, not an inferred PASS from this recipe.

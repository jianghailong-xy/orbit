# OrbitKit

The UI-free core shared by the Orbit **macOS** and **iOS** clients (it started as Phase 0 of
`docs/macos-client-design.md`). Zero third-party dependencies. All protocol logic lives here so the
SwiftUI app layer only has to build views; this package is unit-tested in isolation.

## Build & test

```bash
cd src/macos/OrbitKit
swift build
swift test
```

Builds and tests on **macOS** (the target) and on **Linux** (Swift 6.1 verified) — the pure
parser + reducer + models are platform-agnostic; the URLSession SSE transport and the
Keychain token store are guarded (`#if os(macOS)` / `#if canImport(Security)`) so Linux CI
runs the logic without them.

CI (`.github/workflows/client.yml`, triggered by any change under `src/macos` or `src/ios`) runs
`swift test` on Linux for every push, and again on macOS for pull requests — the macOS pass is what
compiles the `#if os(macOS)` paths the Linux job skips. Mac runners bill at 10×, hence the split.

## Layout

```
Sources/OrbitKit/
  Models/
    Enums.swift          RunStatus · SessionRunState · SessionLifecycleState · RunnerStatus ·
                         PermissionMode · RunEventType · TaskStatus
                         (string values mirror src/shared/src/enums.ts; the decode-tolerant
                          enums fall back to `.unknown` so a newer server never breaks decoding)
    DTOs.swift           User · Login · Session · Agent · Runner · turn/approval/search requests
    ControlEvent.swift   the user-scoped control-plane envelope (mirrors src/shared/src/realtime.ts)
    Agents · Runners · Tasks · Providers · Preferences · Push · Admin · FieldUpdate
    JSONValue.swift      lazily-typed JSON for the heterogeneous RunEvent.payload
    RunEvent.swift       NormalizedRunEvent, tolerant decoding
  Realtime/
    SSEFrameParser.swift pure SSE framing (grapheme-aware newline split — see note below)
    EventStream.swift    EventStreaming protocol · MockEventStream · (macOS) URLSessionEventStream
    ControlStream.swift  the per-user control-plane stream + its silence watchdog
    ReconnectPolicy.swift how a stream attempt ended, and what to do about it — pure, so the
                         reconnect/backoff decisions are testable without a socket
  Transcript/
    Transcript.swift     the render model (bubbles, tool cards, approvals, bg procs)
    TranscriptReducer.swift  the seq/delta/approval/background state machine ← the heart
    TranscriptStore.swift    per-session reducer snapshots, so switching sessions rehydrates
                             instead of replaying from seq 0 (and history survives a restart)
    SessionStore.swift   reconnecting consumer loop (sinceSeq + backoff)
    ToolDisplay.swift    how each tool call renders as a card
  App/                   view-model logic the SwiftUI layer would otherwise hide from tests:
                         session grouping/upsert/status glyphs/headers, composer + approval
                         rules, worktree-bar state, markdown, deep links, notifications,
                         menu-bar summary, recents, skills, task lists, local runner control
  Net/APIClient.swift    async REST, JWT, 401→.unauthorized (+ SessionRefresher, URLSession+Orbit)
  Auth/TokenStore.swift  protocol + InMemory + (macOS) Keychain
Tests/OrbitKitTests/     one suite per source area; TranscriptReducerTests is the original gate
```

**Why `App/` exists:** the SwiftUI views live in `../OrbitApp` and can't be built on Linux, so any
decision worth a test (which sessions count as "needs you", what a status glyph says, whether Send
should queue, which remember-rule a Bash command implies) is pushed down here and covered by
`swift test`. The views above it stay thin enough to be verified by the compile gate plus a look.

## What Phase 0 proved (and one real bug it caught)

`TranscriptReducerTests.testFoldsRecordedSession` folds a representative recorded turn (user →
streamed assistant text → tool call+result → resolved approval → background process → a
**duplicate** durable event → turn end) and asserts the exact resulting items, approvals,
background state, status, and `maxSeq`. This is the de-risk gate for the whole native-console
bet: the streaming/seq/approval logic is correct before any UI exists.

Caught here, not in production: **the Swift CRLF grapheme trap.** `\r\n` is a *single*
Character (extended grapheme cluster) in Swift, so `split(separator: "\n")` silently fails to
break CRLF-terminated SSE lines and drops events. `SSEFrameParser.parse` splits with
`Character.isNewline` (matches LF, CR, and the CRLF cluster) instead. SSE servers commonly
emit CRLF, so this would have been a silent, intermittent event-loss bug.

## Native-vs-browser note

Browser `EventSource` can't set headers, so the web UI passes `?access_token=`. Native
`URLSession` sets the `Authorization` header directly — `URLSessionEventStream` and
`URLSessionControlStream` both do this, keeping the token out of URLs and logs. The server
accepts both.

## Two streams, two replay strategies

- **Data plane** — `GET /sessions/:id/events?sinceSeq=N`, opened for the focused console only.
  Every durable event carries a `seq`; reconnect replays from the high-water mark and the reducer
  dedups by seq. Approval/background nudges arrive with `seq = 0` and deliberately bypass that
  dedup.
- **Control plane** — `GET /events`, one per signed-in client, always on. No `sinceSeq` replay:
  it drives derived state (lists, badges, notifications) that a single REST snapshot can rebuild,
  so reconnect = fetch a snapshot, then follow. Both streams emit a ~20 s `ping`; the transport
  watchdog reconnects on silence rather than trusting the socket to report its own death.

See `docs/realtime-control-plane-stream.md` for the full protocol.

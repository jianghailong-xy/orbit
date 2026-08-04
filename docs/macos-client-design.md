# Orbit — Native macOS Client Design

> Status: **built and shipped** (Phases 0–5 of §11; signed/notarized DMG + Sparkle). Scope
> chosen: a **unified** native app = end-user **console** + local-**runner control**, built in
> **native SwiftUI** (not Tauri/Electron). This document is the design record; it maps the
> existing REST/SSE protocol onto a native client and calls out the hard parts, the phasing,
> and the honest costs.
>
> Two things the original proposal did not anticipate, both now shipped, are recorded elsewhere
> rather than retrofitted into the argument below:
> - The **iOS client** reuses this app's SwiftUI sources in place (Structure B) rather than
>   being a second codebase — see [`src/ios/README.md`](../src/ios/README.md).
> - List state is driven by a **user-level SSE control-plane stream**, not the 4 s polling
>   assumed in §4.1/§5.2 — see
>   [`realtime-control-plane-stream.md`](./realtime-control-plane-stream.md) (polling survives
>   only as the fallback when that stream is down).
>
> §2 (protocol) and §5 (data model) are kept current because clients are written against them;
> the rest reads as of the time the bet was made.

---

## 0. One-paragraph summary

A single signed-and-notarized macOS app with two surfaces fused into one: a **Console**
(chat with agents, drive tasks, approve tool calls — a native re-implementation of the web
`AgentView`) and **Runner Control** (manage the `launchd` runner *on this same Mac* —
status, quota, logs, enrollment). The app talks to the control plane over the **exact same
REST + SSE protocol the web UI uses** (no server changes needed for the console). The
unifying bet: the app runs on the user's Mac, which is *also* (optionally) a runner host —
so it can do what a browser tab fundamentally cannot: drive `launchctl`, read `~/.orbit`,
post **actionable native notifications** for approvals, and live in the **menu bar**. The
hardest engineering is isolated into a UI-free core package (`OrbitKit`): a hand-rolled
**SSE client** and a **transcript reducer** that mirrors the web's streaming/approval/seq
logic. Distribution is **Developer ID + notarization (not the Mac App Store)**, because
managing `launchd` and reading `~/.orbit` is incompatible with the MAS sandbox.

---

## 1. Why native is defensible here (and where it hurts)

The runner-control half *wants* native: directly bootstrapping `com.orbit.runner` via
`launchctl`, tailing `runner.log`, reading `~/.orbit/config.json`, and posting OS
notifications are all clumsy or impossible from a WebView. That justifies the Swift choice
for **that** surface.

The console half is the cost: the web `AgentView` is ~2,500 lines of hard-won streaming /
approval / worktree behavior plus ~4,500 lines of CSS. Rebuilding it natively is months of
work and creates a **second UI to keep at parity with the web forever**. The mitigation,
baked into this design: push *all* protocol logic into `OrbitKit` so only the **views** are
duplicated, and let long-tail surfaces (Skills browser, Admin, Settings detail) **deep-link
into the web** rather than be rebuilt. See §10 (Risks).

---

## 2. What the client talks to (protocol recap)

Everything below already exists and is used by the web UI — the console needs **zero**
server changes.

- **Base:** `https://<instance>/api`, JWT Bearer. The access token's TTL is deployment-set
  (`ACCESS_TOKEN_TTL`, default 7 d) and login also returns a **rotating refresh token**, so a
  401 means "refresh", not "re-login" — only a failed/reused refresh forces the login screen.
  One origin (gateway), `/api/*` proxied to the control plane.
- **Auth:** `POST /auth/login {email,password} → {accessToken,refreshToken,user}`;
  `POST /auth/refresh {refreshToken}` (rotation — re-presenting an already-rotated token revokes
  the whole family); `POST /auth/logout {refreshToken}`; `GET /auth/setup-status → {needsSetup}`;
  `POST /auth/bootstrap`; `POST /auth/change-password`.
- **Real-time:** **SSE only**, two streams — the per-session transcript
  `GET /sessions/:id/events?sinceSeq=N` (data plane, seq replay) and the per-user
  `GET /events` (control plane: lifecycle/status/approval/library nudges, no replay — reconnect
  with a REST snapshot instead). No WebSocket (gateway strips `Upgrade`). Browser EventSource
  needs `?access_token=`; **native `URLSession` should use the `Authorization` header instead**
  (cleaner, keeps the token out of URLs/logs). Both streams emit a ~20 s `ping` frame; clients
  run a byte watchdog and reconnect on silence.
- **Sessions:** `POST /sessions` (create+first prompt), `GET /sessions?view=open|completed|trash`,
  `GET /sessions/:id`, `POST /sessions/:id/turns`, `DELETE /sessions/:id/turns/:turnId`
  (withdraw queued), `POST .../resume|interrupt|end|complete|restore`, `DELETE /sessions/:id`,
  `PATCH /sessions/:id/config` (model/permission/effort mid-session),
  `GET/POST /sessions/:id/diff[/refresh]`, `POST /sessions/:id/merge|commit`.
  Older deployments may expose `view=active|archived|deleted` and `POST .../archive`; OrbitKit
  treats these only as compatibility aliases for Completed semantics.
- **Approvals:** `GET /sessions/:id/approvals?status=PENDING`,
  `POST /sessions/:id/approvals/:approvalId/decision {behavior, message?, answers?, rememberRule?}`.
- **Tasks:** `GET/POST /tasks`, `GET/PATCH/DELETE /tasks/:id`, `POST /tasks/:id/execute`,
  `POST /tasks/batch-execute|batch-stop|batch-assign`, comments, dependencies.
- **Agents:** `GET/POST /agents`, `GET/PATCH/DELETE /agents/:id`, `POST /agents/reorder`.
- **Runners:** `GET /runners`, enrollment tokens, device approve
  (`POST /runners/device/:userCode/approve`), `PATCH /runners/:id`, rotate-token, delete.
- **Attachments:** `POST /attachments?sessionId=…` (multipart, ≤25 MB) → `{id}`; reference
  the id in the turn payload. `GET /attachments/:id` to display.
- **Me/prefs:** `GET /users/me`, `PATCH /users/me/preferences {theme,defaultModel,…}`.

Turn-send rule (important for the composer): **queue-while-running is allowed** — `/turns` is
accepted while `RUNNING` and even while the session is still `PENDING` (unclaimed), and the
message lands as a durable `PENDING` `ConversationTurn` the runner consumes at the next turn
boundary. `clientTurnId` (client UUID) is the idempotency key: a retry/double-click returns the
existing turn. The composer queues optimistically and reconciles on the server `user` event; a
still-queued turn can be listed (`GET /sessions/:id/turns`) and withdrawn
(`DELETE /sessions/:id/turns/:turnId`). **409** is now reserved for "this session can't take a
message at all" (in Trash, ended/cancel-requested, or a worktree merge/commit in flight); there
is no per-run 429 cap. Terminal sessions go through `POST /resume` instead, gated by
`capabilities.canResume` (see
[`session-lifecycle-design.md`](./session-lifecycle-design.md) §4).

---

## 3. App architecture

Two layers. The core is deliberately UI-free so it can be unit-tested and is the only place
protocol logic lives.

```
┌──────────────────────────────── Orbit.app (SwiftUI) ───────────────────────────────┐
│  Scenes:  MainWindow (NavigationSplitView)  ·  MenuBarExtra  ·  Settings  ·         │
│           SessionWindow (detachable)                                                │
│  Native:  UNUserNotificationCenter · global hotkey · Dock badge · orbit:// links    │
│  Views:   ConsoleView · TranscriptView · Composer · ApprovalCards · WorktreeBar ·   │
│           BackgroundTray · TaskList/Detail · RunnerControlPane · LoginView          │
├─────────────────────────────────────────────────────────────────────────────────── │
│                          OrbitKit  (Swift package · no SwiftUI · testable)          │
│  APIClient      async/await REST over URLSession, JWT, 401→re-auth, Codable models  │
│  EventStream    hand-rolled SSE: bytes async-seq → frames → typed RunEvent          │
│  SessionStore   @Observable; folds RunEvent → Transcript via TranscriptReducer      │
│  TranscriptReducer  the seq/delta/approval/background state machine (mirrors web)    │
│  Models         Codable structs mirroring src/shared enums + DTOs + event payloads  │
│  KeychainStore  per-instance {serverURL, token}; never UserDefaults                 │
│  RunnerControl  launchctl + ~/.orbit/config.json + runner.log tail (local runner)   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

State: SwiftUI `@Observable` (Observation framework) stores in `OrbitKit`; views observe.
No external state lib. `URLSession` (one shared, plus per-stream tasks). Concurrency via
Swift structured concurrency (`async`/`await`, `AsyncSequence`, `Task`).

---

## 4. The two hard problems

### 4.1 SSE client (`EventStream`)

`URLSession` has no `EventSource`. Roll a small one over the bytes async-sequence — no third-
party dependency needed:

```swift
// Sketch — the core loop.
func stream(sessionID: String, sinceSeq: Int) -> AsyncThrowingStream<RunEvent, Error> {
    AsyncThrowingStream { continuation in
        let task = Task {
            var url = api.url("/sessions/\(sessionID)/events")
            url.append(queryItems: [.init(name: "sinceSeq", value: String(sinceSeq))])
            var req = URLRequest(url: url)
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")  // native: header, not ?access_token
            req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            req.timeoutInterval = 3600
            let (bytes, resp) = try await session.bytes(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { /* map 401→reauth */ }
            var dataLines: [String] = []
            for try await line in bytes.lines {          // SSE framing: data:… lines, blank = dispatch
                if line.hasPrefix("data:") { dataLines.append(String(line.dropFirst(5)).trimmingPrefix(" ")) }
                else if line.isEmpty, !dataLines.isEmpty {
                    let json = dataLines.joined(separator: "\n"); dataLines.removeAll()
                    if let ev = try? decoder.decode(RunEvent.self, from: Data(json.utf8)) {
                        continuation.yield(ev)
                    }
                }
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
    }
}
```

Robustness rules (get these wrong and transcripts corrupt):
- **Reconnect with the high-water seq.** Track `maxSeq` seen; on drop, reopen with
  `?sinceSeq=maxSeq`. Server replays persisted `RunEvent`s with `seq > sinceSeq`, then goes
  live. **Dedup by seq** as a backstop (a `Set<Int>`).
- **Backoff:** exponential 2s→15s + jitter, cap retries (~12, matching the web), then surface
  "disconnected — retry".
- **Approval/background nudges carry `seq = 0`** (live-only, outside the durable seq space) —
  they must **bypass seq dedup**, and the durable truth for approvals is re-fetched from
  `GET /approvals?status=PENDING` on every (re)connect.
- **Lifecycle:** one live `EventStream` per *foreground/active* session. Backgrounded sessions
  rely on the 4s session-list poll + push notifications, not held-open streams. (`URLSession`
  background sessions are for file transfers and don't fit SSE — use a normal session and own
  the lifecycle.)

### 4.2 Transcript reducer (`TranscriptReducer`)

This is the native port of the web `AgentView` event logic — the single most behavior-dense
piece. It folds the `RunEvent` stream into a render model. Rules, by event type:

| Event | Durable? | Reducer action |
|---|---|---|
| `USER` | yes (seq) | append a user bubble; reconcile the optimistic local bubble by `clientTurnId` |
| `ASSISTANT` | yes (seq) | finalize/replace the in-progress assistant bubble with full text |
| `TEXT_DELTA` | no | append to the **streaming buffer** of the current assistant bubble (animation only) |
| `THINKING` / `THINKING_DELTA` | full=yes / delta=no | same pattern for an extended-thinking block |
| `TOOL_USE` | yes (seq) | open a tool-call card keyed by `toolUseId` |
| `TOOL_RESULT` | yes (seq) | attach result to its card by `toolUseId` |
| `TURN_END` | yes (seq) | flush streaming buffers; mark turn done; session → `AWAITING_INPUT` |
| `APPROVAL_REQUEST` | no (seq 0) | add to pending-approvals; raise a notification if unfocused |
| `APPROVAL_RESOLVED` | no (seq 0) | remove from pending-approvals |
| `BACKGROUND_TASK` | yes | background-tray lifecycle (running→done/failed/killed) |
| `BACKGROUND_OUTPUT` | no | live tail into the tray's output buffer |
| `SYSTEM` / `ERROR` / `INTERRUPT` / `RESULT` | yes | lifecycle markers (banner / interrupt delimiter) |

Render model (sketch):

```swift
enum TranscriptItem: Identifiable {
    case user(UserBubble)            // text, attachments, clientTurnId, pending?
    case assistant(AssistantBubble)  // finalized text + live streamingText buffer
    case thinking(ThinkingBlock)
    case toolCall(ToolCard)          // toolUseId, name, input, result?, status
    case interrupt(seq: Int)         // delimits abandoned output
    case error(ErrorBanner)
}
@Observable final class SessionStore {
    var items: [TranscriptItem] = []
    var pendingApprovals: [Approval] = []
    var background: [BackgroundProc] = []
    var status: RunStatus = .pending
    private var seen = Set<Int>()    // seq dedup
    private var maxSeq = 0
    func apply(_ ev: RunEvent) { /* table above; ignore ev.seq>0 already in `seen` */ }
}
```

This class is **fully unit-testable without UI**: feed a recorded SSE transcript (captured
from a real web session), assert the resulting `items`. That test is the Phase-0 gate.

---

## 5. Data model (Swift, mirroring `src/shared`)

Enum string values are stable (the TS file is explicit that values are kept in sync by
string with the Prisma schema), so these port 1:1. Hand-written now; consider codegen later.

```swift
// Raw runner/process status — what the run is doing, as the runner reports it.
enum RunStatus: String, Codable {
    case pending = "PENDING", running = "RUNNING", succeeded = "SUCCEEDED",
         failed = "FAILED", cancelled = "CANCELLED",
         awaitingInput = "AWAITING_INPUT", interrupted = "INTERRUPTED"
}
// What the UI actually shows. Derived server-side and sent as `runState`; the client re-derives
// it from RunStatus + endReason only for older control planes. Orthogonal to lifecycleState
// (OPEN | COMPLETED | TRASH) — filing a session never changes its run outcome.
// See docs/session-lifecycle-design.md.
enum SessionRunState: String, Codable {
    case queued = "QUEUED", running = "RUNNING", awaitingInput = "AWAITING_INPUT",
         interrupted = "INTERRUPTED", succeeded = "SUCCEEDED", failed = "FAILED",
         ended = "ENDED"          // the single neutral terminal state
}
enum RunnerStatus: String, Codable { case online = "ONLINE", offline = "OFFLINE", draining = "DRAINING" }
enum PermissionMode: String, Codable, CaseIterable {
    case `default` = "default", acceptEdits = "acceptEdits", plan = "plan",
         auto = "auto", dontAsk = "dontAsk", bypass = "bypassPermissions"
}
enum RunEventType: String, Codable {
    case system, assistant, text_delta, thinking, thinking_delta, tool_use, tool_result,
         status, error, result, user, turn_end, interrupt,
         approval_request, approval_resolved, background_task, background_output
    case unknown   // decode fallback — a newer server event must never break the stream
}
// `src/shared` also defines control-plane-internal types (session_created/ended/updated,
// task_changed, agent_changed, task_list_changed, tag_changed, provider_changed). They ride the
// same server-side hub, but are filtered out of every per-session transcript stream and reach
// the client only as a `ControlEvent` on GET /events — so this enum deliberately does NOT list
// them, and would decode one as `.unknown` if it ever appeared.
enum TaskStatus: String, Codable { case open = "OPEN", inProgress = "IN_PROGRESS", done = "DONE", cancelled = "CANCELLED", failed = "FAILED" }

struct RunEvent: Codable {            // matches NormalizedRunEvent
    let seq: Int
    let type: RunEventType
    let ts: String
    let turnId: String?
    let payload: JSONValue            // type-specific; decode lazily per type
}
struct SessionTurnRequest: Codable {  // POST /sessions/:id/turns
    let clientTurnId: String          // UUID — idempotency
    let content: String
    let kind: String                  // "message" | "shell"
    let attachmentIds: [String]?
}
```

`payload` is heterogeneous; use a small `JSONValue` enum (or decode into per-type structs
keyed off `type`). The model list is **not** a static mirror: runners probe the installed CLIs
for their live lists and report them on heartbeat, and configured providers resolve theirs from
the shared preset catalogue (refreshed from models.dev). The native picker therefore reads
whatever the API serves for that agent/provider, with `OrbitKit/App/AgentDefaults.swift` as the
floor for a runner whose probe hasn't landed yet.

---

## 6. The console surface (native re-implementation of `AgentView`)

- **Transcript:** `TranscriptView` over `SessionStore.items`; markdown via **swift-markdown**
  (or Down) + a syntax highlighter; tool cards render input/result; streaming buffers animate.
- **Composer:** text field + model / permission-mode / effort pickers (from §5 defaults),
  `/` slash menu (from `GET` runner-reported skills, agent-scoped), attachment picker
  (`POST /attachments` → ids → turn). Send posts a turn with a fresh `clientTurnId`;
  optimistic bubble reconciled on the `user` event; **respect 409/429** (queue or disable
  while RUNNING per the queue-while-running rule). Interrupt → `POST /interrupt`.
- **Approvals:** three card kinds — tool-permission (allow/deny + "remember rule"),
  AskUserQuestion (multi-choice form → `answers`), ExitPlanMode (plan markdown + approve).
  Decision → `POST /approvals/:id/decision`. Keyboard parity with web (Enter approves,
  ⌘Enter approve+remember).
- **Worktree bar:** branch + diff summary; **Commit** / **Merge to <target>** (split-button
  with target dropdown); file diff drawer (`GET /sessions/:id/diff`, `…/diff/refresh`);
  conflict → "Resolve in session". Disabled mid-turn.
- **Background tray:** from `background_task`/`background_output`; running spinner →
  done/failed/killed; expandable output tail; completion notification.

---

## 7. Runner Control surface (the native-only payoff)

The app detects whether *this* Mac hosts a runner and, if so, manages it directly — no web
UI can do this.

- **Detect:** read `~/.orbit/config.json` (`{server, runnerId, name, …}`) and
  `$ORBIT_HOME` (default `~/.orbit`).
- **Service status / control:** the launchd label is `com.orbit.runner`, plist at
  `~/Library/LaunchAgents/com.orbit.runner.plist`. Status via
  `launchctl print gui/$(id -u)/com.orbit.runner` (or `launchctl list`); start/stop via
  `launchctl bootstrap|bootout gui/$(id -u) <plist>` (modern) or `launchctl load -w|unload`
  (as the runner installer uses); restart-to-self-update via `launchctl kickstart -k`.
- **Logs:** live-tail `$ORBIT_HOME/runner.log` (`FileHandle` + `DispatchSource` file watch)
  in a console pane.
- **Enroll in-app:** since the app is already authenticated as the user, it can complete the
  runner **device-approval** flow natively — start `orbit register` (or replicate
  `POST /api/runner/device/start`), surface the `userCode`, and call
  `POST /api/runners/device/:userCode/approve` directly. One-app enrollment, no browser
  round-trip.
- **Status & quota:** `GET /runners/:id` for online/slots/`planUsage` (same data the web
  runner page shows), plus the *local* truth (process up? log healthy?) the server can't see.
- **Caveat:** subprocess + file access put this **outside the App Store sandbox** (§9).

---

## 8. Native integrations (why a Mac app beats a tab)

- **MenuBarExtra** (macOS 13+): glanceable count of sessions "needing you", runner
  online/offline dot, quick-new-session, recent sessions. Always present.
- **Notifications** (`UNUserNotificationCenter`): approval needed, turn complete, session
  failed, background task done, runner offline. **Actionable** — Allow/Deny buttons on an
  approval notification POST the decision without opening the app; a Reply action sends a turn.
- **Global hotkey:** a Spotlight-style quick-composer to fire a prompt at an agent from
  anywhere.
- **Dock badge:** count of "needs you".
- **Deep links:** `orbit://session/:id`, `orbit://task/:id`, `orbit://runner/:id` — every
  notification / menu item opens straight to the right view; also enables web→app handoff.
- **Detachable session windows:** open a session in its own window (multi-session monitoring).
- **Keychain:** per-instance `{serverURL, token}`.

---

## 9. Auth, multi-instance, distribution

- **Multi-instance:** self-hosted means the app must accept an instance URL
  (e.g. `https://orbitd.io` or a private one). Store `{serverURL, token, user}` per
  instance in Keychain; allow switching. Login mirrors web: `setup-status` → `/setup` or
  `/login`. On 401 (7-day expiry, no refresh), prompt silent re-login.
- **Distribution: Developer ID + notarization, NOT Mac App Store.** Managing `launchd`,
  spawning `orbit`, and reading `~/.orbit` are incompatible with the MAS sandbox. Ship a
  signed, notarized **universal** (arm64 + x86_64) `.dmg`. Min target **macOS 14** (stable
  `MenuBarExtra`, Observation). Auto-update via **Sparkle** (appcast), hostable on the same
  `/dl` pattern the runner binaries already use. CI does sign + notarize + staple.

---

## 10. Risks & honest tradeoffs

1. **Console rebuild cost (biggest).** ~2,500 lines of `AgentView` behavior + ~4,500 lines
   CSS, re-expressed in SwiftUI, then maintained at parity with the web **forever**.
   *Mitigation:* `OrbitKit` isolates all protocol logic (only views duplicate); **deep-link
   long-tail surfaces** (Skills, Admin, Settings detail, cost dashboard) into the web instead
   of rebuilding them; gate native features behind flags so web can stay ahead.
2. **Parity drift.** Every new web feature needs a Swift twin. *Mitigation:* a shared
   events/DTO contract (§5) as the single source of truth; codegen Swift models from
   `src/shared` if it grows.
3. **SSE/seq correctness.** Native reconnect + dedup must be airtight. *Mitigation:* the
   Phase-0 reducer is unit-tested against recorded transcripts before any UI exists.
4. **Markdown + highlighting + diffs** are non-trivial natively (web gets react-markdown +
   highlight.js for free). Budget real time for `TranscriptView`.
5. **Sandbox vs runner-control** forces Developer-ID (not MAS) distribution — accepted.
6. **Consider the cheaper alternative honestly:** a thin **menu-bar-only** companion (runner
   control + notifications + deep-link to web for the console) delivers ~70% of the daily
   value for ~20% of the effort. If timeline matters more than a fully native console, ship
   that first and grow into the full console — this design's layering makes that path
   incremental, not a throwaway.

---

## 11. Phasing (de-risk hardest-first; each phase has a verify gate)

| Phase | Deliverable | Verify |
|---|---|---|
| **0 · OrbitKit core** | `APIClient` + `Models` + `Keychain` + `EventStream` (SSE) + `TranscriptReducer`, no UI | unit test: feed a recorded SSE transcript, assert `items`/approvals/background match the web render |
| **1 · Read-only console** | login + instance picker, sidebar (Active), open a session, **live transcript** (deltas, tool cards, thinking) | a live session mirrors the web side-by-side |
| **2 · Interactive console** | composer (text/model/permission/effort/slash/attachments), send+queue+interrupt, **3 approval kinds**, worktree bar, background tray | drive a full session natively to parity |
| **3 · Native shell** | MenuBarExtra, actionable notifications, Dock badge, global hotkey, deep links, detachable windows | fire a task, close the window, get pinged to approve from the notification |
| **4 · Runner control** | detect/enroll local runner, `launchctl` start/stop, live log tail, status+quota | install a runner from the app; start/stop reflected in `launchctl list` |
| **5 · Tasks + ship** | task list/detail/create/execute, comments, deps; dark-mode parity; **sign + notarize + Sparkle + DMG** | notarized DMG installs + auto-updates on a clean Mac |

A pragmatic **MVP** is Phases 0–1 + the menu bar from 3 + runner control from 4 (the
native-only value), with the console's send path (Phase 2) and tasks (Phase 5) following.

All six phases shipped; the MVP shortcut was not needed.

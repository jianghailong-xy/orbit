import Foundation
import Observation
import UniformTypeIdentifiers
import Network
import OrbitKit
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

struct PendingAttachment: Identifiable, Equatable, Sendable {
    /// Stable local id, assigned at pick time so the chip renders immediately — before the upload
    /// returns a server id. Used for `ForEach`/remove; the turn is sent with `remoteID`, not this.
    let id: String
    /// The server attachment id, filled once the background upload finishes. A failed upload drops
    /// the chip entirely, so `remoteID == nil` means "still uploading" (see `isUploading`).
    var remoteID: String?
    let filename: String
    let mimeType: String
    let byteCount: Int
    /// A small PNG thumbnail for an inline image, downsampled once at attach time so SwiftUI
    /// isn't re-decoding the full-resolution source on every body pass; nil for a non-image file.
    let previewImageData: Data?

    /// True until the background upload resolves — drives the chip's spinner and makes a send that
    /// lands in this window wait for the bytes (mirrors the web composer's `status === 'uploading'`).
    var isUploading: Bool { remoteID == nil }
}

/// Active "Chat about this" reply: the composer's next send resolves this pending question as a
/// deny+message (claude reads it as in-turn feedback) instead of starting a fresh turn.
struct QuestionReply: Equatable, Sendable {
    let approvalID: String
    let question: String
}

// `LocalStatusCard` lives in OrbitKit (Transcript/TranscriptRows.swift) — the transcript's row
// assembly is unit-tested there and needs it.

// One connection attempt's outcome is OrbitKit's `StreamOutcome`; the wait/stop decision after
// each attempt is the unit-tested `ReconnectPolicy` (see `run()`).

/// Drives one open session: the reconnecting SSE consume loop (folded through the verified
/// `TranscriptReducer`) plus the interactive actions — send/queue/interrupt and tool approvals.
/// The worktree status bar's state + actions live in the owned `WorktreeModel` (`worktree`). All
/// decision logic lives in OrbitKit (ComposerLogic / Approvals); this is the orchestration +
/// UI-facing state.
@MainActor
@Observable
final class ConsoleModel {
    let sessionID: String
    /// The owning agent's id. Seeded at init (always for a draft; when threaded through `focus`
    /// for a live console) and re-adopted from the session payload in `loadContext`; it scopes
    /// project commands/skills and session actions even for a console restored from disk.
    private(set) var agentID: String?
    /// Non-nil when this is a draft (pre-session) console backing the "new session" composer: it
    /// runs no stream, and `send()` calls `createSession` for this agent instead of POSTing a turn
    /// (see `createDraftSession`). A live console leaves this nil.
    private let draftAgent: Agent?
    private(set) var provider = "claude"
    /// Draft only: an explicit provider pick from the new-session hero, as opposed to the agent's
    /// own. Non-nil means the create request carries it AND the pick is remembered on the agent
    /// once the session exists — so the next draft here opens on it without the override.
    private(set) var draftProviderOverride: String?
    /// A provider switch made while this session was ENDED. There is nothing to PATCH then, so it
    /// rides along with the resume that revives it — the route Model/Mode/Effort already take.
    /// Nil unless the user picked one here: the session's own provider must never be re-asserted
    /// from a console whose context has not loaded yet.
    private(set) var pendingResumeProvider: String?
    var isDraft: Bool { draftAgent != nil }
    /// Draft only: fired with the freshly created session so the caller can open its live console.
    var onSessionCreated: ((Session) -> Void)?
    private(set) var state = TranscriptState()
    /// Bumped once per published `state` snapshot. Views that only need "the transcript changed"
    /// (auto-scroll, sticky-header recompute) observe this O(1) counter instead of an
    /// `onChange(of: state.items)` that Equatable-compares the whole item array every publish.
    private(set) var stateRevision = 0
    /// Bumped whenever the LOCAL user sends a message from this console. The transcript observes it
    /// to force a scroll to the live tail on send — even when the user had scrolled up to read
    /// history (the `stateRevision` follow only re-pins while already at the bottom). Web parity:
    /// `onSend` re-pins `atBottom` before the new bubble lands (AgentView.tsx).
    private(set) var localSendTick = 0
    private(set) var connected = false

    // Reconnect-loop state (see `run()`). `reconnectPolicy` decides wait-vs-stop and ramps the
    // backoff (pure OrbitKit, unit-tested); `kickRequested` is set by `reconnectNow()` — the network
    // monitor / app foregrounding — to cut a stalled read or a backoff wait short; `netWasSatisfied`
    // debounces the path monitor so only a genuine down→up transition kicks.
    private var reconnectPolicy = ReconnectPolicy()
    private var kickRequested = false
    private var netWasSatisfied = true

    // The session's lifecycle + action capabilities per the server (REST). The SSE stream can't
    // redeliver every terminal transition, while resume eligibility also depends on runner context
    // and heartbeat freshness. These snapshots let the composer choose /turns vs /resume — or
    // block both — without relying on status alone. nil capabilities preserve old-server behavior.
    private var serverStatus: RunStatus?
    private var serverCapabilities: SessionCapabilities?

    // composer
    var composerText = ""
    var modelID = AgentDefaults.defaultModelID
    /// Async context refreshes may replace only a pristine seed. This explicit revision catches a
    /// user who picks away and then returns to the same model, which a string comparison misses.
    private var modelSelectionRevision = ModelSelectionRevision()
    /// The floor until `loadContext` adopts the session's real posture — the same value the server
    /// would resolve for a session that stores none, so the pill can't flash a mode nobody chose.
    var permissionMode = AgentDefaults.defaultPermissionMode
    /// True once the user picks a Mode themselves. Only an edited pick is remembered as the account
    /// default (web parity — `modeWasEdited`): the untouched seed is the app floor, and writing that
    /// back would erase what Settings actually asked for.
    var permissionModeWasEdited = false
    /// The account's synced `defaultPermissionMode` and its write-back, injected by `ConsoleRegistry`
    /// so a console needn't know about `AppModel`. A closure, not a value: the `user` payload primes
    /// asynchronously, so a console built before it lands must still read the current one.
    @ObservationIgnored var accountDefaultPermissionMode: () -> String? = { nil }
    @ObservationIgnored var rememberDefaultPermissionMode: (String) -> Void = { _ in }
    var effort: Effort = .default
    private(set) var pendingAttachments: [PendingAttachment] = []
    /// The in-flight `attach` uploads, keyed by their chip's local id, so a send that lands while
    /// the bytes are still going up can wait for them instead of leaving them behind. Each upload
    /// clears its own entry when it resolves.
    private var uploadTasks: [String: Task<Void, Never>] = [:]
    /// True while a send is holding for the staged attachments to finish uploading (see `send`).
    /// Keeps the composer's contents put and the send button spinning until the ids land.
    private(set) var waitingForUploads = false
    private(set) var sending = false
    /// True from the moment the user sends a message until the agent's first output for that turn
    /// lands (or the send fails). Bridges the window where the POST has returned but the live
    /// `RUNNING` status hasn't arrived yet, so the tail "working" indicator doesn't blink off in
    /// between — see `showWorkingIndicator` / `clearAwaitingReplyIfSatisfied`.
    private(set) var awaitingReply = false
    /// Set while replying to a pending question via "Chat about this" (see send()).
    private(set) var replyContext: QuestionReply?

    // Owning agent's name + the runner's provider quota, shown in the composer footer;
    // loaded once when the console opens.
    private(set) var agentName: String?
    /// The machine this session runs on. A sign-in failure is fixed on that runner specifically, so
    /// the transcript's sign-in card needs its id to drive the relay (and its name to say whose
    /// credentials expired). Loaded with the footer context.
    private(set) var runnerID: String?
    private(set) var runnerName: String?
    /// What the runner's own engine logins report, verbatim. Kept whole rather than resolved on
    /// arrival so the gauge follows a provider switch made after the fetch — see `planUsage`.
    private(set) var runnerPlanUsage: PlanUsage?
    /// The quota for the credential *this* session spends: the configured provider's own, or the
    /// runner login's for a built-in engine (web parity — see `AgentDefaults.planUsage`).
    var planUsage: PlanUsageSnapshot? {
        AgentDefaults.planUsage(for: provider, runner: runnerPlanUsage,
                                configured: configuredProviders)
    }
    private(set) var modelCatalog: RunnerModelCatalog?
    /// What the session's runner last reported about each engine CLI it can host. A provider
    /// choice is a claim about that machine, so the picker greys out what it says can't run there.
    /// Nil until the runner read lands (and from an older server), which claims nothing.
    private(set) var runnerEngines: [RunnerEngineHealth]?
    /// Whether this session's runner is deployed as root, which withdraws one permission mode from
    /// the composer's Mode menu (`AgentDefaults.isRunnable`). Same nil semantics as the engines
    /// above: not reported claims nothing, so no mode is withdrawn on a guess.
    private(set) var runnerRunsAsRoot: Bool?
    /// Control-plane–configured providers (custom slugs borrowing a built-in runtime) — this
    /// session's provider may be one, so the composer's model menu/pill and the context gauge
    /// merge them in. Loaded with the footer context; left empty by an older server without
    /// the endpoint.
    private(set) var configuredProviders: [ConfiguredProvider] = []
    private var configuredProvidersLoaded = false

    var providerCapabilitiesResolved: Bool {
        AgentDefaults.isBuiltInProvider(provider) || configuredProvidersLoaded
    }

    // `/` command & skill autocomplete (the `+` menu opens it scoped). `slashItems` is the
    // session runner's reported set, narrowed to host-level + this session's agent (see applySlashItems).
    private(set) var slashItems: [SlashCommandInfo] = []
    var slashScope: String?   // nil = both kinds; "command"/"skill" when opened from the + menu

    /// The worktree status bar's own model (detail snapshot + diffs + commit/merge actions) —
    /// see `WorktreeModel`. Wired back to this console for the live status + the status line.
    let worktree: WorktreeModel

    /// The sticky error line above the composer. Errors only — it's about the message you just tried
    /// to send, so it belongs next to the input and stays until the ✕. Fleeting confirmations must
    /// *not* land here: the line is in-flow, so each one reflowed the composer up and back down
    /// mid-typing. They go to the app's toast host instead — see `showTransientStatus`.
    var statusMessage: String?
    /// Sink for a session outcome — the app's toast host, injected by `ConsoleRegistry`.
    @ObservationIgnored var onToast: (ToastRequest) -> Void = { _ in }
    /// Local `/status` results belong in the conversation, not the error/info banner above the
    /// composer. Keep a short in-memory tail, matching the web client; these are intentionally not
    /// persisted because no corresponding runner event exists.
    private(set) var localStatusCards: [LocalStatusCard] = []

    /// Newest persisted events pulled for the initial paint (web parity — `TAIL_PAGE`). See `run()`.
    private static let tailPage = 200
    /// Page size for scroll-up history fetches (web parity — `OLDER_PAGE`). See `loadOlder()`.
    private static let olderPage = 200

    private var reducer = TranscriptReducer()
    private let stream: EventStreaming
    private let api: APIClient
    /// Shared image cache (owned by the registry) — seeded on send so the sent bubble shows its
    /// image instantly, and read by the transcript's `ChatAttachmentImage`.
    let attachments: AttachmentImageStore

    init(sessionID: String, agentID: String? = nil, baseURL: URL, tokenStore: TokenStore,
         attachments: AttachmentImageStore, restoring reducer: TranscriptReducer? = nil) {
        self.sessionID = sessionID
        self.agentID = agentID
        self.draftAgent = nil
        self.attachments = attachments
        let api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        self.api = api
        self.worktree = WorktreeModel(sessionID: sessionID, api: api)
        // Live SSE transport on both macOS and iOS — `URLSessionEventStream` is available on both
        // (see EventStream's `#if os(macOS) || os(iOS)` guard). A draft console never starts its
        // stream, so the value there is inert.
        self.stream = URLSessionEventStream(baseURL: baseURL, token: { tokenStore.token(for: baseURL) })
        if let reducer {
            self.reducer = reducer
            self.state = reducer.state   // render the persisted transcript instantly, before SSE connects
        }
        wireWorktree()
    }

    /// Draft (pre-session) console backing the "new session" composer. There's no session yet, so it
    /// runs no stream; the first `send()` calls `createSession` for `agent` and hands the new session
    /// to `onSessionCreated`, after which the caller opens its live console. The model pill is
    /// seeded from the owning runner's Runtime heartbeat; permission and effort remain agent/account
    /// settings.
    init(draftFor agent: Agent, defaultModel: String,
         configuredProviders: [ConfiguredProvider] = [],
         configuredProvidersLoaded: Bool = false,
         modelCatalog: RunnerModelCatalog? = nil, baseURL: URL, tokenStore: TokenStore,
         attachments: AttachmentImageStore) {
        self.sessionID = ""
        self.agentID = agent.id
        self.draftAgent = agent
        self.attachments = attachments
        let api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        self.api = api
        // Inert for a draft (its guards see the empty sessionID); real work starts once the created
        // session's live console replaces this one.
        self.worktree = WorktreeModel(sessionID: "", api: api)
        // Live SSE transport on both macOS and iOS — `URLSessionEventStream` is available on both
        // (see EventStream's `#if os(macOS) || os(iOS)` guard). A draft console never starts its
        // stream, so the value there is inert.
        self.stream = URLSessionEventStream(baseURL: baseURL, token: { tokenStore.token(for: baseURL) })
        self.agentName = agent.name
        self.provider = agent.defaultProvider
        self.configuredProviders = configuredProviders
        self.configuredProvidersLoaded = configuredProvidersLoaded
        // The parent's cached runner snapshot — the same one `defaultModel` was resolved from. It
        // NAMES that id as well, so seeding it here is what keeps the first frame from rendering a
        // label the catalogue is about to replace: a runtime-led BYOK row falls back to its preset
        // list ("Claude Opus 5") until the catalogue lands and settles on "Opus 5".
        self.modelCatalog = modelCatalog
        self.modelID = defaultModel
        // A new session starts at the app floor (Auto), clamped when this model can't run it —
        // web parity (WorkspaceView's `pickedModeSeed`). Deliberately NOT read off the agent:
        // migration 0094 dropped the workspace's mode column and moved the seed to the account,
        // so the field the wire still carries is always nil — which seeded every draft "Don't Ask".
        let seed = AgentDefaults.defaultPermissionMode
        self.permissionMode = providerCapabilitiesResolved
            ? AgentDefaults.clampPermissionMode(
                seed, for: defaultModel, provider: provider,
                configured: configuredProviders)
            : seed
        // Seed the effort pill from the agent's default too (web parity), so a new session shows —
        // and starts at — the agent's configured effort unless the user overrides it.
        if let ef = agent.effort, let e = Effort(rawValue: ef) {
            self.effort = AgentDefaults.normalizeEffort(e, for: provider)
        }
        wireWorktree()
    }

    /// Hand the worktree sub-model the host context it needs: the live status (its poll cadence), the
    /// console status line (its action failures) and the toast host (its confirmations). Weak — it
    /// must not retain the console it's owned by.
    private func wireWorktree() {
        worktree.isSessionLive = { [weak self] in self?.sessionStatus.isLive ?? false }
        worktree.onOutcome = { [weak self] request in self?.onToast(request) }
    }

    /// Show a fleeting, informational message — the native equivalent of web's `message.success`
    /// toast. It floats in the app's toast host under the nav bar, self-dismissing there; errors set
    /// `statusMessage` directly and stay in the line above the composer until the user's ✕.
    func showTransientStatus(_ msg: String) {
        onToast(ToastRequest(message: msg, tone: .info))
    }

    /// Snapshot the full reducer (state + dedup/cursor internals) for the local store. Restoring
    /// it lets the resumed `?sinceSeq=maxSeq` stream continue verbatim — see `ConsoleRegistry`.
    func snapshotReducer() -> TranscriptReducer { reducer }

    // MARK: live stream

    /// The running `run()` loop, owned here rather than by the view's `.task`, so the registry can
    /// start/stop it from the app's focus STATE instead of relying on SwiftUI to tear a `ConsoleView`
    /// down. That guarantees the SSE connection is dropped the moment a session stops being focused —
    /// even if SwiftUI keeps the off-screen console view cached — so streams can't quietly pile up in
    /// the connection pool.
    private var streamTask: Task<Void, Never>?

    /// The worktree status-bar poll loop, owned here alongside `streamTask` (started/stopped with it
    /// from the app's focus STATE) rather than by `WorktreeBar`'s `.task`. On iPhone the console is a
    /// pushed `NavigationSplitView` detail whose `.task` could stop iterating while the bar was still on
    /// screen — freezing it on "Merging…"/"Committing…" until a nav pop + re-push remounted it and a
    /// fresh fetch landed. Anchoring the poll to focus (exactly as the SSE stream already is) keeps the
    /// runner's merge/commit outcome flowing into the bar without a remount.
    private var worktreePollTask: Task<Void, Never>?

    /// Begin the live SSE loop if it isn't already running. Idempotent (re-focusing the same session
    /// is a no-op) and inert for a draft/session-less console.
    func startStreaming() {
        guard streamTask == nil, !isDraft, !sessionID.isEmpty else { return }
        streamTask = Task { [weak self] in await self?.run() }
        worktreePollTask = Task { [weak self] in await self?.worktree.startPolling() }
    }

    /// Cancel the live SSE loop and drop its connection. The reducer state stays cached, so a later
    /// `startStreaming()` resumes from `maxSeq` (no full replay). Safe when not streaming.
    func stopStreaming() {
        streamTask?.cancel()
        streamTask = nil
        worktreePollTask?.cancel()
        worktreePollTask = nil
    }

    func run() async {
        // Footer context: agent name / plan usage / live config — and, from the same runner read,
        // the `/` catalog. One-shot; concurrent with the stream connect.
        Task { await loadContext() }
        // Durable approvals aren't in the replayed stream (the `approval_request` nudge rides
        // seq 0, live-only) — fetch them once on open so a prompt already pending (e.g. an
        // AskUserQuestion awaiting an answer) surfaces. Decoupled from the stream; cancels with run().
        let approvalsSeed = Task { [weak self] in await self?.refreshApprovals() }
        defer { approvalsSeed.cancel() }
        // Still-PENDING turns likewise have no replayable `user` event until the runner leases them.
        // Fetch the durable queue so a follow-up sent from web is visible when this console opens.
        let queuedTurnsSeed = Task { [weak self] in await self?.refreshQueuedTurns() }
        defer { queuedTurnsSeed.cancel() }

        // Kick a reconnect the moment the network path is restored. This both cuts a pending backoff
        // wait short AND tears down a read left stalled on a silently-dropped socket — the server
        // sends no SSE heartbeat, so a dead connection would otherwise hang on URLSession's long
        // timeout. `noteNetworkPath` debounces to a genuine down→up transition.
        netWasSatisfied = true
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in self?.noteNetworkPath(satisfied: satisfied) }
        }
        monitor.start(queue: DispatchQueue(label: "io.orbitd.console.netpath"))
        defer { monitor.cancel() }

        // Tail-first initial paint (web parity — commit 34f2d97, "open at the latest message
        // first"). Rather than replaying the whole history over SSE — which on a long session is
        // hundreds of KB read byte-by-byte, so the latest reply takes many seconds to surface, or
        // never in practice — fetch just the newest page over HTTP, fold it in, then stream live
        // from its max seq. Cold open only: a restored reducer already carries its transcript and
        // maxSeq, so it skips straight to the SSE resume below (which streams seq > maxSeq).
        let coldOpen = reducer.state.maxSeq == 0
        if coldOpen, !sessionID.isEmpty { await seedTailPage() }
        if Task.isCancelled { return }
        // Seed the "Background processes" tray with the server's authoritative, complete list — every
        // Bash(run_in_background) the session launched, not just the few whose launch sits in the loaded
        // tail window, and the output of agent shells whose live tail was never persisted. Kicked so it
        // doesn't delay the first paint. `force` on a cold open (the tray has no cached seed yet); a warm
        // reopen keeps its cached tray and lets the reconnect throttle in `refreshBackground` decide.
        if !sessionID.isEmpty { Task { [weak self] in await self?.refreshBackground(force: coldOpen) } }

        reconnectPolicy = ReconnectPolicy()
        var isReconnect = false          // the first connect is seeded by `approvalsSeed` above
        while !Task.isCancelled {
            kickRequested = false
            // On a reconnect (foregrounded / network back / dropped stream), re-fetch the durable
            // approvals. A card resolved elsewhere — e.g. answered on the web client — while this
            // socket was suspended won't replay, since its `approval_resolved` rides seq 0 (live-only),
            // so without this the stale card lingers. iOS suspends sockets on background, making this
            // the common path there. Kicked concurrently so it doesn't delay the reconnect.
            if isReconnect {
                Task { [weak self] in await self?.refreshApprovals() }
                Task { [weak self] in await self?.refreshQueuedTurns() }
                // Re-seed the tray too: a background shell launched or finished while this socket was
                // suspended emits no replayable event (its background_output tail is broadcast-only), so
                // the authoritative server list is how those changes surface after a reconnect.
                Task { [weak self] in await self?.refreshBackground() }
            }
            isReconnect = true
            let outcome = await withTaskGroup(of: StreamOutcome.self) { group in
                // The live read, on the main actor (folds into the shared reducer). Ends on a clean
                // close, throws on a drop, or is cancelled by the kick watcher / view teardown.
                group.addTask { @MainActor [self] in
                    do {
                        connected = true
                        for try await ev in stream.events(sessionID: sessionID, sinceSeq: reducer.state.maxSeq) {
                            // The server won't replay a gap this long (see `RunEventType.resync`):
                            // the connection carries this order and nothing else, so hand it to the
                            // loop below before any bookkeeping. Without it the window froze at the
                            // cursor for good — the stream stayed connected, every reconnect asked
                            // from the same unreplayable seq, and the transcript sat hours behind a
                            // session list that kept advancing (it comes from the list query, not
                            // this stream).
                            if ev.type == .resync { return .resync }
                            // A queued turn is durable in conversation_turn but intentionally absent
                            // from run_event until leased. The nudge carries no duplicate payload;
                            // reconcile the authoritative REST list without delaying this stream.
                            if ev.type == .queuedTurnsChanged {
                                Task { [weak self] in await self?.refreshQueuedTurns() }
                                reconnectPolicy.noteHealthy()
                                continue
                            }
                            foldQueuedBackIntoComposer(before: ev)   // salvage queued text before an interrupt drops it
                            reducer.apply(ev)
                            scheduleStatePublish()
                            reconnectPolicy.noteHealthy()   // a healthy connection resets the backoff ramp
                        }
                        return .ended
                    } catch is CancellationError {
                        return .cancelled
                    } catch {
                        return .failed
                    }
                }
                // Kick watcher: when `reconnectNow()` fires (network back / app foregrounded), win the
                // race so the group cancels the read above and the loop reconnects immediately.
                group.addTask { @MainActor [self] in
                    while !Task.isCancelled {
                        if kickRequested { return .kicked }
                        try? await Task.sleep(nanoseconds: 200_000_000)
                    }
                    return .cancelled
                }
                let first = await group.next() ?? .cancelled
                group.cancelAll()
                return first
            }

            connected = false
            // Orchestration side effects stay here; the wait/stop decision (backoff ramp, kick
            // reset, retry-forever) is the unit-tested `ReconnectPolicy`. A clean close can mean
            // the session ended during the drop — that terminal broadcast is never replayed, so
            // refresh the status from REST before reconnecting.
            if outcome == .ended || outcome == .cancelled { publishStateNow() }
            if outcome == .ended { await refreshServerStatus() }
            // Ordered by the server: this window is not a viable place to resume from. Throw it
            // away and re-seed exactly as a cold open does, so the next connect resumes from the
            // fresh page's max seq. A seed that fails leaves the reducer empty, which makes the
            // reconnect cursor-less — and a cursor-less replay is server-capped, so the fallback
            // is still a bounded catch-up rather than the full history.
            if outcome == .resync { await reseedFromTailPage() }
            switch reconnectPolicy.next(after: outcome) {
            case .stop:
                return
            case .reconnect(let ms):
                if ms > 0 { await backoffSleep(ms: ms) }
            }
        }
    }

    /// Fold the newest page of persisted events into an empty window — the tail-first seed, used
    /// both on a cold open and when a `resync` clears the window (see `reseedFromTailPage`).
    ///
    /// Retries a few times before giving up. A transient failure here (common on mobile) used to
    /// fall straight through to the SSE loop with `sinceSeq: 0`, replaying the WHOLE transcript
    /// byte-by-byte — the exact "very slow to sync a long session" path. The `where` clause stops
    /// the loop the instant a page seeds (applyTailPage advances maxSeq); if all attempts fail the
    /// server still caps a cursor-less replay (SSE_REPLAY_CAP), so it degrades gracefully rather
    /// than dumping the full history.
    private func seedTailPage() async {
        for attempt in 0..<3 where reducer.state.maxSeq == 0 {
            if Task.isCancelled { return }
            if let page = try? await api.eventPage(sessionID: sessionID, tail: Self.tailPage) {
                reducer.applyTailPage(page)   // also records the scroll-up window cursor (hasMoreOlder)
                publishStateNow()
            } else if attempt < 2 {
                try? await Task.sleep(nanoseconds: UInt64(300 * (attempt + 1)) * 1_000_000)
            }
        }
    }

    /// Act on the server's `resync`: drop the loaded window and rebuild it from a tail page.
    ///
    /// The cleared state is deliberately NOT published on its own — a seed usually lands in a few
    /// hundred milliseconds, and painting an empty transcript in between would flash the screen
    /// blank on what the user experiences as a plain reconnect. The stale rows stay up until the
    /// fresh page replaces them (or, if every attempt fails, until the capped cursor-less replay
    /// on the next connect does).
    private func reseedFromTailPage() async {
        guard !sessionID.isEmpty else { return }
        reducer.resetForResync()
        await seedTailPage()
    }

    /// Force the live stream to reconnect immediately: abandons a stalled read or a backoff wait and
    /// loops again with the backoff reset. Fed by the network monitor and app foregrounding; a no-op
    /// when the loop isn't running. Idempotent — the flag is cleared at the top of each attempt.
    func reconnectNow() { kickRequested = true }

    /// Path-monitor callback: kick a reconnect only on a genuine down→up transition, so a stable
    /// network (which reports `.satisfied` once at startup) doesn't churn the live connection.
    private func noteNetworkPath(satisfied: Bool) {
        if satisfied && !netWasSatisfied { reconnectNow() }
        netWasSatisfied = satisfied
    }

    /// Backoff sleep that returns early on a reconnect kick or task cancellation, so a restored
    /// connection doesn't wait out the full exponential backoff. Sliced fine enough to feel instant.
    private func backoffSleep(ms: Int) async {
        var remaining = ms
        while remaining > 0, !Task.isCancelled, !kickRequested {
            let slice = min(remaining, 200)
            try? await Task.sleep(nanoseconds: UInt64(slice) * 1_000_000)
            remaining -= slice
        }
    }

    // Coalesce transcript publishes. A busy replay or live stream would otherwise copy the full
    // state and re-render the whole transcript PER event (≈ O(N²) over the session), pegging the
    // main actor — opening a busy session froze the app near 100% CPU. Events still fold into the
    // reducer eagerly; the rendered snapshot is pushed to the view at most ~5×/sec. (Was ~20×/sec:
    // every publish re-lays-out the streaming row and re-runs the List diff, and on iPhone that
    // cadence alone kept the CPU pegged for a whole watched turn — a top battery/heat hotspot.
    // 200ms still reads as live typing.)
    private var publishScheduled = false
    private func scheduleStatePublish() {
        guard !publishScheduled else { return }
        publishScheduled = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard let self else { return }
            self.publishStateNow()
        }
    }
    private func publishStateNow() {
        publishScheduled = false
        stateRevision &+= 1
        state = reducer.state
        clearAwaitingReplyIfSatisfied()
        reconcileReplyContext()
    }

    /// End the send→first-token bridge (`awaitingReply`) once the stream reports the turn `RUNNING`
    /// (the running-status branch of `showWorkingIndicator` takes over from here) or the agent's
    /// output has landed at the tail (the transcript no longer ends on the user's un-answered turn).
    /// A failed send clears it directly in `send()`; this handles the success paths.
    private func clearAwaitingReplyIfSatisfied() {
        guard awaitingReply else { return }
        var tailIsUnansweredUser = false
        if let last = state.items.last, case .user = last { tailIsUnansweredUser = true }
        if state.status == .running || !tailIsUnansweredUser { awaitingReply = false }
    }

    /// Drop the chat-reply context if its question was resolved another way (an option was picked,
    /// or an SSE `approval_resolved` arrived) — mirrors the web clearing replyTo when it leaves.
    private func reconcileReplyContext() {
        if let r = replyContext, !state.pendingApprovals.contains(where: { $0.id == r.approvalID }) {
            replyContext = nil
        }
    }

    // MARK: - scroll-up history paging (web parity: AgentView's loadOlder)

    /// True while an older-history fetch is in flight — the single-flight guard.
    private(set) var loadingOlder = false
    /// One-shot scroll anchor: set on each successful prepend to the id of the row that was the
    /// window's first BEFORE older rows grew above it. The transcript consumes it on the next
    /// `stateRevision` bump and re-pins that row, holding what the user was reading steady (web
    /// keeps `scrollTop` constant in a layout effect; SwiftUI's List needs an explicit scrollTo).
    private var prependAnchorID: String?

    /// Consume the pending prepend anchor (nil when the last publish wasn't a prepend).
    func takePrependAnchor() -> String? {
        defer { prependAnchorID = nil }
        return prependAnchorID
    }

    /// Pull the next older history page and graft it above the loaded window. Triggered by the
    /// transcript's load-earlier row scrolling into view; no-op while a fetch is already in
    /// flight, when the whole history is loaded (`hasMoreOlder` false), or before a window
    /// cursor exists. A failed fetch is silent — scrolling re-triggers it.
    func loadOlder() async {
        guard !loadingOlder, !sessionID.isEmpty,
              state.hasMoreOlder, let before = state.oldestSeq else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        guard let page = try? await api.eventPage(sessionID: sessionID,
                                                  before: before, limit: Self.olderPage) else { return }
        let anchor = reducer.state.items.first?.id
        reducer.prependOlder(page)
        // Re-pin only when rows actually grew above the old first row (id unchanged ⇒ nothing
        // prepended — e.g. the cursor hit the start — and yanking the scroll would be wrong).
        if let anchor, reducer.state.items.first?.id != anchor { prependAnchorID = anchor }
        publishStateNow()
    }

    /// The untrimmed payload of one event, for a tool card whose call/result the server clipped to
    /// a preview (`APIClient.maxEventPayload`). The card asks for this only when the user expands
    /// it, so a big Read output or Write body crosses the network only if someone opens it. nil on
    /// failure — the card keeps showing the preview it already has.
    func fullPayload(seq: Int) async -> JSONValue? {
        guard !sessionID.isEmpty else { return nil }
        return try? await api.eventFull(sessionID: sessionID, seq: seq).payload
    }

    // MARK: composer

    /// The status that drives send decisions: the stream status, upgraded to the server's
    /// terminal status when the stream missed the (un-replayable) terminal transition.
    var sessionStatus: RunStatus { ComposerLogic.reconcileStatus(stream: state.status, server: serverStatus) }

    var availability: SendAvailability {
        isDraft ? .sendNow
                : ComposerLogic.availability(status: sessionStatus, capabilities: serverCapabilities)
    }

    /// Explanation shown at the composer when a newer server says this session cannot accept a
    /// message. Question replies use the approval channel rather than POST /turns, so they remain
    /// available while a run is ending.
    var sendBlockedMessage: String? {
        guard !isDraft, replyContext == nil else { return nil }
        return ComposerLogic.blockedMessage(status: sessionStatus, capabilities: serverCapabilities)
    }

    /// Heartbeat-derived denials can change without the transcript changing. The composer exposes
    /// a small retry affordance for these reasons; send() also refreshes before every terminal
    /// resume attempt so a stale RUNNER_OFFLINE snapshot can never authorize or deny the POST.
    var canRefreshBlockedSend: Bool {
        switch serverCapabilities?.resumeBlockedReason {
        case .ending, .noRunner, .runnerOffline: return true
        default: return false
        }
    }

    /// Non-terminal session → composer config edits apply immediately (see `applyConfig`). A draft
    /// has no session to PATCH, so it's never "live": the picked pills ride along in createSession.
    var isLive: Bool { isDraft ? false : ComposerLogic.isLive(status: sessionStatus) }

    var canSend: Bool {
        guard !sending, !waitingForUploads else { return false }
        guard !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || canSendAttachmentsAlone else { return false }
        if replyContext != nil { return true }   // a question reply always sends (deny+message)
        return availability != .blocked
    }

    /// Whether what's staged can go out with no text at all — web parity (`!!text.trim() ||
    /// readyImages.length > 0`): a screenshot on its own is a perfectly good message, and the
    /// runner builds an image-only user turn for it (no text block). Two cases keep the
    /// text-is-required rule: a draft, because POST /sessions rejects an empty `prompt`, and a
    /// question reply, whose deny+message channel carries text only. `send` also excludes a
    /// bare `!`, which is a shell no-op rather than a message.
    private var canSendAttachmentsAlone: Bool {
        !isDraft && replyContext == nil && !pendingAttachments.isEmpty
    }

    /// Whether to show a "working" row at the transcript tail: the agent owes a response it hasn't
    /// begun to stream. This fills the send→first-token gap where the message page would otherwise
    /// look inert — the native port of web's "Waiting for the agent…" note (AgentView.tsx),
    /// generalized to follow-ups on an existing session. Shown while a turn is in flight — `sending`
    /// covers the POST round-trip, `awaitingReply` bridges to the live `RUNNING` status, and
    /// `state.status == .running` covers the rest — and suppressed the moment the tail already
    /// animates on its own (a streaming assistant/thinking block or a running tool) or an approval
    /// card is pending, since each of those already signals the state.
    var showWorkingIndicator: Bool {
        guard !isDraft else { return false }
        guard sending || awaitingReply || state.status == .running else { return false }
        guard state.pendingApprovals.isEmpty else { return false }
        guard let last = state.items.last else { return true }   // empty transcript → a reply is owed
        switch last {
        case .assistant(let b): return b.isFinalized
        case .thinking(let b):  return b.isFinalized
        case .toolCall(let c):  return c.status != .running
        case .user, .interrupt, .error, .authError, .autoRetry: return true   // the agent still owes a reply
        }
    }

    // What we believe the server's stored config is — set on load, updated after each push.
    // A picker's onChange fires even when loadContext adopts the server's value programmatically;
    // without this the adopted value would echo straight back as a PATCH, and a live PATCH
    // re-spawns claude (see SessionsService.updateConfig). So we only push genuine user edits.
    private var syncedConfig: (model: String, permissionMode: String, effort: String)?

    /// Load the footer context once: the owning agent's name + the runner's plan usage, and
    /// adopt the session's stored model/permission/effort so the pills show its real settings
    /// (matching web — see AgentView's seed effects). This runs for terminal sessions too: a
    /// resumable session's pills seed its next resume, and without it the Mode pill would stick
    /// at the hardcoded `.default` instead of the mode the session actually uses.
    private func loadContext() async {
        guard let s = try? await api.session(sessionID) else { return }
        adoptServerSnapshot(s)
        agentName = s.agent?.name
        // Adopt the owning agent's id too (a console opened by session id may have been created
        // without one), so project commands/skills remain correctly scoped.
        if let aid = s.agent?.id { agentID = aid }
        provider = s.provider ?? "claude"

        // A historical Session.model is authoritative and can be adopted immediately. If the user
        // already touched the picker while the session request was in flight, their explicit value
        // wins and no later context request may replace it.
        if modelSelectionRevision.isPristine {
            modelID = s.model ?? AgentDefaults.defaultModel(for: provider)
        }
        // A stored mode is adopted verbatim; a session with none (task- or MCP-created) resolves
        // exactly as the server will — account default, else the floor. Web parity
        // (`effectivePermissionMode`).
        permissionMode = AgentDefaults.resolvePermissionMode(
            session: s.permissionMode, accountDefault: accountDefaultPermissionMode())
        if let ef = s.effort ?? s.agent?.effort, let e = Effort(rawValue: ef) {
            effort = AgentDefaults.normalizeEffort(e, for: provider)
        } else {
            effort = .default
        }
        let live = ComposerLogic.isLive(status: s.effectiveRunStatus)
        // When the session already stores a model, this is a complete server baseline before the
        // slower optional Runner/provider reads. A manual pick can now PATCH against it safely.
        if live, s.model != nil, modelSelectionRevision.isPristine {
            syncedConfig = (modelID, permissionMode.rawValue, effort.rawValue)
        }

        // Plan usage + Runtime model/default data ride the GET /runners list. A request failure is
        // merely unavailable data and must retain the model already on screen.
        var sessionRunner: Runner?
        var runnerSnapshotLoaded = false
        runnerID = s.assignedRunnerId
        if let rid = s.assignedRunnerId, let rows = try? await api.runners() {
            if let r = rows.first(where: { $0.id == rid }) {
                sessionRunner = r
                runnerSnapshotLoaded = true
                runnerName = r.displayName?.isEmpty == false ? r.displayName : r.name
                runnerPlanUsage = r.planUsage
                modelCatalog = r.modelCatalog
                runnerEngines = r.engines
                runnerRunsAsRoot = r.runsAsRoot
            } else {
                runnerPlanUsage = nil
                modelCatalog = nil
                runnerEngines = nil
                runnerRunsAsRoot = nil
            }
        }
        applySlashItems(from: sessionRunner)
        // Configured providers own a separate model space/default. Best-effort: a transient failure
        // keeps the last good list, and built-in runtimes still resolve from the runner/static data.
        if let providers = try? await api.providers() {
            configuredProviders = providers
            configuredProvidersLoaded = true
        }
        // A stored model the Runtime has since retired is no longer something this session can
        // run — the server drops it at dispatch too — so re-resolve it exactly like a model-less
        // session rather than leaving a dead id on the pill. Mirrors web's livePinnedModel.
        let storedPin = AgentDefaults.livePin(
            s.model, provider: provider, catalog: modelCatalog, configured: configuredProviders,
            runtimeDefaults: sessionRunner?.runtimeDefaultModels)
        if storedPin == nil, modelSelectionRevision.isPristine {
            modelID = AgentDefaults.refreshedDefaultModel(
                currentModel: modelID, for: provider, catalog: modelCatalog,
                configured: configuredProviders,
                runtimeDefaults: sessionRunner?.runtimeDefaultModels,
                runnerSnapshotLoaded: runnerSnapshotLoaded,
                configuredProvidersLoaded: configuredProvidersLoaded)
        }
        if providerCapabilitiesResolved {
            permissionMode = AgentDefaults.clampPermissionMode(
                permissionMode, for: modelID, provider: provider,
                configured: configuredProviders)
        }
        // OpenCode variants are model-defined, so this is the first point where a stored
        // value can be validated against the runner catalog.
        effort = AgentDefaults.normalizedEffort(
            effort, for: provider, model: modelID, catalog: modelCatalog)
        // A LIVE session pushes later pill edits to the server (PATCH /config); record the
        // adopted values so `applyConfig` can distinguish a real user edit from this adopt.
        // A terminal session isn't live, so its pills stay local until the next resume.
        if live, modelSelectionRevision.isPristine {
            syncedConfig = (modelID, permissionMode.rawValue, effort.rawValue)
        }
    }

    /// Adopt a fresh list/detail snapshot too. The app's control-plane-driven list refresh carries
    /// heartbeat-derived capability changes, so an open console needn't keep an older denial.
    func adoptServerSnapshot(_ session: Session?) {
        guard let session, session.id == sessionID else { return }
        serverStatus = session.effectiveRunStatus
        serverCapabilities = session.capabilities
    }

    /// Re-read the authoritative lifecycle + capabilities from REST (lighter than loadContext).
    /// The terminal transition is a live-only SSE broadcast absent from the replayed log, so
    /// the stream alone can leave an ended session looking live; this lets the composer pick
    /// resume over a doomed POST /turns. Capabilities include heartbeat-derived runner availability,
    /// so this is also the retry path after RUNNER_OFFLINE. A transient failure keeps the last value.
    @discardableResult
    private func refreshServerStatus() async -> Bool {
        guard let s = try? await api.session(sessionID) else { return false }
        adoptServerSnapshot(s)
        return true
    }

    func refreshCapabilities() async { _ = await refreshServerStatus() }

    /// Record an explicit picker action separately from the selected string. Async context loads
    /// must never overwrite it, even when the user returns to the same value they started with.
    @discardableResult
    func selectModel(_ model: String) -> Bool {
        modelID = model
        modelSelectionRevision.markUserEdit()
        let clamped = providerCapabilitiesResolved
            ? AgentDefaults.clampPermissionMode(
                permissionMode, for: model, provider: provider,
                configured: configuredProviders)
            : permissionMode
        let changedPermissionMode = clamped != permissionMode
        permissionMode = clamped
        return changedPermissionMode
    }

    /// Where this session could move without changing CLI, for the composer's Provider menu.
    /// Offered on the two routes that actually carry a provider: a live session's config PATCH and
    /// the resume that revives an ended one. A draft picks in the new-session hero instead (which
    /// offers every runtime, not one), and `availability` excludes an ended session that cannot be
    /// revived at all — `canSend` already folds "terminal and not resumable" into `.blocked`. One
    /// entry means there is nowhere to go, and the composer omits the menu entirely — the common
    /// case of a single sign-in and no configured providers.
    var providerSwitchChoices: [ProviderChoice] {
        guard !isDraft, isLive || availability != .blocked else { return [] }
        return SessionProviderChoices.sameRuntime(
            provider,
            in: SessionProviderChoices.choices(configured: configuredProviders,
                                               catalog: modelCatalog, engines: runnerEngines),
            configured: configuredProviders,
            catalog: modelCatalog)
    }

    /// Move an existing session to another provider on the same runtime. The model comes along only
    /// when the new provider offers it (two Anthropic accounts share the runtime's model space; an
    /// endpoint with a list of its own does not), and mode/effort are re-clamped to what that pair
    /// accepts — the same follow-on a model change makes. Live pushes it now; ended holds it for
    /// the resume.
    func selectProvider(_ slug: String) async {
        guard !isDraft, slug != provider else { return }
        // The menu greys these out; refuse here too, so a stale render can't move a session onto
        // a CLI this runner can't start.
        guard providerSwitchChoices.first(where: { $0.slug == slug })?.unavailable == nil else { return }
        let offersCurrent = AgentDefaults
            .models(for: slug, catalog: modelCatalog, configured: configuredProviders)
            .contains { $0.id == modelID }
        let nextModel = offersCurrent
            ? modelID
            : AgentDefaults.defaultModel(for: slug, catalog: modelCatalog,
                                         configured: configuredProviders)
        let nextMode = providerCapabilitiesResolved
            ? AgentDefaults.clampPermissionMode(permissionMode, for: nextModel, provider: slug,
                                                configured: configuredProviders)
            : permissionMode
        let nextEffort = AgentDefaults.normalizedEffort(effort, for: slug, model: nextModel,
                                                        catalog: modelCatalog)
        provider = slug
        if nextModel != modelID {
            modelID = nextModel
            modelSelectionRevision.markUserEdit()
        }
        permissionMode = nextMode
        effort = nextEffort
        guard isLive else {
            pendingResumeProvider = slug
            return
        }
        // Cleared, not left behind: a live switch is already persisted, and a pick still sitting
        // here would silently re-assert itself on some later resume of this same console.
        pendingResumeProvider = nil
        await applyConfig(model: nextModel, permissionMode: nextMode.rawValue,
                          effort: nextEffort.rawValue, provider: slug)
    }

    /// Pick a provider for this draft (the new-session hero). Each provider owns its own model
    /// space, so the model can't survive the switch — it is re-seeded from the incoming provider's
    /// default, and the mode/effort pills are re-clamped to what that provider accepts. The seed is
    /// marked pristine again on purpose: a model chosen for the outgoing provider is not a choice
    /// about this one, and keeping it would pin an id the new provider may not even offer.
    func pickDraftProvider(_ slug: String) {
        guard isDraft, slug != provider else { return }
        draftProviderOverride = slug
        provider = slug
        modelID = AgentDefaults.defaultModel(for: slug, catalog: modelCatalog,
                                             configured: configuredProviders)
        modelSelectionRevision = ModelSelectionRevision()
        if providerCapabilitiesResolved {
            permissionMode = AgentDefaults.clampPermissionMode(
                permissionMode, for: modelID, provider: slug, configured: configuredProviders)
        }
        effort = AgentDefaults.normalizedEffort(effort, for: slug, model: modelID,
                                                catalog: modelCatalog)
    }

    /// Keep an already-constructed draft in sync with AgentsModel's later provider/runner fetch.
    /// SwiftUI preserves the draft's @State across parent updates, so constructor snapshots alone
    /// are insufficient. An unresolved custom slug retains its placeholder seed; once the provider
    /// list is authoritative, a pristine picker adopts the real provider default and capabilities.
    func adoptDraftProviderContext(_ providers: [ConfiguredProvider], loaded: Bool,
                                   defaultModel: String) {
        guard isDraft else { return }
        // Successful provider discovery is last-good state. A slower parent request that is still
        // pending (or failed) must not erase a snapshot this draft already fetched itself.
        if loaded {
            configuredProviders = providers
            configuredProvidersLoaded = true
        }
        if modelSelectionRevision.isPristine,
           AgentDefaults.isBuiltInProvider(provider) || loaded {
            // `defaultModel` is the parent's, computed for the AGENT's provider. Once this draft
            // has been pointed somewhere else, that value belongs to a different model space —
            // resolve the picked provider's own default instead of dragging the agent's back in.
            modelID = draftProviderOverride == nil
                ? defaultModel
                : AgentDefaults.defaultModel(for: provider, catalog: modelCatalog,
                                             configured: configuredProviders)
        }
        if providerCapabilitiesResolved {
            permissionMode = AgentDefaults.clampPermissionMode(
                permissionMode, for: modelID, provider: provider,
                configured: configuredProviders)
        }
    }

    /// A picker change on a LIVE session is pushed to the server immediately (PATCH /config,
    /// like web's configMut); on a terminal/draft session the local value is kept and carried
    /// by the next resume. Pass only the field that changed (effort uses its raw value so
    /// Default sends "" to clear it). No-op when the value equals the synced server config —
    /// that filters the programmatic adopt in `loadContext` from re-spawning the session.
    func applyConfig(model: String? = nil, permissionMode: String? = nil, effort: String? = nil,
                     provider: String? = nil) async {
        guard isLive else { return }
        // A provider only ever arrives from an explicit pick — `loadContext`'s adopt never sets one
        // — so it needs no comparison against the synced pair to prove it isn't an echo.
        let changed = provider != nil
            || (model.map { $0 != syncedConfig?.model } ?? false)
            || (permissionMode.map { $0 != syncedConfig?.permissionMode } ?? false)
            || (effort.map { $0 != syncedConfig?.effort } ?? false)
        guard changed else { return }
        do {
            try await api.updateConfig(sessionID: sessionID,
                ConfigUpdateRequest(model: model, permissionMode: permissionMode, effort: effort,
                                    provider: provider))
            let baseline = syncedConfig ?? (model: modelID,
                                             permissionMode: self.permissionMode.rawValue,
                                             effort: self.effort.rawValue)
            syncedConfig = (model ?? baseline.model,
                            permissionMode ?? baseline.permissionMode,
                            effort ?? baseline.effort)
        } catch {
            statusMessage = "Couldn't apply change — \(error)"
        }
    }

    // MARK: `/` autocomplete

    /// The catalog this session's provider can actually invoke. Derived, not filtered at load
    /// time, because the provider is known later than the runner catalog.
    var composerSlashItems: [SlashCommandInfo] {
        ComposerSlash.forProvider(items: slashItems, provider: provider)
    }
    var hasCommands: Bool { composerSlashItems.contains { $0.type == "command" } }
    var hasSkills: Bool { composerSlashItems.contains { $0.type == "skill" } }
    var slashToken: String? { ComposerSlash.token(in: composerText) }
    var slashMatches: [SlashCommandInfo] {
        ComposerSlash.matches(items: composerSlashItems, token: slashToken, scope: slashScope)
    }

    /// Take the commands + skills of the runner this session runs on, scoped to host-level +
    /// this session's agent (web parity — its menu reads the session's runner alone). Slash
    /// assets are per-machine: another runner's can't run here, and a name several machines
    /// report (any skill under a shared `~/.claude`) would otherwise list once per machine.
    /// Fed from the runner read the caller already made; a failure leaves just the local items.
    private func applySlashItems(from runner: Runner?) {
        let all = (runner?.commands ?? []) + (runner?.skills ?? [])
        slashItems = ComposerHostCommand.slashItems + ComposerSlash.scoped(items: all, agentID: agentID)
    }

    /// `+` menu → Command/Skill: pop the menu scoped to one kind by inserting a `/`.
    func openSlash(scope: String) {
        slashScope = scope
        composerText = ComposerSlash.opening(text: composerText)
    }

    /// Replace the active `/token` with `/name `; clears the scope so the next manual `/` shows both.
    func pickSlash(_ name: String) {
        composerText = ComposerSlash.pick(text: composerText, name: name)
        slashScope = nil
    }

    /// `+` menu → Shell: prefix the draft with `!` so send() routes the rest as a raw shell command
    /// run on the runner, bypassing claude. The user types the command after. Mirrors web's insertShell.
    func insertShell() {
        if !composerText.hasPrefix("!") { composerText = "!" + composerText }
    }

    /// `authoritative` is the session's live control-plane run status
    /// (`app.session(id:)?.effectiveRunStatus`), read
    /// by the view at tap time — the same source the Stop button uses. It decides whether a mid-turn
    /// send is labeled "Queued"; nil until the session record loads, where it falls back to the
    /// stream-reconciled status. See `ComposerLogic.willQueue`.
    func send(authoritative: RunStatus? = nil) async {
        guard !sending, !waitingForUploads else { return }
        // A chip is staged the moment an image is picked, while its bytes are still going up (see
        // `attach`). Sending in that window would leave the image behind for good: only chips that
        // already carry a `remoteID` ride along, and the staged list is cleared below either way.
        // So honor the tap and hold until the upload lands. (Web instead disables its send button
        // while `uploading` — the wait costs the user the same time without a button that looks
        // dead.) Everything below reads the composer afterwards, so text typed during the wait
        // still goes out with this send.
        if pendingAttachments.contains(where: \.isUploading) {
            waitingForUploads = true
            await waitForStagedUploads()
            waitingForUploads = false
        }
        // A leading `!` runs the remainder as a raw shell command on the runner, bypassing claude
        // (mirrors the web composer). A bare `!` with nothing after it is a no-op.
        let (text, shell) = ComposerLogic.parseShell(composerText)
        // Empty text still sends when something is staged to carry the message (see
        // `canSendAttachmentsAlone`) — but never as a shell turn: a bare `!` is a no-op that only
        // clears itself, and attachments mean nothing to a raw command (web ignores them there too).
        guard !text.isEmpty || (!shell && canSendAttachmentsAlone) else {
            if shell { composerText = "" }
            return
        }
        if let command = ComposerHostCommand.commandName(in: text) {
            if ComposerHostCommand.isLocal(command) {
                showStatusCommand()
                composerText = ""
                return
            }
            if replyContext == nil, provider != "codex", provider != "opencode" {
                if command.isEmpty {
                    statusMessage = "Pick a slash command before sending"
                    return
                }
                // The catalog is advisory, never a gate — a runner that hasn't reported one
                // (or whose CLI registry is still unlearned) would otherwise have every
                // command rejected, dropping it before it ever reached the queue. An unknown
                // name costs a pass-through at most. Mirrors the web composer's onSend.
                let catalogKnown = composerSlashItems.contains { $0.type != "local" }
                let knownRunnerCommand = composerSlashItems.contains { $0.type != "local" && $0.name == command }
                if catalogKnown, !knownRunnerCommand {
                    showTransientStatus("/\(command) isn't in this runner's catalog — sending anyway")
                }
            }
        }
        if isDraft { await createDraftSession(); return }
        // "Chat about this": resolve the pending question as a deny+message so claude reads the
        // text as in-turn feedback and continues — not a fresh turn. (Mirrors the web reroute.)
        if let reply = replyContext {
            composerText = ""
            replyContext = nil
            await replyToQuestion(approvalID: reply.approvalID, text: text)
            return
        }

        // Resume eligibility depends on context presence and a fresh runner heartbeat. Re-read it
        // immediately before any terminal resume attempt (and when retrying a cached offline denial),
        // then let the server capability — not the old status heuristic — authorize the endpoint.
        let terminalAttempt = ComposerLogic.shouldResume(status: sessionStatus)
        if terminalAttempt || serverCapabilities?.resumeBlockedReason == .runnerOffline {
            let refreshed = await refreshServerStatus()
            // Once a server has supplied capabilities, do not authorize a heartbeat-sensitive
            // resume from an older cached `true` when the required preflight refresh failed.
            if terminalAttempt, !refreshed, serverCapabilities != nil {
                statusMessage = "Couldn't verify whether this session can resume. Check your connection and try again."
                return
            }
        }
        if let message = ComposerLogic.blockedMessage(status: sessionStatus,
                                                      capabilities: serverCapabilities) {
            statusMessage = message
            return
        }
        let clientTurnId = UUID().uuidString
        // What the composer is about to be cleared of. A send that fails for good hands it straight
        // back (see the catch) rather than making the user retype a message they can no longer see.
        // The raw draft, so a shell send comes back with its leading `!`.
        let draft = composerText
        let staged = pendingAttachments
        // Every staged attachment has finished uploading by now (the send waited above), so each
        // carries its server `remoteID`; `compactMap` is belt-and-suspenders against a stray nil.
        let ready = pendingAttachments.compactMap { att in att.remoteID.map { (att, $0) } }
        let attachmentIds = ready.map(\.1)
        // Carry mime/name onto the optimistic bubble so it can render image thumbnails / file chips
        // immediately (the durable `user` event later supplies the authoritative refs).
        let turnAttachments = ready.map { TurnAttachment(id: $0.1, mime: $0.0.mimeType, name: $0.0.filename) }

        // A turn already in flight ⇒ this message waits its turn, so label it "Queued" rather than
        // "Sending…" (web parity). Reads the authoritative control-plane status the view passes in
        // (the Stop button's source), not the stream-reconciled `sessionStatus` — that never reliably
        // reaches `.running` on a cold open of an already-running session. Captured now, before the
        // send revives/advances the status. See `ComposerLogic.willQueue`.
        let willQueue = ComposerLogic.willQueue(authoritative: authoritative, reconciled: sessionStatus)
        // Optimistic bubble; reconciled by the server's `user` event (matched by the turnId
        // tagged below once POST returns — the runner echoes turnId, not clientTurnId).
        reducer.addOptimisticUser(clientTurnId: clientTurnId, text: text, attachments: turnAttachments,
                                  queued: willQueue)
        // Show the tail "working" indicator right away (before the scroll below), and keep it up
        // until the agent's first token — or a send failure — resolves it. `publishStateNow` clears
        // it for a queued send, where the running turn already animates the tail.
        awaitingReply = true
        publishStateNow()   // revision bump → the transcript auto-scrolls the new bubble into view
        localSendTick &+= 1 // …and force that scroll even if the user had scrolled up to read history
        composerText = ""
        pendingAttachments = []

        sending = true
        defer { sending = false }
        // Decide the endpoint once, before any retry: a replay has to be the same request, and the
        // status it reads can move underneath a retry that's waiting out a gateway blip.
        let resuming = ComposerLogic.shouldResume(status: sessionStatus, capabilities: serverCapabilities)
        do {
            let accepted = try await postTurn(resuming: resuming, clientTurnId: clientTurnId,
                                              text: text, shell: shell, attachmentIds: attachmentIds)
            if resuming {
                // The session is revived (back to PENDING/RUNNING); drop the stale terminal
                // snapshot so the stream drives status again and a quick follow-up doesn't
                // re-resume a session that hasn't re-claimed yet.
                serverStatus = nil
                serverCapabilities = nil
            }
            // Tag the optimistic bubble with the server's turnId so the durable `user` event
            // reconciles it instead of appending a duplicate (the runner echoes turnId, not
            // clientTurnId). The POST response always precedes that event — see setOptimisticTurnId.
            if let tid = accepted.turnId {
                // …and with what the server filed it AS. A message sent during a running turn is
                // written into that turn (a steer) rather than queued behind it, and the bubble
                // has to stop saying "Queued" and stop offering a withdraw the server refuses.
                reducer.setOptimisticTurnId(clientTurnId: clientTurnId, turnId: tid,
                                            steer: SteerDelivery.isSteerKind(accepted.kind))
                publishStateNow()
            }
        } catch {
            // Nothing was queued — a POST whose response was merely lost would have been recognized
            // by the replay's idempotent clientTurnId — so take the bubble back down rather than
            // leave a message sitting in the transcript looking delivered…
            reducer.removeOptimisticUser(clientTurnId: clientTurnId)
            awaitingReply = false   // no turn is coming — drop the tail "working" indicator
            publishStateNow()
            // …and hand the draft back: the composer was cleared on send, so this is the only copy
            // left. Anything typed while the retries ran stays, below the returned text.
            composerText = composerText.isEmpty ? draft : draft + "\n" + composerText
            pendingAttachments = staged + pendingAttachments
            statusMessage = ComposerLogic.sendFailureMessage(error)
        }
    }

    /// What a retry after a sign-in failure would re-send: the latest user turn in the transcript.
    /// Empty when the failure landed before any user message — a first run, whose opening prompt was
    /// seeded server-side and never became a transcript item — and the card then offers the sign-in
    /// alone rather than a button that would send nothing.
    var lastUserMessageText: String {
        for item in state.items.reversed() {
            if case .user(let b) = item, !b.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return b.text
            }
        }
        return ""
    }

    /// Re-send that message once the runner is signed back in (web's "Retry — re-send my last
    /// message"). Routed through the composer so the retry obeys the same gating, queueing and
    /// failure handling as anything else sent from here.
    func retryLastMessage() async {
        let text = lastUserMessageText
        guard !text.isEmpty, !sending else { return }
        // Anything the user had typed goes back on top afterwards: send() clears the composer when
        // the message goes out and hands it back when it doesn't, so this is that draft's only copy.
        let draft = composerText
        composerText = text
        await send()
        if !draft.isEmpty {
            composerText = composerText.isEmpty ? draft : draft + "\n" + composerText
        }
    }

    // MARK: auto-retry (the quota / provider-error card)

    /// When the retry armed by a spent quota or a transient provider error fires, or nil when
    /// nothing is armed. Read off the worktree bar's `SessionDetail` snapshot — one GET /sessions/:id
    /// already serves both, and a second poll for the same document would be the same request twice.
    var armedRetryAt: Date? { worktree.detail?.retryAt.flatMap(RelativeTime.parse) }
    /// Attempts already spent on the current outage — what separates "never armed" from "gave up".
    var retryAttempts: Int { worktree.detail?.retryAttempts ?? 0 }

    /// Re-read the armed retry. Called when an auto-retry card appears: the server arms the retry as
    /// the failing turn settles, and a session that just went terminal is exactly the one the
    /// worktree poll stops fetching (see `WorktreeModel.startPolling`), so without this the card
    /// would show the state from before the failure.
    func refreshRetryState() async { await worktree.loadDetail() }

    /// Turn the pending auto-retry off, or put it back at `at`. The server dropped its copy of the
    /// instant when the retry was cancelled, so re-arming carries one the card re-derived from the
    /// same reply the server read it off (`AutoRetryLogic.State.rearmAt`).
    func setAutoRetry(armedAt at: Date?) async {
        do {
            if let at {
                try await api.armAutoRetry(sessionID: sessionID, at: at)
            } else {
                try await api.cancelAutoRetry(sessionID: sessionID)
            }
        } catch {
            statusMessage = "Couldn't change auto-retry — \(error)"
        }
        // Refetch either way: the card renders the server's answer, not the click.
        await worktree.loadDetail()
    }

    /// POST the turn, replaying it through a transient failure — the gateway answering 503 while the
    /// apiserver restarts, a mobile connection dropped mid-request. Safe to replay because the
    /// request carries a `clientTurnId` the server is idempotent on: a retry either queues the
    /// message or is handed back the turn a lost attempt already queued, never a second one.
    private func postTurn(resuming: Bool, clientTurnId: String, text: String, shell: Bool,
                          attachmentIds: [String]) async throws -> TurnAccepted {
        // Built once, for the same reason the endpoint is chosen once: every attempt must send the
        // identical request, and the pills it reads stay editable while a retry waits.
        let resumeRequest = ResumeRequest(clientTurnId: clientTurnId, content: text,
                                          kind: shell ? "shell" : "message",
                                          model: modelID, permissionMode: permissionMode.rawValue,
                                          // Resume config is authoritative. Keep the empty string
                                          // so Default clears a stale server-side model variant.
                                          effort: effort.rawValue,
                                          attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds,
                                          provider: pendingResumeProvider)
        let turnRequest = ComposerLogic.makeTurn(clientTurnId: clientTurnId, text: text,
                                                 shell: shell, attachmentIds: attachmentIds)
        return try await retryingTransientFailures { () async throws -> TurnAccepted in
            if resuming { return try await self.api.resume(sessionID: self.sessionID, resumeRequest) }
            return try await self.api.sendTurn(sessionID: self.sessionID, turnRequest)
        }
    }

    /// Run a send that is safe to replay verbatim, retrying only connection-level failures (see
    /// `ComposerLogic.isRetriableSendFailure`) on a short backoff. Both callers post something the
    /// server dedupes — a turn by its `clientTurnId`, a decision by only applying to a still-PENDING
    /// approval — so a lost response costs a repeat request, never a repeated action.
    private func retryingTransientFailures<T>(_ post: () async throws -> T) async throws -> T {
        var attempt = 0
        while true {
            do {
                let result = try await post()
                if attempt > 0 { statusMessage = nil }   // the retry notice, now moot
                return result
            } catch {
                guard attempt < ComposerLogic.sendRetryDelaysMs.count,
                      ComposerLogic.isRetriableSendFailure(error) else { throw error }
                // Explain the wait — this is otherwise a silent spinner for several seconds.
                // Cleared above on success; replaced by the real reason if the retries run out.
                statusMessage = "Connection problem — retrying…"
                try? await Task.sleep(nanoseconds: ComposerLogic.sendRetryDelaysMs[attempt] * 1_000_000)
                attempt += 1
            }
        }
    }

    private func showStatusCommand() {
        let window: Int? = provider == "opencode" && modelID.isEmpty
            ? nil
            : state.contextWindow ?? AgentDefaults.contextWindow(for: modelID, catalog: modelCatalog,
                                                                 configured: configuredProviders,
                                                                 provider: provider)
        let primary = planUsage?.rows.first
        let rows = ComposerHostCommand.statusRows(ComposerStatusSnapshot(
            surface: "App",
            sessionTitle: isDraft ? nil : "Current session",
            sessionStatus: isDraft ? nil : sessionStatus.rawValue,
            agentName: agentName,
            provider: provider,
            model: modelID,
            permissionMode: permissionMode.rawValue,
            effort: effort.label,
            contextTokens: state.contextTokens,
            contextWindow: window,
            planUsageLabel: primary?.label,
            planUsagePercent: primary?.percent))
        let card = LocalStatusCard(rows: rows, afterItemID: state.items.last?.id)
        localStatusCards = Array((localStatusCards + [card]).suffix(5))
    }

    /// Draft send: create a brand-new session for the agent (mirrors the web composer's create path
    /// when there's no live/resumable selection). A leading `!` seeds a shell first turn; staged
    /// attachments (uploaded session-less) ride along via `attachmentIds`. On success the caller
    /// opens the live console; the pills already carry the agent's seeded config.
    private func createDraftSession() async {
        guard let agent = draftAgent else { return }
        let (text, shell) = ComposerLogic.parseShell(composerText)
        guard !text.isEmpty else {
            if shell { composerText = "" }
            return
        }
        let attachmentIds = pendingAttachments.compactMap(\.remoteID)
        sending = true
        defer { sending = false }
        do {
            let session = try await api.createSession(CreateSessionRequest(
                // Send the raw effort — "" (Default) included:
                // the pill is seeded from the agent's default, so an explicit Default must stick
                // rather than fall back to the agent's effort server-side. Web parity (AgentView).
                // Until a custom provider identity is resolved, this draft's visible model is only
                // a placeholder. Omit it so the server applies the configured provider's own
                // default instead of persisting a guessed Claude model.
                prompt: text, agentId: agent.id,
                // Only an explicit hero pick travels: omitting it lets the server start the
                // session where this project last started, as an untouched draft always did.
                provider: draftProviderOverride,
                model: providerCapabilitiesResolved ? modelID : nil,
                permissionMode: permissionMode.rawValue, effort: effort.rawValue,
                shell: shell ? true : nil,
                attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds))
            composerText = ""
            pendingAttachments = []
            // The pick was this session's binding; nothing to write back. The next draft here
            // opens on it anyway, because the default is read from what the project last ran.
            draftProviderOverride = nil
            // The Mode pick is different: without a write-back it lived on this one session, while
            // the runs nobody starts from a composer — task-launched, MCP-created — keep resolving
            // the ACCOUNT default server-side. Web parity, and best-effort: a failed write costs a
            // remembered default, never a wrong dispatch.
            if permissionModeWasEdited { rememberDefaultPermissionMode(permissionMode.rawValue) }
            onSessionCreated?(session)
        } catch {
            statusMessage = "Couldn't start the session — \(error)"
        }
    }

    /// Draft footer/slash seed (no stream): load the `/` command + skill set for the agent and,
    /// best-effort, the agent's runner plan usage — mirrors the live `run()`.
    func prepareDraft() async {
        // Refresh model context first so a newly reported Runtime default settles before optional
        // slash discovery. The draft already has AgentsModel's cached seed, so failure keeps it.
        var runtimeDefaults: [String: String]?
        var runnerSnapshotLoaded = false
        var agentRunner: Runner?
        if let rid = draftAgent?.runnerId, let rows = try? await api.runners() {
            if let r = rows.first(where: { $0.id == rid }) {
                agentRunner = r
                runnerPlanUsage = r.planUsage
                modelCatalog = r.modelCatalog
                runtimeDefaults = r.runtimeDefaultModels
                runnerSnapshotLoaded = true
                runnerEngines = r.engines
                runnerRunsAsRoot = r.runsAsRoot
            } else {
                runnerPlanUsage = nil
                modelCatalog = nil
                runnerEngines = nil
                runnerRunsAsRoot = nil
            }
        }
        if let providers = try? await api.providers() {
            configuredProviders = providers
            configuredProvidersLoaded = true
        }
        // AgentsModel resolves the seed from its cached runner snapshot so the composer is correct
        // immediately. Re-resolve only while no explicit picker action has ever occurred.
        if draftAgent != nil, modelSelectionRevision.isPristine {
            modelID = AgentDefaults.refreshedDefaultModel(
                currentModel: modelID, for: provider, catalog: modelCatalog,
                configured: configuredProviders, runtimeDefaults: runtimeDefaults,
                runnerSnapshotLoaded: runnerSnapshotLoaded,
                configuredProvidersLoaded: configuredProvidersLoaded)
        }
        if providerCapabilitiesResolved {
            permissionMode = AgentDefaults.clampPermissionMode(
                permissionMode, for: modelID, provider: provider,
                configured: configuredProviders)
        }
        applySlashItems(from: agentRunner)
        // OpenCode variants are model-defined, so this is the first point where a stored
        // value can be validated against the runner catalog.
        effort = AgentDefaults.normalizedEffort(
            effort, for: provider, model: modelID, catalog: modelCatalog)
    }

    func interrupt() async {
        do { try await api.interrupt(sessionID: sessionID) }
        catch { statusMessage = "Interrupt failed" }
    }

    /// Withdraw a message still waiting behind the in-flight turn (the queued bubble's Cancel button,
    /// web parity). Removes it from the local queue optimistically for instant feedback, then issues
    /// the server DELETE. Gated in the UI on a known `turnId` (the DELETE needs it); if the runner has
    /// already leased the message the server rejects the withdraw (409) and its durable `user` event
    /// lands it in the transcript as usual — so a lost race is a no-op, not an error.
    func cancelQueued(_ bubble: UserBubble) async {
        guard let turnId = bubble.turnId else { return }
        reducer.removeQueued(id: bubble.id)
        publishStateNow()
        do {
            try await api.withdrawTurn(sessionID: sessionID, turnId: turnId)
            // Withdrawing shouldn't silently eat what the user typed (interrupt parity): fold the
            // message back into the composer so it can be edited and resent. Only once the DELETE
            // succeeds — a rejected withdraw means the runner already leased it, so it lands in the
            // transcript and restoring would duplicate it. Unlike Stop (offered only with an empty
            // composer), Cancel is reachable mid-draft, so an in-progress draft always wins.
            // Attachments aren't rehydrated (the composer needs their bytes), matching interrupt.
            let body = bubble.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !body.isEmpty, composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                composerText = body
            }
        } catch {
            showTransientStatus("This message is already being processed and can't be withdrawn")
        }
    }

    /// An interrupt drops the still-queued (not-yet-leased) follow-ups server-side, and the reducer
    /// clears them locally to match (web parity). Rather than silently lose what the user typed, fold
    /// that queued text back into the composer so it can be edited and resent. Called just before the
    /// reducer applies the interrupt event, while `state.queued` is still populated.
    ///
    /// Only fires when the composer is idle: unlike web — where Stop is offered only with an empty
    /// composer — an interrupt event can also arrive from another client, so it must never clobber a
    /// draft being typed here. Queued images aren't rehydrated (the composer needs their bytes), so
    /// they're dropped as before; the text is what's costly to lose.
    private func foldQueuedBackIntoComposer(before ev: RunEvent) {
        guard case .interrupt = ev.type, !reducer.state.queued.isEmpty,
              composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let restored = reducer.state.queued
            .map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
        guard !restored.isEmpty else { return }
        composerText = restored
    }

    /// `+` menu → Attach image / Upload file: read a picked file, enforce the size cap (web
    /// parity), and upload it via the existing attachment path.
    func attachFile(url: URL) async {
        guard let data = try? Data(contentsOf: url) else {
            statusMessage = "Couldn't read \(url.lastPathComponent)"
            return
        }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
        if let reason = Attachments.rejectReason(mimeType: mime, byteCount: data.count) {
            statusMessage = reason
            return
        }
        attach(filename: url.lastPathComponent, mimeType: mime, data: data)
    }

    /// Clipboard ⌘V of an image (e.g. a screenshot): the view normalizes it to PNG, then this
    /// enforces the inline-image cap and uploads via the shared path. Mirrors the web composer's
    /// `onPaste` handler, which swallows the paste only when it carries image data.
    func attachPastedImage(pngData: Data) async {
        if let reason = Attachments.rejectReason(mimeType: "image/png", byteCount: pngData.count) {
            statusMessage = reason
            return
        }
        attach(filename: "pasted-image.png", mimeType: "image/png", data: pngData)
    }

    /// Stage an attachment optimistically: the chip (with an inline-image thumbnail) appears
    /// immediately, and the byte upload runs in the background so a slow network never hides the
    /// staged image or blocks the next pick. When the upload resolves the chip gets its server
    /// `remoteID` (and the full-resolution bytes are seeded so the sent bubble needs no re-fetch);
    /// a failure drops the chip. Mirrors the web composer's `addImage`, which stages a local
    /// preview first, then swaps in the id — and is why this returns without awaiting the upload.
    func attach(filename: String, mimeType: String, data: Data) {
        let uid = UUID().uuidString
        let isImage = Attachments.isInlineImage(mimeType: mimeType)
        // Inline images carry a downsampled thumbnail for the composer chip; other files show as a
        // name + size chip instead (web parity). Downsampled once here, not on every body pass.
        let preview = isImage ? composerThumbnail(from: data) : nil
        pendingAttachments.append(PendingAttachment(id: uid, remoteID: nil, filename: filename,
                                                    mimeType: mimeType, byteCount: data.count,
                                                    previewImageData: preview))
        uploadTasks[uid] = Task {
            defer { uploadTasks[uid] = nil }
            do {
                // A draft has no session yet — upload session-less; createSession links the ids later.
                let id = try await api.uploadAttachment(sessionID: isDraft ? nil : sessionID,
                                                        filename: filename, mimeType: mimeType, data: data)
                // The user may have removed the chip mid-upload — only reconcile if it's still staged.
                guard let idx = pendingAttachments.firstIndex(where: { $0.id == uid }) else { return }
                if isImage { attachments.seed(id, data: data) }
                pendingAttachments[idx].remoteID = id
            } catch {
                pendingAttachments.removeAll { $0.id == uid }
                statusMessage = "Upload failed — \(filename)"
            }
        }
    }

    /// Wait out the uploads behind the currently staged chips — what `send` holds on so a message
    /// picked up mid-upload still carries its attachments. Every upload resolves one way or the
    /// other (success fills the chip's `remoteID`, failure drops the chip and reports it) and clears
    /// its own `uploadTasks` entry, so this always ends; re-reading both collections each pass means
    /// a chip removed while waiting stops holding it up, and one attached during the wait still does.
    private func waitForStagedUploads() async {
        while let task = pendingAttachments.compactMap({ uploadTasks[$0.id] }).first {
            await task.value
        }
    }

    func removeAttachment(_ att: PendingAttachment) {
        pendingAttachments.removeAll { $0.id == att.id }
    }

    // MARK: approvals

    /// Begin a "Chat about this" reply to a pending question: the next composer send resolves it
    /// as a deny+message instead of a fresh turn (see send()). The card stays until then.
    func startChatReply(approvalID: String, question: String) {
        replyContext = QuestionReply(approvalID: approvalID, question: question)
    }

    func cancelChatReply() { replyContext = nil }

    /// Resolve a pending question conversationally (deny + the typed text → claude reads it as
    /// in-turn feedback). Optimistic-removes the card; re-seeds from REST on failure.
    private func replyToQuestion(approvalID: String, text: String) async {
        sending = true
        defer { sending = false }
        reducer.removeApproval(id: approvalID)
        publishStateNow()
        localSendTick &+= 1 // a reply is a send too — pin the transcript to the tail (web parity)
        let req = ApprovalDecisionRequest(behavior: .deny, message: text, answers: nil, rememberRule: nil)
        // Replayed through a gateway blip like any other send — the decision only applies to a
        // still-PENDING approval server-side, so a lost response can't answer the question twice.
        do {
            try await retryingTransientFailures {
                try await self.api.decideApproval(sessionID: self.sessionID,
                                                  approvalID: approvalID, req)
            }
        } catch {
            statusMessage = "Reply failed"
            await refreshApprovals()
        }
    }

    func decide(_ approval: PendingApproval, behavior: ApprovalBehavior,
                answers: [String: [String]]? = nil, remember: Bool = false) async {
        var rule: PermissionRule?
        if remember, behavior == .allow, let input = approval.input {
            rule = Approvals.rememberRule(toolName: approval.toolName ?? "", input: input)
        }
        // Optimistic: drop the card now (the SSE `approval_resolved` echoes this). On failure,
        // re-seed from REST so it reappears rather than silently vanishing.
        reducer.removeApproval(id: approval.id)
        publishStateNow()
        let req = ApprovalDecisionRequest(behavior: behavior, message: nil, answers: answers, rememberRule: rule)
        do { try await api.decideApproval(sessionID: sessionID, approvalID: approval.id, req) }
        catch {
            statusMessage = "Approval failed — \(error)"
            await refreshApprovals()
        }
    }

    /// Fetch durable pending approvals (the REST source of truth) and reconcile them into the
    /// reducer. This both *surfaces* a prompt that predates the stream (or whose seq-0 nudge landed
    /// during a reconnect gap — those nudges aren't replayed) and *clears* a card resolved elsewhere
    /// (e.g. answered on the web client) while this socket was suspended, whose `approval_resolved`
    /// we likewise never received. The `knownBefore` snapshot is captured before the await so a live
    /// nudge that folds in during the fetch isn't mistaken for a stale card and dropped.
    private func refreshApprovals() async {
        let knownBefore = Set(reducer.state.pendingApprovals.map(\.id))
        guard let infos = try? await api.approvals(sessionID: sessionID) else { return }
        reducer.reconcileApprovals(infos.map {
            PendingApproval(id: $0.id, kind: Approvals.kind(toolName: $0.toolName),
                            toolName: $0.toolName, input: $0.input)
        }, knownBefore: knownBefore)
        publishStateNow()
    }

    /// Fetch and reconcile the server's still-PENDING user turns. The generation fence makes a
    /// burst of add/withdraw nudges monotonic: an older, slower response cannot repaint a turn a
    /// newer response already observed as cancelled or leased. `knownBefore` deliberately contains
    /// only turn ids learned from the server; an untagged local POST still in flight survives a
    /// snapshot that raced just ahead of its commit.
    private var queuedTurnsFetchGeneration = 0
    private func refreshQueuedTurns() async {
        queuedTurnsFetchGeneration &+= 1
        let generation = queuedTurnsFetchGeneration
        let knownBefore = Set(reducer.state.queued.compactMap(\.turnId))
        guard let turns = try? await api.queuedTurns(sessionID: sessionID),
              generation == queuedTurnsFetchGeneration else { return }
        reducer.reconcileQueuedTurns(turns, knownBefore: knownBefore)
        publishStateNow()
    }

    /// Wall-clock time of the last successful `/background` fetch, for the reconnect throttle below.
    private var lastBackgroundFetch: Date?

    /// Fetch the session's authoritative background-shell list (GET /sessions/:id/background) and seed
    /// it into the reducer. This surfaces every shell the session launched — including older ones whose
    /// launch has scrolled out of (or never entered) the loaded event window — and recovers the output
    /// of agent shells whose live `background_output` tail is broadcast-only and so never persisted.
    /// `seedBackground` merges live-preservingly, so this is safe to call on open and on every reconnect.
    ///
    /// `/background` scans the session's whole tool-event history (no seq bound), so on a long
    /// web-accumulated session it's the priciest per-open query — and `run()` re-kicks it on EVERY
    /// reconnect, including the frequent clean-end-of-turn ones. So throttle to at most once per 30s: a
    /// real suspension gap (the only reconnect that can change the shell set unobserved) is virtually
    /// always longer than that, while an end-of-turn reconnect is seconds. `force` bypasses the throttle
    /// for a cold-open seed (nothing cached yet). Failures don't stamp the clock, so they re-fetch freely.
    private func refreshBackground(force: Bool = false) async {
        let now = Date()
        if !force, let last = lastBackgroundFetch, now.timeIntervalSince(last) < 30 { return }
        guard let dtos = try? await api.backgroundShells(sessionID: sessionID) else { return }
        lastBackgroundFetch = now
        reducer.seedBackground(dtos.map { $0.asBackgroundProc() })
        publishStateNow()
    }

}

/// Downsample an image to a small PNG for the composer's thumbnail chip. Done once at attach time
/// so SwiftUI isn't decoding the full-resolution source on every body pass — a multi-MB screenshot
/// re-decoded per keystroke would jank typing. Best-effort: nil falls back to a name + size chip.
private func composerThumbnail(from data: Data, maxDimension: CGFloat = 96) -> Data? {
    guard let source = PlatformImage(data: data) else { return nil }
    let size = source.size
    guard size.width > 0, size.height > 0 else { return nil }
    let scale = min(1, maxDimension / max(size.width, size.height))
    let target = CGSize(width: max(1, size.width * scale), height: max(1, size.height * scale))
    #if os(macOS)
    let thumb = NSImage(size: target)
    thumb.lockFocus()
    source.draw(in: NSRect(origin: .zero, size: target),
                from: NSRect(origin: .zero, size: size), operation: .copy, fraction: 1)
    thumb.unlockFocus()
    guard let tiff = thumb.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
    return rep.representation(using: .png, properties: [:])
    #elseif os(iOS)
    let renderer = UIGraphicsImageRenderer(size: target)
    return renderer.pngData { _ in source.draw(in: CGRect(origin: .zero, size: target)) }
    #endif
}

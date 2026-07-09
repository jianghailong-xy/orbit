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
    let id: String
    let filename: String
    let mimeType: String
    let byteCount: Int
    /// A small PNG thumbnail for an inline image, downsampled once at attach time so SwiftUI
    /// isn't re-decoding the full-resolution source on every body pass; nil for a non-image file.
    let previewImageData: Data?
}

/// Active "Chat about this" reply: the composer's next send resolves this pending question as a
/// deny+message (claude reads it as in-turn feedback) instead of starting a fresh turn.
struct QuestionReply: Equatable, Sendable {
    let approvalID: String
    let question: String
}

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
    let agentID: String?
    /// Non-nil when this is a draft (pre-session) console backing the "new session" composer: it
    /// runs no stream, and `send()` calls `createSession` for this agent instead of POSTing a turn
    /// (see `createDraftSession`). A live console leaves this nil.
    private let draftAgent: Agent?
    private(set) var provider = "claude"
    var isDraft: Bool { draftAgent != nil }
    /// Draft only: fired with the freshly created session so the caller can open its live console.
    var onSessionCreated: ((Session) -> Void)?
    private(set) var state = TranscriptState()
    /// Bumped once per published `state` snapshot. Views that only need "the transcript changed"
    /// (auto-scroll, sticky-header recompute) observe this O(1) counter instead of an
    /// `onChange(of: state.items)` that Equatable-compares the whole item array every publish.
    private(set) var stateRevision = 0
    private(set) var connected = false

    // Reconnect-loop state (see `run()`). `reconnectPolicy` decides wait-vs-stop and ramps the
    // backoff (pure OrbitKit, unit-tested); `kickRequested` is set by `reconnectNow()` — the network
    // monitor / app foregrounding — to cut a stalled read or a backoff wait short; `netWasSatisfied`
    // debounces the path monitor so only a genuine down→up transition kicks.
    private var reconnectPolicy = ReconnectPolicy()
    private var kickRequested = false
    private var netWasSatisfied = true

    // The session's lifecycle status per the server (REST). The SSE stream can't redeliver the
    // terminal transition (its event is broadcast live-only, never in the replayed log), so the
    // stream alone leaves an opened/reconnected ended session looking live. This is seeded on
    // open and refreshed on each reconnect; the composer reconciles it with the stream status so
    // a send to a dormant/finished session resumes instead of 409-ing on POST /turns.
    private var serverStatus: RunStatus?

    // composer
    var composerText = ""
    var modelID = AgentDefaults.defaultModelID
    var permissionMode: PermissionMode = .default
    var effort: Effort = .default
    private(set) var pendingAttachments: [PendingAttachment] = []
    private(set) var sending = false
    /// Set while replying to a pending question via "Chat about this" (see send()).
    private(set) var replyContext: QuestionReply?

    // Owning agent's name + the runner's provider quota, shown in the composer footer;
    // loaded once when the console opens.
    private(set) var agentName: String?
    private(set) var planUsage: PlanUsageSnapshot?

    // `/` command & skill autocomplete (the `+` menu opens it scoped). `slashItems` is the
    // runner-reported set already narrowed to host-level + this session's agent (see loadSlashItems).
    private(set) var slashItems: [SlashCommandInfo] = []
    var slashScope: String?   // nil = both kinds; "command"/"skill" when opened from the + menu

    /// The worktree status bar's own model (detail snapshot + diffs + commit/merge actions) —
    /// see `WorktreeModel`. Wired back to this console for the live status + the status line.
    let worktree: WorktreeModel

    var statusMessage: String?

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
    /// to `onSessionCreated`, after which the caller opens its live console. The model/permission
    /// pills are seeded from the agent's saved config — web parity: leaving them at "Default" would
    /// make the server treat that as an explicit override and ignore the agent's configured mode.
    init(draftFor agent: Agent, baseURL: URL, tokenStore: TokenStore, attachments: AttachmentImageStore) {
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
        self.provider = agent.provider ?? "claude"
        // The agent's configured model is authoritative — it may belong to any provider. Clamping
        // it to the Claude list used to seed a Codex draft with claude-opus-4-8, which the runner
        // then ran as `codex -m claude-opus-4-8`.
        self.modelID = agent.model ?? AgentDefaults.defaultModel(for: provider)
        self.permissionMode = PermissionMode(rawValue: agent.permissionMode ?? "dontAsk") ?? .dontAsk
        // Seed the effort pill from the agent's default too (web parity), so a new session shows —
        // and starts at — the agent's configured effort unless the user overrides it.
        if let ef = agent.effort, let e = Effort(rawValue: ef) { self.effort = e }
        wireWorktree()
    }

    /// Hand the worktree sub-model the two bits of host context it needs: the live status (its poll
    /// cadence) and the console status line (its action failures). Weak — it must not retain the
    /// console it's owned by.
    private func wireWorktree() {
        worktree.isSessionLive = { [weak self] in self?.sessionStatus.isLive ?? false }
        worktree.onStatus = { [weak self] msg in self?.statusMessage = msg }
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

    /// Begin the live SSE loop if it isn't already running. Idempotent (re-focusing the same session
    /// is a no-op) and inert for a draft/session-less console.
    func startStreaming() {
        guard streamTask == nil, !isDraft, !sessionID.isEmpty else { return }
        streamTask = Task { [weak self] in await self?.run() }
    }

    /// Cancel the live SSE loop and drop its connection. The reducer state stays cached, so a later
    /// `startStreaming()` resumes from `maxSeq` (no full replay). Safe when not streaming.
    func stopStreaming() {
        streamTask?.cancel()
        streamTask = nil
    }

    func run() async {
        Task { await loadSlashItems() }   // one-shot; concurrent with the stream connect
        Task { await loadContext() }      // footer context: agent name / plan usage / live config
        // Durable approvals aren't in the replayed stream (the `approval_request` nudge rides
        // seq 0, live-only) — fetch them once on open so a prompt already pending (e.g. an
        // AskUserQuestion awaiting an answer) surfaces. Decoupled from the stream; cancels with run().
        let approvalsSeed = Task { [weak self] in await self?.refreshApprovals() }
        defer { approvalsSeed.cancel() }

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
        if reducer.state.maxSeq == 0, !sessionID.isEmpty {
            if let page = try? await api.eventPage(sessionID: sessionID, tail: Self.tailPage) {
                reducer.applyTailPage(page)   // also records the scroll-up window cursor (hasMoreOlder)
                publishStateNow()
            }
        }

        reconnectPolicy = ReconnectPolicy()
        var isReconnect = false          // the first connect is seeded by `approvalsSeed` above
        while !Task.isCancelled {
            kickRequested = false
            // On a reconnect (foregrounded / network back / dropped stream), re-fetch the durable
            // approvals. A card resolved elsewhere — e.g. answered on the web client — while this
            // socket was suspended won't replay, since its `approval_resolved` rides seq 0 (live-only),
            // so without this the stale card lingers. iOS suspends sockets on background, making this
            // the common path there. Kicked concurrently so it doesn't delay the reconnect.
            if isReconnect { Task { [weak self] in await self?.refreshApprovals() } }
            isReconnect = true
            let outcome = await withTaskGroup(of: StreamOutcome.self) { group in
                // The live read, on the main actor (folds into the shared reducer). Ends on a clean
                // close, throws on a drop, or is cancelled by the kick watcher / view teardown.
                group.addTask { @MainActor [self] in
                    do {
                        connected = true
                        for try await ev in stream.events(sessionID: sessionID, sinceSeq: reducer.state.maxSeq) {
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
            switch reconnectPolicy.next(after: outcome) {
            case .stop:
                return
            case .reconnect(let ms):
                if ms > 0 { await backoffSleep(ms: ms) }
            }
        }
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
        reconcileReplyContext()
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

    // MARK: composer

    /// The status that drives send decisions: the stream status, upgraded to the server's
    /// terminal status when the stream missed the (un-replayable) terminal transition.
    var sessionStatus: RunStatus { ComposerLogic.reconcileStatus(stream: state.status, server: serverStatus) }

    var availability: SendAvailability { isDraft ? .sendNow : ComposerLogic.availability(status: sessionStatus) }

    /// Non-terminal session → composer config edits apply immediately (see `applyConfig`). A draft
    /// has no session to PATCH, so it's never "live": the picked pills ride along in createSession.
    var isLive: Bool { isDraft ? false : ComposerLogic.isLive(status: sessionStatus) }

    var canSend: Bool {
        guard !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !sending else { return false }
        if replyContext != nil { return true }   // a question reply always sends (deny+message)
        return availability != .blocked
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
        serverStatus = s.status
        agentName = s.agent?.name
        provider = s.provider ?? s.agent?.provider ?? "claude"
        if let m = s.model { modelID = m }
        // A stored mode is adopted verbatim; a session with no stored mode falls back to
        // `dontAsk` (web's `permissionMode ?? 'dontAsk'`), never the hardcoded `.default`.
        if let pm = s.permissionMode { permissionMode = PermissionMode(rawValue: pm) ?? .default }
        else { permissionMode = .dontAsk }
        if let ef = s.effort, let e = Effort(rawValue: ef) { effort = e }
        // A LIVE session pushes later pill edits to the server (PATCH /config); record the
        // adopted values so `applyConfig` can distinguish a real user edit from this adopt.
        // A terminal session isn't live, so its pills stay local until the next resume.
        if ComposerLogic.isLive(status: s.status) {
            syncedConfig = (modelID, permissionMode.rawValue, effort.rawValue)
        }
        // Plan usage rides the GET /runners list (there's no per-runner detail endpoint —
        // the web reads it the same way), so fetch the list and pick this session's runner.
        if let rid = s.assignedRunnerId,
           let r = (try? await api.runners())?.first(where: { $0.id == rid }) {
            planUsage = r.planUsage?.snapshot(for: provider)
        } else {
            planUsage = nil
        }
    }

    /// Re-read just the authoritative lifecycle status from REST (lighter than loadContext).
    /// The terminal transition is a live-only SSE broadcast absent from the replayed log, so
    /// the stream alone can leave an ended session looking live; this lets the composer pick
    /// resume over a doomed POST /turns. No-op on a transient fetch failure (keeps the last value).
    private func refreshServerStatus() async {
        if let s = try? await api.session(sessionID) { serverStatus = s.status }
    }

    /// A picker change on a LIVE session is pushed to the server immediately (PATCH /config,
    /// like web's configMut); on a terminal/draft session the local value is kept and carried
    /// by the next resume. Pass only the field that changed (effort uses its raw value so
    /// Default sends "" to clear it). No-op when the value equals the synced server config —
    /// that filters the programmatic adopt in `loadContext` from re-spawning the session.
    func applyConfig(model: String? = nil, permissionMode: String? = nil, effort: String? = nil) async {
        guard isLive else { return }
        let changed = (model.map { $0 != syncedConfig?.model } ?? false)
            || (permissionMode.map { $0 != syncedConfig?.permissionMode } ?? false)
            || (effort.map { $0 != syncedConfig?.effort } ?? false)
        guard changed else { return }
        do {
            try await api.updateConfig(sessionID: sessionID,
                ConfigUpdateRequest(model: model, permissionMode: permissionMode, effort: effort))
            if let s = syncedConfig {
                syncedConfig = (model ?? s.model, permissionMode ?? s.permissionMode, effort ?? s.effort)
            }
        } catch {
            statusMessage = "Couldn't apply change — \(error)"
        }
    }

    // MARK: `/` autocomplete

    var hasCommands: Bool { slashItems.contains { $0.type == "command" } }
    var hasSkills: Bool { slashItems.contains { $0.type == "skill" } }
    var slashToken: String? { ComposerSlash.token(in: composerText) }
    var slashMatches: [SlashCommandInfo] {
        ComposerSlash.matches(items: slashItems, token: slashToken, scope: slashScope)
    }

    /// Fold every runner's reported commands + skills, scoped to host-level + this session's
    /// agent (web parity). Best-effort: a failure just leaves the menu empty.
    func loadSlashItems() async {
        guard let runners = try? await api.runners() else { return }
        let all = runners.flatMap { ($0.commands ?? []) + ($0.skills ?? []) }
        slashItems = ComposerSlash.scoped(items: all, agentID: agentID)
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

    func send() async {
        guard !sending else { return }
        if isDraft { await createDraftSession(); return }
        // A leading `!` runs the remainder as a raw shell command on the runner, bypassing claude
        // (mirrors the web composer). A bare `!` with nothing after it is a no-op.
        let (text, shell) = ComposerLogic.parseShell(composerText)
        guard !text.isEmpty else {
            if shell { composerText = "" }
            return
        }
        // "Chat about this": resolve the pending question as a deny+message so claude reads the
        // text as in-turn feedback and continues — not a fresh turn. (Mirrors the web reroute.)
        if let reply = replyContext {
            composerText = ""
            replyContext = nil
            await replyToQuestion(approvalID: reply.approvalID, text: text)
            return
        }
        let clientTurnId = UUID().uuidString
        let attachmentIds = pendingAttachments.map(\.id)
        // Carry mime/name onto the optimistic bubble so it can render image thumbnails / file chips
        // immediately (the durable `user` event later supplies the authoritative refs).
        let turnAttachments = pendingAttachments.map {
            TurnAttachment(id: $0.id, mime: $0.mimeType, name: $0.filename)
        }

        // A turn already in flight ⇒ this message waits its turn, so label it "Queued" rather than
        // "Sending…" (web parity). Captured now, before the send revives/advances the status.
        let willQueue = availability == .queue
        // Optimistic bubble; reconciled by the server's `user` event (matched by the turnId
        // tagged below once POST returns — the runner echoes turnId, not clientTurnId).
        reducer.addOptimisticUser(clientTurnId: clientTurnId, text: text, attachments: turnAttachments,
                                  queued: willQueue)
        publishStateNow()   // revision bump → the transcript auto-scrolls the new bubble into view
        composerText = ""
        pendingAttachments = []

        sending = true
        defer { sending = false }
        do {
            let accepted: TurnAccepted
            if ComposerLogic.shouldResume(status: sessionStatus) {
                accepted = try await api.resume(sessionID: sessionID,
                                         ResumeRequest(clientTurnId: clientTurnId, content: text,
                                                       kind: shell ? "shell" : "message",
                                                       model: modelID, permissionMode: permissionMode.rawValue,
                                                       effort: effort.wire,
                                                       attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds))
                // The session is revived (back to PENDING/RUNNING); drop the stale terminal
                // snapshot so the stream drives status again and a quick follow-up doesn't
                // re-resume a session that hasn't re-claimed yet.
                serverStatus = nil
            } else {
                accepted = try await api.sendTurn(sessionID: sessionID,
                                           ComposerLogic.makeTurn(clientTurnId: clientTurnId, text: text,
                                                                  shell: shell, attachmentIds: attachmentIds))
            }
            // Tag the optimistic bubble with the server's turnId so the durable `user` event
            // reconciles it instead of appending a duplicate (the runner echoes turnId, not
            // clientTurnId). The POST response always precedes that event — see setOptimisticTurnId.
            if let tid = accepted.turnId {
                reducer.setOptimisticTurnId(clientTurnId: clientTurnId, turnId: tid)
                publishStateNow()
            }
        } catch {
            statusMessage = "Send failed — \(error)"
        }
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
        let attachmentIds = pendingAttachments.map(\.id)
        sending = true
        defer { sending = false }
        do {
            let session = try await api.createSession(CreateSessionRequest(
                // Send the raw effort — "" (Default) included — not `.wire` (which omits Default):
                // the pill is seeded from the agent's default, so an explicit Default must stick
                // rather than fall back to the agent's effort server-side. Web parity (AgentView).
                prompt: text, agentId: agent.id, model: modelID,
                permissionMode: permissionMode.rawValue, effort: effort.rawValue,
                shell: shell ? true : nil,
                attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds))
            composerText = ""
            pendingAttachments = []
            onSessionCreated?(session)
        } catch {
            statusMessage = "Couldn't start the session — \(error)"
        }
    }

    /// Draft footer/slash seed (no stream): load the `/` command + skill set for the agent and,
    /// best-effort, the agent's runner plan usage — mirrors the live `run()`.
    func prepareDraft() async {
        await loadSlashItems()
        if let rid = draftAgent?.runnerId,
           let r = (try? await api.runners())?.first(where: { $0.id == rid }) {
            planUsage = r.planUsage?.snapshot(for: provider)
        } else {
            planUsage = nil
        }
    }

    func interrupt() async {
        do { try await api.interrupt(sessionID: sessionID) }
        catch { statusMessage = "Interrupt failed" }
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
        await attach(filename: url.lastPathComponent, mimeType: mime, data: data)
    }

    /// Clipboard ⌘V of an image (e.g. a screenshot): the view normalizes it to PNG, then this
    /// enforces the inline-image cap and uploads via the shared path. Mirrors the web composer's
    /// `onPaste` handler, which swallows the paste only when it carries image data.
    func attachPastedImage(pngData: Data) async {
        if let reason = Attachments.rejectReason(mimeType: "image/png", byteCount: pngData.count) {
            statusMessage = reason
            return
        }
        await attach(filename: "pasted-image.png", mimeType: "image/png", data: pngData)
    }

    func attach(filename: String, mimeType: String, data: Data) async {
        do {
            // A draft has no session yet — upload session-less; createSession links the ids later.
            let id = try await api.uploadAttachment(sessionID: isDraft ? nil : sessionID, filename: filename,
                                                    mimeType: mimeType, data: data)
            // Inline images carry a downsampled thumbnail for the composer chip; other files show
            // as a name + size chip instead (web parity).
            let preview = Attachments.isInlineImage(mimeType: mimeType) ? composerThumbnail(from: data) : nil
            // Seed the shared cache with the full-resolution bytes so the sent bubble renders the
            // image instantly (no fetch round-trip) once the turn is sent.
            if Attachments.isInlineImage(mimeType: mimeType) { attachments.seed(id, data: data) }
            pendingAttachments.append(PendingAttachment(id: id, filename: filename, mimeType: mimeType,
                                                        byteCount: data.count, previewImageData: preview))
        } catch {
            statusMessage = "Upload failed"
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
        let req = ApprovalDecisionRequest(behavior: .deny, message: text, answers: nil, rememberRule: nil)
        do { try await api.decideApproval(sessionID: sessionID, approvalID: approvalID, req) }
        catch {
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
            statusMessage = "Approval failed"
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

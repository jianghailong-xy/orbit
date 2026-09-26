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

/// An armed reply: the composer's next send answers one open question instead of starting a fresh
/// turn, and the card that armed it stays until then.
///
/// Three presses arm it, and they are the three places on screen that would otherwise each need
/// their own text box — a question's "Chat about this", a decline of one of Orbit's own asks, and a
/// confirmation's — all three saying the same words. Whichever armed it, the composer is where a
/// typed; only the door it goes to differs, which is what `target` carries.
struct QuestionReply: Equatable, Sendable {
    enum Target: Equatable, Sendable {
        /// A pending approval, resolved as deny + the typed text (claude reads it as in-turn
        /// feedback and continues).
        case approval(id: String)
        /// The confirmation waiting in this session, sent back with the typed text as its reason.
        case ownerConfirmation(OwnerConfirmationWaiting)
        /// One version of one task's evidence this session may decide, sent back with the typed
        /// text as the reason the next version has to answer.
        case evidenceDecision(EvidenceDecisionRow)
        /// The plan a project has not been started on. The one target that answers no door: the
        /// next send is an ordinary turn, with this plan carried in front of the typed message
        /// because nothing in the session holds it.
        case planChange(context: String)
        /// One of the project's owner items — the escalated exception, the pause — discussed
        /// rather than answered: the next send is an ordinary turn, with the item carried in front
        /// of the typed sentence. What it says reaches the coordinator as its next message, which
        /// is the conversation this card is drawn in.
        case ownerItem(context: String)

        /// Whether the typed sentence IS the message: the two that reach no door carry nothing but
        /// text (an attachment cannot say what should change), so an empty composer leaves the bar
        /// armed rather than sending the context back with no question attached.
        var needsText: Bool {
            switch self {
            case .planChange, .ownerItem: return true
            case .approval, .ownerConfirmation, .evidenceDecision: return false
            }
        }
    }

    let target: Target
    /// What the reply bar says it is about to answer, whole — built by whoever armed it, because
    /// the card knows what it asked and the composer does not.
    let banner: String
    /// What the empty composer asks for while this is armed.
    let placeholder: String
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
    /// The refusal this console's last send met, as structure rather than as the server's sentence.
    /// Nil for every other failure, which still reads its own words out of `statusMessage`.
    private(set) var runConflict: TaskRunHandoff.Conflict?
    /// The run a message went to when it did not stay here (contract §2.1).
    private(set) var handedOverSessionID: String?
    /// What a provider pick standing in the composer will actually do, and when.
    private(set) var providerSwitchNote: String?
    /// The reader's answer to `TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED`, alive for exactly
    /// the one send it authorises. Never stored beyond it: stopping a run is destructive, so every
    /// stop is its own answer to its own question.
    private var confirmedStopSessionID: String?
    /// Whether the send that met `runConflict` was the auto-retry card's own button. It decides
    /// WHERE the answer is shown, which is the difference between an answer and a notification.
    private var runConflictFromRetry = false
    private var sendingAutoRetry = false

    /// The refusal the auto-retry card shows instead of its Retry button.
    ///
    /// Only its OWN press: it is that card's offer to re-send that has stopped being true, and a
    /// typed message's refusal belongs next to the composer it was typed in. Never a question
    /// either — a confirmation is about the provider just picked in the composer, and it is
    /// answered there, where the controls that can answer it live. Web parity: `AutoRetryHelp`.
    var autoRetryTakenOver: TaskRunHandoff.Conflict? {
        guard runConflictFromRetry, runConflict?.kind != .confirmSwitch else { return nil }
        return runConflict
    }

    /// The same refusal when the card above is not the one showing it, so it is read once.
    var composerRunConflict: TaskRunHandoff.Conflict? {
        autoRetryTakenOver == nil ? runConflict : nil
    }
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
    /// The follow-up filed by the most recent "stop and send this instead", until the interrupt it
    /// travelled with lands. See `foldQueuedBackIntoComposer`, which must leave that one message
    /// alone: it was filed AFTER the interrupt dropped the queue, so it was never dropped.
    private var interruptFollowUpClientTurnId: String?

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
    /// Account preferences can arrive after a restored-token launch has already presented the
    /// draft. They may refine the legacy workspace seed only until the user touches the picker;
    /// tracking the edit explicitly also catches re-selecting the value already on screen.
    private var effortSelectionRevision = EffortSelectionRevision()
    /// Whether this session runs in the runtime's fast lane (Claude Code's `/fast`, Codex's
    /// "priority" tier). The composer draws the Speed row only where
    /// `AgentDefaults.fastModeAvailable` says the runtime and model have a lane at all
    /// (web parity — `fastModeUsable`), and the value travels the way effort does: onto a live
    /// session's config, or into the payload of the create/resume that builds the process.
    var fastMode = false
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
    /// runner login's for a built-in engine (web parity — see `AgentDefaults.planUsage`). On an
    /// account pool that is the quota of the account it runs on (`poolAccount`), never the pool's —
    /// and none at all while no account can be named.
    var planUsage: PlanUsageSnapshot? {
        if currentPool != nil { return poolAccount?.member.planUsage }
        return AgentDefaults.planUsage(for: provider, runner: runnerPlanUsage,
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
    /// The user's account pools (GET /providers/pools): the new-session picker's pool rows, and which
    /// of a pool's accounts a session on one is spending. Each also rides in `configuredProviders`
    /// (`ProviderPools.asProviders`), where a pool's name, runtime and models resolve from. Loaded
    /// with them; an older server without the route leaves it empty.
    private(set) var providerPools: [ProviderPool] = []
    /// On an account pool: the member this session's last claim dispatched on. Only the session
    /// detail carries it — the list's rows don't — so only a detail read sets it.
    private(set) var poolMemberProviderID: String?

    /// The account pool this session or draft runs on, if its provider is one.
    var currentPool: ProviderPool? { providerPools.first { $0.slug == provider } }
    /// Which of that pool's accounts it is spending (web parity — `sessionPoolAccount`): the member
    /// the last claim recorded, or — for a draft, or a session no claim has reached yet — the one the
    /// next claim picks. Nil once the recorded member has left the pool: nobody is guessed.
    var poolAccount: PoolAccount? {
        guard let pool = currentPool else { return nil }
        return ProviderPools.sessionAccount(in: pool, memberID: isDraft ? nil : poolMemberProviderID)
    }

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
    /// The "Tasks created here" card's own model — see `CreatedTasksModel`. Polled with the stream.
    let createdTasks: CreatedTasksModel

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
    /// Ceiling on the transcript items kept in memory, and the hysteresis above it before a trim
    /// fires. See `TranscriptReducer.trimOlder` for what a trim moves; this is only the number.
    ///
    /// Read off docs/ios-perf-baseline.md §7, which measured `TranscriptRows.build` — 90–96% of a
    /// streaming turn's main-thread cost — as linear in the item count: 528 items → 1.22 ms,
    /// 1,055 → 2.44 ms, 4,490 → 13.63 ms (x86 harness). At the effective ceiling of 1,200 items
    /// that is ≈ 2.8 ms, about a sixth of the 16.7 ms a 60fps frame has, and — the point — it stops
    /// growing with the session instead of reaching 80% of the budget on a long one. 1,200 items is
    /// also ≈ 10 tail pages of scrollback held locally; past that the load-earlier row fetches, as
    /// it already does today.
    private static let maxWindowItems = 1000
    private static let windowTrimSlack = 200

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
        self.createdTasks = CreatedTasksModel(sessionID: sessionID, api: api)
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
         providerPools: [ProviderPool] = [],
         modelCatalog: RunnerModelCatalog? = nil, accountDefaultEffort: String? = nil,
         baseURL: URL, tokenStore: TokenStore,
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
        self.createdTasks = CreatedTasksModel(sessionID: "", api: api)
        // Live SSE transport on both macOS and iOS — `URLSessionEventStream` is available on both
        // (see EventStream's `#if os(macOS) || os(iOS)` guard). A draft console never starts its
        // stream, so the value there is inert.
        self.stream = URLSessionEventStream(baseURL: baseURL, token: { tokenStore.token(for: baseURL) })
        self.agentName = agent.name
        self.provider = agent.defaultProvider
        // The parent's pools too, so a workspace that runs on one opens on its tile and badge rather
        // than waiting for this draft's own read.
        self.providerPools = providerPools
        self.configuredProviders = configuredProviders + ProviderPools.asProviders(providerPools)
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
                configured: configuredProviders, catalog: modelCatalog)
            : seed
        // The account's last-picked effort is the interactive default. `agent.effort` is the legacy
        // workspace default retained for accounts that have never written that preference. `??` in
        // the resolver deliberately preserves an explicit account "" (Default).
        self.effort = AgentDefaults.newSessionEffort(
            accountDefault: accountDefaultEffort, legacyWorkspaceDefault: agent.effort,
            for: provider, model: defaultModel, catalog: modelCatalog,
            configured: configuredProviders)
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
    /// The "Tasks created here" card's poll, started and stopped with the stream for the same reason.
    private var createdTasksPollTask: Task<Void, Never>?

    /// Begin the live SSE loop if it isn't already running. Idempotent (re-focusing the same session
    /// is a no-op) and inert for a draft/session-less console.
    func startStreaming() {
        guard streamTask == nil, !isDraft, !sessionID.isEmpty else { return }
        streamTask = Task { [weak self] in await self?.run() }
        worktreePollTask = Task { [weak self] in await self?.worktree.startPolling() }
        createdTasksPollTask = Task { [weak self] in await self?.createdTasks.startPolling() }
    }

    /// Cancel the live SSE loop and drop its connection. The reducer state stays cached, so a later
    /// `startStreaming()` resumes from `maxSeq` (no full replay). Safe when not streaming.
    func stopStreaming() {
        // Nobody is reading a console that isn't focused, so it must not stay latched out of the
        // window cap on account of where its transcript happened to be scrolled when it lost focus.
        readingHistory = false
        streamTask?.cancel()
        streamTask = nil
        worktreePollTask?.cancel()
        worktreePollTask = nil
        createdTasksPollTask?.cancel()
        createdTasksPollTask = nil
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
                // And the project's standing questions, for the reason the approvals above are
                // re-read: any of them can be answered in a browser while this phone is asleep, and
                // nothing replays that — a card only learns it went stale by asking again.
                Task { [weak self] in await self?.refreshRulerQuestions(force: true) }
                // The task's own confirmation, on the same argument and one more: a run that
                // reported while this socket was suspended puts a card here, and the read is the
                // only way this window hears about it.
                Task { [weak self] in await self?.refreshOwnerConfirmation(force: true) }
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
        trimWindow()
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

    /// Drop the armed reply if its question was answered another way (an option was picked, an SSE
    /// `approval_resolved` arrived, or the confirmation was settled in a browser) — mirrors the web
    /// clearing replyTo when it leaves. A bar left hanging over a question that is gone is an offer
    /// to answer nothing.
    private func reconcileReplyContext() {
        guard let reply = replyContext else { return }
        switch reply.target {
        case .approval(let id):
            if !state.pendingApprovals.contains(where: { $0.id == id }) { replyContext = nil }
        case .ownerConfirmation(let waiting):
            // `isOpen` and not `answerable`, deliberately: a read that has not come back leaves the
            // standing `unread`, which is "this device cannot say" rather than "there is nothing to
            // answer". Disarming on that would throw away a reason somebody is in the middle of
            // typing because one poll failed.
            let standing = OwnerConfirmations.standing(ownerConfirmation, sessionID: sessionID,
                                                       requestID: waiting.requestId)
            if !OwnerConfirmations.isOpen(standing) { replyContext = nil }
        case .evidenceDecision(let row):
            // The same rule the confirmation's branch follows, read off the version's own standing:
            // a version that has left the read was answered elsewhere or displaced by a newer one,
            // and a bar left hanging over it is an offer to answer nothing. A read that has not come
            // back leaves the standing `unread` — "this device cannot say" rather than "there is
            // nothing to answer" — so a reason somebody is mid-sentence over is not thrown away by
            // one failed poll.
            let standing = evidenceStanding(row.taskId, row.evidenceRevision)
            if !EvidenceDecisions.isOpen(standing) { replyContext = nil }
        case .planChange, .ownerItem:
            // Nothing answers either of these another way: no call is pending on them, so there is
            // no question that can go out from under the reader mid-sentence — and a sentence about
            // an item that has since moved is still one the coordinator can act on. They stay armed
            // until they are sent or the bar is dismissed.
            break
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

    /// True while the reader has scrolled up off the live tail — fed by `TranscriptView`'s
    /// `atBottom`. It gates the window cap, and only that.
    private var readingHistory = false

    /// Tell the console whether the reader is up in the history rather than pinned at the live tail.
    ///
    /// The cap trims the HEAD of the window, which is the mirror image of the prepend jump
    /// `prependAnchorID` exists to compensate for: doing it while the reader is up there would pull
    /// rows out from under them. Pinned at the bottom it is invisible — the view re-pins to the tail
    /// on every publish anyway, and the dropped rows are a thousand items above the viewport.
    ///
    /// Coming back down is also the moment to reclaim what a long scroll-up run paged in: `loadOlder`
    /// grows the window a page at a time, and on an IDLE session the only publishes are that method's
    /// own — which skip the cap by design — so without enforcing it here the window would stay over
    /// the ceiling until the next streamed event. Deliberately not guarded on a change of value: the
    /// transcript re-asserts "pinned at the tail" whenever it appears or switches session, and each
    /// of those is a legitimate place to enforce the cap. A call under the ceiling costs one compare.
    func setReadingHistory(_ reading: Bool) {
        readingHistory = reading
        if !reading, trimWindow() { publishStateNow() }
    }

    /// Enforce `maxWindowItems`, unless the reader is up in the history (see `setReadingHistory`) or
    /// a page is being grafted onto the head right this moment — trimming inside `loadOlder` would
    /// throw away the fetch it just made.
    ///
    /// Gated to the same OS floor as `TranscriptView.canPageOlder`: below it the load-earlier row is
    /// never offered at all, so a trimmed row would be one the reader could never get back.
    @discardableResult
    private func trimWindow() -> Bool {
        guard #available(iOS 18, macOS 15, *) else { return false }
        guard !readingHistory, !loadingOlder else { return false }
        return reducer.trimOlder(keeping: Self.maxWindowItems, slack: Self.windowTrimSlack)
    }

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
    /// runner builds an image-only user turn for it (no text block). That holds for a draft too:
    /// POST /sessions takes attachments alone as the opening message. A question reply keeps the
    /// text-is-required rule, since its deny+message channel carries text only. `send` also
    /// excludes a bare `!`, which is a shell no-op rather than a message.
    private var canSendAttachmentsAlone: Bool {
        replyContext == nil && !pendingAttachments.isEmpty
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
    // without this the adopted value would echo straight back as a PATCH, and every live PATCH
    // costs the session something — a control frame at least, and a re-spawn when the change is
    // one only a new process can carry (see `applyConfig`). So we only push genuine user edits.
    private var syncedConfig: (model: String, permissionMode: String, effort: String,
                               fastMode: Bool)?

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
        // The project this conversation coordinates, if any. It is what decides whether the
        // standing questions that project puts to its owner are asked here at all — an ordinary
        // session has no project and makes none of those reads.
        projectID = s.projectId
        if projectID != nil { Task { [weak self] in await self?.refreshRulerQuestions() } }
        // The task this conversation is a run of, if it is one. That — and not the project — is
        // what decides whether an owner confirmation is asked here, so it is read separately and
        // kicked separately: an OWNER_CONFIRMED task may be filed under no project at all.
        taskID = s.taskId
        ownerReadMoment = runMoment(s)
        if taskID != nil { Task { [weak self] in await self?.refreshOwnerConfirmation() } }
        provider = s.provider ?? "claude"
        poolMemberProviderID = s.poolMemberProviderId

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
        // Fast mode is stored, never inherited from the agent: a session either is in the lane or
        // is not, and an absent field (older server, or one that never set it) is off.
        fastMode = s.fastMode == true
        let live = ComposerLogic.isLive(status: s.effectiveRunStatus)
        // When the session already stores a model, this is a complete server baseline before the
        // slower optional Runner/provider reads. A manual pick can now PATCH against it safely.
        if live, s.model != nil, modelSelectionRevision.isPristine {
            syncedConfig = (modelID, permissionMode.rawValue, effort.rawValue, fastMode)
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
        // The account pools ride along; a failed pool read keeps the last good pools.
        let pools = try? await api.providerPools()
        if let providers = try? await api.providers() {
            adoptProviders(providers, pools: pools ?? providerPools)
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
                configured: configuredProviders, catalog: modelCatalog)
        }
        // OpenCode variants are model-defined, so this is the first point where a stored
        // value can be validated against the runner catalog.
        effort = AgentDefaults.normalizedEffort(
            effort, for: provider, model: modelID, catalog: modelCatalog,
            configured: configuredProviders)
        // A LIVE session pushes later pill edits to the server (PATCH /config); record the
        // adopted values so `applyConfig` can distinguish a real user edit from this adopt.
        // A terminal session isn't live, so its pills stay local until the next resume.
        if live, modelSelectionRevision.isPristine {
            syncedConfig = (modelID, permissionMode.rawValue, effort.rawValue, fastMode)
        }
    }

    /// Adopt a fresh list/detail snapshot too. The app's control-plane-driven list refresh carries
    /// heartbeat-derived capability changes, so an open console needn't keep an older denial.
    func adoptServerSnapshot(_ session: Session?) {
        guard let session, session.id == sessionID else { return }
        serverStatus = session.effectiveRunStatus
        serverCapabilities = session.capabilities
        // A run ending its turn moves this SESSION's row, not the task, so no task event re-reads
        // the confirmation. Web re-reads when the row moves for exactly this reason, and the same
        // change is what makes a report arrive: without it the card would wait for the next poll.
        let moment = runMoment(session)
        if moment != ownerReadMoment {
            ownerReadMoment = moment
            if taskID != nil { Task { [weak self] in await self?.refreshOwnerConfirmation(force: true) } }
            // A claim can move a session on an account pool onto another of its accounts, and only
            // the detail says which: re-read it when the run moves, so the account the status bar
            // names follows the claim.
            if currentPool != nil { Task { [weak self] in _ = await self?.refreshServerStatus() } }
        }
        // The final SSE notification is intentionally live-only and can be missed while this app
        // is disconnected. REST is authoritative too: once it observes an idle/terminal run, drop
        // any stranded foreground-shell preview and publish the reducer immediately instead of
        // leaving the card looking active until another transcript event happens to arrive.
        if session.effectiveRunStatus == .awaitingInput || session.effectiveRunStatus.isTerminal {
            let cleared = reducer.clearLiveToolOutputsAtBoundary()
            if cleared || state != reducer.state { publishStateNow() }
        }
    }

    /// The moment of a run's row, as a value that changes when and only when something about the run
    /// moved: web keys its confirmation re-read on the same pair.
    private func runMoment(_ s: Session) -> String {
        "\(s.effectiveRunState.rawValue)|\(s.lastTurnAt ?? "")"
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
        poolMemberProviderID = s.poolMemberProviderId
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
                configured: configuredProviders, catalog: modelCatalog)
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
                                               catalog: modelCatalog, engines: runnerEngines,
                                               pools: providerPools),
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
        // Read before the assignment below, because what the note is ABOUT is the move from one to
        // the other — and the timing of it, which is the whole question: a run keeps its provider
        // for its whole life, so a pick made over something that is going lands on the next turn.
        let from = provider
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
                                                configured: configuredProviders,
                                                catalog: modelCatalog)
            : permissionMode
        let nextEffort = AgentDefaults.normalizedEffort(effort, for: slug, model: nextModel,
                                                        catalog: modelCatalog,
                                                        configured: configuredProviders)
        providerSwitchNote = TaskRunHandoff.providerSwitchNote(from: from, to: slug, liveRun: isLive)
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
                permissionMode, for: modelID, provider: slug, configured: configuredProviders,
                catalog: modelCatalog)
        }
        effort = AgentDefaults.normalizedEffort(effort, for: slug, model: modelID,
                                                catalog: modelCatalog,
                                                configured: configuredProviders)
    }

    /// Adopt a provider catalogue with the account pools folded in, each resolved like a Claude key.
    private func adoptProviders(_ providers: [ConfiguredProvider], pools: [ProviderPool]) {
        providerPools = pools
        configuredProviders = providers + ProviderPools.asProviders(pools)
        configuredProvidersLoaded = true
    }

    /// Keep an already-constructed draft in sync with AgentsModel's later provider/runner fetch.
    /// SwiftUI preserves the draft's @State across parent updates, so constructor snapshots alone
    /// are insufficient. An unresolved custom slug retains its placeholder seed; once the provider
    /// list is authoritative, a pristine picker adopts the real provider default and capabilities.
    func adoptDraftProviderContext(_ providers: [ConfiguredProvider], loaded: Bool,
                                   defaultModel: String) {
        guard isDraft else { return }
        // Successful provider discovery is last-good state. A slower parent request that is still
        // pending (or failed) must not erase a snapshot this draft already fetched itself. The
        // parent's list carries no pools, so this draft's own stay folded in.
        if loaded { adoptProviders(providers, pools: providerPools) }
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
                configured: configuredProviders, catalog: modelCatalog)
        }
        // The provider list is also where a configured model declares the efforts it accepts.
        effort = AgentDefaults.normalizedEffort(
            effort, for: provider, model: modelID, catalog: modelCatalog,
            configured: configuredProviders)
    }

    /// A picker change on a LIVE session is pushed to the server immediately (PATCH /config,
    /// like web's configMut); on a terminal/draft session the local value is kept and carried
    /// by the next resume. Pass only the field that changed (effort uses its raw value so
    /// Default sends "" to clear it). No-op when the value equals the synced server config —
    /// that filters the programmatic adopt in `loadContext` from re-sending a change nobody made.
    ///
    /// WHEN the pushed change takes hold is not one answer for all fields, and the server
    /// decides it (SessionsService.updateConfig), not this call. Effort, fast mode and provider are
    /// decided when the engine process is built — the CLI reads fast mode out of the settings file
    /// its process started with — so they queue a `reload`: the runner re-spawns with --resume once
    /// the running turn ends, and they govern the NEXT turn. Model and permission mode are handed
    /// to a resident Claude Code over its control channel (`set_model` / `set_permission_mode`) as
    /// a `setconfig` the inbox delivers mid-turn, so they take hold where the running turn stands.
    /// Those control frames are the claude runtime's alone — a Codex / Kimi / OpenCode session
    /// still re-spawns for all of them. Web says as much in the pill tooltips (`configPillHints`);
    /// nothing here shows the difference yet, so this comment is where the two clients agree on it.
    func applyConfig(model: String? = nil, permissionMode: String? = nil, effort: String? = nil,
                     fastMode: Bool? = nil, provider: String? = nil) async {
        guard isLive else { return }
        // A provider only ever arrives from an explicit pick — `loadContext`'s adopt never sets one
        // — so it needs no comparison against the synced pair to prove it isn't an echo.
        let changed = provider != nil
            || (model.map { $0 != syncedConfig?.model } ?? false)
            || (permissionMode.map { $0 != syncedConfig?.permissionMode } ?? false)
            || (effort.map { $0 != syncedConfig?.effort } ?? false)
            || (fastMode.map { $0 != syncedConfig?.fastMode } ?? false)
        guard changed else { return }
        do {
            try await api.updateConfig(sessionID: sessionID,
                ConfigUpdateRequest(model: model, permissionMode: permissionMode, effort: effort,
                                    fastMode: fastMode, provider: provider))
            let baseline = syncedConfig ?? (model: modelID,
                                             permissionMode: self.permissionMode.rawValue,
                                             effort: self.effort.rawValue,
                                             fastMode: self.fastMode)
            syncedConfig = (model ?? baseline.model,
                            permissionMode ?? baseline.permissionMode,
                            effort ?? baseline.effort,
                            fastMode ?? baseline.fastMode)
        } catch {
            statusMessage = "Couldn't apply change — \(APIClient.failureReason(error))."
        }
    }

    /// Record a real picker action separately from seed/refill assignments. A late account payload
    /// must never overwrite a choice made while it was loading, even when the user selected the same
    /// value that the legacy workspace happened to seed.
    func selectEffort(_ value: Effort) {
        effort = value
        effortSelectionRevision.markUserEdit()
    }

    /// Re-resolve a draft when the async `me.preferences.defaultEffort` value arrives. This is a no-op
    /// after the picker has been touched; otherwise account last-picked wins and the workspace value
    /// remains only the compatibility fallback.
    func adoptDraftDefaultEffort(_ accountDefault: String?, legacyWorkspaceDefault: String?) {
        guard isDraft, effortSelectionRevision.isPristine else { return }
        effort = AgentDefaults.newSessionEffort(
            accountDefault: accountDefault, legacyWorkspaceDefault: legacyWorkspaceDefault,
            for: provider, model: modelID, catalog: modelCatalog,
            configured: configuredProviders)
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
    ///
    /// `overrideText` is a message the caller supplies instead of the composer's draft — the retry
    /// of the last user turn (see `retryLastMessage`). It rides this same path for the gating,
    /// queueing and failure handling below, but the composer is neither read nor cleared for it: a
    /// retry is nothing the user just typed, so it must not flash through the input field on its
    /// way out, nor take the draft they are part-way through typing with it — nor the attachments
    /// they have staged (a retry carries its own message's files; see `carried` below).
    func send(authoritative: RunStatus? = nil, overrideText: String? = nil,
              overrideAttachments: [TurnAttachment]? = nil) async {
        guard !sending, !waitingForUploads else { return }
        // `false` for a retry: its message was handed in, so the composer keeps what it holds.
        let fromComposer = overrideText == nil
        // A chip is staged the moment an image is picked, while its bytes are still going up (see
        // `attach`). Sending in that window would leave the image behind for good: only chips that
        // already carry a `remoteID` ride along, and the staged list is cleared below either way.
        // So honor the tap and hold until the upload lands. (Web instead disables its send button
        // while `uploading` — the wait costs the user the same time without a button that looks
        // dead.) Everything below reads the composer afterwards, so text typed during the wait
        // still goes out with this send. A retry is not waiting on anything of the composer's: it
        // carries no chips, so an upload in flight is none of its business.
        if fromComposer, pendingAttachments.contains(where: \.isUploading) {
            waitingForUploads = true
            await waitForStagedUploads()
            waitingForUploads = false
        }
        // A leading `!` runs the remainder as a raw shell command on the runner, bypassing claude
        // (mirrors the web composer). A bare `!` with nothing after it is a no-op.
        let (text, shell) = ComposerLogic.parseShell(overrideText ?? composerText)
        // Empty text still sends when something is staged to carry the message (see
        // `canSendAttachmentsAlone`) — but never as a shell turn: a bare `!` is a no-op that only
        // clears itself, and attachments mean nothing to a raw command (web ignores them there too).
        guard !text.isEmpty || (!shell && canSendAttachmentsAlone) else {
            if shell, fromComposer { composerText = "" }
            return
        }
        if let command = ComposerHostCommand.commandName(in: text) {
            if ComposerHostCommand.isLocal(command) {
                showStatusCommand()
                if fromComposer { composerText = "" }
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
        // An armed reply answers a question rather than starting a turn, so it goes to that
        // question's own door. (Mirrors the web reroute.)
        if let reply = replyContext {
            // The two targets that answer no door carry the typed sentence and nothing else — an
            // attachment cannot say what should change or what to do — so an empty composer leaves
            // the bar armed rather than sending the context back with no question attached
            // (web: `if (!c) return`).
            if reply.target.needsText, text.isEmpty { return }
            if fromComposer { composerText = "" }
            replyContext = nil
            switch reply.target {
            // Resolve the pending approval as a deny+message, so claude reads the text as in-turn
            // feedback and continues.
            case .approval(let id):
                await replyToQuestion(approvalID: id, text: text)
            // Send the report back with this text as the reason the door requires. `send` already
            // refuses an empty composer, which is the same rule the door enforces.
            case .ownerConfirmation(let waiting):
                localSendTick &+= 1   // an answer is a send too — pin the transcript to the tail
                await decideOwnerConfirmation(waiting, .sendBack, note: text)
            // Send this version of the evidence back with this text as the reason the door
            // requires. `send` already refuses an empty composer, which is the same rule the door
            // enforces.
            case .evidenceDecision(let row):
                localSendTick &+= 1   // an answer is a send too — pin the transcript to the tail
                await decideEvidence(row, .sendBack, note: text)
            // Talking about a plan before it is started reaches no door: this is an ordinary turn
            // at an idle agent, with the project, its criteria and their seal carried in front of
            // the message. Handed back to `send` whole, with the composer already cleared above —
            // the card that armed it is untouched, and its own Start is still the other way out.
            // Discussing an item that became the owner's reaches no door either: the coordinator
            // is told about it in words and decides what to do with the doors it has.
            case .ownerItem(let context):
                await send(authoritative: authoritative, overrideText: "\(context)\n\n\(text)",
                           overrideAttachments: [])
            case .planChange(let context):
                // Says outright that it carries no attachments, rather than leaving that to how
                // its text arrived: a question about a plan is the typed sentence and nothing else
                // (an attachment cannot say what should change), and the chips staged in the
                // composer stay there for the message they were picked for.
                await send(authoritative: authoritative, overrideText: "\(context)\n\n\(text)",
                           overrideAttachments: [])
            }
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
        // What this send consumes. A send that fails for good hands it straight back (see the
        // catch) rather than making the user retype a message they can no longer see; for a retry
        // that hands the retried text to the composer, which never held it. The raw draft, so a
        // shell send comes back with its leading `!`.
        let draft = overrideText ?? composerText
        let staged = pendingAttachments
        // What rides with this send: whatever it was handed, else the composer's own chips. A
        // retry hands in the attachments of the message it is re-sending — their bytes are on the
        // control plane under those ids and never moved, so re-sending without them would ask the
        // reader to find the files again for a message the server is still holding whole (web
        // parity — its card's retry sends that turn's own ids). What it does NOT take is the staged
        // chips: those belong to the message being composed, so they neither travel with a retry
        // nor leave the composer under it. Every chip that rides along has finished uploading by
        // now (the send waited above), so each carries its server `remoteID`; `compactMap` is
        // belt-and-suspenders against a stray nil.
        let carried: [TurnAttachment] = overrideAttachments ?? pendingAttachments.compactMap { att in
            att.remoteID.map { TurnAttachment(id: $0, mime: att.mimeType, name: att.filename) }
        }
        let attachmentIds = carried.map(\.id)
        // Carry mime/name onto the optimistic bubble so it can render image thumbnails / file chips
        // immediately (the durable `user` event later supplies the authoritative refs).
        let turnAttachments = carried

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
        if fromComposer { composerText = "" }
        if fromComposer { pendingAttachments = [] }

        sending = true
        defer { sending = false }
        // Last send's answer, whichever it was: this one gets to say its own.
        runConflict = nil
        runConflictFromRetry = false
        handedOverSessionID = nil
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
            // The pick has done what it said it would; the sentence describing it is spent.
            providerSwitchNote = nil
            // §2.1: the message was delivered, to the run that holds the task rather than to this
            // session. So the bubble comes back down — it is not here — and the card says where it
            // went, with one press to follow it.
            if let routed = TaskRunHandoff.routedToSession(accepted) {
                reducer.removeOptimisticUser(clientTurnId: clientTurnId)
                awaitingReply = false
                publishStateNow()
                handedOverSessionID = routed
                return
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
            // …and hand the message back: the composer was cleared of what this send consumed, so
            // this is the only copy left of it (a retry's text, which the composer never held,
            // lands here too). Anything typed while the retries ran stays, below the returned text.
            composerText = composerText.isEmpty ? draft : draft + "\n" + composerText
            // The chips come back the same way — but only for a send that took them: a retry never
            // did, and putting them back would double them.
            if fromComposer { pendingAttachments = staged + pendingAttachments }
            // The one place this end stops flattening a refusal into a sentence. A code it knows
            // becomes a card with a way out; anything else — an older server, a code invented
            // later, a connection that simply failed — still reads the server's own words.
            if let held = error as? TaskRunStillHeld {
                runConflict = held.conflict
                runConflictFromRetry = sendingAutoRetry
            } else if let conflict = TaskRunHandoff.readConflict(error) {
                runConflict = conflict
                runConflictFromRetry = sendingAutoRetry
            } else {
                statusMessage = ComposerLogic.sendFailureMessage(error)
            }
        }
    }

    /// Answer the one question that authorises stopping a run that is doing work, and send the
    /// message again — the same message, which the failed send handed back to the composer.
    ///
    /// The id comes from the server's own `confirm.value` by way of `stopSessionIdFor`, so it names
    /// the run the reader was shown. A claim that changed hands between question and answer is
    /// asked about again rather than stopped on a confirmation about a different run.
    func stopAndContinue() async {
        guard let stop = TaskRunHandoff.stopSessionID(runConflict, confirmed: true) else { return }
        confirmedStopSessionID = stop
        runConflict = nil
        defer { confirmedStopSessionID = nil }
        await send()
    }

    /// The other answer, and the default one: nothing is stopped, and the message stays where the
    /// failed send put it — in the composer, for the reader to decide about.
    func keepRunning() {
        runConflict = nil
    }

    func dismissRunConflict() {
        runConflict = nil
        handedOverSessionID = nil
    }

    /// What a retry after a sign-in failure would re-send: the latest user turn in the transcript,
    /// as that retry would carry it — their words, and the attachments those words went out with.
    /// Empty when the failure landed before any user message — a first run, whose opening prompt was
    /// seeded server-side and never became a transcript item — and the card then offers the sign-in
    /// alone rather than a button that would send nothing.
    ///
    /// Both halves off ONE bubble: a second walk back through the transcript could stop at a
    /// different message and re-send one message's words under another's files.
    var lastUserMessage: (text: String, attachments: [TurnAttachment]) {
        for item in state.items.reversed() {
            if case .user(let b) = item, !b.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return (b.text, b.attachments)
            }
        }
        return ("", [])
    }

    var lastUserMessageText: String { lastUserMessage.text }

    /// The same question asked of the server, for the sessions this client cannot answer it for.
    ///
    /// `lastUserMessage` reads the transcript this client HOLDS, which is its newest 200 events
    /// (`tailPage`). A conversation keeps its last message in there; a run does not — a task
    /// session is one message followed by thousands of tool events, so the words a retry exists to
    /// re-send sit at seq 1, outside every window this client paints. Deciding from the window
    /// alone hid the Retry button entirely on exactly the sessions a provider outage kills.
    /// Fetched by `refreshRetryText`, from the same chooser the automatic retry re-sends with
    /// (auto-retry.service `messageToResend`). Web parity: `AutoRetryHelp.onNeedRetryText`.
    ///
    /// Words only. The files a message went out with are read off its bubble, and a session with no
    /// bubble to read has none to offer — so this stands in for `lastUserMessage.text` alone and
    /// never for its attachments.
    private(set) var serverRetryText = ""

    /// What a retry sends: what is on screen when that answers it, and the server's answer when
    /// nothing on screen does.
    var retryMessageText: String {
        let loaded = lastUserMessageText
        return loaded.isEmpty ? serverRetryText : loaded
    }

    /// Go and get it — only when the window came up empty, and only once per session.
    func refreshRetryText() async {
        guard lastUserMessageText.isEmpty, serverRetryText.isEmpty else { return }
        serverRetryText = (try? await api.retryMessage(sessionID: sessionID))?.text ?? ""
    }

    /// Re-send that message once the runner is signed back in (web's "Retry — re-send my last
    /// message"). Handed to `send` as the message itself rather than typed into the composer, so
    /// the retry obeys the same gating, queueing and failure handling as anything else sent from
    /// here without the text flashing through the input field on its way out — and without a draft
    /// the user is part-way through typing having to be moved aside and put back.
    func retryLastMessage() async {
        // The bubble when this client holds one: its words AND the files they went out with, off
        // the same bubble. When it holds none — a run's message is thousands of events behind the
        // window — the server's words stand in, and there are no files to carry with them.
        let last = lastUserMessage
        let text = last.text.isEmpty ? serverRetryText : last.text
        guard !text.isEmpty, !sending else { return }
        sendingAutoRetry = true
        defer { sendingAutoRetry = false }
        await send(overrideText: text, overrideAttachments: last.attachments)
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
            statusMessage = "Couldn't change auto-retry — \(APIClient.failureReason(error))."
        }
        // Refetch either way: the card renders the server's answer, not the click.
        await worktree.loadDetail()
    }

    /// A holder that did not let go within the resends. Carried as an error so the one catch below
    /// decides what is shown, rather than the wait writing to the screen from inside the post.
    private struct TaskRunStillHeld: Error { let conflict: TaskRunHandoff.Conflict }

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
                                          // Same authority as effort, and sent as a value rather
                                          // than only when true: a resume is the one moment a
                                          // dormant session can leave the lane, so leaving it has
                                          // to travel as clearly as joining it.
                                          fastMode: fastMode,
                                          attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds,
                                          provider: pendingResumeProvider,
                                          // Only ever the answer to the question that asked about
                                          // stopping this exact run, and only for this one send.
                                          stopSessionId: confirmedStopSessionID)
        let turnRequest = ComposerLogic.makeTurn(clientTurnId: clientTurnId, text: text,
                                                 shell: shell, attachmentIds: attachmentIds)
        // A run that is letting go frees the task within a couple of seconds, so this waits it out
        // rather than handing the reader a refusal about a situation that is already resolving.
        // The identical request goes back out — same `clientTurnId` — so the server either queues
        // the message once or answers from the receipt of an attempt that got through.
        var waits = 0
        while true {
            do {
                return try await retryingTransientFailures { () async throws -> TurnAccepted in
                    if resuming { return try await self.api.resume(sessionID: self.sessionID, resumeRequest) }
                    return try await self.api.sendTurn(sessionID: self.sessionID, turnRequest)
                }
            } catch {
                guard let conflict = TaskRunHandoff.readConflict(error),
                      conflict.kind == .ending else { throw error }
                // Past this, whatever is holding the engine is not the shutdown this was waiting
                // for, and going on would be a request every two seconds for as long as the window
                // stays open. So it stops and says the true thing instead.
                guard waits < TaskRunHandoff.resendMaxAttempts else {
                    throw TaskRunStillHeld(conflict: TaskRunHandoff.stillHeldAfterWaiting(conflict))
                }
                waits += 1
                runConflict = conflict
                // Shown by whoever this send came from, the same as the settled answer below:
                // a wait that appeared in a different place than its outcome would read as two
                // separate events happening to one message.
                runConflictFromRetry = sendingAutoRetry
                try await Task.sleep(nanoseconds: UInt64(TaskRunHandoff.resendAfter * 1_000_000_000))
            }
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
            // Passed only while it is on, the way web's snapshot carries it: a false here would be
            // indistinguishable from a session that has no lane, which is the same thing it means.
            fastMode: fastMode ? true : nil,
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
        guard !text.isEmpty || (!shell && canSendAttachmentsAlone) else {
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
                // Sent only when on, like every other override that has an "off" default: a
                // session that never touched Speed starts without the lane rather than with an
                // explicit false the server would have to remember anyway.
                fastMode: fastMode ? true : nil,
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
            statusMessage = "Couldn't start the session — \(APIClient.failureReason(error))."
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
        let pools = try? await api.providerPools()
        if let providers = try? await api.providers() {
            adoptProviders(providers, pools: pools ?? providerPools)
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
                configured: configuredProviders, catalog: modelCatalog)
        }
        applySlashItems(from: agentRunner)
        // OpenCode variants are model-defined, so this is the first point where a stored
        // value can be validated against the runner catalog.
        effort = AgentDefaults.normalizedEffort(
            effort, for: provider, model: modelID, catalog: modelCatalog,
            configured: configuredProviders)
    }

    func interrupt() async {
        do { try await api.interrupt(sessionID: sessionID) }
        catch { statusMessage = "Interrupt failed" }
    }

    /// "Stop the current turn and send THIS instead" — one request, not a stop followed by a send
    /// (web parity, `interruptAndSend`). Two requests could not express it: the interrupt drops the
    /// follow-ups queued behind the running turn, so a send racing it might be deleted by it, and a
    /// send that landed first would be filed as a steer — written INTO the turn being stopped.
    ///
    /// The follow-up is filed as an ordinary queued message, so it shows as Queued and runs once the
    /// interrupted turn is actually over.
    func interruptAndSend() async {
        guard !sending, !waitingForUploads else { return }
        // Same wait as `send`: a chip staged while its bytes are still going up would otherwise be
        // left behind for good.
        if pendingAttachments.contains(where: \.isUploading) {
            waitingForUploads = true
            await waitForStagedUploads()
            waitingForUploads = false
        }
        let (text, shell) = ComposerLogic.parseShell(composerText)
        // A `!cmd` runs on the runner beside the engine, so it is not something the engine is
        // stopped for; the button is not offered for one, and this is the backstop.
        guard !shell, !text.isEmpty || canSendAttachmentsAlone else { return }
        let clientTurnId = UUID().uuidString
        let draft = composerText
        let staged = pendingAttachments
        let ready = pendingAttachments.compactMap { att in att.remoteID.map { (att, $0) } }
        let attachmentIds = ready.map(\.1)
        let turnAttachments = ready.map { TurnAttachment(id: $0.1, mime: $0.0.mimeType, name: $0.0.filename) }
        // Always queued: the follow-up waits for the interrupted turn's result, whether or not the
        // engine honours the stop.
        reducer.addOptimisticUser(clientTurnId: clientTurnId, text: text,
                                  attachments: turnAttachments, queued: true)
        // Claimed BEFORE the request goes out, because the `interrupt` event can beat its response
        // back here: the salvage below must already know this one message was not dropped.
        interruptFollowUpClientTurnId = clientTurnId
        awaitingReply = true
        publishStateNow()
        localSendTick &+= 1
        composerText = ""
        pendingAttachments = []
        sending = true
        defer { sending = false }
        do {
            let accepted = try await api.interruptAndSend(
                sessionID: sessionID,
                SessionInterruptRequest(clientTurnId: clientTurnId, content: text,
                                        attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds))
            if let tid = accepted.turnId {
                reducer.setOptimisticTurnId(clientTurnId: clientTurnId, turnId: tid)
            }
            publishStateNow()
        } catch {
            // Nothing was queued and nothing was stopped: take the bubble back down and hand the
            // draft back, exactly as a failed send does.
            reducer.removeOptimisticUser(clientTurnId: clientTurnId)
            interruptFollowUpClientTurnId = nil
            awaitingReply = false
            publishStateNow()
            composerText = composerText.isEmpty ? draft : draft + "\n" + composerText
            pendingAttachments = staged + pendingAttachments
            statusMessage = ComposerLogic.sendFailureMessage(error)
        }
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
            // Except a turn nobody typed — a wake, a delivery — which would land in the composer
            // as though the user had written it (`ComposerLogic.restorableText`).
            if let body = ComposerLogic.restorableText(of: bubble),
               composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
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
    ///
    /// Only for the interrupt a Stop produced (`TranscriptReducer.dropsQueue`): the one a runner
    /// writes as it restarts drops nothing, so folding its queue back would show every message in
    /// it twice — and it did, on 2026-09-25, with a background job's wake nobody had typed.
    private func foldQueuedBackIntoComposer(before ev: RunEvent) {
        guard TranscriptReducer.dropsQueue(ev), !reducer.state.queued.isEmpty,
              composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        // The follow-up of a "stop and send this instead" is in this same queue and was NOT dropped
        // — it was filed after the interrupt's delete, which is the whole point of sending them
        // together. Pulling it back into the composer would show the user their message twice: once
        // as the queued bubble that is really there, once as a draft they never retyped.
        let followUp = interruptFollowUpClientTurnId
        interruptFollowUpClientTurnId = nil
        let restored = reducer.state.queued
            .filter { $0.clientTurnId == nil || $0.clientTurnId != followUp }
            // A turn nobody typed — a wake, a delivery — was never the user's to get back.
            .compactMap(ComposerLogic.restorableText(of:))
            .joined(separator: "\n\n")
        guard !restored.isEmpty else { return }
        composerText = restored
    }

    /// `+` menu → Image / File: read a picked file, enforce the size cap (web
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
        replyContext = QuestionReply(
            target: .approval(id: approvalID),
            banner: question.isEmpty ? "Replying to Claude’s question"
                                     : "Replying to Claude’s question: \(question)",
            placeholder: "Type your reply to Claude…")
    }

    /// Decline one of Orbit's own asks — a batch, a create, a restructure — with the reason beside
    /// it. Same channel as a chat reply, because a decline IS a deny+message; what differs is that
    /// the sentence is the point rather than an alternative to picking an option.
    func startDeclineReply(approvalID: String, toolName: String, subject: String) {
        replyContext = QuestionReply(
            target: .approval(id: approvalID),
            banner: Approvals.decliningPrefix(toolName: toolName) + subject,
            placeholder: Approvals.declinePlaceholder)
    }

    /// Send this session's waiting confirmation back: the next composer send carries the typed text
    /// to the owner-confirmation door as the SEND_BACK's reason. The card stays until then, with
    /// `Confirm done` still live — pressing it is the other way out.
    func startOwnerSendBackReply(_ waiting: OwnerConfirmationWaiting, title: String) {
        replyContext = QuestionReply(
            target: .ownerConfirmation(waiting),
            banner: OwnerConfirmations.sendingBackPrefix + title,
            placeholder: OwnerConfirmations.sendBackLabel)
    }

    /// Send this version of a task's evidence back: the next composer send carries the typed text
    /// to the evidence decision door as the SEND_BACK's reason — what the next version has to
    /// answer, which is the only note the door will take. The card stays until then, with
    /// `Confirm done` still live — pressing it is the other way out.
    func startEvidenceSendBackReply(_ row: EvidenceDecisionRow) {
        replyContext = QuestionReply(
            target: .evidenceDecision(row),
            banner: EvidenceDecisions.sendingBackPrefix + row.title,
            placeholder: EvidenceDecisions.sendBackLabel)
    }

    /// Talk about a plan before the project is started on it: the next composer send is an ordinary
    /// turn saying what should change, with the plan carried in front of it. Unlike the three above
    /// it answers nothing — the agent has finished writing the criteria and is waiting — so no door
    /// is named here. The card stays until then, with `Start the project` still live.
    func startPlanChangeReply(_ standing: StandardSetConfirmationStanding) {
        let criteria = projectCriteria.sorted { $0.ordinal < $1.ordinal }.map(\.text)
        replyContext = QuestionReply(
            target: .planChange(context: AcceptanceConfirmations.planChangeContext(
                projectTitle: projectTitle,
                criteriaDigest: standing.currentVersion.digest,
                criteria: criteria)),
            banner: AcceptanceConfirmations.planChangePrefix + projectTitle,
            placeholder: AcceptanceConfirmations.planChangePlaceholder)
    }

    /// Talk about an item that became the owner's rather than pressing anything: the next composer
    /// send is an ordinary turn to the coordinator, with the item carried in front of it. The card
    /// stays, and its own press stays live — the two ways out are a door and a sentence.
    func startOwnerItemReply(_ row: ProjectOpenItemRow, isPause: Bool) {
        replyContext = QuestionReply(
            target: .ownerItem(context: ExceptionCards.chatContext(projectTitle: projectTitle,
                                                                   row: row, isPause: isPause)),
            banner: ExceptionCards.chatBanner(row, isPause: isPause),
            placeholder: ExceptionCards.chatPlaceholder)
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
            statusMessage = "Approval failed — \(APIClient.failureReason(error))."
            await refreshApprovals()
        }
    }

    // MARK: the project's standing questions — its ruler, and its tasks' evidence

    /// The project this session coordinates, adopted from the session payload. Nil for an ordinary
    /// session, and then nothing below here ever makes a request: these questions belong to a
    /// project, and a conversation that coordinates none has none of them.
    private(set) var projectID: String?

    /// The held loosening proposals, as the owner's read publishes them, or nil while the read has
    /// not come back. Nil is NOT "nothing is pending" — it is `unread`, which shows a delivered
    /// card with dead buttons rather than one that quietly claims the question went away.
    private(set) var criteriaDecisions: PendingCriteriaDecisionQueue?
    /// The completion decisions this session is being asked to make, read the same way and nil for
    /// the same reason. A card is drawn only for the rows `EvidenceDecisions.cardRows` keeps: this
    /// project's, and ones the door would take an answer to from here.
    private(set) var evidenceDecisions: EvidenceDecisionQueue?
    /// Whether the account owner has confirmed the standard set as it stands.
    private(set) var acceptanceConfirmation: StandardSetConfirmationStanding?
    /// What this project still owes somebody a decision about (contract §4.8), or nil while the
    /// read has not come back. Nil is `unread` here too, for the reason the two above give: a card
    /// that quietly claimed its question went away would be indistinguishable from a broken read.
    private(set) var openItems: ProjectOpenItemsView?
    /// The merge this project is asking its owner to confirm (§3.6). Two nils, and they mean
    /// different things: the property is nil while unread, and the read answers nil when this
    /// project is asking nothing — which is the ordinary case and draws no card.
    private(set) var promotion: ProjectPromotionView?
    /// The criteria themselves, carried on the confirmation card: confirming a set the reader
    /// cannot read is the "signed unread" the whole path exists to prevent.
    private(set) var projectCriteria: [ProjectCriteriaDocument.Item] = []
    /// What the confirmation card's meta line calls this project — its own title, or the id when
    /// the read answered without one (web: `document?.title || project`).
    var projectTitle: String { projectDocumentTitle ?? projectID ?? "" }
    private var projectDocumentTitle: String?
    /// The project's status, as the same read publishes it: one of the three facts the card's
    /// condition turns on.
    private var projectStatus: String?
    /// Whether Orbit is handing this project's tasks out, as the same read publishes it: what the
    /// card's meta line says "started" off, and nil while no read has answered — which the line
    /// says rather than guessing "not started" at a project that is dispatching work.
    private(set) var projectStarted: Bool?
    /// How many tasks the same read says the project holds, and the fourth fact the card's
    /// condition turns on: a plan with nothing filed under it yet is one nobody can start. None
    /// until a document answers, which cannot hold the card up — a project whose status nobody has
    /// read is not OPEN either — and `ProjectCriteriaDocument.taskCount` is where a document that
    /// did not say the count is read as none.
    private var projectTaskCount = 0

    /// The task whose run this conversation is, adopted from the session payload. Nil for an
    /// ordinary conversation, and then nothing below ever asks about a confirmation: the card is
    /// drawn in the run's own session and nowhere else.
    private(set) var taskID: String?
    /// What that task is waiting on from its owner, as `GET /tasks/:id/owner-confirmation` publishes
    /// it, or nil while the read has not come back. Nil is NOT "nothing is waiting" — it is
    /// `unread`, which shows a delivered card with dead buttons rather than one that quietly claims
    /// the question went away.
    private(set) var ownerConfirmation: OwnerConfirmationView?
    private var loadingOwnerConfirmation = false
    private var lastOwnerRead = Date.distantPast
    /// The moment of the run this conversation last re-read the confirmation for: web re-reads when
    /// a run's row moves, and the same change is what makes a report arrive.
    private var ownerReadMoment: String?

    /// The questions delivered into THIS window, in arrival order, each anchored to the item that
    /// was last when it arrived. Addresses only — every word a card shows is re-derived from the
    /// reads above on each render (see OrbitKit's `CriteriaDecision.swift`).
    ///
    /// They are kept even after the read stops publishing them, which is the point: a card that
    /// silently vanished mid-read is indistinguishable, to the person reading it, from a render
    /// that broke. It goes stale in place instead, and says which of the ways it went stale.
    private(set) var decisionCards: [DeliveredDecisionCard] = []
    /// Cards answered or set aside HERE. They do not come back in this window: what is true now is
    /// a fact about the criteria, and what happened is the line left in the conversation.
    private var closedCards: Set<String> = []
    private var loadingRuler = false
    /// When the reads above last came back. A card's own `.task` re-fires every time the List
    /// recycles that row back on screen, so scrolling past the card must not be a way to spend
    /// requests; the reads that must never be throttled say so (`force`).
    private var lastRulerRead = Date.distantPast
    /// Web's card re-reads on a 20s timer. This one re-reads on the events that can change the
    /// answer — context load, reconnect, the card appearing, a press — with this as the floor
    /// between two of them.
    private static let rulerReadThrottle: TimeInterval = 10

    /// The cards still waiting below the reader, oldest first — what the "needs you" bar counts and
    /// where a tap on it goes. Each row says whether it is a QUESTION, which is the only thing the
    /// bar's words turn on (`NeedsYouLogic.below`).
    ///
    /// A card that has gone stale stays ON SCREEN (it is the only thing that can explain what
    /// happened to the question) but stops being counted here: pointing somebody at a dead card is
    /// worse than saying nothing. `isOpen` is OrbitKit's, so the one place that decides "still
    /// open" is the same place that decides "answerable" — and so the one case where they differ,
    /// an unreadable standing, cannot drift apart.
    ///
    /// THE EXCEPTIONS ARE IN HERE. They used to be excluded (the note said the browser's rail points
    /// at decisions, not at open items), and the reader was the thing that argument forgot: inside a
    /// project's coordinator conversation the needs-you bar excludes the session on screen, so a
    /// card that scrolled away had nothing at all pointing at it — while a question in the same
    /// position got a bar and a press that scrolls. They are not questions (the owner answers them by
    /// pressing a door, not by replying), which is why the row carries the distinction rather than
    /// the bar assuming one.
    var openBelowRows: [BelowRow] {
        let asking: [(card: DeliveredDecisionCard, row: BelowRow)] = decisionCards.compactMap { card -> (card: DeliveredDecisionCard, row: BelowRow)? in
            // One spelling for both answers, so each case below reads as the question it is: is this
            // card still waiting, and does the reader answer it by replying (`question: true`) or by
            // pressing a door (`false`)?
            func waiting(_ open: Bool, question: Bool) -> (card: DeliveredDecisionCard, row: BelowRow)? {
                guard open else { return nil }
                return (card, BelowRow(rowID: card.id, isQuestion: question))
            }
            switch card.kind {
            case .criteriaDecision(let intentID):
                return waiting(CriteriaDecisions.isOpen(criteriaStanding(intentID)), question: true)
            // A record of an answer, not a question: nothing is waiting on the reader. A merge's
            // receipt is one of these — the merge already happened, and pointing a reader at it
            // would be pointing them at something with nothing to press.
            case .criteriaDecisionReceipt, .evidenceDecisionReceipt,
                 .acceptanceConfirmationReceipt, .promotionReceipt:
                return nil
            case .acceptanceConfirmation:
                return waiting(AcceptanceConfirmations.isOpen(acceptanceConfirmation), question: true)
            case .evidenceDecision(let taskID, let evidenceRevision):
                return waiting(EvidenceDecisions.isOpen(evidenceStanding(taskID, evidenceRevision)),
                               question: true)
            case .ownerConfirmation(let taskID, let requestID):
                return waiting(OwnerConfirmations.isOpen(ownerStanding(taskID, requestID)),
                               question: true)
            case .ownerDecisionReceipt:
                // A receipt is a record, not a question: it stays on screen and is never counted.
                return nil
            case .coordinatorQuestion(let itemID):
                return waiting(CoordinatorQuestions.isOpen(questionStanding(itemID)), question: true)
            case .promotionApproval(let promotionID):
                // Only state A is a question. B is landing on its own, C is a receipt and D is
                // waiting on somebody else — none of the three is something to point a reader at.
                return waiting(PromotionCards.stage(promotionStanding(promotionID)) == .askingYou,
                               question: true)
            case .escalatedItem(let itemID), .fusePause(let itemID):
                // The owner answers one of these by pressing a door, not by replying — so it counts,
                // and the bar is told it is not a question (see `openBelowRows`' doc).
                return waiting(ExceptionCards.isOpen(ownerItemStanding(itemID)), question: false)
            }
        }
        // Oldest in the CONVERSATION first — which is not the order these were delivered in, now
        // that a card can be placed by a moment rather than by its arrival (`flowIndex`): the
        // press goes to the one that happened first. Ties keep the delivery order (the sort is by
        // (place, appended-at)), so the target never depends on how the sort happened to break.
        //
        // Where a card sits is asked of the ones still waiting and of nothing else, against ONE read
        // of the rows' clocks. A record is never waiting, and placing one reads every row's clock
        // (`ReceiptAnchor.Clocks`): asked of every card, this — which the console's body reads on
        // every update — parsed the whole window once per record, and a coordinator's nineteen
        // records froze its console on open (the account owner's iOS report, 2026-09-23).
        var clocks: ReceiptAnchor.Clocks?
        let rows: [(row: BelowRow, at: Int)] = asking.map { entry in
            (row: entry.row, at: flowIndex(of: entry.card, clocks: &clocks))
        }
        return rows.enumerated()
            .sorted { ($0.element.at, $0.offset) < ($1.element.at, $1.offset) }
            .map(\.element.row)
    }

    /// What the needs-you bar above this transcript says, or nil when nothing in it is waiting.
    ///
    /// The direction word is the one part of the line this conversation cannot answer by itself: it
    /// is about the reader's own place, reported by the transcript (`topVisibleItemID`). Everything
    /// else is the count and what kind of thing it points at (`NeedsYouLogic.below`).
    var waitingBelow: WaitingBelow? {
        let rows = openBelowRows
        guard let first = rows.first else { return nil }
        return NeedsYouLogic.below(rows: rows, side: side(ofRow: first.rowID))
    }

    /// Where one delivered card sits in the conversation RIGHT NOW, as an index into `state.items`:
    /// the item it is drawn after, -1 for one older than everything loaded (drawn at the head of
    /// the window), and one past the end for one that trails the tail.
    ///
    /// The same questions `TranscriptRows.build` answers when it assembles the rows, asked here for
    /// the ORDER of the bar's rows and for which way the reader has to look. `clocks` is the rows'
    /// clocks, read by the first card placed by a moment and reused by the rest.
    private func flowIndex(of card: DeliveredDecisionCard,
                           clocks: inout ReceiptAnchor.Clocks?) -> Int {
        switch card.placement {
        case .onArrival(let anchor):
            guard let anchor, let at = state.items.firstIndex(where: { $0.id == anchor })
            else { return state.items.count }
            return at
        case .at(let moment):
            let read = clocks ?? ReceiptAnchor.Clocks(state.items)
            clocks = read
            switch ReceiptAnchor.place(read, at: moment) {
            case .after(let id): return state.items.firstIndex { $0.id == id } ?? state.items.count
            case .beforeWindow:  return -1
            // Nothing draws this one (`TranscriptRows.build` drops an unplaceable stamp), so it is
            // counted as if it were at the tail: the bar must not send the reader to a row that is
            // not there.
            case .unplaceable:   return state.items.count
            }
        }
    }

    /// Which way the reader has to look for one of those rows: above when the card is drawn before
    /// the item at the top of their viewport, below when it is at or after it.
    ///
    /// Nil when the reader's place is unknown — nothing has reported it yet, the system is below the
    /// floor the transcript's scroll geometry needs, or the item it named has since been trimmed out
    /// of the window — and the bar then says the count and no direction (`NeedsYouLogic.below`).
    private func side(ofRow rowID: String) -> ReaderSide? {
        guard let top = topVisibleItemID,
              let item = state.items.firstIndex(where: { $0.id == top }),
              let card = decisionCards.first(where: { $0.id == rowID }) else { return nil }
        var clocks: ReceiptAnchor.Clocks?
        return flowIndex(of: card, clocks: &clocks) < item ? .above : .below
    }

    /// The item straddling the top edge of the reader's viewport, as `TranscriptView` reports it
    /// (`noteTopVisible`) — the reader's own place, and the one fact the bar's direction word needs.
    private(set) var topVisibleItemID: String?

    /// Tell the console which item the reader's viewport top is on.
    ///
    /// Called from the transcript's scroll tracking, which recomputes on every geometry change; the
    /// write happens only when the answer CHANGES, so scrolling a long conversation invalidates the
    /// views that read this a handful of times rather than once a frame.
    func noteTopVisible(_ itemID: String?) {
        guard topVisibleItemID != itemID else { return }
        topVisibleItemID = itemID
    }

    /// A row the transcript has been asked to scroll to. The tick rides along so pressing the bar
    /// twice scrolls twice, which a bare id could not express.
    struct ScrollRequest: Equatable {
        let rowID: String
        let tick: Int
    }
    private(set) var scrollRequest: ScrollRequest?
    private var scrollTick = 0

    func requestScroll(to rowID: String) {
        scrollTick += 1
        scrollRequest = ScrollRequest(rowID: rowID, tick: scrollTick)
    }

    /// Re-read the project's standing questions from the server.
    ///
    /// Driven by the console rather than by a card's own `.task`: a card here EXISTS because the
    /// read found something, so a read that only ran when a card was on screen could never find the
    /// first one. It runs when the session's context loads, when the stream reconnects (the
    /// iOS-specific gap — a suspended socket misses everything), when a card scrolls into view, and
    /// after any press. What it may never do is remove a card.
    func refreshRulerQuestions(force: Bool = false) async {
        guard !isDraft, let projectID, !loadingRuler else { return }
        if !force, Date().timeIntervalSince(lastRulerRead) < Self.rulerReadThrottle { return }
        loadingRuler = true
        defer { loadingRuler = false }

        // Four independent reads. One failing must not blank what the others answered, and none
        // failing may close a card — an unreadable standing is a card that says so.
        if let queue = try? await api.pendingCriteriaDecisions(projectID: projectID) {
            criteriaDecisions = queue
            for row in queue.pending { deliver(.criteriaDecision(intentID: row.intentId)) }
            adoptReceipts(queue)
        }
        // Scoped to THIS session: every row says whether the door would take an answer from here.
        if let queue = try? await api.pendingEvidenceDecisions(decidingSessionID: sessionID) {
            evidenceDecisions = queue
            for row in EvidenceDecisions.cardRows(queue: queue, projectId: projectID) {
                deliver(.evidenceDecision(taskID: row.taskId, evidenceRevision: row.evidenceRevision))
            }
            adoptEvidenceReceipts(queue)
        }
        if let standing = try? await api.acceptanceConfirmation(projectID: projectID) {
            acceptanceConfirmation = standing
            adoptAcceptanceReceipt()
        }
        if let document = try? await api.projectCriteria(projectID: projectID) {
            projectCriteria = document.acceptanceCriteriaItems ?? []
            projectDocumentTitle = document.title
            projectStatus = document.status
            projectStarted = document.coordinatorEnabled
            projectTaskCount = document.taskCount
        }
        // The project's two owner cards. Same rule as the four above: each is independent, a read
        // that fails leaves the last answer standing, and neither may close a card.
        if let items = try? await api.projectOpenItems(projectID: projectID) {
            openItems = items
            for row in CoordinatorQuestions.open(items) {
                deliver(.coordinatorQuestion(itemID: row.itemId))
            }
            // And the exceptions that became the owner's, which had no card here at all: the
            // session list, the console header and the needs-you banner all count them (the
            // server lands the count on this conversation because this is where the card is
            // drawn), so a build that drew none of them said "Waiting for approval" over a
            // conversation with nothing in it to press. `ExceptionCards.cards` draws the owner's
            // group only — what is still the coordinator's is work in progress, and the agent's.
            //
            // Placed by the item's OWN moment rather than by where this device read it
            // (`DeliveryAnchor.exception`), so the card sits where it became the owner's: read off
            // the item, the same clock its heading counts its wait from.
            for row in ExceptionCards.cards(items) {
                deliver(row.kind == .fusePaused ? .fusePause(itemID: row.itemId)
                                                : .escalatedItem(itemID: row.itemId),
                        placement: DeliveryAnchor.exception(row, items: state.items))
            }
        }
        // `do` rather than `try?`, because this door answers `null` for "asking nothing" and `try?`
        // would flatten that into the same nil a failed read gives (SE-0230). The two are opposite
        // instructions: a project with no candidate is a card this window should stop drawing,
        // while a read that did not come back may never close one — the rule the four reads above
        // are under as well.
        do {
            let current = try await api.currentPromotion(projectID: projectID)
            promotion = current
            if let current, let stage = PromotionCards.stage(current) {
                // A merge that has HAPPENED is neither asking nor telling anything now: it is a
                // record, and the conversation draws it where it happened (`adoptPromotionReceipts`
                // below) rather than at the tail. Left here it sat under every later message for the
                // life of the project — the account owner's report, 2026-09-21. The project page,
                // which has no transcript to draw a moment into, keeps its card (web's
                // `drawRecords`).
                if stage == .merged {
                    close(.promotionApproval(promotionID: current.promotionId))
                } else {
                    // And the candidate a check BLOCKED carries a moment of its own, which the card
                    // is delivered at rather than at wherever this device read it
                    // (`DeliveryAnchor.promotion`): held at the tail it sat under every later
                    // message for as long as the block stood — the same report as the merge's, nine
                    // hours and eleven messages later, 2026-09-24. A candidate still asking has no
                    // moment, and that rule hands it back the ordinary arrival anchor.
                    deliver(.promotionApproval(promotionID: current.promotionId),
                            placement: DeliveryAnchor.promotion(current, items: state.items))
                }
            }
        } catch {
            // Left exactly as it was: the card says what it last read, not that the merge vanished.
        }
        // And the merges already made, each drawn where it happened. Its own read rather than the
        // candidate above: that one moves on to the next candidate the branch produces, and a
        // receipt drawn from it would describe a different merge every time that happened. Nothing
        // is kept here: what the conversation holds is the record itself, once it is placed.
        if let merged = try? await api.mergedPromotions(projectID: projectID) {
            adoptPromotionReceipts(merged)
        }
        if settlementHeldOnConfirmation { deliver(.acceptanceConfirmation) }
        // A press that arrived before this read now has its row to land on.
        scrollToPendingOwnerItem()
        lastRulerRead = Date()
    }

    /// Whether this project is waiting to be started on a plan nobody has confirmed.
    ///
    /// Four facts and no fifth: the project is OPEN, it states criteria, it holds at least one
    /// task, and the set standing now has not been confirmed. `satisfied` is deliberately absent —
    /// waiting for every criterion to be met by its work put the question at the moment it could
    /// only be agreed with, because answering "no" then annuls work already done; asked here the
    /// answer is cheap, the plan is written and nothing has run. Web reads the same four off the
    /// same two documents (`settlementHeldOnConfirmation` in `AcceptanceConfirmationCard.tsx`).
    ///
    /// THE TASK COUNT IS THE FOURTH BECAUSE "START" IS A VERB THAT NEEDS AN OBJECT. `project_create`
    /// returns before the coordinator has filed anything, and this condition used to hold from that
    /// moment: the plan is written and there is nothing to hand out, so the card offered to start a
    /// project whose every press would have started nothing. `projectTaskCount` is read off the same
    /// document (`_count.tasks`), and a document that did not say it is read as none for the same
    /// reason `AcceptanceConfirmations.answerable` refuses a standing it does not have: a gate that
    /// cannot establish its fact stays shut.
    private var settlementHeldOnConfirmation: Bool {
        guard AcceptanceConfirmations.answerable(acceptanceConfirmation) else { return false }
        guard projectStatus == "OPEN" else { return false }
        guard !projectCriteria.isEmpty else { return false }
        return projectTaskCount > 0
    }

    /// Put a question into this conversation once, anchored where OrbitKit's rule puts it: where it
    /// arrived, or trailing the tail for the one card whose delivery is triggered by the control
    /// plane rather than by this transcript, and which was therefore drawn above the report it asks
    /// about (`DeliveryAnchor`).
    private func deliver(_ kind: DeliveredDecisionCard.Kind) {
        deliver(kind, anchoredAt: DeliveryAnchor.onArrival(of: kind, items: state.items))
    }

    /// …or where it happened, for a card that carries a moment of its own — a receipt, and the two
    /// owner cards that became the owner's at a time the read can name (`DeliveryAnchor.exception`):
    /// drawn at the point in the conversation they belong to rather than where the reader happened
    /// to be looking when the read brought them back.
    private func deliver(_ kind: DeliveredDecisionCard.Kind, anchoredAt anchor: String?) {
        deliver(kind, placement: .onArrival(afterItemID: anchor))
    }

    /// The same, for a card whose whole placement the caller worked out (`DeliveryAnchor`).
    private func deliver(_ kind: DeliveredDecisionCard.Kind,
                         placement: DeliveredDecisionCard.Placement) {
        let card = DeliveredDecisionCard(kind: kind, placement: placement)
        guard !closedCards.contains(card.id), !decisionCards.contains(where: { $0.id == card.id })
        else { return }
        decisionCards.append(card)
    }

    /// Put the answers this project's read publishes into the conversation as records, and let go of
    /// the question each one answers.
    ///
    /// The receipt is the record of what the owner did — drawn where the decision HAPPENED, the last
    /// item at or before the door's own clock — and it survives a relaunch that never saw the card,
    /// which the in-memory line it replaces did not (the account owner's report, 2026-09-16, about
    /// the browser client, whose receipt was state in the page for the same reason).
    ///
    /// The question card is dropped in the same pass rather than left to dim into "answered at
    /// another end": the record says which way it went, which is the thing the dimmed card could not
    /// say (the owner's complaint of 2026-09-11), and two rows about one answer is one row too many.
    /// A question whose answer the read does NOT name keeps its card, dimmed, and that heading is
    /// then the only thing left that can explain what happened to it.
    ///
    /// Anchors are captured once: a receipt already delivered keeps the place it was given, so a
    /// read coming round again cannot walk it down the conversation. One whose moment is older than
    /// everything loaded leads at the HEAD of the window — see `ReceiptAnchor.Placement`.
    private func adoptReceipts(_ queue: PendingCriteriaDecisionQueue) {
        let receipts = CriteriaDecisions.receipts(queue: queue)
        let answered = Set(receipts.map(\.settled.intentId))
        guard !answered.isEmpty else { return }
        decisionCards.removeAll { card in
            guard case .criteriaDecision(let intentID) = card.kind else { return false }
            return answered.contains(intentID)
        }
        for receipt in receipts where !decisionCards.contains(where: { $0.id == receipt.id }) {
            decisionCards.append(DeliveredDecisionCard(
                kind: .criteriaDecisionReceipt(settled: receipt.settled),
                placement: .at(receipt.moment)))
        }
    }

    /// The same, for the revisions THIS session has already answered — evidence decisions, whose
    /// read publishes them scoped to the deciding session (`decided`).
    ///
    /// One adoption per refresh, anchored once and never re-aimed, and the question card of each
    /// answered revision is let go of: the receipt says which way it went, which is the thing a
    /// dimmed card could not say. A revision the read does not name keeps its card.
    private func adoptEvidenceReceipts(_ queue: EvidenceDecisionQueue) {
        let receipts = EvidenceDecisions.receipts(queue: queue)
        let answered = Set(receipts.map { "\($0.decided.taskId)@\($0.decided.evidenceRevision)" })
        guard !answered.isEmpty else { return }
        decisionCards.removeAll { card in
            guard case .evidenceDecision(let taskID, let evidenceRevision) = card.kind else {
                return false
            }
            return answered.contains("\(taskID)@\(evidenceRevision)")
        }
        for receipt in receipts where !decisionCards.contains(where: { $0.id == receipt.id }) {
            decisionCards.append(DeliveredDecisionCard(
                kind: .evidenceDecisionReceipt(decided: receipt.decided),
                placement: .at(receipt.moment)))
        }
    }

    /// The same, for the one confirmation a project has: the answer this read publishes is drawn as
    /// a record where it was made — who signed it, and which seal — instead of as the line a press
    /// used to leave, which lasted exactly as long as this console did.
    ///
    /// The question card is NOT dropped here, unlike the answered proposal's. The record says which
    /// way ITS answer went, and for a confirmation made at another end that is the card's own
    /// business to say: it goes stale in place, with the reason above its dead button, rather than
    /// vanishing mid-read. A press made HERE has already closed the card, so nothing is left to
    /// take away — this only adds.
    private func adoptAcceptanceReceipt() {
        guard let receipt = AcceptanceConfirmations.receipt(standing: acceptanceConfirmation)
        else { return }
        guard !closedCards.contains(receipt.id),
              !decisionCards.contains(where: { $0.id == receipt.id }) else { return }
        decisionCards.append(DeliveredDecisionCard(
            kind: .acceptanceConfirmationReceipt(confirmed: receipt.confirmation),
            placement: .at(receipt.moment)))
    }

    /// The same, for the decisions this session's runs have already recorded: each drawn where it
    /// was DECIDED, off the door's own clock (`OwnerConfirmations.receipts`).
    ///
    /// These used to be delivered as cards, which placed them where this DEVICE read the answer —
    /// the same place as the decision only on the console that was there to see it. Everywhere else
    /// it stacked the history under the newest row: the account owner's iOS screenshot, 2026-09-20,
    /// three `Decision recorded` cards at the bottom of a conversation that had run for a day after
    /// them. The question card is untouched by this — its arrival is somebody else's clock, which is
    /// what `DeliveryAnchor` says — and so is a decision the read stops publishing: a row already
    /// adopted keeps its place, for `adoptReceipts`' reason.
    private func adoptOwnerReceipts(_ read: OwnerConfirmationView) {
        for receipt in OwnerConfirmations.receipts(read, sessionID: sessionID) {
            guard !closedCards.contains(receipt.id),
                  !decisionCards.contains(where: { $0.id == receipt.id }) else { continue }
            decisionCards.append(DeliveredDecisionCard(
                kind: .ownerDecisionReceipt(taskID: receipt.taskId, decisionID: receipt.decided.id),
                placement: .at(receipt.moment)))
        }
    }

    /// The same, for the merges this project has already made: each drawn where it HAPPENED, off the
    /// merge's own clock (`PromotionCards.receipts`).
    ///
    /// This is the fifth of the five records placed that way, and the last to be: the merge's receipt
    /// was drawn by the card strip off the candidate on offer, so it sat at the bottom of the pane
    /// for the life of the project — and once the branch was offered again, the same strip described
    /// a different merge in the same place. The card that ASKED for a merge is let go of by the read
    /// that says it merged (`refreshRulerQuestions`), which is where the strip stops drawing it; what
    /// is adopted here is the record that replaces it. A merge whose moment is older than everything
    /// loaded leads at the HEAD of the window — see `ReceiptAnchor.Placement`.
    private func adoptPromotionReceipts(_ merged: [ProjectPromotionView]) {
        for receipt in PromotionCards.receipts(merged: merged) {
            guard !closedCards.contains(receipt.id),
                  !decisionCards.contains(where: { $0.id == receipt.id }) else { continue }
            decisionCards.append(DeliveredDecisionCard(
                kind: .promotionReceipt(promotion: receipt.promotion),
                placement: .at(receipt.moment)))
        }
    }

    /// Where one delivered proposal stands right now — the whole of what decides whether its
    /// buttons may be pressed, and never a frame this card kept.
    func criteriaStanding(_ intentID: String) -> CriteriaDecisionStanding {
        CriteriaDecisions.standing(queue: criteriaDecisions, intentId: intentID)
    }

    /// Answer one held proposal, with this device's own credential and the proposal's one-time key.
    ///
    /// The card is NOT dropped optimistically, unlike an approval: the interesting outcomes here
    /// are the door's refusals, and a card that vanished before the answer landed would take the
    /// explanation with it. It goes when the door says it went.
    func decideCriteria(_ row: PendingCriteriaDecisionRow, _ decision: CriteriaDecisionAnswer) async {
        guard let projectID else { return }
        do {
            _ = try await api.decideCriteriaChange(
                projectID: projectID, intentID: row.intentId,
                CriteriaDecisions.request(row: row, decision: decision))
            close(.criteriaDecision(intentID: row.intentId))
            // The card that was answered HERE gives way to its receipt, which the re-read below
            // draws where the decision happened (`adoptReceipts`). Nothing is written locally: left
            // as a card it would go stale into "answered at another end" — the one reading of its
            // own answer this window can be sure is wrong — and left as an in-memory line it would
            // not survive the console being opened again.
        } catch {
            statusMessage = "That decision was not recorded — \(APIClient.failureReason(error))."
        }
        await refreshRulerQuestions(force: true)
    }

    /// Re-read what this conversation's task is waiting on from its owner.
    ///
    /// A read of its own, beside the project's questions rather than inside them: an OWNER_CONFIRMED
    /// task may be filed under no project at all, and its run's session still owes its owner the
    /// card. Nothing here needs a project, so nothing here may be gated on one.
    ///
    /// What it may never do is remove a card: a read that fails leaves the standing `unread`, which
    /// is a card saying it could not check — and a card that vanished mid-read is indistinguishable,
    /// to the person reading it, from a render that broke.
    func refreshOwnerConfirmation(force: Bool = false) async {
        guard !isDraft, let taskID, !loadingOwnerConfirmation else { return }
        if !force, Date().timeIntervalSince(lastOwnerRead) < Self.rulerReadThrottle { return }
        loadingOwnerConfirmation = true
        defer { loadingOwnerConfirmation = false }

        if let read = try? await api.ownerConfirmation(taskID: taskID) {
            ownerConfirmation = read
            if let waiting = OwnerConfirmations.waitingIn(read, sessionID: sessionID) {
                deliver(.ownerConfirmation(taskID: taskID, requestID: waiting.requestId))
            }
            // The receipts this conversation has recorded — from the read rather than from the
            // press, so a reload or another device shows them too. Each is drawn where it was
            // DECIDED (`adoptOwnerReceipts`), and the line names that moment itself
            // ("Confirm done · rev 2 · 19/9/26, 11:47 AM").
            adoptOwnerReceipts(read)
        }
        lastOwnerRead = Date()
    }

    /// Where one delivered confirmation card stands right now — re-derived from the read on every
    /// call, never a frame the card kept.
    func ownerStanding(_ taskID: String, _ requestID: String) -> OwnerConfirmationStanding {
        OwnerConfirmations.standing(ownerConfirmation, sessionID: sessionID, requestID: requestID)
    }

    /// The receipt one recorded decision draws, when the read still publishes it.
    func ownerReceipt(_ taskID: String, _ decisionID: String) -> RecordedOwnerDecision? {
        OwnerConfirmations.receipt(ownerConfirmation, decisionID: decisionID)
    }

    /// Answer the question this conversation's task is waiting on, at the owner-confirmation door
    /// with this device's own credential — no agent between the press and the door, and no session
    /// header on the request (the door refuses any that carries one).
    ///
    /// Not dropped optimistically, for the reason `decideEvidence` gives: the door's refusals are
    /// the outcomes worth explaining, and the re-read below is what explains them. The receipt the
    /// answer leaves comes back with that read, so what is drawn is the record rather than a guess.
    func decideOwnerConfirmation(_ waiting: OwnerConfirmationWaiting, _ decision: OwnerDecision,
                                 note: String? = nil) async {
        guard let taskID,
              let request = OwnerConfirmations.request(waiting: waiting, decision: decision,
                                                       note: note) else { return }
        do {
            _ = try await api.decideOwnerConfirmation(taskID: taskID, request)
            close(.ownerConfirmation(taskID: taskID, requestID: waiting.requestId))
            // Left on screen, the card would go stale into "a later report is waiting", which is
            // the one reading of its own answer this window can be sure is wrong.
            appendDecisionLine(decision == .confirm
                               ? OwnerConfirmations.confirmedHeading
                               : OwnerConfirmations.sentBackHeading)
        } catch {
            // A refusal for staleness is said as such: the card stays and re-derives, and the
            // sentence tells the reader which refusal the press met rather than "it failed".
            let title = OwnerConfirmations.refusalTitle(code: APIClient.refusalCode(error))
            statusMessage = "\(title) — \(APIClient.failureReason(error))."
        }
        await refreshOwnerConfirmation(force: true)
    }

    /// Where one delivered evidence card stands right now — re-derived from the read on every call,
    /// never a frame the card kept.
    func evidenceStanding(_ taskID: String, _ evidenceRevision: String) -> EvidenceDecisionStanding {
        EvidenceDecisions.standing(queue: evidenceDecisions, projectId: projectID, taskId: taskID,
                                   evidenceRevision: evidenceRevision)
    }

    /// Answer one revision of a task's evidence at the decision door, FROM this session and with
    /// this device's own credential.
    ///
    /// Not dropped optimistically, for the reason `decideCriteria` gives: the door's refusals are
    /// the outcomes worth explaining, and the re-read below is what explains them.
    func decideEvidence(_ row: EvidenceDecisionRow, _ decision: EvidenceDecisionAnswer,
                        note: String? = nil) async {
        guard let request = EvidenceDecisions.request(row: row, decision: decision, note: note,
                                                      decidingSessionID: sessionID) else { return }
        do {
            _ = try await api.decideEvidence(taskID: row.taskId, request)
            close(.evidenceDecision(taskID: row.taskId, evidenceRevision: row.evidenceRevision))
            // The card gives way to its receipt, which the re-read below draws where the decision
            // happened (`adoptEvidenceReceipts`) — and which survives the console being opened
            // again, unlike the in-memory line it replaces.
        } catch {
            statusMessage = "That decision was not recorded — \(APIClient.failureReason(error))."
        }
        await refreshRulerQuestions(force: true)
    }

    /// Confirm the standard set as it stands. The digest is what makes this a confirmation of the
    /// wording just read: an edit landing in between is refused rather than signed unread.
    ///
    /// What the press leaves in the conversation is the RECORD, drawn from the door's own reads by
    /// the refresh below (`adoptAcceptanceReceipt`) and not written here: a line left by the window
    /// that pressed is the one thing that does not survive the console being opened again, which is
    /// what the criteria decision next door was fixed for on 2026-09-16.
    func confirmStandardSet() async {
        guard let projectID, let digest = acceptanceConfirmation?.currentVersion.digest else { return }
        do {
            let standing = try await api.confirmAcceptanceCriteria(projectID: projectID,
                                                                   criteriaDigest: digest)
            acceptanceConfirmation = standing
            close(.acceptanceConfirmation)
        } catch {
            statusMessage = "That confirmation was not recorded — \(APIClient.failureReason(error))."
        }
        await refreshRulerQuestions(force: true)
    }

    // MARK: the project's two owner cards — the merge to confirm, and the question it asked

    /// The owner card a "needs you" press is on its way to, until its row exists to scroll to.
    ///
    /// The press arrives before the read does: the bar is derived from the session LIST, which
    /// carries the items, while the card is drawn from this conversation's own read of them. So the
    /// press is remembered and spent by the first read that produces its row — and dropped if that
    /// read says the card is not here, because a scroll to a row nothing draws is a silent no-op
    /// that would leave the reader looking at wherever they happened to be.
    private var pendingOwnerItem: SessionOwnerItem?

    /// Point this conversation at one of the four owner items (§7.6 V13). Called by the banner's
    /// press, which knows which item it named.
    func focus(ownerItem: SessionOwnerItem) {
        pendingOwnerItem = ownerItem
        // Spent by the read below and never here, even when the card is already on screen: this
        // runs BEFORE the navigation that puts the console on screen, and a scroll requested while
        // no view is listening is a scroll nobody makes — and the request, once spent, would not
        // come back. The read is a round-trip, so by the time it answers the console is mounted.
        Task { await refreshRulerQuestions(force: true) }
    }

    /// Spend the pending press, if the card it names is on screen now.
    private func scrollToPendingOwnerItem() {
        guard let item = pendingOwnerItem, let rowID = rowID(forOwnerItem: item) else { return }
        pendingOwnerItem = nil
        requestScroll(to: rowID)
    }

    /// Which row draws one owner item here: the question by its own address, and a merge approval
    /// by the candidate on screen — a project has at most one live candidate, and the item names
    /// the card rather than the candidate.
    private func rowID(forOwnerItem item: SessionOwnerItem) -> String? {
        switch item.kind {
        case .coordinatorQuestion:
            let id = DeliveredDecisionCard(kind: .coordinatorQuestion(itemID: item.itemId)).id
            return decisionCards.contains { $0.id == id } ? id : nil
        case .promotionApproval:
            return decisionCards.first {
                if case .promotionApproval = $0.kind { return true }
                return false
            }?.id
        // The exception that became the owner's, and the pause they lift: both by their own item's
        // id, which is the address the card was delivered under (`ExceptionCards.cards`). A pause
        // is drawn as the pause card because that is the card it is; every other item the owner's
        // group holds is the escalation one.
        case .escalated:
            let id = DeliveredDecisionCard(kind: .escalatedItem(itemID: item.itemId)).id
            return decisionCards.contains { $0.id == id } ? id : nil
        case .fusePaused:
            let id = DeliveredDecisionCard(kind: .fusePause(itemID: item.itemId)).id
            return decisionCards.contains { $0.id == id } ? id : nil
        case .unknown:
            return nil
        }
    }


    /// Where one delivered question stands right now, re-derived from the read on every call.
    func questionStanding(_ itemID: String) -> CoordinatorQuestionStanding {
        CoordinatorQuestions.standing(items: openItems, itemId: itemID)
    }

    /// The same for one delivered exception card, from the same read.
    func ownerItemStanding(_ itemID: String) -> OwnerItemStanding {
        ExceptionCards.standing(items: openItems, itemId: itemID)
    }

    /// The candidate one delivered merge card is about, or nil when the read no longer publishes
    /// it: a newer candidate superseded this one, and a card that drew the new candidate's numbers
    /// under the old one's question would be describing a merge nobody was asked about.
    func promotionStanding(_ promotionID: String) -> ProjectPromotionView? {
        promotion?.promotionId == promotionID ? promotion : nil
    }

    /// How much of this project's ruler the work has met, for the merge card's Criteria row. Nil
    /// until the criteria have been read — "0 of 0 met" would be a claim nobody checked.
    var criteriaMet: (met: Int, total: Int)? {
        guard !projectCriteria.isEmpty else { return nil }
        return (projectCriteria.filter { $0.satisfied == true }.count, projectCriteria.count)
    }

    /// Answer the coordinator's question, with this device's own credential — no agent between the
    /// press and the door, and no session header on the request (§5.2 R10).
    ///
    /// The receipt is handed back rather than kept here: the card that made the press is the one
    /// that shows what was sent and where it went, which is also what the browser's card does. A
    /// refusal leaves the card standing and says which refusal it met.
    func answerQuestion(_ row: ProjectOpenItemRow, option: Int?, text: String) async -> OwnerAnswerReceipt? {
        guard let projectID, let question = row.question,
              let request = CoordinatorQuestions.request(question: question, chosen: option, text: text)
        else { return nil }
        do {
            let receipt = try await api.answerOpenItem(projectID: projectID, itemID: row.itemId,
                                                       request)
            await refreshRulerQuestions(force: true)
            return receipt
        } catch {
            statusMessage = "That answer was not recorded — \(APIClient.failureReason(error))."
            return nil
        }
    }

    /// Ask the coordinator again (§4.7, mock 5): the item goes back to the conversation that
    /// should have had it, with the project's clock for it restarted. Nothing is retried and
    /// nothing ends here — what the coordinator does about it is the coordinator's.
    ///
    /// The receipt is handed back rather than kept: the card that made the press is the one that
    /// shows what was sent and where it went, exactly as the question card does. A refusal leaves
    /// the card standing and says which refusal it met.
    func returnEscalatedItem(_ row: ProjectOpenItemRow) async -> OpenItemReturned? {
        guard let projectID else { return nil }
        do {
            let receipt = try await api.returnOpenItemToCoordinator(projectID: projectID,
                                                                    itemID: row.itemId)
            await refreshRulerQuestions(force: true)
            return receipt
        } catch {
            statusMessage = "\(ExceptionCards.notReturned) — \(APIClient.failureReason(error))."
            return nil
        }
    }

    /// Mark an exception as handled by hand, with the reason the door requires (§4.7, mock 7 方案 B).
    /// The owner's ending for an item nobody has to act on any more — and the reason is the whole of
    /// what the record gains, because nothing on the line could verify the ending for itself.
    ///
    /// The press is refused here rather than sent and refused, for the same reason the browser holds
    /// the same line: a reason the door would reject is not a press, and the field it came from is
    /// still on screen when this returns nil.
    func markItemHandled(_ row: ProjectOpenItemRow, note: String) async -> OpenItemResolved? {
        guard let projectID, let request = ExceptionCards.markHandledRequest(note) else { return nil }
        do {
            let receipt = try await api.resolveOpenItem(projectID: projectID, itemID: row.itemId,
                                                        request)
            await refreshRulerQuestions(force: true)
            return receipt
        } catch {
            statusMessage = "\(ExceptionCards.notMarkedHandled) — \(APIClient.failureReason(error))."
            return nil
        }
    }

    /// Lift the pause (§6.3 F-T4, mock 6 ①) — the owner's alone, and the one press that starts a
    /// stopped conversation again. The episode the card was drawn from rides along, so a press
    /// made after the pause was lifted is refused by the door rather than resuming the next one.
    func resumeFuse(_ row: ProjectOpenItemRow) async -> FuseResumed? {
        guard let projectID, let episodeID = row.fuseEpisodeId else { return nil }
        do {
            let resumed = try await api.resumeProjectFuse(projectID: projectID, episodeID: episodeID)
            await refreshRulerQuestions(force: true)
            return resumed
        } catch {
            statusMessage = "\(ExceptionCards.notResumed) — \(APIClient.failureReason(error))."
            return nil
        }
    }

    /// M-T4: merge it. The candidate's own source SHA rides along, so a card rendered before a
    /// newer candidate superseded it is refused rather than merging whatever is on the branch now.
    ///
    /// The card is not dropped: the interesting outcomes are the door's refusals and the states
    /// that follow (it goes to CONFIRMED, then RECHECKING or MERGED), and the card is where a
    /// reader watches that happen.
    func confirmMergeToMain(_ view: ProjectPromotionView) async {
        guard let projectID else { return }
        do {
            promotion = try await api.confirmPromotion(projectID: projectID,
                                                       promotionID: view.promotionId,
                                                       sourceSha: view.sourceSha)
        } catch {
            statusMessage = "That merge was not confirmed — \(APIClient.failureReason(error))."
        }
        await refreshRulerQuestions(force: true)
    }

    /// M-T10: call it back, while the landing job has not reached the push. The card stays: what
    /// the door answers is the state it left the candidate in, which is what the reader watches.
    func cancelMergeToMain(_ view: ProjectPromotionView) async {
        guard let projectID else { return }
        do {
            promotion = try await api.cancelPromotion(projectID: projectID,
                                                      promotionID: view.promotionId)
        } catch {
            statusMessage = "That merge was not called back — \(APIClient.failureReason(error))."
        }
        await refreshRulerQuestions(force: true)
    }

    /// M-T5: not now. The branch is left exactly where it is, and the next landing offers it again.
    func declineMergeToMain(_ view: ProjectPromotionView) async {
        guard let projectID else { return }
        do {
            promotion = try await api.declinePromotion(projectID: projectID,
                                                       promotionID: view.promotionId)
            close(.promotionApproval(promotionID: view.promotionId))
        } catch {
            statusMessage = "That was not recorded — \(APIClient.failureReason(error))."
        }
        await refreshRulerQuestions(force: true)
    }

    private func close(_ kind: DeliveredDecisionCard.Kind) {
        let id = DeliveredDecisionCard(kind: kind).id
        closedCards.insert(id)
        decisionCards.removeAll { $0.id == id }
    }

    /// What a decision leaves behind, in the flow, where it happened — the same place web's
    /// `DecisionLog` line goes. "Now it is true" is a fact about the project; "this is what
    /// happened" is an event in this conversation.
    private func appendDecisionLine(_ line: String) {
        let card = LocalStatusCard(rows: [ComposerStatusRow(label: "Decision", value: line)],
                                   afterItemID: state.items.last?.id)
        localStatusCards = Array((localStatusCards + [card]).suffix(5))
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
        reducer.seedBackground(dtos.map { $0.asBackgroundProc() }, progress: dtos.compactMap(\.taskProgress))
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

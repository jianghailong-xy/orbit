import Foundation
import Observation
import OrbitKit

/// Per-instance cache of open-session consoles, backed by an on-disk transcript store.
///
/// Why it exists: switching sessions used to tear the console down (`.id(sessionID)`) and rebuild
/// it — a fresh `ConsoleModel`, a fresh SSE stream replaying the whole transcript from seq 0, and a
/// spinner flash. Under fast arrow-key navigation that fired one full replay per fly-by session.
///
/// Here instead, a `ConsoleModel` is reused (instant warm render; its stream simply resumes from
/// `maxSeq`), least-recently-used consoles are evicted to disk and rehydrated on return, and the
/// transcript survives an app restart. Only the focused session streams — non-focused consoles keep
/// their state but pause. The eviction policy (`LRUOrder`) and the file store (`FileTranscriptStore`)
/// are pure OrbitKit pieces, unit-tested on Linux.
@MainActor
@Observable
final class ConsoleRegistry {
    private let baseURL: URL
    private let tokenStore: TokenStore
    private let store: TranscriptPersisting
    /// Shared image cache for user-turn attachments, injected into the transcript (one per instance
    /// so a session switch doesn't re-fetch). Seeded on send for an instant sent-image preview.
    let attachments: AttachmentImageStore
    /// Where a console's fleeting confirmations go — the app's toast host. Set once by `AppModel` and
    /// handed to every console this registry makes, so a `ConsoleModel` needn't know about `AppModel`.
    /// The session id rides along so the toast can be tapped back into the session it reports on; a
    /// draft console has none yet, so it passes nil.
    @ObservationIgnored var onToast: (ToastRequest, String?) -> Void = { _, _ in }

    private var models: [String: ConsoleModel] = [:]
    /// The one session whose SSE stream is currently running (at most one), or nil when no console is
    /// focused. Driven by `focus(_:agentID:)` off the app's focus state.
    private var streamingSessionID: String?
    private var lru: LRUOrder
    /// `maxSeq` last written to disk per session — lets `persist` skip no-op saves.
    private var savedSeq: [String: Int] = [:]

    init(baseURL: URL, tokenStore: TokenStore, store: TranscriptPersisting, capacity: Int = 12) {
        self.baseURL = baseURL
        self.tokenStore = tokenStore
        self.store = store
        self.attachments = AttachmentImageStore(baseURL: baseURL, tokenStore: tokenStore)
        self.lru = LRUOrder(capacity: capacity)
    }

    /// Application Support/Orbit/Transcripts/<host> — scoped per instance so two servers never
    /// collide. Falls back to a temp dir if Application Support is unavailable.
    static func defaultStore(for baseURL: URL) -> FileTranscriptStore {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let host = baseURL.host ?? "default"
        let dir = support.appendingPathComponent("Orbit/Transcripts/\(host)", isDirectory: true)
        return FileTranscriptStore(directory: dir)
    }

    /// The console for `sessionID`, hydrated from disk on first use. Marks it most-recently-used and
    /// evicts (persisting first) any console pushed past capacity. Mutates the cache — call from a
    /// `.task` / event handler, never from a view `body` (use `peek` there).
    func model(for sessionID: String, agentID: String? = nil) -> ConsoleModel {
        let model = models[sessionID] ?? makeModel(sessionID, agentID: agentID)
        models[sessionID] = model
        for evicted in lru.use(sessionID) { evict(evicted) }
        return model
    }

    /// A throwaway draft console for composing a brand-new session for `agent`: it runs no stream,
    /// and its `send()` calls `createSession`, reporting the result via `onCreated` so the caller can
    /// open the live console. Shares the instance attachment cache so a pasted image previews
    /// instantly once that console opens. Not added to `models` — there's no sessionID to key it by.
    func draftModel(for agent: Agent, defaultModel: String,
                    configuredProviders: [ConfiguredProvider] = [],
                    configuredProvidersLoaded: Bool = false,
                    modelCatalog: RunnerModelCatalog? = nil,
                    onCreated: @escaping (Session) -> Void) -> ConsoleModel {
        let model = ConsoleModel(draftFor: agent, defaultModel: defaultModel,
                                 configuredProviders: configuredProviders,
                                 configuredProvidersLoaded: configuredProvidersLoaded,
                                 modelCatalog: modelCatalog,
                                 baseURL: baseURL, tokenStore: tokenStore, attachments: attachments)
        model.onSessionCreated = onCreated
        model.onToast = { [weak self] request in self?.onToast(request, nil) }
        return model
    }

    /// Non-mutating lookup, safe inside a view `body`. Non-nil once `model(for:)` has run (the
    /// debounced activation pre-warms it), so the detail pane renders the warm transcript with no
    /// spinner.
    func peek(_ sessionID: String) -> ConsoleModel? { models[sessionID] }

    /// Make `sessionID` the single streaming console: start its live SSE loop and stop whichever one
    /// was streaming before. Pass nil (leaving a console for its list) to stop all streams. Idempotent
    /// — re-focusing the streaming session is a no-op. Driven by the app's focus STATE (see
    /// `AppModel.syncConsoleFocus`), NOT SwiftUI view lifecycle, so a console view SwiftUI happens to
    /// keep cached still has its stream stopped the moment it stops being focused — the connection
    /// can't linger. Mutates the cache; call from an event handler, never a view `body`.
    func focus(_ sessionID: String?, agentID: String? = nil) {
        guard sessionID != streamingSessionID else { return }
        if let prev = streamingSessionID { models[prev]?.stopStreaming() }
        streamingSessionID = sessionID
        guard let sessionID else { return }
        model(for: sessionID, agentID: agentID).startStreaming()   // hydrate + mark MRU, then stream
    }

    /// Persist a session's transcript if it advanced since the last write. Called for the focused
    /// session on the poll cadence (so a crash loses at most a few seconds) and when leaving it.
    func flush(_ sessionID: String?) {
        guard let sessionID, let model = models[sessionID] else { return }
        persist(sessionID, model, synchronously: false)
    }

    /// Persist every cached console (sign-out / app backgrounded). Synchronous by design — see
    /// `persist`: iOS may suspend the process the moment the `.background` handler returns.
    func persistAll() {
        for (id, model) in models { persist(id, model) }
    }

    /// Nudge every cached console to reconnect its live stream now — called when the app returns to
    /// the foreground, where a socket suspended in the background can be dead but not yet erroring.
    /// Only the focused console has a running stream loop; for the rest this sets a flag that's
    /// cleared the next time they run, so it's a harmless no-op.
    func reconnectAll() {
        for model in models.values { model.reconnectNow() }
    }

    /// Drop all in-memory consoles after persisting them (sign-out). Disk snapshots remain for the
    /// next sign-in.
    func reset() {
        persistAll()
        for model in models.values { model.stopStreaming() }
        streamingSessionID = nil
        models.removeAll()
        savedSeq.removeAll()
        lru = LRUOrder(capacity: lru.capacity)
    }

    /// Forget a session the server authoritatively says no longer exists (a cross-client purge).
    /// Unlike normal LRU eviction this deliberately does not persist first: keeping that transcript
    /// on disk would let a later route rehydrate a permanently deleted ghost.
    func discardMissing(_ sessionID: String) {
        models[sessionID]?.stopStreaming()
        if streamingSessionID == sessionID { streamingSessionID = nil }
        models[sessionID] = nil
        savedSeq[sessionID] = nil
        lru.remove(sessionID)
        store.remove(sessionID: sessionID)
    }

    // MARK: - internals

    private func makeModel(_ sessionID: String, agentID: String?) -> ConsoleModel {
        let restored = store.load(sessionID: sessionID)
        if let restored { savedSeq[sessionID] = restored.state.maxSeq }
        let model = ConsoleModel(sessionID: sessionID, agentID: agentID, baseURL: baseURL,
                                 tokenStore: tokenStore, attachments: attachments, restoring: restored)
        model.onToast = { [weak self] request in self?.onToast(request, sessionID) }
        return model
    }

    /// Snapshot a console's reducer and write it, unless nothing advanced since the last write.
    ///
    /// `synchronously: false` hands the write to a background task. Encoding a whole transcript to
    /// JSON and writing it is tens of milliseconds on a long session, and the focused console repeats
    /// it every few seconds for as long as that session streams — that does not belong on the main
    /// actor. The reducer is a `Sendable` value copy, so the task works on a stable snapshot even as
    /// the live one keeps folding in events. Two writes for the same session can in principle land out
    /// of order, which at worst leaves the on-disk *cache* a few seconds behind — reopening then
    /// resumes the stream from the older `maxSeq` and re-fetches the difference, so nothing is lost.
    ///
    /// The default stays synchronous for the paths that must complete before the process can go away
    /// (`persistAll` at `.background` / sign-out).
    private func persist(_ sessionID: String, _ model: ConsoleModel, synchronously: Bool = true) {
        let reducer = model.snapshotReducer()
        guard savedSeq[sessionID] != reducer.state.maxSeq else { return }   // nothing new durable
        // Claimed before the write, so a later tick can't queue a second write of the same state.
        // A failed write was already indistinguishable from a successful one (the store swallows it)
        // and self-heals on the next advance.
        savedSeq[sessionID] = reducer.state.maxSeq
        guard !synchronously else {
            store.save(sessionID: sessionID, reducer: reducer)
            return
        }
        let store = self.store   // capture the Sendable store, never `self` (main-actor isolated)
        Task.detached(priority: .utility) {
            store.save(sessionID: sessionID, reducer: reducer)
        }
    }

    private func evict(_ sessionID: String) {
        // Off-main too: eviction happens while navigating between sessions, which is exactly when the
        // main thread is busy laying out the console being opened.
        if let model = models[sessionID] {
            persist(sessionID, model, synchronously: false)
            model.stopStreaming()
        }
        if streamingSessionID == sessionID { streamingSessionID = nil }
        models[sessionID] = nil
    }
}

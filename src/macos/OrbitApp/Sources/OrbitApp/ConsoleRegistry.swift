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

    private var models: [String: ConsoleModel] = [:]
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
    func draftModel(for agent: Agent, onCreated: @escaping (Session) -> Void) -> ConsoleModel {
        let model = ConsoleModel(draftFor: agent, baseURL: baseURL, tokenStore: tokenStore,
                                 attachments: attachments)
        model.onSessionCreated = onCreated
        return model
    }

    /// Non-mutating lookup, safe inside a view `body`. Non-nil once `model(for:)` has run (the
    /// debounced activation pre-warms it), so the detail pane renders the warm transcript with no
    /// spinner.
    func peek(_ sessionID: String) -> ConsoleModel? { models[sessionID] }

    /// Persist a session's transcript if it advanced since the last write. Called for the focused
    /// session on the poll cadence (so a crash loses at most a few seconds) and when leaving it.
    func flush(_ sessionID: String?) {
        guard let sessionID, let model = models[sessionID] else { return }
        persist(sessionID, model)
    }

    /// Persist every cached console (sign-out / app backgrounded).
    func persistAll() {
        for (id, model) in models { persist(id, model) }
    }

    /// Drop all in-memory consoles after persisting them (sign-out). Disk snapshots remain for the
    /// next sign-in.
    func reset() {
        persistAll()
        models.removeAll()
        savedSeq.removeAll()
        lru = LRUOrder(capacity: lru.capacity)
    }

    // MARK: - internals

    private func makeModel(_ sessionID: String, agentID: String?) -> ConsoleModel {
        let restored = store.load(sessionID: sessionID)
        if let restored { savedSeq[sessionID] = restored.state.maxSeq }
        return ConsoleModel(sessionID: sessionID, agentID: agentID, baseURL: baseURL,
                            tokenStore: tokenStore, attachments: attachments, restoring: restored)
    }

    private func persist(_ sessionID: String, _ model: ConsoleModel) {
        let reducer = model.snapshotReducer()
        guard savedSeq[sessionID] != reducer.state.maxSeq else { return }   // nothing new durable
        store.save(sessionID: sessionID, reducer: reducer)
        savedSeq[sessionID] = reducer.state.maxSeq
    }

    private func evict(_ sessionID: String) {
        if let model = models[sessionID] { persist(sessionID, model) }
        models[sessionID] = nil
    }
}

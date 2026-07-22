import Foundation

/// Persists per-session transcript snapshots so switching sessions is instant (rehydrate the
/// cached reducer instead of replaying the whole stream from `seq 0`) and history survives an app
/// restart. A protocol so the cache can be unit-tested against an in-memory double.
public protocol TranscriptPersisting: Sendable {
    func load(sessionID: String) -> TranscriptReducer?
    func save(sessionID: String, reducer: TranscriptReducer)
    func remove(sessionID: String)
    /// Session ids that have a snapshot on disk, newest-written first.
    func storedSessionIDs() -> [String]
}

/// One JSON file per session under a per-instance directory. Foundation-only (no SQLite, no extra
/// dependency), so it builds and unit-tests on Linux alongside the reducer. Writes are atomic and
/// the directory is capped at `maxFiles` — the oldest snapshots are pruned by modification time.
public struct FileTranscriptStore: TranscriptPersisting {
    public let directory: URL
    private let maxFiles: Int
    private static let schemaVersion = 3

    public init(directory: URL, maxFiles: Int = 200) {
        self.directory = directory
        self.maxFiles = max(1, maxFiles)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// Versioned envelope: a reducer-shape change bumps `schemaVersion`, and stale files decode
    /// to nil (discarded → the session simply re-fetches its tail page and streams from there).
    /// v2: `TranscriptState` gained the history-window cursor (`oldestSeq`/`hasMoreOlder`); a v1
    /// snapshot would rehydrate without one and leave scroll-up paging permanently dead for that
    /// session, so spend one cheap tail re-fetch instead.
    /// v3: context usage can arrive on non-`turn_end` events; old snapshots may have cached 0/nil
    /// after seeing the relevant seq, so force one tail re-fetch.
    private struct Envelope: Codable { var version: Int; var reducer: TranscriptReducer }

    public func load(sessionID: String) -> TranscriptReducer? {
        guard let data = try? Data(contentsOf: url(for: sessionID)),
              let env = try? JSONDecoder().decode(Envelope.self, from: data),
              env.version == Self.schemaVersion else { return nil }
        return env.reducer
    }

    public func save(sessionID: String, reducer: TranscriptReducer) {
        let env = Envelope(version: Self.schemaVersion, reducer: reducer)
        guard let data = try? JSONEncoder().encode(env) else { return }
        // `.atomic` writes to a temp file then renames, so a crash mid-write never leaves a
        // half-written file that fails to decode and loses the session.
        try? data.write(to: url(for: sessionID), options: .atomic)
        prune()
    }

    public func remove(sessionID: String) {
        try? FileManager.default.removeItem(at: url(for: sessionID))
    }

    public func storedSessionIDs() -> [String] {
        filesByModDate().map { $0.deletingPathExtension().lastPathComponent }
    }

    // MARK: - internals

    private func url(for sessionID: String) -> URL {
        directory.appendingPathComponent(sanitize(sessionID)).appendingPathExtension("json")
    }

    /// Session ids are server UUIDs, but stay defensive: never let one escape the directory.
    private func sanitize(_ id: String) -> String {
        let ok = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        return String(id.map { ok.contains($0) ? $0 : "_" })
    }

    private func modDate(_ u: URL) -> Date {
        (try? FileManager.default.attributesOfItem(atPath: u.path))?[.modificationDate] as? Date ?? .distantPast
    }

    /// All snapshot files, newest modification first.
    private func filesByModDate() -> [URL] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: directory.path) else { return [] }
        return names.filter { $0.hasSuffix(".json") }
            .map { directory.appendingPathComponent($0) }
            .sorted { modDate($0) > modDate($1) }
    }

    private func prune() {
        let files = filesByModDate()
        guard files.count > maxFiles else { return }
        for u in files[maxFiles...] { try? FileManager.default.removeItem(at: u) }
    }
}

/// Most-recently-used order for a bounded in-memory cache. Pure + `Sendable` so the eviction
/// policy is unit-tested in isolation; the cache (app layer) holds the actual model instances.
public struct LRUOrder: Sendable, Equatable {
    public private(set) var keys: [String] = []   // most-recent first
    public let capacity: Int

    public init(capacity: Int) { self.capacity = max(1, capacity) }

    /// Record a use of `key`, moving it to the front. Returns the keys evicted to stay within
    /// `capacity` (never the just-used `key`).
    public mutating func use(_ key: String) -> [String] {
        keys.removeAll { $0 == key }
        keys.insert(key, at: 0)
        guard keys.count > capacity else { return [] }
        let evicted = Array(keys[capacity...])
        keys.removeLast(keys.count - capacity)
        return evicted
    }

    public mutating func remove(_ key: String) {
        keys.removeAll { $0 == key }
    }
}

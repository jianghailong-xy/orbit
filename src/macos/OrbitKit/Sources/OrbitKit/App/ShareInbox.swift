import Foundation

// Share to Orbit, Apple hand-off (docs/share-to-orbit-design.md §3.1). The Share Extension has no
// token and makes no network call: it copies what was shared into the App Group container as one
// inbox entry, and the app claims that entry on open, stages each item through the composer's own
// attach path and then deletes it. Everything here is file-system only, so it builds and is tested
// on Linux; the App Group URL is the caller's (a temp directory in tests).

/// Where a share goes: an existing session, or a new-session draft in a workspace.
/// On disk it is `{"sessionId": …}` or `{"newIn": <workspaceId>}`.
public enum ShareTarget: Codable, Equatable, Sendable {
    case session(id: String)
    case newSession(workspaceId: String)

    private enum CodingKeys: String, CodingKey { case sessionId, newIn }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let id = try c.decodeIfPresent(String.self, forKey: .sessionId) {
            self = .session(id: id)
        } else if let workspace = try c.decodeIfPresent(String.self, forKey: .newIn) {
            self = .newSession(workspaceId: workspace)
        } else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath,
                                                    debugDescription: "target has neither sessionId nor newIn"))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .session(let id): try c.encode(id, forKey: .sessionId)
        case .newSession(let workspace): try c.encode(workspace, forKey: .newIn)
        }
    }
}

/// One shared item as the entry records it. `file` is the copy's name inside the entry's directory.
public struct ShareItem: Codable, Equatable, Sendable {
    public var file: String
    public var name: String
    public var mime: String
    public var bytes: Int64

    public init(file: String, name: String, mime: String, bytes: Int64) {
        self.file = file
        self.name = name
        self.mime = mime
        self.bytes = bytes
    }
}

/// `ShareInbox/<id>/entry.json`.
public struct ShareEntry: Codable, Equatable, Sendable {
    public var id: String
    public var createdAt: Date
    public var target: ShareTarget
    public var items: [ShareItem]
    public var note: String?

    public init(id: String, createdAt: Date, target: ShareTarget, items: [ShareItem], note: String?) {
        self.id = id
        self.createdAt = createdAt
        self.target = target
        self.items = items
        self.note = note
    }
}

/// An entry one caller has claimed: no other claimer can get it, and `list()` no longer shows it.
public struct ClaimedShareEntry: Equatable, Sendable {
    public var entry: ShareEntry
    /// The claimed entry's directory; the item copies are inside it.
    public var directory: URL

    /// Each item's copy, in entry order.
    public var itemURLs: [URL] { entry.items.map { directory.appendingPathComponent($0.file) } }
}

/// The inbox under a container directory (the App Group container on device).
///
/// Layout, all under `<root>/ShareInbox/`:
/// - `<id>/` — a complete, unclaimed entry (`entry.json` plus the item copies).
/// - `<id>.writing/` — an entry still being written; renamed to `<id>/` once whole, so a reader
///   never sees half of one.
/// - `<id>.claimed/` — an entry a caller has claimed; renaming `<id>/` to it is the claim, and a
///   rename succeeds for one caller only.
public struct ShareInbox: Sendable {
    /// Entries older than this are swept, claimed or not.
    public static let maxAge: TimeInterval = 24 * 60 * 60
    /// Opening Orbit any other way within this long of a share routes to its newest unconsumed entry.
    public static let openWindow: TimeInterval = 10 * 60

    public struct Source: Sendable {
        public var url: URL
        public var name: String
        public var mime: String

        public init(url: URL, name: String, mime: String) {
            self.url = url
            self.name = name
            self.mime = mime
        }
    }

    public let directory: URL

    public init(root: URL) {
        directory = root.appendingPathComponent("ShareInbox", isDirectory: true)
    }

    private static let entryFile = "entry.json"
    private static let writingSuffix = ".writing"
    private static let claimedSuffix = ".claimed"

    private static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .millisecondsSince1970
        e.outputFormatting = [.sortedKeys]
        return e
    }

    private static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .millisecondsSince1970
        return d
    }

    // MARK: Write (extension side)

    /// Copies each source file into a new entry and writes its `entry.json`. Files are copied by
    /// URL (`FileManager.copyItem`), never read into memory. The entry appears in `list()` only
    /// once every copy and the JSON are in place.
    @discardableResult
    public func write(target: ShareTarget, items sources: [Source], note: String?,
                      id: String = UUID().uuidString, now: Date = Date()) throws -> ShareEntry {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let staging = directory.appendingPathComponent(id + Self.writingSuffix, isDirectory: true)
        try fm.createDirectory(at: staging, withIntermediateDirectories: false)
        do {
            var items: [ShareItem] = []
            for (index, source) in sources.enumerated() {
                let file = "\(index)-\(Self.safeFileName(source.name))"
                let copy = staging.appendingPathComponent(file)
                try fm.copyItem(at: source.url, to: copy)
                let size = (try fm.attributesOfItem(atPath: copy.path)[.size] as? NSNumber)?.int64Value ?? 0
                items.append(ShareItem(file: file, name: source.name, mime: source.mime, bytes: size))
            }
            let entry = ShareEntry(id: id, createdAt: now, target: target, items: items, note: note)
            try Self.encoder.encode(entry).write(to: staging.appendingPathComponent(Self.entryFile),
                                                 options: .atomic)
            try fm.moveItem(at: staging, to: directory.appendingPathComponent(id, isDirectory: true))
            return entry
        } catch {
            try? fm.removeItem(at: staging)
            throw error
        }
    }

    // MARK: Read and claim (app side)

    /// Unclaimed, complete entries, newest first.
    public func list() -> [ShareEntry] {
        entryDirectories()
            .filter { !$0.name.contains(".") }
            .compactMap { readEntry(in: $0.url) }
            .sorted { $0.createdAt != $1.createdAt ? $0.createdAt > $1.createdAt : $0.id > $1.id }
    }

    /// The entry the app's open path routes to when Orbit is opened other than by the share's own
    /// link: the newest unconsumed one, if it is younger than `openWindow`.
    public func entryForOpen(now: Date = Date()) -> ShareEntry? {
        Self.entryForOpen(in: list(), now: now)
    }

    /// The 10-minute rule over an already-read list.
    public static func entryForOpen(in entries: [ShareEntry], now: Date) -> ShareEntry? {
        guard let newest = entries.max(by: { $0.createdAt < $1.createdAt }) else { return nil }
        return now.timeIntervalSince(newest.createdAt) < openWindow ? newest : nil
    }

    /// Claims one entry by renaming its directory. The rename succeeds for one caller only, so two
    /// claimers can never both get it; the loser, or a caller naming a missing entry, gets nil.
    public func claim(id: String) -> ClaimedShareEntry? {
        guard !id.isEmpty, !id.contains("/"), !id.contains(".") else { return nil }
        let source = directory.appendingPathComponent(id, isDirectory: true)
        let claimed = directory.appendingPathComponent(id + Self.claimedSuffix, isDirectory: true)
        guard rename(source.path, claimed.path) == 0 else { return nil }
        guard let entry = readEntry(in: claimed) else {
            try? FileManager.default.removeItem(at: claimed)
            return nil
        }
        return ClaimedShareEntry(entry: entry, directory: claimed)
    }

    /// Deletes a claimed entry, once every item is staged.
    public func delete(_ claimed: ClaimedShareEntry) {
        try? FileManager.default.removeItem(at: claimed.directory)
    }

    /// Removes every entry — unclaimed, claimed or half-written — older than `maxAge`. An entry's
    /// age is its `createdAt`; one whose JSON cannot be read goes by its directory's modification
    /// date. Returns the number removed.
    @discardableResult
    public func sweep(now: Date = Date()) -> Int {
        var removed = 0
        for dir in entryDirectories() {
            let created = readEntry(in: dir.url)?.createdAt
                ?? (try? FileManager.default.attributesOfItem(atPath: dir.url.path)[.modificationDate] as? Date)
                ?? nil
            guard let created, now.timeIntervalSince(created) > Self.maxAge else { continue }
            if (try? FileManager.default.removeItem(at: dir.url)) != nil { removed += 1 }
        }
        return removed
    }

    // MARK: Helpers

    private func entryDirectories() -> [(name: String, url: URL)] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.map { ($0, directory.appendingPathComponent($0, isDirectory: true)) }
    }

    private func readEntry(in dir: URL) -> ShareEntry? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent(Self.entryFile)) else { return nil }
        return try? Self.decoder.decode(ShareEntry.self, from: data)
    }

    /// A shared file's name as a single safe path component.
    static func safeFileName(_ name: String) -> String {
        let cleaned = String(name.map { $0 == "/" || $0 == "\\" || $0 == ":" || $0.isNewline ? "_" : $0 })
            .trimmingCharacters(in: .whitespaces)
        if cleaned.isEmpty || cleaned == "." || cleaned == ".." { return "item" }
        return cleaned
    }
}

// MARK: - Recent sessions snapshot

/// What the Share Extension's picker lists. The app writes it to the App Group whenever its session
/// list loads, so the extension needs no token and no network call (decision D2). No snapshot means
/// signed out: the app removes it on sign-out, and the extension then says to sign in first.
public struct RecentSessionsSnapshot: Codable, Equatable, Sendable {
    public struct Row: Codable, Equatable, Sendable {
        public var id: String
        public var title: String
        public var workspaceId: String
        public var workspaceName: String
        public var updatedAt: Date

        public init(id: String, title: String, workspaceId: String, workspaceName: String, updatedAt: Date) {
            self.id = id
            self.title = title
            self.workspaceId = workspaceId
            self.workspaceName = workspaceName
            self.updatedAt = updatedAt
        }
    }

    public var sessions: [Row]

    public init(sessions: [Row]) {
        self.sessions = sessions
    }
}

/// `<root>/RecentSessions.json`, written atomically and read with nothing but file access.
public struct RecentSessionsSnapshotStore: Sendable {
    public let file: URL
    private static let schemaVersion = 1

    private struct Envelope: Codable { var version: Int; var snapshot: RecentSessionsSnapshot }

    public init(root: URL) {
        file = root.appendingPathComponent("RecentSessions.json")
    }

    /// The snapshot, or nil — signed out — when there is none or it cannot be read.
    public func load() -> RecentSessionsSnapshot? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        guard let data = try? Data(contentsOf: file),
              let env = try? decoder.decode(Envelope.self, from: data),
              env.version == Self.schemaVersion else { return nil }
        return env.snapshot
    }

    public func save(_ snapshot: RecentSessionsSnapshot) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        let data = try encoder.encode(Envelope(version: Self.schemaVersion, snapshot: snapshot))
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        // `.atomic` writes a temp file and renames it, so the extension never reads half a snapshot.
        try data.write(to: file, options: .atomic)
    }

    /// Sign-out: no snapshot.
    public func remove() {
        try? FileManager.default.removeItem(at: file)
    }
}

// MARK: - Text rule

/// Where shared text goes (§3.4, decision D3): a URL, or text up to `maxComposerCharacters`, into
/// the composer text; longer text becomes a `shared-text.txt` attachment.
public enum SharedText: Equatable, Sendable {
    case composerText(String)
    case attachment(name: String, data: Data)

    public static let maxComposerCharacters = 2_000
    public static let attachmentName = "shared-text.txt"

    public static func route(_ text: String, isURL: Bool = false) -> SharedText {
        if isURL || text.count <= maxComposerCharacters { return .composerText(text) }
        return .attachment(name: attachmentName, data: Data(text.utf8))
    }

    /// Shared text appended after any existing draft text, separated by a blank line.
    public static func appending(_ text: String, to draft: String) -> String {
        var existing = Substring(draft)
        while let last = existing.last, last.isWhitespace { existing.removeLast() }
        return existing.isEmpty ? text : String(existing) + "\n\n" + text
    }
}

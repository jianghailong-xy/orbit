import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

// Resumable uploads into Drive (docs/drive-technical-design.md §4.1, D3, D12; board 03-mac frames 1 and
// 4). Each file is opened with `POST /drive/uploads`, sent as chunks of at most the size the server answers
// (8 MiB) and completed. What has arrived is asked of the server, never assumed, so an upload goes on from where it
// stopped: after a lost connection on its own, and after the app quits, from the file still on disk (unlike the web,
// a Mac app keeps the file's path). The web's twin is src/web/src/lib/driveUploads.ts.

/// Where an upload stands.
public enum DriveUploadState: String, Codable, Sendable {
    case queued, uploading, paused, failed, done
}

/// One file going up, and what is kept of it across a relaunch.
public struct DriveUploadItem: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let size: Int
    /// The file's modification time when it was picked: a file changed since is not resumed into the same upload.
    public let modifiedAt: Double
    public let filePath: String
    /// The folder it was dropped on (nil for the drive's root), and that folder's name for the popover.
    public let parentID: String?
    public let parentName: String
    /// A file of a dropped folder: `Dir/sub/name`.
    public let relativePath: String?
    /// The drop it came in, so every file of a dropped folder lands under one top folder.
    public let dropKey: String?
    public var uploadID: String?
    public var sentBytes: Int
    public var state: DriveUploadState
    /// Why it stopped, in the server's words or "Connection lost."
    public var error: String?
    /// Bytes a second over this run, while uploading.
    public var rate: Double?
    public var entryID: String?

    public init(id: String, name: String, size: Int, modifiedAt: Double, filePath: String, parentID: String?,
                parentName: String, relativePath: String? = nil, dropKey: String? = nil, uploadID: String? = nil,
                sentBytes: Int = 0, state: DriveUploadState = .queued, error: String? = nil, rate: Double? = nil,
                entryID: String? = nil) {
        self.id = id
        self.name = name
        self.size = size
        self.modifiedAt = modifiedAt
        self.filePath = filePath
        self.parentID = parentID
        self.parentName = parentName
        self.relativePath = relativePath
        self.dropKey = dropKey
        self.uploadID = uploadID
        self.sentBytes = sentBytes
        self.state = state
        self.error = error
        self.rate = rate
        self.entryID = entryID
    }

    /// 0…100, for the row's bar.
    public var percent: Int { size == 0 ? 100 : min(100, sentBytes * 100 / size) }

    /// Whether the row can be paused (it is going or waiting to).
    public var pausable: Bool { state == .uploading || state == .queued }
}

/// One file to send: a file picked or dropped, with where it goes.
public struct DriveUploadRequest: Equatable, Sendable {
    public let fileURL: URL
    public let parentID: String?
    public let parentName: String
    public let relativePath: String?
    public let dropKey: String?

    public init(fileURL: URL, parentID: String?, parentName: String, relativePath: String? = nil, dropKey: String? = nil) {
        self.fileURL = fileURL
        self.parentID = parentID
        self.parentName = parentName
        self.relativePath = relativePath
        self.dropKey = dropKey
    }

    /// The requests for what was picked or dropped: a file is itself; a folder is every file under it, each with its
    /// path inside the folder (`Dir/sub/name`) and one drop key, so the whole folder lands under one top folder.
    /// Hidden files (`.DS_Store`) and packages' insides stay behind.
    public static func expand(_ urls: [URL], parentID: String?, parentName: String,
                              fileManager: FileManager = .default) -> [DriveUploadRequest] {
        urls.flatMap { url -> [DriveUploadRequest] in
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) else { return [] }
            guard isDirectory.boolValue else {
                return [DriveUploadRequest(fileURL: url, parentID: parentID, parentName: parentName)]
            }
            let root = url.standardizedFileURL
            let dropKey = "drop-\(UUID().uuidString)"
            guard let walker = fileManager.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey],
                                                      options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
            var files: [DriveUploadRequest] = []
            for case let file as URL in walker {
                guard (try? file.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
                let inside = file.standardizedFileURL.pathComponents.dropFirst(root.pathComponents.count)
                files.append(DriveUploadRequest(
                    fileURL: file, parentID: parentID, parentName: parentName,
                    relativePath: ([root.lastPathComponent] + inside).joined(separator: "/"), dropKey: dropKey))
            }
            return files.sorted { ($0.relativePath ?? "") < ($1.relativePath ?? "") }
        }
    }
}

/// The calls an upload makes. `APIClient` is the real one; tests answer with a fake.
public protocol DriveUploadTransport: AnyObject, Sendable {
    func driveOpenUpload(parentID: String?, name: String, size: Int, relativePath: String?,
                             dropRootID: String?) async throws -> DriveUploadOpened
    func driveUploadStatus(_ uploadID: String) async throws -> DriveUploadStatus
    func drivePutChunk(uploadID: String, index: Int, bytes: Data, sha256: String) async throws
    func driveCompleteUpload(_ uploadID: String) async throws -> DriveEntry
    func driveAbandonUpload(_ uploadID: String) async throws
}

extension APIClient: DriveUploadTransport {}

/// Where the queue keeps its uploads across a relaunch.
public protocol DriveUploadStore: AnyObject {
    func load() -> (uploads: [DriveUploadItem], drops: [String: String])
    func save(uploads: [DriveUploadItem], drops: [String: String])
}

/// The uploads in UserDefaults, one key per server.
public final class DriveUploadDefaultsStore: DriveUploadStore {
    private struct Kept: Codable {
        let uploads: [DriveUploadItem]
        let drops: [String: String]
    }

    private let defaults: UserDefaults
    private let key: String

    public init(baseURL: URL, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.key = "documents.uploads.\(baseURL.absoluteString)"
    }

    public func load() -> (uploads: [DriveUploadItem], drops: [String: String]) {
        guard let data = defaults.data(forKey: key), let kept = try? JSONDecoder().decode(Kept.self, from: data) else {
            return ([], [:])
        }
        return (kept.uploads, kept.drops)
    }

    public func save(uploads: [DriveUploadItem], drops: [String: String]) {
        if let data = try? JSONEncoder().encode(Kept(uploads: uploads, drops: drops)) { defaults.set(data, forKey: key) }
    }
}

/// Which chunks a file still needs, given the chunks the server already has.
public enum DriveChunkPlan {
    public struct Chunk: Equatable, Sendable {
        public let index: Int
        public let offset: Int
        public let length: Int
    }

    /// Every chunk of a file of `size` bytes cut at `chunkSize`; an empty file has none.
    public static func chunks(size: Int, chunkSize: Int) -> [Chunk] {
        guard size > 0, chunkSize > 0 else { return [] }
        let count = (size + chunkSize - 1) / chunkSize
        return (0..<count).map { idx in
            Chunk(index: idx, offset: idx * chunkSize, length: min(chunkSize, size - idx * chunkSize))
        }
    }

    /// The chunks still to send: those the server lacks, or holds at another size (a chunk sent again replaces).
    public static func missing(size: Int, chunkSize: Int, arrived: [Int: Int]) -> [Chunk] {
        chunks(size: size, chunkSize: chunkSize).filter { arrived[$0.index] != $0.length }
    }

    /// The bytes the server already holds of the file.
    public static func arrivedBytes(size: Int, chunkSize: Int, arrived: [Int: Int]) -> Int {
        chunks(size: size, chunkSize: chunkSize).filter { arrived[$0.index] == $0.length }.reduce(0) { $0 + $1.length }
    }
}

/// The owner's uploads, one file at a time, in the order they were added. Lives as long as the app, not the page:
/// leaving Drive does not stop it, and the popover shows it again on return.
@MainActor
public final class DriveUploadQueue {
    public private(set) var items: [DriveUploadItem] = []
    /// How many uploads completed since launch: what the page re-reads its folder on.
    public private(set) var completedCount = 0
    /// Called after every change to `items`.
    public var onChange: (() -> Void)?
    /// Called when an upload completes, with the file it made.
    public var onCompleted: ((DriveUploadItem) -> Void)?

    /// A chunk that fails for want of a connection is tried this many more times, waiting longer each time, before
    /// the upload pauses itself.
    public static let retries = 3
    public static let connectionLost = "Connection lost."

    private let transport: DriveUploadTransport
    private let store: DriveUploadStore?
    private let retryDelay: TimeInterval
    private let fileManager: FileManager
    private var drops: [String: String] = [:]
    private var running: (id: String, task: Task<Void, Never>)?

    public init(transport: DriveUploadTransport, store: DriveUploadStore? = nil, retryDelay: TimeInterval = 1,
                fileManager: FileManager = .default) {
        self.transport = transport
        self.store = store
        self.retryDelay = retryDelay
        self.fileManager = fileManager
        if let store {
            let kept = store.load()
            drops = kept.drops
            // A relaunch: what was going on goes on, from the parts already sent, if its file is still there.
            items = kept.uploads.filter { $0.state != .done }.map { item in
                var item = item
                item.rate = nil
                if item.state == .uploading { item.state = .queued }
                return item
            }
        }
    }

    /// SHA-256 of a chunk as lowercase hex: CryptoKit where there is one, the written-out digest elsewhere.
    public nonisolated static func sha256(_ data: Data) -> String {
        #if canImport(CryptoKit)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        #else
        return RunnerDownload.sha256Hex(data)
        #endif
    }

    /// Start what a relaunch left: called once the app is signed in.
    public func start() { pump() }

    /// Queue files. A file already waiting (same path, size and time, same place) is not added twice.
    public func add(_ requests: [DriveUploadRequest]) {
        for request in requests {
            guard let attributes = try? fileManager.attributesOfItem(atPath: request.fileURL.path) else { continue }
            let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
            let modifiedAt = (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            if items.contains(where: { $0.state != .done && $0.filePath == request.fileURL.path && $0.size == size &&
                $0.modifiedAt == modifiedAt && $0.parentID == request.parentID && $0.relativePath == request.relativePath }) {
                continue
            }
            items.append(DriveUploadItem(
                id: UUID().uuidString, name: request.fileURL.lastPathComponent, size: size, modifiedAt: modifiedAt,
                filePath: request.fileURL.path, parentID: request.parentID, parentName: request.parentName,
                relativePath: request.relativePath, dropKey: request.dropKey))
        }
        changed()
        pump()
    }

    public func pause(_ id: String) {
        if running?.id == id { running?.task.cancel() }
        patch(id) {
            $0.state = .paused
            $0.rate = nil
            $0.error = nil
        }
    }

    public func resume(_ id: String) {
        guard let item = find(id), item.state == .paused || item.state == .failed else { return }
        patch(id) {
            $0.state = .queued
            $0.error = nil
        }
        pump()
    }

    /// Stop and forget an upload; the server drops what it had.
    public func cancel(_ id: String) {
        guard let item = find(id) else { return }
        if running?.id == id { running?.task.cancel() }
        items.removeAll { $0.id == id }
        changed()
        if let uploadID = item.uploadID {
            let transport = transport
            Task { try? await transport.driveAbandonUpload(uploadID) }
        }
    }

    /// Clear the finished rows.
    public func clearFinished() {
        items.removeAll { $0.state == .done }
        changed()
    }

    /// A connection that came back, or a Mac that woke: what a lost connection paused goes on.
    public func resumeInterrupted() {
        var woke = false
        for item in items where item.state == .paused && item.error == Self.connectionLost {
            patch(item.id, quiet: true) {
                $0.state = .queued
                $0.error = nil
            }
            woke = true
        }
        if woke {
            changed()
            pump()
        }
    }

    /// Wait until nothing is uploading. For tests.
    public func idle() async {
        while let task = running?.task { await task.value }
    }

    // MARK: the run

    private func find(_ id: String) -> DriveUploadItem? { items.first { $0.id == id } }

    private func patch(_ id: String, quiet: Bool = false, _ change: (inout DriveUploadItem) -> Void) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        change(&items[index])
        if !quiet { changed() }
    }

    private func changed() {
        let live = Set(items.filter { $0.state != .done }.compactMap(\.dropKey))
        drops = drops.filter { live.contains($0.key) }
        store?.save(uploads: items.filter { $0.state != .done }, drops: drops)
        onChange?()
    }

    private func pump() {
        guard running == nil, let next = items.first(where: { $0.state == .queued }) else { return }
        let id = next.id
        let task = Task { [weak self] in
            await self?.send(id)
            guard let self else { return }
            self.running = nil
            self.pump()
        }
        running = (id, task)
    }

    private struct Stopped: Error {}

    private struct Refused: Error { let message: String }

    /// Whether a failure is the network's (try again) rather than the server's answer (stop and say it).
    nonisolated static func transient(_ error: Error) -> Bool {
        if let url = error as? URLError { return url.code != .cancelled }
        if case APIError.http(let status, _) = error { return status >= 500 }
        return false
    }

    private func send(_ id: String) async {
        // Paused or cancelled before its turn came.
        guard !Task.isCancelled, find(id)?.state == .queued else { return }
        patch(id) {
            $0.state = .uploading
            $0.error = nil
        }
        do {
            let entry = try await sendOnce(id)
            guard !Task.isCancelled, find(id) != nil else { return }
            completedCount += 1
            patch(id) {
                $0.state = .done
                $0.entryID = entry
                $0.sentBytes = $0.size
                $0.rate = nil
            }
            if let item = find(id) { onCompleted?(item) }
        } catch {
            // Paused or cancelled: whoever stopped it has said where it stands.
            if Task.isCancelled || error is Stopped || error is CancellationError { return }
            if let url = error as? URLError, url.code == .cancelled { return }
            guard find(id) != nil else { return }
            if Self.transient(error) {
                patch(id) {
                    $0.state = .paused
                    $0.rate = nil
                    $0.error = Self.connectionLost
                }
            } else {
                let reason = APIClient.failureReason(error)
                let message = (error as? Refused)?.message ?? (reason.prefix(1).uppercased() + reason.dropFirst())
                patch(id) {
                    $0.state = .failed
                    $0.rate = nil
                    $0.error = message
                }
            }
        }
    }

    private func sendOnce(_ id: String) async throws -> String {
        guard let item = find(id) else { throw Stopped() }
        guard let attributes = try? fileManager.attributesOfItem(atPath: item.filePath) else {
            throw Refused(message: "\(item.name) is no longer where it was picked from.")
        }
        let size = (attributes[.size] as? NSNumber)?.intValue ?? -1
        let modifiedAt = (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        if size != item.size || modifiedAt != item.modifiedAt {
            throw Refused(message: "\(item.name) changed since it was picked. Upload it again.")
        }

        var chunkSize = 8 * 1024 * 1024
        var arrived: [Int: Int] = [:]
        if let uploadID = item.uploadID {
            do {
                let status = try await transport.driveUploadStatus(uploadID)
                if status.completed, let entryID = status.entryId { return entryID }
                chunkSize = status.chunkSize
                arrived = Dictionary(status.chunks.map { ($0.idx, $0.sizeBytes) }, uniquingKeysWith: { $1 })
            } catch APIError.http(404, _) {
                // Gone (abandoned, or swept after a long while): start it again.
                patch(id) { $0.uploadID = nil }
            }
        }
        try check(id)
        if find(id)?.uploadID == nil {
            let dropRootID = item.dropKey.flatMap { drops[$0] }
            let opened = try await transport.driveOpenUpload(
                parentID: item.parentID, name: item.name, size: item.size, relativePath: item.relativePath,
                dropRootID: dropRootID)
            if let key = item.dropKey, let root = opened.dropRootId, drops[key] == nil { drops[key] = root }
            chunkSize = opened.chunkSize
            arrived = [:]
            patch(id) { $0.uploadID = opened.id }
        }
        guard let uploadID = find(id)?.uploadID else { throw Stopped() }

        var sent = DriveChunkPlan.arrivedBytes(size: item.size, chunkSize: chunkSize, arrived: arrived)
        patch(id) { $0.sentBytes = sent }
        let started = Date()
        var sentThisRun = 0
        let path = item.filePath
        for chunk in DriveChunkPlan.missing(size: item.size, chunkSize: chunkSize, arrived: arrived) {
            try check(id)
            let (bytes, sha) = try await Task.detached(priority: .utility) {
                let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
                defer { try? handle.close() }
                try handle.seek(toOffset: UInt64(chunk.offset))
                let bytes = try handle.read(upToCount: chunk.length) ?? Data()
                return (bytes, DriveUploadQueue.sha256(bytes))
            }.value
            guard bytes.count == chunk.length else {
                throw Refused(message: "\(item.name) changed since it was picked. Upload it again.")
            }
            var attempt = 0
            while true {
                try check(id)
                do {
                    try await transport.drivePutChunk(uploadID: uploadID, index: chunk.index, bytes: bytes, sha256: sha)
                    break
                } catch {
                    if Task.isCancelled || !Self.transient(error) || attempt >= Self.retries { throw error }
                    let wait = retryDelay * pow(2, Double(attempt))
                    attempt += 1
                    if wait > 0 { try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
                }
            }
            sent += chunk.length
            sentThisRun += chunk.length
            let seconds = Date().timeIntervalSince(started)
            let total = sent
            patch(id) {
                $0.sentBytes = total
                $0.rate = seconds > 0 ? Double(sentThisRun) / seconds : nil
            }
        }
        try check(id)
        return try await transport.driveCompleteUpload(uploadID).id
    }

    /// Stop here if the upload was paused or cancelled meanwhile.
    private func check(_ id: String) throws {
        if Task.isCancelled { throw Stopped() }
        guard let item = find(id), item.state == .uploading else { throw Stopped() }
    }
}

import XCTest
@testable import OrbitKit

/// The resumable uploads (docs/drive-technical-design.md §4.1, D3, D12): chunks of the server's size, what has
/// arrived asked of the server, a lost connection tried again and then paused, a folder's files under one top folder,
/// and the queue kept across a relaunch. The web's twin is src/web/src/lib/driveUploads.ts.
@MainActor
final class DriveUploadsTests: XCTestCase {

    /// A server that keeps chunks in memory. `failPuts` fails that many chunk puts with `failure` first.
    final class FakeServer: DriveUploadTransport, @unchecked Sendable {
        var chunkSize = 4
        var opened: [(name: String, parentID: String?, relativePath: String?, dropRootID: String?)] = []
        var puts: [(upload: String, index: Int, bytes: Data, sha: String)] = []
        var completes: [String] = []
        var abandoned: [String] = []
        var arrived: [String: [Int: Data]] = [:]
        var statusAnswer: ((String) throws -> DriveUploadStatus)?
        var failPuts = 0
        var failure: Error = URLError(.networkConnectionLost)
        var openFailure: Error?
        private var next = 0

        func driveOpenUpload(parentID: String?, name: String, size: Int, relativePath: String?,
                                 dropRootID: String?) async throws -> DriveUploadOpened {
            if let openFailure { throw openFailure }
            opened.append((name, parentID, relativePath, dropRootID))
            next += 1
            return DriveUploadOpened(id: "up\(next)", chunkSize: chunkSize,
                                         dropRootId: relativePath == nil ? nil : (dropRootID ?? "top\(next)"))
        }

        func driveUploadStatus(_ uploadID: String) async throws -> DriveUploadStatus {
            if let statusAnswer { return try statusAnswer(uploadID) }
            let chunks = (arrived[uploadID] ?? [:]).map { DriveUploadStatus.Chunk(idx: $0.key, sizeBytes: $0.value.count) }
            return DriveUploadStatus(chunkSize: chunkSize, chunks: chunks)
        }

        func drivePutChunk(uploadID: String, index: Int, bytes: Data, sha256: String) async throws {
            if failPuts > 0 {
                failPuts -= 1
                throw failure
            }
            puts.append((uploadID, index, bytes, sha256))
            arrived[uploadID, default: [:]][index] = bytes
        }

        func driveCompleteUpload(_ uploadID: String) async throws -> DriveEntry {
            completes.append(uploadID)
            return DriveEntry(id: "entry-\(uploadID)", parentId: nil, kind: "FILE", name: "x")
        }

        func driveAbandonUpload(_ uploadID: String) async throws { abandoned.append(uploadID) }

        /// The whole file as the server put it together.
        func file(_ uploadID: String) -> Data {
            (arrived[uploadID] ?? [:]).sorted { $0.key < $1.key }.reduce(Data()) { $0 + $1.value }
        }
    }

    final class MemoryStore: DriveUploadStore {
        var uploads: [DriveUploadItem] = []
        var drops: [String: String] = [:]
        func load() -> (uploads: [DriveUploadItem], drops: [String: String]) { (uploads, drops) }
        func save(uploads: [DriveUploadItem], drops: [String: String]) {
            self.uploads = uploads
            self.drops = drops
        }
    }

    private var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("documents-uploads-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func file(_ name: String, _ text: String, in folder: URL? = nil) throws -> URL {
        let url = (folder ?? dir).appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
        return url
    }

    func testAChunkPlanCutsAtTheServersSizeAndSkipsWhatArrived() {
        XCTAssertEqual(DriveChunkPlan.chunks(size: 10, chunkSize: 4).map(\.length), [4, 4, 2])
        XCTAssertEqual(DriveChunkPlan.chunks(size: 0, chunkSize: 4), [])
        XCTAssertEqual(DriveChunkPlan.missing(size: 10, chunkSize: 4, arrived: [0: 4, 2: 1]).map(\.index), [1, 2])
        XCTAssertEqual(DriveChunkPlan.arrivedBytes(size: 10, chunkSize: 4, arrived: [0: 4, 2: 2]), 6)
        XCTAssertEqual(DriveChunkPlan.missing(size: 10, chunkSize: 4, arrived: [:]).last,
                       DriveChunkPlan.Chunk(index: 2, offset: 8, length: 2))
    }

    func testTheDigestIsSHA256() {
        XCTAssertEqual(DriveUploadQueue.sha256(Data("abc".utf8)),
                       "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    /// A file goes up in chunks, each with its digest, and is completed; the row ends Uploaded and leaves the store.
    func testAFileGoesUpInChunksAndCompletes() async throws {
        let server = FakeServer()
        let store = MemoryStore()
        let queue = DriveUploadQueue(transport: server, store: store, retryDelay: 0)
        var made: [String] = []
        queue.onCompleted = { made.append($0.entryID ?? "") }
        let url = try file("brief.md", "0123456789")
        queue.add([DriveUploadRequest(fileURL: url, parentID: "folder", parentName: "Orbit UI migration")])
        XCTAssertEqual(store.uploads.count, 1)
        await queue.idle()

        XCTAssertEqual(server.opened.map(\.name), ["brief.md"])
        XCTAssertEqual(server.opened.first?.parentID, "folder")
        XCTAssertEqual(server.puts.map(\.index), [0, 1, 2])
        XCTAssertEqual(server.puts.first?.sha, DriveUploadQueue.sha256(Data("0123".utf8)))
        XCTAssertEqual(server.file("up1"), Data("0123456789".utf8))
        XCTAssertEqual(server.completes, ["up1"])
        XCTAssertEqual(queue.items.first?.state, .done)
        XCTAssertEqual(queue.items.first?.sentBytes, 10)
        XCTAssertEqual(queue.completedCount, 1)
        XCTAssertEqual(made, ["entry-up1"])
        XCTAssertTrue(store.uploads.isEmpty, "a finished upload is not kept")
        queue.clearFinished()
        XCTAssertTrue(queue.items.isEmpty)
    }

    /// After a relaunch the upload goes on from what the server says it has: only the missing chunks are sent.
    func testARelaunchGoesOnFromThePartsAlreadySent() async throws {
        let server = FakeServer()
        let url = try file("walkthrough.mov", "0123456789")
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let store = MemoryStore()
        store.uploads = [DriveUploadItem(
            id: "k", name: "walkthrough.mov", size: 10,
            modifiedAt: (attributes[.modificationDate] as! Date).timeIntervalSince1970, filePath: url.path,
            parentID: nil, parentName: "Drive", uploadID: "up7", sentBytes: 4, state: .uploading)]
        server.arrived["up7"] = [0: Data("0123".utf8)]

        let queue = DriveUploadQueue(transport: server, store: store, retryDelay: 0)
        XCTAssertEqual(queue.items.first?.state, .queued, "what was going when the app quit is queued again")
        queue.start()
        await queue.idle()

        XCTAssertTrue(server.opened.isEmpty)
        XCTAssertEqual(server.puts.map(\.index), [1, 2])
        XCTAssertEqual(server.file("up7"), Data("0123456789".utf8))
        XCTAssertEqual(queue.items.first?.state, .done)
    }

    /// An upload the server no longer has (abandoned, or swept) is opened again from the start.
    func testAnUploadTheServerForgotStartsAgain() async throws {
        let server = FakeServer()
        server.statusAnswer = { _ in throw APIError.http(status: 404, body: nil) }
        let url = try file("a.txt", "hello")
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let store = MemoryStore()
        store.uploads = [DriveUploadItem(
            id: "k", name: "a.txt", size: 5, modifiedAt: (attributes[.modificationDate] as! Date).timeIntervalSince1970,
            filePath: url.path, parentID: nil, parentName: "Drive", uploadID: "gone", state: .queued)]
        let queue = DriveUploadQueue(transport: server, store: store, retryDelay: 0)
        queue.start()
        await queue.idle()
        XCTAssertEqual(server.opened.count, 1)
        XCTAssertEqual(server.completes, ["up1"])
        XCTAssertEqual(queue.items.first?.state, .done)
    }

    /// A chunk that fails for want of a connection is tried again; past the retries the upload pauses, keeps what was
    /// sent, and goes on when the connection is back.
    func testALostConnectionPausesAndGoesOnWhenItIsBack() async throws {
        let server = FakeServer()
        server.failPuts = 2
        let queue = DriveUploadQueue(transport: server, retryDelay: 0)
        queue.add([DriveUploadRequest(fileURL: try file("a.txt", "0123456789"), parentID: nil, parentName: "Drive")])
        await queue.idle()
        XCTAssertEqual(queue.items.first?.state, .done, "two failures are within the retries")

        let flaky = FakeServer()
        flaky.failPuts = DriveUploadQueue.retries + 2
        let paused = DriveUploadQueue(transport: flaky, retryDelay: 0)
        paused.add([DriveUploadRequest(fileURL: try file("b.txt", "0123456789"), parentID: nil, parentName: "Drive")])
        await paused.idle()
        XCTAssertEqual(paused.items.first?.state, .paused)
        XCTAssertEqual(paused.items.first?.error, DriveUploadQueue.connectionLost)
        XCTAssertEqual(DriveLogic.uploadStatus(paused.items[0]), "Connection lost. 0 B of 10 B is kept; it goes on from there.")

        flaky.failPuts = 0
        paused.resumeInterrupted()
        await paused.idle()
        XCTAssertEqual(paused.items.first?.state, .done)
        XCTAssertEqual(flaky.opened.count, 1, "the same upload goes on")
        XCTAssertEqual(flaky.file("up1"), Data("0123456789".utf8))
    }

    /// The server's refusal is the server's sentence, and the upload stops rather than trying again.
    func testARefusalSaysTheServersWords() async throws {
        let server = FakeServer()
        server.openFailure = APIError.http(status: 413, body: #"{"message":"Your storage is full, so new uploads are refused."}"#)
        let queue = DriveUploadQueue(transport: server, retryDelay: 0)
        queue.add([DriveUploadRequest(fileURL: try file("a.txt", "x"), parentID: nil, parentName: "Drive")])
        await queue.idle()
        XCTAssertEqual(queue.items.first?.state, .failed)
        XCTAssertEqual(queue.items.first?.error, "Your storage is full, so new uploads are refused.")
    }

    /// A file changed on disk since it was picked is not sent into the same upload.
    func testAFileChangedSinceItWasPickedIsNotResumed() async throws {
        let server = FakeServer()
        let url = try file("a.txt", "0123")
        let store = MemoryStore()
        store.uploads = [DriveUploadItem(id: "k", name: "a.txt", size: 4, modifiedAt: 1, filePath: url.path,
                                             parentID: nil, parentName: "Drive", uploadID: "up9", state: .queued)]
        let queue = DriveUploadQueue(transport: server, store: store, retryDelay: 0)
        queue.start()
        await queue.idle()
        XCTAssertEqual(queue.items.first?.state, .failed)
        XCTAssertEqual(queue.items.first?.error, "a.txt changed since it was picked. Upload it again.")
        XCTAssertTrue(server.puts.isEmpty)
    }

    /// A dropped folder is every file under it, its path inside the folder kept, hidden files left behind, and every file
    /// lands under the one top folder the first file made.
    func testADroppedFolderLandsUnderOneTopFolder() async throws {
        let folder = dir.appendingPathComponent("screens")
        _ = try file("a.png", "aa", in: folder)
        _ = try file("sub/b.png", "bbbbbb", in: folder)
        _ = try file(".DS_Store", "x", in: folder)
        let loose = try file("loose.txt", "l")
        let requests = DriveUploadRequest.expand([folder, loose], parentID: "p", parentName: "Orbit UI migration")
        XCTAssertEqual(requests.map(\.relativePath), ["screens/a.png", "screens/sub/b.png", nil])
        XCTAssertEqual(Set(requests.prefix(2).map(\.dropKey)).count, 1)
        XCTAssertNotNil(requests[0].dropKey)
        XCTAssertNil(requests[2].dropKey)

        let server = FakeServer()
        let queue = DriveUploadQueue(transport: server, retryDelay: 0)
        queue.add(requests)
        await queue.idle()
        XCTAssertEqual(server.opened.map(\.relativePath), ["screens/a.png", "screens/sub/b.png", nil])
        XCTAssertEqual(server.opened.map(\.dropRootID), [nil, "top1", nil])
        XCTAssertEqual(queue.items.map(\.state), [.done, .done, .done])
        XCTAssertEqual(DriveLogic.uploadDestination(queue.items[1]), "screens/sub")
    }

    /// Pause stops a waiting upload; Resume queues it again; Cancel forgets it and tells the server.
    func testPauseResumeAndCancel() async throws {
        let server = FakeServer()
        let queue = DriveUploadQueue(transport: server, retryDelay: 0)
        let first = try file("a.txt", "0123456789")
        let second = try file("b.txt", "abc")
        queue.add([DriveUploadRequest(fileURL: first, parentID: nil, parentName: "Drive"),
                   DriveUploadRequest(fileURL: second, parentID: nil, parentName: "Drive")])
        let waiting = queue.items[1].id
        queue.pause(waiting)
        await queue.idle()
        XCTAssertEqual(queue.items.map(\.state), [.done, .paused])
        XCTAssertEqual(DriveLogic.uploadStatus(queue.items[1]), "Paused · 0%")
        queue.resume(waiting)
        await queue.idle()
        XCTAssertEqual(queue.items[1].state, .done)

        queue.add([DriveUploadRequest(fileURL: try file("c.txt", "c"), parentID: nil, parentName: "Drive")])
        let third = queue.items[2].id
        queue.pause(third)
        await queue.idle()
        queue.cancel(third)
        XCTAssertEqual(queue.items.count, 2)
    }

    /// The same file picked twice for the same place is one upload.
    func testTheSameFilePickedTwiceIsOneUpload() async throws {
        let server = FakeServer()
        server.failPuts = 100
        let queue = DriveUploadQueue(transport: server, retryDelay: 0)
        let url = try file("a.txt", "x")
        queue.add([DriveUploadRequest(fileURL: url, parentID: nil, parentName: "Drive")])
        queue.add([DriveUploadRequest(fileURL: url, parentID: nil, parentName: "Drive")])
        XCTAssertEqual(queue.items.count, 1)
        queue.add([DriveUploadRequest(fileURL: url, parentID: "other", parentName: "Other")])
        XCTAssertEqual(queue.items.count, 2)
        await queue.idle()
    }
}

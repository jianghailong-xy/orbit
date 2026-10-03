import Foundation
import XCTest
@testable import OrbitKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class SessionFolderURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, data: Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        let answer = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// What reached the wire: the method, the path, and the body as a JSON object (nil when empty), so
/// the assertions don't depend on the order the encoder writes keys in.
private final class SessionFolderRecorder: @unchecked Sendable {
    struct Sent {
        let method: String?
        let path: String?
        let body: [String: Any]?
    }

    private let lock = NSLock()
    private var storage: [Sent] = []

    func append(_ request: URLRequest) {
        let sent = Sent(method: request.httpMethod, path: request.url?.path, body: Self.body(request))
        lock.lock()
        storage.append(sent)
        lock.unlock()
    }

    var sent: [Sent] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    /// URLProtocol hands back a request whose body has been moved to `httpBodyStream`, so the bytes
    /// are read off the stream rather than off `httpBody` (which is nil by then).
    private static func body(_ request: URLRequest) -> [String: Any]? {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(contentsOf: buffer[0..<read])
            }
        }
        guard !data.isEmpty else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}

/// The folder doors (docs/session-folders-move-design.md §3.2): `GET/POST /session-folders`,
/// `PATCH/DELETE /session-folders/:id`, `POST /sessions/:id/move` and `POST /sessions` with a folder.
final class SessionFolderAPIClientTests: XCTestCase {
    override func tearDown() {
        SessionFolderURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionFolderURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private func answer(_ json: String, status: Int = 200) -> SessionFolderRecorder {
        let recorder = SessionFolderRecorder()
        SessionFolderURLProtocol.handler = { request in
            recorder.append(request)
            return (status, Data(json.utf8))
        }
        return recorder
    }

    func testListingCreatingRenamingAndDeletingFolders() async throws {
        let listed = answer(#"[{"id":"f1","workspaceId":"w1","name":"Notes"}]"#)
        let folders = try await client().listSessionFolders()
        XCTAssertEqual(folders, [SessionFolder(id: "f1", workspaceId: "w1", name: "Notes")])
        XCTAssertEqual(listed.sent.map(\.method), ["GET"])
        XCTAssertEqual(listed.sent.map(\.path), ["/api/session-folders"])
        XCTAssertNil(listed.sent.first?.body)

        let created = answer(#"{"id":"f2","workspaceId":"w1","name":"Drafts"}"#, status: 201)
        let folder = try await client().createSessionFolder(workspaceID: "w1", name: "Drafts")
        XCTAssertEqual(folder, SessionFolder(id: "f2", workspaceId: "w1", name: "Drafts"))
        XCTAssertEqual(created.sent.map(\.method), ["POST"])
        XCTAssertEqual(created.sent.map(\.path), ["/api/session-folders"])
        XCTAssertEqual(created.sent.first?.body?["workspaceId"] as? String, "w1")
        XCTAssertEqual(created.sent.first?.body?["name"] as? String, "Drafts")

        let renamed = answer(#"{"id":"f2","workspaceId":"w1","name":"Later"}"#)
        let after = try await client().renameSessionFolder("f2", name: "Later")
        XCTAssertEqual(after.name, "Later")
        XCTAssertEqual(renamed.sent.map(\.method), ["PATCH"])
        XCTAssertEqual(renamed.sent.map(\.path), ["/api/session-folders/f2"])
        XCTAssertEqual(renamed.sent.first?.body?.count, 1)
        XCTAssertEqual(renamed.sent.first?.body?["name"] as? String, "Later")

        let deleted = answer(#"{"ok":true}"#)
        try await client().deleteSessionFolder("f2")
        XCTAssertEqual(deleted.sent.map(\.method), ["DELETE"])
        XCTAssertEqual(deleted.sent.map(\.path), ["/api/session-folders/f2"])
    }

    /// A move posts the folder, or an explicit null for "No Folder", to the session's move door.
    func testMovingASessionPostsItsFolder() async throws {
        let into = answer(#"{"id":"s1","workspaceId":"w1","folderId":"f1"}"#)
        try await client().moveSession("s1", folderID: "f1")
        XCTAssertEqual(into.sent.map(\.method), ["POST"])
        XCTAssertEqual(into.sent.map(\.path), ["/api/sessions/s1/move"])
        XCTAssertEqual(into.sent.first?.body?.count, 1)
        XCTAssertEqual(into.sent.first?.body?["folderId"] as? String, "f1")

        let out = answer(#"{"id":"s1","workspaceId":"w1","folderId":null}"#)
        try await client().moveSession("s1", folderID: nil)
        XCTAssertEqual(out.sent.map(\.path), ["/api/sessions/s1/move"])
        XCTAssertTrue(out.sent.first?.body?["folderId"] is NSNull)
    }

    /// The Move panel's second group reads `GET /sessions/:id/move-targets`; its confirmation posts
    /// the workspace, and the folder there — or an explicit null — to the same move door.
    func testMoveTargetsAndAMoveToAnotherWorkspace() async throws {
        let read = answer(#"""
        {"workspaceId":"w1","folderId":null,"folders":[],"reason":null,"needsEnd":true,"branch":"orbit/s1",
         "changedFiles":1,"unmergedFiles":1,"mergeTarget":"main",
         "targets":[{"workspaceId":"w2","name":"site","provider":"claude","runnerId":"r2","runnerName":"mac-mini",
                     "runnerOnline":true,"workDir":"/srv/site","reason":null,"conversation":"rebuilt",
                     "folders":[{"id":"f2","name":"Bugs","sessionCount":2}]}]}
        """#)
        let targets = try await client().sessionMoveTargets("s1")
        XCTAssertTrue(targets.needsEnd)
        XCTAssertEqual(targets.targets.map(\.name), ["site"])
        XCTAssertEqual(targets.targets.first?.folders.map(\.id), ["f2"])
        XCTAssertEqual(read.sent.map(\.method), ["GET"])
        XCTAssertEqual(read.sent.map(\.path), ["/api/sessions/s1/move-targets"])

        let moved = answer(#"{"id":"s1","workspaceId":"w2","folderId":"f2"}"#, status: 201)
        try await client().moveSession("s1", toWorkspace: "w2", folderID: "f2")
        XCTAssertEqual(moved.sent.map(\.method), ["POST"])
        XCTAssertEqual(moved.sent.map(\.path), ["/api/sessions/s1/move"])
        XCTAssertEqual(moved.sent.first?.body?["workspaceId"] as? String, "w2")
        XCTAssertEqual(moved.sent.first?.body?["folderId"] as? String, "f2")

        let loose = answer(#"{"id":"s1","workspaceId":"w2","folderId":null}"#, status: 201)
        try await client().moveSession("s1", toWorkspace: "w2", folderID: nil)
        XCTAssertEqual(loose.sent.first?.body?["workspaceId"] as? String, "w2")
        XCTAssertTrue(loose.sent.first?.body?["folderId"] is NSNull)

        // A refusal is the server's 409, with the reason the panel shows.
        _ = answer(#"{"statusCode":409,"message":"End the session first."}"#, status: 409)
        do {
            try await client().moveSession("s1", toWorkspace: "w2", folderID: nil)
            XCTFail("a 409 is thrown")
        } catch {
            XCTAssertEqual(SessionMoveCopy.moveFailed(error), "End the session first.")
        }
    }

    /// A session started from a folder's page is created in that folder: the request carries it,
    /// and the session that comes back says where it is.
    func testANewSessionIsCreatedInItsFolder() async throws {
        let recorder = answer(#"{"id":"s9","status":"PENDING","agentId":"w1","folderId":"f1"}"#, status: 201)
        let created = try await client().createSession(
            CreateSessionRequest(prompt: "Draft the notes", agentId: "w1", folderId: "f1"))
        XCTAssertEqual(created.folderId, "f1")
        XCTAssertEqual(recorder.sent.map(\.method), ["POST"])
        XCTAssertEqual(recorder.sent.map(\.path), ["/api/sessions"])
        XCTAssertEqual(recorder.sent.first?.body?["folderId"] as? String, "f1")
        XCTAssertEqual(recorder.sent.first?.body?["agentId"] as? String, "w1")
    }
}

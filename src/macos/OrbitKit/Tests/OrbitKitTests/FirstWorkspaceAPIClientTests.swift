import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class FirstWorkspaceURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, body: Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        let result = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: result.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: result.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class SeenRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    private var bodies: [Data?] = []

    func record(_ request: URLRequest) {
        lock.lock()
        defer { lock.unlock() }
        requests.append(request)
        bodies.append(Self.body(of: request))
    }

    var last: URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return requests.last
    }

    var lastBody: Data? {
        lock.lock()
        defer { lock.unlock() }
        return bodies.last ?? nil
    }

    /// URLSession hands a protocol its body as a stream.
    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&chunk, maxLength: chunk.count)
            guard read > 0 else { break }
            data.append(chunk, count: read)
        }
        return data
    }
}

/// The directory probe relay and a session that makes its workspace, as docs/first-workspace-contract.md
/// words them: §2.1 and §2.2 on the wire, §3 in the create's body and §3.3 in what comes back.
final class FirstWorkspaceAPIClientTests: XCTestCase {
    override func tearDown() {
        FirstWorkspaceURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FirstWorkspaceURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(), session: URLSession(configuration: configuration))
    }

    private func json(_ body: Data?) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(body)) as? [String: Any])
    }

    func testAskingPostsThePathAsTyped() async throws {
        let seen = SeenRequests()
        FirstWorkspaceURLProtocol.handler = { request in
            seen.record(request)
            return (201, Data(#"{"path":"~/code/app","status":"pending"}"#.utf8))
        }
        try await client().askDirProbe(runnerID: "runner", path: "~/code/app")
        let request = try XCTUnwrap(seen.last)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/runners/runner/dir-probe")
        XCTAssertEqual(try json(seen.lastBody)["path"] as? String, "~/code/app")
    }

    func testReadingNamesThePathInTheQueryAndReadsTheAnswer() async throws {
        let seen = SeenRequests()
        FirstWorkspaceURLProtocol.handler = { request in
            seen.record(request)
            return (200, Data(#"""
            {"path":"~/code/app","status":"done","result":{"path":"/home/orbit/code/app","exists":true,"isDir":true,
             "isGit":true,"branch":"main","isHome":false,"freeBytes":5368709120}}
            """#.utf8))
        }
        let answer = try await client().readDirProbe(runnerID: "runner", path: "~/code/app")
        let request = try XCTUnwrap(seen.last)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/runners/runner/dir-probe")
        let query = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(query, [URLQueryItem(name: "path", value: "~/code/app")])
        XCTAssertEqual(answer.status, "done")
        XCTAssertEqual(answer.result, DirProbe(path: "/home/orbit/code/app", exists: true, isDir: true, isGit: true,
                                               branch: "main", isHome: false, freeBytes: 5_368_709_120))
    }

    func testAnOfflineMachinesRefusalIsTheServersOwnWords() async throws {
        FirstWorkspaceURLProtocol.handler = { _ in
            (400, Data(#"{"message":"Runner is offline — it can only look while connected"}"#.utf8))
        }
        do {
            try await client().askDirProbe(runnerID: "runner", path: "/x")
            XCTFail("an offline machine is refused")
        } catch {
            XCTAssertTrue(APIClient.failureReason(error).contains("Runner is offline"))
        }
    }

    func testAnAnswerIsReadLeniently() throws {
        // A look that failed, with nothing but its error; `freeBytes` a string, as a BIGINT would be.
        let probe = try JSONDecoder().decode(DirProbe.self, from: Data(#"""
        {"path":"/x","exists":false,"isDir":false,"isGit":false,"branch":null,"isHome":false,
         "freeBytes":"42","error":"permission denied"}
        """#.utf8))
        XCTAssertEqual(probe.freeBytes, 42)
        XCTAssertEqual(probe.error, "permission denied")
        // An unknown status stays itself, and `result` is absent rather than a failed read.
        let answer = try JSONDecoder().decode(DirProbeAnswer.self, from: Data(#"{"path":"/x","status":"probing"}"#.utf8))
        XCTAssertEqual(answer.status, "probing")
        XCTAssertNil(answer.result)
    }

    /// One request makes the workspace, the session and the message: the machine and the folder are
    /// named, no workspace is, and the engine and its credential travel because there is nothing to
    /// inherit them from.
    func testASessionThatMakesItsWorkspaceNamesTheMachineAndTheFolder() async throws {
        let seen = SeenRequests()
        FirstWorkspaceURLProtocol.handler = { request in
            seen.record(request)
            return (201, Data(#"{"id":"s","status":"PENDING","agentId":"w","createdWorkspace":true}"#.utf8))
        }
        let session = try await client().createSession(CreateSessionRequest(
            prompt: "Fix it", assignedRunnerId: "runner", engine: "claude", provider: "claude",
            newWorkspace: NewWorkspaceRequest(newFolder: "app")))
        let body = try json(seen.lastBody)
        XCTAssertEqual(seen.last?.url?.path, "/api/sessions")
        XCTAssertEqual(body["assignedRunnerId"] as? String, "runner")
        XCTAssertEqual(body["engine"] as? String, "claude")
        XCTAssertEqual(body["provider"] as? String, "claude")
        XCTAssertNil(body["agentId"], "§3: no workspace is named")
        XCTAssertEqual(body["newWorkspace"] as? [String: String], ["newFolder": "app"])
        XCTAssertEqual(session.agentId, "w")
        XCTAssertEqual(session.createdWorkspace, true)
    }

    func testAnExistingFolderGoesAsItsPathAlone() throws {
        let data = try JSONEncoder().encode(NewWorkspaceRequest(workDir: "/home/orbit/code/app"))
        XCTAssertEqual(try JSONSerialization.jsonObject(with: data) as? [String: String],
                       ["workDir": "/home/orbit/code/app"])
    }

    func testAnOrdinaryCreateCarriesNoNewWorkspace() throws {
        let data = try JSONEncoder().encode(CreateSessionRequest(prompt: "Hi", agentId: "w"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(body["newWorkspace"])
        XCTAssertEqual(body["agentId"] as? String, "w")
    }

    func testARunnerCarriesWhereItWasRegistered() throws {
        let row = try JSONDecoder().decode(Runner.self, from: Data(#"{"id":"r","name":"m","registerDir":"~/code/app"}"#.utf8))
        XCTAssertEqual(row.registerDir, "~/code/app")
        let older = try JSONDecoder().decode(Runner.self, from: Data(#"{"id":"r","name":"m"}"#.utf8))
        XCTAssertNil(older.registerDir)
    }
}

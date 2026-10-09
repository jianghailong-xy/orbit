import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class ManagedRunnerURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, body: Data))?
    static var requests: [(method: String, path: String, body: Data)] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        Self.requests.append((request.httpMethod ?? "", request.url?.path ?? "", managedSentBody(of: request)))
        let result = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: result.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: result.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// On macOS the URL loading system hands a URLProtocol the body as `httpBodyStream`.
private func managedSentBody(of request: URLRequest) -> Data {
    if let body = request.httpBody, !body.isEmpty { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        if read <= 0 { break }
        data.append(contentsOf: buffer[0..<read])
    }
    stream.close()
    return data
}

/// The managed runner endpoints as macOS and iOS call them: the capability (a pre-feature server's
/// 404 is no capability), the status read, and the two writes — Retry names the revision it read
/// and one idempotency key, Set up only the key. Every answer is a server state sample from
/// src/shared/src/managed-runner-states.fixture.json.
final class ManagedRunnerAPIClientTests: XCTestCase {
    override func setUp() {
        super.setUp()
        ManagedRunnerURLProtocol.requests = []
    }

    override func tearDown() {
        ManagedRunnerURLProtocol.handler = nil
        ManagedRunnerURLProtocol.requests = []
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ManagedRunnerURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    /// A state's status body, exactly as the fixture (and so the server) has it.
    private static func body(_ name: String) throws -> Data {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var source: URL?
        for _ in 0..<12 {
            let candidate = directory.appendingPathComponent("src/shared/src/managed-runner-states.fixture.json")
            if FileManager.default.fileExists(atPath: candidate.path) { source = candidate; break }
            directory.deleteLastPathComponent()
        }
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: XCTUnwrap(source))) as? [String: Any]
        let states = try XCTUnwrap(object?["states"] as? [[String: Any]])
        let entry = try XCTUnwrap(states.first { $0["name"] as? String == name }, name)
        return try JSONSerialization.data(withJSONObject: XCTUnwrap(entry["status"]))
    }

    func testAPreFeatureServersCapabilityReadIsNoCapability() async throws {
        ManagedRunnerURLProtocol.handler = { _ in
            (404, Data(#"{"message":"Cannot GET /api/auth/capabilities","error":"Not Found","statusCode":404}"#.utf8))
        }
        let capabilities = try await client().serverCapabilities()
        XCTAssertNil(capabilities)
        XCTAssertFalse(ManagedRunnerLogic.offered(capabilities))
        XCTAssertEqual(ManagedRunnerURLProtocol.requests.map(\.path), ["/api/auth/capabilities"])
    }

    func testTheCapabilityAndTheStatusAreRead() async throws {
        let sleeping = try Self.body("sleeping")
        ManagedRunnerURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/auth/capabilities": return (200, Data(#"{"managedRunners":{"enabled":true,"contractVersion":1}}"#.utf8))
            case "/api/managed-runner": return (200, sleeping)
            default: return (404, Data())
            }
        }
        let api = client()
        let offered = ManagedRunnerLogic.offered(try await api.serverCapabilities())
        XCTAssertTrue(offered)
        let status = try await api.managedRunnerStatus()
        XCTAssertEqual(ManagedRunnerLogic.display(status)?.kind, .sleeping)
        XCTAssertEqual(ManagedRunnerURLProtocol.requests.map(\.method), ["GET", "GET"])
    }

    func testRetryPostsTheRevisionItReadAndOneIdempotencyKey() async throws {
        let preparing = try Self.body("preparing: requested")
        ManagedRunnerURLProtocol.handler = { request in
            request.httpMethod == "POST" && request.url?.path == "/api/managed-runner/retry" ? (202, preparing) : (404, Data())
        }
        let status = try await client().retryManagedRunner(revision: 9, idempotencyKey: "retry-key-1")
        XCTAssertEqual(ManagedRunnerLogic.display(status)?.kind, .preparing)
        let sent = try XCTUnwrap(ManagedRunnerURLProtocol.requests.first)
        XCTAssertEqual(sent.method, "POST")
        XCTAssertEqual(sent.path, "/api/managed-runner/retry")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: sent.body) as? [String: Any])
        XCTAssertEqual(body["idempotencyKey"] as? String, "retry-key-1")
        XCTAssertEqual(body["revision"] as? Int, 9)
    }

    func testEachRetryPressIsItsOwnRequest() async throws {
        let preparing = try Self.body("preparing: requested")
        ManagedRunnerURLProtocol.handler = { _ in (202, preparing) }
        let api = client()
        _ = try await api.retryManagedRunner(revision: 9)
        _ = try await api.retryManagedRunner(revision: 9)
        let keys = try ManagedRunnerURLProtocol.requests.map {
            try XCTUnwrap(JSONSerialization.jsonObject(with: $0.body) as? [String: Any])["idempotencyKey"] as? String
        }
        XCTAssertEqual(keys.count, 2)
        XCTAssertNotEqual(keys[0], keys[1])
    }

    func testSetUpPostsTheEnsureWithItsKeyAlone() async throws {
        let preparing = try Self.body("preparing: requested")
        ManagedRunnerURLProtocol.handler = { request in
            request.httpMethod == "POST" && request.url?.path == "/api/managed-runner/ensure" ? (202, preparing) : (404, Data())
        }
        _ = try await client().ensureManagedRunner(idempotencyKey: "ensure-key-1")
        let sent = try XCTUnwrap(ManagedRunnerURLProtocol.requests.first)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: sent.body) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["idempotencyKey"])
    }

    func testARefusedRetryCarriesTheServersCodeAndSentence() async throws {
        ManagedRunnerURLProtocol.handler = { _ in
            (409, Data(#"{"code":"MANAGED_RUNNER_REVISION_CONFLICT","message":"The managed runner moved on: read it again."}"#.utf8))
        }
        do {
            _ = try await client().retryManagedRunner(revision: 9)
            XCTFail("a 409 is a refusal")
        } catch {
            XCTAssertEqual(APIClient.refusalCode(error), "MANAGED_RUNNER_REVISION_CONFLICT")
            XCTAssertEqual(APIClient.failureReason(error), "The managed runner moved on: read it again.")
        }
    }
}

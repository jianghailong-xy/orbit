import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class AccountPauseURLProtocol: URLProtocol, @unchecked Sendable {
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

final class AccountPauseAPIClientTests: XCTestCase {
    override func tearDown() {
        AccountPauseURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AccountPauseURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(), session: URLSession(configuration: configuration))
    }

    func testPausesTheNamedRunnerSlot() async throws {
        let seen = PauseSeenRequest()
        AccountPauseURLProtocol.handler = { request in
            seen.record(request)
            return (200, Data("{}".utf8))
        }
        try await client().pauseRunnerAccount("runner", engine: .codex, account: "slot-2", durationMinutes: 120)
        let request = try XCTUnwrap(seen.request)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/runners/runner/accounts/codex/slot-2/pause")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Int])
        XCTAssertEqual(body, ["durationMinutes": 120])
    }

    func testResumesTheNamedPoolAccountWithAnExplicitNull() async throws {
        let seen = PauseSeenRequest()
        AccountPauseURLProtocol.handler = { request in
            seen.record(request)
            return (204, Data())
        }
        try await client().pausePoolMember(poolID: "pool", memberID: "login:…AB12", durationMinutes: nil)
        let request = try XCTUnwrap(seen.request)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/providers/pools/pool/members/login:…AB12/pause")
        XCTAssertTrue(request.url?.absoluteString.contains("%E2%80%A6AB12") == true)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertTrue(body["durationMinutes"] is NSNull)
    }

    func testPermissionFailureKeepsTheServersReason() async {
        AccountPauseURLProtocol.handler = { _ in
            (403, Data(#"{"message":"Only the contributor or an admin can pause this account"}"#.utf8))
        }
        do {
            try await client().pausePoolMember(poolID: "pool", memberID: "key", durationMinutes: 60)
            XCTFail("Forbidden pause succeeded")
        } catch {
            XCTAssertEqual(APIClient.failureReason(error), "Only the contributor or an admin can pause this account")
        }
    }
}

/// The request the stub was handed, read back by the test once the call returned.
private final class PauseSeenRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: URLRequest?

    func record(_ request: URLRequest) {
        // On macOS URLProtocol receives the body as a stream, as in ProfileRecorder.
        var captured = request
        if captured.httpBody == nil, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer[0..<count])
            }
            captured.httpBody = data
        }
        lock.lock()
        seen = captured
        lock.unlock()
    }

    var request: URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }
}

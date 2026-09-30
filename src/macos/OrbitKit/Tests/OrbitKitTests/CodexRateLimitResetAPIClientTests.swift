import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class CodexResetURLProtocol: URLProtocol, @unchecked Sendable {
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

final class CodexRateLimitResetAPIClientTests: XCTestCase {
    override func tearDown() {
        CodexResetURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CodexResetURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private static let operation = #"""
    {
      "id":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f","runnerId":"runner-1","clientRequestId":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e30",
      "accountFingerprint":"cxa1_0123456789abcdef0123456789abcdef",
      "status":"REFRESHING","consumeState":"CONFIRMED","consumeOutcome":"reset",
      "refreshState":"PENDING","failureCode":null,"lastErrorCode":null,
      "createdAt":"2026-09-30T04:00:00.000Z","updatedAt":"2026-09-30T04:00:02.000Z",
      "consumeConfirmedAt":"2026-09-30T04:00:01.000Z","completedAt":null
    }
    """#

    func testPlanUsageDecodesNestedResetCreditsAndNullableDetails() throws {
        let json = #"""
        {
          "provider":"codex",
          "primary":{"utilization":100,"resetsAt":"2026-09-30T12:58:00Z"},
          "rateLimitReset":{
            "protocolVersion":1,"support":"SUPPORTED",
            "accountFingerprint":"cxa1_0123456789abcdef0123456789abcdef",
            "rateLimitResetCredits":{"availableCount":4,"credits":null},
            "fetchedAt":"2026-09-30T04:00:00.000Z","generation":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e31","sequence":7
          }
        }
        """#
        let usage = try JSONDecoder().decode(PlanUsage.self, from: Data(json.utf8))
        let block = try XCTUnwrap(usage.rateLimitReset)
        XCTAssertEqual(block.support, "SUPPORTED")
        XCTAssertEqual(block.rateLimitResetCredits?.availableCount, 4)
        XCTAssertNil(block.rateLimitResetCredits?.credits)
    }

    func testResetOperationRoutesDecodeAndEncodeTheConfirmation() async throws {
        CodexResetURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET" && path.hasSuffix("/codex-rate-limit-reset") {
                return (200, Data(("{\"active\":" + Self.operation + ",\"latest\":" + Self.operation + "}").utf8))
            }
            if request.httpMethod == "GET" && path.hasSuffix("/codex-rate-limit-reset/0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f") {
                return (200, Data(Self.operation.utf8))
            }
            if request.httpMethod == "POST" && path.hasSuffix("/codex-rate-limit-reset") {
                let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String]) ?? [:]
                precondition(body["clientRequestId"] == "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e30")
                precondition(body["accountFingerprint"] == "cxa1_0123456789abcdef0123456789abcdef")
                precondition(body["workspaceId"] == "workspace-1")
                return (201, Data(("{\"operation\":" + Self.operation + ",\"replayed\":false}").utf8))
            }
            return (404, Data())
        }

        let api = client()
        let list = try await api.codexRateLimitResetOperations(runnerID: "runner-1")
        XCTAssertEqual(list.active?.id, "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f")
        let operation = try await api.codexRateLimitResetOperation(
            runnerID: "runner-1", operationID: "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f")
        XCTAssertEqual(operation.status, "REFRESHING")
        let response = try await api.createCodexRateLimitReset(
            runnerID: "runner-1",
            CreateCodexRateLimitResetRequest(
                clientRequestId: "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e30",
                accountFingerprint: "cxa1_0123456789abcdef0123456789abcdef",
                workspaceId: "workspace-1"))
        XCTAssertFalse(response.replayed)
    }
}

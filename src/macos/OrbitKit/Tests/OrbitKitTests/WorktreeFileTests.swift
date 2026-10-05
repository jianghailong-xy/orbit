import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class WorktreeFileURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw APIError.invalidResponse }
            let (status, bytes) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status,
                                           httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: bytes)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}

final class WorktreeFileTests: XCTestCase {
    override func tearDown() {
        WorktreeFileURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorktreeFileURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    func testReadsExactRelativePathAndUnmodifiedBinaryBytesWithoutCache() async throws {
        let path = "docs/mocks/a b+#中文.png"
        let bytes = Data([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
        WorktreeFileURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/sessions/session-1/worktree-file")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(query, [URLQueryItem(name: "path", value: path)])
            XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-cache")
            XCTAssertEqual(request.timeoutInterval, 45)
            return (200, bytes)
        }

        let result = try await client().sessionWorktreeFile(sessionID: "session-1", path: path)
        XCTAssertEqual(result, bytes)
    }

    func testSamePathIsReadAgainAndDoesNotReusePreviousBytes() async throws {
        let api = client()
        WorktreeFileURLProtocol.handler = { _ in (200, Data([1])) }
        let first = try await api.sessionWorktreeFile(sessionID: "s1", path: "image.png")
        WorktreeFileURLProtocol.handler = { _ in (200, Data([2])) }
        let second = try await api.sessionWorktreeFile(sessionID: "s1", path: "image.png")
        XCTAssertEqual(first, Data([1]))
        XCTAssertEqual(second, Data([2]))
    }

    func testOversizeErrorIsPreservedForThePreview() async throws {
        let body = #"{"message":"file too large"}"#
        WorktreeFileURLProtocol.handler = { _ in (413, Data(body.utf8)) }
        do {
            _ = try await client().sessionWorktreeFile(sessionID: "s1", path: "large.zip")
            XCTFail("Expected the file read to fail")
        } catch {
            XCTAssertEqual(error as? APIError, .http(status: 413, body: body))
            XCTAssertEqual(WorktreeFileFailure.from(error).title, "File too large")
            XCTAssertFalse(WorktreeFileFailure.from(error).canRetry)
        }
    }

    func testFailuresDistinguishMissingOfflineTimeoutAndDeleted() {
        let missing = WorktreeFileFailure.from(APIError.http(status: 404, body: nil))
        XCTAssertEqual(missing.title, "File not found")
        XCTAssertTrue(missing.canRetry)
        let offline = WorktreeFileFailure.from(APIError.http(status: 503, body: nil))
        XCTAssertEqual(offline.title, "Runner unavailable")
        XCTAssertTrue(offline.canRetry)
        let timeout = WorktreeFileFailure.from(APIError.http(status: 504, body: nil))
        XCTAssertEqual(timeout, .from(URLError(.timedOut)))
        XCTAssertTrue(timeout.canRetry)
        XCTAssertEqual(WorktreeFileFailure.deleted.title, "File deleted")
        XCTAssertFalse(WorktreeFileFailure.deleted.canRetry)
    }

    func testOtherReadErrorsOfferRetryAndReadableServerReason() {
        let failure = WorktreeFileFailure.from(APIError.http(
            status: 502, body: #"{"message":"The file could not be read"}"#))
        XCTAssertEqual(failure.title, "Couldn't load file")
        XCTAssertEqual(failure.detail, "The file could not be read")
        XCTAssertTrue(failure.canRetry)
    }
}

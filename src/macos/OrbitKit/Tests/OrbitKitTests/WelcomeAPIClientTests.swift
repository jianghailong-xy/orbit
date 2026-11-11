import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class WelcomeURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, body: Data))?
    static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        Self.requests.append(request)
        let result = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: result.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: result.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// The welcome card's new-account read (board 03, rule 1): `GET /sessions?view=open&limit=1` and
/// `?view=completed&limit=1`, counted. A row of any shape counts; an answer that is not an array throws,
/// which the app reads as an account that is not new.
final class WelcomeAPIClientTests: XCTestCase {
    override func setUp() {
        super.setUp()
        WelcomeURLProtocol.requests = []
    }

    override func tearDown() {
        WelcomeURLProtocol.handler = nil
        WelcomeURLProtocol.requests = []
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WelcomeURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private func query(_ request: URLRequest) -> [String: String] {
        let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        return Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
    }

    func testEachListIsAskedForOneRow() async throws {
        WelcomeURLProtocol.handler = { request in
            let view = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "view" }?.value
            return (200, Data((view == "open" ? "[]" : #"[{"id":"s1","anything":{"else":1}}]"#).utf8))
        }
        let api = client()
        let open = try await api.sessionRowCount(view: .open)
        let completed = try await api.sessionRowCount(view: .completed)
        XCTAssertEqual(open, 0)
        XCTAssertEqual(completed, 1)
        XCTAssertFalse(Welcome.isNewAccount(openRows: open, completedRows: completed))
        XCTAssertEqual(WelcomeURLProtocol.requests.map { $0.url?.path }, ["/api/sessions", "/api/sessions"])
        XCTAssertEqual(WelcomeURLProtocol.requests.map(query),
                       [["view": "open", "limit": "1"], ["view": "completed", "limit": "1"]])
    }

    func testTwoEmptyListsAreANewAccount() async throws {
        WelcomeURLProtocol.handler = { _ in (200, Data("[]".utf8)) }
        let api = client()
        let open = try await api.sessionRowCount(view: .open)
        let completed = try await api.sessionRowCount(view: .completed)
        XCTAssertTrue(Welcome.isNewAccount(openRows: open, completedRows: completed))
    }

    func testAnAnswerThatIsNoListThrows() async {
        WelcomeURLProtocol.handler = { _ in (200, Data(#"{"items":[]}"#.utf8)) }
        do {
            _ = try await client().sessionRowCount(view: .open)
            XCTFail("an object is not an empty list")
        } catch {}
    }

    func testAFailedReadThrows() async {
        WelcomeURLProtocol.handler = { _ in (500, Data(#"{"message":"boom"}"#.utf8)) }
        do {
            _ = try await client().sessionRowCount(view: .completed)
            XCTFail("a failed read is no answer")
        } catch {}
    }

    /// The managed default workspace's draft, from the shared fixture's mapping, under either spelling.
    func testTheManagedDefaultDraftIsTheStatusWorkspace() throws {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var source: URL?
        for _ in 0..<12 {
            let candidate = directory.appendingPathComponent("src/shared/src/managed-runner-states.fixture.json")
            if FileManager.default.fileExists(atPath: candidate.path) { source = candidate; break }
            directory.deleteLastPathComponent()
        }
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: XCTUnwrap(source))) as? [String: Any]
        let states = try XCTUnwrap(object?["states"] as? [[String: Any]])
        let entry = try XCTUnwrap(states.first { $0["name"] as? String == "preparing: requested" })
        let status = try JSONDecoder().decode(ManagedRunnerStatus.self,
                                              from: JSONSerialization.data(withJSONObject: XCTUnwrap(entry["status"])))
        let workspace = try XCTUnwrap(status.workspaceId)
        XCTAssertTrue(Welcome.isManagedDefaultDraft(status: status, workspaceID: workspace))
        XCTAssertFalse(Welcome.isManagedDefaultDraft(status: status, workspaceID: "another"))
        XCTAssertFalse(Welcome.isManagedDefaultDraft(status: status, workspaceID: nil))
        XCTAssertFalse(Welcome.isManagedDefaultDraft(status: nil, workspaceID: workspace))
    }
}

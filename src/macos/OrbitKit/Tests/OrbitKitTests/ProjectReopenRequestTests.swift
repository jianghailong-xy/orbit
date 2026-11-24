import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class ReopenDoorProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, data: Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let answer = Self.handler?(request) ?? (status: 500, data: Data())
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// PROJECT_REOPEN on the Apple clients (docs/project-reopen-request-design.md §6): the wire shape, the card's words
/// and the Reopen door.
final class ProjectReopenRequestTests: XCTestCase {
    override func tearDown() {
        ReopenDoorProtocol.handler = nil
        super.tearDown()
    }

    private let pending = #"""
    {"id":"r1","kind":"PROJECT_REOPEN","state":"PENDING","title":"Reopen project “Share to Orbit”?",
     "why":"The Android share sheet still opens the old screen.","askedBySessionId":"s1","askedBySessionTitle":"Fix share",
     "projectId":"p1","createdAt":"2026-11-24T00:00:00Z",
     "payload":{"projectId":"p1","statusAtAsk":"DONE","settledAt":"2026-11-18T09:00:00Z",
                "plannedWork":"Add a criterion for the share target.",
                "askers":[{"sessionId":"s1","askedAt":"2026-11-24T00:00:00Z","title":"Fix share"},
                          {"sessionId":"s2","askedAt":"2026-11-24T00:05:00Z","title":"Release check"}]}}
    """#

    private func decode(_ json: String) throws -> OwnerRequest {
        try JSONDecoder().decode(OwnerRequest.self, from: Data(json.utf8))
    }

    func testTheKindAndItsPayloadDecode() throws {
        let request = try decode(pending)
        XCTAssertEqual(request.kind, .projectReopen)
        let facts = try XCTUnwrap(ProjectReopenFacts(request))
        XCTAssertEqual(facts.projectId, "p1")
        XCTAssertEqual(facts.statusAtAsk, "DONE")
        XCTAssertEqual(facts.plannedWork, "Add a criterion for the share target.")
        XCTAssertEqual(facts.askers.map(\.sessionId), ["s1", "s2"])
        XCTAssertEqual(facts.otherAskerTitles(besides: "s1"), ["Release check"])
        XCTAssertNil(ProjectReopenFacts(try decode(pending.replacingOccurrences(of: "PROJECT_REOPEN", with: "CONFIRM"))))
    }

    /// What shipped builds do: a kind they do not know fails that row's decode, and the list drops the row. The
    /// request is invisible to them, which is why the owner can always answer on the project page.
    func testAListDropsAKindItDoesNotKnowAndKeepsTheRest() throws {
        let json = #"{"requests":[\#(pending),{"id":"r2","kind":"CONFIRM","state":"PENDING","title":"t","askedBySessionId":"s","createdAt":"2026-11-24T00:00:00Z"},{"id":"r3","kind":"FUTURE_KIND","state":"PENDING","title":"t","askedBySessionId":"s","createdAt":"2026-11-24T00:00:00Z"}]}"#
        let list = try JSONDecoder().decode(OwnerRequestList.self, from: Data(json.utf8))
        XCTAssertEqual(list.requests.map(\.id), ["r1", "r2"])
    }

    func testTheCardsWords() throws {
        XCTAssertEqual(ProjectReopenCopy.title("Share to Orbit"), "↺ Reopen project “Share to Orbit”?")
        XCTAssertEqual(ProjectReopenCopy.agentSays("x"), "The agent says: x")
        XCTAssertEqual(OwnerRequests.primaryLabel(.projectReopen), "Reopen")
        XCTAssertEqual(ProjectReopenCopy.chat, "💬 Chat about this")
        XCTAssertEqual(ProjectReopenCopy.askedBy("Fix share"), "Asked by Fix share")
        XCTAssertEqual(ProjectReopenCopy.alsoAskedBy(["A", "B"]), "Also asked by A, B")
        XCTAssertNil(ProjectReopenCopy.alsoAskedBy([]))
        XCTAssertTrue(ProjectReopenCopy.settledLine(status: "DONE", settledAt: "2026-11-18T12:00:00Z").hasPrefix("DONE since Nov "))
        XCTAssertTrue(ProjectReopenCopy.settledLine(status: "CANCELLED", settledAt: "2026-11-18T12:00:00Z").hasPrefix("Cancelled since "))
        XCTAssertEqual(Notifications.ownerRequestActionTitle(.projectReopen), "Review")
    }

    func testTheEndedLines() throws {
        let declined = try decode(pending.replacingOccurrences(of: #""state":"PENDING""#, with: #""state":"DECLINED","resolutionNote":"Not now""#))
        XCTAssertEqual(OwnerRequests.outcomeLine(declined, runner: ""), "Declined: “Not now”")
        let done = try decode(pending.replacingOccurrences(of: #""state":"PENDING""#, with: #""state":"DONE","resolvedAt":"2026-11-23T14:02:00Z""#))
        XCTAssertTrue(OwnerRequests.outcomeLine(done, runner: "").hasPrefix("Reopened · Nov "))
    }

    func testTheProjectPageFindsItsPendingRequest() throws {
        let mine = try decode(pending)
        let other = try decode(pending.replacingOccurrences(of: #""projectId":"p1","statusAtAsk""#, with: #""projectId":"p2","statusAtAsk""#)
            .replacingOccurrences(of: #""id":"r1""#, with: #""id":"r9""#))
        XCTAssertEqual(OwnerRequests.pendingReopens([other, mine], projectID: "p1").map(\.id), ["r1"])
    }

    func testReopenGoesToTheReopenProjectDoor() async throws {
        final class Seen: @unchecked Sendable { var rows: [(String, String)] = [] }
        let seen = Seen()
        ReopenDoorProtocol.handler = { request in
            seen.rows.append((request.httpMethod ?? "", request.url?.path ?? ""))
            return (200, Data(#"{"id":"r1","kind":"PROJECT_REOPEN","state":"DONE","title":"t","askedBySessionId":"s","createdAt":"2026-11-24T00:00:00Z"}"#.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ReopenDoorProtocol.self]
        let api = APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                            session: URLSession(configuration: configuration))
        let answered = try await api.reopenProjectFromOwnerRequest("r1")
        XCTAssertEqual(answered.state, .done)
        XCTAssertEqual(seen.rows.count, 1)
        XCTAssertEqual(seen.rows[0].0, "POST")
        XCTAssertEqual(seen.rows[0].1, "/api/owner-requests/r1/reopen-project")
    }
}

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class DeltaURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, headers: [String: String], data: Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        let answer = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status,
                                       httpVersion: nil, headerFields: answer.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// A scripted server: each request that reaches the wire is recorded (query and If-None-Match) and
/// answered by the next scripted reply.
private final class Script: @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [(Int, [String: String], String)]
    private var log: [String] = []

    init(_ replies: [(Int, [String: String], String)]) { self.replies = replies }

    func answer(_ request: URLRequest) -> (status: Int, headers: [String: String], data: Data) {
        lock.lock()
        defer { lock.unlock() }
        let tag = request.value(forHTTPHeaderField: "If-None-Match").map { " if-none-match=\($0)" } ?? ""
        log.append((request.url?.query ?? "") + tag)
        guard !replies.isEmpty else { return (500, [:], Data()) }
        let (status, headers, body) = replies.removeFirst()
        return (status, headers, Data(body.utf8))
    }

    var requests: [String] {
        lock.lock()
        defer { lock.unlock() }
        return log
    }
}

private func row(_ id: String, _ title: String = "t") -> String {
    #"{"id":"\#(id)","title":"\#(title)","status":"AWAITING_INPUT"}"#
}

private func session(_ id: String, _ title: String = "t") -> Session {
    try! JSONDecoder().decode(Session.self, from: Data(row(id, title).utf8))
}

/// The Open list's delta read: the client applies what changed since its cursor to the list the
/// server last sent under it, and falls back to the conditional full read whenever it cannot.
@MainActor
final class OpenListDeltaTests: XCTestCase {
    override func tearDown() {
        DeltaURLProtocol.handler = nil
        super.tearDown()
    }

    private func client(_ script: Script) -> APIClient {
        DeltaURLProtocol.handler = { script.answer($0) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeltaURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private func expect(_ reader: OpenListReader, _ expected: OpenListReader.Outcome,
                        line: UInt = #line) async throws {
        let outcome = try await reader.read()
        XCTAssertEqual(outcome, expected, line: line)
    }

    // MARK: merging

    func testAChangedRowIsReplacedInPlace() {
        let delta = OpenListDelta(upserts: [session("b", "new")], removedIds: [], order: nil, cursor: "c2")
        XCTAssertEqual(delta.applied(to: [session("a"), session("b", "old"), session("c")]),
                       [session("a"), session("b", "new"), session("c")])
    }

    func testARemovedRowLeavesTheRestInPlace() {
        let delta = OpenListDelta(upserts: [], removedIds: ["b"], order: ["a", "c"], cursor: "c2")
        XCTAssertEqual(delta.applied(to: [session("a"), session("b"), session("c")]),
                       [session("a"), session("c")])
    }

    func testANewRowLandsWhereTheServerOrderPutsIt() {
        let delta = OpenListDelta(upserts: [session("n"), session("c", "moved")], removedIds: ["a"],
                                  order: ["c", "n", "b"], cursor: "c2")
        XCTAssertEqual(delta.applied(to: [session("a"), session("b"), session("c")]),
                       [session("c", "moved"), session("n"), session("b")])
    }

    func testADeltaThatDoesNotFitItsBaseIsRefused() {
        // An order naming a row nobody has.
        XCTAssertNil(OpenListDelta(upserts: [], removedIds: [], order: ["a", "x"], cursor: "c")
            .applied(to: [session("a")]))
        // A new row with no order to place it.
        XCTAssertNil(OpenListDelta(upserts: [session("x")], removedIds: [], order: nil, cursor: "c")
            .applied(to: [session("a")]))
        // An upsert the order leaves out.
        XCTAssertNil(OpenListDelta(upserts: [session("x")], removedIds: [], order: ["a"], cursor: "c")
            .applied(to: [session("a")]))
    }

    // MARK: the wire

    func testTheDeltaReadAsksSinceTheCursorAndDecodesBothShapes() async throws {
        let script = Script([
            (200, [:], #"{"full":true,"sessions":[\#(row("a"))],"cursor":"c1"}"#),
            (200, [:], #"{"full":false,"upserts":[\#(row("a", "x"))],"removedIds":["b"],"order":["a"],"cursor":"c2"}"#),
        ])
        let api = client(script)
        let full = try await api.listOpenSessions(since: "")
        XCTAssertEqual(full, .full([session("a")], cursor: "c1"))
        let delta = try await api.listOpenSessions(since: "c1")
        XCTAssertEqual(delta, .delta(OpenListDelta(upserts: [session("a", "x")], removedIds: ["b"],
                                                   order: ["a"], cursor: "c2")))
        XCTAssertEqual(script.requests, ["view=open&since=", "view=open&since=c1"])
    }

    /// A server that predates the delta read ignores `since` and answers the plain array.
    func testAnOlderServersPlainArrayIsAWholeListWithNoCursor() async throws {
        let api = client(Script([(200, [:], "[\(row("a"))]")]))
        let read = try await api.listOpenSessions(since: "")
        XCTAssertEqual(read, .full([session("a")], cursor: nil))
    }

    func testARejectedSinceAnswersNil() async throws {
        let api = client(Script([(400, [:], "{}")]))
        let read = try await api.listOpenSessions(since: "c1")
        XCTAssertNil(read)
    }

    // MARK: polling

    func testPollsApplyDeltasToTheListAsFetched() async throws {
        let script = Script([
            (200, [:], #"{"full":true,"sessions":[\#(row("a")),\#(row("b"))],"cursor":"c1"}"#),
            (200, [:], #"{"full":false,"upserts":[],"removedIds":[],"cursor":"c1"}"#),
            (200, [:], #"{"full":false,"upserts":[\#(row("b", "x"))],"removedIds":[],"cursor":"c2"}"#),
            (200, [:], #"{"full":false,"upserts":[\#(row("n"))],"removedIds":["a"],"order":["n","b"],"cursor":"c3"}"#),
        ])
        let reader = OpenListReader(api: client(script))
        try await expect(reader, .list([session("a"), session("b")]))
        reader.adopted()
        try await expect(reader, .unchanged)
        try await expect(reader, .list([session("a"), session("b", "x")]))
        reader.adopted()
        try await expect(reader, .list([session("n"), session("b", "x")]))
        XCTAssertEqual(script.requests, ["view=open&since=", "view=open&since=c1",
                                         "view=open&since=c1", "view=open&since=c2"])
    }

    /// Which lists only changed rows in place, so the caller can apply those rows alone.
    func testAnInPlaceDeltaNamesTheRowsItReplaced() async throws {
        let script = Script([
            (200, [:], #"{"full":true,"sessions":[\#(row("a")),\#(row("b"))],"cursor":"c1"}"#),
            (200, [:], #"{"full":false,"upserts":[\#(row("b", "x"))],"removedIds":[],"cursor":"c2"}"#),
            (200, [:], #"{"full":false,"upserts":[],"removedIds":[],"cursor":"c2"}"#),
            (200, [:], #"{"full":false,"upserts":[],"removedIds":[],"order":["b","a"],"cursor":"c3"}"#),
            (200, [:], #"{"full":false,"upserts":[],"removedIds":["a"],"order":["b"],"cursor":"c4"}"#),
        ])
        let reader = OpenListReader(api: client(script))
        _ = try await reader.read()
        XCTAssertNil(reader.replacedRows, "a whole list")
        reader.adopted()
        _ = try await reader.read()
        XCTAssertEqual(reader.replacedRows, [session("b", "x")])
        reader.adopted()
        reader.invalidate()
        _ = try await reader.read()
        XCTAssertEqual(reader.replacedRows, [], "an empty delta after an event replaced nothing itself")
        reader.adopted()
        _ = try await reader.read()
        XCTAssertNil(reader.replacedRows, "a new order")
        reader.adopted()
        _ = try await reader.read()
        XCTAssertNil(reader.replacedRows, "a row removed")
    }

    /// An event folded into the caller's list since: an empty delta must hand back the server's list
    /// rather than vouch for the edited one, as the full read would.
    func testAnInvalidatedListIsNotAnsweredUnchanged() async throws {
        let script = Script([
            (200, [:], #"{"full":true,"sessions":[\#(row("a"))],"cursor":"c1"}"#),
            (200, [:], #"{"full":false,"upserts":[],"removedIds":[],"cursor":"c1"}"#),
        ])
        let reader = OpenListReader(api: client(script))
        _ = try await reader.read()
        reader.adopted()
        reader.invalidate()
        try await expect(reader, .list([session("a")]))
    }

    /// A cursor the server no longer holds comes back whole, with a cursor to go on from.
    func testAFullAnswerToACursorReplacesTheList() async throws {
        let script = Script([
            (200, [:], #"{"full":true,"sessions":[\#(row("a"))],"cursor":"c1"}"#),
            (200, [:], #"{"full":true,"sessions":[\#(row("z"))],"cursor":"c9"}"#),
            (200, [:], #"{"full":false,"upserts":[],"removedIds":[],"cursor":"c9"}"#),
        ])
        let reader = OpenListReader(api: client(script))
        _ = try await reader.read()
        reader.adopted()
        try await expect(reader, .list([session("z")]))
        reader.adopted()
        try await expect(reader, .unchanged)
        XCTAssertEqual(script.requests.last, "view=open&since=c9")
    }

    /// A delta that does not fit falls back to the conditional full read in the same poll, and the
    /// next poll starts a fresh cursor.
    func testADeltaThatDoesNotFitFallsBackToTheFullRead() async throws {
        let script = Script([
            (200, [:], #"{"full":true,"sessions":[\#(row("a"))],"cursor":"c1"}"#),
            (200, [:], #"{"full":false,"upserts":[],"removedIds":[],"order":["a","x"],"cursor":"c2"}"#),
            (200, ["ETag": "W/\"e1\""], "[\(row("a")),\(row("x"))]"),
            (200, [:], #"{"full":true,"sessions":[\#(row("a")),\#(row("x"))],"cursor":"c3"}"#),
        ])
        let reader = OpenListReader(api: client(script))
        _ = try await reader.read()
        reader.adopted()
        try await expect(reader, .list([session("a"), session("x")]))
        reader.adopted()
        try await expect(reader, .list([session("a"), session("x")]))
        XCTAssertEqual(script.requests, ["view=open&since=", "view=open&since=c1", "view=open",
                                         "view=open&since="])
    }

    /// A server that turns `since` down is read the old way in the same poll — tagged, 304 and all —
    /// until the retry interval has passed, and then asked for the delta again.
    func testARejectingServerIsPolledWithTheConditionalFullRead() async throws {
        let script = Script([
            (404, [:], "{}"),
            (200, ["ETag": "W/\"e1\""], "[\(row("a"))]"),
            (304, [:], ""),
            (200, [:], #"{"full":true,"sessions":[\#(row("a"))],"cursor":"c1"}"#),
        ])
        var clock = Date(timeIntervalSince1970: 0)
        let reader = OpenListReader(api: client(script), deltaRetryInterval: 300, now: { clock })
        try await expect(reader, .list([session("a")]))
        reader.adopted()
        XCTAssertFalse(reader.usesDelta)
        try await expect(reader, .unchanged)
        clock = clock.addingTimeInterval(301)
        XCTAssertTrue(reader.usesDelta)
        try await expect(reader, .list([session("a")]))
        XCTAssertEqual(script.requests, ["view=open&since=", "view=open",
                                         "view=open if-none-match=W/\"e1\"", "view=open&since="])
    }

    /// An older server's plain array is the list itself — no second request — and later polls use
    /// the conditional full read.
    func testAnOlderServerIsReadTheOldWay() async throws {
        let script = Script([
            (200, ["ETag": "W/\"e1\""], "[\(row("a"))]"),
            (200, ["ETag": "W/\"e2\""], "[\(row("b"))]"),
            (304, [:], ""),
        ])
        let reader = OpenListReader(api: client(script))
        try await expect(reader, .list([session("a")]))
        reader.adopted()
        try await expect(reader, .list([session("b")]))
        reader.adopted()
        try await expect(reader, .unchanged)
        XCTAssertEqual(script.requests, ["view=open&since=", "view=open",
                                         "view=open if-none-match=W/\"e2\""])
    }
}

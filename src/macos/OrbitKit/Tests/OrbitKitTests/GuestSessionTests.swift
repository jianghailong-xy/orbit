import Foundation
import XCTest
@testable import OrbitKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class GuestDoorURLProtocol: URLProtocol, @unchecked Sendable {
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

private func bodyOf(_ request: URLRequest) -> String {
    if let body = request.httpBody { return String(decoding: body, as: UTF8.self) }
    guard let stream = request.httpBodyStream else { return "" }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        if read <= 0 { break }
        data.append(contentsOf: buffer[0..<read])
    }
    return String(decoding: data, as: UTF8.self)
}

private final class GuestDoorRecorder: @unchecked Sendable {
    struct Sent: Equatable {
        let method: String?
        let path: String?
        let query: String?
        let body: String
    }

    private let lock = NSLock()
    private var storage: [Sent] = []

    func append(_ request: URLRequest) {
        lock.lock()
        storage.append(Sent(method: request.httpMethod, path: request.url?.path, query: request.url?.query,
                            body: bodyOf(request)))
        lock.unlock()
    }

    var sent: [Sent] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

/// The guest's side of session guests (docs/session-guests-design.md §4): the guest door's reads and
/// its one write, Shared with me, and the guest view's states — in the web's own words
/// (SharedWithMe.tsx, GuestSessionPage.tsx).
final class GuestSessionTests: XCTestCase {

    override func tearDown() {
        GuestDoorURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GuestDoorURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private func answer(_ json: String, status: Int = 200) -> GuestDoorRecorder {
        let recorder = GuestDoorRecorder()
        GuestDoorURLProtocol.handler = { request in
            recorder.append(request)
            return (status, Data(json.utf8))
        }
        return recorder
    }

    private static let root = """
    {"title":"Fix the login redirect\\nmore","workspaceName":"orbit","status":"RUNNING","runStatus":"RUNNING",
     "sessionState":"RUNNING","runState":"RUNNING","lifecycleState":"OPEN","filingState":"OPEN",
     "createdAt":"2026-11-13T10:00:00.000Z","hasMore":true,"ownerName":"Ana","waitingOnOwner":false,
     "events":[
       {"seq":7,"type":"user","payload":{"text":"hi","externalSender":{"source":"ORBIT_GUEST","name":"Bo"}},"turnId":"t1","ts":"2026-11-13T10:00:01.000Z"},
       {"seq":8,"type":"assistant","payload":{"text":"hello"},"turnId":"t1","ts":"2026-11-13T10:00:02.000Z","truncated":false}
     ]}
    """

    // MARK: The door

    func testSharedWithMeIsOneRead() async throws {
        let recorder = answer("""
        {"sessions":[{"id":"34A","title":"Fix it","ownerName":"Ana","status":"RUNNING","sessionState":"RUNNING",
          "lifecycleState":"OPEN","addedAt":"2026-11-13T09:00:00.000Z","lastTurnAt":null}]}
        """)
        let sessions = try await client().guestSessions()
        XCTAssertEqual(sessions.map(\.id), ["34A"])
        XCTAssertEqual(sessions.first?.ownerName, "Ana")
        XCTAssertNil(sessions.first?.lastTurnAt)
        XCTAssertEqual(recorder.sent, [.init(method: "GET", path: "/api/guest-sessions", query: nil, body: "")])
    }

    func testTheGuestViewsRootDecodesTheHeadAndTheTail() async throws {
        let recorder = answer(Self.root)
        let session = try await client().guestSession("34A", limit: 200)
        XCTAssertEqual(session.ownerName, "Ana")
        XCTAssertEqual(session.title, "Fix the login redirect\nmore")
        XCTAssertTrue(session.hasMore)
        XCTAssertEqual(session.events.map(\.seq), [7, 8])
        XCTAssertEqual(session.events.first?.type, .user)
        XCTAssertEqual(session.state.resolvedRunState, .running)
        XCTAssertFalse(session.state.waitingOnOwner)
        XCTAssertEqual(recorder.sent, [.init(method: "GET", path: "/api/guest-sessions/34A",
                                             query: "limit=200&maxPayload=\(APIClient.maxEventPayload)", body: "")])
    }

    func testAHeadMissingItsNewFieldsStillDecodes() throws {
        let json = #"{"title":"T","ownerName":"Ana","status":"CANCELLED","events":[]}"#
        let session = try JSONDecoder().decode(GuestSession.self, from: Data(json.utf8))
        XCTAssertEqual(session.state.resolvedRunState, .ended)
        XCTAssertFalse(session.hasMore)
        XCTAssertFalse(session.state.live)
    }

    func testFollowingAsksAfterTheNewestSeqAndPagingAsksBeforeTheOldest() async throws {
        let after = answer("""
        {"title":"T","status":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN",
         "events":[{"seq":9,"type":"assistant","payload":{"text":"x"}}],"after":null,"waitingOnOwner":true}
        """)
        let now = try await client().guestEventsAfter("34A", after: 8, limit: 200)
        XCTAssertEqual(now.events.map(\.seq), [9])
        XCTAssertNil(now.after)
        XCTAssertTrue(now.state.waiting)
        XCTAssertEqual(after.sent.first?.path, "/api/guest-sessions/34A/events")
        XCTAssertEqual(after.sent.first?.query, "after=8&limit=200&maxPayload=\(APIClient.maxEventPayload)")

        let before = answer(#"{"events":[{"seq":3,"type":"user","payload":{"text":"a"}}],"hasMore":false}"#)
        let page = try await client().guestEventsBefore("34A", before: 7, limit: 200)
        XCTAssertEqual(page.events.map(\.seq), [3])
        XCTAssertFalse(page.hasMore)
        XCTAssertEqual(before.sent.first?.query, "before=7&limit=200&maxPayload=\(APIClient.maxEventPayload)")

        let full = answer(#"{"seq":8,"type":"tool_call","payload":{"name":"Read"},"turnId":null,"ts":"2026-11-13T10:00:02.000Z"}"#)
        let event = try await client().guestEventFull("34A", seq: 8)
        XCTAssertEqual(event.seq, 8)
        XCTAssertEqual(full.sent.first?.path, "/api/guest-sessions/34A/events/8")
    }

    func testAMessageIsTextOnly() async throws {
        let recorder = answer(#"{"turnId":"T9","revived":true}"#, status: 201)
        let accepted = try await client().sendGuestTurn("34A", clientTurnId: "k1", content: "Please run the tests")
        XCTAssertEqual(accepted.turnId, "T9")
        XCTAssertTrue(accepted.revived)
        XCTAssertEqual(recorder.sent.first?.method, "POST")
        XCTAssertEqual(recorder.sent.first?.path, "/api/guest-sessions/34A/turns")
        let body = try JSONSerialization.jsonObject(with: Data(recorder.sent.first!.body.utf8)) as? [String: String]
        // Nothing but the key and the words: no mode, model, effort or attachment.
        XCTAssertEqual(body, ["clientTurnId": "k1", "content": "Please run the tests"])
    }

    func testNotSharedIsTheDoorsOne404() async {
        _ = answer(#"{"statusCode":404,"code":"GUEST_SESSION_NOT_SHARED"}"#, status: 404)
        do {
            _ = try await client().guestSession("34A", limit: 200)
            XCTFail("a 404 must throw")
        } catch APIError.http(let status, _) {
            XCTAssertEqual(status, 404)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    // MARK: Shared with me

    private func summary(_ id: String = "34A", status: String = "RUNNING", lifecycle: String = "OPEN",
                         lastTurnAt: String? = nil) -> GuestSessionSummary {
        GuestSessionSummary(id: id, title: "  \nFix it\nsecond", ownerName: "Ana", status: status,
                            sessionState: status, lifecycleState: lifecycle,
                            addedAt: "2026-11-13T09:00:00.000Z", lastTurnAt: lastTurnAt)
    }

    func testNoGroupWhileThereIsNone() {
        XCTAssertFalse(SharedWithMe.showsGroup([]))
        XCTAssertTrue(SharedWithMe.showsGroup([summary()]))
    }

    func testARowSaysTitleOwnerAndState() {
        XCTAssertEqual(SharedWithMe.title(summary()), "Fix it")
        XCTAssertEqual(SharedWithMe.subtitle(summary()), "Ana \u{00B7} Running")
        XCTAssertEqual(SharedWithMe.subtitle(summary(status: "AWAITING_INPUT")), "Ana \u{00B7} Awaiting reply")
        XCTAssertEqual(SharedWithMe.subtitle(summary(status: "SUCCEEDED", lifecycle: "COMPLETED")), "Ana \u{00B7} Completed")
    }

    func testARowsTimeIsItsLastTurnElseWhenItWasShared() {
        let now = RelativeTime.parse("2026-11-13T12:00:00.000Z")!
        XCTAssertEqual(SharedWithMe.ago(summary(), now: now), "3h")
        XCTAssertEqual(SharedWithMe.ago(summary(lastTurnAt: "2026-11-13T11:58:00.000Z"), now: now), "2m")
        XCTAssertEqual(SharedWithMe.ago(summary(lastTurnAt: "2026-11-13T11:59:59.000Z"), now: now), "now")
        XCTAssertEqual(SharedWithMe.ago(summary(lastTurnAt: "2026-11-10T12:00:00.000Z"), now: now), "3d")
    }

    func testTheOpenRowIsFoundInEitherIdSpelling() {
        let row = summary("34A")
        XCTAssertTrue(SharedWithMe.contains([row], id: "34A"))
        XCTAssertFalse(SharedWithMe.contains([row], id: "34B"))
        XCTAssertFalse(SharedWithMe.contains([row], id: nil))
    }

    // MARK: The guest view's states

    private func state(_ run: SessionRunState, lifecycle: String = "OPEN", waiting: Bool = false) -> GuestSessionState {
        GuestSessionState(runState: run, runStatus: nil, sessionState: nil, lifecycleState: lifecycle, waitingOnOwner: waiting)
    }

    func testRunningRunsOnTheOwnersMachine() {
        let s = state(.running)
        XCTAssertEqual(s.word, "Running")
        XCTAssertEqual(s.tone, .running)
        XCTAssertEqual(s.hint(owner: "Ana"), "Runs on Ana\u{2019}s machine")
        XCTAssertEqual(GuestFollow.delay(s, moved: false), 4)
    }

    func testWaitingOnTheOwnerSaysSoAndTheMessageWaitsItsTurn() {
        let s = state(.awaitingInput, waiting: true)
        XCTAssertTrue(s.waiting)
        XCTAssertEqual(s.word, "Awaiting reply")
        XCTAssertEqual(s.hint(owner: "Ana"), "Your message waits its turn")
        XCTAssertEqual(GuestCopy.waiting("Ana"), "Waiting for Ana to approve")
        XCTAssertEqual(GuestFollow.delay(s, moved: false), 30)
        XCTAssertEqual(GuestFollow.delay(s, moved: true), 4)
        // Awaiting the next message is not waiting on the owner.
        XCTAssertEqual(state(.awaitingInput).hint(owner: "Ana"), "Runs on Ana\u{2019}s machine")
    }

    func testEndedRestartsOnTheOwnersMachineAndIsNoLongerFollowed() {
        for s in [state(.ended), state(.succeeded), state(.failed), state(.running, lifecycle: "COMPLETED")] {
            XCTAssertFalse(s.live)
            XCTAssertEqual(s.hint(owner: "Ana"),
                           "Send to continue \u{2014} this restarts the session on Ana\u{2019}s machine.")
            XCTAssertEqual(GuestFollow.delay(s, moved: false, expecting: true), 4)
        }
        // Over and quiet: no longer asked. (A run still going in a session filed Completed is still
        // followed while it runs, as the web's `followDelay` follows it.)
        for s in [state(.ended), state(.succeeded), state(.failed)] {
            XCTAssertNil(GuestFollow.delay(s, moved: false))
        }
        XCTAssertEqual(GuestFollow.delay(state(.running, lifecycle: "COMPLETED"), moved: false), 4)
        XCTAssertEqual(state(.succeeded, lifecycle: "COMPLETED").word, "Completed")
        XCTAssertEqual(state(.succeeded, lifecycle: "COMPLETED").tone, .done)
        XCTAssertEqual(state(.ended).word, "Ended")
    }

    func testNoLongerSharedReadsInTheWebsWords() {
        XCTAssertEqual(GuestCopy.notShared, "This conversation is no longer shared with you.")
        XCTAssertEqual(GuestCopy.sharedBy("Ana"), "Shared by Ana")
        XCTAssertEqual(GuestCopy.guestBadge, "Guest")
        XCTAssertEqual(GuestCopy.sharedWithMe, "Shared with me")
    }

    func testTheGuestsOwnMessagesReadAsTheirs() throws {
        let session = try JSONDecoder().decode(GuestSession.self, from: Data(Self.root.utf8))
        let mine = GuestTranscript.ownMessages(session.events, myName: " Bo ")
        XCTAssertEqual(ExternalSender.parse(mine[0].payload["externalSender"]).map(ExternalSender.label), "You")
        XCTAssertEqual(mine[0].payload["text"]?.stringValue, "hi")
        XCTAssertEqual(mine[1], session.events[1])
        // Somebody else's keep `From <name>`.
        let theirs = GuestTranscript.ownMessages(session.events, myName: "Cy")
        XCTAssertEqual(theirs, session.events)
        // Drawn by the transcript: the guest's own bubble carries no sender line.
        var reducer = TranscriptReducer()
        for event in mine { reducer.apply(event) }
        guard case .user(let bubble)? = reducer.state.items.first else { return XCTFail("no user bubble") }
        XCTAssertEqual(bubble.externalSender.map(ExternalSender.label), "You")
    }

    // MARK: Navigation

    func testASharedRowOpensTheGuestViewAsItsOwnPage() {
        var nav = NavState(section: .tasks)
        nav.openGuestSession("34A")
        XCTAssertEqual(nav.section, .agents)
        XCTAssertEqual(nav.path, [.guestSession(sessionID: "34A")])
        XCTAssertEqual(nav.guestSessionOnTop, "34A")
        XCTAssertTrue(nav.atDestinationRoot)
        XCTAssertEqual(nav.drawerDestination(agentID: "w1"), .guestSession(sessionID: "34A"))
        XCTAssertNil(nav.focusedConsoleSessionID)
        XCTAssertEqual(SidebarLogic.selection(section: .agents, agentID: "w1", machineDraftRunnerID: nil,
                                              projectID: nil, guestSessionID: "34A"), .guestSession("34A"))
        XCTAssertEqual(SidebarLogic.target(.guestSession("34A")), .guestSession("34A"))
    }

    func testAnOwner404ThatTheGuestDoorAnswersBecomesTheGuestView() {
        var nav = NavState(section: .agents, stacks: [.agents: [.console(sessionID: "34A", origin: .deepLink)]])
        nav.replaceConsoleWithGuest("34A")
        XCTAssertEqual(nav.path, [.guestSession(sessionID: "34A")])
        XCTAssertNil(nav.focusedConsoleSessionID)
    }
}

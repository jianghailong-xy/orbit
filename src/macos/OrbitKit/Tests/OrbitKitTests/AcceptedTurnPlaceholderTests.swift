import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class ActiveViewURLProtocol: URLProtocol, @unchecked Sendable {
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

private final class ActiveViewRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [URLRequest] = []

    func record(_ request: URLRequest) {
        lock.lock()
        seen.append(request)
        lock.unlock()
    }

    var all: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }
}

/// The turn a runner has taken but not echoed yet — the accepted head of `GET …/turns?view=active` —
/// is on screen before its echo: as the card the echo will be, where the echo will land, with no
/// Cancel, and the echo then takes over that same row. A turn that moves up from the queue to the
/// head stays on screen the whole way.
///
/// Before, this end read only the bare queue view, which leaves the head out by contract
/// (apiserver `listQueuedTurns`): a resumed run's brief behind a busy runner was a blank pane until it
/// ran, and a queued card vanished the moment its turn came up, coming back with the echo.
final class AcceptedTurnPlaceholderTests: XCTestCase {

    override func tearDown() {
        ActiveViewURLProtocol.handler = nil
        super.tearDown()
    }

    // MARK: - fixtures

    /// A resumed run's brief: the turn that hands a task's run its brief, drawn as the task.
    private static let taskStart = """
        {"taskId": "34b5pNIwCilV7N1JMwfkV", "title": "原生：拉 view=active，把 accepted 队首画成不可取消的占位",
         "completionCriterion": "EVIDENCE_JUDGMENT", "auto": true,
         "project": {"id": "34avliEv0G5LKATGl41hI", "title": "统一排队与已投递消息的卡片渲染"}}
        """
    private static let brief = "You are running one task Orbit has already recorded."
    private static let filedAt = "2026-10-06T07:27:13.155Z"

    /// One row as the active view lists it (sessions.service.ts `ListedActiveTurn`).
    private func row(_ turnId: String, placement: String?, kind: String = "message", content: String,
                     cards: String = "", extra: String = "") -> String {
        let placed = placement.map { ", \"placement\": \"\($0)\"" } ?? ""
        return """
            {"turnId": "\(turnId)", "kind": "\(kind)"\(placed), "content": "\(content)",
             "createdAt": "\(Self.filedAt)", "attachments": []\(cards)\(extra)}
            """
    }

    private var briefCards: String { ", \"taskStart\": \(Self.taskStart), \"authoredByOrbit\": true" }

    private func listing(_ rows: String...) throws -> [QueuedTurnInfo] {
        try JSONDecoder().decode([QueuedTurnInfo].self, from: Data("[\(rows.joined(separator: ","))]".utf8))
    }

    private func event(_ json: String) throws -> RunEvent {
        try JSONDecoder().decode(RunEvent.self, from: Data(json.utf8))
    }

    /// The runner's echo of a turn: the durable `user` event, carrying the cards beside its words.
    private func echo(seq: Int, turnId: String, text: String, cards: String = "") throws -> RunEvent {
        try event("""
            {"seq": \(seq), "type": "user", "turnId": "\(turnId)", "ts": "2026-10-06T07:31:02.000Z",
             "payload": {"text": "\(text)"\(cards)}}
            """)
    }

    private func reply(seq: Int, turnId: String) throws -> RunEvent {
        try event(#"{"seq": \#(seq), "type": "assistant", "turnId": "\#(turnId)", "payload": {"text": "Done."}}"#)
    }

    private func turnEnd(seq: Int, turnId: String) throws -> RunEvent {
        try event(#"{"seq": \#(seq), "type": "turn_end", "turnId": "\#(turnId)", "payload": {"subtype": "success"}}"#)
    }

    private func rows(_ reducer: TranscriptReducer) -> [TranscriptRow] {
        TranscriptRows.build(state: reducer.state, statusCards: [], canPageOlder: false, showWorkingIndicator: false)
    }

    /// Every row that draws this turn, and how: in the transcript's own rows, or as the queue's.
    private func drawn(_ turnId: String, in rows: [TranscriptRow]) -> [(index: Int, bubble: UserBubble, queued: Bool)] {
        rows.enumerated().compactMap { index, row in
            switch row {
            case .item(.user(let bubble)) where bubble.turnId == turnId: return (index, bubble, false)
            case .queued(let bubble) where bubble.turnId == turnId:      return (index, bubble, true)
            default:                                                     return nil
            }
        }
    }

    private func transcriptTurns(_ reducer: TranscriptReducer) -> [UserBubble] {
        reducer.state.items.compactMap { item -> UserBubble? in
            guard case .user(let bubble) = item else { return nil }
            return bubble
        }
    }

    /// A conversation with one finished round in it, so the head has history to be drawn after.
    private func afterOneRound() throws -> TranscriptReducer {
        var reducer = TranscriptReducer()
        reducer.apply(try echo(seq: 1, turnId: "t-0", text: "earlier question"))
        reducer.apply(try reply(seq: 2, turnId: "t-0"))
        reducer.apply(try turnEnd(seq: 3, turnId: "t-0"))
        return reducer
    }

    // MARK: - the accepted head before its echo

    /// Drawn as its card, where its echo will land — after every item, ahead of the queue — as the
    /// transcript draws a user turn: never the queue's row, never "Queued", never a Cancel.
    func testTheAcceptedHeadIsDrawnAsItsCardWhereItsEchoWillLandWithNoCancel() throws {
        var reducer = try afterOneRound()
        reducer.reconcileQueuedTurns(try listing(
            row("t-brief", placement: "accepted", content: Self.brief, cards: briefCards),
            row("t-next", placement: "queued", content: "and then deploy")),
            knownBefore: reducer.state.listedTurnIDs)

        XCTAssertEqual(reducer.state.accepted.count, 1)
        let head = try XCTUnwrap(reducer.state.accepted.first)
        XCTAssertEqual(head.turnId, "t-brief")
        XCTAssertEqual(head.text, Self.brief)
        XCTAssertEqual(head.taskStart?.taskId, "34b5pNIwCilV7N1JMwfkV", "the head is drawn as a bubble, not as its card")
        XCTAssertEqual(head.taskStart?.project?.title, "统一排队与已投递消息的卡片渲染")
        XCTAssertTrue(head.authoredByOrbit)
        XCTAssertFalse(head.queued, "the head says Queued and offers a Cancel the runner has made meaningless")
        XCTAssertFalse(head.steer)
        XCTAssertFalse(head.undelivered)
        XCTAssertTrue(head.pending, "the head is still waiting on its echo")
        XCTAssertEqual(head.ts, Self.filedAt, "the head carries when it was filed until its echo brings the runner's clock")
        XCTAssertEqual(reducer.state.queued.map(\.turnId), ["t-next"], "the queue behind the head is drawn as it was")

        let drawnRows = rows(reducer)
        let history = reducer.state.items.map(\.id)
        let next = try XCTUnwrap(reducer.state.queued.first)
        XCTAssertEqual(drawnRows.map(\.id), history + [head.id, "queued-\(next.id)", "transcript-bottom"],
                       "the head is not drawn after the history and ahead of the queue")
        let brief = drawn("t-brief", in: drawnRows)
        XCTAssertEqual(brief.count, 1)
        XCTAssertEqual(brief.first?.queued, false, "the head is drawn as the queue's row, with its Cancel")
        XCTAssertEqual(brief.first?.bubble, head)
    }

    /// The card the head is drawn as is the card its echo is: the same fields, read off the listing and
    /// off the `user` event by the same readers.
    func testThePlaceholderIsTheCardItsEchoIsDrawnAs() throws {
        var listed = TranscriptReducer()
        listed.reconcileQueuedTurns(try listing(row("t-brief", placement: "accepted", content: Self.brief,
                                                    cards: briefCards)), knownBefore: [])
        var echoed = TranscriptReducer()
        echoed.apply(try echo(seq: 1, turnId: "t-brief", text: Self.brief, cards: ", \"taskStart\": \(Self.taskStart)"))

        let placeholder = try XCTUnwrap(listed.state.accepted.first)
        let delivered = try XCTUnwrap(transcriptTurns(echoed).first)
        XCTAssertNotNil(delivered.taskStart)
        XCTAssertEqual(placeholder.cards, delivered.cards)
        XCTAssertEqual(placeholder.text, delivered.text)
    }

    // MARK: - the echo replaces it

    /// The echo takes over the placeholder's row — the same id, at the same place — so the turn is drawn
    /// once, and nothing is removed and inserted when it lands.
    func testTheEchoTakesOverThePlaceholdersRowAndTheTurnIsDrawnOnce() throws {
        var reducer = try afterOneRound()
        reducer.reconcileQueuedTurns(try listing(
            row("t-brief", placement: "accepted", content: Self.brief, cards: briefCards),
            row("t-next", placement: "queued", content: "and then deploy")),
            knownBefore: reducer.state.listedTurnIDs)
        let head = try XCTUnwrap(reducer.state.accepted.first)
        let before = rows(reducer)

        reducer.apply(try echo(seq: 4, turnId: "t-brief", text: Self.brief, cards: ", \"taskStart\": \(Self.taskStart)"))

        XCTAssertTrue(reducer.state.accepted.isEmpty, "the placeholder outlived its echo")
        let delivered = transcriptTurns(reducer).filter { $0.turnId == "t-brief" }
        XCTAssertEqual(delivered.count, 1, "the turn is in the transcript twice")
        XCTAssertEqual(delivered.first?.id, head.id, "the echo drew a row of its own instead of taking over the placeholder's")
        XCTAssertEqual(delivered.first?.pending, false)
        XCTAssertEqual(delivered.first?.cards, head.cards, "the card changed when the echo landed")

        let after = rows(reducer)
        XCTAssertEqual(after.map(\.id), before.map(\.id), "a row moved, or was replaced, when the echo landed")
        XCTAssertEqual(drawn("t-brief", in: after).count, 1)
    }

    /// A listing read just before the echo was written, arriving after it, brings nothing back.
    func testAListingThatRacedTheEchoDoesNotDrawTheTurnAgain() throws {
        var reducer = try afterOneRound()
        let stale = try listing(row("t-brief", placement: "accepted", content: Self.brief, cards: briefCards))
        reducer.reconcileQueuedTurns(stale, knownBefore: reducer.state.listedTurnIDs)
        reducer.apply(try echo(seq: 4, turnId: "t-brief", text: Self.brief))

        reducer.reconcileQueuedTurns(stale, knownBefore: reducer.state.listedTurnIDs)

        XCTAssertTrue(reducer.state.accepted.isEmpty, "a stale listing resurrected the head under its own echo")
        XCTAssertEqual(drawn("t-brief", in: rows(reducer)).count, 1)
    }

    // MARK: - from the queue to the head

    /// Queued behind a running turn, then the head once that turn ends, then echoed: on screen as its
    /// card at every step, as one row, the same one throughout — where the queue alone lost it between
    /// the second step and the third.
    func testATurnMovingUpFromTheQueueStaysOnScreenUntilItsEchoReplacesIt() throws {
        var reducer = TranscriptReducer()
        reducer.apply(try echo(seq: 1, turnId: "t-a", text: "run the migration"))
        reducer.reconcileQueuedTurns(try listing(row("t-b", placement: "queued", content: Self.brief, cards: briefCards)),
                                     knownBefore: reducer.state.listedTurnIDs)
        let waiting = drawn("t-b", in: rows(reducer))
        XCTAssertEqual(waiting.count, 1)
        XCTAssertEqual(waiting.first?.queued, true, "behind a running turn, it is the queue's, with its Cancel")
        let queuedRow = try XCTUnwrap(waiting.first?.bubble)
        XCTAssertNotNil(queuedRow.taskStart)

        reducer.apply(try reply(seq: 2, turnId: "t-a"))
        reducer.apply(try turnEnd(seq: 3, turnId: "t-a"))
        XCTAssertEqual(drawn("t-b", in: rows(reducer)).count, 1, "the turn left the screen when the one before it ended")

        reducer.reconcileQueuedTurns(try listing(row("t-b", placement: "accepted", content: Self.brief, cards: briefCards)),
                                     knownBefore: reducer.state.listedTurnIDs)
        let atHead = drawn("t-b", in: rows(reducer))
        XCTAssertEqual(atHead.count, 1, "the turn left the screen when it became the head")
        XCTAssertEqual(atHead.first?.queued, false, "the head is still drawn as the queue's row, with a Cancel")
        XCTAssertEqual(atHead.first?.bubble.id, queuedRow.id, "the head was drawn as a new row rather than the one it had")
        XCTAssertEqual(atHead.first?.bubble.cards, queuedRow.cards, "the card changed as the turn came up")
        XCTAssertTrue(reducer.state.queued.isEmpty)

        reducer.apply(try echo(seq: 4, turnId: "t-b", text: Self.brief, cards: ", \"taskStart\": \(Self.taskStart)"))
        let delivered = drawn("t-b", in: rows(reducer))
        XCTAssertEqual(delivered.count, 1, "the echo drew the turn a second time")
        XCTAssertEqual(delivered.first?.bubble.id, queuedRow.id)
        XCTAssertEqual(delivered.first?.bubble.pending, false)
        XCTAssertEqual(delivered.first?.bubble.cards, queuedRow.cards)
        XCTAssertTrue(reducer.state.accepted.isEmpty)
    }

    /// A send queued from here, whose listing as the head arrives before its POST response has tagged
    /// it, is adopted by its words: the same row, not a second one beside it.
    func testAQueuedSendThatReachesTheHeadBeforeItsTagIsTheSameRow() throws {
        var reducer = TranscriptReducer()
        reducer.addOptimisticUser(clientTurnId: "c-2", text: "and then deploy", queued: true)
        let sent = try XCTUnwrap(reducer.state.queued.first)

        reducer.reconcileQueuedTurns(try listing(row("t-2", placement: "accepted", content: "and then deploy")),
                                     knownBefore: reducer.state.listedTurnIDs)

        XCTAssertTrue(reducer.state.queued.isEmpty)
        let head = try XCTUnwrap(reducer.state.accepted.first)
        XCTAssertEqual(head.id, sent.id)
        XCTAssertEqual(head.turnId, "t-2")
        XCTAssertEqual(head.clientTurnId, "c-2")
        XCTAssertFalse(head.queued)

        reducer.apply(try echo(seq: 1, turnId: "t-2", text: "and then deploy"))
        XCTAssertEqual(transcriptTurns(reducer).map(\.id), [sent.id])
        XCTAssertEqual(drawn("t-2", in: rows(reducer)).count, 1)
    }

    /// Every send broadcasts the queue nudge, so the listing naming an idle send as the head routinely
    /// beats the POST response that tags its bubble. That bubble already draws the turn where its echo
    /// will land; a placeholder beside it would draw it twice.
    func testAnIdleSendIsNotDrawnTwiceWhenItsListingBeatsItsPostResponse() throws {
        var reducer = TranscriptReducer()
        reducer.addOptimisticUser(clientTurnId: "c-1", text: "deploy it")
        let accepted = try listing(row("t-1", placement: "accepted", content: "deploy it"))

        reducer.reconcileQueuedTurns(accepted, knownBefore: reducer.state.listedTurnIDs)
        XCTAssertTrue(reducer.state.accepted.isEmpty, "an untagged idle send was drawn a second time as the head")

        reducer.setOptimisticTurnId(clientTurnId: "c-1", turnId: "t-1")
        reducer.reconcileQueuedTurns(accepted, knownBefore: reducer.state.listedTurnIDs)
        XCTAssertTrue(reducer.state.accepted.isEmpty, "a tagged idle send was drawn a second time as the head")

        reducer.apply(try echo(seq: 1, turnId: "t-1", text: "deploy it"))
        XCTAssertEqual(transcriptTurns(reducer).map(\.turnId), ["t-1"])
        XCTAssertEqual(drawn("t-1", in: rows(reducer)).count, 1)
    }

    // MARK: - when the head goes without an echo

    /// A `!cmd` has no echo — the runner runs it as a Bash card — so the head it becomes is no
    /// placeholder, and its queued row goes (web parity).
    func testAnAcceptedCommandHasNoPlaceholder() throws {
        var reducer = TranscriptReducer()
        reducer.reconcileQueuedTurns(try listing(row("t-sh", placement: "queued", kind: "shell", content: "ls -la")),
                                     knownBefore: [])
        XCTAssertEqual(reducer.state.queued.map(\.turnId), ["t-sh"])

        reducer.reconcileQueuedTurns(try listing(row("t-sh", placement: "accepted", kind: "shell", content: "ls -la")),
                                     knownBefore: reducer.state.listedTurnIDs)
        XCTAssertTrue(reducer.state.accepted.isEmpty)
        XCTAssertTrue(reducer.state.queued.isEmpty)
    }

    /// A turn that ended is not waiting on an echo any more; another turn ending leaves the head alone.
    func testTheHeadGoesWithItsOwnTurnsEnd() throws {
        var reducer = TranscriptReducer()
        reducer.reconcileQueuedTurns(try listing(row("t-1", placement: "accepted", content: "deploy it")),
                                     knownBefore: [])

        reducer.apply(try turnEnd(seq: 1, turnId: "t-0"))
        XCTAssertEqual(reducer.state.accepted.map(\.turnId), ["t-1"], "the end of the turn before took the head with it")

        reducer.apply(try turnEnd(seq: 2, turnId: "t-1"))
        XCTAssertTrue(reducer.state.accepted.isEmpty)
    }

    /// A head the listing no longer names was delivered, or dropped, elsewhere — unless it was drawn
    /// after this listing's fetch began, which the listing cannot speak for.
    func testAHeadTheListingNoLongerNamesGoesUnlessItIsNewerThanTheListing() throws {
        var reducer = TranscriptReducer()
        reducer.reconcileQueuedTurns(try listing(row("t-1", placement: "accepted", content: "deploy it")),
                                     knownBefore: [])
        XCTAssertEqual(reducer.state.listedTurnIDs, ["t-1"])

        var newer = reducer
        newer.reconcileQueuedTurns([], knownBefore: [])
        XCTAssertEqual(newer.state.accepted.map(\.turnId), ["t-1"], "a listing older than the head took it away")
        XCTAssertTrue(newer.state.queued.isEmpty, "a head the listing could not speak for went back to the queue")

        reducer.reconcileQueuedTurns([], knownBefore: reducer.state.listedTurnIDs)
        XCTAssertTrue(reducer.state.accepted.isEmpty)
    }

    /// A user_delivery reporting the head failed before it was ever echoed says so on its row.
    func testAHeadReportedUndeliveredSaysSo() throws {
        var reducer = TranscriptReducer()
        reducer.reconcileQueuedTurns(try listing(row("t-1", placement: "accepted", content: "deploy it")),
                                     knownBefore: [])
        reducer.apply(try event(#"{"seq": 1, "type": "user_delivery", "turnId": "t-1", "payload": {"turnId": "t-1", "delivery": "failed"}}"#))

        let head = try XCTUnwrap(reducer.state.accepted.first)
        XCTAssertTrue(head.undelivered)
        XCTAssertFalse(head.pending)
        XCTAssertEqual(head.delivery, "failed")
    }

    // MARK: - the rest of the listing is drawn as it was

    /// A receipt for a message written into the running turn that never made it is a steer that is
    /// over: the queue never listed one, and the tail still draws none — a steer of the queue's that
    /// becomes one goes, as it did when the listing dropped it.
    func testADeliveryReceiptIsNotDrawnInTheTail() throws {
        var reducer = TranscriptReducer()
        reducer.reconcileQueuedTurns(try listing(row("t-s", placement: "steer", kind: "steer", content: "use staging",
                                                     extra: ", \"targetTurnId\": \"t-a\"")),
                                     knownBefore: [])
        XCTAssertEqual(reducer.state.queued.map(\.steer), [true])

        reducer.reconcileQueuedTurns(try listing(row("t-s", placement: "steer", kind: "steer", content: "use staging",
                                                     extra: """
                                                         , "targetTurnId": "t-a", "delivery": "failed",
                                                         "deliveryCode": "CURRENT_WORK_TARGET_COMPLETED",
                                                         "deliveryReason": "The turn it was written into had already ended."
                                                         """)),
                                     knownBefore: reducer.state.listedTurnIDs)
        XCTAssertTrue(reducer.state.queued.isEmpty)
        XCTAssertTrue(reducer.state.accepted.isEmpty)
    }

    /// A server that predates the active view lists no placement: its rows are the queue's and steers,
    /// drawn exactly as before.
    func testAListingWithoutPlacementIsTheQueueAsBefore() throws {
        var reducer = TranscriptReducer()
        reducer.reconcileQueuedTurns(try listing(
            row("t-1", placement: nil, content: "and then deploy"),
            row("t-2", placement: nil, kind: "steer", content: "use staging")), knownBefore: [])

        XCTAssertTrue(reducer.state.accepted.isEmpty)
        XCTAssertEqual(reducer.state.queued.map(\.turnId), ["t-1", "t-2"])
        XCTAssertEqual(reducer.state.queued.map(\.queued), [true, true])
        XCTAssertEqual(reducer.state.queued.map(\.steer), [false, true])
    }

    // MARK: - kept across a snapshot

    /// The console checkpoints the reducer; the head rides along, and a snapshot from before it existed
    /// still restores.
    func testTheHeadIsKeptInASnapshotAndAnOlderSnapshotStillRestores() throws {
        var reducer = try afterOneRound()
        reducer.reconcileQueuedTurns(try listing(row("t-brief", placement: "accepted", content: Self.brief,
                                                     cards: briefCards)), knownBefore: [])

        let restored = try JSONDecoder().decode(TranscriptReducer.self, from: JSONEncoder().encode(reducer))
        XCTAssertEqual(restored.state.accepted, reducer.state.accepted)
        XCTAssertEqual(restored.state.items, reducer.state.items)

        let older = """
            {"items": [], "pendingApprovals": [], "background": [],
             "queued": [{"id": "server-t-2", "text": "and then deploy", "turnId": "t-2", "pending": true, "queued": true}],
             "status": "RUNNING", "maxSeq": 7}
            """
        let state = try JSONDecoder().decode(TranscriptState.self, from: Data(older.utf8))
        XCTAssertEqual(state.accepted, [])
        XCTAssertEqual(state.queued.map(\.turnId), ["t-2"])
        XCTAssertEqual(state.maxSeq, 7)
    }

    // MARK: - the active view, read whole

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ActiveViewURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(), session: URLSession(configuration: configuration))
    }

    /// The console asks for the active view, and every field a row of it carries is read: where the
    /// turn was placed, when it was filed, the turn a steer went into, a receipt's outcome, code and
    /// reason, and the cards.
    func testTheConsoleReadsTheActiveViewAndEveryFieldItsRowsCarry() async throws {
        let requests = ActiveViewRequests()
        let body = """
            [{"turnId": "t-brief", "kind": "message", "placement": "accepted",
              "taskStart": \(Self.taskStart), "authoredByOrbit": true,
              "content": "\(Self.brief)", "createdAt": "\(Self.filedAt)", "attachments": []},
             {"turnId": "t-next", "kind": "message", "placement": "queued", "content": "and then deploy",
              "createdAt": "2026-10-06T07:28:00.000Z", "attachments": [{"id": "att-1", "mimeType": "image/png"}]},
             {"turnId": "t-steer", "kind": "steer", "placement": "steer", "targetTurnId": "t-brief",
              "content": "use staging", "createdAt": "2026-10-06T07:29:00.000Z", "attachments": []},
             {"turnId": "t-lost", "kind": "steer", "placement": "steer", "targetTurnId": "t-old",
              "delivery": "unconfirmed", "deliveryCode": "CURRENT_WORK_SESSION_REAPED",
              "deliveryReason": "The runner went away before it could say.",
              "content": "too late", "createdAt": "2026-10-06T07:20:00.000Z", "attachments": []}]
            """
        ActiveViewURLProtocol.handler = { request in
            requests.record(request)
            return (200, Data(body.utf8))
        }

        let turns = try await client().queuedTurns(sessionID: "s-1")

        let request = try XCTUnwrap(requests.all.first)
        XCTAssertEqual(requests.all.count, 1)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/sessions/s-1/turns")
        XCTAssertEqual(request.url?.query, "view=active", "the console still reads the queue alone, which leaves the head out")

        XCTAssertEqual(turns.map(\.turnId), ["t-brief", "t-next", "t-steer", "t-lost"])
        XCTAssertEqual(turns.map(\.placement), ["accepted", "queued", "steer", "steer"])
        XCTAssertEqual(turns.map(\.isAccepted), [true, false, false, false])
        XCTAssertEqual(turns.map(\.createdAt), [Self.filedAt, "2026-10-06T07:28:00.000Z",
                                                "2026-10-06T07:29:00.000Z", "2026-10-06T07:20:00.000Z"])
        XCTAssertEqual(turns.map(\.targetTurnId), [nil, nil, "t-brief", "t-old"])
        XCTAssertEqual(turns.map(\.delivery), [nil, nil, nil, "unconfirmed"])
        XCTAssertEqual(turns[3].deliveryCode, "CURRENT_WORK_SESSION_REAPED")
        XCTAssertEqual(turns[3].deliveryReason, "The runner went away before it could say.")
        XCTAssertEqual(turns[0].cards.taskStart?.title, "原生：拉 view=active，把 accepted 队首画成不可取消的占位")
        XCTAssertEqual(turns[0].authoredByOrbit, true)
        XCTAssertEqual(turns[1].attachments, [QueuedTurnInfo.Attachment(id: "att-1", mimeType: "image/png")])
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw NSError(domain: "AcceptedTurnPlaceholderTests", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "\(relative) was not found above this test"])
    }

    /// The fields one TypeScript interface declares, by name: its body up to the closing brace at the
    /// start of a line, comments skipped.
    private func fields(ofInterface name: String, in source: String) throws -> Set<String> {
        guard let head = source.range(of: "interface \(name) "),
              let open = source.range(of: "{\n", range: head.upperBound..<source.endIndex),
              let close = source.range(of: "\n}", range: open.upperBound..<source.endIndex) else {
            throw NSError(domain: "AcceptedTurnPlaceholderTests", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "interface \(name) was not found"])
        }
        let field = try NSRegularExpression(pattern: "^([A-Za-z_][A-Za-z0-9_]*)\\??:")
        return Set(source[open.upperBound..<close.lowerBound].split(separator: "\n").compactMap { line -> String? in
            let code = line.trimmingCharacters(in: .whitespaces)
            let range = NSRange(code.startIndex..., in: code)
            guard let match = field.firstMatch(in: code, range: range),
                  let name = Range(match.range(at: 1), in: code) else { return nil }
            return String(code[name])
        })
    }

    /// Every field the server lists on a row of either view (sessions.service.ts `ListedQueuedTurn` /
    /// `ListedActiveTurn`, and the cards of turn-cards.ts `TurnCards`) is one a `QueuedTurnInfo` decodes:
    /// a field the server adds and this end never reads fails here rather than going unseen.
    func testEveryFieldTheServerListsIsOneThisEndDecodes() throws {
        let service = try source("src/apiserver/src/sessions/sessions.service.ts")
        let cards = try source("src/apiserver/src/sessions/turn-cards.ts")
        let listed = try fields(ofInterface: "ListedQueuedTurn", in: service)
            .union(try fields(ofInterface: "ListedActiveTurn", in: service))
            .union(try fields(ofInterface: "TurnCards", in: cards))
        XCTAssertTrue(listed.isSuperset(of: ["turnId", "placement", "createdAt", "delivery", "taskStart"]),
                      "the interfaces were not read: \(listed.sorted())")

        let full = QueuedTurnInfo(
            turnId: "t", kind: "message", content: "words",
            attachments: [QueuedTurnInfo.Attachment(id: "a", mimeType: "image/png")],
            openItemDelivery: .object([:]), taskStart: .object([:]), projectStarted: .object([:]),
            sessionMessage: .object([:]), sessionReplies: .array([]), authoredByOrbit: true,
            confirmationReviewRequest: .object([:]), confirmationReturn: .object([:]),
            placement: "accepted", createdAt: Self.filedAt, targetTurnId: "t-a", delivery: "failed",
            deliveryCode: "CODE", deliveryReason: "reason")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(full)) as? [String: Any])
        let decoded = Set(object.keys)
        XCTAssertEqual(listed.subtracting(decoded), [], "the server lists a field this end never reads")
        XCTAssertEqual(try JSONDecoder().decode(QueuedTurnInfo.self, from: JSONEncoder().encode(full)), full)
    }
}

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class HeldCancelURLProtocol: URLProtocol, @unchecked Sendable {
    static var status = 204
    static var seen: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.seen.append(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let body = Self.status >= 400 ? #"{"code":"TURN_ALREADY_LEASED","message":"leased"}"# : ""
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// `Queued · runner full · Cancel` under a message the server accepted but no runner has taken
/// (web parity: `cancellableHeldTurn`, `HeldFoot`). Which messages get Cancel, and what the press does:
/// it withdraws the turn through the cancel-turn door and puts the words back in the composer.
final class HeldCancelTests: XCTestCase {

    override func tearDown() {
        HeldCancelURLProtocol.status = 204
        HeldCancelURLProtocol.seen = []
        super.tearDown()
    }

    private func listing(_ json: String) throws -> [QueuedTurnInfo] {
        try JSONDecoder().decode([QueuedTurnInfo].self, from: Data(json.utf8))
    }

    private func row(_ turnId: String, _ content: String, extra: String = "") -> String {
        """
        {"turnId": "\(turnId)", "kind": "message", "placement": "accepted", "content": "\(content)",
         "createdAt": "2026-11-20T01:00:00.000Z", "attachments": []\(extra)}
        """
    }

    /// The accepted head another client's send left: listed by GET …/turns?view=active, no echo yet.
    private func acceptedHead(_ extra: String = "") throws -> UserBubble {
        var reducer = TranscriptReducer()
        reducer.reconcileQueuedTurns(try listing("[\(row("t-6", "Why is task 6 still queued?", extra: extra))]"),
                                     knownBefore: [])
        return try XCTUnwrap(reducer.state.accepted.first)
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HeldCancelURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(), session: URLSession(configuration: configuration))
    }

    // MARK: which messages get Cancel

    func testAnAcceptedPlaceholderWithATurnIdGetsCancel() throws {
        let head = try acceptedHead()
        XCTAssertTrue(head.pending)
        XCTAssertEqual(head.turnId, "t-6")
        XCTAssertTrue(HeldCancel.offers(head))

        // This console's own send the server answered `accepted`: in the conversation, tagged, unechoed.
        var reducer = TranscriptReducer()
        reducer.addOptimisticUser(clientTurnId: "c-1", text: "Why is task 6 still queued?")
        reducer.setOptimisticTurnId(clientTurnId: "c-1", turnId: "t-7", placement: "accepted",
                                    acceptedAt: "2026-11-20T01:00:00.000Z")
        guard case .user(let own) = try XCTUnwrap(reducer.state.items.last) else { return XCTFail("no bubble") }
        XCTAssertTrue(HeldCancel.offers(own))
    }

    func testTheOpeningPromptGetsNoCancel() throws {
        let opening = try acceptedHead(#", "opening": true"#)
        XCTAssertTrue(opening.opening, "the listing's `opening` reaches the bubble")
        XCTAssertFalse(HeldCancel.offers(opening), "the server keeps a session's opening prompt")
    }

    func testAPlaceholderWithoutATurnIdGetsNoCancel() {
        var reducer = TranscriptReducer()
        reducer.addOptimisticUser(clientTurnId: "c-1", text: "Why is task 6 still queued?")
        guard case .user(let untagged) = reducer.state.items.last else { return XCTFail("no bubble") }
        XCTAssertNil(untagged.turnId)
        XCTAssertFalse(HeldCancel.offers(untagged), "the DELETE keys on the turn id")
    }

    func testAnEchoedMessageGetsNoCancel() throws {
        var reducer = TranscriptReducer()
        reducer.reconcileQueuedTurns(try listing("[\(row("t-6", "Why is task 6 still queued?"))]"), knownBefore: [])
        reducer.apply(try JSONDecoder().decode(RunEvent.self, from: Data("""
            {"seq": 1, "type": "user", "turnId": "t-6", "ts": "2026-11-20T01:01:00.000Z",
             "payload": {"text": "Why is task 6 still queued?"}}
            """.utf8)))
        XCTAssertTrue(reducer.state.accepted.isEmpty)
        guard case .user(let echoed) = try XCTUnwrap(reducer.state.items.last) else { return XCTFail("no bubble") }
        XCTAssertFalse(echoed.pending)
        XCTAssertFalse(HeldCancel.offers(echoed), "a runner has it")
    }

    func testQueuedSteeredAndUndeliveredMessagesGetNoCancelHere() {
        let queued = UserBubble(id: "q", text: "x", turnId: "t-q", pending: true, queued: true)
        let steer = UserBubble(id: "s", text: "x", turnId: "t-s", pending: true, steer: true)
        let lost = UserBubble(id: "u", text: "x", turnId: "t-u", pending: true, undelivered: true)
        XCTAssertFalse(HeldCancel.offers(queued), "a queued row has its own Cancel")
        XCTAssertFalse(HeldCancel.offers(steer))
        XCTAssertFalse(HeldCancel.offers(lost))
    }

    func testOpeningSurvivesASnapshotAndAnOldSnapshotReadsFalse() throws {
        let head = try acceptedHead(#", "opening": true"#)
        let round = try JSONDecoder().decode(UserBubble.self, from: JSONEncoder().encode(head))
        XCTAssertTrue(round.opening)
        let old = try JSONDecoder().decode(UserBubble.self, from: Data(#"{"id": "b", "text": "hi", "pending": true}"#.utf8))
        XCTAssertFalse(old.opening)
    }

    // MARK: the press

    func testCancelCallsTheCancelTurnAPIAndRestoresTheWordsToTheComposer() async throws {
        let head = try acceptedHead()
        let api = client()

        let outcome = await HeldCancel.press(head) { try await api.withdrawTurn(sessionID: "s-1", turnId: $0) }

        let request = try XCTUnwrap(HeldCancelURLProtocol.seen.first)
        XCTAssertEqual(HeldCancelURLProtocol.seen.count, 1)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/api/sessions/s-1/turns/t-6")
        XCTAssertEqual(outcome, .withdrawn(words: "Why is task 6 still queued?"))

        guard case .withdrawn(let words) = outcome else { return }
        XCTAssertEqual(HeldCancel.composer("", restoring: words), "Why is task 6 still queued?")
        XCTAssertEqual(HeldCancel.composer("a draft", restoring: words), "a draft\n\nWhy is task 6 still queued?",
                       "under any draft, which keeps its place")
    }

    func testATranslatedMessageGivesBackWhatTheReaderWrote() async throws {
        var head = try acceptedHead()
        head.text = "Deploy staging first"
        head.translation = TurnTranslation(state: .done, from: .zhHans, original: "先部署预发环境")
        let outcome = await HeldCancel.press(head) { _ in }
        XCTAssertEqual(outcome, .withdrawn(words: "先部署预发环境"))
    }

    func testARefusedCancelLeavesTheMessageAndSaysSo() async throws {
        HeldCancelURLProtocol.status = 409
        let head = try acceptedHead()
        let api = client()
        let outcome = await HeldCancel.press(head) { try await api.withdrawTurn(sessionID: "s-1", turnId: $0) }
        XCTAssertEqual(outcome, .refused)
        XCTAssertEqual(HeldCancel.refused, "This message is already being processed and cannot be withdrawn")
        XCTAssertEqual(HeldCancel.composer("a draft", restoring: nil), "a draft")
    }

    func testThePressNeverAsksForTheOpeningPrompt() async throws {
        let opening = try acceptedHead(#", "opening": true"#)
        var asked = false
        let outcome = await HeldCancel.press(opening) { _ in asked = true }
        XCTAssertFalse(asked)
        XCTAssertEqual(outcome, .refused)
    }

    func testAWithdrawnMessageLeavesTheScreen() throws {
        var listed = TranscriptReducer()
        listed.reconcileQueuedTurns(try listing("[\(row("t-6", "Why is task 6 still queued?"))]"), knownBefore: [])
        listed.removeAcceptedTurn(turnId: "t-6")
        XCTAssertTrue(listed.state.accepted.isEmpty)

        var own = TranscriptReducer()
        own.addOptimisticUser(clientTurnId: "c-1", text: "Why is task 6 still queued?")
        own.setOptimisticTurnId(clientTurnId: "c-1", turnId: "t-7", placement: "accepted")
        own.removeAcceptedTurn(turnId: "t-7")
        XCTAssertTrue(own.state.items.isEmpty)
    }

    // MARK: the app's wiring (SwiftUI does not build on Linux, so these read its sources)

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw NSError(domain: "HeldCancelTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(relative) not found"])
    }

    private let app = "src/macos/OrbitApp/Sources/OrbitApp/"

    func testTheHeldTagCarriesCancelInTheTintWhereTheRuleSays() throws {
        let tag = try source(app + "Views/Console/RunnerUpdatingViews.swift")
        let cancel = try XCTUnwrap(tag.range(of: "Button { onCancel() } label: {"), "Cancel after the tag")
        XCTAssertTrue(tag[cancel.upperBound...].hasPrefix("""

                    Text(HeldCancel.label)
                }
                .buttonStyle(.plain).foregroundStyle(.tint)
"""), "in the tint, the tag staying muted")
        let bubbles = try source(app + "Views/Console/MessageBubbles.swift")
        XCTAssertTrue(bubbles.contains("RunnerUpdatingTagView(foot: heldFoot, onCancel: heldCancelPress)"))
        XCTAssertTrue(bubbles.contains("guard let heldCancel, HeldCancel.offers(bubble) else { return nil }"))
        let console = try source(app + "Views/Console/ConsoleView.swift")
        XCTAssertTrue(console.contains(".environment(\\.heldCancel, { [console] bubble in Task { await console.cancelHeld(bubble) } })"))
        let model = try source(app + "ConsoleModel.swift")
        XCTAssertTrue(model.contains("switch await HeldCancel.press(bubble, withdraw: { try await api.withdrawTurn(sessionID: sessionID, turnId: $0) }) {"))
        XCTAssertTrue(model.contains("reducer.removeAcceptedTurn(turnId: turnId)"))
        XCTAssertTrue(model.contains("composerText = HeldCancel.composer(composerText, restoring: words)"))
        XCTAssertTrue(model.contains("showTransientStatus(HeldCancel.refused)"))
    }
}

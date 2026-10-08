import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class DecideURLProtocol: URLProtocol, @unchecked Sendable {
    static var answer: String?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let found = request.url?.path == "/api/wiki/changesets/\(WikiDecisionRefusalTests.changesetID)/decide"
        let response = HTTPURLResponse(url: request.url!, statusCode: found ? 200 : 404,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((found ? Self.answer ?? "" : "").utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// What Review says once a decide is answered: the decision the server RECORDED for the op, read off
/// the answer — not the button that was pressed.
///
/// `POST /api/wiki/changesets/:id/decide` answers 200 with the whole changeset whatever became of the op.
/// An amend, supersede or retire whose entry moved past the revision it was written against is recorded
/// `conflict` and nothing is applied (`WikiService.applyDecision`); so is a challenge of an entry no
/// longer active (`answerChallenge`); and a `withdrawn` op applied nothing either. The model used to drop
/// that answer and float "Accepted". The sentences are Android's, word for word (its `WikiCopy.kt`), and
/// the web's (`WIKI_DECIDE_*`, held to these by `WikiCopyParityTests`).
final class WikiDecisionRefusalTests: XCTestCase {
    static let changesetID = "0196b800-0000-7000-8000-0000000000c1"
    private static let opID = "0196b800-0000-7000-8000-0000000000a1"

    override func tearDown() {
        DecideURLProtocol.answer = nil
        super.tearDown()
    }

    /// The server's answer to a decide (`changesetView`): the changeset, every op with its `decision`.
    private func answer(_ ops: [(id: String, op: String, decision: String)]) -> String {
        let rows = ops.enumerated().map { seq, row in
            """
            {"id":"\(row.id)","changesetId":"\(Self.changesetID)","seq":\(seq),"op":"\(row.op)",
             "entryId":"0196b800-0000-7000-8000-0000000000e1","baseRevision":3,"payload":{"op":"\(row.op)"},
             "similar":[],"tainted":false,"decision":"\(row.decision)","decisionReason":null,"decisionNote":null,
             "resultEntryId":null,"resultRevision":null,"decidedAt":"2026-10-07T12:00:00.000Z",
             "appliedByMode":null,"spotCheck":false,"verification":null,"verificationHistory":[]}
            """
        }
        return """
            {"id":"\(Self.changesetID)","spaceId":"\(WikiFixtures.spaceID)","origin":"agent",
             "sessionId":"34TcwNgAIo6tGUiIKjqnQ","toolCallId":null,"rationale":"Upgrade deploy","status":"settled",
             "createdAt":"2026-10-07T10:00:00.000Z","decidedAt":"2026-10-07T12:00:00.000Z","expiresAt":null,
             "ops":[\(rows.joined(separator: ","))]}
            """
    }

    /// The refusal for the op `op` answered with `action`, read off an answer that recorded `decision`.
    private func refusal(_ decision: String, op: WikiOpKind, action: WikiDecideAction) throws -> String? {
        let decided = try WikiFixtures.decode(WikiChangeset.self, answer([(Self.opID, op.rawValue, decision)]))
        return WikiLogic.decisionRefusal(WikiLogic.recordedDecision(decided, opID: Self.opID), op: op, action: action)
    }

    // MARK: a refusal that applied nothing

    /// An amend written against r3 of an entry now at r4: Accept is answered 200, the op recorded
    /// `conflict`, the entry unchanged — and that is what is said, decoded off the wire as the model reads it.
    func testAStaleAmendIsRefusedNotAccepted() async throws {
        DecideURLProtocol.answer = answer([(Self.opID, "amend", "conflict")])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DecideURLProtocol.self]
        let api = APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                            session: URLSession(configuration: configuration))

        let decided = try await api.decideWikiChangeset(
            Self.changesetID, WikiDecideRequest(decisions: [WikiDecision(opId: Self.opID, action: .accept)]))

        XCTAssertEqual(WikiLogic.recordedDecision(decided, opID: Self.opID), .conflict)
        XCTAssertEqual(WikiLogic.decisionRefusal(.conflict, op: .amend, action: .accept),
                       "Nothing was applied: the entry changed after this was proposed.")
        XCTAssertEqual(WikiLogic.decisionRefusal(WikiLogic.recordedDecision(decided, opID: Self.opID),
                                                 op: .amend, action: .accept),
                       WikiCopy.conflictRefused)
    }

    /// The same answer to Edit's form, and to the other ops a base revision guards — supersede and retire.
    func testAStaleOpIsRefusedWhicheverWayItWasAnswered() throws {
        XCTAssertEqual(try refusal("conflict", op: .amend, action: .edit), WikiCopy.conflictRefused,
                       "an edited amend, from Edit's form")
        XCTAssertEqual(try refusal("conflict", op: .supersede, action: .accept), WikiCopy.conflictRefused)
        XCTAssertEqual(try refusal("conflict", op: .retire, action: .accept), WikiCopy.conflictRefused)
        XCTAssertEqual(try refusal("conflict", op: .add, action: .accept), WikiCopy.conflictRefused)
    }

    /// A challenge of an entry that is no longer active is recorded `conflict` too, whatever the answer —
    /// and says why in its own words.
    func testAChallengeOfAnEntryNoLongerActiveIsRefused() throws {
        for action in [WikiDecideAction.reconfirm, .amend, .retire] {
            XCTAssertEqual(try refusal("conflict", op: .challenge, action: action),
                           "Nothing was applied: the entry is no longer active.", "\(action)")
        }
        XCTAssertEqual(WikiCopy.inactiveRefused, "Nothing was applied: the entry is no longer active.")
    }

    func testAWithdrawnProposalIsRefused() throws {
        XCTAssertEqual(try refusal("withdrawn", op: .amend, action: .accept),
                       "Nothing was applied: the proposal was withdrawn.")
        XCTAssertEqual(try refusal("withdrawn", op: .add, action: .edit), WikiCopy.withdrawnRefused)
        XCTAssertEqual(try refusal("withdrawn", op: .challenge, action: .reconfirm), WikiCopy.withdrawnRefused)
    }

    // MARK: an answer that did what was asked

    /// Accept recorded `accepted` is no refusal, and its toast is the one it always was.
    func testAnAcceptedAnswerIsNoRefusal() throws {
        XCTAssertNil(try refusal("accepted", op: .amend, action: .accept))
        XCTAssertNil(try refusal("edited", op: .amend, action: .edit))
        XCTAssertNil(try refusal("rejected", op: .add, action: .reject))
        XCTAssertNil(try refusal("accepted", op: .challenge, action: .reconfirm))
        XCTAssertNil(try refusal("edited", op: .challenge, action: .amend))
        XCTAssertEqual(WikiLogic.decidedToast(op: .amend, action: .accept), "Accepted")
        for decision in WikiOpDecision.allCases where decision != .conflict && decision != .withdrawn {
            XCTAssertNil(WikiLogic.decisionRefusal(decision, op: .amend, action: .accept), "\(decision)")
        }
        XCTAssertNil(WikiLogic.decisionRefusal(nil, op: .add, action: .accept), "an answer that does not say")
    }

    /// Retire on a challenge retires the entry, and the retire takes every op still waiting on it along,
    /// the challenge it answers included: the server records that challenge `withdrawn` (its own
    /// wiki-anchors.pg.spec.ts: "the challenge left with the entry it was about"). That is the answer done.
    func testRetiringAChallengedEntryIsTheAnswerDone() throws {
        XCTAssertNil(try refusal("withdrawn", op: .challenge, action: .retire))
        XCTAssertEqual(WikiLogic.decidedToast(op: .challenge, action: .retire), "Retired")
    }

    // MARK: reading the answer

    /// The decided op's own decision, among the changeset's others; nil for an op the answer does not
    /// hold. Either spelling of the id names the same op.
    func testTheDecisionReadIsTheDecidedOpsOwn() throws {
        let other = "0196b800-0000-7000-8000-0000000000a2"
        let decided = try WikiFixtures.decode(WikiChangeset.self,
                                              answer([(other, "add", "accepted"), (Self.opID, "amend", "conflict")]))
        XCTAssertEqual(WikiLogic.recordedDecision(decided, opID: Self.opID), .conflict)
        XCTAssertEqual(WikiLogic.recordedDecision(decided, opID: other), .accepted)
        XCTAssertEqual(WikiLogic.recordedDecision(decided, opID: PublicID.toPublic(Self.opID)), .conflict,
                       "the card's public id and the answer's UUID name the same op")
        XCTAssertNil(WikiLogic.recordedDecision(decided, opID: "0196b800-0000-7000-8000-0000000000a3"))
        XCTAssertNil(WikiLogic.recordedDecision(WikiChangeset(id: Self.changesetID), opID: Self.opID),
                     "an answer without ops")
    }

    /// Word for word Android's `WikiCopy.conflictRefused` / `inactiveRefused` / `withdrawnRefused`.
    func testTheSentencesAreAndroidsWordForWord() {
        XCTAssertEqual(WikiCopy.conflictRefused, "Nothing was applied: the entry changed after this was proposed.")
        XCTAssertEqual(WikiCopy.inactiveRefused, "Nothing was applied: the entry is no longer active.")
        XCTAssertEqual(WikiCopy.withdrawnRefused, "Nothing was applied: the proposal was withdrawn.")
    }
}

import Foundation
import XCTest
@testable import OrbitKit

/// A fact told to a session is drawn from the card the control plane recorded beside the turn's echo
/// (`coordinatorDelivery`) — one line, "Evidence revision 1 submitted: <task> · Sent to the coordinator
/// · 07:30 PM" — and never from the words the agent was sent, which stay behind the line verbatim.
///
/// The client half of the pair the web is held to (`CoordinatorDeliveryLine.test.tsx`): with the payload
/// the turn is the line, and without one it is exactly the bubble it was before any of this existed.
/// `CoordinatorDeliveryCopyParityTests` holds the words and the field names to the browser's.
final class CoordinatorDeliveryTests: XCTestCase {

    /// What `buildCoordinatorDeliveryMessage` writes for an evidence revision — the agent's reading,
    /// never read here, only kept.
    static let told = "From Orbit · project “Runner link v1” has a revision of completion evidence for you to decide\n\n"
        + "Task “Wiki model queue: one claim can take more requests than the concurrency room” "
        + "(34nmQgDgyywHNIUtjb9TD) submitted revision 1 of its completion evidence."

    private static let taskId = "01a0d6a9-d763-70e1-b4cf-8793e971b513"
    private static let title = "Wiki model queue: one claim can take more requests than the concurrency room"

    /// The card as the apiserver writes it (projects/coordinator-delivery-card.ts).
    private let card = """
        {"kind": "EVIDENCE_SUBMITTED",
         "task": {"id": "01a0d6a9-d763-70e1-b4cf-8793e971b513",
                  "title": "Wiki model queue: one claim can take more requests than the concurrency room"},
         "revision": 1, "count": null, "deliveredAt": "2026-10-31T11:30:00.000Z"}
        """

    private let expected = CoordinatorDelivery(
        kind: .evidenceSubmitted,
        task: .init(id: CoordinatorDeliveryTests.taskId, title: CoordinatorDeliveryTests.title),
        revision: 1, deliveredAt: "2026-10-31T11:30:00.000Z")

    /// One `user` event exactly as the server stores it, decoded through `RunEvent`: the wire path a
    /// client actually gets.
    private func echo(_ card: String?, text: String = CoordinatorDeliveryTests.told,
                      extra: String = "") throws -> RunEvent {
        let field = card.map { ", \"coordinatorDelivery\": \($0)" } ?? ""
        let json = """
            {"seq": 9, "type": "user", "turnId": "turn-delivery", "ts": "2026-10-31T11:30:01.000Z",
             "payload": {"text": \(Self.jsonString(text))\(field)\(extra)}}
            """
        return try JSONDecoder().decode(RunEvent.self, from: Data(json.utf8))
    }

    private static func jsonString(_ text: String) -> String {
        String(decoding: try! JSONEncoder().encode(text), as: UTF8.self)
    }

    private func onlyUser(_ reducer: TranscriptReducer) throws -> UserBubble {
        let users = reducer.state.items.compactMap { item -> UserBubble? in
            guard case .user(let b) = item else { return nil }
            return b
        }
        XCTAssertEqual(users.count, 1)
        return try XCTUnwrap(users.first)
    }

    private func parse(_ json: String) throws -> CoordinatorDelivery? {
        CoordinatorDelivery.parseCard(try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))
    }

    // MARK: - the payload

    func testReadsEveryFieldOfTheCard() throws {
        XCTAssertEqual(CoordinatorDelivery.parse(try echo(card).payload), expected)
        let moved = card.replacingOccurrences(of: "EVIDENCE_SUBMITTED", with: "EVIDENCE_MOVED_IN")
        XCTAssertEqual(CoordinatorDelivery.parse(try echo(moved).payload)?.kind, .evidenceMovedIn)
    }

    /// Every kind the server writes reads back, with exactly the fields its sentence names.
    func testEveryKindReadsWithTheFieldsItsSentenceNames() throws {
        let at = "\"deliveredAt\": \"2026-10-31T11:30:00.000Z\""
        let task = "\"task\": {\"id\": \"\(Self.taskId)\", \"title\": \"T\"}"
        for kind in CoordinatorDelivery.Kind.allCases {
            let sentence = CoordinatorDeliveryCard.sentence(for: kind)
            var fields = ["\"kind\": \"\(kind.rawValue)\"", at]
            if sentence.contains("{task}") { fields.append(task) }
            if sentence.contains("{revision}") { fields.append("\"revision\": 2") }
            if sentence.contains("{count}") { fields.append("\"count\": 3") }
            let read = try XCTUnwrap(try parse("{\(fields.joined(separator: ", "))}"), kind.rawValue)
            XCTAssertEqual(read.kind, kind)
            XCTAssertEqual(read.task != nil, sentence.contains("{task}"), kind.rawValue)
            XCTAssertEqual(read.revision != nil, sentence.contains("{revision}"), kind.rawValue)
            XCTAssertEqual(read.count != nil, sentence.contains("{count}"), kind.rawValue)
        }
    }

    /// A field the sentence does not name is left out, whatever the payload held: the line can never
    /// say a number or a task its sentence has no place for.
    func testAFieldTheSentenceDoesNotNameIsLeftOut() throws {
        let read = try XCTUnwrap(try parse("""
            {"kind": "LOOKS_FINISHED", "task": {"id": "\(Self.taskId)", "title": "T"}, "revision": 4, "count": 9,
             "deliveredAt": "2026-10-31T11:30:00.000Z"}
            """))
        XCTAssertEqual(read, CoordinatorDelivery(kind: .looksFinished, deliveredAt: "2026-10-31T11:30:00.000Z"))
    }

    /// A payload missing what makes it a card — a kind this end does not know, a moment that is not one,
    /// or a field its sentence names — is no card at all, never half of one: the turn keeps its old reading.
    func testAPayloadThatIsNotACardIsNone() throws {
        let broken = [
            card.replacingOccurrences(of: "EVIDENCE_SUBMITTED", with: "ATTEMPT_ENDED_UNSETTLED"),
            card.replacingOccurrences(of: "2026-10-31T11:30:00.000Z", with: "yesterday"),
            card.replacingOccurrences(of: "\"deliveredAt\": \"2026-10-31T11:30:00.000Z\"", with: "\"deliveredAt\": 7"),
            card.replacingOccurrences(of: "\"revision\": 1", with: "\"revision\": 0"),
            card.replacingOccurrences(of: "\"revision\": 1", with: "\"revision\": -2"),
            card.replacingOccurrences(of: "\"revision\": 1", with: "\"revision\": 1.5"),
            card.replacingOccurrences(of: "\"revision\": 1", with: "\"revision\": \"1\""),
            card.replacingOccurrences(of: "\"revision\": 1", with: "\"revision\": null"),
            card.replacingOccurrences(of: "\"title\": \"\(Self.title)\"", with: "\"title\": \"   \""),
            card.replacingOccurrences(of: "\"id\": \"\(Self.taskId)\"", with: "\"id\": \"\""),
            card.replacingOccurrences(of: "\"id\": \"\(Self.taskId)\"", with: "\"id\": 42"),
            "{\"kind\": \"DEPENDENT_READY\", \"task\": null, \"deliveredAt\": \"2026-10-31T11:30:00.000Z\"}",
            "{\"kind\": \"CRITERION_UNLANDED\", \"deliveredAt\": \"2026-10-31T11:30:00.000Z\"}",
            "{\"kind\": \"SETTLED_UNMERGED\", \"count\": 0, \"deliveredAt\": \"2026-10-31T11:30:00.000Z\"}",
            "{\"kind\": \"CRITERIA_APPROVED\"}",
            "\"Evidence revision 1 submitted\"",
            "[]",
            "null",
        ]
        for payload in broken {
            XCTAssertNil(CoordinatorDelivery.parse(try echo(payload).payload), payload)
        }
        XCTAssertNil(CoordinatorDelivery.parse(try echo(nil).payload), "an ordinary message is no delivery")
    }

    // MARK: - the transcript

    /// The echo becomes a row carrying the card, with the words kept whole for the sheet behind it.
    func testTheEchoCarriesTheCardAndKeepsItsWords() throws {
        var reducer = TranscriptReducer()
        reducer.apply(try echo(card))
        let b = try onlyUser(reducer)
        XCTAssertEqual(b.coordinatorDelivery, expected)
        XCTAssertEqual(b.text, Self.told)
        XCTAssertEqual(b.cards, TurnCards(coordinatorDelivery: expected))

        var plain = TranscriptReducer()
        plain.apply(try echo(nil))
        XCTAssertNil(try onlyUser(plain).coordinatorDelivery, "the same words with no card stay the bubble they were")
    }

    /// A transcript cached to disk keeps the card, and one cached before it existed keeps the bubble.
    func testASnapshotKeepsTheCard() throws {
        let bubble = UserBubble(id: "u1", text: Self.told, pending: false, coordinatorDelivery: expected)
        let stored = try JSONEncoder().encode(bubble)
        XCTAssertEqual(try JSONDecoder().decode(UserBubble.self, from: stored).coordinatorDelivery, expected)
        let older = Data("{\"id\": \"u1\", \"text\": \"hi\", \"pending\": false}".utf8)
        XCTAssertNil(try JSONDecoder().decode(UserBubble.self, from: older).coordinatorDelivery)

        // A reply told to a task's run keeps saying so; a card cached before `toCoordinator` existed is
        // still the card it was drawn as — the coordinator's — rather than no card at all.
        let run = CoordinatorDelivery(kind: .criteriaRejected, deliveredAt: expected.deliveredAt, toCoordinator: false)
        let ran = try JSONEncoder().encode(UserBubble(id: "u2", text: "x", pending: false, coordinatorDelivery: run))
        XCTAssertEqual(try JSONDecoder().decode(UserBubble.self, from: ran).coordinatorDelivery, run)
        let cachedBefore = Data(("{\"id\": \"u3\", \"text\": \"x\", \"pending\": false, \"coordinatorDelivery\": "
            + "{\"kind\": \"CRITERIA_APPROVED\", \"deliveredAt\": \"2026-10-31T11:30:00.000Z\"}}").utf8)
        XCTAssertEqual(try JSONDecoder().decode(UserBubble.self, from: cachedBefore).coordinatorDelivery,
                       CoordinatorDelivery(kind: .criteriaApproved, deliveredAt: "2026-10-31T11:30:00.000Z"))
    }

    /// Undelivered, the line offers nothing to put back in the composer: the words are the platform's,
    /// and its echo carries no `authoredByOrbit` to say so — the card does.
    func testNothingGoesBackToTheComposer() throws {
        var reducer = TranscriptReducer()
        reducer.apply(try echo(card, extra: ", \"delivery\": \"failed\""))
        var b = try onlyUser(reducer)
        b.undelivered = true
        XCTAssertNil(ComposerLogic.restorableText(of: b))
        XCTAssertFalse(SteerDelivery.offersPutBack(b))
        XCTAssertFalse(SteerDelivery.isReadersOwn(b))

        var plain = TranscriptReducer()
        plain.apply(try echo(nil, extra: ", \"delivery\": \"failed\""))
        var typed = try onlyUser(plain)
        typed.undelivered = true
        XCTAssertNotNil(ComposerLogic.restorableText(of: typed), "the same words with no card are still the reader's")
    }

    // MARK: - the line

    /// What every kind says, in the words of the design board — and a singular for one.
    func testEveryKindSaysItsSentence() {
        let at = "2026-10-31T11:30:00.000Z"
        let task = CoordinatorDelivery.TaskRef(id: Self.taskId, title: "Fix the claim")
        let cases: [(CoordinatorDelivery, String)] = [
            (.init(kind: .evidenceSubmitted, task: task, revision: 1, deliveredAt: at),
             "Evidence revision 1 submitted: Fix the claim"),
            (.init(kind: .evidenceMovedIn, task: task, revision: 3, deliveredAt: at),
             "Evidence revision 3 moved in: Fix the claim"),
            (.init(kind: .dependentReady, task: task, deliveredAt: at), "Can start now: Fix the claim"),
            (.init(kind: .taskDispatchRefused, task: task, deliveredAt: at), "Could not start: Fix the claim"),
            (.init(kind: .projectBlockerRaised, task: task, deliveredAt: at), "Blocker raised: Fix the claim"),
            (.init(kind: .taskRunStopped, task: task, deliveredAt: at), "Run stopped: Fix the claim"),
            (.init(kind: .criterionUnlanded, count: 3, deliveredAt: at), "Work not on main yet: 3 tasks"),
            (.init(kind: .criterionUnlanded, count: 1, deliveredAt: at), "Work not on main yet: 1 task"),
            (.init(kind: .acceptanceLanded, count: 9, deliveredAt: at), "All 9 criteria landed"),
            (.init(kind: .acceptanceLanded, count: 1, deliveredAt: at), "The only criterion landed"),
            (.init(kind: .acceptanceLandedHeld, count: 9, deliveredAt: at), "All 9 criteria landed, Done held back"),
            (.init(kind: .acceptanceLandedHeld, count: 1, deliveredAt: at), "The only criterion landed, Done held back"),
            (.init(kind: .acceptanceLandedDone, count: 9, deliveredAt: at), "All 9 criteria landed, recorded Done"),
            (.init(kind: .acceptanceLandedDone, count: 1, deliveredAt: at), "The only criterion landed, recorded Done"),
            (.init(kind: .looksFinished, deliveredAt: at), "Looks finished, not recorded Done"),
            (.init(kind: .settledUnmerged, count: 2, deliveredAt: at), "Settled with work not on main: 2 commits"),
            (.init(kind: .settledUnmerged, count: 1, deliveredAt: at), "Settled with work not on main: 1 commit"),
            (.init(kind: .criteriaApproved, deliveredAt: at), "Criteria proposal approved"),
            (.init(kind: .criteriaRejected, deliveredAt: at), "Criteria proposal rejected"),
        ]
        for (card, sentence) in cases {
            XCTAssertEqual(CoordinatorDeliveryCard.sentence(card), sentence, card.kind.rawValue)
        }
        XCTAssertEqual(Set(cases.map { $0.0.kind }), Set(CoordinatorDelivery.Kind.allCases),
                       "a kind with no sentence checked")
    }

    /// A title is the owner's words: whatever it holds is said, never read as a placeholder.
    func testATitleIsNeverAPattern() {
        let odd = CoordinatorDelivery(kind: .dependentReady,
                                      task: .init(id: Self.taskId, title: "Rename {count} to $& and {task}"),
                                      deliveredAt: "2026-10-31T11:30:00.000Z")
        XCTAssertEqual(CoordinatorDeliveryCard.sentence(odd), "Can start now: Rename {count} to $& and {task}")
    }

    /// The sentence, then what a version handed to its coordinator says, on the same clock — the half
    /// that never gives way.
    func testTheLineIsTheSentenceThenSentToTheCoordinator() throws {
        let sameDay = try XCTUnwrap(ThinkingSummary.date("2026-10-31T11:45:00.000Z"))
        let sent = CoordinatorDeliveryCard.sent(expected, now: sameDay)
        XCTAssertEqual(sent, EvidenceDecisions.sentLine(expected.deliveredAt, now: sameDay))
        XCTAssertTrue(sent.hasPrefix("Sent to the coordinator · "))
        XCTAssertEqual(CoordinatorDeliveryCard.line(expected, now: sameDay),
                       "Evidence revision 1 submitted: \(Self.title) · \(sent)")
    }

    // MARK: - a reply told to a session that is not the coordinator

    /// The owner's answer to a criteria proposal goes to whichever session filed it. Told to a task's run,
    /// the line says it was sent to this session and opens to what this session was told — never the
    /// coordinator, which it was not sent to. Told to the coordinator, it says what it always said.
    func testAReplyToATasksRunSaysThisSession() throws {
        let reply = "{\"kind\": \"CRITERIA_REJECTED\", \"task\": null, \"revision\": null, \"count\": null, "
            + "\"deliveredAt\": \"2026-10-31T11:30:00.000Z\", \"toCoordinator\": false}"
        let run = try XCTUnwrap(try parse(reply))
        XCTAssertEqual(run, CoordinatorDelivery(kind: .criteriaRejected, deliveredAt: "2026-10-31T11:30:00.000Z",
                                                toCoordinator: false))
        let sameDay = try XCTUnwrap(ThinkingSummary.date("2026-10-31T11:45:00.000Z"))
        let time = EvidenceDecisions.receiptTime(run.deliveredAt, now: sameDay)
        XCTAssertEqual(CoordinatorDeliveryCard.sent(run, now: sameDay), "Sent to this session · \(time)")
        XCTAssertEqual(CoordinatorDeliveryCard.line(run, now: sameDay), "Criteria proposal rejected · Sent to this session · \(time)")
        XCTAssertEqual(CoordinatorDeliveryCard.heading(run), "What this session was told")
        XCTAssertEqual(CoordinatorDeliveryCard.openHint(run), "Opens what this session was told")
        for said in [CoordinatorDeliveryCard.sent(run, now: sameDay), CoordinatorDeliveryCard.line(run, now: sameDay),
                     CoordinatorDeliveryCard.heading(run), CoordinatorDeliveryCard.openHint(run)] {
            XCTAssertFalse(said.contains("coordinator"), said)
        }
        // The sentence and the sticky bar are what they were.
        XCTAssertEqual(CoordinatorDeliveryCard.sentence(run), "Criteria proposal rejected")
        XCTAssertEqual(StickySummary.of(text: "From Orbit · criteria decision", coordinatorDelivery: run).label, "↑ From Orbit")

        let coordinator = try XCTUnwrap(try parse(reply.replacingOccurrences(of: "false}", with: "true}")))
        XCTAssertTrue(coordinator.toCoordinator)
        XCTAssertEqual(CoordinatorDeliveryCard.sent(coordinator, now: sameDay), EvidenceDecisions.sentLine(coordinator.deliveredAt, now: sameDay))
        XCTAssertTrue(CoordinatorDeliveryCard.sent(coordinator, now: sameDay).hasPrefix("Sent to the coordinator · "))
        XCTAssertEqual(CoordinatorDeliveryCard.heading(coordinator), "What the coordinator was told")
        XCTAssertEqual(CoordinatorDeliveryCard.openHint(coordinator), "Opens what the coordinator was told")
    }

    /// Only the server's own `false` says the conversation is not the coordinator: a card stored before the
    /// field existed — every fact a coordinator is told, and every reply until now — reads as it was drawn.
    func testOnlyTheServersFalseSaysNotTheCoordinator() throws {
        XCTAssertTrue(try XCTUnwrap(CoordinatorDelivery.parse(try echo(card).payload)).toCoordinator, "a card with no field")
        for odd in ["\"false\"", "0", "null", "\"no\""] {
            let read = try XCTUnwrap(try parse(card.replacingOccurrences(of: "\"count\": null,",
                                                                          with: "\"count\": null, \"toCoordinator\": \(odd),")), odd)
            XCTAssertTrue(read.toCoordinator, odd)
        }
    }

    /// The task the fact names opens in the app; a fact that names none has no link.
    func testItsTaskOpensTheTask() {
        XCTAssertEqual(CoordinatorDeliveryCard.taskLink(expected)?.absoluteString, "orbit-task:\(Self.taskId)")
        XCTAssertNil(CoordinatorDeliveryCard.taskLink(.init(kind: .looksFinished, deliveredAt: expected.deliveredAt)))
        XCTAssertEqual(CoordinatorDeliveryCard.itsTask, "Its task ↗")
    }

    // MARK: - the sticky bar

    /// Unlike the owner's answer, the line IS the head of a round — the reply under it answers it — so
    /// the bar points back at it and names it `↑ From Orbit` and the sentence, never `Your question`.
    func testTheStickyBarNamesTheLineFromOrbit() {
        XCTAssertTrue(StickySummary.isAnchor(text: Self.told, coordinatorDelivery: expected))
        let summary = StickySummary.of(text: Self.told, coordinatorDelivery: expected)
        XCTAssertEqual(summary.label, "↑ From Orbit")
        XCTAssertEqual(summary.text, CoordinatorDeliveryCard.sentence(expected))
        XCTAssertNotEqual(summary.label, StickySummary.yourQuestion)
        XCTAssertEqual(StickySummary.compactLabel(summary.label), "↑ From Orbit", "the iPhone's capsule says it too")
        XCTAssertEqual(StickySummary.of(text: Self.told).label, StickySummary.yourQuestion,
                       "with no card it is the reader's message, as before")
    }
}

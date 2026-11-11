import Foundation
import XCTest
@testable import OrbitKit

/// The five Orbit turn cards (`OrbitTurnCards.swift`, docs/mocks/orbit-turn-cards/): each payload
/// read, a payload that is not one read as nothing, the state lines word for word as the web's, and
/// an echo carrying one drawn as its card and never as the reader's own words.
final class OrbitTurnCardsTests: XCTestCase {
    private let now = RelativeTime.parse("2026-11-11T05:20:00.000Z")!

    private func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    // MARK: - evidence to review

    private func review(state: String = "OPEN", dueAt: String? = "2026-11-11T05:35:30.000Z",
                        decision: String? = nil, latest: String = "1") throws -> EvidenceReviewCard {
        let due = dueAt.map { "\"\($0)\"" } ?? "null"
        let dec = decision.map { "\"\($0)\"" } ?? "null"
        return try XCTUnwrap(EvidenceReviewCard.parse(try json("""
            {"text": "", "evidenceReview": {"evidenceId": "ev", "taskId": "task-1", "title": "Welcome card",
             "revision": "1", "runSessionId": "s-run", "dueAt": \(due), "claim": "Done in all states.",
             "state": "\(state)", "latestRevision": "\(latest)", "decision": \(dec)}}
            """)))
    }

    func testEvidenceReviewParsesAndSaysWhoDecides() throws {
        let card = try review()
        XCTAssertEqual(card.claim, "Done in all states.")
        XCTAssertEqual(card.state, .open)
        XCTAssertTrue(OrbitTurnCardCopy.evidenceMeta(card, now: now).hasPrefix("Revision 1 · Due "))
        let open = OrbitTurnCardCopy.evidenceState(card, now: now)
        XCTAssertTrue(open.text.hasPrefix("This session decides it. If it hasn't by "))
        XCTAssertTrue(open.text.hasSuffix(", you're asked."))
        XCTAssertEqual(open.tone, .secondary)

        let late = OrbitTurnCardCopy.evidenceState(card, now: now.addingTimeInterval(3_600))
        XCTAssertTrue(late.text.hasPrefix("You were asked at "))
        XCTAssertEqual(late.tone, .warning)

        XCTAssertEqual(OrbitTurnCardCopy.evidenceState(try review(dueAt: nil), now: now).text, "This session decides it.")
        XCTAssertEqual(OrbitTurnCardCopy.evidenceMeta(try review(dueAt: nil), now: now), "Revision 1")
        XCTAssertEqual(OrbitTurnCardCopy.evidenceState(try review(state: "SUPERSEDED", latest: "2"), now: now).text,
                       "Revision 2 replaced it. Nothing to decide.")
        XCTAssertEqual(OrbitTurnCardCopy.evidenceState(try review(state: "DECIDED", decision: "CONFIRM"), now: now),
                       OrbitTurnCardStateLine(text: "Confirmed.", tone: .success))
        XCTAssertEqual(OrbitTurnCardCopy.evidenceState(try review(state: "DECIDED", decision: "SEND_BACK"), now: now).text,
                       "Sent back.")
        XCTAssertEqual(OrbitTurnCardCopy.evidenceState(try review(state: "CLOSED"), now: now).text,
                       "The task is closed. Nothing to decide.")
    }

    func testEvidenceReviewThatIsNotOneReadsAsNothing() throws {
        XCTAssertNil(EvidenceReviewCard.parse(try json(#"{"text": "hi"}"#)))
        XCTAssertNil(EvidenceReviewCard.parse(try json(#"{"evidenceReview": {"taskId": "t", "title": "x"}}"#)))
        XCTAssertNil(EvidenceReviewCard.parse(try json("""
            {"evidenceReview": {"taskId": "t", "title": "x", "revision": "1", "runSessionId": "s", "state": "MAYBE"}}
            """)))
    }

    // MARK: - evidence sent back

    func testEvidenceSendBackSaysWhoSentItBack() throws {
        let bySession = try XCTUnwrap(EvidenceSendBackCard.parse(try json("""
            {"evidenceSendBack": {"decisionId": "d", "taskId": "task-1", "title": "Welcome card", "revision": "1",
             "note": "Add the macOS shot.", "by": "SESSION", "bySessionId": "s-1", "byTitle": "新用户欢迎卡片"}}
            """)))
        XCTAssertEqual(OrbitTurnCardCopy.sendBackLead(bySession) + OrbitTurnCardCopy.sendBackWho(bySession),
                       "Revision 1 · by 新用户欢迎卡片")
        let byOwner = try XCTUnwrap(EvidenceSendBackCard.parse(try json("""
            {"evidenceSendBack": {"taskId": "task-1", "title": "Welcome card", "revision": "2", "note": "More.", "by": "OWNER"}}
            """)))
        XCTAssertEqual(OrbitTurnCardCopy.sendBackLead(byOwner) + OrbitTurnCardCopy.sendBackWho(byOwner), "Revision 2 · by you")
        let unknown = EvidenceSendBackCard(taskId: "t", title: "x", revision: "1", note: "n", byOwner: false)
        XCTAssertEqual(OrbitTurnCardCopy.sendBackWho(unknown), "a session")
        XCTAssertNil(EvidenceSendBackCard.parse(try json("""
            {"evidenceSendBack": {"taskId": "t", "title": "x", "revision": "1", "note": "n", "by": "NOBODY"}}
            """)))
        XCTAssertNil(EvidenceSendBackCard.parse(try json(#"{"evidenceSendBack": "nope"}"#)))
    }

    // MARK: - question from a task run

    private func question(_ extra: String = #""answers": null, "answeredBy": null"#,
                          state: String = "OPEN", approval: String = "PENDING") throws -> RunQuestionCard {
        try XCTUnwrap(RunQuestionCard.parse(try json("""
            {"runQuestion": {"requestId": "rq", "approvalId": "ap", "taskId": "task-3", "taskTitle": "",
             "runSessionId": "s-run", "replyBy": "2026-11-11T06:10:00.000Z", "state": "\(state)",
             "approvalStatus": "\(approval)",
             "questions": [{"question": "Keep its place?", "options": [{"label": "Keep"}, {"label": "Back"}]}],
             \(extra)}}
            """)))
    }

    func testRunQuestionSaysWhoAnswersAndWhatWasPicked() throws {
        let open = try question()
        XCTAssertEqual(OrbitTurnCardCopy.taskTitle(open.taskTitle), "A task run")
        XCTAssertEqual(open.lines(open.questions[0]).map(\.text), ["Keep", "Back"])
        let waiting = OrbitTurnCardCopy.questionState(open, now: now)
        XCTAssertTrue(waiting.text.hasPrefix("The run is waiting. This session answers it; if it hasn't by "))
        XCTAssertTrue(waiting.text.hasSuffix(", you're asked."))
        let passed = OrbitTurnCardCopy.questionState(open, now: now.addingTimeInterval(7_200))
        XCTAssertTrue(passed.text.hasPrefix("Passed to you at "))
        XCTAssertEqual(passed.tone, .warning)
        XCTAssertTrue(OrbitTurnCardCopy.questionState(try question(state: "NO_REPLY"), now: now).text
            .hasPrefix("Passed to you at "))

        let bySession = try question(#""answers": {"Keep its place?": ["Keep"]}, "answeredBy": "SESSION""#,
                                     state: "REPLIED", approval: "ALLOWED")
        XCTAssertEqual(bySession.lines(bySession.questions[0]),
                       [.init(text: "\u{2713} Keep", picked: true), .init(text: "Back", picked: false)])
        XCTAssertEqual(OrbitTurnCardCopy.questionState(bySession, now: now),
                       OrbitTurnCardStateLine(text: "Answered by this session.", tone: .success))

        let ownWords = try question(#""answers": {"Keep its place?": ["Neither, ask me"]}, "answeredBy": "OWNER""#,
                                    state: "OWNER_ANSWERED", approval: "ALLOWED")
        XCTAssertEqual(ownWords.lines(ownWords.questions[0]).map(\.text),
                       ["Keep", "Back", "\u{2713} \u{201C}Neither, ask me\u{201D}"])
        XCTAssertEqual(OrbitTurnCardCopy.questionState(ownWords, now: now).text, "Answered by you.")

        XCTAssertEqual(OrbitTurnCardCopy.questionState(try question(state: "UNDELIVERED", approval: "DENIED"), now: now).text,
                       "Closed without an answer.")
        XCTAssertNil(RunQuestionCard.parse(try json(#"{"runQuestion": {"requestId": "rq"}}"#)))
    }

    // MARK: - notice from a task run

    func testRunNoticeParses() throws {
        let card = try XCTUnwrap(RunNoticeCard.parse(try json("""
            {"runNotice": {"requestId": "rn", "taskId": "task-4", "taskTitle": "Three clients", "runSessionId": "s",
             "message": "Android emulator is down.", "state": "OPEN"}}
            """)))
        XCTAssertEqual(card.message, "Android emulator is down.")
        XCTAssertEqual(OrbitTurnCardCopy.noticeState, "Nothing to reply to. It did not reach you.")
        XCTAssertNil(RunNoticeCard.parse(try json(#"{"runNotice": {"requestId": "rn", "runSessionId": "s"}}"#)))
    }

    // MARK: - the opening of a session Orbit opened

    func testSessionOpeningSaysWhyByKind() throws {
        func opening(_ kind: String, target: String?, mention: String? = nil) throws -> SessionOpeningCard {
            let m = mention.map { "\"\($0)\"" } ?? "null"
            return try XCTUnwrap(SessionOpeningCard.parse(try json("""
                {"sessionOpening": {"kind": "\(kind)", "target": \(target ?? "null"), "mention": \(m)}}
                """)))
        }
        let project = #"{"kind": "PROJECT", "id": "01a0cca0-aeaa-7618-bd5a-caccc089108c", "title": "Landing checks"}"#
        let task = #"{"kind": "TASK", "id": "01a0cca7-8609-70ed-a0e2-d4b55b832b60", "title": "K3"}"#
        let list = #"{"kind": "LIST", "id": "01a0cca7-8609-70ed-a0e2-d4b55b832b61", "title": "Wiki polish"}"#
        let coordinator = try opening("COORDINATOR", target: project)
        XCTAssertEqual(coordinator.lead, "Orbit started this session as the coordinator of")
        XCTAssertEqual(coordinator.linkedTarget?.url?.scheme, "orbit-project")
        XCTAssertEqual(try opening("JUDGMENT", target: task).lead, "Orbit started this session to judge")
        XCTAssertEqual(try opening("JUDGMENT", target: task).linkedTarget?.url?.scheme, "orbit-task")
        XCTAssertEqual(try opening("DISPATCH", target: list).lead, "Orbit started this session to dispatch the list")
        XCTAssertEqual(try opening("DISPATCH", target: list).linkedTarget?.url?.scheme, "orbit-list")
        let mention = try opening("MENTION", target: task, mention: "@agent check the domain")
        XCTAssertEqual(mention.lead, "Orbit started this session for your mention on")
        XCTAssertEqual(mention.mention, "@agent check the domain")
        let other = try opening("OTHER", target: nil)
        XCTAssertEqual(other.lead, "Orbit started this session")
        XCTAssertNil(other.linkedTarget)
        XCTAssertEqual(try opening("COORDINATOR", target: nil).lead, "Orbit started this session")
        XCTAssertNil(SessionOpeningCard.parse(try json(#"{"sessionOpening": {"kind": "SOMETHING"}}"#)))
    }

    // MARK: - the echo

    /// Each card reaches the bubble its `user` event draws, and that bubble is never the reader's own
    /// words: it neither waits in the tray nor goes back to the composer.
    func testAnEchoCarryingACardIsDrawnAsItAndIsNotTheReadersOwn() throws {
        let payloads: [(field: String, card: String)] = [
            ("evidenceReview", """
                {"taskId": "t", "title": "x", "revision": "1", "runSessionId": "s", "state": "OPEN", "latestRevision": "1"}
                """),
            ("evidenceSendBack", #"{"taskId": "t", "title": "x", "revision": "1", "note": "n", "by": "OWNER"}"#),
            ("runQuestion", """
                {"requestId": "rq", "runSessionId": "s", "replyBy": "2026-11-11T06:10:00.000Z", "state": "OPEN",
                 "questions": []}
                """),
            ("runNotice", #"{"requestId": "rn", "runSessionId": "s", "message": "m"}"#),
            ("sessionOpening", #"{"kind": "OTHER", "target": null}"#),
        ]
        for payload in payloads {
            let event = """
                {"seq": 1, "type": "user", "turnId": "t-1", "ts": "2026-11-11T05:05:00.000Z",
                 "payload": {"text": "Words Orbit wrote for the agent.", "\(payload.field)": \(payload.card)}}
                """
            var reducer = TranscriptReducer()
            reducer.apply(try JSONDecoder().decode(RunEvent.self, from: Data(event.utf8)))
            let bubble = try XCTUnwrap(reducer.state.items.compactMap { item -> UserBubble? in
                guard case .user(let b) = item else { return nil }
                return b
            }.first, payload.field)
            let filled = Mirror(reflecting: bubble.cards).children.compactMap { child -> String? in
                let value = Mirror(reflecting: child.value)
                return value.displayStyle == .optional && value.children.isEmpty ? nil : child.label
            }
            XCTAssertEqual(filled, [payload.field])
            XCTAssertFalse(SteerDelivery.isReadersOwn(bubble), "\(payload.field) read as the reader's own words")
        }
    }
}

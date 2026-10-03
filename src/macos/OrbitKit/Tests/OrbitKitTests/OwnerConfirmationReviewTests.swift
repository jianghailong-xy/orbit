import Foundation
import XCTest
@testable import OrbitKit

/// What the owner-confirmation card's review bar draws, what a confirmation sends about the review,
/// and what a receipt says about the owner's answers — proved against
/// `src/shared/src/owner-confirmation-review.fixture.json`, the same cases the web's
/// `OwnerConfirmationReview.test.tsx` proves its `reviewBar`, `reviewAnswered` and `ownerAnswerLines`
/// against. So the browser, the Mac and the phone draw the same lines about one review.
///
/// A failure — never an `XCTSkip` — when the fixture goes missing: a check that quietly opts out
/// reports green on exactly the day the thing it watches went away.
final class OwnerConfirmationReviewTests: XCTestCase {

    private static let fixturePath = "src/shared/src/owner-confirmation-review.fixture.json"

    private struct Missing: Error, CustomStringConvertible {
        var description: String {
            "\(OwnerConfirmationReviewTests.fixturePath) was not found above this test file. "
                + "Both clients are proved against it; if it moved, move this check with it."
        }
    }

    private struct Fixture: Decodable {
        struct BarCase: Decodable {
            let `case`: String
            let place: ReviewPlace
            let review: OwnerConfirmationReviewView
            let bar: ReviewBar
        }
        struct WindowCase: Decodable {
            let seconds: Int
            let words: String
        }
        struct RequestCase: Decodable {
            let `case`: String
            let decision: OwnerDecision
            let requestId: String
            let note: String?
            let review: OwnerConfirmationReviewView?
            let choices: [String: ReviewChoice]
            let body: JSONValue
            let complete: Bool
        }
        struct AnswerCase: Decodable {
            let `case`: String
            let decided: RecordedOwnerDecision
            let lines: [OwnerAnswerLine]
            let before: Bool
        }
        let bars: [BarCase]
        let windows: [WindowCase]
        let requests: [RequestCase]
        let answers: [AnswerCase]
    }

    private func fixture() throws -> Fixture {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(Self.fixturePath)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: candidate))
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing()
    }

    /// The fixture's clock: an instant's UTC hours and minutes.
    private static func utcClock(_ iso: String) -> String? {
        guard let at = RelativeTime.parse(iso) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let parts = calendar.dateComponents([.hour, .minute], from: at)
        guard let hour = parts.hour, let minute = parts.minute else { return nil }
        return String(format: "%02d:%02d", hour, minute)
    }

    // MARK: the bar

    func testTheBarDrawsWhatTheFixtureDraws() throws {
        let cases = try fixture().bars
        XCTAssertGreaterThan(cases.count, 15)
        for each in cases {
            XCTAssertEqual(OwnerConfirmations.reviewBar(each.review, place: each.place,
                                                        clock: Self.utcClock),
                           each.bar, each.case)
        }
    }

    func testAWindowIsSaidTheWayTheFixtureSaysIt() throws {
        for each in try fixture().windows {
            XCTAssertEqual(OwnerConfirmations.reviewWindowWords(each.seconds), each.words, "\(each.seconds)")
        }
    }

    // MARK: the press

    /// What one press sends, compared as JSON with the body the web sends for the same review and
    /// answers: the record the card drew (null when none, and present either way), and an answer to
    /// each question — with a confirmation only.
    func testThePressSendsWhatTheFixtureSends() throws {
        for each in try fixture().requests {
            let waiting = OwnerConfirmationWaiting(requestId: each.requestId, sessionId: "s",
                                                   requestedAt: "2026-10-02T14:55:00Z", review: each.review)
            let request = try XCTUnwrap(OwnerConfirmations.request(
                waiting: waiting, decision: each.decision, note: each.note,
                review: OwnerConfirmations.reviewAnswered(each.review, choices: each.choices)), each.case)
            let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? NSDictionary
            let expected = try JSONSerialization.jsonObject(with: JSONEncoder().encode(each.body)) as? NSDictionary
            XCTAssertEqual(sent, expected, each.case)
            XCTAssertEqual(OwnerConfirmations.reviewAnswersComplete(each.review, choices: each.choices),
                           each.complete, each.case)
        }
    }

    // MARK: the receipt

    func testTheReceiptListsTheAnswersTheFixtureLists() throws {
        for each in try fixture().answers {
            XCTAssertEqual(OwnerConfirmations.ownerAnswerLines(each.decided), each.lines, each.case)
            XCTAssertEqual(OwnerConfirmations.reviewCameInAfter(each.decided), each.before, each.case)
        }
    }

    // MARK: the read, as this client takes it

    /// A review this build cannot read costs the review alone, never the card: an unknown state drops
    /// the bar and keeps the question, and an unknown reason keeps the bar and says no reason.
    func testAReviewThisBuildCannotReadCostsOnlyTheReview() throws {
        func view(_ review: String) throws -> OwnerConfirmationView {
            try JSONDecoder().decode(OwnerConfirmationView.self, from: Data((
                #"{"taskId":"t1","title":"T","status":"OPEN","projectId":null,"#
                    + #""completionCriterion":"OWNER_CONFIRMED","acceptanceCriteria":null,"#
                    + #""waiting":{"requestId":"r1","sessionId":"s1","requestedAt":"2026-10-02T14:55:00Z","#
                    + #""report":null,"review":\#(review)},"decisions":[]}"#).utf8))
        }
        let base = #"{"reviewId":"rv1","reviewer":{"kind":"TASK_CREATOR","sessionId":"s2","title":"R"},"#
            + #""since":"2026-10-02T14:55:00Z","dueAt":"2026-10-02T15:25:00Z","windowSeconds":1800,"#
            + #""outdated":null,"headline":null,"review":null,"returned":null,"problems":null,"#
        let unknownState = try view(base + #""state":"SOMETHING_NEW","notReviewedReason":null}"#)
        XCTAssertNotNil(unknownState.waiting, "the question is still asked")
        XCTAssertNil(unknownState.waiting?.review, "without a bar this build cannot draw")

        let unknownReason = try view(base + #""state":"NOT_REVIEWED","notReviewedReason":"SOMETHING_NEW"}"#)
        let review = try XCTUnwrap(unknownReason.waiting?.review)
        XCTAssertEqual(review.notReviewedReason, .unknown)
        XCTAssertEqual(OwnerConfirmations.notReviewedNote(review.notReviewedReason, windowSeconds: 1800),
                       "Only the agent that did the work has checked this.")

        // An older server sends no review at all, and no returns: the card is as it always was.
        let older = try JSONDecoder().decode(OwnerConfirmationView.self, from: Data(
            (#"{"taskId":"t1","title":"T","status":"OPEN","projectId":null,"completionCriterion":"OWNER_CONFIRMED","#
                + #""acceptanceCriteria":null,"waiting":null,"decisions":[{"id":"d1","decision":"CONFIRM","#
                + #""note":null,"decidedAt":"2026-10-02T15:00:00Z","decidedByType":"USER","requestId":"r1","#
                + #""sessionId":"s1","report":null}]}"#).utf8))
        XCTAssertEqual(older.reviewerReturns, [])
        XCTAssertNil(older.decisions.first?.review)
        XCTAssertEqual(older.decisions.first?.answers, [])
    }

    /// A report its reviewer sent back is answered — by nobody the owner was asked to be — and the
    /// card it was becomes the record of that, with nothing to press (§8 B6).
    func testAReturnedReportIsARecordNotAQuestion() throws {
        let returned = ReviewerReturnedRequest(
            requestId: "r1", sessionId: "s1", requestedAt: "2026-10-02T14:55:00Z",
            review: OwnerConfirmationReviewView(
                reviewId: "rv1", state: .returned,
                reviewer: .init(kind: "TASK_CREATOR", sessionId: "s2", title: "R"),
                since: "2026-10-02T14:55:00Z", dueAt: "2026-10-02T15:25:00Z", windowSeconds: 1800,
                returned: ConfirmationReturnRecordView(recordId: "ret1", recordedAt: "2026-10-02T15:08:00Z",
                                                       reason: "Not fixed yet.", problems: [])))
        let view = OwnerConfirmationView(taskId: "t1", title: "T", status: "OPEN",
                                         completionCriterion: "OWNER_CONFIRMED", reviewerReturns: [returned])
        let standing = OwnerConfirmations.standing(view, sessionID: "s1", requestID: "r1")
        XCTAssertEqual(standing.returned, returned)
        XCTAssertFalse(standing.answerable)
        XCTAssertFalse(OwnerConfirmations.isOpen(standing))
        XCTAssertNil(OwnerConfirmations.staleExplanation(standing), "the record explains itself")
        XCTAssertEqual(OwnerConfirmations.reviewerReturnsIn(view, sessionID: "s1"), [returned])
        XCTAssertEqual(OwnerConfirmations.reviewerReturnsIn(view, sessionID: "elsewhere"), [])
    }

    /// While a run's report is with its reviewer, the task's own page takes the reader to the card
    /// saying so rather than asking for the owner's confirmation (§5 N3); the task list's row says it
    /// in the place `Waiting for your confirmation` takes.
    func testTheTaskSaysUnderReviewWhereItWouldAskForConfirmation() throws {
        let review = OwnerConfirmationReviewView(
            reviewId: "rv1", state: .underReview,
            reviewer: .init(kind: "TASK_CREATOR", sessionId: "s2", title: "R"),
            since: "2026-10-02T14:55:00Z", dueAt: "2026-10-02T15:25:00Z", windowSeconds: 1800)
        let view = OwnerConfirmationView(
            taskId: "t1", title: "T", status: "OPEN", completionCriterion: "OWNER_CONFIRMED",
            waiting: OwnerConfirmationWaiting(requestId: "r1", sessionId: "s1",
                                              requestedAt: "2026-10-02T14:55:00Z", review: review))
        let action = OwnerConfirmations.panelAction(view, taskIsOwnerConfirmed: true, taskUnsettled: true,
                                                    taskHasRuns: true)
        XCTAssertEqual(action, .underReview(sessionId: "s1"))
        let idle = try JSONDecoder().decode(TaskItem.self, from: Data(
            #"{"id":"t1","title":"t","status":"OPEN","sessions":[{"id":"s1","status":"AWAITING_INPUT"}]}"#.utf8))
        let row = TaskDetailLogic.actionRow(owner: action, reopenable: false, status: .open, gate: false,
                                            entry: TaskRunHandoff.entry(for: idle))
        XCTAssertEqual(row.leading, .underReview(sessionID: "s1"))
        XCTAssertTrue(row.stacked, "the same stacking as the pointer it stands in for")

        let task = try JSONDecoder().decode(TaskItem.self, from: Data(
            #"{"id":"a","title":"t","status":"IN_PROGRESS","awaitingOwnerConfirmation":false,"confirmationUnderReview":true}"#.utf8))
        XCTAssertEqual(TaskListLogic.rowPhrase(task), .underReview)
    }

    /// Reopen task is offered under a receipt only once the task has settled, and asks the panel's
    /// own question (§9 L4).
    func testReopenIsOfferedOnceTheTaskHasSettled() {
        func view(_ status: String) -> OwnerConfirmationView {
            OwnerConfirmationView(taskId: "t1", title: "T", status: status, completionCriterion: "OWNER_CONFIRMED")
        }
        XCTAssertTrue(OwnerConfirmations.reopenOffered(view("DONE")))
        XCTAssertTrue(OwnerConfirmations.reopenOffered(view("FAILED")))
        XCTAssertFalse(OwnerConfirmations.reopenOffered(view("OPEN")))
        XCTAssertFalse(OwnerConfirmations.reopenOffered(nil))
        XCTAssertEqual(TaskReopen.paragraphs(projectId: "p1", terminalReason: nil),
                       [TaskReopenCopy.modalBody, TaskReopenCopy.modalProject])
    }

    // MARK: the two turns a review puts into a conversation

    func testTheTwoReviewTurnsParseAsTheirCards() {
        let request = ConfirmationReviewRequestCard.parse(.object([
            "text": .string(""),
            "confirmationReviewRequest": .object([
                "requestId": .string("r1"), "reviewId": .string("rv1"), "taskId": .string("t1"),
                "title": .string("会话间请求与回复"), "runSessionId": .string("s1"),
                "branch": .string("orbit/p1"), "sha": .null, "dueAt": .string("2026-10-02T15:25:00Z"),
            ]),
        ]))
        XCTAssertEqual(request, ConfirmationReviewRequestCard(requestId: "r1", reviewId: "rv1", taskId: "t1",
                                                             title: "会话间请求与回复", runSessionId: "s1",
                                                             branch: "orbit/p1", dueAt: "2026-10-02T15:25:00Z"))
        XCTAssertNil(ConfirmationReviewRequestCard.parse(.object(["text": .string("hi")])))

        let returned = ConfirmationReturnCard.parse(.object([
            "confirmationReturn": .object([
                "requestId": .string("r1"), "recordId": .string("ret1"),
                "reviewerSessionId": .string("s2"), "reviewerTitle": .string("R"),
                "reason": .string("Not fixed yet."),
                "problems": .array([.object(["key": .string("p1"), "text": .string("P1-3 twice")])]),
            ]),
        ]))
        XCTAssertEqual(returned?.problems.map(\.text), ["P1-3 twice"])
        XCTAssertEqual(returned?.reviewerTitle, "R")
        XCTAssertNil(ConfirmationReturnCard.parse(.object(["confirmationReturn": .object(["requestId": .string("r1")])])))
    }
}

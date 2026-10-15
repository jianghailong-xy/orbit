import XCTest
@testable import OrbitKit

/// The words a review sheet ends on once its own answer was taken — each the line the owner
/// approved on its board, word for word.
final class ReviewRecordsTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!
    private var calendar: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = utc; return c }
    /// 2026-10-15 14:06 UTC, and "now" a minute later on the same day.
    private let at = Date(timeIntervalSince1970: 1_792_073_160)
    private var now: Date { at.addingTimeInterval(60) }

    override func setUp() {
        super.setUp()
        NSTimeZone.default = utc
    }

    func testTheClockOnTheDayAndTheDateAfter() {
        XCTAssertEqual(ReviewRecords.time(at, now: now, calendar: calendar, timeZone: utc), "14:06")
        XCTAssertEqual(ReviewRecords.time(at, now: at.addingTimeInterval(86_400), calendar: calendar, timeZone: utc),
                       "10/15 14:06")
    }

    func testTheApprovals() {
        XCTAssertEqual(ReviewRecords.question(at: at, now: now),
                       ReviewRecordFooter(mark: .done, line: "Answered by you · 14:06", detail: "Sent to the agent"))
        XCTAssertEqual(ReviewRecords.plan(approved: true, at: at, now: now),
                       ReviewRecordFooter(mark: .done, line: "Approved by you · 14:06",
                                          detail: "The agent is running the plan"))
        XCTAssertEqual(ReviewRecords.plan(approved: false, at: at, now: now),
                       ReviewRecordFooter(mark: .keptOpen, line: "Kept planning · by you · 14:06",
                                          detail: "The agent goes on planning"))
        XCTAssertEqual(ReviewRecords.toolAsk(at: at, now: now),
                       ReviewRecordFooter(mark: .done, line: "Approved by you · 14:06", detail: "Sent to the agent"))
    }

    func testAnAnswerSplitsIntoThePicksAndTheWordsTyped() {
        let q = AskQuestion(header: nil, question: "How?", options: [
            AskOption(label: "Confirm", description: nil), AskOption(label: "Send back", description: nil),
        ], multiSelect: true)
        let picked = ReviewRecords.answer(to: q, in: ["How?": ["Confirm", "Send back"]])
        XCTAssertEqual(picked.picked, ["Confirm", "Send back"])
        XCTAssertNil(picked.typed)
        let typed = ReviewRecords.answer(to: q, in: ["How?": ["Confirm it, and file the rest"]])
        XCTAssertEqual(typed.picked, [])
        XCTAssertEqual(typed.typed, "Confirm it, and file the rest")
        XCTAssertEqual(ReviewRecords.answer(to: q, in: [:]).picked, [])
    }

    func testTheDecisionCards() {
        XCTAssertEqual(ReviewRecords.evidence(revision: "2", at: at, now: now),
                       ReviewRecordFooter(mark: .done, line: "Confirmed done by you · 14:06", detail: "Recorded on rev 2"))
        XCTAssertEqual(ReviewRecords.ownerConfirmed(at: at, reportedAt: "2026-10-15T13:58:00Z", now: now).detail,
                       "Recorded on the 13:58 report")
        XCTAssertNil(ReviewRecords.ownerConfirmed(at: at, reportedAt: nil, now: now).detail,
                     "a report that did not say when leaves the line out")
        XCTAssertEqual(ReviewRecords.started(criteria: 3, seal: "a1b2c3", at: at, now: now),
                       ReviewRecordFooter(mark: .done, line: "Started by you · 14:06",
                                          detail: "On 3 criteria at seal a1b2c3"))
        XCTAssertEqual(ReviewRecords.confirmed(criteria: 5, seal: "d4e5f6", changes: "1 new, 1 stricter", at: at, now: now),
                       ReviewRecordFooter(mark: .done, line: "Confirmed by you · 14:06",
                                          detail: "5 criteria at seal d4e5f6 — 1 new, 1 stricter"))
        XCTAssertEqual(ReviewRecords.confirmed(criteria: 1, seal: "d4e5f6", changes: nil, at: at, now: now).detail,
                       "1 criterion at seal d4e5f6")
        XCTAssertEqual(ReviewRecords.criteriaDecision(approved: true, baseSeal: "d4e5f6", resultingSeal: "e7f8a9",
                                                      at: at, now: now),
                       ReviewRecordFooter(mark: .done, line: "Approved by you · 14:06",
                                          detail: "Re-sealed: d4e5f6 → e7f8a9"))
        XCTAssertEqual(ReviewRecords.criteriaDecision(approved: false, baseSeal: "d4e5f6", resultingSeal: nil,
                                                      at: at, now: now),
                       ReviewRecordFooter(mark: .refused, line: "Refused by you · 14:06",
                                          detail: "The criteria stay at seal d4e5f6"))
    }
}

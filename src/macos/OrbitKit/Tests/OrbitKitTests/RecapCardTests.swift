import XCTest
@testable import OrbitKit

/// The conversation's Recap card (`RecapCard`): when a conversation is at rest for it, what it says
/// about when the recap was written, what a refresh that wrote nothing says, and the row it is in
/// the transcript. Ports the web's `SessionRecapCard.test.tsx` and `WorkspaceView.recapRow.test.tsx`
/// cases, and holds the words to the web file they came from.
final class RecapCardTests: XCTestCase {
    private let recap = "Moved the recap onto the list row; the three states are covered by tests."

    private func session(status: RunStatus = .awaitingInput, lifecycleState: SessionLifecycleState? = nil,
                         pendingApprovals: Int? = nil, runningBgCount: Int? = nil,
                         runningSubagentCount: Int? = nil, engineTurnActive: Bool? = nil,
                         recapText: String? = "Moved the recap onto the list row; the three states are covered by tests.",
                         recapAt: String? = nil) -> Session {
        Session(id: "s", title: "t", status: status, lifecycleState: lifecycleState, agentId: nil,
                assignedRunnerId: nil, pendingApprovals: pendingApprovals, branch: nil, updatedAt: nil,
                lastAssistantText: "Committed the row change.", recapText: recapText, recapAt: recapAt,
                runningBgCount: runningBgCount, runningSubagentCount: runningSubagentCount,
                engineTurnActive: engineTurnActive)
    }

    func testAConversationAtRestEndsInItsRecap() {
        XCTAssertEqual(RecapCard.make(for: session(), recaps: true), RecapCard(text: recap, when: nil))
        // A process it left running, or a run that ended, is no turn of its own: still at rest.
        XCTAssertNotNil(RecapCard.make(for: session(runningBgCount: 1), recaps: true))
        XCTAssertNotNil(RecapCard.make(for: session(status: .succeeded), recaps: true))
    }

    func testWorkInHandKeepsTheCardAway() {
        XCTAssertNil(RecapCard.make(for: session(status: .running), recaps: true), "generating")
        XCTAssertNil(RecapCard.make(for: session(engineTurnActive: true), recaps: true), "a turn it started itself")
        XCTAssertNil(RecapCard.make(for: session(status: .pending), recaps: true), "queued")
        XCTAssertNil(RecapCard.make(for: session(pendingApprovals: 1), recaps: true), "waiting on you")
        XCTAssertNil(RecapCard.make(for: session(runningSubagentCount: 1), recaps: true), "an agent it started")
    }

    func testNoCardWithoutARecapOrWithRecapsOff() {
        XCTAssertNil(RecapCard.make(for: session(recapText: nil), recaps: true))
        XCTAssertNil(RecapCard.make(for: session(recapText: "   "), recaps: true))
        XCTAssertNil(RecapCard.make(for: session(), recaps: false), "the Session recaps switch governs the card too")
        XCTAssertNil(RecapCard.make(for: session(lifecycleState: .trash), recaps: true))
    }

    func testWhenSaysAClockTimeTodayAndTheDateOnAnotherDay() {
        let clock = DateFormatter(); clock.timeStyle = .short
        let day = DateFormatter(); day.dateFormat = "EEE, MMM d"
        let now = Date()
        XCTAssertEqual(RecapCard.whenWritten(ISO8601DateFormatter().string(from: now), now: now),
                       clock.string(from: now))
        let old = Date(timeIntervalSinceNow: -3 * 86_400)
        XCTAssertEqual(RecapCard.whenWritten(ISO8601DateFormatter().string(from: old), now: now),
                       "\(day.string(from: old)), \(clock.string(from: old))")
        XCTAssertNil(RecapCard.whenWritten(nil))
        XCTAssertNil(RecapCard.whenWritten("not a time"))
        XCTAssertEqual(RecapCard.make(for: session(recapAt: ISO8601DateFormatter().string(from: now)),
                                      recaps: true, now: now)?.when, clock.string(from: now))
    }

    func testARefreshThatWroteNothingSaysWhy() {
        XCTAssertEqual(RecapCard.notice(for: "no-events"), .init(text: RecapCard.upToDate, failed: false))
        XCTAssertEqual(RecapCard.notice(for: "too-few-events"), .init(text: RecapCard.tooLittle, failed: false))
        XCTAssertEqual(RecapCard.notice(for: "no-key"), .init(text: RecapCard.unavailable, failed: false))
        XCTAssertEqual(RecapCard.notice(for: "disabled"), .init(text: RecapCard.unavailable, failed: false))
        XCTAssertEqual(RecapCard.notice(for: "llm-failed"), .init(text: RecapCard.failed, failed: true))
        XCTAssertEqual(RecapCard.notice(for: "error"), .init(text: RecapCard.failed, failed: true))
        XCTAssertNil(RecapCard.notice(for: "cas-lost"), "another pass wrote first: reading again shows its line")
    }

    /// The card is the conversation's last row: under everything it said, above the questions still
    /// trailing at the tail, and absent from a window with nothing loaded to sum up.
    func testTheRecapRowClosesTheConversationAboveTheTrailingQuestions() {
        var state = TranscriptState()
        state.items = [.error(id: "e1", message: "Committed the row change.")]
        let card = RecapCard(text: recap, when: "5:38 PM")
        let question = DeliveredDecisionCard(kind: .coordinatorQuestion(itemID: "q1"), placement: .onArrival(afterItemID: nil))
        let rows = TranscriptRows.build(state: state, statusCards: [], canPageOlder: false,
                                        showWorkingIndicator: false, decisionCards: [question], recap: card)
        XCTAssertEqual(rows.map(\.id), ["e1", "session-recap", question.id, "transcript-bottom"])

        XCTAssertFalse(TranscriptRows.build(state: TranscriptState(), statusCards: [], canPageOlder: false,
                                            showWorkingIndicator: false, recap: card).contains { $0.id == "session-recap" })
        XCTAssertFalse(TranscriptRows.build(state: state, statusCards: [], canPageOlder: false,
                                            showWorkingIndicator: false).contains { $0.id == "session-recap" })
    }

    /// The card's words are the web card's (`RECAP_CARD_COPY` in components/SessionRecapCard.tsx).
    func testTheWordsAreTheWebCardsWords() throws {
        let web = try webSource("src/web/src/components/SessionRecapCard.tsx")
        XCTAssertTrue(web.contains("word: '\(RecapCard.word)'"))
        XCTAssertTrue(web.contains("refresh: '\(RecapCard.refresh)'"))
        XCTAssertTrue(web.contains("upToDate: '\(RecapCard.upToDate)'"))
        XCTAssertTrue(web.contains("tooLittle: \"\(RecapCard.tooLittle)\""))
        XCTAssertTrue(web.contains("unavailable: \"\(RecapCard.unavailable)\""))
        XCTAssertTrue(web.contains("failed: \"\(RecapCard.failed)\""))
    }

    private func webSource(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(relative) was not found above this test file; the web card moved, so move this check with it")
        return ""
    }
}

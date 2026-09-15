import XCTest
@testable import OrbitKit

/// What the folded row of a stretch of reasoning says. Web twin: `thinkingDraft.test.ts`.
final class ThinkingSummaryTests: XCTestCase {
    func testDurationReadsAsSecondsUnderAMinuteAndMinutesPastIt() {
        XCTAssertEqual(ThinkingSummary.duration(12), "12s")
        XCTAssertEqual(ThinkingSummary.duration(107), "1m 47s")
        XCTAssertEqual(ThinkingSummary.duration(120), "2m")
    }

    func testDurationNeverClaimsABlockTookNoTime() {
        // Rounding a 400ms block to "0s" reads as "it did not happen".
        XCTAssertEqual(ThinkingSummary.duration(0.4), "1s")
    }

    func testSizeIsStatedInCharactersSinceReasoningIsAsOftenCJK() {
        XCTAssertEqual(ThinkingSummary.size(445), "445 chars")
        XCTAssertEqual(ThinkingSummary.size(2300), "2.3k chars")
        XCTAssertEqual(ThinkingSummary.size(21_000), "21k chars")
    }

    func testElapsedParsesTheRunnersFractionalStamps() {
        // What the server actually broadcasts: `new Date().toISOString()`.
        let seconds = ThinkingSummary.elapsed(from: "2026-09-15T17:51:52.123Z", to: "2026-09-15T17:52:04.123Z")
        XCTAssertEqual(seconds ?? 0, 12, accuracy: 0.001)
    }

    func testElapsedAlsoParsesAStampWithoutFractionalSeconds() {
        let seconds = ThinkingSummary.elapsed(from: "2026-09-15T17:51:52Z", to: "2026-09-15T17:51:59Z")
        XCTAssertEqual(seconds ?? 0, 7, accuracy: 0.001)
    }

    func testElapsedDeclinesToGuessWhenTheClockIsMissingOrDoesNotAdvance() {
        // A transcript recorded before the runner stamped these, or a page that opened mid-block.
        XCTAssertNil(ThinkingSummary.elapsed(from: nil, to: "2026-09-15T17:52:04.123Z"))
        XCTAssertNil(ThinkingSummary.elapsed(from: "2026-09-15T17:51:52.123Z", to: nil))
        XCTAssertNil(ThinkingSummary.elapsed(from: "not a date", to: "2026-09-15T17:52:04.123Z"))
        XCTAssertNil(ThinkingSummary.elapsed(from: "2026-09-15T17:52:04.123Z", to: "2026-09-15T17:51:52.123Z"))
    }

    func testSettledLabelStatesDurationBlocksAndSize() {
        let label = ThinkingSummary.settledLabel(
            chars: 21_000, blocks: 3,
            startedTs: "2026-09-15T17:51:52.000Z", finishedTs: "2026-09-15T17:53:39.000Z")

        XCTAssertEqual(label, "Thought for 1m 47s · 3 blocks · 21k chars")
    }

    func testSettledLabelOmitsTheBlockCountWhenNothingWasFolded() {
        let label = ThinkingSummary.settledLabel(
            chars: 2300, blocks: 1,
            startedTs: "2026-09-15T17:51:52.000Z", finishedTs: "2026-09-15T17:52:04.000Z")

        XCTAssertEqual(label, "Thought for 12s · 2.3k chars")
    }

    func testSettledLabelStatesSizeAloneWhenNoClockSurvived() {
        // A transcript rehydrated from disk, or one recorded by a runner that stamped no `ts`:
        // size still answers "is opening this worth it".
        XCTAssertEqual(
            ThinkingSummary.settledLabel(chars: 872, blocks: 1, startedTs: nil, finishedTs: nil),
            "Thought · 872 chars")
    }
}

import XCTest
@testable import OrbitKit

/// How a turn's reasoning folds into the transcript. Web twin: `Transcript.thinking.test.tsx`.
///
/// Measured on this deployment: a DeepSeek turn closes 10 thinking blocks at the median, 51 at
/// p90 and 115 at the worst. A row each was a stack of identical "Thinking" lines.
final class TranscriptThinkingTests: XCTestCase {
    private func thinkingRows(_ r: TranscriptReducer) -> [ThinkingBlock] {
        r.state.items.compactMap { if case .thinking(let b) = $0 { return b } else { return nil } }
    }

    private func delta(_ text: String, ts: String? = nil) -> RunEvent {
        RunEvent(seq: 0, type: .thinkingDelta, ts: ts, payload: .object(["delta": .string(text)]))
    }

    private func settle(_ text: String, seq: Int, ts: String? = nil) -> RunEvent {
        RunEvent(seq: seq, type: .thinking, ts: ts, payload: .object(["text": .string(text)]))
    }

    private func toolCall(seq: Int) -> RunEvent {
        RunEvent(seq: seq, type: .toolUse,
                 payload: .object(["id": .string("t\(seq)"), "name": .string("Bash"),
                                   "input": .object(["command": .string("nvidia-smi")])]))
    }

    func testAdjacentBlocksFoldIntoOneRowThatCountsThem() {
        var r = TranscriptReducer()
        r.apply(settle("first", seq: 1))
        r.apply(settle("second", seq: 2))
        r.apply(settle("third", seq: 3))

        let rows = thinkingRows(r)
        XCTAssertEqual(rows.count, 1, "three adjacent stretches are one row")
        XCTAssertEqual(rows.first?.blocks, 3)
        XCTAssertEqual(rows.first?.text, "first\n\nsecond\n\nthird")
        XCTAssertEqual(rows.first?.seq, 3, "the row covers through the last block it folded")
    }

    func testABlockEitherSideOfAToolCallKeepsItsOwnRow() {
        // Those two are not one thought: each explains the call it sits against.
        var r = TranscriptReducer()
        r.apply(settle("why I am about to run this", seq: 1))
        r.apply(toolCall(seq: 2))
        r.apply(settle("what the output means", seq: 3))

        let rows = thinkingRows(r)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows.map(\.blocks), [1, 1])
    }

    func testStreamedReasoningSurvivesABlockThatClosesEmpty() {
        // Claude closes every block with {"thinking":"","signature":"…"} — 84% of the durable rows
        // on this deployment carry no text. The reducer keeps what it streamed.
        var r = TranscriptReducer()
        r.apply(delta("weighing whether to go straight to L3"))
        r.apply(settle("", seq: 1))

        XCTAssertEqual(thinkingRows(r).first?.text, "weighing whether to go straight to L3")
    }

    func testAnEmptyBlockWithNothingStreamedDrawsNoRow() {
        // A reload replays durable events with no deltas behind them; inventing a row there is
        // what would paper a transcript with blank "Thinking" lines.
        var r = TranscriptReducer()
        r.apply(settle("", seq: 1))

        XCTAssertTrue(thinkingRows(r).isEmpty)
    }

    func testTheRowCarriesTheClockThatMeasuredIt() {
        var r = TranscriptReducer()
        r.apply(delta("hmm", ts: "2026-09-15T17:51:52.000Z"))
        r.apply(settle("hmm, yes", seq: 1, ts: "2026-09-15T17:52:04.000Z"))

        let row = thinkingRows(r).first
        XCTAssertEqual(row?.startedTs, "2026-09-15T17:51:52.000Z")
        XCTAssertEqual(row?.finishedTs, "2026-09-15T17:52:04.000Z")
        XCTAssertEqual(
            ThinkingSummary.settledLabel(chars: row?.text.count ?? 0, blocks: row?.blocks ?? 1,
                                         startedTs: row?.startedTs, finishedTs: row?.finishedTs),
            "Thought for 12s · 8 chars")
    }

    func testAFoldedRowSpansFromTheFirstStartToTheLastFinish() {
        var r = TranscriptReducer()
        r.apply(delta("a", ts: "2026-09-15T17:51:52.000Z"))
        r.apply(settle("first", seq: 1, ts: "2026-09-15T17:52:04.000Z"))
        r.apply(settle("second", seq: 2, ts: "2026-09-15T17:53:39.000Z"))

        let row = thinkingRows(r).first
        XCTAssertEqual(row?.startedTs, "2026-09-15T17:51:52.000Z", "kept from the stretch that began it")
        XCTAssertEqual(row?.finishedTs, "2026-09-15T17:53:39.000Z", "advanced to the one that ended it")
    }

    func testFoldingLeavesAStillOpenAssistantBubbleAddressable() {
        // The open-bubble cursors are item indices, and folding removes a row: a delta arriving
        // after it must still land in the bubble it belongs to, not in the wrong one.
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("Hel")])))
        r.apply(settle("first", seq: 1))
        r.apply(settle("second", seq: 2))
        r.apply(RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("lo")])))

        let assistant = r.state.items.compactMap { if case .assistant(let b) = $0 { return b } else { return nil } }
        XCTAssertEqual(assistant.first?.displayText, "Hello", "the second delta found the same bubble")
    }

    func testAPersistedBlockFromBeforeTheseFieldsStillRehydrates() {
        // TranscriptStore discards a snapshot it cannot decode, taking the whole cached session
        // with it — so the new keys have to default rather than fail.
        let old = #"{"id":"t1","text":"reasoning","streamingText":"","seq":7}"#.data(using: .utf8)!

        let block = try? JSONDecoder().decode(ThinkingBlock.self, from: old)

        XCTAssertEqual(block?.text, "reasoning")
        XCTAssertEqual(block?.blocks, 1)
        XCTAssertNil(block?.startedTs)
    }
}

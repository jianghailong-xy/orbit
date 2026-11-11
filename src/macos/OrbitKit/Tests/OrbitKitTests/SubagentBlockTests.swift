import XCTest
@testable import OrbitKit

/// A `delegate` call's transcript block (docs/subagent-design.md §6.4, board 03): the folded row, its
/// grey second line, the Background mark, and the opened block's Why. Pinning the row model here keeps
/// iOS and macOS drawing the same words as each other and as web's block.
final class SubagentBlockTests: XCTestCase {
    private func obj(_ d: [String: JSONValue]) -> JSONValue { .object(d) }

    private func run(
        type: String = "explore", background: Bool = false, status: String = "DONE",
        level: String? = "S", model: String? = "deepseek-chat", modelLabel: String? = "DeepSeek Chat",
        effort: String? = nil, reasons: [String] = [], costUsd: Double = 0.21, resultSummary: String? = nil,
        createdAt: String = "2026-11-11T08:00:00.000Z", endedAt: String? = "2026-11-11T08:00:41.000Z"
    ) -> SubagentRunView {
        SubagentRunView(toolUseId: "toolu_sa", type: type, background: background, status: status,
                        level: level, model: model, modelLabel: modelLabel, effort: effort,
                        reasons: reasons, costUsd: costUsd, resultSummary: resultSummary,
                        createdAt: createdAt, endedAt: endedAt)
    }

    private let call = JSONValue.object([
        "description": .string("Find every caller of pollQuota"),
        "type": .string("explore"),
        "prompt": .string("Find every caller."),
    ])

    // MARK: - the folded first line

    func testTheFoldedRowNamesTheSubAgentAndItsDescription() {
        let d = ToolDisplay.describe(name: SubagentBlock.toolName, input: call, status: .ok, id: "toolu_sa")
        XCTAssertEqual(d.label, "SubAgent")
        XCTAssertEqual(d.summary, "Find every caller of pollQuota")
        XCTAssertEqual(d.tone, .agent)
        XCTAssertEqual(d.symbol, "sparkle")
        XCTAssertFalse(d.hasBody, "the block opens to the child's steps, not to the delegate prompt")
    }

    // MARK: - the second line

    func testTheSecondLineCarriesTypeTierModelDurationAndCost() {
        let block = SubagentBlock.describe(input: call, run: run(), status: .ok)
        XCTAssertEqual(block.detailLine, "explore · S · DeepSeek Chat · 41s · $0.21")
        XCTAssertEqual(block.type, "explore")
        XCTAssertFalse(block.background)
        XCTAssertFalse(block.running)
    }

    func testARunningRunHasNoDurationOrCostYet() {
        let block = SubagentBlock.describe(
            input: call,
            run: run(status: "RUNNING", endedAt: nil),
            status: .ok)
        XCTAssertEqual(block.detailLine, "explore · S · DeepSeek Chat")
        XCTAssertTrue(block.running)
    }

    func testACostUnderACentReadsAsLessThanACent() {
        let block = SubagentBlock.describe(input: call, run: run(costUsd: 0.004), status: .ok)
        XCTAssertEqual(block.detailLine, "explore · S · DeepSeek Chat · 41s · <$0.01")
    }

    func testAZeroCostAlsoReadsAsLessThanACent() {
        let block = SubagentBlock.describe(input: call, run: run(costUsd: 0), status: .ok)
        XCTAssertEqual(block.detailLine, "explore · S · DeepSeek Chat · 41s · <$0.01")
    }

    func testTheModelFallsBackToTheIdWhenTheTableNamesNone() {
        let block = SubagentBlock.describe(input: call, run: run(modelLabel: nil), status: .ok)
        XCTAssertEqual(block.detailLine, "explore · S · deepseek-chat · 41s · $0.21")
    }

    func testTheCallSaysWhatItKnowsBeforeARunIsRead() {
        // The row exists the moment the call does; the run row arrives a beat later.
        let block = SubagentBlock.describe(input: call, run: nil, status: .running)
        XCTAssertEqual(block.detailLine, "explore")
        XCTAssertTrue(block.running)
        XCTAssertNil(block.why)
    }

    func testATypeTheCallOmittedDefaultsToGeneral() {
        let block = SubagentBlock.describe(input: .object(["description": .string("Write the spec")]),
                                           run: nil, status: .running)
        XCTAssertEqual(block.type, "general")
        XCTAssertEqual(block.detailLine, "general")
    }

    // MARK: - Background

    func testABackgroundBlockPutsBackgroundInTheTypesPlaceAndAddsNoDuration() {
        let input = obj(["description": .string("Write the backoff spec"),
                         "type": .string("general"),
                         "background": .bool(true)])
        let block = SubagentBlock.describe(
            input: input,
            run: run(type: "general", background: true, status: "RUNNING", level: "M",
                     model: "gpt-5.6-sol", modelLabel: "GPT-5.6 Sol", endedAt: nil),
            status: .ok)
        XCTAssertTrue(block.background)
        XCTAssertTrue(block.running)
        XCTAssertEqual(block.detailLine, "Background · M · GPT-5.6 Sol")
        XCTAssertEqual(block.type, "general", "the type is still known; the mock draws Background in its place")
    }

    func testTheRunsBackgroundFlagWinsOverTheCallsInput() {
        // A definition file may default is_background: the call's input says nothing, the run says why.
        let block = SubagentBlock.describe(input: call, run: run(background: true), status: .ok)
        XCTAssertTrue(block.background)
        XCTAssertTrue(block.detailLine?.hasPrefix("Background · ") == true, "\(block.detailLine ?? "nil")")
    }

    func testAFinishedBackgroundBlockAddsItsDurationAndCost() {
        let input = obj(["description": .string("Write the backoff spec"),
                         "type": .string("general"),
                         "background": .bool(true)])
        let block = SubagentBlock.describe(
            input: input,
            run: run(type: "general", background: true, status: "DONE", level: "M",
                     model: "gpt-5.6-sol", modelLabel: "GPT-5.6 Sol", costUsd: 0.03),
            status: .ok)
        XCTAssertFalse(block.running)
        XCTAssertEqual(block.detailLine, "Background · M · GPT-5.6 Sol · 41s · $0.03")
    }

    // MARK: - Why

    func testTheOpenedBlockWhyJoinsTheRoutersReasons() {
        let block = SubagentBlock.describe(
            input: call,
            run: run(reasons: ["Tier S, set by the built-in explore default",
                               "Optimize For: Cost", "Cheapest of 5 providers with quota"]),
            status: .ok)
        XCTAssertEqual(block.why,
                       "Tier S, set by the built-in explore default · Optimize For: Cost"
                       + " · Cheapest of 5 providers with quota")
    }

    func testAWhyWithNoReasonsIsAbsent() {
        XCTAssertNil(SubagentBlock.describe(input: call, run: run(), status: .ok).why)
    }

    // MARK: - the result

    func testAForegroundResultCarriesTheSubAgentsText() {
        let result = #"{"runId":"sa_1","status":"DONE","result":"Three callers, all in quota/.","costUsd":0.21}"#
        XCTAssertEqual(SubagentResult.text(callResult: result, run: run()),
                       "Three callers, all in quota/.")
    }

    func testABackgroundReceiptIsHiddenUntilTheRunHasAResult() {
        let receipt = #"{"runId":"sa_2","status":"running"}"#
        XCTAssertNil(SubagentResult.text(callResult: receipt, run: run(background: true,
                                                                       status: "RUNNING", endedAt: nil)))
        XCTAssertEqual(SubagentResult.text(callResult: receipt,
                                           run: run(background: true, resultSummary: "The spec is written.")),
                       "The spec is written.")
    }

    func testPlainTextIsShownAsItCame() {
        XCTAssertEqual(SubagentResult.text(callResult: "not json", run: nil), "not json")
        XCTAssertNil(SubagentResult.text(callResult: "  ", run: nil))
    }

    // MARK: - re-reading the runs

    func testTheSignatureMovesWhenADelegateCallStartsOrEnds() {
        func card(_ status: ToolStatus, resultSeq: Int?) -> TranscriptItem {
            .toolCall(ToolCard(id: "toolu_sa", name: SubagentBlock.toolName,
                               input: .object([:]), result: nil, status: status,
                               inputSeq: 1, resultSeq: resultSeq))
        }
        let started = SubagentRuns.signature(items: [card(.running, resultSeq: nil)], background: [])
        XCTAssertEqual(started, "toolu_sa:running:-")
        let ended = SubagentRuns.signature(items: [card(.ok, resultSeq: 9)], background: [])
        XCTAssertNotEqual(started, ended)
        XCTAssertEqual(SubagentRuns.signature(items: [], background: []), "",
                       "a session that never delegated reads nothing")
    }

    // MARK: - nesting

    func testADelegateCallIsItsOwnRowNotFoldedIntoAStepsLine() {
        // A steps line stands in for calls with nothing of their own to draw; a SubAgent's block
        // carries its steps and Why, so it is drawn where it happened (web: isGroupableTool).
        var state = TranscriptState()
        state.items = [
            .assistant(AssistantBubble(id: "a1", text: "I'll split this.", streamingText: "",
                                       seq: 2, turnId: nil, ts: nil)),
            .toolCall(ToolCard(id: "toolu_sa", name: SubagentBlock.toolName, input: .object([:]),
                               result: nil, status: .running, inputSeq: 3)),
        ]
        let rows = TranscriptRows.build(state: state, statusCards: [], canPageOlder: false,
                                        showWorkingIndicator: false)
        XCTAssertFalse(rows.contains { if case .steps = $0 { return true }; return false }, "\(rows)")
        XCTAssertTrue(rows.contains {
            if case .item(.toolCall(let card)) = $0 { return card.id == "toolu_sa" }
            return false
        }, "\(rows)")
    }

    func testADelegatesStepsNestUnderItsCallLikeAnAgentCard() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .toolUse, ts: "2026-11-11T08:00:00.000Z", turnId: "t1",
                         payload: .object(["id": .string("toolu_sa"),
                                           "name": .string(SubagentBlock.toolName),
                                           "input": .object(["description": .string("Find callers")])])))
        r.apply(RunEvent(seq: 2, type: .toolResult, ts: "2026-11-11T08:00:01.000Z", turnId: "t1",
                         payload: .object(["toolUseId": .string("toolu_sa"),
                                           "content": .string(#"{"runId":"sa_1","status":"DONE","result":"ok"}"#)])))
        r.apply(RunEvent(seq: 3, type: .toolUse, ts: "2026-11-11T08:00:02.000Z", turnId: nil,
                         payload: .object(["id": .string("toolu_child"), "name": .string("Grep"),
                                           "input": .object(["pattern": .string("pollQuota")]),
                                           "parentToolUseId": .string("toolu_sa")])))
        r.apply(RunEvent(seq: 4, type: .assistant, ts: "2026-11-11T08:00:03.000Z", turnId: nil,
                         payload: .object(["text": .string("Three callers, all in quota/."),
                                           "parentToolUseId": .string("toolu_sa")])))

        XCTAssertEqual(r.state.items.count, 1, "the conversation is the parent's own call")
        let sub = r.state.subagentItems["toolu_sa"] ?? []
        XCTAssertEqual(sub.count, 2, "\(sub)")
        guard case .toolCall(let grep) = sub[0], case .assistant(let words) = sub[1] else {
            return XCTFail("sub = \(sub)")
        }
        XCTAssertEqual(grep.name, "Grep")
        XCTAssertEqual(words.text, "Three callers, all in quota/.")
    }
}

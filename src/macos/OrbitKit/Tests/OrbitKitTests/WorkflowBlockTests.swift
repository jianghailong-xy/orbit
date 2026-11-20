import XCTest
@testable import OrbitKit

/// An Orbit workflow as iOS and macOS draw it (board docs/mocks/subagent-workflow part 4): the folded
/// block's three lines, the calls page by phase, and the finished strip of its wake turn.
final class WorkflowBlockTests: XCTestCase {
    private let wf = "toolu_wf"

    private func workflowCard(status: ToolStatus = .ok) -> ToolCard {
        ToolCard(id: wf, name: WorkflowBlock.toolName,
                 input: .object(["description": .string("Review the scheduler diff"),
                                 "script": .string("export const meta = { name: 'review-changes', phases: [] }")]),
                 result: #"{"workflowRunId":"w1","status":"running"}"#, status: status)
    }

    private func call(_ index: Int, label: String, phase: String, ended: Bool, error: Bool = false,
                      result: String? = nil) -> TranscriptItem {
        .toolCall(ToolCard(id: "\(wf)#\(index)", name: SubagentBlock.toolName,
                           input: .object(["description": .string(label), "prompt": .string("…"),
                                           "workflow_phase": .string(phase)]),
                           result: ended ? (result.map { #"{"status":"DONE","result":"\#($0)"}"# } ?? "{}") : nil,
                           status: ended ? (error ? .error : .ok) : .running))
    }

    private func run(_ index: Int, label: String, phase: String, status: String, cost: Double = 0.05,
                     result: String? = nil) -> SubagentRunView {
        SubagentRunView(toolUseId: "\(wf)#\(index)", type: "general", background: false, status: status,
                        costUsd: cost, resultSummary: result, createdAt: "2026-11-20T08:00:00.000Z",
                        endedAt: status == "RUNNING" ? nil : "2026-11-20T08:01:00.000Z",
                        workflowRunId: "w1", callIndex: index, label: label, phase: phase)
    }

    private func view(status: String = "RUNNING", done: Int = 6, failed: Int = 1, cost: Double = 0.84,
                      limit: Double? = nil, error: String? = nil, endedAt: String? = nil) -> WorkflowRunView {
        WorkflowRunView(id: "w1", toolUseId: wf, name: "review-changes", description: "Review the scheduler diff",
                        phases: ["Review", "Verify"], status: status, callsDone: done, callsFailed: failed,
                        costUsd: cost, maxCostUsd: limit, error: error, createdAt: "2026-11-20T08:00:00.000Z",
                        endedAt: endedAt)
    }

    /// The board's running workflow: four reviews done, then eight verifies — two done, one failed,
    /// three running, two queued (no run yet).
    private func boardState() -> (nested: [TranscriptItem], runs: [String: SubagentRunView]) {
        var nested: [TranscriptItem] = []
        var runs: [String: SubagentRunView] = [:]
        for (i, label) in ["review:correctness", "review:timezones", "review:concurrency", "review:migrations"].enumerated() {
            nested.append(call(i, label: label, phase: "Review", ended: true, result: "2 findings"))
            runs["\(wf)#\(i)"] = run(i, label: label, phase: "Review", status: "DONE", result: "2 findings")
        }
        let verifies: [(String, String?)] = [("DONE", "Real"), ("DONE", "Real"), ("FAILED", nil),
                                             ("RUNNING", nil), ("RUNNING", nil), ("RUNNING", nil), ("", nil), ("", nil)]
        for (j, (status, result)) in verifies.enumerated() {
            let i = 4 + j
            nested.append(call(i, label: "verify", phase: "Verify", ended: !status.isEmpty && status != "RUNNING",
                               error: status == "FAILED", result: result))
            if !status.isEmpty { runs["\(wf)#\(i)"] = run(i, label: "verify", phase: "Verify", status: status, result: result) }
        }
        return (nested, runs)
    }

    // MARK: - the folded block

    func testTheRunningBlockSaysPhaseCountAndCostThenRunningAndQueued() {
        let (nested, runs) = boardState()
        let block = WorkflowBlock.describe(card: workflowCard(), workflow: view(), nested: nested, run: { runs[$0] })
        XCTAssertEqual(WorkflowBlock.label, "Workflow")
        XCTAssertEqual(block.title, "Review the scheduler diff")
        XCTAssertEqual(block.state, .running)
        XCTAssertEqual(block.progress, "Verify · 7 of 12 · $0.84")
        XCTAssertEqual(block.live, "3 running, 2 queued")
        XCTAssertNil(block.error)
    }

    func testTheCostReadsAsOfTheLimitOnlyWhenTheCallSetOne() {
        let (nested, runs) = boardState()
        let limited = WorkflowBlock.describe(card: workflowCard(), workflow: view(limit: 5), nested: nested, run: { runs[$0] })
        XCTAssertEqual(limited.progress, "Verify · 7 of 12 · $0.84 of $5.00")
    }

    func testAFinishedBlockDropsThePhaseAndTheLiveLine() {
        let (nested, _) = boardState()
        let ended = view(status: "DONE", done: 11, failed: 1, cost: 1.37, endedAt: "2026-11-20T08:06:40.000Z")
        let done: [String: SubagentRunView] = Dictionary(uniqueKeysWithValues: (0..<12).map { i in
            ("\(wf)#\(i)", run(i, label: i < 4 ? "review" : "verify", phase: i < 4 ? "Review" : "Verify",
                               status: i == 6 ? "FAILED" : "DONE"))
        })
        let block = WorkflowBlock.describe(card: workflowCard(), workflow: ended, nested: nested, run: { done[$0] })
        XCTAssertEqual(block.state, .done)
        XCTAssertEqual(block.progress, "12 of 12 · $1.37")
        XCTAssertNil(block.live)
        XCTAssertFalse(block.sections.contains { $0.more != nil }, "a finished workflow folds no phase")
    }

    func testAWorkflowThatDidNotFinishSaysWhy() {
        let block = WorkflowBlock.describe(
            card: workflowCard(), workflow: view(status: "FAILED", done: 0, failed: 0, cost: 0,
                                                 error: "TypeError: args.routes is undefined (line 4)"),
            nested: [], run: { _ in nil })
        XCTAssertEqual(block.state, .failed)
        XCTAssertEqual(block.progress, "0 of 0 · $0.00")
        XCTAssertEqual(block.error, "TypeError: args.routes is undefined (line 4)")
    }

    func testBeforeTheServerIsReadTheBlockStillDrawsFromTheTranscript() {
        let (nested, runs) = boardState()
        let block = WorkflowBlock.describe(card: workflowCard(), workflow: nil, nested: nested, run: { runs[$0] },
                                           backgroundRunning: true)
        XCTAssertEqual(block.state, .running)
        XCTAssertEqual(block.progress, "Verify · 7 of 12 · $0.35", "the ended calls' spend, counted from their runs")
        let name = WorkflowBlock.describe(
            card: ToolCard(id: wf, name: WorkflowBlock.toolName,
                           input: .object(["script": .string("export const meta = { name: 'review-changes' }")]),
                           result: nil, status: .running),
            workflow: nil, nested: [], run: { _ in nil })
        XCTAssertEqual(name.title, "review-changes", "no description: the script's name")
    }

    // MARK: - the calls page

    func testTheCallsPageGroupsByPhaseWithCountsAndFoldsAnEndedPhase() {
        let (nested, runs) = boardState()
        let block = WorkflowBlock.describe(card: workflowCard(), workflow: view(), nested: nested, run: { runs[$0] })
        XCTAssertEqual(block.sections.map(\.title), ["Review", "Verify"])
        XCTAssertEqual(block.sections.map(\.header), ["Review · 4 done", "Verify · 3 done · 3 running · 2 queued"])
        let review = block.sections[0]
        XCTAssertEqual(review.shown, 2)
        XCTAssertEqual(review.more, "2 more")
        XCTAssertEqual(review.calls.first?.label, "review:correctness")
        XCTAssertEqual(review.calls.first?.result, "2 findings")
        let verify = block.sections[1]
        XCTAssertNil(verify.more)
        XCTAssertEqual(verify.calls.map(\.state), [.done, .done, .failed, .running, .running, .running, .queued, .queued])
        XCTAssertNil(verify.calls[3].result, "a running call has handed back nothing yet")
        XCTAssertEqual(verify.calls[0].card.id, "\(wf)#4", "a row opens its own delegate call's SubAgent detail")
    }

    func testCallsWithNoPhaseComeLastAndAPhaseNotInTheMetaFollowsTheMetasOrder() {
        let nested: [TranscriptItem] = [
            call(0, label: "loose", phase: "", ended: true),
            call(1, label: "extra", phase: "Extra", ended: true),
            call(2, label: "verify", phase: "Verify", ended: true),
        ]
        let block = WorkflowBlock.describe(card: workflowCard(), workflow: view(status: "DONE"), nested: nested,
                                           run: { _ in nil })
        XCTAssertEqual(block.sections.map(\.title), ["Verify", "Extra", nil])
        XCTAssertEqual(block.sections.last?.header, "1 done")
    }

    func testACallLeftQueuedWhenTheWorkflowEndedNeverRan() {
        let block = WorkflowBlock.describe(card: workflowCard(), workflow: view(status: "INTERRUPTED"),
                                           nested: [call(0, label: "verify", phase: "Verify", ended: false)],
                                           run: { _ in nil })
        XCTAssertEqual(block.state, .stopped)
        XCTAssertEqual(block.calls.map(\.state), [.failed])
    }

    // MARK: - what moves it

    func testTheSignatureMovesWhenACallIsMadeOpensOrEnds() {
        let card = TranscriptItem.toolCall(workflowCard())
        let none = WorkflowRuns.signature(items: [], nested: [:], background: [])
        XCTAssertEqual(none, "", "a session with no workflow reads nothing")
        let made = WorkflowRuns.signature(items: [card], nested: [wf: [call(0, label: "a", phase: "P", ended: false)]],
                                          background: [])
        let opened = WorkflowRuns.signature(
            items: [card],
            nested: [wf: [call(0, label: "a", phase: "P", ended: false)],
                     "\(wf)#0": [.assistant(AssistantBubble(id: "x", text: "hi", streamingText: ""))]],
            background: [])
        let ended = WorkflowRuns.signature(items: [card], nested: [wf: [call(0, label: "a", phase: "P", ended: true)]],
                                           background: [])
        XCTAssertEqual(Set([made, opened, ended]).count, 3)
    }

    // MARK: - the finished strip

    private let wake = """
    <orbit-workflow-finished>
      Workflow review-changes — Review the scheduler diff (run 4wRun0000000000000001) finished: DONE
        Calls done: 11, failed: 1. Cost: $1.37.
        Result: Returned 3 confirmed findings.
      The control plane opened this turn for it.
    </orbit-workflow-finished>
    """

    func testTheWakeBlockReadsAsOneRun() throws {
        let parsed = try XCTUnwrap(WorkflowFinishedText.parse(wake))
        XCTAssertEqual(parsed.runs, [WorkflowFinishedRun(
            runId: "4wRun0000000000000001", name: "review-changes", description: "Review the scheduler diff",
            status: "DONE", callsDone: 11, callsFailed: 1, costUsd: 1.37)])
        XCTAssertEqual(parsed.rest, "")
        XCTAssertNil(WorkflowFinishedText.parse("<orbit-subagent-finished>\n  x\n</orbit-subagent-finished>"))
        XCTAssertNil(WorkflowFinishedText.parse("<orbit-workflow-finished>\n  not a head\n</orbit-workflow-finished>"))
    }

    func testTheStripSaysCallsFailedTimeAndCost() throws {
        let run = try XCTUnwrap(WorkflowFinishedText.parse(wake)?.runs.first)
        let server = WorkflowRunView(id: "4wRun0000000000000001", toolUseId: wf, name: "review-changes",
                                     status: "DONE", callsDone: 11, callsFailed: 1, costUsd: 1.37,
                                     createdAt: "2026-11-20T08:00:00.000Z", endedAt: "2026-11-20T08:06:40.000Z")
        XCTAssertEqual(WorkflowFinishedStrip.workflow(for: run, in: [server]), server)
        let strip = WorkflowFinishedStrip.describe(run, workflow: server)
        XCTAssertEqual(strip.title, "Workflow finished")
        XCTAssertEqual(strip.line, "12 calls · 1 failed · 6m 40s · $1.37")
        XCTAssertFalse(strip.failed)
        // Before the server's view is read, the block's own numbers, and no time.
        XCTAssertEqual(WorkflowFinishedStrip.describe(run, workflow: nil).line, "12 calls · 1 failed · $1.37")
    }

    func testAnInterruptedWorkflowsStripSaysSo() throws {
        let note = """
        <orbit-workflow-finished>
          Workflow audit (run 4wRun0000000000000002) finished: INTERRUPTED
          The runner process stopped before the workflow finished. What its SubAgents changed so far is in the working tree, uncommitted. A workflow cannot be resumed yet: start one for the work that is left, or finish it yourself.
            Calls done: 1, failed: 0. Cost: $0.10.
          The control plane opened this turn for it.
        </orbit-workflow-finished>
        """
        let run = try XCTUnwrap(WorkflowFinishedText.parse(note)?.runs.first)
        XCTAssertNil(run.description)
        let strip = WorkflowFinishedStrip.describe(run, workflow: nil)
        XCTAssertEqual(strip.title, "Workflow interrupted")
        XCTAssertEqual(strip.line, "1 call · $0.10")
        XCTAssertTrue(strip.failed)
    }
}

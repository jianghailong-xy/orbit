import Foundation
import XCTest
@testable import OrbitKit

/// A background SubAgent is ONE card from start to end, as Claude Code's built-in Agent is (board
/// docs/mocks/subagent-card-and-end-line, approved 2026-11-20): the card's row says how it ended, the line
/// under the folded row becomes the ending, and the opened card closes on an end block. The turn the
/// control plane opened for the end draws nothing: no line, no From Orbit line, no bubble.
///
/// Web parity: `Transcript.subagentEnd.test.tsx`, case for case. The blocks are the web's fixtures
/// (`subagentFinished.fixtures.ts`), read from that file so both ends read the same bytes.
final class SubagentCardEndTests: XCTestCase {
    private static let fixturesPath = "src/web/src/lib/subagentFinished.fixtures.ts"
    private static let ts = "2026-11-15T16:30:00.000Z"
    private static let ended = "2026-11-15T16:29:00.000Z"
    private static let files = [
        "src/apiserver/src/tasks/model-routing.ts",
        "src/apiserver/src/tasks/task-route-decision.ts",
        "src/web/src/components/TaskDetailPanel.modelRouting.test.tsx",
        "src/web/src/components/a.ts",
        "src/web/src/components/b.ts",
    ]
    /// The runs the fixtures' blocks name, by the fixture.
    private static let runOf: [String: (runId: String, status: String, description: String)] = [
        "SUBAGENT_DONE": ("34y5NxcqKYA179mC04VUB", "DONE", "Deploy 6bb50a957 to production"),
        "SUBAGENT_FAILED": ("34y5PfailRUNid0000001", "FAILED", "Write the poller spec"),
        "SUBAGENT_STOPPED": ("34y5PstopRUNid0000002", "STOPPED", "Sweep stale worktrees"),
        "SUBAGENT_INTERRUPTED": ("34y5PintrRUNid0000003", "INTERRUPTED", "Port the retry to the Go runner"),
    ]
    private static let job = [
        "<background-job-wake>",
        "  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:",
        "    bgj_13c53745a88a｜job｜make test｜unit tests",
        "      ended｜completed｜exit code 0",
        "      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–10",
        "      (no output)",
        "  The control plane recorded this for you; the user did not say it.",
        "</background-job-wake>",
    ].joined(separator: "\n")

    private static var cached: [String: String]?

    private func block(_ name: String) throws -> String {
        if Self.cached == nil {
            var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            var source: String?
            for _ in 0..<12 {
                let url = dir.appendingPathComponent(Self.fixturesPath)
                if FileManager.default.fileExists(atPath: url.path) {
                    source = try String(contentsOf: url, encoding: .utf8)
                    break
                }
                dir = dir.deletingLastPathComponent()
            }
            let text = try XCTUnwrap(source, "\(Self.fixturesPath) was not found above this test file")
            let re = try NSRegularExpression(pattern: "export const (\\w+) =\\s*(\"(?:[^\"\\\\]|\\\\.)*\");")
            var out: [String: String] = [:]
            for match in re.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                guard let name = Range(match.range(at: 1), in: text), let literal = Range(match.range(at: 2), in: text),
                      let value = try JSONSerialization.jsonObject(with: Data(text[literal].utf8),
                                                                   options: .fragmentsAllowed) as? String else { continue }
                out[String(text[name])] = value
            }
            Self.cached = out
        }
        return try XCTUnwrap(Self.cached?[name], "no fixture \(name)")
    }

    // MARK: building a conversation

    private var events: [[String: Any]] = []

    private func event(_ seq: Int, _ type: String, _ turnId: String, _ payload: [String: Any]) {
        events.append(["seq": seq, "type": type, "turnId": turnId, "ts": Self.ts, "payload": payload])
    }

    /// A background delegate call, its launch receipt, and one step of its child.
    private func delegate(_ seq: Int, _ id: String, _ runId: String, _ description: String) {
        event(seq, "tool_use", "turn-1", ["id": id, "name": SubagentBlock.toolName,
                                          "input": ["description": description, "prompt": "Do it.",
                                                    "type": "general", "background": true]])
        let receipt = String(decoding: try! JSONSerialization.data(withJSONObject: ["runId": runId, "status": "running"]),
                             as: UTF8.self)
        event(seq + 1, "tool_result", "turn-1", ["toolUseId": id, "content": [["type": "text", "text": receipt]]])
        event(seq + 2, "tool_use", "turn-1", ["id": "\(runId):c1", "name": "Edit", "parentToolUseId": id,
                                              "input": ["file_path": "/repo/x.ts", "old_string": "a", "new_string": "b"]])
    }

    /// A `user` event as ingest stores a wake turn: the echo, and the same block recorded as the note.
    private func wake(_ seq: Int, _ block: String, _ extra: [String: Any] = [:], turnId: String? = nil) {
        var payload: [String: Any] = ["text": block, "controlPlaneNote": block]
        payload.merge(extra) { $1 }
        event(seq, "user", turnId ?? "turn-wake-\(seq)", payload)
    }

    private func reply(_ seq: Int, _ text: String, turnId: String? = nil) {
        event(seq, "assistant", turnId ?? "turn-wake-\(seq - 1)", ["text": text])
    }

    private func state() throws -> TranscriptState {
        var reducer = TranscriptReducer()
        for e in events {
            let data = try JSONSerialization.data(withJSONObject: e)
            reducer.apply(try JSONDecoder().decode(RunEvent.self, from: data))
        }
        return reducer.state
    }

    private func rows(_ state: TranscriptState) -> [TranscriptRow] {
        TranscriptRows.build(state: state, statusCards: [], canPageOlder: false, showWorkingIndicator: false)
    }

    /// The opening message, one background SubAgent, its end turn, and the agent carrying on.
    private func oneRun(_ fixture: String) throws -> (runId: String, status: String) {
        let (runId, status, description) = try XCTUnwrap(Self.runOf[fixture])
        event(1, "user", "turn-1", ["text": "Start them."])
        delegate(2, "toolu_bg", runId, description)
        wake(9, try block(fixture))
        reply(10, "Carrying on.")
        return (runId, status)
    }

    private func run(_ toolUseId: String, _ status: String, files: [String]? = nil) -> SubagentRunView {
        SubagentRunView(toolUseId: toolUseId, type: "general", background: true, status: status,
                        level: "M", model: "claude-sonnet-5-5", modelLabel: "Sonnet 5.5", effort: "medium",
                        reasons: [], costUsd: 0,
                        resultSummary: status == "DONE" ? "Three callers, all in **quota/**." : nil,
                        createdAt: "2026-11-15T16:26:00.000Z", endedAt: status == "RUNNING" ? nil : Self.ended,
                        why: "Tier M from the caller", workspaceName: nil, description: nil, engine: "claude",
                        readonly: false, changedFiles: files ?? (status == "DONE" ? [] : Self.files))
    }

    /// Every row that stands for a SubAgent or its end: its card, and any line or bubble an end turn drew.
    private func subagentRows(_ rows: [TranscriptRow]) -> [TranscriptRow] {
        rows.filter {
            switch $0 {
            case .item(.toolCall(let card)): return card.name == SubagentBlock.toolName
            case .agents: return true
            case .item(.user(let b)), .queued(let b):
                return SubagentFinishedText.parse(b.note) != nil || SubagentFinishedText.parse(b.text) != nil
            case .exchanges: return true
            default: return false
            }
        }
    }

    private func userRows(_ rows: [TranscriptRow]) -> [UserBubble] {
        rows.compactMap { if case .item(.user(let b)) = $0 { return b } else { return nil } }
    }

    private func replies(_ rows: [TranscriptRow]) -> [String] {
        rows.compactMap { if case .item(.assistant(let b)) = $0 { return b.text } else { return nil } }
    }

    // MARK: from start to end

    func testRunsAsOneCardWithNoEnd() throws {
        _ = try oneRun("SUBAGENT_DONE")
        events.removeLast(2)
        let rows = rows(try state())
        XCTAssertEqual(subagentRows(rows).count, 1)
        XCTAssertNil(SubagentCardEnd.ended(run("toolu_bg", "RUNNING")), "a running card draws no end")
    }

    func testEndsDoneOnTheSameCardAndTheEndTurnDrawsNothing() throws {
        let (runId, _) = try oneRun("SUBAGENT_DONE")
        let state = try state()
        let rows = rows(state)
        XCTAssertEqual(subagentRows(rows).count, 1, "one element for the run: its card")
        XCTAssertEqual(userRows(rows).map(\.text), ["Start them."], "only the reader's own message is a bubble")
        XCTAssertEqual(replies(rows), ["Carrying on."], "the agent's answer reads on, unfolded")
        let done = run("toolu_bg", "DONE")
        XCTAssertNotNil(SubagentCardEnd.ended(done))
        XCTAssertNil(SubagentCardEnd.chip(done.status), "✓ and no word")
        XCTAssertEqual(SubagentCardEnd.tone(done.status), .ok)
        XCTAssertNil(SubagentCardEnd.because(done.status))
        XCTAssertEqual(SubagentCardEnd.resultLines, 2)
        // The card keeps what the agent read, joined by run id, read at the turn's time.
        let seen = try XCTUnwrap(SubagentCardEnd.wakes(state.items)[runId])
        XCTAssertEqual(seen.text, try block("SUBAGENT_DONE"))
        XCTAssertEqual(seen.readAt, Self.ts)
    }

    func testEndsFailedInterruptedAndStoppedOnTheSameCard() throws {
        for (fixture, word, tone, reason) in [
            ("SUBAGENT_FAILED", "failed", SubagentCardEnd.Tone.failed, "It did not finish its work."),
            ("SUBAGENT_INTERRUPTED", "interrupted", .failed,
             "The runner hosting it stopped (a restart, an update or a crash) before it finished."),
            ("SUBAGENT_STOPPED", "stopped", .stopped, "Stopped by the agent."),
        ] {
            events = []
            let (_, status) = try oneRun(fixture)
            let rows = rows(try state())
            XCTAssertEqual(subagentRows(rows).count, 1, "\(fixture): one element for the run")
            XCTAssertEqual(userRows(rows).count, 1, "\(fixture): no bubble for the end turn")
            XCTAssertEqual(SubagentCardEnd.chip(status), word)
            XCTAssertEqual(SubagentCardEnd.tone(status), tone)
            XCTAssertEqual(SubagentCardEnd.because(status), reason)
            let files = run("toolu_bg", status).changedFiles ?? []
            XCTAssertEqual("\(SubagentCardEnd.fileCount(files.count)) \(SubagentCardEnd.showFiles) \(SubagentCardEnd.fileNames(files))",
                           "5 files left uncommitted Show files model-routing.ts · task-route-decision.ts · +3")
        }
    }

    func testOpenedInterruptedEndSaysItsReasonOnceAndListsThreeFiles() throws {
        let nine = (0..<9).map { "src/f\($0).ts" }
        XCTAssertEqual(SubagentCardEnd.fileCount(nine.count), "9 files left uncommitted")
        XCTAssertEqual(SubagentCardEnd.endHead("INTERRUPTED", when: "1m ago"),
                       "Interrupted 1m ago: the runner hosting it stopped (a restart, an update or a crash) before it finished.")
        XCTAssertEqual(SubagentCardEnd.filesHead(nine.count), "9 files left uncommitted in the working tree:")
        XCTAssertEqual(Array(nine.prefix(SubagentCardEnd.filesShown)) + [SubagentCardEnd.moreFiles(nine.count - 3)],
                       ["src/f0.ts", "src/f1.ts", "src/f2.ts", "… 6 more"])
        XCTAssertEqual(SubagentCardEnd.rawSummary, "What the agent read")
        let clock = try XCTUnwrap(SubagentCardEnd.clock(Self.ts))
        XCTAssertTrue(clock.range(of: "^\\d\\d:\\d\\d$", options: .regularExpression) != nil, clock)
        XCTAssertEqual(SubagentCardEnd.runLine("34y5PintrRUNid0000003", readAt: clock),
                       "Run 34y5PintrRUNid0000003 · read by the agent at \(clock)")
    }

    func testGreysAStoppedEndAsNoFailure() {
        XCTAssertEqual(SubagentCardEnd.tone("STOPPED"), .stopped)
        XCTAssertEqual(SubagentCardEnd.endHead("STOPPED", when: "1m ago"), "Stopped 1m ago by the agent.")
        let stopped = run("toolu_bg", "STOPPED")
        let block = SubagentBlock.describe(input: .object([:]), run: stopped, status: .ok)
        XCTAssertFalse(block.outcomeIsFailure, "a stop is not drawn red")
    }

    func testAWakeNamingTwoRunsDrawsNothingAndJoinsEachCard() throws {
        event(1, "user", "turn-1", ["text": "Start them."])
        delegate(2, "toolu_a", "34y5Qcall0000000000001", "Find every caller of pollQuota")
        event(5, "assistant", "turn-1", ["text": "Both started."])
        delegate(6, "toolu_b", "34y5Qspec0000000000002", "Write the poller spec")
        wake(9, try block("SUBAGENT_TWO"))
        reply(10, "One of them failed.")
        let state = try state()
        let rows = rows(state)
        XCTAssertEqual(subagentRows(rows).count, 2, "two cards, nothing at the wake")
        XCTAssertEqual(userRows(rows).count, 1)
        XCTAssertEqual(replies(rows).last, "One of them failed.")
        let wakes = SubagentCardEnd.wakes(state.items)
        XCTAssertEqual(wakes["34y5Qcall0000000000001"]?.text, try block("SUBAGENT_TWO"))
        XCTAssertEqual(wakes["34y5Qspec0000000000002"]?.text, try block("SUBAGENT_TWO"))
    }

    func testAWakeWrittenIntoTheRunningTurnDrawsNothing() throws {
        event(1, "user", "turn-1", ["text": "Start them."])
        delegate(2, "toolu_a", "34y5Qcall0000000000001", "Find every caller of pollQuota")
        reply(5, "Still working.", turnId: "turn-1")
        wake(9, try block("SUBAGENT_STEER"), ["steer": true, "delivery": "enqueued"], turnId: "turn-1")
        event(10, "user_delivery", "turn-1", ["turnId": "turn-1", "delivery": "acknowledged"])
        let rows = rows(try state())
        XCTAssertEqual(subagentRows(rows).count, 1)
        XCTAssertEqual(userRows(rows).count, 1)
    }

    /// A job's news written beside the end draws nothing either: the job is its own card (`BgJobCard`,
    /// board C1), so the whole turn draws nothing (web parity: `wakeupsOnly`).
    func testAJobsNewsWrittenBesideTheEndDrawsNothingEither() throws {
        _ = try oneRun("SUBAGENT_DONE")
        let both = "\(try block("SUBAGENT_DONE"))\n\n\(Self.job)"
        events[4] = ["seq": 9, "type": "user", "turnId": "turn-wake-9", "ts": Self.ts,
                     "payload": ["text": both, "controlPlaneNote": both]]
        let rows = rows(try state())
        XCTAssertFalse(rows.contains { if case .item(.user(let b)) = $0 { return b.id != "i1" } else { return false } },
                       "no line for the end, none for the job's news")
        XCTAssertFalse(rows.contains { if case .exchanges = $0 { return true } else { return false } })
        XCTAssertTrue(SubagentCardEnd.drawsNothing(UserBubble(id: "w", text: "", pending: false,
                                                              note: "\(try block("SUBAGENT_DONE"))\n\n\(Self.job)"),
                                                   queued: false))
    }

    func testABlockInAWordingItDoesNotKnowIsTheFromOrbitLine() throws {
        let unknown = try block("SUBAGENT_DONE").replacingOccurrences(of: "finished: DONE", with: "finished: CANCELLED")
        wake(9, unknown)
        let rows = rows(try state())
        let b = try XCTUnwrap(userRows(rows).first, "the turn keeps a row")
        XCTAssertFalse(SubagentCardEnd.drawsNothing(b, queued: false))
        XCTAssertTrue(OrbitEvent.draws(b), "drawn as the From Orbit line, not a bubble")
    }

    // MARK: still on the queue

    func testAQueuedEndTurnWaitsOnItsCardNotInTheTail() throws {
        let (runId, _) = try oneRun("SUBAGENT_INTERRUPTED")
        events.removeLast(2)
        var state = try state()
        let block = try block("SUBAGENT_INTERRUPTED")
        state.queued = [UserBubble(id: "q1", text: block, turnId: "wake-1", pending: true, queued: true)]
        let rows = rows(state)
        XCTAssertFalse(rows.contains { if case .queued = $0 { return true } else { return false } },
                       "the tail draws nothing for a SubAgent-only wake")
        XCTAssertEqual(subagentRows(rows).count, 1)
        XCTAssertEqual(SubagentCardEnd.queuedWake(state.queued[0])?.runIds, [runId])
        XCTAssertEqual("\(SubagentCardEnd.waiting) · \(SubagentCardEnd.dontSend)",
                       "Waiting for the agent to read it · Don't send")
        // Delivered: off the queue, in the transcript, read.
        XCTAssertNil(SubagentCardEnd.wakes(state.items)[runId])
    }

    func testQueuedWakesAreToldApartFromTheTailsOwnRows() throws {
        let two = UserBubble(id: "q", text: try block("SUBAGENT_TWO"), pending: true, queued: true)
        XCTAssertEqual(SubagentCardEnd.queuedWake(two)?.runIds, ["34y5Qcall0000000000001", "34y5Qspec0000000000002"])
        XCTAssertEqual(SubagentCardEnd.queuedWake(two)?.alone, true)
        let withJob = UserBubble(id: "q", text: "\(try block("SUBAGENT_DONE"))\n\n\(Self.job)", pending: true, queued: true)
        XCTAssertEqual(SubagentCardEnd.queuedWake(withJob)?.alone, true)
        XCTAssertTrue(SubagentCardEnd.drawsNothing(withJob, queued: true), "a job's news waits on its own card too")
        XCTAssertNil(SubagentCardEnd.queuedWake(UserBubble(id: "q", text: "deploy it", pending: true, queued: true)))
        XCTAssertNil(ComposerLogic.restorableText(of: two), "never goes back to the composer")
    }

    /// An end turn never delivered keeps its block on the card but no read time.
    func testAnUndeliveredEndTurnWasNeverRead() throws {
        let done = try block("SUBAGENT_DONE")
        let items: [TranscriptItem] = [.user(UserBubble(id: "w", text: "", ts: Self.ts, pending: false, note: done,
                                                        delivery: "failed"))]
        XCTAssertNil(SubagentCardEnd.wakes(items)["34y5NxcqKYA179mC04VUB"]?.readAt)
        XCTAssertEqual(SubagentCardEnd.wakes(items)["34y5NxcqKYA179mC04VUB"]?.text, done)
    }
}

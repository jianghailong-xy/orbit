import Foundation
import XCTest
@testable import OrbitKit

/// Reading the block the control plane opens a turn with when a SubAgent ends. The turn draws nothing
/// (its card is the end, `SubagentCardEndTests`); the card keeps the block under What the agent read. The blocks are the web's fixtures (`subagentFinished.fixtures.ts`, the output of the
/// apiserver's `buildSubagentFinishedBlock`), read from that file so both ends read the same bytes.
final class SubagentFinishedTests: XCTestCase {

    private static let fixturesPath = "src/web/src/lib/subagentFinished.fixtures.ts"

    /// The sentences the block closes on: the agent's, never shown outside the raw block.
    private static let protocolSentences = [
        "The control plane opened this turn for it.",
        "It ended while you were working",
        "the user did not say it",
        "call delegate with resume",
        "The control plane recorded this for you",
    ]

    private static var cached: [String: String]?

    private func fixtures() throws -> [String: String] {
        if let cached = Self.cached { return cached }
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
        guard let source else {
            XCTFail("\(Self.fixturesPath) was not found above this test file")
            return [:]
        }
        let re = try NSRegularExpression(pattern: "export const (\\w+) =\\s*(\"(?:[^\"\\\\]|\\\\.)*\");")
        var out: [String: String] = [:]
        for match in re.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
            guard let name = Range(match.range(at: 1), in: source),
                  let literal = Range(match.range(at: 2), in: source),
                  let value = try JSONSerialization.jsonObject(
                    with: Data(source[literal].utf8), options: .fragmentsAllowed) as? String else { continue }
            out[String(source[name])] = value
        }
        XCTAssertEqual(Set(out.keys), ["SUBAGENT_DONE", "SUBAGENT_FAILED", "SUBAGENT_STOPPED",
                                        "SUBAGENT_INTERRUPTED", "SUBAGENT_TWO", "SUBAGENT_STEER",
                                        "SUBAGENT_NODESC"])
        Self.cached = out
        return out
    }

    private func block(_ name: String) throws -> String {
        try XCTUnwrap(try fixtures()[name], "no fixture \(name)")
    }

    private func wake(_ name: String) throws -> SubagentFinished {
        try XCTUnwrap(SubagentFinishedText.parse(try block(name)), "\(name) did not parse")
    }

    func testReadsARunThatFinishedWithItsWholeResultBackAtColumnZero() throws {
        let done = try block("SUBAGENT_DONE")
        let wake = try wake("SUBAGENT_DONE")
        XCTAssertEqual(wake.runs.count, 1)
        let run = wake.runs[0]
        XCTAssertEqual(run.runId, "34y5NxcqKYA179mC04VUB")
        XCTAssertEqual(run.description, "Deploy 6bb50a957 to production")
        XCTAssertEqual(run.status, "DONE")
        XCTAssertNil(run.reason)
        XCTAssertTrue(run.result.hasPrefix("Stopped at step 1: the local lock `/tmp/orbit-upgrade.lock/pid`"))
        XCTAssertTrue(run.result.contains("(not mine).\n\nThe remote check came back clean."))
        XCTAssertFalse(run.result.components(separatedBy: "\n").contains { $0.hasPrefix(" ") })
        XCTAssertEqual(wake.text, done)
        XCTAssertEqual(wake.rest, "")
    }

    func testReadsEachWayARunCanFailToFinishWithWhy() throws {
        let failed = try wake("SUBAGENT_FAILED").runs[0]
        XCTAssertEqual(failed.status, "FAILED")
        XCTAssertEqual(failed.reason, "It did not finish its work.")
        XCTAssertEqual(failed.result, "vitest could not resolve `../quota/poller`; nothing written.")
        let stopped = try wake("SUBAGENT_STOPPED").runs[0]
        XCTAssertEqual(stopped.status, "STOPPED")
        XCTAssertEqual(stopped.reason, "It was stopped before it finished.")
        XCTAssertEqual(stopped.result, "")
        let interrupted = try wake("SUBAGENT_INTERRUPTED").runs[0]
        XCTAssertEqual(interrupted.status, "INTERRUPTED")
        XCTAssertTrue(interrupted.reason?.hasPrefix(
            "The runner process hosting it stopped (a restart, an update or a crash)") == true)
        XCTAssertEqual(interrupted.result, "")
    }

    func testReadsEveryRunOfABlockThatCarriesSeveral() throws {
        let wake = try wake("SUBAGENT_TWO")
        XCTAssertEqual(wake.runs.map(\.description), ["Find every caller of pollQuota", "Write the poller spec"])
        XCTAssertEqual(wake.runs.map(\.status), ["DONE", "FAILED"])
        XCTAssertEqual(wake.runs[0].result,
                       "Three callers, all in `quota/`: poller.ts, account.ts, limits.ts.\n\nNothing else imports it.")
        XCTAssertEqual(wake.runs[1].reason, "It did not finish its work.")
    }

    func testReadsASteersBlockAndARunWithNoDescription() throws {
        XCTAssertEqual(try wake("SUBAGENT_STEER").runs[0].status, "DONE")
        let nodesc = try wake("SUBAGENT_NODESC").runs[0]
        XCTAssertEqual(nodesc.description, "without a description")
        XCTAssertEqual(nodesc.result, "ok")
    }

    /// The protocol sentences are never shown outside the raw text: the card says the run's end in its
    /// own words, read off the run's status, and only `text` (What the agent read) holds them.
    func testNothingTheCardShowsCarriesTheSentencesForTheAgent() throws {
        for name in try fixtures().keys.sorted() {
            let wake = try wake(name)
            var shown = [wake.rest, SubagentCardEnd.rawSummary, SubagentCardEnd.waiting]
            for run in wake.runs {
                shown += [SubagentCardEnd.because(run.status) ?? "", SubagentCardEnd.chip(run.status) ?? "",
                          SubagentCardEnd.endHead(run.status, when: "1m ago") ?? "",
                          SubagentCardEnd.runLine(run.runId, readAt: "14:02")]
            }
            for text in shown {
                for sentence in Self.protocolSentences {
                    XCTAssertFalse(text.contains(sentence), "\(name): \(text.debugDescription) shows \(sentence)")
                }
            }
            XCTAssertTrue(Self.protocolSentences.contains { wake.text.contains($0) },
                          "\(name): the raw text lost the block it was read from")
        }
    }

    func testKeepsTheRestOfTheNoteAndLeavesAJobsBlockToItsOwnReader() throws {
        let job = [
            "<background-job-wake>",
            "  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:",
            "    bgj_13c53745a88a｜job｜make test｜unit tests",
            "      ended｜completed｜exit code 0",
            "      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–10",
            "      (no output)",
            "  The control plane recorded this for you; the user did not say it.",
            "</background-job-wake>",
        ].joined(separator: "\n")
        let done = try block("SUBAGENT_DONE")
        let wake = try XCTUnwrap(SubagentFinishedText.parse("\(done)\n\n\(job)"))
        XCTAssertEqual(wake.runs.count, 1)
        XCTAssertEqual(wake.rest, job)
        XCTAssertEqual(BackgroundWakeText.parse(wake.rest)?.jobs.first?.id, "bgj_13c53745a88a")
        let nudge = "You were interrupted; carry on from where you were."
        XCTAssertEqual(SubagentFinishedText.parse("\(nudge)\n\n\(done)")?.rest, nudge)
    }

    func testReadsAWordingItDoesNotKnowAsNothingAtAll() throws {
        let done = try block("SUBAGENT_DONE")
        XCTAssertNil(SubagentFinishedText.parse(nil))
        XCTAssertNil(SubagentFinishedText.parse(""))
        XCTAssertNil(SubagentFinishedText.parse("Please deploy it"))
        XCTAssertNil(SubagentFinishedText.parse(done.replacingOccurrences(of: "finished: DONE", with: "finished: CANCELLED")))
        XCTAssertNil(SubagentFinishedText.parse(done.replacingOccurrences(of: "SubAgent Deploy", with: "Sub-agent Deploy")))
        XCTAssertNil(SubagentFinishedText.parse(done.replacingOccurrences(of: "  Result:\n", with: "")))
        XCTAssertNil(SubagentFinishedText.parse(
            "<orbit-subagent-finished>\n  The control plane opened this turn for it.\n</orbit-subagent-finished>"))
        XCTAssertNil(SubagentFinishedText.parse(done.replacingOccurrences(of: "</orbit-subagent-finished>", with: "")))
        XCTAssertNil(SubagentFinishedText.parse(
            try block("SUBAGENT_TWO").replacingOccurrences(of: "finished: FAILED", with: "finished: LOST")))
        XCTAssertFalse(SubagentFinishedText.carriesWake("Please deploy it"))
        XCTAssertTrue(SubagentFinishedText.carriesWake(done))
    }

    func testADelegateCallsResultNamesItsRun() {
        XCTAssertEqual(SubagentFinishedText.delegateRunId(#"{"runId":"34y5Qcall0000000000001","status":"running"}"#),
                       "34y5Qcall0000000000001")
        XCTAssertEqual(SubagentFinishedText.delegateRunId("  {\"runId\":\"abc\",\"status\":\"DONE\",\"result\":\"ok\"}\n"), "abc")
        XCTAssertNil(SubagentFinishedText.delegateRunId(nil))
        XCTAssertNil(SubagentFinishedText.delegateRunId("not json"))
        XCTAssertNil(SubagentFinishedText.delegateRunId(#"{"runId":""}"#))
    }

    /// The turn is nobody's words: no tray, no composer, no sticky anchor — and it folds as nothing: it
    /// draws nothing, so the agent's answer after it stays in view (web: `orbitTurnOf`).
    func testTheTurnIsNotTheReadersOwnAndFoldsAsNothing() throws {
        let done = try block("SUBAGENT_DONE")
        let bubble = UserBubble(id: "u1", text: "", pending: false, note: done)
        XCTAssertFalse(SteerDelivery.isReadersOwn(bubble))
        XCTAssertFalse(StickySummary.isAnchor(text: "", note: done))
        XCTAssertTrue(StickySummary.isAnchor(text: "and also this", note: done))

        let queued = UserBubble(id: "u2", text: done, pending: false, queued: true)
        XCTAssertNil(ComposerLogic.restorableText(of: queued))

        XCTAssertNil(OrbitExchangeFold.orbitTurn(bubble))
        var failed = bubble
        failed.note = try block("SUBAGENT_FAILED")
        XCTAssertNil(OrbitExchangeFold.orbitTurn(failed))
    }
}

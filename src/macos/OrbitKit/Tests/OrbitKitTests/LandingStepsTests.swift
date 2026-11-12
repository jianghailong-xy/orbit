import Foundation
import XCTest
@testable import OrbitKit

/// A landing's timeline as the chat's tool rows (owner 2026-11-11, docs/mocks/landings-chat-tools-native):
/// the same cases `src/web/src/lib/landingSteps.test.ts` holds, and the words looked up in the web file
/// they were ported from.
final class LandingStepsTests: XCTestCase {
    private var seq = 0

    private func line(_ kind: String, _ text: String, phase: String? = nil, check: String? = nil,
                      state: String? = nil, exit: Int? = nil) -> IntegrationTimelineEntry {
        seq += 1
        var data: [String: JSONValue]?
        if let state { data = ["state": .string(state)] }
        if let exit { data = ["exitCode": .int(exit), "expectedExitCode": .int(0)] }
        return IntegrationTimelineEntry(
            id: "e\(seq)", seq: seq, kind: kind, at: String(format: "2026-11-10T15:%02d:00.000Z", 20 + seq),
            claim: 1, round: 1, check: check.map { LandingTimelineCheck(name: $0, index: 1) }, phase: phase,
            data: data, text: text)
    }

    func testALandedTasksFifteenLinesAreFiveSteps() {
        // The owner's 2026-11-11 screenshot, line for line.
        let entries = [
            line("ENQUEUED", "Task marked done · queued to land on project/p1"),
            line("CLAIMED", "Claimed by runner workstation-gpu · claim 1"),
            line("STEP", "Waiting for this runner's repository lock"),
            line("ROUND", "Round 1 of 3"),
            line("STEP", "Fetching the repository", phase: "FETCH"),
            line("STEP", "Syncing main into project/p1", phase: "MAIN_SYNC"),
            line("STEP", "Rebasing onto project/p1", phase: "REBASE"),
            line("STEP", "Running the checks", phase: "CHECK"),
            line("STEP", "Preparing the combined tree", phase: "MERGE"),
            line("CHECK_STARTED", "Merge check started · claim 1 · workstation-gpu", check: "MERGE_CHECK"),
            line("STEP", "Running the checks", phase: "CHECK"),
            line("STEP", "Reported starting the push to project/p1", phase: "PUSH"),
            line("STEP", "Verifying the merged tree", phase: "VERIFY"),
            line("CHECK_FINISHED", "Merge check passed · 0m 16s", check: "MERGE_CHECK", exit: 0),
            line("RESULT", "Landed on project/p1 · 9afb7d1", state: "LANDED"),
        ]
        let steps = LandingSteps.steps(entries, kind: "LAND_TASK")
        XCTAssertEqual(steps.map(\.name), ["Queue", "Claim", "Sync", "Merge check", "Push"])
        XCTAssertEqual(steps.map(\.summary.text), [
            "Task marked done · queued to land on project/p1",
            "Claimed by runner workstation-gpu · claim 1",
            "Preparing the combined tree",
            "Merge check passed · 0m 16s",
            "Landed on project/p1 · 9afb7d1",
        ])
        XCTAssertEqual(steps.map(\.entries.count), [1, 2, 5, 4, 3])
        // Every line is kept, each once.
        XCTAssertEqual(steps.flatMap { $0.entries.map { $0.index } }.sorted(), Array(0..<entries.count))
        XCTAssertEqual(steps[4].at, entries[14].at)
        XCTAssertFalse(steps.contains { LandingSteps.failed($0, kind: "LAND_TASK") })
    }

    func testAFailedChecksResultStaysInItsCheck() {
        let steps = LandingSteps.steps([
            line("ENQUEUED", "Task marked done"),
            line("CLAIMED", "Claimed by runner wikova · claim 1"),
            line("CHECK_STARTED", "Merge check started", check: "MERGE_CHECK"),
            line("CHECK_FINISHED", "Merge check failed · exit 1 after 3m 52s", check: "MERGE_CHECK", exit: 1),
            line("RESULT", "Check failed · nothing was pushed", state: "CHECK_FAILED"),
        ], kind: "LAND_TASK")
        XCTAssertEqual(steps.map(\.name), ["Queue", "Claim", "Merge check"])
        XCTAssertEqual(steps[2].summary.text, "Check failed · nothing was pushed")
        XCTAssertTrue(LandingSteps.failed(steps[2], kind: "LAND_TASK"))
        XCTAssertFalse(LandingSteps.failed(steps[1], kind: "LAND_TASK"))
    }

    func testAMergeRoundsLastStepIsMergeAndACheckRoundsIsResult() {
        XCTAssertEqual(LandingSteps.steps([line("RESULT", "Ready to merge into main", state: "READY")],
                                          kind: "CHECK_PROMOTION").map(\.name), ["Result"])
        XCTAssertEqual(LandingSteps.steps([line("RESULT", "Merged into main · 8958893", state: "LANDED")],
                                          kind: "LAND_PROMOTION").map(\.name), ["Merge"])
    }

    func testTaskAcceptanceAndTheMergeCheckEachHaveAStep() {
        let steps = LandingSteps.steps([
            line("CHECK_STARTED", "Task acceptance started", check: "TASK_ACCEPTANCE"),
            line("CHECK_FINISHED", "Task acceptance passed · 1m 02s", check: "TASK_ACCEPTANCE", exit: 0),
            line("CHECK_STARTED", "Merge check started", check: "MERGE_CHECK"),
        ], kind: "LAND_TASK")
        XCTAssertEqual(steps.map(\.name), ["Task acceptance", "Merge check"])
    }

    func testChecksDuration() {
        XCTAssertEqual(LandingSteps.checksDurationMs([16_000, nil, 1_000]), 17_000)
        XCTAssertNil(LandingSteps.checksDurationMs([nil]))
        XCTAssertNil(LandingSteps.checksDurationMs([]))
    }

    /// The words, as the web writes them.
    func testTheWordsAreTheWebs() throws {
        let steps = try source("src/web/src/lib/landingSteps.ts")
        for (key, copy) in [("QUEUE", LandingStepCopy.queue), ("CLAIM", LandingStepCopy.claim),
                            ("SYNC", LandingStepCopy.sync), ("PUSH", LandingStepCopy.push),
                            ("MERGE", LandingStepCopy.merge), ("RESULT", LandingStepCopy.result)] {
            XCTAssertTrue(steps.contains("\(key): '\(copy)',"), "landingSteps.ts no longer says \(key): '\(copy)'")
        }
        let window = try source("src/web/src/components/ProjectLandingsWindow.tsx")
        for (key, copy) in [("CHECK", LandingStepCopy.check), ("DETAILS", LandingStepCopy.details),
                            ("WORKING_FOR", LandingStepCopy.workingFor)] {
            XCTAssertTrue(window.contains("\(key): '\(copy)',"), "ProjectLandingsWindow.tsx no longer says \(key): '\(copy)'")
        }
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(relative) was not found above this test file")
        return ""
    }
}

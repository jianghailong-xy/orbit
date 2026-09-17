import Foundation
import XCTest
@testable import OrbitKit

/// Reading the inventory block a returning engine is handed.
///
/// Held to the wording the apiserver writes today (`runner-api/background-jobs-context.ts`'s
/// `buildBackgroundJobsBlock`) AND to the one that shipped until 2026-09-15, which most of the
/// blocks already in the record still carry — recognising only the new one would have sent every
/// older transcript back to a wall of `｜` on the day it shipped. Every fixture is copied out of
/// this deployment's own `run_event` rows (`BackgroundJobsFixtures`).
///
/// The browser proves the same readings against the same blocks in `backgroundJobs.test.ts`; what
/// holds the two readings to each other is `BackgroundJobsCopyParityTests`.
final class BackgroundJobsTests: XCTestCase {

    func testReadsOneEndedJobInTheWordingWrittenToday() {
        let jobs = BackgroundJobsText.parse(BackgroundJobsFixtures.enEnded)

        XCTAssertEqual(jobs?.running, [])
        XCTAssertEqual(jobs?.ended, [
            BackgroundJobRow(
                id: "bgj_41314cd48e66",
                kind: "job",
                command: "cd src/macos/OrbitKit && swift test && cd ../OrbitApp/Sources/OrbitApp && "
                    + "for f in *.swift Views/*.swift Views/Console/*.swift; do swift -frontend "
                    + "-parse \"$f\" >/dev/null || exit 1; done; echo \"ACCEPTANCE_EXIT=$?\"",
                status: "completed",
                exitCode: 0,
                reason: nil,
                outputPath: "/root/.orbit/runs/6add2dbe-be98-5ea7-a619-4b729c74e82f/"
                    + "bgj_41314cd48e66.output"),
        ])
    }

    func testReadsTheSameFieldsOutOfTheOlderWording() {
        let jobs = BackgroundJobsText.parse(BackgroundJobsFixtures.zhEnded)

        XCTAssertEqual(jobs?.ended, [
            BackgroundJobRow(
                id: "bgj_0f012a1b9d50",
                kind: "job",
                command: "/root/orbit/.claude/skills/upgrade/upgrade.sh 2>&1",
                status: "completed",
                exitCode: 0,
                reason: nil,
                outputPath: "/root/.orbit/runs/01a066d7-5db3-763e-a3c4-0291a933ee0b/"
                    + "bgj_0f012a1b9d50.output"),
        ])
    }

    func testKeepsAKillReasonAsTheRunnerRecordedItUntranslated() {
        let job = BackgroundJobsText.parse(BackgroundJobsFixtures.zhKilled)?.ended.first

        XCTAssertEqual(job?.status, "killed")
        XCTAssertEqual(job?.reason, "drain_cap")
        XCTAssertNil(job?.exitCode)
    }

    func testReadsAJobWhoseRunnerDiedWithoutReportingAnEndAsStopped() {
        let job = BackgroundJobsText.parse(BackgroundJobsFixtures.zhNoEnd)?.ended.first

        XCTAssertEqual(job?.command, "/usr/bin/python3 /root/gpu-ladder.py")
        XCTAssertEqual(job?.status, "stopped")
        XCTAssertNil(job?.exitCode)
        // The outcome's own words, not the sentence of gloss the block appends to them.
        XCTAssertEqual(job?.reason, "没有结束报告")
        XCTAssertEqual(job?.outputPath,
                       "/root/.orbit/runs/01a0a34b-e497-762e-9742-1db4f1a0b7b0/bgj_9056fe0308d8.output")
    }

    func testTellsTheTwoSectionsApart() {
        let today = BackgroundJobsText.parse(BackgroundJobsFixtures.enRunningAndEnded)
        let older = BackgroundJobsText.parse(BackgroundJobsFixtures.zhRunningAndEnded)

        XCTAssertEqual(today?.running.map(\.id), ["bgj_b6ac1419950c"])
        XCTAssertEqual(today?.ended.map(\.id), ["bgj_e95780ddaf25"])
        // A running job has no outcome to report, and must not borrow the ended one's.
        XCTAssertEqual(today?.running.first?.status, "")
        XCTAssertNil(today?.running.first?.exitCode)
        XCTAssertEqual(older?.running.map(\.id), ["bgj_06e2cae99078"])
        XCTAssertEqual(older?.ended.map(\.id), ["bgj_6dff87bf9125"])
    }

    func testKeepsACommandThatRunsToSeveralLinesWhole() {
        let jobs = BackgroundJobsText.parse(BackgroundJobsFixtures.zhMultilineCommand)

        XCTAssertEqual(jobs?.running.map(\.id),
                       ["bgj_e5753c1a7d36", "bgj_5beaf98d55a4", "bgj_dd920b03adc6"])
        // Six lines of shell, ending on the line that reports the exit code — not cut at the first
        // newline, and not swallowing the job listed after it.
        let second = jobs?.running[1].command ?? ""
        XCTAssertTrue(second.contains("\nBGPID=$!\n"), second)
        XCTAssertTrue(second.hasSuffix("echo \"EXIT=$?\""), second)
        XCTAssertTrue(jobs?.running[2].command.hasPrefix("chmod +x") == true)
    }

    func testLeavesTheMonitorSectionToTheVerbatimFold() {
        let jobs = BackgroundJobsText.parse(BackgroundJobsFixtures.zhMonitor)

        // The Monitor line is `｜`-separated like a job's and sits at the same indent; reading it as
        // one would put a row nobody can act on between two that matter.
        XCTAssertEqual(jobs?.ended.map(\.id), ["bgj_76417c73491e"])
        XCTAssertEqual(jobs?.running, [])
        XCTAssertTrue(jobs?.text.contains("Monitor｜tool_use toolu_014ZNoYjEsHpmEucpLSzBGzT") == true)
    }

    func testHandsBackTheBlockVerbatimAndWhateverElseTheNoteCarried() {
        let note = "<referenced-task>\n  34QGTYmD6gkY7BqjTXk1c\n</referenced-task>\n\n"
            + BackgroundJobsFixtures.zhEnded

        let jobs = BackgroundJobsText.parse(note)

        XCTAssertEqual(jobs?.text, BackgroundJobsFixtures.zhEnded)
        XCTAssertEqual(jobs?.rest, "<referenced-task>\n  34QGTYmD6gkY7BqjTXk1c\n</referenced-task>")
    }

    func testIsNothingAtAllForANoteWithNoBlockOrABlockWithNoJobs() {
        XCTAssertNil(BackgroundJobsText.parse(nil))
        XCTAssertNil(BackgroundJobsText.parse("<referenced-task>\n  34QG\n</referenced-task>"))
        XCTAssertNil(BackgroundJobsText.parse(
            "<background-jobs>\n  这是控制面替你记下的，不是用户说的。\n</background-jobs>"))
    }

    // MARK: the line that names the block folded

    private func summary(_ note: String) -> String? {
        BackgroundJobsText.parse(note).map(BackgroundJobsNote.summary)
    }

    func testSaysHowTheOneJobCameOut() {
        XCTAssertEqual(summary(BackgroundJobsFixtures.enEnded), "1 ended, exit 0")
        XCTAssertEqual(summary(BackgroundJobsFixtures.zhKilled), "1 killed")
    }

    func testCountsTheSectionsWhenThereIsMoreThanOneJob() {
        XCTAssertEqual(summary(BackgroundJobsFixtures.enRunningAndEnded), "1 running, 1 ended")
        XCTAssertEqual(summary(BackgroundJobsFixtures.zhMultilineCommand), "3 running")
    }

    // MARK: what one row says

    func testARowSaysItsOutcomeItsNameAndItsIds() {
        let ended = BackgroundJobsText.parse(BackgroundJobsFixtures.zhEnded)?.ended.first
        let killed = BackgroundJobsText.parse(BackgroundJobsFixtures.zhKilled)?.ended.first
        let stopped = BackgroundJobsText.parse(BackgroundJobsFixtures.zhNoEnd)?.ended.first
        let running = BackgroundJobsText.parse(BackgroundJobsFixtures.enRunningAndEnded)?.running.first

        XCTAssertEqual(ended.map(BackgroundJobsNote.outcome), "exit 0")
        XCTAssertEqual(killed.map(BackgroundJobsNote.outcome), "killed · drain_cap")
        XCTAssertEqual(stopped.map(BackgroundJobsNote.outcome), "stopped · 没有结束报告")
        // Still running: the glyph has already said so, and there is no outcome to report.
        XCTAssertEqual(running.map(BackgroundJobsNote.outcome), "")

        XCTAssertEqual(ended.map(BackgroundJobsNote.mark), .ok)
        XCTAssertEqual(killed.map(BackgroundJobsNote.mark), .failed)
        XCTAssertEqual(stopped.map(BackgroundJobsNote.mark), .failed)
        XCTAssertEqual(running.map(BackgroundJobsNote.mark), .running)

        XCTAssertEqual(ended.map(BackgroundJobsNote.name),
                       "/root/orbit/.claude/skills/upgrade/upgrade.sh 2>&1")
        XCTAssertEqual(ended.map(BackgroundJobsNote.meta), "bgj_0f012a1b9d50 · job")
    }

    /// The two sentences addressed to the agent, the absolute output paths and the Monitor section
    /// are the block's, not the rows' — a reader who wants them opens the fold.
    func testTheRowsCarryNoneOfTheNarrationOrThePaths() {
        for (name, block) in BackgroundJobsFixtures.all {
            guard let jobs = BackgroundJobsText.parse(block) else {
                XCTFail("\(name) parsed as nothing")
                continue
            }
            for job in jobs.running + jobs.ended {
                let row = [BackgroundJobsNote.name(job), BackgroundJobsNote.outcome(job),
                           BackgroundJobsNote.meta(job)].joined(separator: " ")
                for narration in ["这是控制面替你记下的", "The control plane recorded this for you",
                                  "mcp__orbit__bg_output", "/root/.orbit/runs/", "Monitor"] {
                    XCTAssertFalse(row.contains(narration),
                                   "\(name): a row says \(narration.debugDescription) — it belongs "
                                       + "to the fold under the rows, not to the row")
                }
            }
            XCTAssertTrue(jobs.text.contains("</background-jobs>"),
                          "\(name): the fold keeps the block whole")
        }
    }
}

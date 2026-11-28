import Foundation
import XCTest
@testable import OrbitKit

/// The task card in a task's own run conversation (docs/task-run-sidebar-design.md): the web column's
/// block order and rules (`TaskRunSidebar.test.tsx`), and the shared reason table's cases
/// (`src/shared/src/taskStatusReason.spec.ts`), each here.
final class TaskRunCardTests: XCTestCase {
    private func task(_ json: String) -> TaskItem {
        try! JSONDecoder().decode(TaskItem.self, from: Data(json.utf8))
    }

    private func run(_ json: String) -> SessionRef {
        try! JSONDecoder().decode(SessionRef.self, from: Data(json.utf8))
    }

    private func said(_ json: String) -> String? { TaskStatusReason.failure(run(json))?.text }

    // MARK: the shared reason table

    func testItNamesTheNewestAcceptanceRoundThatDisagreedWithItsCode() {
        XCTAssertEqual(said("""
        {"id":"S","acceptanceRounds":[
          {"id":"r2","turnId":"t2","exitCode":1,"expectedExitCode":0,"finishedAt":"2026-11-26T06:53:00.000Z"},
          {"id":"r1","turnId":"t1","exitCode":0,"expectedExitCode":0,"finishedAt":"2026-11-26T06:00:00.000Z"}]}
        """), "check exited 1")
        XCTAssertEqual(said("""
        {"id":"S","acceptanceRounds":[{"id":"r","turnId":"t","exitCode":null,"expectedExitCode":0,"finishedAt":"x"}]}
        """), "check exited -1")
    }

    func testItReadsTheApiserverSentenceWhenNoRoundIsListed() {
        XCTAssertEqual(said(#"{"id":"S","error":"acceptance command exited 2; expected 0"}"#), "check exited 2")
    }

    func testItNamesALostRunnerABudgetAStopAndAnInterruption() {
        XCTAssertEqual(said(#"{"id":"S","error":"runner offline"}"#), "runner lost")
        XCTAssertEqual(said(#"{"id":"S","error":"the run went over budget"}"#), "over budget")
        XCTAssertEqual(said(#"{"id":"S","endReason":"cancelled"}"#), "run stopped")
        XCTAssertEqual(said(#"{"id":"S","lastTurnOutcome":"CANCELLED"}"#), "run stopped")
        XCTAssertEqual(said(#"{"id":"S","lastTurnOutcome":"INTERRUPTED"}"#), "run interrupted")
    }

    func testItFallsBackToRunFailedAndSaysNothingWithoutACause() {
        XCTAssertEqual(said(#"{"id":"S","error":"engine crashed"}"#), "run failed")
        XCTAssertEqual(said(#"{"id":"S","lastTurnOutcome":"FAILED"}"#), "run failed")
        XCTAssertNil(said("""
        {"id":"S","lastTurnOutcome":"ANSWERED",
         "acceptanceRounds":[{"id":"r","turnId":"t","exitCode":0,"expectedExitCode":0,"finishedAt":"x"}]}
        """))
        XCTAssertNil(TaskStatusReason.failure(nil))
    }

    // MARK: the card's blocks

    func testTheBlocksAreTheWebColumnsInItsOrder() {
        XCTAssertEqual(TaskRunCardLogic.blocks(state: .failed, hasBranch: true, hasRuns: true),
                       [.head, .state, .branch, .doneMeans, .runs, .runsWith, .activity])
        XCTAssertEqual(TaskRunCardLogic.blocks(state: nil, hasBranch: false, hasRuns: false),
                       [.head, .doneMeans, .runsWith, .activity])
    }

    func testTheStateBlockIsTheSettledOneFirst() {
        XCTAssertEqual(TaskRunCardLogic.state(status: .done, needsYou: true, running: true), .done)
        XCTAssertEqual(TaskRunCardLogic.state(status: .failed, needsYou: false, running: true), .failed)
        XCTAssertEqual(TaskRunCardLogic.state(status: .inProgress, needsYou: true, running: true), .needsYou)
        XCTAssertEqual(TaskRunCardLogic.state(status: .inProgress, needsYou: false, running: true), .running)
        XCTAssertNil(TaskRunCardLogic.state(status: .open, needsYou: false, running: false))
    }

    func testTheCardIsDrawnOnlyOverOneOfTheTasksOwnRuns() {
        let t = task(#"{"id":"T","title":"t","status":"FAILED","sessions":[{"id":"S2"},{"id":"S1"}]}"#)
        let ownRun: [NavNode] = [.console(sessionID: "S1", origin: .list), .taskDetail(taskID: "T")]
        XCTAssertEqual(TaskRunCardLogic.hereRun(t, path: ownRun)?.id, "S1")
        let other: [NavNode] = [.console(sessionID: "OTHER", origin: .list), .taskDetail(taskID: "T")]
        XCTAssertNil(TaskRunCardLogic.hereRun(t, path: other), "a link in another conversation opens the full page")
        XCTAssertNil(TaskRunCardLogic.hereRun(t, path: [.taskDetail(taskID: "T")]), "so does the Tasks list")
        let deeper: [NavNode] = [.console(sessionID: "S1", origin: .list), .taskDetail(taskID: "T"),
                                 .taskDetail(taskID: "U")]
        XCTAssertEqual(TaskRunCardLogic.hereRun(t, path: deeper)?.id, "S1",
                       "the task's own frame is found even when another page is over it")
    }

    func testThePillCarriesItsReason() {
        let failed = task("""
        {"id":"T","title":"t","status":"FAILED","sessions":[
          {"id":"S","createdAt":"2026-11-25T14:41:00.000Z","costUsd":1.32,"error":"acceptance command exited 1; expected 0"}]}
        """)
        let here = failed.sessions?.first
        XCTAssertEqual(TaskRunCardLogic.pill(failed, state: .failed, run: here, evidenceRevision: nil),
                       TaskPill(kind: .failed, label: "Failed · check exited 1"))
        XCTAssertEqual(TaskRunCardLogic.pill(failed, state: .needsYou, run: here, evidenceRevision: "1").label,
                       "Needs you · evidence r1")
        XCTAssertEqual(TaskRunCardLogic.pill(failed, state: .needsYou, run: here, evidenceRevision: nil).label, "Needs you")
        XCTAssertEqual(TaskRunCardLogic.meta(failed, state: .failed, run: here) { $0 == nil ? nil : "Nov 25" },
                       "Nov 25 · $1.32")
        let running = task("""
        {"id":"T","title":"t","status":"IN_PROGRESS","sessions":[{"id":"S","status":"RUNNING","costUsd":0.84}]}
        """)
        XCTAssertEqual(TaskRunCardLogic.meta(running, state: .running, run: running.sessions?.first) { _ in "x" },
                       "$0.84 so far")
    }

    func testDoneMeansIsAChecklistJudgedByTheNewestRound() {
        let round = try! JSONDecoder().decode(TaskAcceptanceRound.self, from: Data("""
        {"id":"r","turnId":"t","exitCode":1,"expectedExitCode":0,"finishedAt":"x"}
        """.utf8))
        let rows = TaskRunCardLogic.doneMeans(criteria: "- `npm test` passes\n- Full suite, 0 failed",
                                              command: "npm test", round: round, status: .failed, evidenceDecision: nil)
        XCTAssertEqual(rows.map(\.text), ["npm test", "`npm test` passes", "Full suite, 0 failed"])
        XCTAssertEqual(rows.map(\.glyph), ["✕", "○", "○"])
        XCTAssertEqual(rows.first?.code, true)
        let accepted = TaskRunCardLogic.doneMeans(criteria: "Upload retries\n3× on 5xx", command: nil, round: nil,
                                                  status: .inProgress, evidenceDecision: "CONFIRM")
        XCTAssertEqual(accepted.map(\.text), ["Upload retries 3× on 5xx"])
        XCTAssertEqual(accepted.map(\.mark), [.passed])
        XCTAssertEqual(TaskRunCardLogic.doneMeans(criteria: nil, command: "make", round: nil, status: .open,
                                                  evidenceDecision: nil).map(\.mark), [.pending])
    }

    func testTheLandingLineSaysWhatLandingWaitsOn() {
        XCTAssertEqual(TaskRunCardLogic.landingLine(landing: "Landed on main · 7c41e9", mergeStatus: nil,
                                                    mergeTarget: nil, main: "main", state: .done),
                       "Landed on main · 7c41e9")
        XCTAssertEqual(TaskRunCardLogic.landingLine(landing: nil, mergeStatus: "merged", mergeTarget: nil,
                                                    main: "main", state: .done), "Merged into main")
        XCTAssertEqual(TaskRunCardLogic.landingLine(landing: nil, mergeStatus: nil, mergeTarget: nil, main: "main",
                                                    state: .failed), "Not landed")
        XCTAssertEqual(TaskRunCardLogic.landingLine(landing: nil, mergeStatus: nil, mergeTarget: nil, main: "main",
                                                    state: .needsYou), "After you accept")
        XCTAssertEqual(TaskRunCardLogic.landingLine(landing: nil, mergeStatus: nil, mergeTarget: nil, main: "main",
                                                    state: .running), "After it's done")
    }

    func testTheNoteAndTheActivityLine() {
        XCTAssertEqual(TaskRunCardLogic.firstLine("\n  Machine load, not the code.\nMore."), "Machine load, not the code.")
        let creator = run(#"{"id":"C","title":"Polish the header share button"}"#)
        XCTAssertEqual(TaskRunCardLogic.activityLine(count: 4, filedFrom: creator),
                       "Activity · 4 · Filed from Polish the header share button")
        XCTAssertEqual(TaskRunCardLogic.activityLine(count: 2, filedFrom: nil), "Activity · 2")
    }

    func testRoundsAndSessionErrorsDecodeFromTheTaskDetail() {
        let t = task("""
        {"id":"T","title":"t","status":"FAILED","sessions":[{"id":"S","error":"runner offline","acceptanceRounds":[
          {"id":"r","turnId":"t","exitCode":1,"expectedExitCode":0,"branchSha":"432e94c0","finishedAt":"2026-11-26T06:53:00.000Z",
           "outputTail":"1 failed"}]}]}
        """)
        XCTAssertEqual(t.sessions?.first?.error, "runner offline")
        XCTAssertEqual(t.sessions?.first?.acceptanceRounds?.first?.branchSha, "432e94c0")
        XCTAssertEqual(TaskRunCardLogic.newestRound(t, run: nil)?.id, "r")
    }
}

/// The card's words are the web column's and the shared reason table's. Each is looked up in the
/// source it was ported from; a missing counterpart is a failure.
final class TaskRunCardCopyParityTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(relative) was not found above this test file")
        return ""
    }

    func testTheReasonsAreTheSharedTables() throws {
        let table = try source("src/shared/src/taskStatusReason.ts")
        XCTAssertTrue(table.contains("CHECK_EXITED: (exitCode: number) => `check exited ${exitCode}`"))
        XCTAssertEqual(TaskStatusReason.checkExited(7).text, "check exited 7")
        for (key, reason) in [("RUN_STOPPED", TaskStatusReason.runStopped), ("RUN_INTERRUPTED", .runInterrupted),
                              ("OVER_BUDGET", .overBudget), ("RUNNER_LOST", .runnerLost), ("RUN_FAILED", .runFailed)] {
            XCTAssertTrue(table.contains("\(key): '\(reason.text)'"), "\(key) says \(reason.text) on the web too")
        }
    }

    func testTheBlocksSayTheWebColumnsWords() throws {
        // JSX wraps its text: `> Retry the task <` is the button's words.
        let panel = try source("src/web/src/components/TaskDetailPanel.tsx")
            .replacingOccurrences(of: "> ", with: ">").replacingOccurrences(of: " <", with: "<")
        for words in [TaskRunCardCopy.kicker, TaskRunCardCopy.reviewTheEvidence, TaskRunCardCopy.accept,
                      TaskRunCardCopy.sendBack, TaskRunCardCopy.delivered, TaskRunCardCopy.whyItFailed,
                      TaskRunCardCopy.output, TaskRunCardCopy.rerunTheCheck, TaskRunCardCopy.retryTheTask,
                      TaskRunCardCopy.closeAsNotNeeded, TaskRunCardCopy.branch, TaskRunCardCopy.left,
                      TaskRunCardCopy.landing, TaskRunCardCopy.doneMeans, TaskRunCardCopy.criteriaTextBrief,
                      TaskRunCardCopy.runs, TaskRunCardCopy.edit] {
            XCTAssertTrue(panel.contains(">\(words)<"), "the web column draws \(words)")
        }
        for words in ["'Failed'", "`Needs you · evidence r${latestEvidence.revision}`", "'Needs you'",
                      "`${costLabel(liveRun?.costUsd)} so far`", "`Evidence r${latestEvidence.revision} accepted · ",
                      "`Check exited ${newestRound.exitCode} · ", "`Acceptance check · exit ${round.exitCode ?? 'none'}, expected ${round.expectedExitCode} · ",
                      "'It printed nothing.'", "`Latest note (${newestComment.authorName ?? 'Unknown'}, ",
                      "'Show less' : 'Read'", "'Hide' : 'Show'", "`In ${mainBranch}`", "`${branchCommits.length} ahead`",
                      "{branchCommits.length - 3} more", "`Merged into ${", "'Not landed'", "'After you accept'",
                      "\"After it's done\"", "<strong>Run {sessions.length - i}</strong>", ">· this conversation<",
                      "`Activity · ${activity.length}`", "` · Filed from ${q.data.creatorSession.title || 'Untitled session'}`",
                      "vs {mainBranch}"] {
            XCTAssertTrue(panel.contains(words), "the web column writes \(words)")
        }
    }
}

/// The iPhone draws the card from the logic: over one of the task's own runs, the blocks in its order,
/// each one of the page's own sections.
final class TaskRunCardWiringTests: XCTestCase {
    private func view() throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp/Views/TasksView.swift")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("TasksView.swift was not found")
        return ""
    }

    func testTheTaskPageIsTheCardOverItsOwnRun() throws {
        let source = try view()
        XCTAssertTrue(source.contains("if !cardFullPage, let here = TaskRunCardLogic.hereRun(task, path: model.nav.path) {"))
        XCTAssertTrue(source.contains("ForEach(TaskRunCardLogic.blocks(state: state, hasBranch: cardSession?.branch != nil,"))
        XCTAssertTrue(source.contains("if let run = TaskDetailLogic.liveRun(task) { nowSection(task, run) }"),
                      "Running is the page's own Now")
        XCTAssertTrue(source.contains("acceptanceSection(task)\n                briefSection(task)"),
                      "the criteria text and the brief fold behind Show")
        XCTAssertTrue(source.contains("Task { _ = await tasks.rerunCheck(task.id) }"))
        XCTAssertTrue(source.contains("Task { await tasks.setStatus(task.id, .cancelled) }"))
    }
}

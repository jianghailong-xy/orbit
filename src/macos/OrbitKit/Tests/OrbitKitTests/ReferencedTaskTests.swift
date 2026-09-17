import XCTest
@testable import OrbitKit

/// Reading the blocks delivery appends for a person's `#`-references.
///
/// Held to the wording the apiserver writes (tasks/reference-expansion.ts `describeTask`) and proved
/// against this deployment's own notes, copied out of `run_event` (`ReferencedTaskFixtures`) —
/// including the note that carries eight of them and the one that shares a note with the inventory a
/// returning engine was handed.
///
/// The browser proves the same notes with the same expectations (referencedTask.test.ts); two ends
/// reading one block differently is exactly what `ReferencedTaskCopyParityTests` is for.
final class ReferencedTaskTests: XCTestCase {

    func testReadsEveryFieldOfOneBlockIdIncluded() {
        let parsed = ReferencedTaskText.parse(ReferencedTaskFixtures.oneTask)

        XCTAssertEqual(parsed?.tasks, [
            ReferencedTask(id: "34OEE9MQXMEm0h0Ptm1GG",
                           title: "runner 从项目集成线的 tip 创建 worktree",
                           status: "FAILED",
                           suffixes: [],
                           list: "(无列表)",
                           assignee: "orbit",
                           runs: 1,
                           executed: 1,
                           // The classified cause rides along with the status, in the block's words.
                           lastRun: "FAILED (unattributed), 31 turns"),
        ])
        XCTAssertEqual(parsed?.rest, "")
    }

    func testKeepsATaskNobodyHasRunAndNobodyOwnsAsTheBlockPutIt() {
        let task = ReferencedTaskText.parse(ReferencedTaskFixtures.neverRan)?.tasks.first

        XCTAssertEqual(task?.status, "OPEN")
        XCTAssertEqual(task?.runs, 0)
        XCTAssertEqual(task?.executed, 0)
        XCTAssertEqual(task?.list, "(无列表)")
        XCTAssertEqual(task?.assignee, "(未指派)")
        XCTAssertEqual(task?.lastRun, "从未运行")
    }

    func testTellsAStatusFromWhatTheLineSaysAfterItAndTranslatesNeither() {
        let tasks = ReferencedTaskText.parse(ReferencedTaskFixtures.twoTasks)?.tasks

        XCTAssertEqual(tasks?.first?.status, "DONE")
        XCTAssertEqual(tasks?.first?.suffixes, ["验收任务"])
        // The evidence question: a session exists, and it has never taken a turn.
        XCTAssertEqual(tasks?.last?.runs, 1)
        XCTAssertEqual(tasks?.last?.executed, 0)
        XCTAssertEqual(tasks?.last?.lastRun, "RUNNING, 0 turns")
    }

    func testReadsAllEightOfTheMostAnyoneHasReferencedAtOnce() {
        let parsed = ReferencedTaskText.parse(ReferencedTaskFixtures.eightTasks)

        XCTAssertEqual(parsed?.tasks.map(\.id), [
            "34ONkD7V6aKjyLdHXyimz", "34OAsTIS8JuGm5H2j95qO", "34NcCcju6ItuCcHBoeaqd",
            "34NaYaztogra0gaMFo4mY", "34NaebW9aR15Mr8WrYyV5", "34Nb44UnFuiGKvXwWfxFY",
            "34NJZsv3am8LrTpZ4jc09", "34DH29mTc7OQ6AwxAFIJu",
        ])
        // Nothing of the note is left over: eight blocks and the blank lines between them.
        XCTAssertEqual(parsed?.rest, "")
        XCTAssertEqual(parsed?.tasks[6].status, "OPEN")
        XCTAssertEqual(parsed?.tasks[7].suffixes, ["验收任务"])
    }

    func testHandsAnotherBlockInTheSameNoteBackUntouched() {
        let parsed = ReferencedTaskText.parse(ReferencedTaskFixtures.withBackgroundJobs)

        XCTAssertEqual(parsed?.tasks.map(\.title), ["Claude QA 复验：Watch 核心后端（D1/D2/D2b 修复后）"])
        XCTAssertEqual(parsed?.rest.hasPrefix("<background-jobs>"), true)
        XCTAssertEqual(parsed?.rest.hasSuffix("</background-jobs>"), true)
        // And the inventory reads its own block out of the same note, neither taking the other's.
        XCTAssertEqual(BackgroundJobsText.parse(ReferencedTaskFixtures.withBackgroundJobs)?.ended.count, 1)
    }

    func testLeavesABlockThatIsNotThisShapeToTheTextItAlwaysWas() {
        let missingField = ReferencedTaskFixtures.oneTask
            .replacingOccurrences(of: "  运行   共", with: "  运行了   共")
        let notAnId = ReferencedTaskFixtures.oneTask
            .replacingOccurrences(of: "34OEE9MQXMEm0h0Ptm1GG\">", with: "task 34OEE9MQXMEm0h0Ptm1GG\">")

        // Nil, not a card with a blank row: the note keeps the shape it has always had.
        XCTAssertNil(ReferencedTaskText.parse(missingField))
        XCTAssertNil(ReferencedTaskText.parse(notAnId))
        XCTAssertNil(ReferencedTaskText.parse(nil))
        // A list reference is a shape this deployment has never sent one of, and nobody guesses.
        XCTAssertNil(ReferencedTaskText.parse(
            "<referenced-list id=\"34OEE9MQXMEm0h0Ptm1GG\">\n  标题   x\n</referenced-list>"))
    }

    func testDrawsTheBlocksItCanReadAndLeavesBesideThemTheOneItCannot() {
        let unreadable = ReferencedTaskFixtures.oneTask
            .replacingOccurrences(of: "  标题   runner", with: "  名称   runner")
        let note = "\(unreadable)\n\n\(ReferencedTaskFixtures.neverRan)"

        let parsed = ReferencedTaskText.parse(note)

        XCTAssertEqual(parsed?.tasks.map(\.id), ["349vy0HknpSjHwdwJ31O1"])
        XCTAssertEqual(parsed?.rest, unreadable)
    }

    // MARK: the line that names the note folded

    func testSaysTheStateOfALoneTaskOutrightAndCountsSeveral() {
        let summary = { (note: String) in
            ReferencedTaskNote.summary(ReferencedTaskText.parse(note)?.tasks ?? [])
        }

        XCTAssertEqual(summary(ReferencedTaskFixtures.oneTask), "FAILED")
        XCTAssertEqual(summary(ReferencedTaskFixtures.neverRan), "OPEN")
        XCTAssertEqual(summary(ReferencedTaskFixtures.eightTasks), "7 DONE, 1 OPEN")
        XCTAssertEqual(summary(ReferencedTaskFixtures.twoTasks), "1 DONE, 1 OPEN")
    }

    // MARK: what a card says

    func testACardSaysTheOutcomeTheIdsAndHowManyRuns() {
        let tasks = ReferencedTaskText.parse(ReferencedTaskFixtures.twoTasks)?.tasks ?? []
        let never = ReferencedTaskText.parse(ReferencedTaskFixtures.neverRan)?.tasks.first

        XCTAssertEqual(ReferencedTaskNote.outcome(tasks[0]), "SUCCEEDED, 144 turns")
        XCTAssertEqual(ReferencedTaskNote.meta(tasks[0]),
                       "34DH29mTc7OQ6AwxAFIJu · (无列表) · orbit · 1 run")
        // A run that took no turn says so; a task nothing has run has no outcome to show at all.
        XCTAssertEqual(ReferencedTaskNote.meta(tasks[1]),
                       "34NNZFNbWKndTBsVbh8jc · (无列表) · orbit · 1 run, 0 with turns")
        XCTAssertEqual(ReferencedTaskNote.outcome(never!), "")
        XCTAssertEqual(ReferencedTaskNote.meta(never!),
                       "349vy0HknpSjHwdwJ31O1 · (无列表) · (未指派) · never run")
        XCTAssertEqual(ReferencedTaskNote.link(tasks[0])?.absoluteString,
                       "orbit-task:34DH29mTc7OQ6AwxAFIJu")
        // The link is one this app routes rather than hands to the system browser.
        XCTAssertEqual(ReferenceLink.route(ReferencedTaskNote.link(tasks[0])!), .task("34DH29mTc7OQ6AwxAFIJu"))
    }
}

import Foundation
import XCTest
@testable import OrbitKit

/// A task run's opening turn is drawn from the task the control plane recorded beside the echo
/// (`taskStart`) — never from the brief the agent was sent.
///
/// The brief is written for the AGENT: the task, then four steps of protocol about which tools to call
/// and which statuses never to write. Drawn as a message it was the owner's own bubble, several
/// screens on a phone. These tests are the client half of the pair the web is held to
/// (`TaskStartCard.test.tsx`): with the payload the card is drawn from fields, and without one the
/// turn is exactly the bubble it was before any of this existed. `TaskStartCopyParityTests` holds the
/// words to the browser's.
final class TaskStartTests: XCTestCase {

    // MARK: - the payload, as the apiserver writes it (tasks/task-start-card.ts `readTaskStartCard`)

    /// One `user` event exactly as the server stores it, decoded through `RunEvent` so what is
    /// asserted is the wire path a client actually gets.
    private func started(_ card: String?, text: String = TaskStartTests.brief) throws -> RunEvent {
        let payload = card.map { "{\"text\": \(Self.jsonString(text)), \"taskStart\": \($0)}" }
            ?? "{\"text\": \(Self.jsonString(text))}"
        let json = """
            {"seq": 1, "type": "user", "turnId": "turn-1", "ts": "2026-09-23T09:48:42.000Z",
             "payload": \(payload)}
            """
        return try JSONDecoder().decode(RunEvent.self, from: Data(json.utf8))
    }

    private static func jsonString(_ text: String) -> String {
        String(decoding: try! JSONEncoder().encode(text), as: UTF8.self)
    }

    /// The brief as the agent reads it (tasks.service.ts `buildTaskExecutionPrompt`), abridged.
    static let brief = """
        请开始执行任务「runner + web：配额按账户归属」。

        任务描述：
        让每个账户的 plan usage 只进它自己那一行。

        请按以下步骤进行：
        1. 先用 task_get 查看该任务的完整信息与历史评论。
        """

    /// The same card as the web suite's `CARD`, field for field.
    private let card = """
        {"taskId": "01a0cca7-8609-70ed-a0e2-d4b55b832b60",
         "title": "runner + web：配额按账户归属",
         "description": "让每个账户的 plan usage 只进它自己那一行。\\n\\n背景：二值判断。",
         "acceptanceCriteria": "配额按账户归属：每个账户的 plan usage 只进它自己那一行。",
         "completionCriterion": "EXECUTABLE",
         "acceptanceCommand": "go test ./... -run TestCodexAccountQuota",
         "acceptanceExpectedExitCode": 0,
         "listInstructions": null,
         "project": {"id": "01a0cca0-aeaa-7618-bd5a-caccc089108c",
                     "title": "Codex 多账户：一台机器上登录多个 Codex"},
         "auto": true}
        """

    private func bubble(_ reducer: TranscriptReducer) throws -> UserBubble {
        try XCTUnwrap(reducer.state.items.first.flatMap { item -> UserBubble? in
            guard case .user(let b) = item else { return nil }
            return b
        })
    }

    // MARK: - (a) reading the payload

    func testReadsEveryFieldOfACard() throws {
        let start = try XCTUnwrap(TaskStart.parse(try started(card).payload))

        XCTAssertEqual(start, TaskStart(
            taskId: "01a0cca7-8609-70ed-a0e2-d4b55b832b60",
            title: "runner + web：配额按账户归属",
            description: "让每个账户的 plan usage 只进它自己那一行。\n\n背景：二值判断。",
            acceptanceCriteria: "配额按账户归属：每个账户的 plan usage 只进它自己那一行。",
            completionCriterion: .executable,
            acceptanceCommand: "go test ./... -run TestCodexAccountQuota",
            acceptanceExpectedExitCode: 0,
            listInstructions: nil,
            project: TaskStartProject(id: "01a0cca0-aeaa-7618-bd5a-caccc089108c",
                                      title: "Codex 多账户：一台机器上登录多个 Codex"),
            auto: true))
    }

    func testIsACardOnlyWithItsTaskAndTitle() throws {
        for value in ["null", "\"not an object\"", "{\"title\": \"x\"}", "{\"taskId\": \"t\"}",
                      "{\"taskId\": \"\", \"title\": \"x\"}", "{\"taskId\": \"t\", \"title\": \"\"}"] {
            XCTAssertNil(TaskStart.parse(try started(value).payload), value)
        }
        XCTAssertNil(TaskStart.parse(try started(nil).payload))
    }

    func testDefaultsWhatThePayloadLeftOutAndDropsWhatItDoesNotKnow() throws {
        let start = try XCTUnwrap(TaskStart.parse(try started("""
            {"taskId": "t", "title": "x", "completionCriterion": "SOMETHING_NEW",
             "project": {"title": "no id"}, "acceptanceExpectedExitCode": "0"}
            """).payload))

        XCTAssertNil(start.completionCriterion, "a criterion this build does not know is not guessed")
        XCTAssertNil(start.project)
        XCTAssertNil(start.acceptanceExpectedExitCode)
        XCTAssertNil(start.description)
        XCTAssertFalse(start.auto)
    }

    // MARK: - (b) the reducer: with a card the turn carries it, without one it is the bubble it was

    func testABriefWithNoCardStaysTheMessageItAlwaysWas() throws {
        var reducer = TranscriptReducer()
        reducer.apply(try started(nil))

        let b = try bubble(reducer)
        XCTAssertNil(b.taskStart)
        XCTAssertEqual(b.text, Self.brief, "the echo is left exactly as it was")
        XCTAssertEqual(StickySummary.of(text: b.text, note: b.note, itemCard: b.itemCard,
                                        taskStart: b.taskStart).label, StickySummary.yourQuestion)
    }

    func testABriefWithACardCarriesItKeepsTheBriefAndNamesTheBar() throws {
        var reducer = TranscriptReducer()
        reducer.apply(try started(card))

        let b = try bubble(reducer)
        XCTAssertEqual(b.taskStart?.taskId, "01a0cca7-8609-70ed-a0e2-d4b55b832b60")
        XCTAssertEqual(b.text, Self.brief, "the brief the agent read is folded, not dropped")

        let summary = StickySummary.of(text: b.text, note: b.note, itemCard: b.itemCard,
                                       taskStart: b.taskStart)
        XCTAssertEqual(summary.label, "↑ Task started")
        XCTAssertEqual(summary.text, "runner + web：配额按账户归属")
    }

    /// A cached transcript written before the card existed rehydrates with the bubble it had, and one
    /// written with the card keeps it.
    func testASnapshotFromBeforeTheCardStillRehydrates() throws {
        let snapshot = #"""
            {"state":{"items":[{"user":{"_0":{"id":"i1","text":"请开始执行任务「…」","attachments":[],
              "pending":false,"queued":false,"undelivered":false,"steer":false}}}],
              "pendingApprovals":[],"background":[],"queued":[],"status":"AWAITING_INPUT","maxSeq":1},
             "seen":[1],"idSeq":1}
            """#
        let restored = try JSONDecoder().decode(TranscriptReducer.self, from: Data(snapshot.utf8))
        XCTAssertNil(try bubble(restored).taskStart)

        var live = TranscriptReducer()
        live.apply(try started(card))
        let round = try JSONDecoder().decode(TranscriptReducer.self, from: JSONEncoder().encode(live))
        XCTAssertEqual(try bubble(round).taskStart, try bubble(live).taskStart)
        XCTAssertNotNil(try bubble(round).taskStart)
    }

    // MARK: - (c) what the card says

    func testSaysHowTheRunIsJudgedInThePanelsWords() throws {
        let base = try XCTUnwrap(TaskStart.parse(try started(card).payload))
        func with(_ criterion: TaskStartCriterion?, exit: Int? = 0) -> TaskStart {
            TaskStart(taskId: base.taskId, title: base.title, completionCriterion: criterion,
                      acceptanceCommand: base.acceptanceCommand, acceptanceExpectedExitCode: exit)
        }

        for criterion in TaskStartCriterion.allCases {
            XCTAssertEqual(TaskStartCard.judgedBy(with(criterion)),
                           TaskJudgmentCopy.completionCriterionChip[criterion.rawValue])
            XCTAssertNotNil(TaskStartCard.judgedHow(with(criterion)))
        }
        XCTAssertEqual(TaskStartCard.judgedHow(with(.executable, exit: 3)),
                       "Runs after each turn: exit 3 → Done, else Failed.")
        XCTAssertNil(TaskStartCard.judgedBy(with(nil)), "no chip for a judgment nobody declared")
        XCTAssertNil(TaskStartCard.judgedHow(with(nil)))
        // The command is only the judge of an EXECUTABLE task.
        XCTAssertEqual(TaskStartCard.command(with(.executable)), "go test ./... -run TestCodexAccountQuota")
        XCTAssertNil(TaskStartCard.command(with(.ownerConfirmed)))
    }

    func testFoldsOnlyADescriptionThatDoesNotFitAndOffersDetailsOnlyWhenThereAreAny() {
        let short = TaskStart(taskId: "t", title: "x", description: "一行就说完的描述。")
        XCTAssertFalse(TaskStartCard.foldsDescription(short))
        XCTAssertFalse(TaskStartCard.hasDetails(short), "nothing is behind Show details")

        let paragraphs = TaskStart(taskId: "t", title: "x", description: "第一段。\n\n第二段。")
        XCTAssertTrue(TaskStartCard.foldsDescription(paragraphs))
        let long = TaskStart(taskId: "t", title: "x",
                             description: String(repeating: "长", count: TaskStartCard.descriptionFoldChars + 1))
        XCTAssertTrue(TaskStartCard.foldsDescription(long))

        XCTAssertTrue(TaskStartCard.hasDetails(TaskStart(taskId: "t", title: "x", acceptanceCriteria: "判据")))
        XCTAssertTrue(TaskStartCard.hasDetails(TaskStart(taskId: "t", title: "x", listInstructions: "作业指导")))
        XCTAssertTrue(TaskStartCard.hasDetails(TaskStart(taskId: "t", title: "x", completionCriterion: .executable,
                                                         acceptanceCommand: "true")))
        XCTAssertFalse(TaskStartCard.hasDetails(TaskStart(taskId: "t", title: "x", completionCriterion: .ownerConfirmed,
                                                          acceptanceCommand: "true")))
    }

    func testNamesTheTaskInThePublicSpellingAndLinksToItAndItsProject() throws {
        let start = try XCTUnwrap(TaskStart.parse(try started(card).payload))
        let now = ISO8601DateFormatter().date(from: "2026-09-23T09:50:42Z")!

        XCTAssertEqual(TaskStartCard.meta(start, ts: "2026-09-23T09:48:42.000Z", now: now),
                       "Task \(PublicID.toPublic("01a0cca7-8609-70ed-a0e2-d4b55b832b60")) · 2m ago")
        XCTAssertEqual(TaskStartCard.meta(start), "Task \(PublicID.toPublic(start.taskId))")
        XCTAssertEqual(TaskStartCard.taskLink(start)?.absoluteString,
                       "orbit-task:01a0cca7-8609-70ed-a0e2-d4b55b832b60")
        XCTAssertEqual(TaskStartCard.projectLink(start)?.absoluteString,
                       "orbit-project:01a0cca0-aeaa-7618-bd5a-caccc089108c")
        // An id that names nothing is drawn as the words it is, not as a link that could only fail.
        XCTAssertNil(TaskStartCard.taskLink(TaskStart(taskId: "not-an-id", title: "x")))
        XCTAssertNil(TaskStartCard.projectLink(TaskStart(taskId: "t", title: "x")))
    }
}

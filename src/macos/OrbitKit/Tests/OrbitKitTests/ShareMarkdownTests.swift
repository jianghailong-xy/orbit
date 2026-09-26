import XCTest
@testable import OrbitKit

/// Copy as Markdown on a task and on a project (docs/share-links-design.md §8) writes what the web's
/// does. The fixtures are the web tests' own (`TaskDetailPanel.share.test.tsx`,
/// `ProjectShareControls.test.tsx`), decoded from the JSON the owner's reads answer with, so the two
/// ends are checked against the same expected text.
final class ShareMarkdownTests: XCTestCase {

    private static let taskLink = "https://orbitd.io/tasks/34UozoiaJIsxCZj728bfe"
    private static let projectLink = "https://orbitd.io/projects/34UonbgOiq9ajX8aH3JPz"

    private func task(_ json: String) throws -> TaskItem {
        try JSONDecoder().decode(TaskItem.self, from: Data(json.utf8))
    }

    /// `GET /tasks/:id` as the web test's DETAIL: done, judged by evidence, a command, one
    /// prerequisite and one dependent, a run and a run in the Trash.
    private static let detail = """
        {"id":"34UozoiaJIsxCZj728bfe","title":"T6 安全边界：跨 owner、准入与凭据不外泄的回归断言",
         "status":"DONE","terminalReason":null,"completionCriterion":"EVIDENCE_JUDGMENT",
         "acceptanceCriteria":"新增的安全边界断言全部为绿。","acceptanceCommand":"npm test",
         "acceptanceExpectedExitCode":0,"description":"What to do.","comments":[],
         "sessions":[
           {"id":"s1","title":"Run","status":"SUCCEEDED","createdAt":"2026-09-25T02:12:20.000Z",
            "workspace":{"name":"orbit"},"agent":{"name":"orbit"}},
           {"id":"s2","title":"Trashed","status":"FAILED","createdAt":"2026-09-24T02:12:20.000Z",
            "deletedAt":"2026-09-24T03:00:00.000Z","workspace":{"name":"orbit"},"agent":{"name":"orbit"}}],
         "dependsOn":[{"dependsOnTask":{"id":"a","title":"T3b 放开池 slug 的写入口","status":"DONE"}}],
         "dependedOnBy":[{"task":{"id":"b","title":"T7 合并边界","status":"OPEN"}}],
         "supersededByTaskIdAbsentReason":"NOT_SUPERSEDED","supersedes":[],"successorChain":[]}
        """

    func testTheTaskDetailCarriesWhatTheMarkdownReads() throws {
        let t = try task(Self.detail)
        XCTAssertEqual(t.acceptanceCriteria, "新增的安全边界断言全部为绿。")
        XCTAssertEqual(t.acceptanceCommand, "npm test")
        XCTAssertEqual(t.acceptanceExpectedExitCode, 0)
        XCTAssertEqual(t.supersededByTaskIdAbsentReason, "NOT_SUPERSEDED")
        XCTAssertEqual(t.supersedes, [])
        XCTAssertEqual(t.successorChain, [])
    }

    func testATaskIsItsTitleStatusAcceptanceDependenciesRunsAndLink() throws {
        let markdown = ShareMarkdown.task(try task(Self.detail), link: Self.taskLink,
                                          time: { $0 == "2026-09-25T02:12:20.000Z" ? "Sep 25, 2:12 AM" : "?" })
        XCTAssertEqual(markdown, [
            "# T6 安全边界：跨 owner、准入与凭据不外泄的回归断言",
            "",
            "**Status:** Done · Judged by submitted evidence",
            "**Link:** \(Self.taskLink)",
            "",
            "## Acceptance",
            "",
            "新增的安全边界断言全部为绿。",
            "",
            "Command: `npm test` — done when it exits `0`",
            "",
            "## Dependencies",
            "",
            "- Needs: T3b 放开池 slug 的写入口 — Done",
            "- Unblocks: T7 合并边界 — Open",
            "",
            "## Runs",
            "",
            "1 run",
            "",
            "- Succeeded · Sep 25, 2:12 AM · orbit",
            "",
        ].joined(separator: "\n"), "the run in the Trash is not one to send anybody to")
    }

    func testARunsTimeIsWrittenOutByDefault() throws {
        let markdown = ShareMarkdown.task(try task(Self.detail), link: Self.taskLink)
        let runs = try XCTUnwrap(markdown.range(of: "## Runs")).lowerBound
        let line = try XCTUnwrap(markdown[runs...].split(separator: "\n").last)
        XCTAssertTrue(line.hasPrefix("- Succeeded · "), String(line))
        XCTAssertTrue(line.hasSuffix(" · orbit"), String(line))
        XCTAssertFalse(line.contains("—"), "a readable start time, not the placeholder: \(line)")
    }

    func testABareTaskSaysWhatItLacks() throws {
        let markdown = ShareMarkdown.task(try task(#"{"id":"t","title":"Bare","status":"OPEN"}"#), link: "L")
        XCTAssertEqual(markdown, [
            "# Bare", "", "**Status:** Open", "**Link:** L", "", "## Acceptance", "", "No acceptance criteria set.",
            "", "## Dependencies", "", "No dependencies", "", "## Runs", "", "No runs yet", "",
        ].joined(separator: "\n"), "no criterion declared, no chip invented")
    }

    func testManyRunsAreCountedPastTheTenth() throws {
        let sessions = (0..<12).map {
            #"{"id":"s\#($0)","status":"FAILED","createdAt":"2026-09-2\#($0 % 9)T00:00:00.000Z"}"#
        }.joined(separator: ",")
        let markdown = ShareMarkdown.task(try task(#"{"id":"t","title":"T","status":"FAILED","sessions":[\#(sessions)]}"#),
                                          link: "L", time: { _ in "then" })
        XCTAssertTrue(markdown.contains("## Runs\n\n12 runs\n\n"))
        XCTAssertEqual(markdown.components(separatedBy: "- Failed · then\n").count - 1, 10)
        XCTAssertTrue(markdown.hasSuffix("- …and 2 earlier\n"))
    }

    func testWhatReplacedATaskOrWhatItReplaced() throws {
        func outcome(_ fields: String) throws -> String? {
            let markdown = ShareMarkdown.task(try task(#"{"id":"t","title":"T","status":"CANCELLED",\#(fields)}"#),
                                              link: "L")
            return markdown.split(separator: "\n").first { $0.hasPrefix("**Outcome:** ") }
                .map { String($0.dropFirst("**Outcome:** ".count)) }
        }
        XCTAssertEqual(try outcome(#""terminalReason":"SUPERSEDED","successorChain":[{"id":"n","title":"T8b"}]"#),
                       "Superseded by T8b")
        XCTAssertEqual(try outcome(#""terminalReason":"SUPERSEDED","successorChain":[{"id":"n","title":"T8b"},{"id":"m","title":"T8c"}]"#),
                       "Superseded — T8c is the live attempt, 2 replacements on")
        XCTAssertEqual(try outcome(#""terminalReason":"SUPERSEDED","supersededByTaskIdAbsentReason":"SUCCESSOR_DELETED""#),
                       "Superseded — the task that replaced it has been deleted")
        XCTAssertEqual(try outcome(#""terminalReason":"SUPERSEDED""#), "Superseded by a later attempt")
        XCTAssertEqual(try outcome(#""supersedes":[{"id":"o","title":"T8a"}]"#), "Replaces T8a")
        XCTAssertEqual(try outcome(#""supersedes":[{"id":"o","title":"A"},{"id":"p","title":"B"}]"#),
                       "Replaces 2 earlier attempts")
        XCTAssertNil(try outcome(#""terminalReason":null"#))

        let superseded = ShareMarkdown.task(try task(#"{"id":"t","title":"T","status":"CANCELLED","terminalReason":"SUPERSEDED","completionCriterion":"EXECUTABLE"}"#), link: "L")
        XCTAssertTrue(superseded.contains("**Status:** Superseded · Judged by its acceptance command\n"))
        XCTAssertEqual(ShareMarkdown.outcomeLabel(status: "CANCELLED", terminalReason: "ABANDONED"), "Abandoned")
    }

    // MARK: a project

    private static let document = ProjectDocument(
        id: "34UonbgOiq9ajX8aH3JPz", title: "Claude 账号池：按订阅配额均衡派发", status: .open,
        goal: "把一组同厂商的 Claude 订阅凭据表达成一个可派发的池身份。", taskCount: 12,
        acceptanceCriteriaItems: [
            ProjectCriterion(id: "c1", ordinal: 1, text: "同一 owner 的多行订阅可以归入一个池。", satisfied: true,
                             landing: "LANDED"),
            ProjectCriterion(id: "c2", ordinal: 2, text: "派发时选中窗口占用最低的那一行。", satisfied: true,
                             landing: "ON_INTEGRATION_LINE"),
            ProjectCriterion(id: "c3", ordinal: 3, text: "客户端能看到每个成员的占用。", satisfied: false,
                             landing: "UNKNOWN"),
        ])

    func testAProjectIsItsTitleProgressGoalCriteriaTasksAndLink() {
        let markdown = ShareMarkdown.project(
            Self.document, link: Self.projectLink,
            buckets: ProjectPanoramaBuckets(running: 2, done: 10),
            tasks: [ProjectTaskRow(id: "t8", title: "T8 收尾", status: "OPEN", workState: "RUNNING"),
                    ProjectTaskRow(id: "t6", title: "T6 安全边界", status: "DONE", workState: "DONE")])
        XCTAssertEqual(markdown, [
            "# Claude 账号池：按订阅配额均衡派发",
            "",
            "**Status:** Open · 12 tasks · 10 done, 2 running",
            "**Link:** \(Self.projectLink)",
            "",
            "## Goal",
            "",
            "把一组同厂商的 Claude 订阅凭据表达成一个可派发的池身份。",
            "",
            "## Acceptance criteria",
            "",
            "1. 同一 owner 的多行订阅可以归入一个池。 — Met by its work · on main",
            "2. 派发时选中窗口占用最低的那一行。 — Met by its work · on the project branch · not on main yet",
            "3. 客户端能看到每个成员的占用。 — Not met by its work",
            "",
            "## Tasks",
            "",
            "- T8 收尾 — Running",
            "- T6 安全边界 — Done",
            "",
        ].joined(separator: "\n"))
    }

    func testAProjectWithNothingReadYetSaysOnlyWhatItHas() {
        let bare = ProjectDocument(id: "p", title: "P", status: .done, taskCount: 1)
        XCTAssertEqual(ShareMarkdown.project(bare, link: "L"), [
            "# P", "", "**Status:** Completed · 1 task", "**Link:** L", "", "## Goal", "", "No goal set", "",
            "## Acceptance criteria", "", "No criteria are stated for this project.", "",
        ].joined(separator: "\n"), "no Tasks section until the page has read its tasks")
        XCTAssertTrue(ShareMarkdown.project(bare, link: "L", tasks: []).hasSuffix("## Tasks\n\nNo top-level tasks yet\n"))
        XCTAssertTrue(ShareMarkdown.project(bare, link: "L", buckets: ProjectPanoramaBuckets())
            .contains("**Status:** Completed · 1 task\n"), "a lane with nothing in it is not named")
    }
}

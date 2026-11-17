import Foundation
import XCTest
@testable import OrbitKit

/// The iPhone's text rules for the owner exception card (board docs/mocks/owner-card-ios-text,
/// D1–D3 = A): the settled-items fold, the failing lines Details shows in place of the output's
/// tail, the one-line subline, and the command "Copy command" copies.
final class OwnerCardPhoneTextTests: XCTestCase {

    private static let command =
        "cd src/apiserver && npx tsc -p tsconfig.test.json && SPECS=$(ls build/*/*.spec.js | grep -v '\\.pg\\.spec\\.js$') && node --test --test-concurrency=4 $SPECS"
    private static let title = "docs: 排队规则设计稿补「每条结论的来历」一节（情况 · 问题 · 修复）"

    /// A node test runner's output: one failure where it ran, the same failure again in the
    /// summary under its "✖ failing tests:" heading, and a TAP `not ok` line besides.
    private static let output = [
        "▶ queue rules",
        "  ✔ orders by priority (12ms)",
        "  \u{1B}[31m✖ no spec hand-rolls the $queryRaw calling conventions (158ms)\u{1B}[39m",
        "    AssertionError [ERR_ASSERTION]: 3 specs hand-roll it",
        "not ok 7 - landing check waits for the slot",
        "✖ refuses a second claim (4ms)",
        "✖ keeps the lease on a slow runner (9ms)",
        "ℹ tests 41",
        "ℹ fail 4",
        "✖ failing tests:",
        "",
        "✖ no spec hand-rolls the $queryRaw calling conventions (158ms)",
    ].joined(separator: "\n")

    private func row(kind: String = "INTEGRATION_ERROR", output: String? = OwnerCardPhoneTextTests.output,
                     title: String = OwnerCardPhoneTextTests.title) throws -> ProjectOpenItemRow {
        var check: [String: Any] = ["name": "MERGE_CHECK", "command": Self.command,
                                    "exitCode": 1, "durationMs": 372_000]
        if let output { check["outputTail"] = output }
        let json: [String: Any] = [
            "itemId": "01a0bb0b", "kind": kind, "title": "Integration error", "detailLine": "",
            "assignee": "OWNER", "assigneeReason": "ESCALATED",
            "waitingSince": "2026-11-16T09:00:00Z", "escalatedAt": "2026-11-16T11:00:00Z",
            "taskId": "01a03f58", "sessionId": "489fc485",
            "actions": ["ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "RETRY", "OPEN_LANDING"],
            "facts": ["task": ["id": "01a03f58", "title": title],
                      "targetRef": "project/queue-rules", "files": [String](),
                      "check": check],
        ]
        return try JSONDecoder().decode(ProjectOpenItemRow.self,
                                        from: JSONSerialization.data(withJSONObject: json))
    }

    // MARK: D2 = A — the failing lines

    func testDetailsShowsTheFailingLinesCappedAtThreeWithTheFullOutputCount() throws {
        let lines = try XCTUnwrap(ExceptionCards.failingLines(Self.output))
        XCTAssertEqual(lines.shown, [
            "✖ no spec hand-rolls the $queryRaw calling conventions (158ms)",
            "not ok 7 - landing check waits for the slot",
            "✖ refuses a second claim (4ms)",
        ], "✖ and `not ok` lines, trimmed and stripped of colour, in the order printed, at most three")
        XCTAssertEqual(ExceptionCards.FailingLines.shownMax, 3)
        XCTAssertEqual(lines.failing, 4,
                       "the summary's repeat and its \"✖ failing tests:\" heading are not counted again")
        XCTAssertEqual(lines.total, 12, "every line the output has, for the sheet")
        XCTAssertEqual(ExceptionCards.fullOutputLabel(lines.total), "Full output (12 lines)")
        XCTAssertEqual(ExceptionCards.fullOutputLabel(1), "Full output (1 line)")
        XCTAssertFalse(lines.all.joined().contains("\u{1B}"), "the sheet shows no ANSI codes")
    }

    func testAnOutputWithNoFailingLinesShowsNoneAndAnEmptyOneNothing() {
        let quiet = ExceptionCards.failingLines("compiling…\nerror TS2322: nope\n")
        XCTAssertEqual(quiet?.shown, [])
        XCTAssertEqual(quiet?.failing, 0)
        XCTAssertEqual(quiet?.total, 3)
        XCTAssertNil(ExceptionCards.failingLines("  \n "))
        XCTAssertNil(ExceptionCards.failingLines(nil))
    }

    func testTheFoldedSummaryNamesTheFailedCheckAndHowManyTestsFailed() throws {
        XCTAssertEqual(ExceptionCards.phoneDetailsSummary(try row()),
                       "Details · check failed · 4 failing tests")
        let one = try row(output: "✖ only this one (3ms)")
        XCTAssertEqual(ExceptionCards.phoneDetailsSummary(one), "Details · check failed · 1 failing test")
        XCTAssertEqual(ExceptionCards.phoneDetailsSummary(try row(output: nil)), "Details · check failed")
    }

    // MARK: rule 4 — clamped facts

    func testTheCommandCopiedIsTheWholeCommand() throws {
        let item = try row()
        XCTAssertEqual(ExceptionCards.commandCopyValue(item), Self.command)
        XCTAssertEqual(ExceptionCards.copyCommand, "Copy command")
        let details = ExceptionCards.phoneDetailRows(item, projectName: "Queue rules")
        let check = try XCTUnwrap(details.first { $0.label == ExceptionCards.checkLabel })
        XCTAssertEqual(check.value, Self.command, "the row is cut by the view, never by the model")
        XCTAssertEqual(check.runs.map(\.face), [.mono])
        XCTAssertNil(check.logTail, "the failing lines replace the tail")
        let failed = try XCTUnwrap(details.first { $0.label == ExceptionCards.failedLabel })
        XCTAssertEqual(failed.value, "exit 1 after 6m 12s")
        XCTAssertEqual(failed.runs.first?.face, .bad)
    }

    func testTheSublineIsOneLineAndTheWholeTitleLeadsDetails() throws {
        let item = try row(title: "docs: 排队规则设计稿补\n「每条结论的来历」一节")
        XCTAssertEqual(ExceptionCards.phoneSublineLines, 1)
        let subline = ExceptionCards.phoneSubline(item, projectName: nil)
        XCTAssertEqual(subline, "Integration error · docs: 排队规则设计稿补 「每条结论的来历」一节")
        XCTAssertFalse(subline.contains("\n"), "a clamp to one line has no second line to open")
        let details = ExceptionCards.phoneDetailRows(try row(), projectName: nil)
        XCTAssertEqual(details.first, ExceptionCards.FactRow(label: "Task", value: Self.title),
                       "the title the subline cuts is whole in Details")
        XCTAssertEqual(details.map(\.label).filter { $0 == "Task" }.count, 1)
        XCTAssertEqual(ExceptionCards.phoneStatusLines, 2)
    }

    // MARK: D1 = A — the settled fold

    private func card(_ itemID: String) -> TranscriptRow {
        .decisionCard(DeliveredDecisionCard(kind: .escalatedItem(itemID: itemID)))
    }

    func testSettledCardsAboveAnOpenOneFoldIntoOneRowThatExpandsInPlace() {
        let rows: [TranscriptRow] = [card("a"), card("b"), card("open"), .bottom]
        let standing: (String) -> SettledExceptionFold.Standing = {
            $0 == "open" ? .open : .settled(receipt: ExceptionCards.returned)
        }
        let runs = SettledExceptionFold.runs(rows, standing: standing)
        XCTAssertEqual(runs.count, 1)
        XCTAssertEqual(runs[0].count, 2)
        XCTAssertEqual(runs[0].headID, rows[0].id)
        XCTAssertEqual(runs[0].memberIDs, [rows[0].id, rows[1].id])
        XCTAssertEqual(runs[0].line, "2 sent back to the coordinator")

        let folded = SettledExceptionFold.fold(rows, runs: runs, expanded: [])
        XCTAssertEqual(folded.map(\.id), [rows[0].id, rows[2].id, rows[3].id],
                       "folded: one row in the run's place, then the open card")
        let opened = SettledExceptionFold.fold(rows, runs: runs, expanded: [runs[0].headID])
        XCTAssertEqual(opened.map(\.id), rows.map(\.id), "Show draws every settled card again, in place")
    }

    func testOnlyARunDirectlyAboveAnOpenCardFolds() {
        let rows: [TranscriptRow] = [card("a"), .bottom, card("b"), card("open"), card("c")]
        let runs = SettledExceptionFold.runs(rows) { $0 == "open" ? .open : .settled(receipt: nil) }
        XCTAssertEqual(runs.map(\.memberIDs), [[rows[2].id]],
                       "a settled card cut off by another row, or under the open one, stays as it is")
        XCTAssertEqual(runs[0].line, "1 no longer open")
        XCTAssertEqual(SettledExceptionFold.runs(rows) { _ in .settled(receipt: nil) }, [],
                       "nothing open, nothing folded")
    }

    func testAMixOfEndingsReadsSettled() {
        XCTAssertEqual(SettledExceptionFold.line(receipts: [ExceptionCards.returned, ExceptionCards.handled]),
                       "2 settled")
        XCTAssertEqual(SettledExceptionFold.line(receipts: [ExceptionCards.handled]), "1 marked as handled")
    }
}

import Foundation
import XCTest
@testable import OrbitKit

/// The rules of the task page led by the run (docs/mocks/task-detail-agent-first, boards 04–05),
/// each against the web panel's own cases (`TaskDetailPanel.test.tsx`, "the task page's words").
final class TaskDetailAgentFirstTests: XCTestCase {
    private func task(_ json: String) -> TaskItem {
        try! JSONDecoder().decode(TaskItem.self, from: Data(json.utf8))
    }

    private let now = RelativeTime.parse("2026-11-12T10:54:00.000Z")!

    func testItSaysHowLongAndHowMuch() {
        XCTAssertEqual(TaskDetailLogic.elapsedLabel("2026-11-12T10:53:30.000Z", now: now), "<1m")
        XCTAssertEqual(TaskDetailLogic.elapsedLabel("2026-11-12T10:47:00.000Z", now: now), "7m")
        XCTAssertEqual(TaskDetailLogic.elapsedLabel("2026-11-12T09:42:00.000Z", now: now), "1h 12m")
        XCTAssertEqual(TaskDetailLogic.elapsedLabel("2026-11-12T08:54:00.000Z", now: now), "2h")
        XCTAssertNil(TaskDetailLogic.elapsedLabel(nil, now: now))
        XCTAssertNil(TaskDetailLogic.costLabel(0))
        XCTAssertNil(TaskDetailLogic.costLabel(nil))
        XCTAssertEqual(TaskDetailLogic.costLabel(0.004), "<$0.01")
        XCTAssertEqual(TaskDetailLogic.costLabel(3.125), "$3.13")
    }

    func testOneStatusReadsRunningWithItsTimeAndTheRunsCost() {
        let running = task("""
        {"id":"T","title":"t","status":"OPEN","sessions":[
          {"id":"S","status":"RUNNING","createdAt":"2026-11-12T09:42:00.000Z","costUsd":0.84,"model":"claude-opus-5-5"},
          {"id":"R","status":"SUCCEEDED","createdAt":"2026-11-11T09:42:00.000Z","costUsd":2.16}]}
        """)
        XCTAssertEqual(TaskDetailLogic.headPill(running, now: now), TaskPill(kind: .running, label: "Running · 1h 12m"))
        XCTAssertEqual(TaskDetailLogic.totalCost(running), "$3.00")
        XCTAssertEqual(TaskDetailLogic.liveRun(running)?.id, "S")
        XCTAssertEqual(TaskDetailLogic.runRecipient(task("""
        {"id":"T","title":"t","status":"OPEN","assignee":{"id":"W"},"sessions":[{"id":"S","status":"RUNNING"}]}
        """)), "W")
        let idle = task(#"{"id":"T","title":"t","status":"DONE","assignee":{"id":"W"},"sessions":[{"id":"S","status":"SUCCEEDED"}]}"#)
        XCTAssertEqual(TaskDetailLogic.headPill(idle, now: now).label, "Done")
        XCTAssertNil(TaskDetailLogic.liveRun(idle))
        XCTAssertNil(TaskDetailLogic.runRecipient(idle), "no run going: an ordinary comment")
        XCTAssertNil(TaskDetailLogic.totalCost(idle), "a server without costUsd prints none")
    }

    func testTheCommentToTheRunMentionsItsWorkspaceOnce() {
        XCTAssertEqual(TaskDetailLogic.mentions(["A"], toRun: "W"), ["A", "W"])
        XCTAssertEqual(TaskDetailLogic.mentions(["W"], toRun: "W"), ["W"])
        XCTAssertEqual(TaskDetailLogic.mentions(["A"], toRun: nil), ["A"])
    }

    func testNowReadsTheReportedPosition() {
        let reported = task("""
        {"id":"T","title":"t","status":"OPEN","progress":{"revision":3,"phase":"One manager per host","current":3,
         "total":5,"message":"Editing manager.service.ts","lastProgressAt":"2026-11-12T10:50:00.000Z"}}
        """)
        let progress = try! XCTUnwrap(TaskDetailLogic.progress(reported))
        XCTAssertEqual(TaskDetailLogic.progressStep(progress), "Step 3 of 5")
        XCTAssertEqual(TaskDetailLogic.progressFraction(progress), 0.6)
        XCTAssertEqual(TaskDetailLogic.progressStep(TaskProgressView(current: 2, revision: 1)), "Step 2")
        XCTAssertNil(TaskDetailLogic.progressFraction(TaskProgressView(current: 2, revision: 1)))
        XCTAssertNil(TaskDetailLogic.progress(task(#"{"id":"T","title":"t","status":"OPEN","progress":{"revision":0}}"#)),
                     "a task that never reported")
        XCTAssertNil(TaskDetailLogic.progress(task(#"{"id":"T","title":"t","status":"OPEN"}"#)), "an older server")
        // A malformed progress costs the page its Now card, never the task.
        XCTAssertNil(TaskDetailLogic.progress(task(#"{"id":"T","title":"t","status":"OPEN","progress":{"revision":"x"}}"#)))
    }

    func testDeliveredSaysWhatTheEvidenceIsAndWhoDecidedIt() throws {
        let rows = try JSONDecoder().decode([TaskEvidenceRevision].self, from: Data("""
        [{"revision":"1","submittedAt":"2026-11-12T10:20:00.000Z","evidence":{"claim":"old"},
          "decision":{"decision":"SEND_BACK","note":"Show the tests","decidedAt":"2026-11-12T10:25:00.000Z","decidedByType":"AGENT"}},
         {"revision":"2","submittedAt":"2026-11-12T10:28:00.000Z",
          "evidence":{"claim":"Refuses peers outside allowPeers.","gaps":[],"checks":[
            {"kind":"TOOL_CALL","ref":"toolu_1","command":"python3 -m unittest","succeeded":true},
            {"kind":"COMMIT","ref":"7c41e9a0123456"},{"kind":"FILE","ref":"report.json"},{"kind":"TOOL_CALL","ref":"toolu_2"}]},
          "decision":{"decision":"CONFIRM","decidedAt":"2026-11-12T10:31:00.000Z","decidedByType":"USER"}},
         {"revision":3,"evidence":"not an object"}]
        """.utf8))
        XCTAssertEqual(rows.map(\.revision), ["1", "2", "3"], "a number or a bad envelope still decodes")
        let when: (String?) -> String = { _ in "Nov 12, 10:31 AM" }
        XCTAssertEqual(TaskDetailLogic.evidenceOutcome(rows[0]).label, "Sent back")
        XCTAssertEqual(TaskDetailLogic.evidenceOutcome(rows[1]).label, "Accepted")
        XCTAssertEqual(TaskDetailLogic.evidenceOutcome(rows[2]).label, "Awaiting a decision")
        XCTAssertEqual(TaskDetailLogic.evidenceMeta(rows[1], when: when), "Evidence r2 · accepted by you · Nov 12, 10:31 AM")
        XCTAssertEqual(TaskDetailLogic.evidenceMeta(rows[0], when: when),
                       "Evidence r1 · sent back by a reviewing agent · Nov 12, 10:31 AM")
        XCTAssertEqual(TaskDetailLogic.evidenceMeta(rows[2], when: when), "Evidence r3 · submitted Nov 12, 10:31 AM")
        let checks = try XCTUnwrap(rows[1].evidence?.checks).map(TaskDetailLogic.evidenceCheckText)
        XCTAssertEqual(checks, ["python3 -m unittest", "Commit 7c41e9a01", "File report.json", "Tool call toolu_2"])
    }

    func testThePlanIsOneSentence() {
        XCTAssertEqual(TaskDetailLogic.planSentence(task(#"{"id":"T","title":"t","status":"OPEN"}"#)),
                       "Nothing blocks this task.")
        XCTAssertEqual(TaskDetailLogic.planSentence(task("""
        {"id":"T","title":"t","status":"OPEN","dependsOn":[{"dependsOnTask":{"id":"A","title":"a","status":"DONE"}}],
         "dependedOnBy":[{"task":{"id":"B","title":"Channel-host kit","status":"OPEN"}}]}
        """)), "Its prerequisite is done. “Channel-host kit” waits on it.")
        // Blocked: the notice above it already says so; only what waits on it is added.
        XCTAssertEqual(TaskDetailLogic.planSentence(task("""
        {"id":"T","title":"t","status":"OPEN","dependencyState":"BLOCKED",
         "dependsOn":[{"dependsOnTask":{"id":"A","title":"a","status":"OPEN"}}],
         "dependedOnBy":[{"task":{"id":"B","title":"A","status":"OPEN"}},{"task":{"id":"C","title":"B","status":"OPEN"}},
                         {"task":{"id":"D","title":"C","status":"DONE"}}]}
        """)), "“A” and 1 more wait on it.")
    }

    func testAttributionShowsOnlyWhenItSaysSomethingNew() throws {
        let quiet = try JSONDecoder().decode(TaskAttribution.self, from: Data("""
        {"taskId":"T","owning":{"projectId":"P","title":"p","status":"OPEN"},"owningAbsentReason":null,
         "discovery":{"recorded":false,"authority":"EVIDENCE_ONLY","absentReason":"NO_DISCOVERY_RECORDED"},
         "crossing":null,"crossingAbsentReason":"NO_CROSSING_DECLARED","blocker":null,"blockerAbsentReason":"NOTHING_BLOCKING_ATTRIBUTION"}
        """.utf8))
        XCTAssertFalse(TaskDetailLogic.attributionNeedsCard(quiet, projectId: "P"), "the header's project again")
        XCTAssertTrue(TaskDetailLogic.attributionNeedsCard(quiet, projectId: "Q"), "counted somewhere else")
    }

    func testTheTimelineIsOldestFirst() throws {
        let filed = task("""
        {"id":"T","title":"t","status":"DONE","createdAt":"2026-11-12T09:35:00.000Z",
         "sessions":[{"id":"S","status":"SUCCEEDED","createdAt":"2026-11-12T09:42:00.000Z"},
                     {"id":"X","status":"FAILED","createdAt":"2026-11-12T09:40:00.000Z","deletedAt":"2026-11-12T09:41:00.000Z"}],
         "comments":[{"id":"C","body":"Looks right","createdAt":"2026-11-12T10:40:00.000Z"}]}
        """)
        let evidence = [TaskEvidenceRevision(revision: "1", submittedAt: "2026-11-12T10:28:00.000Z",
                                             decision: .init(decision: "CONFIRM", decidedAt: "2026-11-12T10:31:00.000Z",
                                                             decidedByType: "AGENT"))]
        let items = TaskDetailLogic.activity(filed, evidence: evidence)
        XCTAssertEqual(items.map(\.id), ["filed", "run-S", "evidence-1", "decision-1", "comment-C"],
                       "oldest first, and a run in the Trash is left out")
        XCTAssertEqual(TaskDetailLogic.activityText(items[3]), "Evidence r1 accepted by a reviewing agent")
        XCTAssertEqual(TaskDetailLogic.activityText(items[2]), "Evidence r1 submitted")
    }
}

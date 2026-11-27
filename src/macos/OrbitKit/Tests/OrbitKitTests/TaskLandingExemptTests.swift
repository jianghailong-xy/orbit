import Foundation
import XCTest
@testable import OrbitKit

/// A task's exemption from its project's landing check (revision 42 part two, D5), held to web's
/// `TaskLandingExempt.tsx`, `landingCheckTaskExempt` and `ProjectLandingsWindow`'s skipped step
/// (f0708d56d4): the four task fields decode; who marked it and when are the newest unreverted record
/// that set it; and a TASK_EXEMPT landing check reads "Landing check · Skipped" with
/// "Exempt: <reason>", never failed, with no inline output to fetch.
final class TaskLandingExemptTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private let now = RelativeTime.parse("2026-11-20T12:00:00.000Z")!
    private let reason = "Only moves cron entries; the landing check needs a database this task cannot reach."

    // MARK: the task's four fields

    func testTheTaskReadDecodesAllFourExemptionFields() throws {
        let coordinator = try decode(TaskItem.self, """
        {"id":"t1","title":"T","status":"DONE","landingCheckExempt":true,"landingCheckExemptReason":"\(reason)",
         "landingCheckExemptBySessionId":"s1","landingCheckExemptOwnerSetAt":null}
        """)
        XCTAssertEqual(coordinator.landingCheckExempt, true)
        XCTAssertEqual(coordinator.landingCheckExemptReason, reason)
        XCTAssertEqual(coordinator.landingCheckExemptBySessionId, "s1")
        XCTAssertNil(coordinator.landingCheckExemptOwnerSetAt)

        let owner = try decode(TaskItem.self, """
        {"id":"t1","title":"T","status":"OPEN","landingCheckExempt":true,"landingCheckExemptReason":"why",
         "landingCheckExemptBySessionId":null,"landingCheckExemptOwnerSetAt":"2026-11-20T11:55:00.000Z"}
        """)
        XCTAssertNil(owner.landingCheckExemptBySessionId)
        XCTAssertEqual(owner.landingCheckExemptOwnerSetAt, "2026-11-20T11:55:00.000Z")

        let off = try decode(TaskItem.self, """
        {"id":"t1","title":"T","status":"DONE","landingCheckExempt":false,"landingCheckExemptReason":null,
         "landingCheckExemptBySessionId":null,"landingCheckExemptOwnerSetAt":null}
        """)
        XCTAssertEqual(off.landingCheckExempt, false)
        XCTAssertNil(TaskLandingCheckExemption.of(off), "a task that is not exempt draws no row")
    }

    // MARK: who marked it and when

    private let changes = """
    [{"id":"c5","projectId":"p1","taskId":"t1","field":"TASK_LANDING_CHECK_EXEMPT","origin":"COORDINATOR",
      "oldValue":{"exempt":false,"reason":null},"newValue":{"exempt":true,"reason":"Later, reverted."},
      "reason":"Later, reverted.","writtenBySessionId":"s1","revertsChangeId":null,
      "revertedAt":"2026-11-20T11:59:00.000Z","revertible":false,"createdAt":"2026-11-20T11:58:00.000Z"},
     {"id":"c4","projectId":"p1","taskId":"t1","field":"TASK_LANDING_CHECK_EXEMPT","origin":"OWNER",
      "oldValue":{"exempt":true,"reason":"x"},"newValue":{"exempt":false,"reason":null},
      "reason":null,"writtenBySessionId":null,"revertsChangeId":null,"revertedAt":null,"revertible":false,
      "createdAt":"2026-11-20T11:50:00.000Z"},
     {"id":"c3","projectId":"p1","taskId":"t2","field":"TASK_LANDING_CHECK_EXEMPT","origin":"COORDINATOR",
      "oldValue":{"exempt":false,"reason":null},"newValue":{"exempt":true,"reason":"Another task."},
      "reason":"Another task.","writtenBySessionId":"s1","revertsChangeId":null,"revertedAt":null,
      "revertible":true,"createdAt":"2026-11-20T11:45:00.000Z"},
     {"id":"c2","projectId":"p1","taskId":"t1","field":"TASK_LANDING_CHECK_EXEMPT","origin":"CARD",
      "oldValue":{"exempt":false,"reason":null},"newValue":{"exempt":true,"reason":"x"},
      "reason":"x","writtenBySessionId":"s1","revertsChangeId":null,"revertedAt":null,
      "revertible":false,"createdAt":"2026-11-20T11:40:00.000Z"},
     {"id":"c1","projectId":"p1","taskId":"t1","field":"TASK_LANDING_CHECK_EXEMPT","origin":"COORDINATOR",
      "oldValue":{"exempt":false,"reason":null},"newValue":{"exempt":true,"reason":"Older."},
      "reason":"Older.","writtenBySessionId":"s1","revertsChangeId":null,"revertedAt":null,
      "revertible":false,"createdAt":"2026-11-20T11:00:00.000Z"}]
    """

    /// Web's `find`: this task, this field, a write that set it, that nothing reverted — newest first.
    func testTheMarkIsTheNewestUnrevertedRecordThatSetIt() throws {
        let list = try decode([ProjectSettingChange].self, changes)
        XCTAssertEqual(TaskLandingCheckExemption.marked(taskID: "t1", changes: list)?.id, "c2",
                       "c5 was reverted, c4 took it off, c3 is another task's")
        XCTAssertEqual(TaskLandingCheckExemption.marked(taskID: "t2", changes: list)?.id, "c3")
        XCTAssertNil(TaskLandingCheckExemption.marked(taskID: "t9", changes: list))
        XCTAssertNil(TaskLandingCheckExemption.marked(taskID: "t1", changes: []))
    }

    private func task(bySession: String?, ownerSetAt: String?) throws -> TaskItem {
        try decode(TaskItem.self, """
        {"id":"t1","title":"T","status":"DONE","landingCheckExempt":true,"landingCheckExemptReason":"\(reason)",
         "landingCheckExemptBySessionId":\(bySession.map { "\"\($0)\"" } ?? "null"),
         "landingCheckExemptOwnerSetAt":\(ownerSetAt.map { "\"\($0)\"" } ?? "null")}
        """)
    }

    private func record(_ origin: String, at: String) -> ProjectSettingChange {
        ProjectSettingChange(id: "c", taskId: "t1", field: "TASK_LANDING_CHECK_EXEMPT", origin: origin,
                             oldValue: SettingChangeValue(exempt: false), newValue: SettingChangeValue(exempt: true),
                             createdAt: at)
    }

    /// The origin badge is the record's, in web's words: Coordinator, Approved on a card, else You.
    func testTheOriginBadgeIsTheRecordsOrigin() throws {
        let t = try task(bySession: "s1", ownerSetAt: nil)
        let coordinator = try XCTUnwrap(TaskLandingCheckExemption.of(t, marked: record("COORDINATOR", at: "2026-11-20T11:40:00.000Z"), now: now))
        XCTAssertEqual([coordinator.originKind, coordinator.originLabel, coordinator.when], ["coordinator", "Coordinator", "marked 20m ago"])
        XCTAssertEqual(coordinator.reason, reason)

        let card = try XCTUnwrap(TaskLandingCheckExemption.of(t, marked: record("CARD", at: "2026-11-20T11:55:00.000Z"), now: now))
        XCTAssertEqual([card.originKind, card.originLabel, card.when], ["card", "Approved on a card", "marked 5m ago"])

        let owner = try XCTUnwrap(TaskLandingCheckExemption.of(try task(bySession: nil, ownerSetAt: "2026-11-20T11:00:00.000Z"),
                                                               marked: record("OWNER", at: "2026-11-20T11:58:00.000Z"), now: now))
        XCTAssertEqual([owner.originKind, owner.originLabel, owner.when], ["you", "You", "marked 2m ago"],
                       "the record's time, not the task's")
    }

    /// With no record listed, the task's own fields: a coordinator's mark names its session and no
    /// time, the owner's carries its own time.
    func testWithNoRecordTheTasksOwnFieldsSay() throws {
        let coordinator = try XCTUnwrap(TaskLandingCheckExemption.of(try task(bySession: "s1", ownerSetAt: nil), now: now))
        XCTAssertEqual(coordinator.originLabel, "Coordinator")
        XCTAssertNil(coordinator.when)
        let owner = try XCTUnwrap(TaskLandingCheckExemption.of(try task(bySession: nil, ownerSetAt: "2026-11-20T11:55:00.000Z"), now: now))
        XCTAssertEqual(owner.originLabel, "You")
        XCTAssertEqual(owner.when, "marked 5m ago")
    }

    func testRemoveExemptionPatchesTheFlagOff() throws {
        let body = String(decoding: try JSONEncoder().encode(TaskLandingCheckExemption.removeRequest), as: UTF8.self)
        XCTAssertEqual(body, #"{"landingCheckExempt":false}"#)
    }

    // MARK: the landing's check list

    private func entries(_ landing: String) throws -> [IntegrationTimelineEntry] {
        try decode([IntegrationTimelineEntry].self, """
        [{"kind":"CHECK_FINISHED","at":"2026-11-20T11:57:14.000Z","claim":1,
          "check":{"name":"TASK_ACCEPTANCE","index":1,"count":2},
          "data":{"exitCode":0,"expectedExitCode":0},"text":"Task acceptance passed · 14s"},
         \(landing)]
        """)
    }

    private func exempt(_ reason: String) -> String {
        """
        {"kind":"CHECK_FINISHED","at":"2026-11-20T11:57:14.000Z","claim":1,
         "check":{"name":"LANDING_CHECK","index":2,"count":2},
         "data":{"skipped":"TASK_EXEMPT","reason":"\(reason)","exitCode":null,"expectedExitCode":0},
         "text":"Landing check skipped · this task is exempt: \(reason)"}
        """
    }

    private func status(_ step: LandingStep, isLast: Bool = true, live: Bool = false, queued: Bool = false) -> LandingStepStatus {
        LandingStepStatus.of(step, kind: "LAND_TASK", isLast: isLast, live: live, queued: queued)
    }

    func testATaskExemptLandingCheckReadsSkippedWithItsReason() throws {
        let steps = LandingSteps.steps(try entries(exempt(reason)), kind: "LAND_TASK")
        let check = try XCTUnwrap(steps.first { $0.key == "check:LANDING_CHECK" })
        XCTAssertEqual(status(check), .skipped)
        XCTAssertEqual(status(check, live: true), .skipped, "a skip is not drawn running")
        XCTAssertEqual(LandingStepStatus.name(check, .skipped), "Landing check · Skipped")
        XCTAssertEqual(LandingStepStatus.summary(check, .skipped), "Exempt: \(reason)")
        let acceptance = try XCTUnwrap(steps.first { $0.key == "check:TASK_ACCEPTANCE" })
        XCTAssertEqual(status(acceptance, isLast: false), .ok)
        XCTAssertEqual(LandingStepStatus.name(acceptance, .ok), "Task acceptance")
    }

    /// web's `exemptCheckReason(reason ?? '')`: a skip that names no reason still says Exempt.
    func testASkipWithNoReasonStillSaysExempt() throws {
        let steps = LandingSteps.steps(try entries(exempt("")), kind: "LAND_TASK")
        let check = try XCTUnwrap(steps.first { $0.key == "check:LANDING_CHECK" })
        XCTAssertEqual(LandingStepStatus.summary(check, status(check)), "Exempt: ")
    }

    /// A landing check that ran and failed is failed; one that passed is ok — only the task's
    /// exemption reads Skipped, and the paths' (K2) does not.
    func testOnlyTheTasksExemptionIsSkipped() throws {
        let failed = """
        {"kind":"CHECK_FINISHED","at":"2026-11-20T11:57:14.000Z","claim":1,"check":{"name":"LANDING_CHECK","index":2,"count":2},
         "data":{"exitCode":1,"expectedExitCode":0},"text":"Landing check failed · exit 1"}
        """
        let passed = failed.replacingOccurrences(of: #""exitCode":1"#, with: #""exitCode":0"#)
        let paths = """
        {"kind":"CHECK_FINISHED","at":"2026-11-20T11:57:14.000Z","claim":1,"check":{"name":"LANDING_CHECK","index":2,"count":2},
         "data":{"skipped":"PATHS_EXEMPT","exitCode":null,"expectedExitCode":0},"text":"Landing check skipped · only exempt paths changed"}
        """
        func check(_ line: String) throws -> LandingStep {
            try XCTUnwrap(LandingSteps.steps(try entries(line), kind: "LAND_TASK").first { $0.key == "check:LANDING_CHECK" })
        }
        XCTAssertEqual(status(try check(failed)), .failed)
        XCTAssertEqual(status(try check(passed)), .ok)
        XCTAssertEqual(status(try check(paths)), .ok)
        XCTAssertEqual(LandingStepStatus.summary(try check(failed), .failed), "Landing check failed · exit 1")
    }

    /// Web's order: a line in the step that stopped short fails it even beside the skip.
    func testAStopInTheStepStillFailsIt() throws {
        let steps = LandingSteps.steps(try entries(exempt(reason) + """
        ,{"kind":"TIMED_OUT","at":"2026-11-20T11:58:00.000Z","claim":1,"text":"Timed out"}
        """), kind: "LAND_TASK")
        let check = try XCTUnwrap(steps.first { $0.key == "check:LANDING_CHECK" })
        XCTAssertEqual(status(check), .failed)
    }

    /// The timeline line draws → in warning ink (the view's), and opens no inline output: there is
    /// nothing a skipped check printed. A failed check's line still opens its tail.
    func testASkippedCheckFetchesNoInlineOutput() throws {
        let list = try entries(exempt(reason))
        let skip = try XCTUnwrap(list.last)
        XCTAssertFalse(skip.checkPassed, "the skip has no exit code to pass on")
        XCTAssertFalse(LandingCheckSkip.showsInlineOutput(skip))
        XCTAssertFalse(LandingCheckSkip.showsInlineOutput(list[0]), "a passed check stays one line")
        let failed = try decode(IntegrationTimelineEntry.self, """
        {"kind":"CHECK_FINISHED","at":"2026-11-20T11:57:14.000Z","claim":1,"check":{"name":"LANDING_CHECK","index":2,"count":2},
         "data":{"exitCode":1,"expectedExitCode":0},"text":"Landing check failed · exit 1"}
        """)
        XCTAssertTrue(LandingCheckSkip.showsInlineOutput(failed))
    }
}

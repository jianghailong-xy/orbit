import Foundation
import XCTest
@testable import OrbitKit

/// Contract revision 42 part two on this client, as the owner ruled it on docs/mocks/landing-measured
/// (D1–D9, 2026-11-20): a start request with no line, the landing check's provenance and its No check
/// value, a task's exemption, and the coordinator's change list with the owner's revert. Every new
/// field is optional on the wire, so an older server's payloads are held here too.
final class LandingMeasuredTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private let now = RelativeTime.parse("2026-11-20T12:00:00.000Z")!

    // MARK: ① the start card for a request with no line (P-M2, D1, D8)

    private let noLineSettings = """
    {"automatic":true,"maxConcurrentTasks":3,"mergeCheckCommand":"npm test"}
    """

    func testAStartRequestWithNoLineDecodes() throws {
        let item = try decode(ProjectOpenItemRow.self, """
        {"itemId":"item-1","kind":"START_REQUEST","status":"OPEN","createdAt":"2026-11-20T11:48:00.000Z",
         "startRequest":{"settings":\(noLineSettings),"why":"Rotate the staging password.",
                         "criteriaDigest":"\(String(repeating: "a", count: 64))",
                         "planDigest":"\(String(repeating: "p", count: 64))","warnings":[]}}
        """)
        let request = try XCTUnwrap(item.startRequest, "a request with no line is still a request")
        XCTAssertNil(request.settings.line)
        XCTAssertEqual(request.settings.mergeCheckCommand, "npm test")
        XCTAssertEqual(request.settings.maxConcurrentTasks, 3)
    }

    func testALineThisBuildDoesNotKnowIsStillNotSettings() {
        let json = #"{"line":"SIDEWAYS","automatic":true,"maxConcurrentTasks":1}"#
        XCTAssertThrowsError(try decode(ProjectStartSettings.self, json))
        XCTAssertNil(ProjectStartSettings.parse(try? decode(JSONValue.self, json)))
    }

    func testTheStartedRecordWithNoLineDecodesAndTheCardCarriesItsSettings() throws {
        let record = try decode(ProjectStartRecord.self, #"{"settings":\#(noLineSettings),"differsFromRequest":[]}"#)
        XCTAssertNil(record.settings.line)
        let card = try decode(JSONValue.self, """
        {"projectStarted":{"by":"CONFIRMATION","projectId":"p1","projectTitle":"Rotate staging credentials",
          "settings":\(noLineSettings)}}
        """)
        let started = try XCTUnwrap(ProjectStarted.parse(card))
        let settings = try XCTUnwrap(started.settings, "the Project started card keeps its settings")
        XCTAssertNil(settings.line)
        XCTAssertEqual(RunSettings.parts(settings).first?.text, StartProject.landsWhenCommits)
    }

    func testTheDraftOfANoLineRequestDrawsTheOneSentenceAndThePressSendsNoLine() throws {
        let settings = try decode(ProjectStartSettings.self, noLineSettings)
        let request = ProjectStartRequest(settings: settings, criteriaDigest: String(repeating: "a", count: 64))
        // A repository and a delivery mode on the read: neither is offered for a request with no line.
        let standing = ProjectIntegrationView(repository: "acme/payments-api", deliveryMode: .platform)
        let draft = StartSettingsDraft(settings, standing: standing)
        XCTAssertTrue(draft.linePending)
        XCTAssertNil(draft.upstream)
        XCTAssertNil(draft.deliveryMode)
        XCTAssertEqual(draft.mergeCheckCommand, "npm test", "D8 keeps the merge check row")

        let body = StartProject.body(request: request, draft: draft, requestId: "item-1")
        let sent = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertNil(sent["line"], "the press sends no line")
        XCTAssertNil(sent["projectBranchName"])
        XCTAssertNil(sent["upstreamRef"])
        XCTAssertNil(sent["deliveryMode"])
        XCTAssertNil(sent["landingCheckCommand"])
        XCTAssertNil(sent["landingCheckTimeoutSeconds"])
        XCTAssertEqual(sent["mergeCheckCommand"] as? String, "npm test")
        XCTAssertEqual(sent["maxConcurrentTasks"] as? Int, 3)
        XCTAssertEqual(sent["automatic"] as? Bool, true)
        XCTAssertEqual(sent["requestId"] as? String, "item-1")
    }

    /// With no line nothing is decided about where work lands: the Automatic sentence names no
    /// branch and no merge comes to the owner (web's `runAutomaticSays` / `startComesToYou` with
    /// `line === null`).
    func testANoLineRequestNamesNoBranch() throws {
        var draft = StartSettingsDraft(try decode(ProjectStartSettings.self, noLineSettings))
        XCTAssertEqual(draft.automaticSays, "The coordinator decides when each task is done.")
        draft.automatic = false
        XCTAssertEqual(draft.automaticSays, "You decide when each task is done.")
        let items = StartProject.comesToYou(automatic: false, line: draft.line, ownerConfirmed: [],
                                            evidenceJudged: 0, escalationSeconds: 7_200,
                                            linePending: true)
        XCTAssertFalse(items.contains { $0.text.contains("main") }, "a merge is listed: \(items.map(\.text))")
    }

    /// What main's second port asserted beside these (StartProjectTests, 111357a5bc), held on this
    /// side's types: the request is complete as it is, a merge check left empty goes as null, neither
    /// Automatic setting lists a merge, and a request that names the project branch still says it merges.
    func testANoLineRequestIsCompleteAndNamesNoMergeEitherWay() throws {
        let settings = try decode(ProjectStartSettings.self,
                                  #"{"automatic":true,"maxConcurrentTasks":3,"mergeCheckCommand":null}"#)
        let standing = ProjectIntegrationView(upstreamRef: "main", repository: "acme/app", deliveryMode: .platform)
        let draft = StartSettingsDraft(settings, standing: standing)
        XCTAssertTrue(draft.complete, "a request with no line can be started as it is")
        XCTAssertNil(draft.upstream, "a request with no line offers no main branch")
        let request = ProjectStartRequest(settings: settings, criteriaDigest: String(repeating: "a", count: 64))
        let body = StartProject.body(request: request, draft: draft, requestId: "item-1")
        let sent = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertTrue(sent["mergeCheckCommand"] is NSNull, "no merge check goes as null: \(sent)")
        XCTAssertNil(sent["line"])
        XCTAssertNil(sent["upstreamRef"])
        for automatic in [true, false] {
            let items = StartProject.comesToYou(automatic: automatic, line: draft.line, ownerConfirmed: [],
                                                evidenceJudged: 0, escalationSeconds: 7_200, linePending: true)
            let text = items.map(\.text).joined(separator: " ")
            XCTAssertNil(text.range(of: "\\bmain\\b|merge", options: [.regularExpression, .caseInsensitive]), text)
        }
        XCTAssertTrue(RunSettings.automaticSays(automatic: true, line: .projectBranch, hasMergeCheck: false)
            .contains("merges into main by itself"))
    }

    func testARequestThatNamesALineStillSendsIt() throws {
        let settings = ProjectStartSettings(line: .projectBranch, automatic: true, maxConcurrentTasks: 2)
        let request = ProjectStartRequest(settings: settings, criteriaDigest: String(repeating: "a", count: 64))
        let draft = StartSettingsDraft(settings)
        XCTAssertFalse(draft.linePending)
        let body = StartProject.body(request: request, draft: draft, requestId: nil)
        let sent = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertEqual(sent["line"] as? String, "PROJECT_BRANCH")
    }

    // MARK: ③ the landing check, who set it, and No check (P-C1, D3, D4, D9)

    func testTheLandingCheckReadsItsProvenance() throws {
        let view = try decode(ProjectIntegrationView.self, """
        {"line":"PROJECT_BRANCH","locked":true,"landingCheckCommand":"npm run check:landing",
         "landingCheckCommandAbsentReason":null,
         "landingCheck":{"command":"npm run check:landing","setBy":"COORDINATOR",
                         "setBySessionId":"s1","setAt":"2026-11-20T11:48:00.000Z"},
         "integratingCount":0,"queuedCount":0,"mergeCheckOnTip":"UNKNOWN"}
        """)
        let setting = LandingCheckSetting.of(view, now: now)
        XCTAssertEqual(setting.mode, .command)
        XCTAssertEqual(setting.command, "npm run check:landing")
        XCTAssertEqual(setting.origin?.label, "Coordinator")
        XCTAssertEqual(setting.origin?.when, "set 12m ago")
    }

    func testNoCheckIsAValue() throws {
        let view = try decode(ProjectIntegrationView.self, """
        {"line":"PROJECT_BRANCH","landingCheckCommand":null,"landingCheckCommandAbsentReason":"NONE",
         "landingCheck":{"command":"NONE","setBy":"OWNER","setBySessionId":null,"setAt":"2026-11-20T11:57:00.000Z"}}
        """)
        let setting = LandingCheckSetting.of(view, now: now)
        XCTAssertEqual(setting.mode, .none)
        XCTAssertNil(setting.command)
        XCTAssertEqual(setting.origin?.label, "You")
        XCTAssertEqual(setting.origin?.when, "set 3m ago")
        XCTAssertEqual(LandingCheckSetting.Mode.allCases.map(\.label), ["Merge check", "Command", "No check"])
    }

    func testTheFourWritersReadAsTheBoardsFourBadges() {
        let labels = ["OWNER", "COORDINATOR", "CARD", "START"].map {
            LandingCheckSetting.origin(ProjectLandingCheck(command: "x", setBy: $0), now: now)?.label
        }
        XCTAssertEqual(labels, ["You", "Coordinator", "Approved on a card", "Set at start"])
        XCTAssertNil(LandingCheckSetting.origin(ProjectLandingCheck(command: nil, setBy: nil), now: now))
    }

    func testTheOwnersWritesForEachValue() throws {
        func sent(_ mode: LandingCheckSetting.Mode) throws -> String? {
            guard let body = LandingCheckSetting.write(mode) else { return nil }
            return String(decoding: try JSONEncoder().encode(body), as: UTF8.self)
        }
        XCTAssertEqual(try sent(.mergeCheck), #"{"landingCheckCommand":null}"#)
        XCTAssertEqual(try sent(.none), #"{"landingCheck":"NONE"}"#)
        XCTAssertNil(try sent(.command), "a command is typed in its editor")
    }

    // MARK: ④ a task's exemption (P-C2, D5)

    func testAnExemptTaskDecodesItsMark() throws {
        let task = try decode(TaskItem.self, """
        {"id":"t1","title":"Move cron jobs off the old VM","status":"DONE",
         "landingCheckExempt":true,
         "landingCheckExemptReason":"Only moves cron entries; the landing check needs a database this task cannot reach.",
         "landingCheckExemptBySessionId":"s1","landingCheckExemptOwnerSetAt":null}
        """)
        let record = ProjectSettingChange(id: "c2", taskId: "t1", field: "TASK_LANDING_CHECK_EXEMPT", origin: "COORDINATOR",
                                          oldValue: SettingChangeValue(exempt: false), newValue: SettingChangeValue(exempt: true),
                                          createdAt: "2026-11-20T11:40:00.000Z")
        let exemption = try XCTUnwrap(TaskLandingCheckExemption.of(task, marked: record, now: now))
        XCTAssertEqual(exemption.originLabel, "Coordinator")
        XCTAssertEqual(exemption.when, "marked 20m ago")
        XCTAssertTrue(exemption.reason.hasPrefix("Only moves cron entries"))
    }

    func testTheOwnersExemptionAndTheRemoveBody() throws {
        let task = try decode(TaskItem.self, """
        {"id":"t1","title":"T","status":"OPEN","landingCheckExempt":true,"landingCheckExemptReason":"why",
         "landingCheckExemptBySessionId":null,"landingCheckExemptOwnerSetAt":"2026-11-20T11:55:00.000Z"}
        """)
        let exemption = try XCTUnwrap(TaskLandingCheckExemption.of(task, now: now))
        XCTAssertEqual(exemption.originLabel, "You")
        XCTAssertEqual(exemption.when, "marked 5m ago")
        let body = String(decoding: try JSONEncoder().encode(TaskLandingCheckExemption.removeRequest), as: UTF8.self)
        XCTAssertEqual(body, #"{"landingCheckExempt":false}"#)
    }

    /// The coordinator's note on this task: a LANDING_CHECK entry skipped as TASK_EXEMPT, with its
    /// reason, is drawn as skipped — never as a failed check.
    func testATaskExemptLandingCheckIsSkippedNotFailed() throws {
        let entries = try decode([IntegrationTimelineEntry].self, """
        [{"kind":"CHECK_STARTED","at":"2026-11-20T11:57:00.000Z","claim":1,
          "check":{"name":"TASK_ACCEPTANCE","index":1,"count":2},"text":"Task acceptance started"},
         {"kind":"CHECK_FINISHED","at":"2026-11-20T11:57:14.000Z","claim":1,
          "check":{"name":"TASK_ACCEPTANCE","index":1,"count":2},
          "data":{"exitCode":0,"expectedExitCode":0},"text":"Task acceptance passed · 14s"},
         {"kind":"CHECK_FINISHED","at":"2026-11-20T11:57:14.000Z","claim":1,
          "check":{"name":"LANDING_CHECK","index":2,"count":2},
          "data":{"skipped":"TASK_EXEMPT","reason":"Only moves cron entries.","exitCode":null,"expectedExitCode":0},
          "text":"Landing check skipped · this task is exempt: Only moves cron entries."}]
        """)
        let steps = LandingSteps.steps(entries, kind: "LAND_TASK")
        let check = try XCTUnwrap(steps.first { $0.key == "check:LANDING_CHECK" })
        XCTAssertFalse(LandingSteps.failed(check, kind: "LAND_TASK"), "an exempt task's check did not fail")
        let skip = try XCTUnwrap(LandingCheckSkip.taskExempt(check))
        XCTAssertEqual(LandingCheckSkip.exemptLine(skip), "Exempt: Only moves cron entries.")
        XCTAssertTrue(LandingCheckSkip.isSkip(skip))
        XCTAssertEqual(LandingProvenanceCopy.checkSkipped, "Landing check · Skipped")
    }

    // MARK: ⑤ the coordinator's changes and the owner's revert (P-R1, D6, D7)

    private let changes = """
    [{"id":"c4","projectId":"p1","taskId":null,"field":"LANDING_CHECK","origin":"OWNER",
      "oldValue":{"command":null,"timeoutSeconds":null,"none":true},
      "newValue":{"command":"npm run check:landing","timeoutSeconds":null,"none":false},
      "reason":null,"writtenBySessionId":null,"revertsChangeId":"c1","revertedAt":null,"revertible":false,
      "createdAt":"2026-11-20T11:59:50.000Z"},
     {"id":"c1","projectId":"p1","taskId":null,"field":"LANDING_CHECK","origin":"COORDINATOR",
      "oldValue":{"command":"npm run check:landing","timeoutSeconds":null,"none":false},
      "newValue":{"command":null,"timeoutSeconds":null,"none":true},
      "reason":"This project only changes infrastructure; the command has nothing to build.",
      "writtenBySessionId":"s1","revertsChangeId":null,"revertedAt":"2026-11-20T11:59:50.000Z","revertible":false,
      "createdAt":"2026-11-20T11:48:00.000Z"},
     {"id":"c2","projectId":"p1","taskId":"t1","field":"TASK_LANDING_CHECK_EXEMPT","origin":"COORDINATOR",
      "oldValue":{"exempt":false,"reason":null},"newValue":{"exempt":true,"reason":"Only moves cron entries."},
      "reason":"Only moves cron entries.","writtenBySessionId":"s1","revertsChangeId":null,"revertedAt":null,
      "revertible":true,"createdAt":"2026-11-20T11:40:00.000Z"},
     {"id":"c3","projectId":"p1","taskId":null,"field":"LANDING_CHECK","origin":"OWNER",
      "oldValue":{"command":null,"timeoutSeconds":null,"none":false},
      "newValue":{"command":"npm run check:landing","timeoutSeconds":null,"none":false},
      "reason":null,"writtenBySessionId":null,"revertsChangeId":null,"revertedAt":null,"revertible":false,
      "createdAt":"2026-11-18T12:00:00.000Z"}]
    """

    func testTheChangeListReadsAsTheBoard() throws {
        let document = try decode(ProjectDocument.self, #"{"id":"p1","title":"Rotate staging credentials","settingChanges":\#(changes)}"#)
        let list = try XCTUnwrap(document.settingChanges)
        XCTAssertEqual(CoordinatorChanges.count(list), 3, "the owner's revert is a line on the change, not a row")
        let rows = CoordinatorChanges.rows(list, taskTitles: ["t1": "Move cron jobs off the old VM"], now: now)
        XCTAssertEqual(rows.map(\.title), ["Landing check", "Check exempt · Move cron jobs…", "Landing check"])

        let reverted = rows[0]
        XCTAssertEqual(reverted.old, "npm run check:landing")
        XCTAssertTrue(reverted.oldIsCode)
        XCTAssertEqual(reverted.new, "No check")
        XCTAssertFalse(reverted.revertible)
        XCTAssertTrue(reverted.reverted)
        XCTAssertEqual(reverted.note, "Reverted by you · 10s ago · coordinator needs a card for this field")

        let exempt = rows[1]
        XCTAssertEqual([exempt.old, exempt.new], ["not exempt", "exempt"])
        XCTAssertTrue(exempt.revertible)
        XCTAssertEqual(exempt.originLabel, "Coordinator")
        XCTAssertEqual(exempt.when, "20m ago")

        let own = rows[2]
        XCTAssertEqual([own.old, own.new], ["Uses merge check", "npm run check:landing"])
        XCTAssertFalse(own.revertible)
        XCTAssertEqual(own.originLabel, "You")
        XCTAssertEqual(own.note, "Your change · nothing to revert")
    }

    func testTheRevertConfirmationSaysWhatGoesBack() throws {
        let list = try decode([ProjectSettingChange].self, changes)
        let change = try XCTUnwrap(list.first { $0.id == "c1" })
        XCTAssertEqual(CoordinatorChanges.revertText(change),
                       "Landing check goes back from No check to npm run check:landing.")
        XCTAssertEqual(LandingProvenanceCopy.revertAfter,
                       "The coordinator can no longer change this field without a card.")
    }

    // MARK: an older server

    /// Payloads from a server that predates revision 42 part two: no landingCheck, no settingChanges,
    /// no exemption fields. Everything decodes, and the page draws today's.
    func testAnOlderServerStillDecodes() throws {
        let view = try decode(ProjectIntegrationView.self, """
        {"line":"PROJECT_BRANCH","ref":"project/p1","locked":false,"landingCheckCommand":"npm run check:landing",
         "landingCheckTimeoutSeconds":null,"landingCheckCommandAbsentReason":null,
         "integratingCount":0,"queuedCount":0,"mergeCheckOnTip":"UNKNOWN"}
        """)
        XCTAssertNil(view.landingCheck)
        let setting = LandingCheckSetting.of(view, now: now)
        XCTAssertEqual(setting.mode, .command)
        XCTAssertNil(setting.origin, "no badge from a server that keeps no provenance")

        let document = try decode(ProjectDocument.self, """
        {"id":"p1","title":"T","status":"OPEN","integration":{"line":"PROJECT_BRANCH","locked":false}}
        """)
        XCTAssertNil(document.settingChanges)
        XCTAssertNil(document.integration?.landingCheck)

        let task = try decode(TaskItem.self, #"{"id":"t1","title":"T","status":"DONE"}"#)
        XCTAssertNil(task.landingCheckExempt)
        XCTAssertNil(TaskLandingCheckExemption.of(task))

        let started = try decode(ProjectStartSettings.self,
                                 #"{"line":"MAIN","automatic":false,"maxConcurrentTasks":1,"mergeCheckCommand":null}"#)
        XCTAssertEqual(started.line, .main)
    }
}

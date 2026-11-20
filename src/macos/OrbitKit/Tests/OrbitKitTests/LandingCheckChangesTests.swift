import Foundation
import XCTest
@testable import OrbitKit

/// The landing check's three values, who set it, and the coordinator's change list with Revert
/// (revision 42 part two, rulings D3–D7, D9), held to the browser's rules and wiring.
final class LandingCheckChangesTests: XCTestCase {

    private func web(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(relative) was not found above this test file; move this check with it rather than deleting it")
        return ""
    }

    private func json(_ body: UpdateProjectIntegrationRequest?) throws -> [String: Any] {
        let body = try XCTUnwrap(body)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
    }

    // MARK: the three values

    func testTheModeIsReadOffTheLandingCheckFirstAndTheCommandOtherwise() throws {
        let decoded = try JSONDecoder().decode(ProjectIntegrationView.self, from: Data("""
            {"landingCheckCommand":null,"landingCheck":{"command":"NONE","setBy":"COORDINATOR",
             "setBySessionId":"s1","setAt":"2026-11-20T10:00:00.000Z"}}
            """.utf8))
        XCTAssertEqual(decoded.landingCheck?.setBy, .coordinator)
        XCTAssertEqual(decoded.landingCheck?.setAt, "2026-11-20T10:00:00.000Z")
        XCTAssertEqual(LandingCheckMode.of(decoded), .noCheck)
        XCTAssertEqual(LandingCheckMode.of(ProjectIntegrationView(landingCheckCommand: "make fast")), .command)
        XCTAssertEqual(LandingCheckMode.of(ProjectIntegrationView()), .mergeCheck)
        XCTAssertEqual(LandingCheckMode.of(ProjectIntegrationView(landingCheckCommand: "stale",
            landingCheck: ProjectLandingCheck(command: nil))), .mergeCheck, "the landing check wins over the old field")
        // A writer this build does not know is nobody, not a failed read.
        let unknown = try JSONDecoder().decode(ProjectIntegrationView.self, from: Data("""
            {"landingCheck":{"command":"make","setBy":"ROBOT","setBySessionId":null,"setAt":null}}
            """.utf8))
        XCTAssertNil(unknown.landingCheck?.setBy)
        XCTAssertEqual(unknown.landingCheck?.command, "make")
        XCTAssertEqual(LandingCheckMode.allCases.map(\.label), ["Merge check", "Command", "No check"])
    }

    func testWhoSetItIsTheBadgeAndTheTime() {
        let now = ISO8601DateFormatter().date(from: "2026-11-20T12:00:00Z")!
        XCTAssertEqual(LandingCheckOriginCopy.line(ProjectLandingCheck(command: nil, setBy: .coordinator,
                                                                       setAt: "2026-11-20T10:00:00Z"), now: now),
                       "Coordinator · set 2h ago")
        XCTAssertEqual(LandingCheckOriginCopy.line(ProjectLandingCheck(command: nil, setBy: .start), now: now), "Set at start")
        XCTAssertNil(LandingCheckOriginCopy.line(ProjectLandingCheck(command: nil), now: now))
        XCTAssertNil(LandingCheckOriginCopy.line(nil, now: now))
        XCTAssertEqual(LandingCheckSetBy.allCases.map(LandingCheckOriginCopy.badge),
                       ["You", "Approved on a card", "Set at start", "Coordinator"])
    }

    func testNoCheckIsWrittenByNameAndACommandOrTheMergeCheckLiftsIt() throws {
        let merge = ProjectIntegrationView(landingCheckTimeoutSeconds: 600)
        // To No check: by name, and no timeout with it.
        let none = try json(RunSettings.landingCheckWrite(merge, mode: .noCheck, command: "", timeout: 900))
        XCTAssertEqual(none["landingCheck"] as? String, "NONE")
        XCTAssertNil(none["landingCheckCommand"])
        XCTAssertNil(none["landingCheckTimeoutSeconds"])
        // Already No check: nothing.
        let stored = ProjectIntegrationView(landingCheck: ProjectLandingCheck(command: "NONE"))
        XCTAssertNil(RunSettings.landingCheckWrite(stored, mode: .noCheck, command: "x", timeout: nil))
        // Out of No check, to the merge check: a null command, even though the old field is null too.
        let lifted = try json(RunSettings.landingCheckWrite(stored, mode: .mergeCheck, command: "make", timeout: nil))
        XCTAssertTrue(lifted["landingCheckCommand"] is NSNull)
        XCTAssertNil(lifted["landingCheck"])
        // A command, sent as typed.
        let command = try json(RunSettings.landingCheckWrite(merge, mode: .command, command: "  make fast ", timeout: 600))
        XCTAssertEqual(command["landingCheckCommand"] as? String, "  make fast ")
        XCTAssertNil(command["landingCheckTimeoutSeconds"])
        // A blank command is the merge check.
        XCTAssertNil(RunSettings.landingCheckWrite(merge, mode: .command, command: "  ", timeout: 600))
    }

    // MARK: the change list

    private static let changes = """
        [{"id":"c3","projectId":"p1","taskId":null,"field":"LANDING_CHECK","origin":"COORDINATOR",
          "oldValue":{"command":null,"timeoutSeconds":null,"none":false},
          "newValue":{"command":"make fast","timeoutSeconds":600,"none":false},
          "reason":"Full suite is slow","writtenBySessionId":"s1","revertsChangeId":null,"revertedAt":null,
          "revertible":true,"createdAt":"2026-11-20T10:00:00.000Z"},
         {"id":"c2","projectId":"p1","taskId":"t9","field":"TASK_LANDING_CHECK_EXEMPT","origin":"OWNER",
          "oldValue":{"exempt":false,"reason":null},"newValue":{"exempt":true,"reason":"docs only"},
          "reason":null,"writtenBySessionId":null,"revertsChangeId":null,"revertedAt":null,
          "revertible":false,"createdAt":"2026-11-20T09:00:00.000Z"},
         {"id":"c1","projectId":"p1","taskId":null,"field":"LANDING_CHECK","origin":"COORDINATOR",
          "oldValue":{"command":"make","timeoutSeconds":null,"none":false},
          "newValue":{"command":null,"timeoutSeconds":null,"none":true},
          "reason":"no tests yet","writtenBySessionId":"s1","revertsChangeId":null,
          "revertedAt":"2026-11-20T11:00:00.000Z","revertible":false,"createdAt":"2026-11-20T08:00:00.000Z"},
         {"id":"c0","projectId":"p1","taskId":null,"field":"SOMETHING_NEW","origin":"OWNER",
          "oldValue":{},"newValue":{},"revertible":false,"createdAt":""}]
        """

    func testTheProjectReadCarriesTheChangesAndLeavesOutWhatItCannotRead() throws {
        let document = try JSONDecoder().decode(ProjectDocument.self, from: Data("""
            {"id":"p1","title":"P","settingChanges":\(Self.changes)}
            """.utf8))
        let changes = try XCTUnwrap(document.settingChanges)
        XCTAssertEqual(changes.map(\.id), ["c3", "c2", "c1"])
        XCTAssertNil(try JSONDecoder().decode(ProjectDocument.self, from: Data(#"{"id":"p1"}"#.utf8)).settingChanges)
        // Round trip, as the page's cache writes it.
        let again = try JSONDecoder().decode(ProjectDocument.self, from: JSONEncoder().encode(document))
        XCTAssertEqual(again.settingChanges, changes)

        let (coordinator, owner, reverted) = (changes[0], changes[1], changes[2])
        XCTAssertEqual(LandingChanges.what(coordinator), "Landing check")
        XCTAssertEqual(LandingChanges.what(owner), "Check exempt")
        XCTAssertEqual(LandingChanges.valueText(coordinator.oldValue).text, "Uses merge check")
        XCTAssertTrue(LandingChanges.valueText(coordinator.newValue) == ("make fast", true))
        XCTAssertEqual(LandingChanges.valueText(reverted.newValue).text, "No check")
        XCTAssertEqual(LandingChanges.valueText(owner.newValue).text, "exempt")
        XCTAssertEqual(LandingChanges.valueText(owner.oldValue).text, "not exempt")
        XCTAssertEqual(LandingChanges.origin(coordinator), "Coordinator")
        XCTAssertEqual(LandingChanges.origin(owner), "You")
        // Revert exactly where the server says so; the owner's own change says there is nothing to revert.
        XCTAssertEqual(LandingChanges.action(coordinator), .revert)
        XCTAssertEqual(LandingChanges.action(owner), .note("Your change · nothing to revert"))
        XCTAssertEqual(LandingChanges.action(reverted), .nothing)
        let revertRow = ProjectSettingChange(id: "c4", origin: .owner, oldValue: reverted.newValue,
                                             newValue: reverted.oldValue, revertsChangeId: "c1")
        XCTAssertEqual(LandingChanges.action(revertRow), .nothing, "a revert's own row offers nothing")
        XCTAssertEqual(LandingChanges.confirmBody(coordinator), "Landing check goes back from make fast to Uses merge check.")
    }

    // MARK: the browser's wiring

    func testTheWebWiresTheRowTheListAndTheRevertAsThisClientDoes() throws {
        let list = try web("src/web/src/components/ProjectLandingChanges.tsx")
        for literal in [
            "`/projects/${encodeURIComponent(projectId)}/setting-changes/${encodeURIComponent(change.id)}/revert`, { method: 'POST' },",
            "{change.revertible ? (",
            ") : change.origin !== 'COORDINATOR' && !change.revertsChangeId ? (",
            "if (!changes || changes.length === 0) return null;",
            "{changesRowLabel(changes.length)} ›",
            "{change.revertedAt ? <div className=\"project-change-reverted\">{revertedLine(ago(change.revertedAt, now))}</div> : null}",
            "goes back from{' '}",
            "if (value.none) return <>{CHANGES_COPY.NO_CHECK}</>;",
            "const isLandingValue = (value: ProjectSettingChangeView['oldValue']): value is ProjectLandingCheckValue => 'none' in value;",
            "<div className=\"project-change-consequence\">{CHANGES_COPY.CONFIRM_CONSEQUENCE}</div>",
            "confirmText: CHANGES_COPY.REVERT,",
            "cancelText: CHANGES_COPY.CANCEL,",
        ] {
            XCTAssertTrue(list.contains(literal), "ProjectLandingChanges.tsx no longer says \(literal)")
        }
        let block = try web("src/web/src/components/ProjectRunSettings.tsx")
        for literal in [
            "? (storedMode !== 'NONE' ? { landingCheck: 'NONE' } : {})",
            ": (landing !== (view.landingCheckCommand ?? null) || storedMode === 'NONE' ? { landingCheckCommand: landing } : {});",
            "...(draft.landingMode !== 'NONE' && draft.landingCheckTimeoutSeconds !== (view.landingCheckTimeoutSeconds ?? null)",
            "{setAt ? <span className=\"project-landing-origin-time\">{`set ${ago(setAt, now)}`}</span> : null}",
            "<b>{LANDING_MODE_COPY.NONE_HEAD}</b> {LANDING_MODE_COPY.NONE_BODY}",
            "{LANDING_CHECK_COPY.HINT} {LANDING_MODE_COPY.COMMAND_NOTE}",
        ] {
            XCTAssertTrue(block.contains(literal), "ProjectRunSettings.tsx no longer says \(literal)")
        }
        // The row sits under the landing check and over the merge check.
        let order = ["{LANDING_CHECK_COPY.LABEL}</div>", "<ProjectChangesRow projectId={projectId} changes={project.settingChanges} />",
                     "{RUN_MERGE_CHECK}</div>"]
        let at = order.map { block.range(of: $0)?.lowerBound }
        XCTAssertFalse(at.contains(nil), "the web block lost one of \(order)")
        XCTAssertEqual(at.compactMap { $0 }, at.compactMap { $0 }.sorted())
        let words = try web("src/web/src/lib/landingCheck.ts")
        XCTAssertTrue(words.contains("const command = view.landingCheck ? view.landingCheck.command : view.landingCheckCommand;"))
        XCTAssertTrue(words.contains("if (command === 'NONE') return 'NONE';"))
        XCTAssertTrue(words.contains("return command ? 'COMMAND' : 'MERGE_CHECK';"))
    }
}

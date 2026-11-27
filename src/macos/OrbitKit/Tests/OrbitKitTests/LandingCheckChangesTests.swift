import Foundation
import XCTest
@testable import OrbitKit

/// What main's second port of revision 42 part two (c7b17038b8) asserted that `LandingMeasuredTests`
/// did not, held on this client's types once the two were merged into one: the new `landingCheck`
/// deciding the value over the older field, a writer this build does not know, a change list holding a
/// record this build cannot read or draw, the card's own change, the exemption row's task link, and the
/// browser's wiring of the row, the list and the revert.
final class LandingCheckChangesTests: XCTestCase {

    private let now = RelativeTime.parse("2026-11-20T12:00:00.000Z")!

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

    // MARK: the value and who set it

    func testTheLandingCheckDecidesOverTheOlderField() {
        // Web's `landingCheckModeOf`: where the server sends `landingCheck`, its command decides, null
        // included; the older `landingCheckCommand` is read only without it.
        var stale = ProjectIntegrationView(landingCheckCommand: "stale")
        stale.landingCheck = ProjectLandingCheck(command: nil)
        XCTAssertEqual(LandingCheckSetting.of(stale, now: now).mode, .mergeCheck)
        XCTAssertEqual(LandingCheckSetting.of(ProjectIntegrationView(landingCheckCommand: "make fast"), now: now).mode, .command)
        XCTAssertEqual(LandingCheckSetting.of(ProjectIntegrationView(), now: now).mode, .mergeCheck)
    }

    func testAWriterThisBuildDoesNotKnowIsNobody() throws {
        let view = try JSONDecoder().decode(ProjectIntegrationView.self, from: Data("""
            {"landingCheck":{"command":"make","setBy":"ROBOT","setBySessionId":null,"setAt":null}}
            """.utf8))
        XCTAssertEqual(view.landingCheck?.setBy, "ROBOT", "kept as the server said it")
        let setting = LandingCheckSetting.of(view, now: now)
        XCTAssertEqual(setting.mode, .command)
        XCTAssertEqual(setting.command, "make")
        XCTAssertNil(setting.origin, "a writer this build does not know wears no badge")
        // Set at start, with no time on it: the badge alone.
        var started = ProjectIntegrationView()
        started.landingCheck = ProjectLandingCheck(command: nil, setBy: "START")
        XCTAssertEqual(LandingCheckSetting.of(started, now: now).origin?.label, "Set at start")
        XCTAssertNil(LandingCheckSetting.of(started, now: now).origin?.when)
        var nobody = ProjectIntegrationView()
        nobody.landingCheck = ProjectLandingCheck(command: nil)
        XCTAssertNil(LandingCheckSetting.of(nobody, now: now).origin)
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
         {"id":"c1","projectId":"p1","taskId":null,"field":"LANDING_CHECK","origin":"CARD",
          "oldValue":{"command":"make","timeoutSeconds":null,"none":false},
          "newValue":{"command":null,"timeoutSeconds":null,"none":true},
          "reason":null,"writtenBySessionId":null,"revertsChangeId":null,"revertedAt":null,
          "revertible":false,"createdAt":"2026-11-20T08:00:00.000Z"},
         {"id":"c0","projectId":"p1","taskId":null,"field":"SOMETHING_NEW","origin":"OWNER",
          "oldValue":{},"newValue":{},"revertible":false,"createdAt":"2026-11-20T07:00:00.000Z"},
         {"projectId":"p1","field":"LANDING_CHECK","origin":"COORDINATOR"}]
        """

    func testTheProjectReadKeepsWhatItCanReadAndDrawsWhatItKnows() throws {
        let document = try JSONDecoder().decode(ProjectDocument.self, from: Data("""
            {"id":"p1","title":"P","settingChanges":\(Self.changes)}
            """.utf8))
        let changes = try XCTUnwrap(document.settingChanges)
        // The record with no id cannot be read: it is left out, not the whole list with it.
        XCTAssertEqual(changes.map(\.id), ["c3", "c2", "c1", "c0"])
        // A field this build does not know still decodes (it is the server's string), and is not drawn.
        XCTAssertEqual(changes.last?.field, "SOMETHING_NEW")
        let rows = CoordinatorChanges.rows(changes, now: now)
        XCTAssertEqual(rows.map(\.id), ["c3", "c2", "c1"])
        XCTAssertEqual(CoordinatorChanges.count(changes), 3)
        XCTAssertNil(try JSONDecoder().decode(ProjectDocument.self, from: Data(#"{"id":"p1","title":"P"}"#.utf8)).settingChanges)
        // Round trip, as the page's cache writes it.
        let again = try JSONDecoder().decode(ProjectDocument.self, from: JSONEncoder().encode(document))
        XCTAssertEqual(again.settingChanges, changes)

        let (coordinator, owner, card) = (rows[0], rows[1], rows[2])
        XCTAssertTrue(coordinator.revertible)
        XCTAssertNil(coordinator.note)
        XCTAssertNil(coordinator.taskID, "a landing-check row names no task")
        XCTAssertEqual(owner.note, "Your change · nothing to revert")
        XCTAssertEqual(owner.taskID, "t9", "an exemption row opens its task")
        // A change approved on a card is the owner's too: nothing to revert (web: origin !== 'COORDINATOR').
        XCTAssertEqual(card.originLabel, "Approved on a card")
        XCTAssertFalse(card.revertible)
        XCTAssertEqual(card.note, "Your change · nothing to revert")
        XCTAssertEqual(CoordinatorChanges.revertText(changes[0]), "Landing check goes back from make fast to Uses merge check.")
    }

    // MARK: the browser's wiring

    func testTheWebWiresTheRowTheListAndTheRevertAsThisClientDoes() throws {
        let list = try web("src/web/src/components/ProjectLandingChanges.tsx")
        for literal in [
            "`/projects/${encodeURIComponent(projectId)}/setting-changes/${encodeURIComponent(change.id)}/revert`, { method: 'POST' },",
            "{change.revertible ? (",
            ") : change.origin !== 'COORDINATOR' ? (",
            "if (!changes || changes.length === 0) return null;",
            "{changesRowLabel(changes.length)} ›",
            "{change.revertedAt ? <div className=\"project-change-reverted\">{revertedLine(ago(change.revertedAt, now))}</div> : null}",
            "goes back from{' '}",
            "if (value.none) return <>{CHANGES_COPY.NO_CHECK}</>;",
            "const isLandingValue = (value: ProjectSettingChangeView['oldValue']): value is ProjectLandingCheckValue => 'none' in value;",
            "<div className=\"project-change-consequence\">{CHANGES_COPY.CONFIRM_CONSEQUENCE}</div>",
            "confirmText: CHANGES_COPY.REVERT,",
            "cancelText: CHANGES_COPY.CANCEL,",
            ">\(LandingProvenanceCopy.openTask)</Link>",
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
            "{LANDING_CHECK_ORIGIN_NOTES.map((entry) => (",
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

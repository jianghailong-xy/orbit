import Foundation
import XCTest
@testable import OrbitKit

final class SessionPermissionModeTests: XCTestCase {
    func testOlderSessionsAndListRowsDecodeWithoutHistory() throws {
        let older = try session(#"{"id":"s","status":"RUNNING","permissionMode":"auto"}"#)
        XCTAssertEqual(older.permissionMode, "auto")
        XCTAssertNil(older.actualPermissionMode)
        XCTAssertNil(older.permissionModeChanges)

        let list = try session(#"""
        {"id":"s","status":"RUNNING","permissionMode":"auto","actualPermissionMode":"default",
         "actualPermissionModeAt":"2026-11-22T12:00:00.000Z"}
        """#)
        XCTAssertEqual(list.permissionMode, "auto")
        XCTAssertEqual(list.actualPermissionMode, "default")
        XCTAssertEqual(list.actualPermissionModeAt, "2026-11-22T12:00:00.000Z")
        XCTAssertNil(list.permissionModeChanges)
    }

    func testConfirmedModeAndPreStartDisplay() {
        let actual = SessionModeDisplay(intent: .auto, actual: "auto", beforeStart: false)
        XCTAssertEqual(actual.label, "Auto")
        XCTAssertNil(actual.reason)
        XCTAssertFalse(actual.isCorrecting)
        XCTAssertEqual(SessionModeDisplay(intent: .plan, actual: nil, beforeStart: true).label, "Plan")
        XCTAssertEqual(SessionModeDisplay(intent: .auto, actual: nil, beforeStart: false).label, "Mode unconfirmed")
    }

    func testReportedGapExplainsRunnerCorrection() {
        let report = change(from: "auto", to: "default", cause: "ENGINE_REPORT")
        let gap = SessionModeDisplay(intent: .auto, actual: "default", beforeStart: false, latestChange: report)
        XCTAssertEqual(gap.label, "Default → Auto")
        XCTAssertTrue(gap.isCorrecting)
        XCTAssertTrue(gap.reason?.contains("The runner is switching it to Auto.") == true)
    }

    func testClaimSubstitutionExplainsRootRunnerWithoutShowingCorrection() {
        let claim = change(from: nil, to: "auto", cause: "CLAIM")
        let gap = SessionModeDisplay(intent: .bypass, actual: "auto", beforeStart: false,
                                     latestChange: claim, runsAsRoot: true)
        XCTAssertEqual(gap.label, "Auto → Bypass")
        XCTAssertEqual(gap.reason, "Running in Auto. Bypass can't run on a root runner.")
        XCTAssertFalse(gap.isCorrecting)
    }

    func testAutoHintKeepsAutoSelectedBeforeStart() {
        XCTAssertEqual(autoHint(model: "claude-haiku-4-5"), "starts in Default")
        XCTAssertNil(autoHint(model: "claude-opus-5-5"))
        XCTAssertNil(SessionModeDisplay.autoStartHint(model: "any", engine: "codex", provider: "codex",
                                                      configured: [], catalog: nil))
        XCTAssertEqual(SessionModeDisplay(intent: .auto, actual: nil, beforeStart: true,
                                          autoStartsInDefault: true).label, "Auto")
        let report = change(from: "auto", to: "default", cause: "ENGINE_REPORT")
        let gap = SessionModeDisplay(intent: .auto, actual: "default", beforeStart: false,
                                     latestChange: report, autoStartsInDefault: true)
        XCTAssertEqual(gap.reason, "Running in Default. Auto starts in Default on this model.")
        XCTAssertFalse(gap.isCorrecting)
    }

    func testDetailDecodesAndPlacesAttributedModeChangesInTranscript() throws {
        let detail = try session(#"""
        {"id":"s","status":"RUNNING","permissionMode":"auto","actualPermissionMode":"auto",
         "actualPermissionModeAt":"2026-11-22T12:00:03.000Z",
         "permissionModeChanges":[
           {"fromMode":null,"toMode":"auto","cause":"CLAIM","client":null,"at":"2026-11-22T12:00:00.000Z"},
           {"fromMode":"auto","toMode":"default","cause":"OWNER_PICK","client":"ios","at":"2026-11-22T12:00:02.000Z"},
           {"fromMode":"default","toMode":"auto","cause":"RUNNER_CORRECTION","client":null,"at":"2026-11-22T12:00:03.000Z"}
         ]}
        """#)
        XCTAssertEqual(try JSONDecoder().decode(Session.self, from: JSONEncoder().encode(detail)), detail)
        let changes = try XCTUnwrap(detail.permissionModeChanges)
        XCTAssertNil(changes[0].fromMode)
        XCTAssertEqual(changes.map(\.line), [
            "Started in Auto — assigned at claim",
            "Mode set to Default by you on iOS",
            "Mode set back to Auto by the runner — the engine had been in Default",
        ])
        XCTAssertEqual(change(from: "default", to: "auto", cause: "RESPAWN").line, "Engine restarted in Auto")
        XCTAssertEqual(change(from: "auto", to: "default", cause: "ORBIT_CHANGE").line, "Mode set to Default by Orbit")

        let cards = changes.map { DeliveredDecisionCard(kind: .permissionModeChange($0), placement: .at($0.at)) }
        var state = TranscriptState()
        state.items = [.user(UserBubble(id: "message", text: "Hello", ts: "2026-11-22T12:00:01.000Z",
                                        pending: false, queued: false))]
        let rows = TranscriptRows.build(state: state, statusCards: [], canPageOlder: false,
                                        showWorkingIndicator: false, decisionCards: cards)
        XCTAssertEqual(rows.map(\.id), [cards[0].id, "message", cards[1].id, cards[2].id, "transcript-bottom"])
    }

    // A correction Claude refused (`permission_mode_correction_failed`): a gap that lasts at once, in the CLI's words.

    private let words = "Cannot set permission mode to auto: auto mode unavailable for this model"

    private func refusalEvent(seq: Int = 7, ts: String = "2026-11-22T12:00:01.000Z") throws -> RunEvent {
        let json = """
        {"seq":\(seq),"type":"system","ts":"\(ts)","payload":{"subtype":"permission_mode_correction_failed",
         "mode":"default","requested":"auto","reason":"\(words)"}}
        """
        return try JSONDecoder().decode(RunEvent.self, from: Data(json.utf8))
    }

    func testRefusedCorrectionIsALastingGapWithTheCLIWordsNotSwitching() throws {
        let refusal = try XCTUnwrap(PermissionModeRefusal(event: refusalEvent()))
        XCTAssertEqual(refusal, PermissionModeRefusal(seq: 7, at: "2026-11-22T12:00:01.000Z", mode: "default",
                                                      requested: "auto", reason: words))
        let report = change(from: "auto", to: "default", cause: "ENGINE_REPORT")
        let gap = SessionModeDisplay(intent: .auto, actual: "default", beforeStart: false,
                                     latestChange: report, refusal: refusal)
        XCTAssertEqual(gap.label, "Default")
        XCTAssertFalse(gap.isCorrecting)
        XCTAssertEqual(gap.reason, "Running in Default. You asked for Auto, but the runner couldn't switch Claude to it: \(words).")
        XCTAssertEqual(refusal.line, "Claude stays in Default — the runner couldn't switch it to Auto: \(words)")
        // Without the refusal the same report still reads as the runner switching it.
        XCTAssertTrue(SessionModeDisplay(intent: .auto, actual: "default", beforeStart: false, latestChange: report).isCorrecting)
    }

    func testTheNextChangeEndsARefusal() throws {
        let refusal = try XCTUnwrap(PermissionModeRefusal(event: refusalEvent()))
        let corrected = SessionPermissionModeChange(fromMode: "default", toMode: "auto", cause: "RUNNER_CORRECTION",
                                                    client: nil, at: "2026-11-22T12:05:00.000Z")
        XCTAssertFalse(refusal.stands(latest: corrected, actual: "auto"))
        let respawn = SessionPermissionModeChange(fromMode: "auto", toMode: "default", cause: "RESPAWN",
                                                  client: nil, at: "2026-11-22T12:20:00.000Z")
        XCTAssertFalse(refusal.stands(latest: respawn, actual: "default"), "a later re-spawn makes its own attempt")
        let corrected2 = #"{"seq":3,"type":"system","payload":{"subtype":"permission_mode_corrected","mode":"auto"}}"#
        XCTAssertNil(PermissionModeRefusal(event: try JSONDecoder().decode(RunEvent.self, from: Data(corrected2.utf8))))
    }

    func testRefusalCardIsARecordPlacedAtTheRunnersReport() throws {
        let refusal = try XCTUnwrap(PermissionModeRefusal(event: refusalEvent()))
        let card = DeliveredDecisionCard(kind: .permissionModeRefusal(refusal), placement: .at(refusal.at))
        XCTAssertTrue(card.kind.isRecord)
        XCTAssertEqual(card.id, "permission-mode-refused-7")
    }

    func testClaimLineIsWordedFromTheServersRequestedModeAndReason() throws {
        let detail = try session(#"""
        {"id":"s","status":"RUNNING","permissionMode":"bypassPermissions","actualPermissionMode":"auto",
         "permissionModeChanges":[
           {"fromMode":null,"toMode":"auto","cause":"CLAIM","client":null,"at":"2026-11-22T12:00:00.000Z",
            "requestedMode":"bypassPermissions","reason":"ROOT_RUNNER"}
         ]}
        """#)
        let claim = try XCTUnwrap(detail.permissionModeChanges?.first)
        XCTAssertEqual(claim.requestedMode, "bypassPermissions")
        XCTAssertEqual(claim.reason, "ROOT_RUNNER")
        XCTAssertEqual(claim.line, "Started in Auto, not Bypass — Bypass can't run on a root runner")
        var scheduled = change(from: "default", to: "auto", cause: "CLAIM")
        scheduled.requestedMode = "default"
        scheduled.reason = "SCHEDULED_RUN"
        XCTAssertEqual(scheduled.line, "Resumed in Auto — scheduled runs always use Auto")
        XCTAssertEqual(change(from: nil, to: "auto", cause: "CLAIM").line, "Started in Auto — assigned at claim")
    }

    private func autoHint(model: String) -> String? {
        SessionModeDisplay.autoStartHint(model: model, engine: "claude", provider: "claude",
                                        configured: [], catalog: nil)
    }

    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private func change(from: String?, to: String, cause: String) -> SessionPermissionModeChange {
        SessionPermissionModeChange(fromMode: from, toMode: to, cause: cause, client: nil,
                                    at: "2026-11-22T12:00:00.000Z")
    }
}

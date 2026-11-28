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

    /// Since migration 1810: each change's seq, the detail's word that older ones exist, and a page of them. Repeated
    /// transitions in one millisecond are rows apart and each drawn once, in the order they were recorded.
    func testRepeatedTransitionsAtOneMomentAreEachDrawnOnceInOrder() throws {
        let detail = try session(#"""
        {"id":"s","status":"RUNNING","permissionMode":"auto","actualPermissionMode":"auto",
         "actualPermissionModeAt":"2026-11-22T12:00:02.000Z","permissionModeChangesHasMore":true,
         "permissionModeChanges":[
           {"fromMode":"auto","toMode":"plan","cause":"OWNER_PICK","client":"web","at":"2026-11-22T12:00:02.000Z","seq":41},
           {"fromMode":"plan","toMode":"auto","cause":"OWNER_PICK","client":"ios","at":"2026-11-22T12:00:02.000Z","seq":42},
           {"fromMode":"auto","toMode":"plan","cause":"OWNER_PICK","client":"web","at":"2026-11-22T12:00:02.000Z","seq":43},
           {"fromMode":"plan","toMode":"auto","cause":"OWNER_PICK","client":"ios","at":"2026-11-22T12:00:02.000Z","seq":44}
         ]}
        """#)
        XCTAssertEqual(detail.permissionModeChangesHasMore, true)
        XCTAssertNil(try session(#"{"id":"s","status":"RUNNING"}"#).permissionModeChangesHasMore)
        let changes = try XCTUnwrap(detail.permissionModeChanges)
        XCTAssertEqual(changes.map(\.seq), [41, 42, 43, 44])
        XCTAssertEqual(Set(changes.map(\.rowID)).count, 4)
        let cards = changes.map { DeliveredDecisionCard(kind: .permissionModeChange($0), placement: .at($0.at)) }
        var state = TranscriptState()
        state.items = [.user(UserBubble(id: "message", text: "Hello", ts: "2026-11-22T12:00:01.000Z",
                                        pending: false, queued: false))]
        let rows = TranscriptRows.build(state: state, statusCards: [], canPageOlder: false,
                                        showWorkingIndicator: false, decisionCards: cards)
        XCTAssertEqual(rows.map(\.id), ["message"] + cards.map(\.id) + ["transcript-bottom"])

        let page = try JSONDecoder().decode(SessionPermissionModeChangePage.self, from: Data(#"""
        {"changes":[{"fromMode":null,"toMode":"auto","cause":"CLAIM","client":null,"at":"2026-11-22T11:59:00.000Z","seq":7}],
         "hasMore":false}
        """#.utf8))
        XCTAssertEqual(page.changes.map(\.seq), [7])
        XCTAssertFalse(page.hasMore)
    }

    func testHistoryHoldsEachChangeOnceAsTheTranscriptPagesBack() {
        let held = ModeChangeHistory().adopt(numbered(11...60), hasMore: true)
        XCTAssertEqual(held.changes.map(\.seq), Array(11...60))
        XCTAssertTrue(held.hasMore)
        XCTAssertEqual(held.adopt(numbered(11...60), hasMore: true), held)
        // A change that falls out of the newest fifty stays; the new ones are added once.
        let grown = ModeChangeHistory(changes: numbered(1...60), hasMore: false).adopt(numbered(13...62), hasMore: true)
        XCTAssertEqual(grown.changes.map(\.seq), Array(1...62))
        XCTAssertFalse(grown.hasMore)
        // A detail that no longer reaches what is held starts it again, so nothing in between is missed.
        let restarted = ModeChangeHistory(changes: numbered(1...60), hasMore: false).adopt(numbered(71...120), hasMore: true)
        XCTAssertEqual(restarted.changes.map(\.seq), Array(71...120))
        XCTAssertTrue(restarted.hasMore)
        // A page goes only onto the oldest it was read for.
        let paged = held.withOlder(before: 11, SessionPermissionModeChangePage(changes: numbered(1...10), hasMore: false))
        XCTAssertEqual(paged.changes.map(\.seq), Array(1...60))
        XCTAssertFalse(paged.hasMore)
        XCTAssertEqual(held.withOlder(before: 5, SessionPermissionModeChangePage(changes: numbered(1...4), hasMore: false)), held)
        // An older server's changes, which carry no seq, are held as the detail says and page nothing.
        let unnumbered = [change(from: nil, to: "auto", cause: "CLAIM")]
        XCTAssertEqual(ModeChangeHistory().adopt(unnumbered, hasMore: true), ModeChangeHistory(changes: unnumbered))
    }

    func testHistoryReadsOlderOnlyAsFarBackAsTheTranscript() {
        let held = ModeChangeHistory(changes: numbered(11...60), hasMore: true)
        XCTAssertFalse(held.needsOlder(oldestRowAt: stamp(30), reachesStart: false))
        XCTAssertTrue(held.needsOlder(oldestRowAt: stamp(11), reachesStart: false))
        XCTAssertTrue(held.needsOlder(oldestRowAt: stamp(5), reachesStart: false))
        XCTAssertTrue(held.needsOlder(oldestRowAt: stamp(30), reachesStart: true))
        XCTAssertFalse(held.needsOlder(oldestRowAt: nil, reachesStart: true))
        XCTAssertFalse(ModeChangeHistory(changes: numbered(11...60)).needsOlder(oldestRowAt: stamp(5), reachesStart: true))
        // Read off a transcript: its oldest row with a clock, and whether it has paged back to the start.
        var state = TranscriptState()
        state.items = [.user(UserBubble(id: "m", text: "Hi", ts: stamp(30), pending: false, queued: false))]
        state.maxSeq = 4
        state.hasMoreOlder = true
        XCTAssertFalse(held.needsOlder(in: state))
        state.hasMoreOlder = false
        XCTAssertTrue(held.needsOlder(in: state))
    }

    private func stamp(_ seconds: Int) -> String {
        String(format: "2026-11-27T05:%02d:%02d.000Z", seconds / 60, seconds % 60)
    }

    private func numbered(_ seqs: ClosedRange<Int>) -> [SessionPermissionModeChange] {
        seqs.map { seq in
            SessionPermissionModeChange(fromMode: seq % 2 == 1 ? "auto" : "plan", toMode: seq % 2 == 1 ? "plan" : "auto",
                                        cause: "OWNER_PICK", client: "ios", at: stamp(seq), seq: seq)
        }
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

import XCTest
@testable import OrbitKit

/// Applying a control-plane event to a loaded list row instead of refetching the list (see
/// `SessionUpsert`). The contract under test is which fields the event owns and which it must leave
/// alone: the summary is a slim payload, so anything it omits has to survive the merge or the row
/// would visibly lose content (its preview line, tags, pin) every time a turn ticked.
final class SessionUpsertTests: XCTestCase {

    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private func summary(_ json: String) throws -> ControlSessionSummary {
        try JSONDecoder().decode(ControlSessionSummary.self, from: Data(json.utf8))
    }

    /// A fully-populated list row: everything the `GET /sessions` payload carries, including the
    /// fields the control summary does not.
    private func loadedRow() throws -> Session {
        try session(##"""
        {"id":"s1","title":"Fix bug","status":"RUNNING","runStatus":"RUNNING","runState":"RUNNING",
         "lifecycleState":"OPEN","pendingApprovals":0,"lastTurnAt":"2026-08-01T10:00:00.000Z",
         "createdAt":"2026-08-01T09:00:00.000Z","updatedAt":"2026-08-01T10:00:00.000Z",
         "pinnedAt":"2026-08-01T09:30:00.000Z","assignedRunnerId":"r1","branch":"orbit/s1",
         "provider":"claude","model":"opus","permissionMode":"dontAsk","effort":"high",
         "lastAssistantText":"here you go","lastToolUse":"Read","lastUserText":"do it",
         "runningBgCount":2,"error":"boom","endReason":"IDLE",
         "agent":{"id":"a1","name":"builder","provider":"claude","model":"opus","effort":"high"},
         "tags":[{"id":"t1","name":"Red","color":"#FF3B30","isSystem":true,"position":0}]}
        """##)
    }

    func testAdoptsTheFieldsTheEventOwns() throws {
        let row = try loadedRow()
        let event = try summary("""
        {"id":"s1","title":"Fix bug, better","status":"AWAITING_INPUT","runStatus":"AWAITING_INPUT",
         "sessionState":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN",
         "capabilities":{"canSend":true,"canResume":true,"canComplete":true,"canRestore":false},
         "agentId":"a1","agent":{"id":"a1","name":"builder","model":"opus"},
         "pendingApprovals":3,"lastTurnAt":"2026-08-01T11:00:00.000Z"}
        """)
        let merged = row.applying(event)

        XCTAssertEqual(merged.title, "Fix bug, better")
        XCTAssertEqual(merged.status, .awaitingInput)
        XCTAssertEqual(merged.runStatus, .awaitingInput)
        XCTAssertEqual(merged.sessionState, .awaitingInput)
        XCTAssertEqual(merged.runState, .awaitingInput)
        XCTAssertEqual(merged.effectiveRunState, .awaitingInput)
        XCTAssertEqual(merged.pendingApprovals, 3)
        XCTAssertEqual(merged.lastTurnAt, "2026-08-01T11:00:00.000Z")
        XCTAssertEqual(merged.agentId, "a1")
        XCTAssertEqual(merged.capabilities?.canSend, true)
    }

    /// The whole point of merging rather than replacing: the slim payload must not blank the row.
    func testPreservesEverythingTheSummaryOmits() throws {
        let row = try loadedRow()
        let event = try summary("""
        {"id":"s1","title":"Fix bug","status":"RUNNING","pendingApprovals":1}
        """)
        let merged = row.applying(event)

        XCTAssertEqual(merged.lastAssistantText, "here you go")
        XCTAssertEqual(merged.lastToolUse, "Read")
        XCTAssertEqual(merged.lastUserText, "do it")
        XCTAssertEqual(merged.runningBgCount, 2)
        XCTAssertEqual(merged.tags?.map(\.id), ["t1"])
        XCTAssertEqual(merged.pinnedAt, row.pinnedAt)
        XCTAssertEqual(merged.assignedRunnerId, "r1")
        XCTAssertEqual(merged.branch, "orbit/s1")
        XCTAssertEqual(merged.error, "boom")
        XCTAssertEqual(merged.endReason, "IDLE")
        XCTAssertEqual(merged.model, "opus")
        XCTAssertEqual(merged.permissionMode, "dontAsk")
        XCTAssertEqual(merged.effort, "high")
        XCTAssertEqual(merged.provider, "claude")
        XCTAssertEqual(merged.createdAt, row.createdAt)
        XCTAssertEqual(merged.id, "s1")
    }

    /// The row's nested agent carries provider + effort; the summary's carries neither, so the
    /// richer one has to win or the composer would lose that context on a status change.
    func testKeepsTheRicherNestedAgent() throws {
        let row = try loadedRow()
        let event = try summary("""
        {"id":"s1","status":"RUNNING","agent":{"id":"a1","name":"builder","model":"opus"},
         "pendingApprovals":0}
        """)
        let merged = row.applying(event)
        XCTAssertEqual(merged.agent?.provider, "claude")
        XCTAssertEqual(merged.agent?.effort, "high")
    }

    /// …but it does fill a row that has none (a record from an endpoint that omits the nested agent).
    func testAdoptsTheSummaryAgentWhenTheRowHasNone() throws {
        let row = try session(#"{"id":"s1","status":"RUNNING"}"#)
        let event = try summary("""
        {"id":"s1","status":"RUNNING","agent":{"id":"a1","name":"builder","model":"opus"},
         "pendingApprovals":0}
        """)
        let merged = row.applying(event)
        XCTAssertEqual(merged.agent?.id, "a1")
        XCTAssertEqual(merged.agent?.name, "builder")
        XCTAssertNil(merged.agent?.provider)
    }

    /// A null title means "not named yet", not "cleared" — the naming pass fills it in later.
    func testNullTitleDoesNotClearAName() throws {
        let row = try loadedRow()
        let event = try summary("""
        {"id":"s1","title":null,"status":"RUNNING","pendingApprovals":0}
        """)
        XCTAssertEqual(row.applying(event).title, "Fix bug")
    }

    /// An older/newer control plane can send an unrecognized (→ `.unknown`) lifecycle; that must not
    /// overwrite the known location the list query gave us.
    func testUnknownLifecycleDoesNotOverwriteAKnownOne() throws {
        let row = try loadedRow()
        let event = try summary("""
        {"id":"s1","status":"RUNNING","lifecycleState":"SOMETHING_NEW","pendingApprovals":0}
        """)
        let merged = row.applying(event)
        XCTAssertEqual(merged.lifecycleState, .open)
        XCTAssertEqual(merged.effectiveLifecycleState, .open)
    }

    func testSettingPendingApprovalsTouchesNothingElse() throws {
        let row = try loadedRow()
        let merged = row.settingPendingApprovals(4)
        XCTAssertEqual(merged.pendingApprovals, 4)
        // Equal on every other field: putting the original count back reproduces the row exactly.
        XCTAssertEqual(merged.settingPendingApprovals(0), row)
    }

    /// The pending count is what flips a running row between the spinner and the amber needs-you
    /// cue, so an approval event alone is enough to repaint it — no list refetch needed.
    func testPendingApprovalsDrivesTheRowGlyph() throws {
        let row = try loadedRow()
        XCTAssertEqual(SessionStatusGlyph.make(for: row).shape, .spinner)
        XCTAssertEqual(SessionStatusGlyph.make(for: row.settingPendingApprovals(1)).tone, .warning)
    }

    /// `POST /sessions` answers with a flat `agentId` and no nested agent, and that record is
    /// registered straight into the loaded lists — so the agent filter has to recognize it, or the
    /// row vanishes from the very list that just created it.
    func testForAgentMatchesAFlatAgentIdRow() throws {
        let created = try session(#"{"id":"new","status":"PENDING","agentId":"a1"}"#)
        let listed = try session(#"{"id":"old","status":"RUNNING","agent":{"id":"a1","name":"builder"}}"#)
        let other = try session(#"{"id":"other","status":"RUNNING","agentId":"a2"}"#)
        XCTAssertEqual(SessionFilter.forAgent([created, listed, other], agentID: "a1").map(\.id),
                       ["new", "old"])
    }
}

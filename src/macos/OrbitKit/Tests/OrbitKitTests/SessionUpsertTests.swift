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
         "projectId":"p1","projectTitle":"Initial project",
         "lastAssistantText":"here you go","lastToolUse":"Read","lastUserText":"do it",
         "runningBgCount":2,"runningBgJobCount":1,"error":"boom","endReason":"IDLE",
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
         "projectId":"p2","projectTitle":"Renamed project",
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
        XCTAssertEqual(merged.projectId, "p2")
        XCTAssertEqual(merged.projectTitle, "Renamed project")
        XCTAssertEqual(merged.capabilities?.canSend, true)
    }

    /// Coordinator relation updates need all three wire states: value binds/renames, explicit null
    /// clears after rotation/delete, and absence from an older server preserves the loaded row.
    func testTracksProjectRelationValueNullAndAbsence() throws {
        let row = try loadedRow()
        let changed = try summary("""
        {"id":"s1","status":"RUNNING","pendingApprovals":0,
         "projectId":"p2","projectTitle":"Renamed project"}
        """)
        let rebound = row.applyingProjectRelation(changed)
        XCTAssertEqual(rebound.projectId, "p2")
        XCTAssertEqual(rebound.projectTitle, "Renamed project")

        let removed = try summary("""
        {"id":"s1","status":"RUNNING","pendingApprovals":0,
         "projectId":null,"projectTitle":null}
        """)
        let ordinary = rebound.applyingProjectRelation(removed)
        XCTAssertNil(ordinary.projectId)
        XCTAssertNil(ordinary.projectTitle)

        let legacy = try summary("""
        {"id":"s1","status":"RUNNING","pendingApprovals":0}
        """)
        XCTAssertEqual(row.applyingProjectRelation(legacy).projectId, "p1")
        XCTAssertEqual(row.applyingProjectRelation(legacy).projectTitle, "Initial project")
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
        // The count of those that are jobs with an end, which the glyph's motion reads: an event
        // arriving mid-job must not stop it breathing.
        XCTAssertEqual(merged.runningBgJobCount, 1)
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

    /// `retryAt` is the one field where the summary's null differs from its absence, because the
    /// row's state depends on it: the summary that turns a row FAILED is also what says the
    /// failure is being retried, and the summary that clears it is how the row learns the retries
    /// ran out. Merging a null as "unchanged" would leave a spent countdown drawn as "Retrying".
    func testTracksTheArmedRetryInBothDirections() throws {
        let row = try loadedRow()
        let failedArmed = try summary("""
        {"id":"s1","status":"FAILED","runStatus":"FAILED","runState":"FAILED","pendingApprovals":0,
         "retryAt":"2026-08-01T10:00:30.000Z"}
        """)
        let armed = row.applying(failedArmed)
        XCTAssertEqual(armed.retryAt, "2026-08-01T10:00:30.000Z")
        let midWait = try XCTUnwrap(RelativeTime.parse("2026-08-01T10:00:10Z"))
        XCTAssertTrue(armed.retryPending(now: midWait))

        // Gave up: same status, explicit null. The row must stop claiming a retry is coming.
        let gaveUp = try summary("""
        {"id":"s1","status":"FAILED","runStatus":"FAILED","runState":"FAILED","pendingApprovals":0,
         "retryAt":null}
        """)
        XCTAssertNil(armed.applying(gaveUp).retryAt)

        // An older control plane omits the key entirely — that is the only "leave it alone".
        let legacy = try summary("""
        {"id":"s1","status":"FAILED","runStatus":"FAILED","runState":"FAILED","pendingApprovals":0}
        """)
        XCTAssertEqual(armed.applying(legacy).retryAt, "2026-08-01T10:00:30.000Z")
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

    /// A session moved to another workspace (docs/session-folders-move-design.md §5.6): the summary
    /// names the new workspace, and the row takes the summary's agent for it — the lists group rows
    /// by `agent.id`, so the row's own agent would hold it in the old workspace's list until the next
    /// snapshot. The row leaves the list it was in and joins the other workspace's at once.
    func testAMoveToAnotherWorkspaceTakesTheSummarysAgent() throws {
        let row = try loadedRow()
        XCTAssertEqual(SessionFilter.forAgent([row], agentID: "a1").map(\.id), ["s1"])
        let event = try summary("""
        {"id":"s1","status":"SUCCEEDED","runStatus":"SUCCEEDED","runState":"SUCCEEDED","pendingApprovals":0,
         "agentId":"a2","agent":{"id":"a2","name":"site","model":"sonnet","effort":"medium"},"folderId":"f9"}
        """)
        let moved = row.applying(event)

        XCTAssertEqual(moved.agentId, "a2")
        XCTAssertEqual(moved.agent?.id, "a2")
        XCTAssertEqual(moved.agent?.name, "site")
        XCTAssertEqual(moved.agent?.model, "sonnet")
        XCTAssertEqual(moved.agent?.effort, "medium")
        XCTAssertEqual(moved.folderId, "f9")
        XCTAssertEqual(SessionFilter.forAgent([moved], agentID: "a1"), [], "gone from the old workspace's list")
        XCTAssertEqual(SessionFilter.forAgent([moved], agentID: "a2").map(\.id), ["s1"], "and in the new one's")
        // Nothing else the summary leaves out is lost on the way.
        XCTAssertEqual(moved.lastAssistantText, "here you go")
        XCTAssertEqual(moved.tags?.map(\.id), ["t1"])
        XCTAssertEqual(moved.provider, "claude")
    }

    /// A summary that names the new workspace but carries no agent still moves the row: a bare agent
    /// for that workspace, which the next snapshot fills in.
    func testAMoveWithoutTheSummarysAgentStillMovesTheRow() throws {
        let row = try loadedRow()
        let event = try summary(#"{"id":"s1","status":"RUNNING","pendingApprovals":0,"agentId":"a2"}"#)
        let moved = row.applying(event)
        XCTAssertEqual(moved.agent?.id, "a2")
        XCTAssertNil(moved.agent?.name)
        XCTAssertEqual(SessionFilter.forAgent([moved], agentID: "a2").map(\.id), ["s1"])

        // A row that only knows its workspace by the flat id moves the same way.
        let flat = try session(#"{"id":"s1","status":"RUNNING","agentId":"a1"}"#)
        let event2 = try summary("""
        {"id":"s1","status":"RUNNING","pendingApprovals":0,"agentId":"a2","agent":{"id":"a2","name":"site"}}
        """)
        XCTAssertEqual(flat.applying(event2).agent?.id, "a2")
        XCTAssertEqual(SessionFilter.forAgent([flat.applying(event2)], agentID: "a1"), [])
    }

    /// The same workspace is no move: the row's richer agent stays (the test above it), and so does
    /// a row whose summary names no workspace at all.
    func testNoWorkspaceInTheSummaryLeavesTheRowWhereItIs() throws {
        let row = try loadedRow()
        let event = try summary(#"{"id":"s1","status":"RUNNING","pendingApprovals":0}"#)
        XCTAssertEqual(row.applying(event).agent, row.agent)
        XCTAssertNil(row.applying(event).agentId)
    }

    /// The app's own move writes the new workspace into the row once the server has it there.
    func testSettingWorkspaceMovesTheRowAndItsFolder() throws {
        let row = try loadedRow()
        let moved = row.settingWorkspace(id: "a2", name: "site", model: "sonnet", effort: nil, folder: "f9")
        XCTAssertEqual(moved.agentId, "a2")
        XCTAssertEqual(moved.agent, SessionAgentRef(id: "a2", name: "site", provider: nil, model: "sonnet", effort: nil))
        XCTAssertEqual(moved.folderId, "f9")
        XCTAssertEqual(SessionFilter.forAgent([moved], agentID: "a1"), [])
        XCTAssertNil(moved.settingWorkspace(id: "a2", name: "site", model: nil, effort: nil, folder: nil).folderId)
        XCTAssertEqual(moved.title, row.title)
        XCTAssertEqual(moved.pinnedAt, row.pinnedAt)
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

    /// The optimistic half of a rename: the typed title shows immediately, and nothing else on the
    /// row moves while the server's `session.updated` is in flight.
    func testSettingTitleTouchesNothingElse() throws {
        let row = try loadedRow()
        let merged = row.settingTitle("Fix bug, properly")
        XCTAssertEqual(merged.title, "Fix bug, properly")
        XCTAssertEqual(merged.settingTitle("Fix bug"), row)
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

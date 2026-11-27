import Foundation
import XCTest
@testable import OrbitKit

/// A failed landing fixed by the task's own session (contract revision 42, §12.5, §12.7), as ruled on
/// docs/mocks/landing-fix-own-session: the turn read back into its card, S5's shapes decoded, the
/// Fixing state and the hand-back read off a landing view, the record's new rows, the task row and the
/// project page's Open items group.
final class LandingFixTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let target = "project/34ZZnLsPqC2jVd8CsCFp"

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try decoder.decode(type, from: Data(json.utf8))
    }

    /// The turn's words exactly as `landing-fix-turn.ts#landingFixMessage` writes a conflict.
    private var conflictTurn: String {
        [
            "Orbit could not land your work for \"A10c · Notification \"cold start\" drops the session\" on \(target).",
            "",
            "Conflict while rebasing onto \(target) at 41ac9e0c2b7d:",
            "app/src/main/kotlin/io/orbitd/notify/ColdStartRouter.kt, app/src/main/kotlin/io/orbitd/session/SessionListStore.kt",
            "",
            "Nothing was pushed. \(target) is unchanged.",
            "",
            "Fix it on your own branch, in this checkout:",
            "1. Merge \(target) into your branch and resolve what conflicts.",
            "2. Run what failed until it passes.",
            "3. Commit, then end your turn.",
            "",
            "Orbit lands the new commit and runs the checks again by itself. Do not push \(target).",
            "If this is not yours to fix, end your turn without committing and say why; the project's coordinator takes it from there.",
            "The full record: landing 3e2BVUL9ouZf2MKTCThrP6.",
        ].joined(separator: "\n")
    }

    private var checkTurn: String {
        [
            "Orbit could not land your work for \"Write back first\" on main.",
            "",
            "The check \"landing check\" (npm run check:landing) failed on the combined tree (9f1c2ab77), exit 1:",
            "FAIL src/store.test.ts",
            "  expected 2, got 3",
            "",
            "Nothing was pushed. main is unchanged.",
            "",
            "Fix it on your own branch, in this checkout:",
            "1. Merge main and upstream/main into your branch and resolve what conflicts.",
            "2. Run what failed until it passes.",
            "3. Commit, then end your turn.",
            "",
            "Orbit lands the new commit and runs the checks again by itself. Do not push main.",
            "If this is not yours to fix, end your turn without committing and say why; the project's coordinator takes it from there.",
            "The full record: landing not recorded.",
        ].joined(separator: "\n")
    }

    // MARK: - ② b, the card

    func testAConflictTurnReadsBackIntoTheBoardsCard() throws {
        let card = try XCTUnwrap(LandingFix.parse(clientTurnId: "landing-fix:v1:job-1", text: conflictTurn))
        XCTAssertEqual(card.failure, .conflict)
        XCTAssertEqual(card.taskTitle, "A10c · Notification \"cold start\" drops the session")
        XCTAssertEqual(card.target, target)
        XCTAssertEqual(card.badge, "Conflict")
        XCTAssertEqual(card.heading, "Orbit could not land your work on project/34ZZn...CsCFp")
        XCTAssertEqual(card.lead, "Conflict while rebasing onto the project branch at")
        XCTAssertEqual(card.sha, "41ac9e0")
        XCTAssertEqual(card.boxLines, ["app/…/notify/ColdStartRouter.kt", "app/…/session/SessionListStore.kt"])
        XCTAssertEqual(card.steps, [
            "Merge the project branch into your branch and resolve what conflicts.",
            "Run what failed until it passes.",
            "Commit, then end your turn.",
        ])
        XCTAssertEqual(card.footer, "Orbit lands the new commit and runs the checks again. Do not push the project branch. "
            + "Not yours to fix? End your turn without committing and say why.")
        XCTAssertEqual(card.landingSessionId, "3e2BVUL9ouZf2MKTCThrP6")
    }

    func testAFailedCheckTurnNamesTheCheckItsExitAndItsLines() throws {
        let card = try XCTUnwrap(LandingFix.parse(clientTurnId: nil, text: checkTurn))
        XCTAssertEqual(card.failure, .checkFailed)
        XCTAssertEqual(card.badge, "Check failed")
        XCTAssertEqual(card.heading, "Orbit could not land your work on main")
        XCTAssertEqual(card.lead, "The check \"landing check\" failed on the combined tree, exit 1, at")
        XCTAssertEqual(card.sha, "9f1c2ab")
        XCTAssertEqual(card.boxLines, ["FAIL src/store.test.ts", "  expected 2, got 3"])
        XCTAssertEqual(card.upstream, "upstream/main")
        XCTAssertEqual(card.steps.first, "Merge main and upstream/main into your branch and resolve what conflicts.")
        XCTAssertNil(card.landingSessionId)
    }

    func testAnyOtherTurnIsNoCard() {
        XCTAssertNil(LandingFix.parse(clientTurnId: "c-1", text: "Please land my work"))
        XCTAssertNil(LandingFix.parse(clientTurnId: "landing-fix:v1:j", text: "Something else"))
        XCTAssertTrue(LandingFix.isTurn(clientTurnId: "landing-fix:v1:j", text: ""))
        XCTAssertTrue(LandingFix.isTurn(clientTurnId: nil, text: conflictTurn))
    }

    func testBranchesAndPathsShortenAsTheBoardDoes() {
        XCTAssertEqual(LandingFix.shortBranch(target), "project/34ZZn...CsCFp")
        XCTAssertEqual(LandingFix.shortBranch("main"), "main")
        XCTAssertEqual(LandingFix.shortBranch("project/foo-352xNyEH"), "project/foo-352xNyEH")
        XCTAssertEqual(LandingFix.shortBranch("project/352xNyEH"), "project/352xNyEH")
        XCTAssertEqual(LandingFix.shortPath("a/b.kt"), "a/b.kt")
        XCTAssertEqual(LandingFix.shortPath("app/src/x/y/notify/Router.kt"), "app/…/notify/Router.kt")
    }

    // MARK: - S5's shapes

    func testOpenItemsDecodeTheHeldGroupAndEachRowsWorkSession() throws {
        let view = try decode(ProjectOpenItemsView.self, """
        {"needsYou": [], "withCoordinator": [],
         "withWorkSession": [{"itemId": "i1", "kind": "INTEGRATION_CONFLICT", "title": "Landing conflict",
           "waitingSince": "2026-11-23T10:00:00.000Z", "assignee": "COORDINATOR", "taskId": "t1",
           "workSession": {"sessionId": "s1", "offeredAt": "2026-11-23T10:02:00.000Z", "rounds": 0}}]}
        """)
        XCTAssertEqual(view.withWorkSession.count, 1)
        let held = try XCTUnwrap(view.withWorkSession.first?.workSession)
        XCTAssertEqual(held.sessionId, "s1")
        XCTAssertTrue(held.held)
        XCTAssertEqual(held.round, 1)
        let back = try decode(OpenItemWorkSession.self, """
        {"sessionId": "s1", "offeredAt": "a", "returnedAt": "b", "returnReason": "NO_NEW_COMMIT", "rounds": 2}
        """)
        XCTAssertFalse(back.held)
        XCTAssertEqual(back.returnReason, "NO_NEW_COMMIT")
        XCTAssertEqual(back.round, 2)
        // An older server: no group, no field.
        let old = try decode(ProjectOpenItemsView.self, #"{"needsYou": [], "withCoordinator": []}"#)
        XCTAssertTrue(old.withWorkSession.isEmpty)
    }

    func testTheTaskRowAndTheTodoNameTheSessionThatHasIt() throws {
        let integration = try decode(TaskIntegrationView.self,
                                     #"{"state": "FIXING", "workSessionId": "s1", "openItemId": "i1"}"#)
        XCTAssertEqual(integration.state, "FIXING")
        XCTAssertEqual(integration.workSessionId, "s1")
        let todo = try decode(SessionLandingTodo.self, #"{"id": "i1", "workSessionId": "s1"}"#)
        XCTAssertEqual(todo.workSessionId, "s1")
        XCTAssertNil(try decode(SessionLandingTodo.self, #"{"id": "i1"}"#).workSessionId)
    }

    // MARK: - ② c, d — the landing window

    private func entry(_ kind: String, _ text: String, at: String, data: [String: JSONValue]? = nil,
                       reason: String? = nil) -> IntegrationTimelineEntry {
        IntegrationTimelineEntry(kind: kind, at: at, claim: 1, reason: reason, data: data, text: text, derived: true)
    }

    private func landing(held: Bool, returned: Bool = false, words: String? = nil) -> SessionLandingView {
        var first: [IntegrationTimelineEntry] = [
            entry("ENQUEUED", "Task marked done · queued to land", at: "2026-11-23T10:01:00.000Z"),
            entry("RESULT", "Conflict in 2 files · nothing was pushed", at: "2026-11-23T10:02:00.000Z",
                  data: ["state": .string("CONFLICT")]),
            entry("HANDED_TO_SESSION", "Handed to the task's session", at: "2026-11-23T10:02:01.000Z",
                  data: ["sessionId": .string("s1")]),
        ]
        if returned {
            var data: [String: JSONValue] = ["sessionId": .string("s1"), "returnReason": .string("NO_NEW_COMMIT")]
            if let words { data["lastMessage"] = .string(words) }
            first.append(entry("RETURNED_TO_COORDINATOR", "Returned to the coordinator: no new commit",
                               at: "2026-11-23T10:31:00.000Z", data: data, reason: "NO_NEW_COMMIT"))
        }
        return SessionLandingView(
            sessionId: "L1", projectId: "P1", subject: "TASK", taskId: "t1",
            currentAttempt: SessionLandingAttempt(jobId: "j1", kind: "LAND_TASK", state: "CONFLICT", phase: "REBASE",
                                                  claim: 1, sourceSessionId: "s1",
                                                  targetRef: "refs/heads/project/34ZZnLsPqC2jVd8CsCFp"),
            todos: [SessionLandingTodo(id: "i1", kind: "INTEGRATION_CONFLICT", state: "OPEN",
                                       waitingSince: "2026-11-23T10:02:00.000Z",
                                       workSessionId: held ? "s1" : nil)],
            timeline: SessionLandingTimeline(sections: [
                IntegrationTimelineSection(title: "Generation 1", jobId: "j1", kind: "LAND_TASK", generation: 1,
                                           state: "CONFLICT", entries: first),
            ]))
    }

    func testAHeldFailureReadsFixingWithWhoseHandsAndWhichRound() throws {
        let view = landing(held: true)
        XCTAssertTrue(LandingFix.isFixing(view))
        XCTAssertEqual(LandingFix.workSessionId(view), "s1")
        XCTAssertEqual(LandingFix.fixingDetail(view), "conflict · its own session is on it")
        let now = try XCTUnwrap(RelativeTime.parse("2026-11-23T10:06:01.000Z"))
        XCTAssertEqual(LandingFix.fixingWho(view, now: now), "is fixing it · 4m · round 1 of 2")
        XCTAssertNil(LandingFix.handBack(view), "nothing has come back while the session has it")
    }

    func testAHandBackCarriesTheSessionsLastWordsWhereTheServerServesThem() throws {
        let words = "The conflict is with A13f's store refactor. Which of the two designs stays is not mine to decide."
        let view = landing(held: false, returned: true, words: words)
        XCTAssertFalse(LandingFix.isFixing(view))
        let back = try XCTUnwrap(LandingFix.handBack(view))
        XCTAssertEqual(back.leadLine, "The task's session ended its turn without a new commit:")
        XCTAssertEqual(back.lastMessage, words)
        XCTAssertEqual(back.sessionId, "s1")
        let now = try XCTUnwrap(RelativeTime.parse("2026-11-23T10:31:20.000Z"))
        XCTAssertEqual(LandingFix.coordinatorHasIt(back, now: now), "has it · just now")
        // No words served: the lead stands alone and says nothing it does not know.
        XCTAssertEqual(LandingFix.handBack(landing(held: false, returned: true))?.leadLine,
                       "The task's session ended its turn without a new commit.")
    }

    func testTheRecordDrawsTheNewRowsUnderTheFailureTheyAreAbout() {
        var view = landing(held: false, returned: true)
        let second = IntegrationTimelineSection(
            title: "Generation 2", jobId: "j2", kind: "LAND_TASK", generation: 2, state: "QUEUED",
            entries: [entry("FIXED_BY_SESSION", "Fixed in 4be19c2 · landing again", at: "2026-11-23T10:09:00.000Z",
                            data: ["sessionId": .string("s1"), "sourceSha": .string("4be19c2aa01")])])
        view = SessionLandingView(sessionId: view.sessionId, projectId: view.projectId, subject: view.subject,
                                  taskId: view.taskId, currentAttempt: view.currentAttempt, todos: view.todos,
                                  timeline: SessionLandingTimeline(sections: (view.timeline?.sections ?? []) + [second]))
        let rows = LandingFix.rows(after: 0, in: view.timeline!.sections)
        XCTAssertEqual(rows.map(\.kind), [.handed, .fixed, .returned])
        XCTAssertEqual(rows[0].head, "Handed to the task's session")
        XCTAssertEqual(rows[0].detail, "It wrote this work · round 1 of 2")
        XCTAssertEqual(rows[1].head, "Fixed in")
        XCTAssertEqual(rows[1].sha, "4be19c2")
        XCTAssertEqual(rows[1].rest, "landing again")
        XCTAssertEqual(rows[2].head, "Returned to the coordinator")
        XCTAssertEqual(rows[2].rest, "no new commit")
        XCTAssertTrue(LandingFix.rows(after: 1, in: view.timeline!.sections).isEmpty)
        XCTAssertEqual(LandingFix.againLine(view), "Landing 4be19c2 again")
        XCTAssertEqual(LandingFix.againLine(view, by: "s1"), "Landing 4be19c2 again")
        XCTAssertNil(LandingFix.againLine(view, by: "s2"), "another session's fix is not this session's line")
        XCTAssertNil(LandingFix.againLine(landing(held: true)))
        // The steps leave them out: no Queue or Sync row says it.
        let steps = LandingSteps.steps(view.timeline!.sections[0].entries, kind: "LAND_TASK")
        XCTAssertFalse(steps.flatMap(\.entries).contains { LandingFix.rowKinds.contains($0.entry.kind) })
        XCTAssertTrue(LandingSteps.steps(second.entries, kind: "LAND_TASK").isEmpty)
    }

    func testTheFailureLineIsTheBoardsOwnSentenceSaidOnce() throws {
        let view = landing(held: true)
        XCTAssertEqual(LandingFix.failureLine(view, files: ["a.kt", "b.kt"]),
                       "Conflict in 2 files while rebasing onto project/34ZZn...CsCFp · nothing was pushed")
        XCTAssertEqual(LandingFix.failureLine(view, files: nil),
                       "Conflict while rebasing onto project/34ZZn...CsCFp · nothing was pushed")
        XCTAssertEqual(LandingFix.failureLine(view, files: ["a.kt"]),
                       "Conflict in 1 file while rebasing onto project/34ZZn...CsCFp · nothing was pushed")
        // The hand-back's subtitle says what stopped and where; the line under it says how much.
        XCTAssertEqual(LandingFix.handBackDetail(landing(held: false, returned: true)),
                       "conflict · rebasing onto the project branch")
        // The files are the failure item's own, found by the landing's todo in any group.
        let items = try decode(ProjectOpenItemsView.self, """
        {"needsYou": [], "withCoordinator": [{"itemId": "i1", "kind": "INTEGRATION_CONFLICT", "title": "t",
           "waitingSince": "2026-11-23T10:00:00.000Z", "facts": {"files": ["a.kt", "b.kt"], "nothingLanded": true}}]}
        """)
        XCTAssertEqual(LandingFix.failedFiles(view, in: items), ["a.kt", "b.kt"])
        XCTAssertNil(LandingFix.failedFiles(view, in: ProjectOpenItemsView()))
    }

    func testTheFooterNamesTheTasksSessionFirstWhileOneHasALanding() {
        XCTAssertEqual(LandingFixCopy.footerSessionFirst,
                       "Orbit runs these landings — nothing to type here. "
                           + "Decisions: the task's own session first, then the coordinator")
        let fixing = LandingsWindow(days: [], now: [LandingsWindowCard(sessionId: "L1", subject: "TASK",
                                                                        state: "FIXING", title: "t", at: 0)])
        XCTAssertTrue(LandingFix.sessionFirst(fixing, details: [:]))
        let waiting = LandingsWindow(days: [], now: [LandingsWindowCard(sessionId: "L3", subject: "TASK",
                                                                         state: "AWAITING_DECISION", title: "t", at: 0)])
        XCTAssertFalse(LandingFix.sessionFirst(waiting, details: ["L3": landing(held: false, returned: true)]))
        XCTAssertTrue(LandingFix.sessionFirst(waiting, details: ["L3": landing(held: true)]))
    }

    // MARK: - the project page

    func testTheTaskRowReadsLandingFixingAndOpensTheSession() throws {
        let row = try decode(ProjectTaskRow.self, """
        {"id": "t1", "title": "A10c", "status": "DONE", "childCount": 0, "unmetCount": 0, "blocksCount": 0,
         "topoLevel": 0, "workState": "DONE", "integration": {"state": "FIXING", "workSessionId": "s1"}}
        """)
        XCTAssertEqual(ProjectPage.integrationTag(row, ref: nil, upstreamRef: nil)?.text, "Landing · fixing")
        XCTAssertEqual(ProjectPage.integrationStage(row), .integrating)
        XCTAssertEqual(ProjectPage.fixingSessionID(row), "s1")
    }

    func testOpenItemsListTheHeldItemApartAndCountItInNobodysNeedsYou() throws {
        let items = try decode(ProjectOpenItemsView.self, """
        {"needsYou": [], "withCoordinator": [],
         "withWorkSession": [{"itemId": "i1", "kind": "INTEGRATION_CONFLICT", "title": "Landing conflict",
           "waitingSince": "2026-11-23T10:02:00.000Z", "assignee": "COORDINATOR", "taskId": "t1",
           "workSession": {"sessionId": "s1", "offeredAt": "2026-11-23T10:02:00.000Z", "rounds": 0}}]}
        """)
        let section = try XCTUnwrap(ProjectPage.openItemsSection(status: .open, started: true, derivedDone: nil,
                                                                 items: items))
        XCTAssertEqual(section.beingFixed.map(\.itemId), ["i1"])
        XCTAssertEqual(section.hint, "0 need you · oldest first")
        XCTAssertEqual(ProjectPage.beingFixedHeading(1), "Being fixed by its session · 1")
        let row = items.withWorkSession[0]
        XCTAssertEqual(LandingFix.itemHead(row, taskTitle: "A10c · Notification cold start drops the session"),
                       "Landing conflict · A10c · Notification cold start drops the session")
        let now = try XCTUnwrap(RelativeTime.parse("2026-11-23T10:06:30.000Z"))
        XCTAssertEqual(LandingFix.itemDetail(row, now: now),
                       "The task's session is on it · 4m · round 1 of 2 · nothing was pushed")
    }
}

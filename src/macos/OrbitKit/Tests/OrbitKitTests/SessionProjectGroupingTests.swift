import XCTest
@testable import OrbitKit

/// Project sectioning + the per-group ordering — the native half of the session-list redesign, held
/// to the same rules as web's `projectGrouping.test.ts` / `sessionRole.test.ts`.
final class SessionProjectGroupingTests: XCTestCase {

    private func session(_ id: String, project: (id: String, title: String?)? = nil,
                         role: SessionProjectRole? = nil, approvals: Int = 0,
                         waitingSince: String? = nil, status: RunStatus = .awaitingInput,
                         engineTurnActive: Bool? = nil, pinnedAt: String? = nil,
                         lastTurnAt: String? = nil, taskId: String? = nil,
                         taskTitle: String? = nil, title: String? = nil) -> Session {
        Session(id: id, title: title ?? id, status: status, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: approvals, branch: nil, updatedAt: nil,
                oldestPendingApprovalAt: waitingSince,
                taskId: taskId, taskTitle: taskTitle,
                projectId: project?.id, projectTitle: project?.title, role: role,
                engineTurnActive: engineTurnActive, agent: nil, pinnedAt: pinnedAt,
                lastTurnAt: lastTurnAt)
    }

    private let alpha = (id: "p1", title: Optional("Alpha"))
    private let beta = (id: "p2", title: Optional("Beta"))
    private let counts = SessionProjectGrouping.countsById([
        ProjectSessionCounts(projectId: "p1", needsYou: 2, running: 1, done: 5, total: 9),
        ProjectSessionCounts(projectId: "p2", needsYou: 0, running: 0, done: 1, total: 4),
    ])

    // MARK: sections

    /// Two projects plus three unfiled rows: one group each in first-mentioned order, then a
    /// trailing Unfiled whose internal sections are the recency ones `SessionTimeGrouping` gives.
    func testGroupsByProjectThenUnfiledByRecency() {
        let now = ISO8601DateFormatter().date(from: "2026-08-22T12:00:00Z")!
        let today = "2026-08-22T09:00:00Z", yesterday = "2026-08-21T09:00:00Z"
        let sections = SessionProjectGrouping.sections([
            session("a", project: alpha, lastTurnAt: today),
            session("u1", lastTurnAt: today),
            session("b", project: beta, lastTurnAt: today),
            session("c", project: alpha, lastTurnAt: today),
            session("u2", lastTurnAt: yesterday),
        ], counts: counts, now: now, calendar: .current)

        XCTAssertEqual(sections.map(\.key), ["p1", "p2", SessionProjectGrouping.unfiledKey])
        XCTAssertEqual(sections.map(\.title), ["Alpha", "Beta", "Unfiled"])
        XCTAssertEqual(sections[0].sections.flatMap { $0.sessions.map(\.id) }, ["a", "c"])
        XCTAssertEqual(sections[1].sections.flatMap { $0.sessions.map(\.id) }, ["b"])
        // Unfiled keeps the recency sections it always had, in the same shape as the time grouper's.
        let unfiled = sections[2]
        XCTAssertEqual(unfiled.sections.map(\.title), ["Today", "Yesterday"])
        XCTAssertEqual(unfiled.sections.flatMap { $0.sessions.map(\.id) }, ["u1", "u2"])
        XCTAssertEqual(SessionTimeGrouping.sections([session("u1", lastTurnAt: today),
                                                     session("u2", lastTurnAt: yesterday)],
                                                    pinnedFirst: false, now: now).map(\.title),
                       unfiled.sections.map(\.title))
    }

    /// The header badge is the server rollup, keyed by project; Pinned and Unfiled are not projects
    /// and carry none.
    func testHeaderCountsComeFromTheServerRollup() {
        let sections = SessionProjectGrouping.sections([
            session("pin", pinnedAt: "2026-08-22T08:00:00Z"),
            session("a", project: alpha),
            session("u"),
        ], counts: counts)
        XCTAssertEqual(sections.map(\.key),
                       [SessionProjectGrouping.pinnedKey, "p1", SessionProjectGrouping.unfiledKey])
        XCTAssertNil(sections[0].counts)
        XCTAssertEqual(sections[1].counts, ProjectSessionCounts(projectId: "p1", needsYou: 2,
                                                                running: 1, done: 5, total: 9))
        XCTAssertNil(sections[2].counts)
    }

    /// Rolling a project up hides its rows but must never hide the fact that someone is waiting on
    /// you — the whole reason the rollup is on the header.
    func testCollapsedGroupKeepsItsBadgeAndCountButDropsItsRows() {
        let sections = SessionProjectGrouping.sections([
            session("a", project: alpha, approvals: 1),
            session("b", project: alpha),
        ], counts: counts, collapsed: ["p1"])
        XCTAssertEqual(sections.count, 1)
        XCTAssertTrue(sections[0].collapsed)
        XCTAssertTrue(sections[0].sections.isEmpty)
        XCTAssertEqual(sections[0].count, 2)
        XCTAssertEqual(sections[0].counts?.needsYou, 2)
    }

    func testPinnedLiftsAheadOfEveryProjectAndOnlyWhenAsked() {
        let rows = [session("pin", project: alpha, pinnedAt: "2026-08-22T08:00:00Z"),
                    session("a", project: alpha)]
        XCTAssertEqual(SessionProjectGrouping.sections(rows).map(\.key),
                       [SessionProjectGrouping.pinnedKey, "p1"])
        // Under a tag filter (or in Completed/Trash) pinning doesn't apply, and the row groups by
        // its project like any other.
        XCTAssertEqual(SessionProjectGrouping.sections(rows, pinnedFirst: false).map(\.key), ["p1"])
    }

    /// A row that only carries the id must not leave the group titleless when a later row names it.
    func testGroupTitleFallsBackToTheFirstRowThatNamesTheProject() {
        let sections = SessionProjectGrouping.sections([
            session("a", project: (id: "p1", title: nil)),
            session("b", project: alpha),
        ])
        XCTAssertEqual(sections.map(\.title), ["Alpha"])
        XCTAssertEqual(SessionProjectGrouping.sections([session("a", project: (id: "p9", title: nil))])
                        .map(\.title), ["Untitled project"])
    }

    func testHasProjectsGatesTheWholeGrouping() {
        XCTAssertFalse(SessionProjectGrouping.hasProjects([session("a"), session("b")]))
        XCTAssertTrue(SessionProjectGrouping.hasProjects([session("a"), session("b", project: beta)]))
    }

    // MARK: ordering (web parity: Main > needs you > running > rest, then waitingSince ASC)

    func testOrdersMainThenBlockedThenRunningThenTheRest() {
        let ordered = SessionProjectGrouping.ordered([
            session("done", status: .succeeded),
            session("running", status: .running),
            session("blocked", approvals: 1, waitingSince: "2026-08-22T10:00:00Z"),
            session("main", role: .coordinator),
        ])
        XCTAssertEqual(ordered.map(\.id), ["main", "blocked", "running", "done"])
    }

    /// Two rows both reading "1 waiting" are a five-second-old prompt and a two-hour-old one, and
    /// the old one is the one being forgotten.
    func testWithinATierTheLongestWaitComesFirst() {
        let ordered = SessionProjectGrouping.ordered([
            session("fresh", approvals: 1, waitingSince: "2026-08-22T11:59:00Z"),
            session("stale", approvals: 1, waitingSince: "2026-08-22T09:00:00Z"),
            session("middle", approvals: 2, waitingSince: "2026-08-22T10:30:00Z"),
        ])
        XCTAssertEqual(ordered.map(\.id), ["stale", "middle", "fresh"])
    }

    /// A row with nothing waiting sorts after those that do rather than to 1970, and rows the
    /// ranking cannot separate keep the server's order (recency still holds inside a tier).
    func testMissingWaitSortsLastAndTiesAreStable() {
        let ordered = SessionProjectGrouping.ordered([
            session("first", status: .running),
            session("second", status: .running),
            session("third", status: .running),
        ])
        XCTAssertEqual(ordered.map(\.id), ["first", "second", "third"])

        let mixed = SessionProjectGrouping.ordered([
            session("blockedNoStamp", approvals: 1),
            session("blockedStamped", approvals: 1, waitingSince: "2026-08-22T09:00:00Z"),
        ])
        XCTAssertEqual(mixed.map(\.id), ["blockedStamped", "blockedNoStamp"])
    }

    /// A coordinator that is itself blocked stays first: it is the way into the project, and the
    /// role is asked before anything else (web's `tierOf`).
    func testCoordinatorOutranksABlockedWorker() {
        let ordered = SessionProjectGrouping.ordered([
            session("worker", approvals: 1, waitingSince: "2026-08-22T08:00:00Z"),
            session("main", role: .coordinator, approvals: 1, waitingSince: "2026-08-22T11:00:00Z"),
        ])
        XCTAssertEqual(ordered.map(\.id), ["main", "worker"])
    }

    /// A self-driven turn (parked at AWAITING_INPUT with the engine producing) is running, not idle —
    /// the same reading every other surface takes (`Session.isGenerating`).
    func testSelfDrivenTurnCountsAsRunning() {
        let ordered = SessionProjectGrouping.ordered([
            session("idle", status: .awaitingInput),
            session("selfDriven", status: .awaitingInput, engineTurnActive: true),
        ])
        XCTAssertEqual(ordered.map(\.id), ["selfDriven", "idle"])
    }

    /// Ordering is applied inside a project group, so the rendered rows are ranked by what the
    /// project is asking of you — not by the recency the server sent.
    func testSectionsApplyTheOrderingInsideEachProject() {
        let sections = SessionProjectGrouping.sections([
            session("running", project: alpha, status: .running),
            session("main", project: alpha, role: .coordinator),
            session("blocked", project: alpha, approvals: 1, waitingSince: "2026-08-22T09:00:00Z"),
        ])
        XCTAssertEqual(sections[0].sections.flatMap { $0.sessions.map(\.id) },
                       ["main", "blocked", "running"])
    }

    // MARK: badge

    func testBadgePartsDropZeroesButAlwaysStateProgress() {
        let busy = SessionProjectGrouping.badgeParts(
            ProjectSessionCounts(projectId: "p1", needsYou: 2, running: 1, done: 5, total: 9))
        XCTAssertEqual(busy.map(\.kind), [.needsYou, .running, .done])
        XCTAssertEqual(busy.map(\.text), ["2 needs you", "1 running", "5/9 done"])

        let idle = SessionProjectGrouping.badgeParts(
            ProjectSessionCounts(projectId: "p2", needsYou: 0, running: 0, done: 1, total: 4))
        XCTAssertEqual(idle.map(\.kind), [.done])
        XCTAssertEqual(idle.map(\.text), ["1/4 done"])
    }

    func testCountsByIdIndexesTheRollup() {
        let map = SessionProjectGrouping.countsById([
            ProjectSessionCounts(projectId: "p1", needsYou: 1, running: 0, done: 0, total: 1),
        ])
        XCTAssertEqual(map["p1"]?.needsYou, 1)
        XCTAssertNil(map["nope"])
    }

    // MARK: row title (role chip + task name)

    func testRowTitlePrefersTheTaskNameAndKeepsTheSessionTitleAsTooltip() {
        let row = SessionRowTitle.make(for: session("s", role: .execution, taskId: "t1",
                                                    taskTitle: "C2 · Web: role chips",
                                                    title: "执行任务：C2 · Web：角色身份——…"))
        XCTAssertEqual(row.chip, SessionRoleChip(label: "Exec", tone: .exec))
        XCTAssertEqual(row.text, "C2 · Web: role chips")
        XCTAssertEqual(row.tooltip, "执行任务：C2 · Web：角色身份——…")
    }

    func testRowTitleFallsBackToTheSessionTitleWithoutATask() {
        let main = SessionRowTitle.make(for: session("s", role: .coordinator, title: "Coordinating F1"))
        XCTAssertEqual(main.chip, SessionRoleChip(label: "Main", tone: .main))
        XCTAssertEqual(main.text, "Coordinating F1")
        XCTAssertNil(main.tooltip)   // the title IS the text — no second name to hide behind a hover
    }

    /// A conversation the user started wears no chip, and a row from a server that serves no role at
    /// all wears none either — the unmarked row is "yours".
    func testUserAndUnknownRolesWearNoChip() {
        XCTAssertNil(SessionRowTitle.make(for: session("s", role: .user)).chip)
        XCTAssertNil(SessionRowTitle.make(for: session("s")).chip)
        XCTAssertEqual(SessionRowTitle.chip(for: .verification),
                       SessionRoleChip(label: "Verify", tone: .verify))
    }

    func testRowTitleFallsBackWhenNothingIsNamed() {
        // Neither name: a dispatched row whose task title hasn't loaded and whose session was never
        // titled. The row still has to say something rather than collapse to an empty line.
        let nameless = Session(id: "s", title: nil, status: .running, agentId: nil,
                               assignedRunnerId: nil, pendingApprovals: 0, branch: nil,
                               updatedAt: nil, taskId: "t1", role: .execution)
        let bare = SessionRowTitle.make(for: nameless)
        XCTAssertEqual(bare.text, "Untitled session")
        XCTAssertNil(bare.tooltip)
        XCTAssertEqual(bare.chip?.label, "Exec")
    }

    // MARK: wire

    /// The list payload's new fields decode, and older payloads without them still do.
    func testSessionRowDecodesProjectRoleAndWait() throws {
        let json = """
        {"id":"s1","title":"t","status":"RUNNING","pendingApprovals":2,
         "oldestPendingApprovalAt":"2026-08-22T09:00:00.000Z",
         "taskId":"t1","taskTitle":"A1 · API","projectId":"p1","projectTitle":"Alpha",
         "role":"coordinator"}
        """
        let s = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(s.projectId, "p1")
        XCTAssertEqual(s.projectTitle, "Alpha")
        XCTAssertEqual(s.role, .coordinator)
        XCTAssertEqual(s.taskTitle, "A1 · API")
        XCTAssertEqual(s.oldestPendingApprovalAt, "2026-08-22T09:00:00.000Z")

        let old = try JSONDecoder().decode(
            Session.self, from: Data(#"{"id":"s2","title":"t","status":"RUNNING"}"#.utf8))
        XCTAssertNil(old.projectId)
        XCTAssertNil(old.role)
        XCTAssertNil(old.oldestPendingApprovalAt)
    }

    /// A role a newer server invents must not blank the list — it reads as the unmarked row.
    func testUnknownRoleDecodesAsUser() throws {
        let s = try JSONDecoder().decode(
            Session.self,
            from: Data(#"{"id":"s","title":"t","status":"RUNNING","role":"auditor"}"#.utf8))
        XCTAssertEqual(s.role, .user)
        XCTAssertNil(SessionRowTitle.make(for: s).chip)
    }

    /// An `approval.resolved` event empties the row's approvals; the timestamp it dates must go with
    /// them, or the row keeps claiming an hour-old wait and sorts ahead of rows that really have one.
    func testResolvingApprovalsClearsTheWaitTimestamp() {
        let blocked = session("s", project: alpha, approvals: 1, waitingSince: "2026-08-22T09:00:00Z")
        XCTAssertEqual(blocked.settingPendingApprovals(0).oldestPendingApprovalAt, nil)
        XCTAssertEqual(blocked.settingPendingApprovals(2).oldestPendingApprovalAt,
                       "2026-08-22T09:00:00Z")
        // The project identity survives an in-place merge — a row that lost it would jump out of its
        // group on the next event.
        XCTAssertEqual(blocked.settingPendingApprovals(0).projectId, "p1")
        XCTAssertEqual(blocked.settingPendingApprovals(0).projectTitle, "Alpha")
    }
}

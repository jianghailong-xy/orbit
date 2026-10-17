import Foundation
import XCTest
@testable import OrbitKit

final class SessionProjectGroupingTests: XCTestCase {
    private let now = RelativeTime.parse("2026-10-04T10:00:00Z")!

    private func ago(_ minutes: Double) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-minutes * 60))
    }

    private func session(_ id: String, role: SessionProjectMembership.Role? = .task,
                         projectID: String = "p1", projectStatus: ProjectStatus = .open,
                         title: String? = nil, folder: String? = nil,
                         state: SessionRunState = .awaitingInput, approvals: Int = 0,
                         waitingKind: SessionWaitingKind? = nil, since: [String] = [],
                         bg: Int = 0, jobs: Int = 0, subagents: Int = 0,
                         pinnedAt: String? = nil, lastTurnAt: String? = "2026-10-04T09:40:00Z",
                         createdAt: String? = "2026-10-04T09:00:00Z",
                         reply: String? = "Last reply", userText: String? = nil,
                         tool: String? = nil, review: ConfirmationUnderReview? = nil) -> Session {
        Session(id: id, title: title ?? id, status: .awaitingInput, runState: state,
                agentId: "w1", assignedRunnerId: nil, pendingApprovals: approvals,
                waitingKind: waitingKind,
                ownerItems: since.enumerated().map { index, at in
                    SessionOwnerItem(itemId: "\(id)-\(index)", kind: .coordinatorQuestion,
                                     title: "Question", since: at)
                },
                branch: nil, updatedAt: nil,
                projectId: role == .coordinator ? projectID : nil,
                projectTitle: role == .coordinator ? "Project one" : nil,
                lastAssistantText: reply, lastToolUse: tool, lastUserText: userText,
                runningBgCount: bg, runningBgJobCount: jobs, runningSubagentCount: subagents,
                pinnedAt: pinnedAt, createdAt: createdAt, lastTurnAt: lastTurnAt,
                folderId: folder, confirmationUnderReview: review,
                projectMembership: role.map {
                    SessionProjectMembership(projectId: projectID, projectTitle: "Project one",
                                             projectStatus: projectStatus, role: $0)
                })
    }

    private func coordinator(folder: String? = nil, approvals: Int = 0,
                             pinnedAt: String? = nil, lastTurnAt: String? = "2026-10-04T09:40:00Z") -> Session {
        session("coordinator", role: .coordinator, folder: folder, approvals: approvals,
                pinnedAt: pinnedAt, lastTurnAt: lastTurnAt)
    }

    private func folder(_ id: String, _ name: String) -> SessionFolder {
        SessionFolder(id: id, workspaceId: "w1", name: name)
    }

    private func project(held: ProjectListCoordinatorItems? = nil) -> ProjectSummary {
        ProjectSummary(id: "p1", title: "Project summary", buckets: ProjectBuckets(running: 2),
                       lastActivityAt: ago(1), attention: ProjectListAttention(coordinatorItems: held),
                       taskCounts: ProjectSidebarTaskCounts(done: 3, failed: 1, total: 8))
    }

    private func listing(_ sessions: [Session], view: SessionView = .open, byTag: Bool = false,
                         searching: Bool = false, folderID: String? = nil, offline: Bool = false,
                         projects: [ProjectSummary]? = nil, folders: [SessionFolder] = [],
                         coordinators: [Session] = [], content: [Session]? = nil,
                         watching: [String: WatchSessionSummary] = [:],
                         line: ((Session) -> SessionLine)? = nil) -> SessionProjectListing {
        SessionProjectGrouping.listing(sessions, folders: folders, projects: projects ?? [project()],
                                       view: view, byTag: byTag, searching: searching, folderID: folderID,
                                       runnerOffline: offline, now: now, coordinators: coordinators,
                                       contentSessions: content, watching: watching, line: line)
    }

    func testAllMembershipRolesMergeInOpenAndCompleted() {
        let members = [coordinator()] + [SessionProjectMembership.Role.task, .context, .judgment, .child]
            .map { session($0.rawValue, role: $0) }
        for view in [SessionView.open, .completed] {
            let out = listing(members + [session("ordinary", role: nil)], view: view)
            XCTAssertEqual(out.projects.count, 1)
            XCTAssertEqual(out.projects.first?.members, members)
            XCTAssertEqual(out.projects.first?.title, "Project summary")
            XCTAssertEqual(out.sessions.map(\.id), ["ordinary"])
            XCTAssertEqual(out.entries.map(\.id), ["ordinary", "p1"])
        }
    }

    func testTrashTagsAndSearchKeepFiledMembersFlat() {
        let sessions = [coordinator(folder: "f1"), session("worker"), session("ordinary", role: nil)]
        for (view, byTag, searching) in [(SessionView.trash, false, false), (.open, true, false),
                                         (.completed, true, false), (.open, false, true)] {
            let out = listing(sessions, view: view, byTag: byTag, searching: searching,
                              folders: [folder("f1", "Filed")])
            XCTAssertEqual(out.sessions, sessions)
            XCTAssertTrue(out.projects.isEmpty)
            XCTAssertTrue(out.folders.isEmpty)
            XCTAssertEqual(out.entries, sessions.map(SessionProjectEntry.session))
        }
        XCTAssertTrue(SessionProjectGrouping.listShowsProjects(view: .open, byTag: false))
        XCTAssertTrue(SessionProjectGrouping.listShowsProjects(view: .completed, byTag: false))
    }

    func testLegacyProjectRelationDoesNotInventMembership() throws {
        let legacy = try JSONDecoder().decode(Session.self, from: Data(
            #"{"id":"legacy","status":"AWAITING_INPUT","projectId":"p1","projectTitle":"Project one"}"#.utf8))
        let out = listing([legacy, session("ordinary", role: nil)])
        XCTAssertTrue(out.projects.isEmpty)
        XCTAssertEqual(out.sessions.map(\.id), ["legacy", "ordinary"])
    }

    func testOrdinaryOnlyListingPreservesInputOrderIncludingFolderPages() {
        let sessions = [session("older", role: nil, folder: "f1", lastTurnAt: ago(60)),
                        session("newer", role: nil, folder: "f1", lastTurnAt: ago(1)),
                        session("pinned", role: nil, folder: "f1", pinnedAt: ago(30))]
        XCTAssertEqual(listing(sessions).entries, sessions.map(SessionProjectEntry.session))
        let filed = listing(sessions, folderID: "f1", folders: [folder("f1", "Filed")])
        XCTAssertEqual(filed.entries, sessions.map(SessionProjectEntry.session))
    }

    func testDoneProjectMissingFromSidebarUsesMembershipWithoutProgress() {
        let out = listing([session("done", projectStatus: .done)], view: .completed, projects: [])
        XCTAssertEqual(out.projects.first?.status, .done)
        XCTAssertEqual(out.projects.first?.title, "Project one")
        XCTAssertNil(out.projects.first?.taskCounts)
        XCTAssertEqual(out.projects.first?.line, SessionLine(text: "No coordinator", tone: .preview))
        XCTAssertEqual(out.projects.first?.target, .project("p1"))
    }

    func testOnlyCoordinatorPinsAndLatestLocalActivityOrdersRows() {
        let coord = coordinator(lastTurnAt: ago(10_000))
        let worker = session("worker", pinnedAt: ago(30), lastTurnAt: ago(1))
        let out = listing([coord, worker, session("ordinary", role: nil, lastTurnAt: ago(5))])
        XCTAssertNil(out.projects.first?.pinnedAt)
        XCTAssertEqual(out.projects.first?.lastTurnAt, ago(1))
        XCTAssertEqual(out.entries.map(\.id), ["p1", "ordinary"])
        let pinned = listing([coordinator(pinnedAt: ago(40), lastTurnAt: ago(10_000)),
                              session("worker", lastTurnAt: ago(10_000)),
                              session("ordinary", role: nil, lastTurnAt: ago(1))])
        XCTAssertEqual(pinned.entries.map(\.id), ["p1", "ordinary"])
        XCTAssertEqual(pinned.entries.first?.pinnedAt, ago(40))
        let completed = listing([coordinator(pinnedAt: ago(40), lastTurnAt: ago(10_000)),
                                 session("ordinary", role: nil, lastTurnAt: ago(1))], view: .completed)
        XCTAssertEqual(completed.entries.map(\.id), ["ordinary", "p1"])
    }

    func testNewMemberUsesCreatedAtIgnoringGlobalProjectActivity() {
        let out = listing([coordinator(), session("new", lastTurnAt: nil, createdAt: ago(2))])
        XCTAssertEqual(out.projects.first?.lastTurnAt, ago(2))
    }

    func testCoordinatorFolderOwnsAllMemberCountsAndActivityWithoutMutatingInputs() {
        let folders = [folder("f1", "Release"), folder("f2", "Tasks"), folder("empty", "Empty")]
        let sessions = [coordinator(folder: "f1"), session("worker", folder: "f2", state: .running),
                        session("waiting", approvals: 1), session("ordinary", role: nil)]
        let snapshot = sessions
        let out = listing(sessions, folders: folders)
        XCTAssertTrue(out.projects.isEmpty)
        XCTAssertEqual(out.sessions.map(\.id), ["ordinary"])
        XCTAssertEqual(out.folders.map(\.id), ["empty", "f1", "f2"])
        XCTAssertEqual(out.folders.map(\.sessionCount), [0, 3, 0])
        XCTAssertEqual(out.folders.map(\.status), [.idle, .needsYou(1), .idle])
        let inside = listing(sessions, folderID: "f1", folders: folders)
        XCTAssertTrue(inside.folders.isEmpty)
        XCTAssertTrue(inside.sessions.isEmpty)
        XCTAssertEqual(inside.projects.first?.members, sessions.dropLast().map { $0 })
        XCTAssertEqual(inside.projects.first?.indicator, .needsYou)
        XCTAssertTrue(listing(sessions, folderID: "f2", folders: folders).entries.isEmpty)
        XCTAssertEqual(sessions, snapshot)
        XCTAssertEqual(listing([coordinator(folder: "f1"), session("worker", state: .running)],
                               folders: folders).folders.first { $0.id == "f1" }?.status, .running)
    }

    func testCompletedShowsOnlyOccupiedFoldersAndDeletedFolderKeepsProjectVisible() {
        let out = listing([coordinator(folder: "gone"), session("worker", folder: "f1")],
                          view: .completed, folders: [folder("f1", "Old task folder")])
        XCTAssertTrue(out.folders.isEmpty)
        XCTAssertEqual(out.projects.count, 1)
        let filed = listing([coordinator(folder: "f1"), session("worker", folder: "f2")],
                            view: .completed, folders: [folder("f1", "Release"), folder("f2", "Tasks")])
        XCTAssertEqual(filed.folders.map(\.id), ["f1"])
        XCTAssertEqual(filed.folders.map(\.sessionCount), [2])
    }

    func testSupplementalCoordinatorAffectsWordingAndPlacementOnly() {
        let coord = session("coordinator", role: .coordinator, state: .running,
                            pinnedAt: ago(5), lastTurnAt: ago(1), tool: "Bash")
        let worker = session("completed", lastTurnAt: ago(60))
        let out = listing([worker], view: .completed, coordinators: [coord])
        XCTAssertEqual(out.projects.first?.coordinator, coord)
        XCTAssertEqual(out.projects.first?.lastTurnAt, ago(60))
        XCTAssertEqual(out.projects.first?.members, [worker])
        XCTAssertEqual(out.projects.first?.sessionCount, 1)
        XCTAssertNil(out.projects.first?.indicator)
        XCTAssertEqual(out.projects.first?.line, SessionLine.make(for: coord, live: true))
        XCTAssertEqual(out.projects.first?.target, .session(coord.id))
        let filed = listing([worker], folders: [folder("f1", "Release")],
                            coordinators: [coord.settingFolder("f1")])
        XCTAssertTrue(filed.projects.isEmpty)
        XCTAssertEqual(filed.folders.first?.sessionCount, 1)
        XCTAssertEqual(filed.folders.first?.status, .idle)
    }

    func testCoordinatorWaitingWordsOutrankOlderWaitingMembers() {
        for text in ["Approve merge to main", "Question from coordinator", "Escalated to you", "Paused", "Ready to start"] {
            let out = listing([coordinator(approvals: 1), session("older", approvals: 1, since: [ago(90)])],
                              line: { SessionLine(text: $0.id == "coordinator" ? text : "Waiting", tone: .approval) })
            XCTAssertEqual(out.projects.first?.line, SessionLine(text: text, tone: .approval))
            XCTAssertEqual(out.projects.first?.target, .session("coordinator"))
            XCTAssertEqual(out.projects.first?.indicator, .needsYou)
        }
    }

    func testLongestWaitUsesOwnerItemSinceInsteadOfRecentActivity() {
        let old = session("old", title: "Quota retry", approvals: 1, waitingKind: .ownerConfirmation,
                          since: [ago(10), "invalid", ago(90)], lastTurnAt: ago(1))
        let recent = session("recent", approvals: 1, since: [ago(5)], lastTurnAt: ago(80))
        let out = listing([coordinator(), recent, old])
        XCTAssertEqual(out.projects.first?.line,
                       SessionLine(text: "Waiting for your confirmation · Quota retry", tone: .approval))
        XCTAssertEqual(out.projects.first?.target, .session("old"))
    }

    func testRemoteWaitSuppliesContentWhileIndicatorAndTimeStayLocal() {
        let coord = coordinator()
        let local = session("local", state: .running, lastTurnAt: ago(20))
        let remote = session("remote", title: "Remote retry", approvals: 1, waitingKind: .ownerConfirmation,
                             since: [ago(90)], lastTurnAt: ago(1))
        let unrelated = session("unrelated", projectID: "p2", approvals: 1, since: [ago(120)])
        let content = [coord, local, remote, unrelated]
        let out = listing([coord, local], content: content)
        XCTAssertEqual(out.projects.first?.line,
                       SessionLine(text: "Waiting for your confirmation · Remote retry", tone: .approval))
        XCTAssertEqual(out.projects.first?.target, .session("remote"))
        XCTAssertEqual(out.projects.first?.members, [coord, local])
        XCTAssertEqual(out.projects.first?.sessionCount, 3)
        XCTAssertEqual(out.projects.first?.indicator, .running)
        XCTAssertEqual(out.projects.first?.needsYou, false)
        XCTAssertEqual(out.projects.first?.lastTurnAt, ago(20))
        let idle = session("local", lastTurnAt: ago(20))
        XCTAssertNil(listing([coord, idle], content: content).projects.first?.indicator)
        let localWait = session("local", approvals: 1, since: [ago(5)])
        let both = listing([coord, localWait], content: content)
        XCTAssertEqual(both.projects.first?.target, .session("remote"))
        XCTAssertEqual(both.projects.first?.indicator, .needsYou)
        XCTAssertEqual(listing([coord, local]).projects.first?.sessionCount, 2)
    }

    func testLegacyWaitUsesActivityAndInvalidInstantsSortLastWithIDTieBreak() {
        let out = listing([coordinator(), session("unknown", approvals: 1, lastTurnAt: "invalid", createdAt: nil),
                           session("z-known", approvals: 1, lastTurnAt: ago(30)),
                           session("a-known", approvals: 1, lastTurnAt: ago(30))])
        XCTAssertEqual(out.projects.first?.target, .session("a-known"))
    }

    func testEqualWaitUsesWebLocaleOrderingForMixedCasePublicIDs() {
        let out = listing([coordinator(), session("Z", approvals: 1, since: [ago(30)]),
                           session("a", approvals: 1, since: [ago(30)])])
        XCTAssertEqual(out.projects.first?.target, .session("a"))
    }

    func testEveryCoordinatorExceptionUsesProjectWordsAndAge() {
        let cases: [(CoordinatorLeadKind, String)] = [
            (.integrationConflict, "Resolving a merge conflict"), (.integrationCheckFailed, "Checks failed"),
            (.integrationError, "Handling an integration error"), (.taskFailed, "Handling a failed task"),
            (.deliveryReview, "Reviewing a delivery"),
        ]
        for (kind, text) in cases {
            let held = ProjectListCoordinatorItems(count: 1, leadKind: kind, oldestWaitingSince: ago(18))
            let out = listing([coordinator()], projects: [project(held: held)])
            XCTAssertEqual(out.projects.first?.line, SessionLine(text: "\(text) · 18m", tone: .running))
            XCTAssertEqual(out.projects.first?.target, .session("coordinator"))
        }
    }

    func testExceptionAgeMatchesWebBoundariesAndOmitsFutureOrInvalid() {
        for (at, age) in [(ago(0.5), " · <1m"), (ago(120), " · 2h"), (ago(4_320), " · 3d"),
                          (ago(-1), ""), ("invalid", "")] {
            let held = ProjectListCoordinatorItems(count: 1, leadKind: .integrationConflict, oldestWaitingSince: at)
            XCTAssertEqual(listing([coordinator()], projects: [project(held: held)]).projects.first?.line.text,
                           "Resolving a merge conflict\(age)")
        }
    }

    func testWaitingOutranksCoordinatorException() {
        let held = ProjectListCoordinatorItems(count: 1, leadKind: .taskFailed, oldestWaitingSince: ago(18))
        let out = listing([coordinator(), session("worker", approvals: 1)], projects: [project(held: held)])
        XCTAssertEqual(out.projects.first?.target, .session("worker"))
        XCTAssertEqual(out.projects.first?.line.tone, .approval)
    }

    func testOrdinaryCoordinatorLineIsVerbatimAndTargetsCoordinator() {
        for coord in [session("coordinator", role: .coordinator, state: .running, tool: "Bash"),
                      session("coordinator", role: .coordinator, userText: "Continue"),
                      session("coordinator", role: .coordinator, reply: "Finished the requested change.")] {
            let out = listing([coord])
            XCTAssertEqual(out.projects.first?.line, SessionLine.make(for: coord, live: true))
            XCTAssertEqual(out.projects.first?.target, .session("coordinator"))
        }
    }

    func testNoCoordinatorTargetsProjectUnlessMemberWaits() {
        let worker = session("worker")
        XCTAssertEqual(listing([worker]).projects.first?.target, .project("p1"))
        let held = ProjectListCoordinatorItems(count: 1, leadKind: .taskFailed, oldestWaitingSince: ago(18))
        XCTAssertEqual(listing([worker], projects: [project(held: held)]).projects.first?.line,
                       SessionLine(text: "No coordinator", tone: .preview))
        XCTAssertEqual(listing([session("worker", approvals: 1)]).projects.first?.target, .session("worker"))
    }

    func testIndicatorUsesSharedReadingsWaitingThenRunningThenJobs() {
        let coord = coordinator()
        let background = session("background", bg: 2, jobs: 1)
        let service = session("service", bg: 1)
        let running = session("running", state: .running)
        let waiting = session("waiting", approvals: 1)
        XCTAssertEqual(listing([coord, background, running, waiting]).projects.first?.indicator, .needsYou)
        XCTAssertTrue(NeedsYouLogic.isCounted(waiting))
        XCTAssertEqual(listing([coord, background, running]).projects.first?.indicator, .running)
        XCTAssertTrue(WorkspaceActivityLogic.isRunning(running))
        XCTAssertEqual(listing([coord, background, service]).projects.first?.indicator, .jobs)
        XCTAssertTrue(SessionStatusGlyph.make(for: background).pulse)
        XCTAssertNil(listing([coord, service]).projects.first?.indicator)
        XCTAssertNil(listing([coord]).projects.first?.indicator)
        XCTAssertEqual(listing([coord, session("subagent", subagents: 1)]).projects.first?.indicator, .running)
    }

    func testSidebarRunningCountsNeverCreateLocalMotionAndOfflineSuppressesMotionOnly() {
        let coord = coordinator()
        XCTAssertEqual(listing([coord]).projects.first?.runningCount, 2)
        XCTAssertEqual(listing([coord]).projects.first?.taskCounts, ProjectSidebarTaskCounts(done: 3, failed: 1, total: 8))
        XCTAssertNil(listing([coord]).projects.first?.indicator)
        let running = session("running", state: .running)
        let background = session("background", bg: 1, jobs: 1)
        let offline = listing([coord, running, background], offline: true)
        XCTAssertEqual(offline.projects.first?.running, false)
        XCTAssertEqual(offline.projects.first?.jobs, false)
        XCTAssertNil(offline.projects.first?.indicator)
        XCTAssertEqual(listing([coord, running], projects: []).projects.first?.runningCount, 1)
        XCTAssertEqual(listing([coord, running], offline: true, projects: []).projects.first?.runningCount, 0)
        XCTAssertEqual(listing([coord, running, session("waiting", approvals: 1)], offline: true)
            .projects.first?.indicator, .needsYou)
    }

    func testReadyToStartIsAmberWithoutAddingFolderNeedsYouCount() {
        let coord = session("coordinator", role: .coordinator, folder: "f1", approvals: 1, waitingKind: .startRequest)
        let folders = [folder("f1", "Filed")]
        XCTAssertFalse(NeedsYouLogic.isCounted(coord))
        XCTAssertEqual(listing([coord], folders: folders).folders.first?.status, .idle)
        let inside = listing([coord], folderID: "f1", folders: folders)
        XCTAssertEqual(inside.projects.first?.indicator, .needsYou)
        XCTAssertEqual(inside.projects.first?.line.text, "Ready to start")
    }

    func testUnderReviewIsNeitherWaitingNorRunning() {
        let review = ConfirmationUnderReview(requestId: "r1", taskId: "t1", reviewerTitle: "Reviewer",
                                             since: ago(18), dueAt: ago(-60))
        let coord = session("coordinator", role: .coordinator, review: review)
        let out = listing([coord])
        XCTAssertEqual(out.projects.first?.line, SessionLine.make(for: coord, live: true))
        XCTAssertEqual(out.projects.first?.line.tone, .review)
        XCTAssertEqual(out.projects.first?.target, .session("coordinator"))
        XCTAssertNil(out.projects.first?.indicator)
    }

    func testWatchSuppressesBackgroundJobMotionJustLikeTheSessionGlyph() {
        let coord = session("coordinator", role: .coordinator, bg: 1, jobs: 1)
        let watch = WatchSessionSummary(observing: [WatchFixture.watch(observer: coord.id)])
        let watches = [coord.id: watch]
        let glyph = SessionStatusGlyph.make(for: coord, watching: watch)
        XCTAssertFalse(glyph.pulse)
        let out = listing([coord], watching: watches)
        XCTAssertEqual(out.projects.first?.line, SessionLine.make(for: coord, live: true, watching: watch))
        XCTAssertEqual(out.projects.first?.line.tone, .watching)
        XCTAssertNil(out.projects.first?.indicator)
        let filed = listing([coord.settingFolder("f1")], folders: [folder("f1", "Filed")], watching: watches)
        XCTAssertEqual(filed.folders.first?.status, .idle)
        let worker = session("worker", state: .running)
        XCTAssertEqual(listing([coord, worker], watching: watches).projects.first?.indicator, .running)
    }
}

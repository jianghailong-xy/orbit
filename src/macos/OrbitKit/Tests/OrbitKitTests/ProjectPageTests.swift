import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// One project's page, card by card: the same cells, sentences, pills, bands and tags the web's
/// project page draws for the same reads.
final class ProjectPageTests: XCTestCase {

    private static let now = RelativeTime.parse("2026-09-24T12:00:00.000Z")!

    private func iso(_ secondsBeforeNow: TimeInterval) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Self.now.addingTimeInterval(-secondsBeforeNow))
    }

    // MARK: Work overview

    func testOverviewWithoutIntegrationDrawsTheSevenLanesAndDoneCarriesItsShare() {
        let cells = ProjectPage.overviewCells(
            ProjectPanoramaBuckets(running: 4, ready: 1, blocked: 2, done: 27), taskCount: 34, line: nil)
        XCTAssertEqual(cells.map(\.label),
                       ["Running", "Ready", "Waiting", "Awaiting verification", "Done", "Failed", "Cancelled"])
        XCTAssertEqual(cells.first { $0.key == "done" }?.footnote, "79% complete")
        XCTAssertEqual(ProjectPage.overviewCells(ProjectPanoramaBuckets(), taskCount: 0, line: nil)
                        .first { $0.key == "done" }?.footnote, "no tasks yet")
    }

    func testOverviewWithIntegrationSplitsDoneAndShowsOnlyNonZeroExtras() {
        let b = ProjectPanoramaBuckets(running: 4, ready: 0, blocked: 2, done: 28, failed: 1,
                                       integrating: 1, onIntegrationLine: 4, onUpstream: 23,
                                       doneNotIntegrated: 0, waitingForLanding: 1)
        let branch = ProjectPage.overviewCells(b, taskCount: 35, line: .projectBranch)
        XCTAssertEqual(branch.map(\.label),
                       ["Running", "Ready", "Waiting", "Integrating", "On project branch", "On main", "Failed"])
        XCTAssertEqual(branch.first { $0.key == "blocked" }?.footnote, "for a prerequisite to land")
        // A project landing straight into main has no branch to strand work on.
        XCTAssertFalse(ProjectPage.overviewCells(b, taskCount: 35, line: .main)
                        .contains { $0.key == "onIntegrationLine" })
    }

    func testOverviewSubtitleCountsTasksAndDependencies() {
        XCTAssertEqual(ProjectPage.overviewSubtitle(.init(taskCount: 34, edgeCount: 18)), "34 tasks · 18 dependencies")
        XCTAssertEqual(ProjectPage.overviewSubtitle(.init(taskCount: 1, edgeCount: 1)), "1 task · 1 dependency")
    }

    // MARK: Acceptance criteria

    func testCriterionWorkSaysWhereMetWorkIsAndNothingForAnUnansweredOne() {
        let onMain = ProjectCriterion(id: "c1", ordinal: 1, text: "A", satisfied: true, landing: "LANDED")
        let onBranch = ProjectCriterion(id: "c2", ordinal: 2, text: "B", satisfied: true,
                                        landing: "ON_INTEGRATION_LINE")
        let noReceipt = ProjectCriterion(id: "c3", ordinal: 3, text: "C", satisfied: true, landing: "UNKNOWN")
        let unanswered = ProjectCriterion(id: "c4", ordinal: 4, text: "D")

        XCTAssertEqual(ProjectPage.criterionWork(onMain, integrationRef: "project/x")?.state, "Met by its work")
        XCTAssertEqual(ProjectPage.criterionWork(onMain, integrationRef: "project/x")?.landing, "on main")
        let branch = ProjectPage.criterionWork(onBranch, integrationRef: "project/x")
        XCTAssertEqual(branch?.landing, "on project/x")
        XCTAssertEqual(branch?.landingWarning, "not on main yet")
        let flagged = ProjectPage.criterionWork(noReceipt, integrationRef: nil)
        XCTAssertEqual(flagged?.landing, "no merge receipt either way")
        XCTAssertEqual(flagged?.landingFlagged, true)
        XCTAssertNil(ProjectPage.criterionWork(unanswered, integrationRef: nil))
        XCTAssertEqual(ProjectPage.criterionMark(unanswered), .unanswered)
        XCTAssertEqual(ProjectPage.criterionMark(onMain), .met)
    }

    func testUnmetWorkNamesEveryReasonAndTheTasksHoldingItInWords() {
        let c = ProjectCriterion(id: "c", ordinal: 1, text: "X", satisfied: false, unmet: [
            ProjectCriterionUnmet(clause: "SERVING_WORK_UNSETTLED", heldUpBy: [
                ProjectCriterionHeldUpBy(taskId: "t1", title: "Wire it", requiredAction: "RUN_ACCEPTANCE_COMMAND"),
                ProjectCriterionHeldUpBy(taskId: "t2", title: "Odd", requiredAction: "SOMETHING_NEW"),
            ]),
            ProjectCriterionUnmet(clause: "NEW_CLAUSE"),
        ], landing: "UNKNOWN")
        let work = try! XCTUnwrap(ProjectPage.criterionWork(c, integrationRef: nil))
        XCTAssertEqual(work.state, "Not met by its work")
        // Landing is not said beside work that has not met its criterion.
        XCTAssertNil(work.landing)
        XCTAssertEqual(work.reasons.map(\.sentence),
                       ["Work filed under it has not settled by the criterion that work declared.", "NEW_CLAUSE"])
        XCTAssertEqual(work.reasons.first?.heldUpBy.map(\.action),
                       ["needs its acceptance command to run", "SOMETHING_NEW"])
    }

    // MARK: Coordinator

    private func status(_ state: ProjectCoordinationState,
                        session: ProjectCoordinatorStatus.Session? = nil) -> ProjectCoordinatorStatus {
        ProjectCoordinatorStatus(projectId: "p", readAt: iso(0), state: state,
                                 coordination: .init(sessionId: session?.id, session: session))
    }

    func testCoordinatorPillFollowsTheWebsTruthTable() {
        let live = { (run: SessionRunState, active: Bool, pending: Int) in
            ProjectPage.coordinatorPill(self.status(.live, session: .init(
                id: "s", runState: run, lifecycleState: .open, engineTurnActive: active,
                pendingApprovals: pending))).label
        }
        XCTAssertEqual(live(.running, false, 1), "Needs you")      // a pending card blocks inside the turn
        XCTAssertEqual(live(.running, false, 0), "Working")
        XCTAssertEqual(live(.awaitingInput, true, 0), "Working")
        XCTAssertEqual(live(.awaitingInput, false, 0), "Needs you")
        XCTAssertEqual(live(.failed, false, 0), "Idle")
        XCTAssertEqual(ProjectPage.coordinatorPill(status(.live, session: .init(
            id: "s", runState: .awaitingInput, lifecycleState: .completed))).label, "Completed")
        XCTAssertEqual(ProjectPage.coordinatorPill(status(.neverOpened)).label, "Not started")
        XCTAssertEqual(ProjectPage.coordinatorPill(status(.trashed)).label, "Deleted")
        XCTAssertEqual(ProjectPage.coordinatorPill(status(.unavailable)), .init(label: "Cannot be opened", tone: .error))
    }

    func testCoordinatorRowsReadTheWayTheWebCardDoes() {
        XCTAssertEqual(ProjectPage.coordinatorOrdinal("0"), "1st coordinator of this project")
        XCTAssertEqual(ProjectPage.coordinatorOrdinal("1"), "2nd coordinator of this project")
        XCTAssertEqual(ProjectPage.coordinatorOrdinal("10"), "11th coordinator of this project")
        XCTAssertEqual(ProjectPage.coordinatorOrdinal("21"), "22nd coordinator of this project")
        XCTAssertEqual(ProjectPage.wakeupsLine(.init(state: "DELIVERED", at: iso(240)), now: Self.now),
                       "delivered · last 4m ago")
        XCTAssertEqual(ProjectPage.wakeupsLine(.init(state: "NONE"), now: Self.now), "none yet")
        XCTAssertEqual(ProjectPage.selfStartedLine(.init(selfStartedToday: 6, limit: 30)), "6 of 30")
        XCTAssertEqual(ProjectPage.selfStartedLine(.init(selfStartedToday: 6)), "6 · no limit")
        XCTAssertEqual(ProjectPage.selfStartedLine(.init(selfStartedToday: 30, limit: 30, paused: true)),
                       "30 of 30 · paused")
        XCTAssertEqual(ProjectPage.selfStartedFraction(.init(selfStartedToday: 31, limit: 30)), 1)
        XCTAssertNil(ProjectPage.selfStartedFraction(.init(selfStartedToday: 3)))
        XCTAssertEqual(ProjectPage.lastActive(.init(id: "s", startedAt: iso(3_600), finishedAt: iso(720)),
                                              readAt: iso(0)), "last active 12m ago")
        // Started a month ago, talked twelve minutes ago: the newest turn is what it was last active at.
        XCTAssertEqual(ProjectPage.lastActive(.init(id: "s", startedAt: iso(2_592_000), lastTurnAt: iso(720)),
                                              readAt: iso(0)), "last active 12m ago")
    }

    // MARK: Open items

    private func item(_ kind: ProjectOpenItemKind, assignee: ProjectOpenItemAssignee,
                      waited: TimeInterval, escalateIn: TimeInterval? = nil,
                      actions: [ProjectOpenItemAction] = [], sessionId: String? = nil,
                      fuse: String? = nil) -> ProjectOpenItemRow {
        ProjectOpenItemRow(itemId: "i", kind: kind, title: "T", waitingSince: iso(waited),
                           assignee: assignee,
                           escalateAt: escalateIn.map { iso(-$0) },
                           sessionId: sessionId, fuseEpisodeId: fuse, actions: actions)
    }

    func testWaitingLabelCountsDownToTheOwner() {
        XCTAssertEqual(ProjectPage.waitingLabel(item(.integrationConflict, assignee: .coordinator,
                                                     waited: 18 * 60, escalateIn: 102 * 60), now: Self.now),
                       "18m · goes to you in 1h 42m")
        XCTAssertEqual(ProjectPage.waitingLabel(item(.integrationConflict, assignee: .coordinator,
                                                     waited: 3 * 3_600, escalateIn: -60), now: Self.now),
                       "3h · due to come to you")
        XCTAssertEqual(ProjectPage.waitingLabel(item(.coordinatorQuestion, assignee: .owner,
                                                     waited: 35 * 60), now: Self.now),
                       "waiting 35m")
    }

    func testPrimaryActionIsTheFirstThisClientCanCarryOut() {
        XCTAssertEqual(ProjectPage.primaryAction(item(.taskFailed, assignee: .owner, waited: 60,
                                                      actions: [.retry, .openTaskSession, .cancelTask],
                                                      sessionId: "s1")), .openTaskSession)
        XCTAssertNil(ProjectPage.primaryAction(item(.taskFailed, assignee: .owner, waited: 60,
                                                    actions: [.retry, .openTaskSession])))
        XCTAssertEqual(ProjectPage.primaryAction(item(.coordinatorQuestion, assignee: .owner, waited: 60,
                                                      actions: [.answer])), .answer)
        XCTAssertNil(ProjectPage.primaryAction(item(.fusePaused, assignee: .owner, waited: 60,
                                                    actions: [.resume])))
        XCTAssertEqual(ProjectPage.primaryAction(item(.fusePaused, assignee: .owner, waited: 60,
                                                      actions: [.resume], fuse: "f1")), .resume)
        XCTAssertEqual(ProjectPage.actionLabel(.review), "Review")
        XCTAssertNil(ProjectPage.actionLabel(.cancelTask))
    }

    func testOwnerItemKindFoldsEveryExceptionIntoEscalated() {
        XCTAssertEqual(ProjectPage.ownerItemKind(item(.promotionApproval, assignee: .owner, waited: 1)), .promotionApproval)
        XCTAssertEqual(ProjectPage.ownerItemKind(item(.coordinatorQuestion, assignee: .owner, waited: 1)), .coordinatorQuestion)
        XCTAssertEqual(ProjectPage.ownerItemKind(item(.fusePaused, assignee: .owner, waited: 1)), .fusePaused)
        for kind in [ProjectOpenItemKind.integrationConflict, .integrationCheckFailed, .integrationError, .taskFailed] {
            XCTAssertEqual(ProjectPage.ownerItemKind(item(kind, assignee: .owner, waited: 1)), .escalated)
        }
    }

    // MARK: Integration line

    func testIntegrationFactsOnABranchAndOnMain() {
        let branch = ProjectIntegrationView(line: .projectBranch, ref: "project/bg-jobs", upstreamRef: "main",
                                            commitsAheadOfUpstream: 7, lastUpstreamSyncAt: iso(720),
                                            integratingCount: 1, queuedCount: 1, mergeCheckOnTip: "PASSING")
        XCTAssertEqual(ProjectPage.integrationFacts(branch, now: Self.now), [
            "project/bg-jobs", "7 commits ahead of main", "synced with main 12m ago",
            "Integrating 1 · Queued 1", "Merge check ✓ passing on the branch tip",
        ])
        let main = ProjectIntegrationView(line: .main, upstreamRef: "main", commitsAheadOfUpstream: 3,
                                          mergeCheckOnTip: "UNKNOWN")
        XCTAssertEqual(ProjectPage.integrationFacts(main, now: Self.now),
                       ["main", "Integrating 0 · Queued 0", "Merge check not run yet"])
        XCTAssertNil(ProjectPage.integrationFacts(ProjectIntegrationView(), now: Self.now))
    }

    // MARK: Tasks

    func testTaskBandsFollowTheWebsOrder() {
        let rows = [
            ProjectTaskRow(id: "done", title: "d", status: "DONE", workState: "DONE"),
            ProjectTaskRow(id: "lvl2", title: "b2", topoLevel: 2, dependencyState: "BLOCKED", workState: "BLOCKED"),
            ProjectTaskRow(id: "ready", title: "r", workState: "READY"),
            ProjectTaskRow(id: "run", title: "x", status: "IN_PROGRESS", workState: "RUNNING"),
            ProjectTaskRow(id: "landing", title: "l", dependencyState: "BLOCKED", workState: "BLOCKED",
                           landingWaitCount: 1),
            ProjectTaskRow(id: "integ", title: "i", status: "DONE", workState: "DONE",
                           integration: .init(state: "CHECK_FAILED", handler: "COORDINATOR")),
            ProjectTaskRow(id: "landed", title: "o", status: "DONE", workState: "DONE",
                           integration: .init(state: "ON_UPSTREAM")),
            ProjectTaskRow(id: "lvl1", title: "b1", topoLevel: 1, dependencyState: "BLOCKED", workState: "BLOCKED"),
        ]
        let groups = ProjectPage.taskGroups(rows)
        XCTAssertEqual(groups.map(\.key), ["running", "integrating", "ready", "waiting-for-landing",
                                           "level-1", "level-2", "landed", "settled"])
        XCTAssertEqual(groups.map(\.heading), [
            "Running", "Integrating · checks run on the combined tree", "Ready · can start now",
            "Waiting · for a prerequisite to land", "Blocked · topology level 1", "Blocked · topology level 2",
            "Landed", "Done / Cancelled",
        ])
        XCTAssertEqual(groups.last?.settled, true)
    }

    func testAnOlderServersOpenRowIsNeverPromotedToReady() {
        XCTAssertEqual(ProjectPage.workState(ProjectTaskRow(id: "t", title: "t", status: "OPEN")), "BLOCKED")
        XCTAssertEqual(ProjectPage.workState(ProjectTaskRow(id: "t", title: "t", status: "OPEN",
                                                            completionPolicy: "VERIFICATION_PASSED")),
                       "AWAITING_VERIFICATION")
    }

    func testTaskTagsNameTheLaneAndWhoHasAFailure() {
        XCTAssertEqual(ProjectPage.workTag(ProjectTaskRow(id: "t", title: "t", workState: "READY",
                                                          autoRunWhenReady: true))?.text,
                       "Ready · automatic dispatch")
        XCTAssertNil(ProjectPage.workTag(ProjectTaskRow(id: "t", title: "t", dependencyState: "BLOCKED",
                                                        workState: "BLOCKED", landingWaitCount: 2)))
        let tag = { (state: String, handler: String?) in
            ProjectPage.integrationTag(ProjectTaskRow(id: "t", title: "t",
                                                      integration: .init(state: state, handler: handler)),
                                       ref: "project/x", upstreamRef: "main")?.text
        }
        XCTAssertEqual(tag("CONFLICT", "OWNER"), "Conflict · you")
        XCTAssertEqual(tag("CHECK_FAILED", "COORDINATOR"), "Checks failed · coordinator")
        XCTAssertEqual(tag("ON_INTEGRATION_LINE", nil), "On project/x")
        XCTAssertEqual(tag("ON_UPSTREAM", nil), "On main")
        XCTAssertNil(tag("SOMETHING_NEW", nil))
        XCTAssertEqual(ProjectPage.integrationTag(
            ProjectTaskRow(id: "t", title: "t", integration: .init(state: "RUNNING", checksRunningForMs: 180_000)),
            ref: nil, upstreamRef: nil)?.text, "Integrating · checks 3m")
        XCTAssertEqual(ProjectPage.integrationTag(
            ProjectTaskRow(id: "t", title: "t", dependencyState: "BLOCKED", landingWaitCount: 1),
            ref: nil, upstreamRef: nil)?.text, "Waits for 1 task to land")
    }

    // MARK: decoding

    func testDecodesTheProjectDocumentAndCoordinatorStatusAsServed() throws {
        let doc = try JSONDecoder().decode(ProjectDocument.self, from: Data("""
        {"id":"p1","title":"Landing","status":"OPEN","goal":"G","instructions":null,
         "createdAt":"2026-09-23T00:00:00.000Z","updatedAt":"2026-09-24T00:00:00.000Z",
         "coordinatorEnabled":true,"configRevision":"7","coordinatorSessionId":"s1",
         "maxConcurrentTasks":3,"_count":{"tasks":7},"tasksByStatus":{"OPEN":4,"DONE":3},
         "acceptanceCriteriaItems":[{"id":"c1","ordinal":1,"text":"T","revision":2,"satisfied":false,
           "unmet":[{"clause":"NO_WORK_SERVES_IT","heldUpBy":[]}],"landing":"UNKNOWN",
           "verificationMethod":"read it"}],
         "integration":{"line":"PROJECT_BRANCH","lineAbsentReason":null,"ref":"project/landing",
           "upstreamRef":"main","source":"EXPLICIT","locked":true,"startedAt":null,
           "mergeCheckCommand":"npm test","mergeCheckCommandAbsentReason":null,
           "mergeCheckTimeoutSeconds":null,"escalationSeconds":7200},
         "blockers":{"open":[],"recentlyResolved":[]},"derivedDone":{"done":false}}
        """.utf8))
        XCTAssertEqual(doc.taskCount, 7)
        XCTAssertEqual(doc.configRevision, "7")
        XCTAssertEqual(doc.coordinatorEnabled, true)
        XCTAssertEqual(doc.acceptanceCriteriaItems.first?.unmet.first?.clause, "NO_WORK_SERVES_IT")
        XCTAssertEqual(doc.integration?.ref, "project/landing")
        XCTAssertEqual(doc.integration?.locked, true)

        let status = try JSONDecoder().decode(ProjectCoordinatorStatus.self, from: Data("""
        {"projectId":"p1","readAt":"2026-09-24T12:00:00.000Z","state":"LIVE",
         "coordination":{"sessionId":"s1","sessionIdAbsentReason":null,
           "session":{"id":"s1","title":"Coord","runStatus":"RUNNING","runState":"RUNNING",
             "lifecycleState":"OPEN","filingState":"OPEN","endReason":null,"startedAt":"2026-09-24T11:00:00.000Z",
             "finishedAt":null,"completedAt":null,"deletedAt":null,"engineTurnActive":true,"pendingApprovals":0},
           "sessionAbsentReason":null,"coordinatorGeneration":"1","workspaceId":"w1",
           "workspaceIdAbsentReason":null,"workspaceName":"orbit","agentId":"w1","agentName":"orbit",
           "wakeups":{"state":"DELIVERED","at":"2026-09-24T11:56:00.000Z"},
           "fuse":{"selfStartedToday":6,"limit":30,"paused":false,"episodeId":null}},
         "openability":{"canOpen":true,"willCreate":false,"refusalCode":null,"refusalDetail":null,
           "refusalCodeAbsentReason":"NOTHING_REFUSES","requiredAction":null,
           "landing":{"workspaceId":null,"workspaceName":null}}}
        """.utf8))
        XCTAssertEqual(status.state, .live)
        XCTAssertEqual(status.coordination.session?.runState, .running)
        XCTAssertEqual(status.coordination.coordinatorGeneration, "1")
        XCTAssertEqual(status.coordination.fuse?.limit, 30)
        XCTAssertEqual(ProjectPage.coordinatorPill(status).label, "Working")
    }

    func testDecodesATaskPageAndPanorama() throws {
        let page = try JSONDecoder().decode(ProjectTaskPage.self, from: Data("""
        {"items":[{"id":"t1","title":"A","status":"OPEN","parentTaskId":null,"createdAt":"x","updatedAt":"y",
          "childCount":0,"unmetCount":1,"blocksCount":2,"topoLevel":1,"dependencyState":"BLOCKED",
          "workState":"BLOCKED","integration":{"state":"NOT_APPLICABLE","since":null,"handler":null,
          "openItemId":null,"jobId":null,"checksRunningForMs":null},"landingWaitCount":0}],
         "nextCursor":"c2"}
        """.utf8))
        XCTAssertEqual(page.items.first?.blocksCount, 2)
        XCTAssertEqual(page.items.first?.integration?.state, "NOT_APPLICABLE")
        XCTAssertEqual(page.nextCursor, "c2")

        let panorama = try JSONDecoder().decode(ProjectPanorama.self, from: Data("""
        {"buckets":{"running":1,"ready":2,"blocked":1,"awaitingVerification":0,"done":3,"failed":0,
          "cancelled":0,"integrating":1,"onIntegrationLine":1,"onUpstream":1,"doneNotIntegrated":0,
          "waitingForLanding":0},"shape":{"taskCount":7,"edgeCount":5,"ratio":0.7,"maxDepth":2,"form":"chain"}}
        """.utf8))
        XCTAssertTrue(ProjectPage.reportsIntegrationLanes(panorama.buckets))
        XCTAssertEqual(panorama.shape.edgeCount, 5)
    }
}

// MARK: - the routes

private final class ProjectAPIURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, body: String))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let result = Self.handler?(request) ?? (status: 500, body: "")
        let response = HTTPURLResponse(url: request.url!, statusCode: result.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(result.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class ProjectRequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []

    func record(_ request: URLRequest) {
        guard let url = request.url else { return }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.query.map { "?\($0)" } ?? ""
        var body = ""
        if let data = request.httpBody ?? request.httpBodyStream.map(Self.drain) {
            // Key order is the encoder's business, not the contract's: compare bodies sorted.
            if let object = try? JSONSerialization.jsonObject(with: data),
               let sorted = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
                body = " " + String(decoding: sorted, as: UTF8.self)
            } else {
                body = " " + String(decoding: data, as: UTF8.self)
            }
        }
        lock.lock()
        lines.append("\(request.httpMethod ?? "?") \(url.path)\(query)\(body)")
        lock.unlock()
    }

    private static func drain(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }

    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }
}

/// Each project read and write hits the route `projects.controller.ts` serves for it.
final class ProjectAPIClientTests: XCTestCase {
    override func tearDown() {
        ProjectAPIURLProtocol.handler = nil
        super.tearDown()
    }

    func testEveryProjectCallHitsItsRoute() async throws {
        let log = ProjectRequestLog()
        let document = #"{"id":"p1","title":"T","status":"OPEN","createdAt":"x","_count":{"tasks":0}}"#
        ProjectAPIURLProtocol.handler = { request in
            log.record(request)
            let path = request.url?.path ?? ""
            switch (request.httpMethod ?? "", path) {
            case ("GET", "/api/projects"): return (200, "[\(document)]")
            case ("GET", "/api/projects/p1"), ("PATCH", "/api/projects/p1"): return (200, document)
            case ("GET", "/api/projects/p1/panorama"): return (200, #"{"buckets":{},"shape":{}}"#)
            case ("GET", "/api/projects/p1/integration"): return (200, #"{"line":null}"#)
            case ("GET", "/api/projects/p1/tasks/page"): return (200, #"{"items":[],"nextCursor":null}"#)
            case ("GET", "/api/projects/p1/coordinator/status"):
                return (200, #"{"projectId":"p1","state":"NEVER_OPENED","coordination":{},"openability":{"canOpen":true}}"#)
            case ("POST", "/api/projects/p1/coordinator"):
                return (201, #"{"sessionId":"s1","created":true,"workspaceId":"w1"}"#)
            case ("DELETE", "/api/projects/p1"): return (200, "{}")
            default: return (404, "")
            }
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProjectAPIURLProtocol.self]
        let api = APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                            session: URLSession(configuration: configuration))

        let listed = try await api.projects()
        _ = try await api.projects(status: .open)
        _ = try await api.project("p1")
        _ = try await api.projectPanorama("p1")
        _ = try await api.projectIntegration("p1")
        _ = try await api.projectTaskPage("p1", cursor: "c2", limit: 50)
        let status = try await api.projectCoordinatorStatus("p1")
        let opened = try await api.openProjectCoordinator("p1")
        _ = try await api.updateProjectStatus("p1", to: .done)
        _ = try await api.setProjectAutomatic("p1", enabled: true, expectedConfigRevision: "7")
        try await api.deleteProject("p1")

        XCTAssertEqual(listed.map(\.id), ["p1"])
        XCTAssertEqual(status.state, .neverOpened)
        XCTAssertEqual(opened, ProjectCoordinatorOpened(sessionId: "s1", created: true, workspaceId: "w1"))
        XCTAssertEqual(log.all, [
            "GET /api/projects",
            "GET /api/projects?status=OPEN",
            "GET /api/projects/p1",
            "GET /api/projects/p1/panorama",
            "GET /api/projects/p1/integration",
            "GET /api/projects/p1/tasks/page?limit=50&cursor=c2",
            "GET /api/projects/p1/coordinator/status",
            "POST /api/projects/p1/coordinator",
            #"PATCH /api/projects/p1 {"status":"DONE"}"#,
            #"PATCH /api/projects/p1 {"coordinatorEnabled":true,"expectedConfigRevision":"7"}"#,
            "DELETE /api/projects/p1",
        ])
    }
}

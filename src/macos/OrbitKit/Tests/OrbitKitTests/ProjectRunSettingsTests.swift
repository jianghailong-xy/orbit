import Foundation
import XCTest
@testable import OrbitKit

/// What the project page concludes about starting a project and about how a started one runs —
/// `ProjectRunSettings.swift` — case for case with the browser's `ProjectRunSettings.test.tsx`,
/// `ProjectProgressStatus.test.tsx` and `defaultStartSettings`. The words are
/// `ProjectRunSettingsCopyParityTests`'.
final class ProjectRunSettingsTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func request(_ line: IntegrationLine = .projectBranch) -> ProjectOpenItemRow {
        ProjectOpenItemRow(itemId: "i1", kind: .unknown, title: "Start this project?",
                           waitingSince: "2026-09-30T02:00:00.000Z",
                           startRequest: ProjectStartRequest(
                            settings: ProjectStartSettings(line: line, automatic: true, maxConcurrentTasks: 3),
                            criteriaDigest: "abc"))
    }

    // MARK: started, and paused, as the project document says them

    func testStartedIsReadOffStartedAtAndATheReadThatDoesNotSayIsNeitherAnswer() throws {
        let started = try decode(ProjectDocument.self,
                                 #"{"id":"p","startedAt":"2026-09-29T03:13:53.201Z","pausedAt":null,"maxConcurrentTasks":3}"#)
        XCTAssertEqual(started.started, true)
        XCTAssertNil(started.pausedAt)
        XCTAssertEqual(started.maxConcurrentTasks, 3)
        let nobody = try decode(ProjectDocument.self, #"{"id":"p","startedAt":null}"#)
        XCTAssertEqual(nobody.started, false, "a null is a project nobody has started")
        let older = try decode(ProjectDocument.self, #"{"id":"p","coordinatorEnabled":true}"#)
        XCTAssertNil(older.started, "no key is a server that did not say — not a no, and not Automatic's yes")
        let paused = try decode(ProjectDocument.self, #"{"id":"p","startedAt":"s","pausedAt":"2026-09-30T01:00:00.000Z"}"#)
        XCTAssertEqual(paused.pausedAt, "2026-09-30T01:00:00.000Z")

        // What this build writes back reads the same: the null survives the round trip.
        let again = try JSONDecoder().decode(ProjectDocument.self, from: try JSONEncoder().encode(nobody))
        XCTAssertEqual(again.started, false)
    }

    func testTheIntegrationReadCarriesWhatHowItRunsEdits() throws {
        let view = try decode(ProjectIntegrationView.self, #"""
            {"line":"PROJECT_BRANCH","ref":"project/34Wvw","upstreamRef":"main","locked":true,
             "startedAt":"2026-09-29T04:26:47.134Z","mergeCheckCommand":"npx tsc -b","escalationSeconds":7200,
             "integratingCount":0,"queuedCount":0,"mergeCheckOnTip":"UNKNOWN","inFlight":null}
            """#)
        XCTAssertTrue(view.locked)
        XCTAssertEqual(view.startedAt, "2026-09-29T04:26:47.134Z")
        XCTAssertEqual(view.mergeCheckCommand, "npx tsc -b")
        XCTAssertEqual(view.escalationSeconds, 7200)
        let older = try decode(ProjectIntegrationView.self, #"{"line":null}"#)
        XCTAssertFalse(older.locked)
        XCTAssertNil(older.escalationSeconds)
    }

    // MARK: before the start

    func testTheStartRowIsTheRequestOrTheOwnersOwnAndOnlyForAnOpenProjectNobodyStarted() {
        let asked = ProjectOpenItemsView(startRequest: request())
        XCTAssertEqual(StartProject.pageRow(status: .open, started: false, openItems: asked), .asked(request()))
        XCTAssertEqual(StartProject.pageRow(status: .open, started: false, openItems: ProjectOpenItemsView()), .own)
        XCTAssertNil(StartProject.pageRow(status: .open, started: false, openItems: nil),
                     "a request still on its way is not a project nobody asked about")
        XCTAssertNil(StartProject.pageRow(status: .open, started: true, openItems: asked),
                     "a started project answers no request, whatever the read still carries")
        XCTAssertNil(StartProject.pageRow(status: .open, started: nil, openItems: asked),
                     "a read that does not say is not a project waiting to be started")
        XCTAssertNil(StartProject.pageRow(status: .done, started: false, openItems: asked))
    }

    /// The default rule, as the browser's `defaultStartSettings` states it.
    func testTheOwnersStartTakesTheDefaultRule() {
        let chain = ProjectDependencyGraph(
            marks: [.task(id: "a", title: "A", status: "OPEN"), .task(id: "b", title: "B", status: "OPEN")],
            edges: [ProjectGraphEdge(sourceMarkId: "a", targetMarkId: "b")])
        let loose = ProjectDependencyGraph(
            marks: [.task(id: "a", title: "A", status: "OPEN"), .task(id: "b", title: "B", status: "OPEN")])
        let cancelledEdge = ProjectDependencyGraph(
            marks: [.task(id: "a", title: "A", status: "CANCELLED"), .task(id: "b", title: "B", status: "OPEN")],
            edges: [ProjectGraphEdge(sourceMarkId: "a", targetMarkId: "b")])
        let folded = ProjectDependencyGraph(marks: [ProjectGraphMark(kind: .run, id: "r", title: "run", taskCount: 3,
                                                                     statusCounts: ["OPEN": 3])])
        let undecided = ProjectIntegrationView(line: nil, mergeCheckCommand: "make check")

        // A plan whose tasks wait on one another gets a project branch; one whose do not gets main.
        XCTAssertEqual(StartProject.defaultSettings(view: undecided, maxConcurrentTasks: 4, graph: chain),
                       ProjectStartSettings(line: .projectBranch, automatic: true, maxConcurrentTasks: 4,
                                            mergeCheckCommand: "make check"))
        XCTAssertEqual(StartProject.defaultSettings(view: undecided, maxConcurrentTasks: 4, graph: loose).line, .main)
        XCTAssertEqual(StartProject.defaultSettings(view: undecided, maxConcurrentTasks: 4, graph: cancelledEdge).line,
                       .main, "an edge from a cancelled task is not a dependency anybody waits on")
        XCTAssertEqual(StartProject.defaultSettings(view: undecided, maxConcurrentTasks: 4, graph: folded).line,
                       .projectBranch, "a run the server folded is a chain")
        XCTAssertEqual(StartProject.defaultSettings(view: undecided, maxConcurrentTasks: nil, graph: nil),
                       ProjectStartSettings(line: .main, automatic: true, maxConcurrentTasks: 1,
                                            mergeCheckCommand: "make check"))

        // A line already decided stays, with the branch it names.
        let decided = ProjectIntegrationView(line: .projectBranch, ref: "project/34Wzv")
        XCTAssertEqual(StartProject.defaultSettings(view: decided, maxConcurrentTasks: 3, graph: loose),
                       ProjectStartSettings(line: .projectBranch, projectBranchName: "refs/heads/project/34Wzv",
                                            automatic: true, maxConcurrentTasks: 3))
        XCTAssertEqual(StartProject.defaultSettings(view: ProjectIntegrationView(line: .main, ref: "main"),
                                                    maxConcurrentTasks: 3, graph: chain),
                       ProjectStartSettings(line: .main, automatic: true, maxConcurrentTasks: 3))

        // The card it opens answers no request: no reason, no warnings, the seal standing now.
        let owner = StartProject.ownerRequest(settings: StartProject.defaultSettings(
            view: decided, maxConcurrentTasks: 3, graph: loose), criteriaDigest: "d1")
        XCTAssertEqual(owner.criteriaDigest, "d1")
        XCTAssertEqual(owner.why, "")
        XCTAssertTrue(owner.warnings.isEmpty)
        XCTAssertNil(owner.repository)
        let body = StartProject.body(request: owner, draft: StartSettingsDraft(owner.settings), requestId: nil)
        XCTAssertNil(body.requestId)
        XCTAssertEqual(body.projectBranchName, "refs/heads/project/34Wzv")
    }

    func testReadyWorkOnAProjectNobodyStartedWaitsForTheStart() {
        let buckets = ProjectPanoramaBuckets(ready: 2, blocked: 3)
        let waiting = ProjectPage.overviewCells(buckets, taskCount: 5, line: nil, started: false)
        XCTAssertEqual(waiting.first { $0.key == "ready" }?.footnote, ProjectPage.readyUntilStarted)
        let running = ProjectPage.overviewCells(buckets, taskCount: 5, line: nil, started: true)
        XCTAssertEqual(running.first { $0.key == "ready" }?.footnote, "can start now")
        let lanes = ProjectPanoramaBuckets(ready: 1, integrating: 0, onIntegrationLine: 0, onUpstream: 0)
        XCTAssertEqual(ProjectPage.overviewCells(lanes, taskCount: 1, line: .projectBranch, started: false)
                        .first { $0.key == "ready" }?.footnote, ProjectPage.readyUntilStarted)
        let queue = ProjectReadyToRun(readyCount: 2,
                                     manualReady: .init(count: 2, taskId: "t", title: "Ready task"))
        XCTAssertNil(ProjectPage.manualReady(queue, status: .open, started: false))
        XCTAssertNotNil(ProjectPage.manualReady(queue, status: .open, started: true))
    }

    // MARK: How it runs

    func testHowItRunsIsDrawnForEveryProjectExceptOneNobodyStarted() {
        XCTAssertTrue(RunSettings.shown(started: true))
        XCTAssertTrue(RunSettings.shown(started: nil), "an older server's project runs")
        XCTAssertFalse(RunSettings.shown(started: false))
    }

    func testTheLineIsWrittenOnlyWhileItCanMoveAndOnlyWhenItMoves() {
        let open = ProjectIntegrationView(line: nil)
        XCTAssertEqual(RunSettings.lineWrite(open, to: .main), UpdateProjectIntegrationRequest(line: .main))
        let chosen = ProjectIntegrationView(line: .projectBranch, ref: "project/x")
        XCTAssertNil(RunSettings.lineWrite(chosen, to: .projectBranch), "the line it already holds")
        XCTAssertEqual(RunSettings.lineWrite(chosen, to: .main), UpdateProjectIntegrationRequest(line: .main))
        let locked = ProjectIntegrationView(line: .projectBranch, ref: "project/x", locked: true)
        XCTAssertNil(RunSettings.lineWrite(locked, to: .main), "a locked line is refused 409; it is not sent")
    }

    func testTheMergeCheckIsTrimmedBlankIsNoneAndUnchangedIsNothing() throws {
        let set = ProjectIntegrationView(line: .projectBranch, mergeCheckCommand: "npx tsc -b")
        XCTAssertNil(RunSettings.mergeCheckWrite(set, to: "  npx tsc -b \n"))
        XCTAssertEqual(RunSettings.mergeCheckWrite(set, to: "   "),
                       UpdateProjectIntegrationRequest(mergeCheckCommand: .some(nil)))
        XCTAssertEqual(RunSettings.mergeCheckWrite(ProjectIntegrationView(line: .main), to: " make test "),
                       UpdateProjectIntegrationRequest(mergeCheckCommand: .some("make test")))
        XCTAssertNil(RunSettings.mergeCheckWrite(ProjectIntegrationView(line: .main), to: ""))

        // Removing it is said out loud — `null` — and leaving it alone says nothing.
        let removed = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            UpdateProjectIntegrationRequest(mergeCheckCommand: .some(nil)))) as? [String: Any]
        XCTAssertTrue(removed?["mergeCheckCommand"] is NSNull)
        let alone = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            UpdateProjectIntegrationRequest(exceptionEscalationSeconds: 3600))) as? [String: Any]
        XCTAssertEqual(alone?.keys.sorted(), ["exceptionEscalationSeconds"])
    }

    func testTheEscalationWindowIsWrittenWhenItMoves() {
        let view = ProjectIntegrationView(line: .main, escalationSeconds: 7200)
        XCTAssertNil(RunSettings.escalationWrite(view, to: 7200))
        XCTAssertEqual(RunSettings.escalationWrite(view, to: 3600),
                       UpdateProjectIntegrationRequest(exceptionEscalationSeconds: 3600))
    }

    /// Automatic and the concurrency limit, as the project's own PATCH takes them: `automatic`, and
    /// only what changed, fenced on the revision read.
    func testTheAuthorizationWriteSendsOnlyWhatChangedUnderTheRevisionRead() throws {
        func keys(_ body: UpdateProjectAuthorizationRequest) throws -> [String] {
            let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any]
            return object?.keys.sorted() ?? []
        }
        XCTAssertEqual(try keys(UpdateProjectAuthorizationRequest(automatic: false, expectedConfigRevision: "3")),
                       ["automatic", "expectedConfigRevision"])
        XCTAssertEqual(try keys(UpdateProjectAuthorizationRequest(maxConcurrentTasks: 5, expectedConfigRevision: "3")),
                       ["expectedConfigRevision", "maxConcurrentTasks"])
    }
}

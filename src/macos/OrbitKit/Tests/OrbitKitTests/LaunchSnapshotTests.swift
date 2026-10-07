import XCTest
@testable import OrbitKit

/// A cold launch draws its first frame straight from this snapshot — the workspace it lands on, the
/// session rows, the badges — so what reads back has to be exactly what was written, and anything
/// that can't be read has to be no snapshot at all rather than a wrong one.
final class LaunchSnapshotTests: XCTestCase {

    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("LaunchSnapshotTests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    /// In a directory that doesn't exist yet: `save` has to make it, as on a first launch.
    private var store: LaunchSnapshotStore {
        LaunchSnapshotStore(file: dir.appendingPathComponent("Launch/orbit.example.com.json"))
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) -> T {
        try! JSONDecoder().decode(type, from: Data(json.utf8))
    }

    /// Every model the snapshot holds, filled in well past its required fields — so a field whose
    /// encoding doesn't read back (a custom decoder expecting a wire shape the synthesized encoder
    /// doesn't write) fails here as an inequality, rather than as a row that quietly lost it.
    private func snapshot() -> LaunchSnapshot {
        let user = decode(User.self, #"""
        {"id":"u1","email":"ada@example.com","name":"Ada","role":"OWNER",
         "createdAt":"2026-01-01T00:00:00Z","avatarUpdatedAt":"2026-09-30T10:00:00Z",
         "preferences":{"theme":"dark","defaultModels":{"claude":"opus"},"defaultEffort":"high",
                        "defaultPermissionMode":"auto","notifyAgentMessage":false}}
        """#)
        let agents = [
            decode(Agent.self, #"""
            {"id":"a1","name":"orbit","lastProvider":"codex","model":"gpt","effort":"high",
             "workDir":"/srv/orbit","runnerId":"r2","enabled":true,"env":{"K":"V"},
             "allowedTools":["Bash"],"maxTurns":40,"maxBudgetUsd":2.5,
             "workDirFreeBytes":"123456789012",
             "repoHealth":{"root":"/srv/orbit","state":"clean","branch":"main","paths":[]},
             "repoCleanup":{"status":"ok","branch":"main","message":"done"}}
            """#),
            decode(Agent.self, #"{"id":"a2","name":"web","runnerId":"r1"}"#),
            decode(Agent.self, #"{"id":"a3","name":"host-level"}"#),
        ]
        let sessions = [
            Session(id: "s1", title: "Fix the launch", status: .running, runState: .running,
                    lifecycleState: .open,
                    capabilities: SessionCapabilities(canSend: true, canResume: false,
                                                      resumeBlockedReason: .runnerOffline,
                                                      canComplete: true, canRestore: false),
                    agentId: nil, assignedRunnerId: "r2", provider: "claude", pendingApprovals: 1,
                    waitingKind: .ownerItem,
                    ownerItems: [SessionOwnerItem(itemId: "i1", kind: .coordinatorQuestion,
                                                  title: "Which one?", since: "2026-09-30T09:00:00Z")],
                    branch: "orbit/fix", updatedAt: "2026-09-30T10:00:00Z",
                    lastAssistantText: "On it.", runningBgCount: 2, runningBgJobCount: 1,
                    engineTurnActive: true,
                    agent: decode(SessionAgentRef.self, #"{"id":"a1","name":"orbit","model":"opus"}"#),
                    pinnedAt: "2026-09-29T08:00:00Z", lastTurnAt: "2026-09-30T10:00:00Z",
                    currentTurnStartedAt: "2026-09-30T09:59:00Z",
                    tags: [SessionTag(id: "t1", name: "Red", color: "#ff0000", isSystem: true)],
                    retryAt: "2026-09-30T10:05:00Z"),
            Session(id: "s2", title: nil, status: .succeeded, agentId: "a2", assignedRunnerId: nil,
                    pendingApprovals: nil, branch: nil, updatedAt: nil),
        ]
        return LaunchSnapshot(user: user, agents: agents,
                              runnerNames: ["r1": "Mac mini", "r2": "devbox"],
                              runnerOrder: ["r1", "r2"], openSessions: sessions)
    }

    // MARK: The file

    func testSnapshotReadsBackAsWritten() {
        let written = snapshot()
        store.save(written)
        XCTAssertEqual(store.load(), written)
    }

    /// What a cold launch reads is read off the main thread, so the two have to agree — the async
    /// one is the shipping path (`AppModel.restoreLaunchSnapshot`) and the sync one is the tests'.
    func testReadingOffTheMainThreadReadsWhatLoadReads() async {
        let written = snapshot()
        store.save(written)
        let offMain = await store.loadOffMain()
        XCTAssertEqual(offMain, store.load())
        XCTAssertEqual(offMain, written)
    }

    func testNothingReadableIsNoSnapshot() throws {
        // First launch: no file, nor a directory for it.
        XCTAssertNil(store.load())
        // A torn or foreign file.
        try FileManager.default.createDirectory(at: store.file.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data(#"{"version":1,"snap"#.utf8).write(to: store.file)
        XCTAssertNil(store.load())
        // One another schema wrote: its models may not mean what this build's do.
        store.save(snapshot())
        var json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: store.file)) as? [String: Any])
        json["version"] = 999
        try JSONSerialization.data(withJSONObject: json).write(to: store.file)
        XCTAssertNil(store.load())
    }

    func testRemoveTakesTheSnapshotAway() {
        store.save(snapshot())
        XCTAssertNotNil(store.load())
        store.remove()
        XCTAssertNil(store.load())
        store.remove()   // and again, with nothing there, is harmless
    }

    func testEachInstanceHostHasItsOwnFile() {
        let a = LaunchSnapshotStore.defaultStore(for: URL(string: "https://orbit.example.com")!)
        let b = LaunchSnapshotStore.defaultStore(for: URL(string: "https://other.example.com:8443/base")!)
        XCTAssertEqual(a.file.lastPathComponent, "orbit.example.com.json")
        XCTAssertEqual(b.file.lastPathComponent, "other.example.com.json")
        XCTAssertEqual(a.file.deletingLastPathComponent(), b.file.deletingLastPathComponent())
    }

    // MARK: Where it lands

    func testLandsOnTheRememberedWorkspaceWhileItIsListed() {
        XCTAssertEqual(snapshot().landingAgentID(lastAgentID: "a3"), "a3")
    }

    func testOtherwiseLandsOnTheFirstWorkspaceInSidebarOrder() {
        #if os(macOS)
        // Runners r1, r2, then host-level: a2 (on r1) leads, though a1 is listed first.
        XCTAssertEqual(snapshot().landingAgentID(lastAgentID: "gone"), "a2")
        XCTAssertEqual(snapshot().landingAgentID(lastAgentID: nil), "a2")
        #else
        // iOS keeps the saved workspace order, independent of the runner directory's order.
        XCTAssertEqual(snapshot().landingAgentID(lastAgentID: "gone"), "a1")
        XCTAssertEqual(snapshot().landingAgentID(lastAgentID: nil), "a1")
        #endif
    }

    func testRememberedWorkspaceMatchesAcrossIdSpellings() {
        let uuid = "019fcbf3-0fa8-7f83-9302-46b25389cb16"
        let base62 = "341DOGTVEs0Fk0gAn1mje"
        var snap = snapshot()
        snap.agents.append(decode(Agent.self, #"{"id":"\#(base62)","name":"renamed","runnerId":"r2"}"#))
        XCTAssertEqual(snap.landingAgentID(lastAgentID: uuid), base62)
    }

    func testWithoutWorkspacesTheLandingWaitsForTheFetch() {
        var snap = snapshot()
        snap.agents = []
        XCTAssertNil(snap.landingAgentID(lastAgentID: "a1"))
    }

    // MARK: What a launch that has already answered still draws from it

    /// The launch restore reads its file off the main thread, so the launch can answer first. Each
    /// piece a fetch has answered for is handed over as nil — the caller has nothing to adopt, and
    /// so cannot put the previous run's copy over this run's answer.
    func testFetchedOpenListIsNeverOverwrittenByASnapshotThatArrivesLater() {
        let fetched = [Session(id: "s1", title: "Renamed on web while we were away",
                               status: .running, agentId: "a1", assignedRunnerId: "r2",
                               pendingApprovals: nil, branch: nil, updatedAt: "2026-10-06T10:00:00Z")]
        var snap = snapshot()
        snap.openSessions = [Session(id: "s1", title: "Fix the launch", status: .running,
                                     agentId: "a1", assignedRunnerId: "r2",
                                     pendingApprovals: nil, branch: nil,
                                     updatedAt: "2026-09-30T10:00:00Z")]
        let late = snap.fillIn(openListAnswered: true)
        XCTAssertNil(late.openSessions)
        // What `AppModel` does with a fill-in: adopt a piece only where there is one.
        XCTAssertEqual((late.openSessions ?? fetched).map(\.title), ["Renamed on web while we were away"])
        // The pieces nothing answered for are still the launch's to draw.
        XCTAssertEqual(late.user, snap.user)
        XCTAssertEqual(late.workspaces?.items, snap.agents)
    }

    func testNothingAnsweredHandsOverTheWholeSnapshot() {
        let snap = snapshot()
        let fillIn = snap.fillIn()
        XCTAssertFalse(fillIn.isEmpty)
        XCTAssertEqual(fillIn.user, snap.user)
        XCTAssertEqual(fillIn.workspaces?.items, snap.agents)
        XCTAssertEqual(fillIn.workspaces?.runnerNames, snap.runnerNames)
        XCTAssertEqual(fillIn.workspaces?.runnerOrder, snap.runnerOrder)
        XCTAssertEqual(fillIn.openSessions, snap.openSessions)
    }

    func testEachPieceIsDroppedForItsOwnAnswerAlone() {
        let snap = snapshot()
        XCTAssertNil(snap.fillIn(accountAnswered: true).user)
        XCTAssertNotNil(snap.fillIn(accountAnswered: true).openSessions)
        XCTAssertNil(snap.fillIn(workspacesAnswered: true).workspaces)
        XCTAssertNotNil(snap.fillIn(workspacesAnswered: true).openSessions)
    }

    func testAFullyAnsweredLaunchHasNothingLeftToDraw() {
        XCTAssertTrue(snapshot().fillIn(accountAnswered: true, workspacesAnswered: true,
                                        openListAnswered: true).isEmpty)
    }
}

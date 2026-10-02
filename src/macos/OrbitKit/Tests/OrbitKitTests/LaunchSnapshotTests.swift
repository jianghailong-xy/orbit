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
        // Runners r1, r2, then host-level: a2 (on r1) leads, though a1 is listed first.
        XCTAssertEqual(snapshot().landingAgentID(lastAgentID: "gone"), "a2")
        XCTAssertEqual(snapshot().landingAgentID(lastAgentID: nil), "a2")
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
}

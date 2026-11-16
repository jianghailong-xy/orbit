import Foundation
import XCTest
@testable import OrbitKit

/// From GitHub on the setup card and the clone on the conversation's first line (docs/github-workspace-design.md §8):
/// the same cases as the web's `GithubFolderOption.test.tsx`, `CreatedWorkspaceLine.clone.test.tsx` and
/// `lib/workspaceClone.ts`, as values.
final class GithubWorkspaceTests: XCTestCase {

    private func runner(_ fields: String) throws -> Runner {
        try JSONDecoder().decode(Runner.self, from: Data("{\"id\":\"r1\",\"name\":\"mac\"\(fields)}".utf8))
    }

    private let repo = GithubRepository(id: 42, fullName: "orbit-labs/orbit-web", private: true, defaultBranch: "main",
                                        installationId: 7, pushedAt: "2026-11-16T10:00:00Z")

    private func probe(exists: Bool, error: String? = nil) -> DirProbe {
        DirProbe(path: "/Users/ada/orbit-repos/orbit-web", exists: exists, isDir: exists, error: error)
    }

    // MARK: the machine

    func testOnlyAMachineThatClonesAndHasAReposFolderOffersTheClone() throws {
        XCTAssertTrue(MachineSetup.clonesRepositories(try runner(",\"capabilities\":[\"clone-workdir/v1\"],\"reposRoot\":\"/r\"")))
        XCTAssertFalse(MachineSetup.clonesRepositories(try runner(",\"capabilities\":[\"clone-workdir/v1\"],\"reposRoot\":\"  \"")))
        XCTAssertFalse(MachineSetup.clonesRepositories(try runner(",\"capabilities\":[\"create-workdir/v1\"],\"reposRoot\":\"/r\"")))
        XCTAssertFalse(MachineSetup.clonesRepositories(try runner("")))
    }

    // MARK: the pick

    func testTheFolderDefaultsToTheRepositorysNameWhenItIsOne() {
        XCTAssertEqual(MachineSetup.repositoryFolder("orbit-labs/orbit-web"), "orbit-web")
        XCTAssertEqual(MachineSetup.repositoryFolder("o/has space"), "")
        XCTAssertEqual(MachineSetup.repositoryFolder(""), "")
    }

    func testTheHomeFolderIsWrittenAsTilde() {
        XCTAssertEqual(MachineSetup.homeShortPath("/Users/ada/orbit-repos/x"), "~/orbit-repos/x")
        XCTAssertEqual(MachineSetup.homeShortPath("/home/ada/orbit-repos/x"), "~/orbit-repos/x")
        XCTAssertEqual(MachineSetup.homeShortPath("/root"), "~")
        XCTAssertEqual(MachineSetup.homeShortPath("/rootless/x"), "/rootless/x")
        XCTAssertEqual(MachineSetup.homeShortPath("/srv/repos/x"), "/srv/repos/x")
    }

    func testABranchIsAskedForOnlyWhenItIsNotTheDefault() {
        XCTAssertNil(MachineSetup.cloneRef(typed: nil, defaultBranch: "main"))
        XCTAssertNil(MachineSetup.cloneRef(typed: "  ", defaultBranch: "main"))
        XCTAssertNil(MachineSetup.cloneRef(typed: "main", defaultBranch: "main"))
        XCTAssertEqual(MachineSetup.cloneRef(typed: " release/1 ", defaultBranch: "main"), "release/1")
    }

    func testOnlyAFolderTheMachineSaysIsFreeCanBeClonedInto() {
        let root = "/Users/ada/orbit-repos"
        XCTAssertNil(MachineSetup.githubPick(repo, name: "orbit-web", ref: nil, reposRoot: root, probe: nil), "not answered yet")
        XCTAssertNil(MachineSetup.githubPick(repo, name: "orbit-web", ref: nil, reposRoot: root, probe: probe(exists: true)))
        XCTAssertNil(MachineSetup.githubPick(repo, name: "orbit-web", ref: nil, reposRoot: root,
                                             probe: probe(exists: false, error: "permission denied")))
        XCTAssertNil(MachineSetup.githubPick(repo, name: "../x", ref: nil, reposRoot: root, probe: probe(exists: false)))
        let picked = MachineSetup.githubPick(repo, name: "orbit-web", ref: "dev", reposRoot: root, probe: probe(exists: false))
        XCTAssertEqual(picked, .github(GithubPick(repoId: 42, repository: "orbit-labs/orbit-web", isPrivate: true,
                                                  defaultBranch: "main", ref: "dev", name: "orbit-web",
                                                  path: "/Users/ada/orbit-repos/orbit-web")))
    }

    func testAPickIsSentAsNewWorkspaceGithubAndSaysTheBoardsLines() throws {
        let pick = PickedFolder.github(GithubPick(repoId: 42, repository: "orbit-labs/orbit-web", isPrivate: false,
                                                  defaultBranch: "main", ref: nil, name: "orbit-web",
                                                  path: "/Users/ada/orbit-repos/orbit-web"))
        XCTAssertEqual(pick.newWorkspace, NewWorkspaceRequest(github: .init(repoId: 42, ref: nil, folder: "orbit-web")))
        let body = String(decoding: try JSONEncoder().encode(pick.newWorkspace), as: UTF8.self)
        XCTAssertTrue(body.contains("\"github\":{"), body)
        XCTAssertTrue(body.contains("\"repoId\":42"), body)
        XCTAssertFalse(body.contains("\"ref\""), "the default branch is asked for by leaving ref out: \(body)")
        // Create workspace (board 04 A on the one-field card) sends it as POST /workspaces `github`, under the Name.
        let create = MachineSetup.createRequest(folder: pick, name: " orbit-web ", runnerID: "r1")
        let sent = String(decoding: try JSONEncoder().encode(create), as: UTF8.self)
        XCTAssertTrue(sent.contains("\"github\":{"), sent)
        XCTAssertTrue(sent.contains("\"name\":\"orbit-web\""), sent)
        XCTAssertFalse(sent.contains("\"workDir\"") || sent.contains("\"newFolder\""), sent)
        XCTAssertEqual(MachineSetupCopy.setupGithubDonePath(repository: "orbit-labs/orbit-web",
                                                            path: MachineSetup.homeShortPath(pick.path)),
                       "orbit-labs/orbit-web → ~/orbit-repos/orbit-web")
        XCTAssertEqual(MachineSetupCopy.SETUP_GITHUB_DONE, "cloned before the session starts")
    }

    func testTheIntegrationDecodesAnOlderServersAnswer() throws {
        let view = try JSONDecoder().decode(GithubIntegration.self, from: Data("""
            {"available":true,"connected":true,"login":"ada","connectedAt":null,"needsReconnect":false,
             "installations":[{"id":1,"account":"ada","type":"User","repositorySelection":"selected","repositoryCount":2},
                              {"id":2,"account":"labs","type":"Organization","repositorySelection":"all","repositoryCount":9}],
             "installUrl":"https://github.com/apps/orbit/installations/new","workspaceCount":0}
            """.utf8))
        XCTAssertTrue(view.usable)
        XCTAssertEqual(view.repositoryCount, 11)
        XCTAssertNil(view.workspaces)
        let unasked = GithubIntegration(available: true, connected: true, login: "ada", installations: nil)
        XCTAssertNil(unasked.repositoryCount)
        XCTAssertEqual(repo.owner, "orbit-labs/")
        XCTAssertEqual(repo.name, "orbit-web")
    }

    // MARK: the clone

    func testAFrameNamesItsWorkspaceAsAgentIdThenId() {
        let clone: JSONValue = .object(["state": .string("CLONING"), "progress": .int(42)])
        let byAgentID = WorkspaceClone.event(type: "agent.changed", data: .object(["agentId": .string("w1"), "id": .string("w2"), "clone": clone]))
        XCTAssertEqual(byAgentID?.workspaceID, "w1")
        XCTAssertEqual(byAgentID?.clone, CloneHeard(state: .cloning, progress: 42))
        XCTAssertEqual(WorkspaceClone.event(type: "agent.changed", data: .object(["id": .string("w2"), "clone": clone]))?.workspaceID, "w2")
        XCTAssertEqual(WorkspaceClone.event(type: "agent.changed", data: .object(["clone": clone]), envelopeAgentID: "w3")?.workspaceID, "w3")
        XCTAssertNil(WorkspaceClone.event(type: "agent.changed", data: .object(["agentId": .string("w1")])), "no clone, no clone event")
        XCTAssertNil(WorkspaceClone.event(type: "session.updated", data: .object(["agentId": .string("w1"), "clone": clone])))
        XCTAssertNil(WorkspaceClone.cloneOf(.object(["state": .string("DONE")])))
        XCTAssertEqual(WorkspaceClone.cloneOf(.object(["state": .string("CLONING"), "progress": .double(140.4)]))?.progress, 100)
        XCTAssertEqual(WorkspaceClone.cloneOf(.object(["state": .string("CLONING"), "progress": .int(-3)]))?.progress, 0)
    }

    func testTheLedgerKeysAWorkspaceInOneSpellingAndKeepsItsPercentage() {
        let uuid = "0190f5b6-7d3a-7b6e-8c9d-0123456789ab"
        let publicID = PublicID.toPublic(uuid)
        var ledger = CloneLedger()
        XCTAssertTrue(ledger.hear(uuid, CloneHeard(state: .cloning, progress: 10)))
        XCTAssertFalse(ledger.hear(publicID, CloneHeard(state: .cloning, progress: nil)), "the same state is no move")
        XCTAssertEqual(ledger.heard(publicID)?.progress, 10, "a frame with no percentage keeps the last one")
        XCTAssertTrue(ledger.hear(publicID, CloneHeard(state: .failed)))
        XCTAssertNil(ledger.heard(uuid)?.progress)
        XCTAssertTrue(WorkspaceClone.sameWorkspace(uuid, publicID))
        XCTAssertFalse(WorkspaceClone.sameWorkspace(uuid, nil))
    }

    func testTheNewerOfFrameAndDetailWins() {
        let read = Date(timeIntervalSince1970: 1000)
        let before = CloneHeard(state: .cloning, progress: 30, at: read.addingTimeInterval(-5))
        let after = CloneHeard(state: .pending, progress: nil, at: read.addingTimeInterval(5))
        XCTAssertEqual(WorkspaceClone.now(stored: "FAILED", live: before, storedAt: read)?.state, .failed, "a detail read since wins")
        XCTAssertEqual(WorkspaceClone.now(stored: "FAILED", live: after, storedAt: read)?.state, .pending, "a Retry heard since wins")
        XCTAssertEqual(WorkspaceClone.now(stored: "CLONING", live: before, storedAt: read)?.progress, 30, "agreeing, the stream adds %")
        XCTAssertEqual(WorkspaceClone.now(stored: "READY", live: after, storedAt: read)?.state, .ready, "READY is an end")
        XCTAssertEqual(WorkspaceClone.now(stored: nil, live: before)?.state, .cloning)
        XCTAssertEqual(WorkspaceClone.now(stored: "PENDING", live: nil)?.state, .pending)
    }

    func testTheRepositoryIsReadFromItsGithubURL() {
        XCTAssertEqual(WorkspaceClone.repositoryOf("https://github.com/orbit-labs/orbit-web.git"), "orbit-labs/orbit-web")
        XCTAssertEqual(WorkspaceClone.repositoryOf("https://github.com/orbit-labs/orbit-web"), "orbit-labs/orbit-web")
        XCTAssertNil(WorkspaceClone.repositoryOf("git@github.com:orbit-labs/orbit-web.git"))
        XCTAssertNil(WorkspaceClone.repositoryOf(nil))
    }

    func testTheThreeFailuresV1Names() {
        XCTAssertEqual(WorkspaceClone.failureOf("/Users/ada/orbit-repos/x already exists on mac"), .folderTaken)
        XCTAssertEqual(WorkspaceClone.failureOf("Orbit's GitHub App is no longer installed on o/r. Install it again or pick another repository."),
                       .appRemoved)
        XCTAssertEqual(WorkspaceClone.failureOf("Your GitHub sign-in expired. Connect GitHub in Settings."), .signInExpired)
        XCTAssertEqual(WorkspaceClone.failureOf("fatal: unable to access"), .other)
        XCTAssertEqual(WorkspaceClone.failureOf(nil), .other)
    }

    /// A failure heard before its reason has been read says so with no colon left hanging (P2's QA walk).
    func testAReasonEndsWithOneFullStopAndNoneMeansNoColon() {
        XCTAssertEqual(WorkspaceClone.reason("  fatal: repository not found "), "fatal: repository not found.")
        XCTAssertEqual(WorkspaceClone.reason("git said no."), "git said no.")
        XCTAssertEqual(WorkspaceClone.reason(nil), "")
        XCTAssertEqual(MachineSetupCopy.cloneCouldNot(repository: "o/r", why: WorkspaceClone.reason(nil)), "Couldn’t clone o/r.")
    }
}

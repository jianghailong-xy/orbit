import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// Main checkout Git on macOS and iOS (docs/main-checkout-git-contract.md): the result lines against the
/// shared fixture's exact sentences, the transcript reducer's reading of the two new noticeKinds, the
/// Main checkout bar's rules, the review sheet's selection, the worktree isolation dialogs and the
/// three endpoints' requests.
final class MainCheckoutTests: XCTestCase {

    // MARK: fixture

    private static func repoFile(_ relative: String) throws -> URL {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = directory.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            directory.deleteLastPathComponent()
        }
        throw XCTSkip("\(relative) not found above \(#filePath)")
    }

    private static func fixture() throws -> [String: Any] {
        let data = try Data(contentsOf: repoFile("src/shared/src/main-checkout-git.fixture.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }

    // MARK: result lines (board 03)

    /// Every result the fixture holds reads, word for word, as the shared builder writes it.
    func testEveryFixtureResultReadsAsTheSharedLine() throws {
        let results = try XCTUnwrap(Self.fixture()["results"] as? [[String: Any]])
        XCTAssertEqual(results.count, 24)
        for sample in results {
            let name = sample["name"] as? String ?? "?"
            let result = try Self.decode(MainCheckoutActionResult.self, try XCTUnwrap(sample["result"]))
            let v = sample["view"] as? [String: Any] ?? [:]
            let view = MainCheckoutCopy.LineView(sessionId: v["sessionId"] as? String,
                                                 targetTitle: v["targetTitle"] as? String,
                                                 isolated: v["isolated"] as? Bool ?? true)
            let line = MainCheckoutCopy.resultLine(result, view: view)
            XCTAssertEqual(line.lead, sample["lead"] as? String, name)
            XCTAssertEqual(line.text, sample["text"] as? String, name)
            XCTAssertTrue(line.text.hasPrefix(line.lead), name)
            let link = sample["link"] as? [String: Any]
            XCTAssertEqual(line.link?.action.rawValue, link?["action"] as? String, name)
            XCTAssertEqual(line.link?.label, link?["label"] as? String, name)
            if result.status == "waiting" { XCTAssertEqual(line.tone, .waiting, name) }
            else if result.status == "done" { XCTAssertEqual(line.tone, .ok, name) }
            else { XCTAssertEqual(line.tone, .refused, name) }
        }
    }

    /// The variants the contract names but the fixture leaves out.
    func testLineVariants() {
        var move = MainCheckoutActionResult(requestId: "r", kind: .move, root: "/root/orbit", status: "done",
                                            finishedAt: "2026-11-12T08:00:00Z")
        move.fileCount = 2
        move.remaining = 1
        move.rescueBranch = "orbit/rescue-5f2c1a9"
        move.targetSessionId = "sess-2"
        XCTAssertEqual(MainCheckoutCopy.resultLine(move, view: .init(sessionId: "sess-1", targetTitle: "Bump eslint to 9")).text,
                       "Moved 2 files into the worktree of “Bump eslint to 9”. The main checkout still has 1 other uncommitted file. A copy of what it held is on orbit/rescue-5f2c1a9.")

        var commit = MainCheckoutActionResult(requestId: "r", kind: .commit, root: "/root/orbit", status: "done",
                                              finishedAt: "2026-11-12T08:00:00Z")
        commit.fileCount = 1
        commit.branch = "main"
        commit.head = "8d41e0c55"
        commit.subject = "Add retry backoff"
        commit.upstream = "origin/main"
        XCTAssertEqual(MainCheckoutCopy.resultLine(commit, view: .init(isolated: false)).text,
                       "Committed 1 file to main in the main checkout as 8d41e0c “Add retry backoff”. Not pushed yet.")

        var push = MainCheckoutActionResult(requestId: "r", kind: .push, root: "/root/orbit", status: "done",
                                            finishedAt: "2026-11-12T08:00:00Z")
        push.branch = "b"
        push.upstream = "origin/b"
        push.remoteAfter = "8d41e0c55"
        XCTAssertEqual(MainCheckoutCopy.resultLine(push).text, "Pushed b to origin as a new branch (8d41e0c).")
    }

    /// The Swift copy is the shared module's: each fixed sentence sits in mainCheckoutGit.ts verbatim.
    func testFixedCopyIsTheSharedModules() throws {
        let ts = try String(contentsOf: Self.repoFile("src/shared/src/mainCheckoutGit.ts"), encoding: .utf8)
        let fixed = [
            MainCheckoutCopy.moveToThisWorktree, MainCheckoutCopy.moveToAWorktree, MainCheckoutCopy.saveAndClean,
            MainCheckoutCopy.saveAndCleanHint, MainCheckoutCopy.askAgent, MainCheckoutCopy.askAgentHint,
            MainCheckoutCopy.leaveAsIs, MainCheckoutCopy.reviewAndCommitShort, MainCheckoutCopy.reviewMainCheckout,
            MainCheckoutCopy.commitMessagePlaceholder, MainCheckoutCopy.notShown, MainCheckoutCopy.targetOpenedFrom,
            MainCheckoutCopy.targetBusy, MainCheckoutCopy.cleanUpCheckout,
            WorktreeIsolationDialog.turnOnTitle, WorktreeIsolationDialog.turnOffTitle,
            WorktreeIsolationDialog.unchanged, WorktreeIsolationDialog.reviewFiles, WorktreeIsolationDialog.turnOn,
            WorktreeIsolationDialog.turnOff,
        ]
        for sentence in fixed {
            XCTAssertTrue(ts.contains("'\(sentence)'") || ts.contains("\"\(sentence)\""), sentence)
        }
        XCTAssertTrue(ts.contains(#"unseen: "Orbit can't see this checkout right now.""#))
    }

    // MARK: card (board 01)

    func testCardFromTheFixtureNotice() throws {
        let object = try XCTUnwrap(Self.fixture()["changedNotice"])
        let notice = try Self.decode(MainCheckoutChangedNotice.self, object)
        let card = MainCheckoutCard(notice)
        XCTAssertEqual(card.title, "3 files changed in the main checkout during this turn")
        XCTAssertEqual(card.subtitle,
                       "/root/orbit on main, outside this session's worktree. Orbit saw them appear; it can't tell who wrote them.")
        // The event's `notice` is title + subtitle, for clients that draw only text.
        XCTAssertEqual(notice.notice, card.title + " " + card.subtitle)
        XCTAssertEqual(card.visibleFiles.map(\.path), ["src/api/client.ts", "src/api/retry.test.ts", "src/api/retry.ts"])
        XCTAssertNil(card.moreFiles)
        XCTAssertNil(card.truncatedNote)
    }

    func testCardFoldsPastEightAndSaysWhereItStoppedCounting() {
        let files = (1...200).map { MainCheckoutFile(path: "f\($0).ts", status: "A") }
        let card = MainCheckoutCard(MainCheckoutChangedNotice(notice: "", root: "/r", files: files, fileCount: 200,
                                                              truncated: true, fingerprint: "mc1:-:x"))
        XCTAssertEqual(card.title, "At least 200 files changed in the main checkout during this turn")
        XCTAssertEqual(card.visibleFiles.count, 8)
        XCTAssertEqual(card.moreFiles, "and 192 more")
        XCTAssertEqual(card.truncatedNote, "Orbit stopped counting at 200 files.")
        XCTAssertEqual(MainCheckoutCopy.cardSubtitle(root: "/r", branch: nil),
                       "/r, outside this session's worktree. Orbit saw them appear; it can't tell who wrote them.")
    }

    func testCardButtonsNeedTheCapabilityAndAStillDirtyCheckout() {
        let dirty = RunnerRepoHealth(root: "/r", state: "dirty", branch: "main", paths: nil, fileCount: 3)
        let clean = RunnerRepoHealth(root: "/r", state: "clean", branch: "main", paths: nil, fileCount: 0)
        let older = RunnerRepoHealth(root: "/r", state: "dirty", branch: "main", paths: nil)
        XCTAssertTrue(MainCheckoutCard.showsActions(actionsSupported: true, dismissed: false, health: dirty))
        XCTAssertTrue(MainCheckoutCard.showsActions(actionsSupported: true, dismissed: false, health: older))
        XCTAssertTrue(MainCheckoutCard.showsActions(actionsSupported: true, dismissed: false, health: nil))
        XCTAssertFalse(MainCheckoutCard.showsActions(actionsSupported: false, dismissed: false, health: dirty))
        XCTAssertFalse(MainCheckoutCard.showsActions(actionsSupported: true, dismissed: true, health: dirty))
        XCTAssertFalse(MainCheckoutCard.showsActions(actionsSupported: true, dismissed: false, health: clean))
    }

    // MARK: reducer

    private static func systemEvent(seq: Int, _ object: Any) throws -> RunEvent {
        RunEvent(seq: seq, type: .system, payload: try decode(JSONValue.self, object))
    }

    /// `main-checkout-changed` becomes the card, not the generic notice row.
    func testReducerMapsTheChangedNoticeToTheCard() throws {
        let object = try XCTUnwrap(Self.fixture()["changedNotice"])
        var r = TranscriptReducer()
        r.apply(try Self.systemEvent(seq: 7, object))
        XCTAssertEqual(r.state.items.count, 1)
        guard case .mainCheckout(let item)? = r.state.items.first else { return XCTFail("\(r.state.items)") }
        XCTAssertEqual(item.seq, 7)
        XCTAssertNil(item.result)
        XCTAssertEqual(item.changed?.fileCount, 3)
        XCTAssertEqual(item.changed?.branch, "main")
        XCTAssertEqual(item.changed?.files.first?.additions, 12)
        XCTAssertEqual(item.notice, item.changed?.notice)
    }

    /// `main-checkout-action-result` becomes a result line carrying the whole result.
    func testReducerMapsTheResultNoticeToALine() throws {
        let results = try XCTUnwrap(Self.fixture()["results"] as? [[String: Any]])
        let stale = try XCTUnwrap(results.first { $0["name"] as? String == "FINGERPRINT_STALE" })
        let payload: [String: Any] = ["noticeKind": "main-checkout-action-result",
                                      "notice": stale["text"] as Any, "result": stale["result"] as Any]
        var r = TranscriptReducer()
        r.apply(try Self.systemEvent(seq: 9, payload))
        guard case .mainCheckout(let item)? = r.state.items.first else { return XCTFail("\(r.state.items)") }
        XCTAssertNil(item.changed)
        XCTAssertEqual(item.result?.code, "FINGERPRINT_STALE")
        XCTAssertEqual(item.result?.paths, ["src/api/retry.ts"])
        XCTAssertEqual(MainCheckoutCopy.resultLine(try XCTUnwrap(item.result)).text, stale["text"] as? String)
    }

    /// Another noticeKind, or a main checkout payload that doesn't decode, stays the plain notice it was.
    func testOtherOrBrokenNoticesStayPlainNotices() throws {
        var r = TranscriptReducer()
        r.apply(try Self.systemEvent(seq: 1, ["noticeKind": "pool-member-switched", "notice": "Switched"]))
        r.apply(try Self.systemEvent(seq: 2, ["noticeKind": "main-checkout-changed", "notice": "3 files changed"]))
        r.apply(try Self.systemEvent(seq: 3, ["noticeKind": "main-checkout-action-result", "notice": "Cancelled: nothing was changed."]))
        XCTAssertEqual(r.state.items.map(\.asNotice), ["Switched", "3 files changed", "Cancelled: nothing was changed."])
    }

    /// The row survives the on-disk snapshot (the store's v9).
    func testItemRoundTripsThroughCodable() throws {
        let object = try XCTUnwrap(Self.fixture()["changedNotice"])
        var r = TranscriptReducer()
        r.apply(try Self.systemEvent(seq: 7, object))
        let data = try JSONEncoder().encode(r)
        let back = try JSONDecoder().decode(TranscriptReducer.self, from: data)
        XCTAssertEqual(back.state.items, r.state.items)
    }

    // MARK: bar (boards 01⑤, 02④)

    private func health(files: Int?, ahead: Int?, branch: String? = "main", upstream: String? = "origin/main") -> RunnerRepoHealth {
        RunnerRepoHealth(root: "/root/orbit", state: (files ?? 0) > 0 ? "dirty" : "clean", branch: branch, paths: nil,
                         head: "62325fb4a1c0", upstream: upstream, ahead: ahead, behind: 0, fileCount: files,
                         truncated: false, fingerprint: "mc1:62325fb4a1c0:ab")
    }

    func testBarShowsUncommittedFilesWithReviewInAWorktreeSession() {
        let bar = MainCheckoutBar.make(health: health(files: 3, ahead: 0), isolationStatus: "worktree",
                                       isolated: true, actionsSupported: true)
        XCTAssertEqual(bar?.status, "3 uncommitted files")
        XCTAssertEqual(bar?.reviewLabel, "Review")
        XCTAssertNil(bar?.pushLabel)
        XCTAssertEqual(bar?.dirty, true)
        XCTAssertEqual(bar?.branch, "main")
    }

    func testBarInASharedSessionSaysReviewAndCommit() {
        let bar = MainCheckoutBar.make(health: health(files: 3, ahead: 0), isolationStatus: nil,
                                       isolated: false, actionsSupported: true)
        XCTAssertEqual(bar?.reviewLabel, "Review and commit…")
        // A phone's row falls back to the short status before it truncates anything.
        XCTAssertEqual(bar?.shortStatus, "3 uncommitted")
        XCTAssertEqual(MainCheckoutBar.make(health: health(files: 0, ahead: 2), isolationStatus: nil, isolated: false,
                                            actionsSupported: true)?.shortStatus, "2 not pushed")
    }

    func testBarOffersPushWhenCleanAndAhead() {
        let bar = MainCheckoutBar.make(health: health(files: 0, ahead: 1), isolationStatus: nil,
                                       isolated: false, actionsSupported: true)
        XCTAssertEqual(bar?.status, "Clean · 1 commit not pushed")
        XCTAssertEqual(bar?.pushLabel, "Push to origin/main")
        XCTAssertNil(bar?.reviewLabel)
        XCTAssertEqual(bar?.dirty, false)
        // No upstream yet: the push sets origin/<branch>.
        let fresh = MainCheckoutBar.make(health: health(files: 0, ahead: 2, branch: "b", upstream: nil),
                                         isolationStatus: "worktree", isolated: true, actionsSupported: true)
        XCTAssertEqual(fresh?.pushLabel, "Push to origin/b")
        XCTAssertEqual(fresh?.status, "Clean · 2 commits not pushed")
    }

    func testBarDirtyAndAheadSaysBothAndReviewsFirst() {
        let bar = MainCheckoutBar.make(health: health(files: 1, ahead: 2), isolationStatus: "worktree",
                                       isolated: true, actionsSupported: true)
        XCTAssertEqual(bar?.status, "1 uncommitted file · 2 commits not pushed")
        XCTAssertEqual(bar?.reviewLabel, "Review")
        XCTAssertNil(bar?.pushLabel)
    }

    func testBarHidesWhenCleanUnknownOrNotGit() {
        XCTAssertNil(MainCheckoutBar.make(health: health(files: 0, ahead: 0), isolationStatus: "worktree",
                                          isolated: true, actionsSupported: true))
        XCTAssertNil(MainCheckoutBar.make(health: nil, isolationStatus: "worktree", isolated: true, actionsSupported: true))
        // An older runner reports no counts: unknown, never a guessed bar.
        XCTAssertNil(MainCheckoutBar.make(health: RunnerRepoHealth(root: "/r", state: "dirty", branch: "main", paths: ["a"]),
                                          isolationStatus: "worktree", isolated: true, actionsSupported: false))
        XCTAssertNil(MainCheckoutBar.make(health: health(files: 3, ahead: 0), isolationStatus: "shared-nogit",
                                          isolated: false, actionsSupported: true))
    }

    func testBarWithoutTheCapabilityStillSaysWhatItSeesButHasNoButtons() {
        let bar = MainCheckoutBar.make(health: health(files: 3, ahead: 1), isolationStatus: "worktree",
                                       isolated: true, actionsSupported: false)
        XCTAssertEqual(bar?.status, "3 uncommitted files · 1 commit not pushed")
        XCTAssertNil(bar?.reviewLabel)
        XCTAssertNil(bar?.pushLabel)
    }

    /// The heartbeat entry's counts decode off the workspace payload, with the capability flag.
    func testWorkspacePayloadCarriesCountsAndCapability() throws {
        let repo = try XCTUnwrap(Self.fixture()["heartbeatRepo"])
        let workspace: [String: Any] = ["id": "w1", "name": "orbit", "repoHealth": repo, "mainCheckoutActions": true]
        let agent = try Self.decode(Agent.self, workspace)
        XCTAssertEqual(agent.mainCheckoutActions, true)
        XCTAssertEqual(agent.repoHealth?.fileCount, 7)
        XCTAssertEqual(agent.repoHealth?.ahead, 1)
        XCTAssertEqual(agent.repoHealth?.upstream, "origin/main")
        XCTAssertEqual(agent.repoHealth?.fingerprint?.hasPrefix("mc1:62325fb"), true)
        let older = try Self.decode(Agent.self, ["id": "w1", "name": "orbit"])
        XCTAssertNil(older.mainCheckoutActions)
    }

    // MARK: review sheet (board 02)

    func testSelectionStartsWithEveryFileAndGatesCommitOnAMessage() {
        var selection = MainCheckoutSelection(files: [MainCheckoutFile(path: "b", status: "M"),
                                                      MainCheckoutFile(path: "a", status: "A")])
        XCTAssertEqual(selection.paths, ["b", "a"])
        XCTAssertFalse(selection.canCommit(message: "  \n"))
        XCTAssertTrue(selection.canCommit(message: "Add retry backoff"))
        selection.toggle("b")
        XCTAssertEqual(selection.paths, ["a"])
        XCTAssertEqual(MainCheckoutCopy.chooseFiles(chosen: selection.paths.count, total: selection.all.count),
                       "Choose files to commit · 1 of 2")
        XCTAssertEqual(MainCheckoutCopy.commitButton(chosen: 1, branch: "main"), "Commit 1 file to main")
        selection.toggle("a")
        XCTAssertFalse(selection.canMove)
        XCTAssertFalse(selection.canCommit(message: "Add retry backoff"))
    }

    // MARK: isolation dialogs (board 04)

    func testIsolationDialogs() {
        let dirty = health(files: 3, ahead: 0)
        guard case .turnOnDirty? = WorktreeIsolationDialog.make(turningOn: true, health: dirty, workDir: nil,
                                                               unmergedSessions: 0) else { return XCTFail() }
        let on = WorktreeIsolationDialog.make(turningOn: true, health: dirty, workDir: nil, unmergedSessions: 0)
        XCTAssertEqual(on?.title, "Turn on worktree isolation?")
        XCTAssertEqual(on?.message,
                       "The main checkout /root/orbit has 3 uncommitted files. New sessions start from the last commit on main (62325fb), so they won't see those files.\n\n"
                        + "Nothing in the checkout is changed. Sessions already running keep working in the main checkout until they end.")
        XCTAssertEqual(on?.confirm, "Turn on")

        // A clean checkout switches at once, either way.
        XCTAssertNil(WorktreeIsolationDialog.make(turningOn: true, health: health(files: 0, ahead: 3), workDir: nil, unmergedSessions: 0))
        XCTAssertNil(WorktreeIsolationDialog.make(turningOn: false, health: health(files: 0, ahead: 0), workDir: nil, unmergedSessions: 0))

        let stuck = RunnerRepoHealth(root: "/root/orbit", state: "rebase", branch: nil, paths: nil)
        XCTAssertEqual(WorktreeIsolationDialog.make(turningOn: true, health: stuck, workDir: nil, unmergedSessions: 0),
                       .turnOnStuck(body: "The main checkout /root/orbit is stuck in a rebase — new sessions can be created, but merges stay blocked until it's cleaned up."))

        let off = WorktreeIsolationDialog.make(turningOn: false, health: dirty, workDir: nil, unmergedSessions: 2)
        XCTAssertEqual(off?.title, "Turn off worktree isolation?")
        XCTAssertEqual(off?.message,
                       "New sessions will work directly in /root/orbit. The 2 sessions with unmerged worktrees keep them — merge or discard them from each session as before.")
        XCTAssertEqual(off?.confirm, "Turn off")

        // Nothing reported: say so, never guess.
        XCTAssertEqual(WorktreeIsolationDialog.make(turningOn: true, health: nil, workDir: "/root/orbit", unmergedSessions: 0),
                       .unseen(turningOn: true))
        XCTAssertEqual(WorktreeIsolationDialog.unseen(turningOn: true).message, "Orbit can't see this checkout right now.")
        XCTAssertNil(WorktreeIsolationDialog.make(turningOn: false, health: nil, workDir: nil, unmergedSessions: 0))
    }

    // MARK: wiring (OrbitApp compiles only on a Mac, so its hookups are held here as text)

    func testTheAppDrawsTheCardBarSheetAndSwitch() throws {
        func app(_ file: String) throws -> String {
            try String(contentsOf: Self.repoFile("src/macos/OrbitApp/Sources/OrbitApp/\(file)"), encoding: .utf8)
        }
        let console = try app("Views/Console/ConsoleView.swift")
        XCTAssertTrue(console.contains("case .mainCheckout(let item):"))
        XCTAssertTrue(console.contains("MainCheckoutCardView(console: console, item: item, notice: changed)"))
        XCTAssertTrue(console.contains("MainCheckoutResultRow(console: console, result: result)"))
        let bar = try app("Views/WorktreeBar.swift")
        XCTAssertTrue(bar.contains("MainCheckoutBarView(console: console)"))
        XCTAssertTrue(bar.contains("MainCheckoutReviewSheet(model: console.mainCheckout, workspaceID: target.id, console: console)"))
        XCTAssertTrue(try app("Views/AgentsView.swift").contains("WorktreeIsolationSwitch(workspace: agent)"))
        let views = try app("Views/MainCheckoutViews.swift")
        // The switch goes through the one write every caller uses.
        XCTAssertTrue(views.contains("app.setWorktreeIsolation(want, inWorkspace: workspace.id)"))
        XCTAssertFalse(views.contains(".confirmationDialog("))
    }

    // MARK: requests

    /// Each kind's body holds exactly the fields the contract gives it — the fixture's requests, plus
    /// the session the person pressed it in.
    func testActionBodiesMatchTheFixtureRequests() throws {
        let requests = try XCTUnwrap(Self.fixture()["requests"] as? [[String: Any]])
        let fp = try XCTUnwrap(requests.first?["fingerprint"] as? String)
        let posts: [MainCheckoutActionPost] = [
            .move(root: "/root/orbit", fingerprint: fp, files: ["src/api/client.ts", "src/api/retry.ts"],
                  targetSessionId: "sess-1", requestId: "req-move", from: nil),
            .commit(root: "/root/orbit", fingerprint: fp, files: ["src/api/client.ts"], message: "  Add retry backoff\n",
                    requestId: "req-commit", from: nil),
            .push(root: "/root/orbit", fingerprint: fp, requestId: "req-push", from: nil),
            .rescue(root: "/root/orbit", fingerprint: fp, requestId: "req-rescue", from: nil),
        ]
        for (post, expected) in zip(posts, requests) {
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(post)) as? NSDictionary)
            XCTAssertEqual(body, expected as NSDictionary, post.kind.rawValue)
        }
    }

    func testEndpoints() async throws {
        MainCheckoutURLProtocol.requests = []
        let read = try XCTUnwrap(Self.fixture()["snapshot"])
        MainCheckoutURLProtocol.handler = { request in
            if request.httpMethod == "GET" {
                let body: [String: Any] = ["snapshot": read, "actionsSupported": true,
                                           "managedBranch": ["projectId": "p1", "projectTitle": "Main checkout Git",
                                                             "role": "landing-target"],
                                           "inFlight": NSNull(),
                                           "diffs": [["path": "src/api/client.ts", "binary": false, "patch": "@@ -1 +1 @@\n-a\n+b\n"]]]
                return (200, try! JSONSerialization.data(withJSONObject: body))
            }
            return (200, Data(#"{"requestId":"req-1","status":"pending"}"#.utf8))
        }
        defer { MainCheckoutURLProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MainCheckoutURLProtocol.self]
        let api = APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                            session: URLSession(configuration: configuration))

        let view = try await api.mainCheckout(workspaceId: "w1", diff: ["src/api/client.ts", "src/api/retry.ts"])
        XCTAssertTrue(view.actionsSupported)
        XCTAssertEqual(view.snapshot.fileCount, 7)
        XCTAssertEqual(view.managedBranch?.projectTitle, "Main checkout Git")
        XCTAssertEqual(view.diffs?.first?.patch, "@@ -1 +1 @@\n-a\n+b\n")

        let answer = try await api.mainCheckoutAction(
            workspaceId: "w1", .commit(root: "/root/orbit", fingerprint: "mc1:x:y", files: ["a"], message: "m",
                                       requestId: "req-1", from: "sess-1"))
        XCTAssertEqual(answer.status, "pending")
        _ = try await api.cancelMainCheckoutAction(workspaceId: "w1", requestId: "req-1")

        let sent = MainCheckoutURLProtocol.requests
        XCTAssertEqual(sent.map(\.method), ["GET", "POST", "POST"])
        XCTAssertEqual(sent[0].path, "/api/workspaces/w1/main-checkout")
        XCTAssertEqual(sent[0].query, "diff=src/api/client.ts&diff=src/api/retry.ts")
        XCTAssertEqual(sent[1].path, "/api/workspaces/w1/main-checkout/actions")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: sent[1].body) as? NSDictionary)
        XCTAssertEqual(body, ["kind": "commit", "root": "/root/orbit", "fingerprint": "mc1:x:y", "files": ["a"],
                              "message": "m", "requestId": "req-1", "initiatedFromSessionId": "sess-1"] as NSDictionary)
        XCTAssertEqual(sent[2].path, "/api/workspaces/w1/main-checkout/actions/req-1/cancel")
    }
}

private final class MainCheckoutURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (Int, Data))?
    nonisolated(unsafe) static var requests: [(method: String, path: String, query: String, body: Data)] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        Self.requests.append((request.httpMethod ?? "", request.url?.path ?? "",
                              request.url?.query?.removingPercentEncoding ?? "", Self.body(of: request)))
        let (status, body) = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody, !body.isEmpty { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(contentsOf: buffer[0..<read])
        }
        return data
    }
}

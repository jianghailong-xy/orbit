import Foundation
import XCTest
@testable import OrbitKit

/// Moving a session to another workspace (docs/session-folders-move-design.md §4, §5.2–5.4): what
/// `GET /sessions/:id/move-targets` decodes to, how the Move panel's second group and its pages put
/// the server's answer into rows and sentences, and the readable failures of the one move request
/// (the server lets a held session go first; the client never ends it).
final class SessionWorkspaceMoveTests: XCTestCase {
    private func decode(_ json: String) throws -> SessionMoveTargets {
        try JSONDecoder().decode(SessionMoveTargets.self, from: Data(json.utf8))
    }

    /// The server's answer for an idle Codex session (mock 03 ③): the folders of its own workspace,
    /// still held, the branch it leaves behind, and three workspaces — one it can go to, two it
    /// can't, each with the server's reason.
    private func codexAnswer() throws -> SessionMoveTargets {
        try decode(#"""
        {"workspaceId":"w-orbit","folderId":null,
         "folders":[{"id":"f-release","name":"Release","sessionCount":4}],
         "reason":null,"needsEnd":true,"branch":"orbit/review-import-3fa21c",
         "changedFiles":3,"unmergedFiles":3,"mergeTarget":"main",
         "targets":[
          {"workspaceId":"w-wikova","name":"wikova-develop","provider":"codex","runnerId":"r-wikova",
           "runnerName":"wikova","runnerOnline":true,"workDir":"/srv/wikova-develop","reason":null,
           "conversation":"continues",
           "folders":[{"id":"f-bugs","name":"Bugs","sessionCount":12},{"id":"f-infra","name":"Infra","sessionCount":3}]},
          {"workspaceId":"w-wikids","name":"Wikids AI 游戏模拟器","provider":"codex","runnerId":"r-mac",
           "runnerName":"mac-mini","runnerOnline":true,"workDir":"/Users/me/wikids","reason":"Codex keeps this conversation on wikova",
           "conversation":"rebuilt","folders":[]},
          {"workspaceId":"w-site","name":"site","provider":"claude","runnerId":"r-mac","runnerName":"mac-mini",
           "runnerOnline":true,"workDir":"/Users/me/site","reason":"mac-mini can't run Codex",
           "conversation":"rebuilt","folders":[]}
         ]}
        """#)
    }

    private func names(_ slug: String) -> String {
        ["codex": "Codex", "claude": "Claude"][slug] ?? slug
    }

    // MARK: the wire

    func testTheAnswerDecodesAsTheServerSendsIt() throws {
        let answer = try codexAnswer()
        XCTAssertEqual(answer.workspaceId, "w-orbit")
        XCTAssertNil(answer.folderId)
        XCTAssertEqual(answer.folders, [SessionMoveFolder(id: "f-release", name: "Release", sessionCount: 4)])
        XCTAssertNil(answer.reason)
        XCTAssertTrue(answer.needsEnd)
        XCTAssertEqual(answer.branch, "orbit/review-import-3fa21c")
        XCTAssertEqual(answer.changedFiles, 3)
        XCTAssertEqual(answer.unmergedFiles, 3)
        XCTAssertEqual(answer.mergeTarget, "main")
        XCTAssertEqual(answer.targets.map(\.workspaceId), ["w-wikova", "w-wikids", "w-site"])
        let wikova = answer.targets[0]
        XCTAssertEqual(wikova.name, "wikova-develop")
        XCTAssertEqual(wikova.provider, "codex")
        XCTAssertEqual(wikova.runnerId, "r-wikova")
        XCTAssertEqual(wikova.runnerName, "wikova")
        XCTAssertTrue(wikova.runnerOnline)
        XCTAssertEqual(wikova.workDir, "/srv/wikova-develop")
        XCTAssertNil(wikova.reason)
        XCTAssertEqual(wikova.conversation, .continues)
        XCTAssertEqual(wikova.folders.map(\.name), ["Bugs", "Infra"])
        XCTAssertEqual(wikova.id, "w-wikova")
        XCTAssertEqual(answer.targets[1].reason, "Codex keeps this conversation on wikova")
        XCTAssertEqual(answer.targets[1].conversation, .rebuilt)
    }

    /// Every field past the ids is read if present: a payload short of one still decodes, to the
    /// value that claims nothing — no end needed, nothing changed, the runner not called away — and
    /// a way of carrying the conversation this client doesn't know reads as none.
    func testAShortOrNewerAnswerStillDecodes() throws {
        let answer = try decode(#"""
        {"targets":[{"workspaceId":"w2","name":"site","conversation":"teleported"}]}
        """#)
        XCTAssertNil(answer.workspaceId)
        XCTAssertEqual(answer.folders, [])
        XCTAssertNil(answer.reason)
        XCTAssertFalse(answer.needsEnd)
        XCTAssertNil(answer.branch)
        XCTAssertEqual(answer.changedFiles, 0)
        XCTAssertEqual(answer.unmergedFiles, 0)
        let target = try XCTUnwrap(answer.targets.first)
        XCTAssertEqual(target.provider, "claude")
        XCTAssertTrue(target.runnerOnline, "only the server's own false says a runner is away")
        XCTAssertNil(target.conversation)
        XCTAssertEqual(target.folders, [])
        XCTAssertEqual(try JSONDecoder().decode(SessionMoveFolder.self, from: Data(#"{"id":"f","name":"N"}"#.utf8)).sessionCount, 0)
        XCTAssertEqual(try decode("{}").targets, [])
    }

    /// The move to another workspace names it, and the folder there — "No Folder" as an explicit
    /// null; a move within the workspace still leaves the workspace out.
    func testTheMoveRequestNamesTheWorkspace() throws {
        func body(_ request: MoveSessionRequest) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        }
        let into = try body(MoveSessionRequest(folderId: "f-bugs", workspaceId: "w-wikova"))
        XCTAssertEqual(into["workspaceId"] as? String, "w-wikova")
        XCTAssertEqual(into["folderId"] as? String, "f-bugs")
        let loose = try body(MoveSessionRequest(folderId: nil, workspaceId: "w-wikova"))
        XCTAssertEqual(loose["workspaceId"] as? String, "w-wikova")
        XCTAssertTrue(loose["folderId"] is NSNull)
        let within = try body(MoveSessionRequest(folderId: "f1"))
        XCTAssertEqual(Array(within.keys), ["folderId"])
    }

    // MARK: the panel's second group

    /// Mock 03 ③: the workspace it can go to reads `<Provider> · <runner>` and opens; the two it
    /// can't are greyed with the server's reasons, shown as they are.
    func testRowsGreyTheWorkspacesTheServerRefuses() throws {
        let rows = SessionWorkspaceMoveLogic.rows(try codexAnswer(), providerName: names)
        XCTAssertEqual(rows.map(\.id), ["w-wikova", "w-wikids", "w-site"])
        XCTAssertEqual(rows.map(\.isEnabled), [true, false, false])
        XCTAssertEqual(rows.map(\.detail), ["Codex · wikova", "Codex keeps this conversation on wikova",
                                            "mac-mini can't run Codex"])
        XCTAssertNil(SessionWorkspaceMoveLogic.groupReason(try codexAnswer()))
    }

    /// A session that can't leave at all (§5.2 — running, a task's run, Trash…): every row is greyed,
    /// each still saying what it would, and the group says why under it.
    func testASessionThatCantLeaveGreysTheWholeGroup() throws {
        let answer = try decode(#"""
        {"reason":"Stop the session first.","needsEnd":false,
         "targets":[{"workspaceId":"w2","name":"site","provider":"claude","runnerName":"mac-mini","runnerOnline":true},
                    {"workspaceId":"w3","name":"web","provider":"claude","runnerName":"wikova","runnerOnline":true,
                     "reason":"Update wikova to move sessions here"}]}
        """#)
        let rows = SessionWorkspaceMoveLogic.rows(answer, providerName: names)
        XCTAssertEqual(rows.map(\.isEnabled), [false, false])
        XCTAssertEqual(rows.map(\.detail), ["Claude · mac-mini", "Update wikova to move sessions here"])
        XCTAssertEqual(SessionWorkspaceMoveLogic.groupReason(answer), "Stop the session first.")
    }

    /// An offline runner is no reason not to move (§5.2): the row stays open and says so.
    func testAnOfflineRunnerStaysOpenAndSaysSo() throws {
        let answer = SessionMoveTargets(targets: [
            SessionMoveTarget(workspaceId: "w2", name: "wikids", provider: "claude", runnerId: "r2",
                              runnerName: "mac-mini", runnerOnline: false, conversation: .rebuilt),
            SessionMoveTarget(workspaceId: "w3", name: "notes", provider: "claude", runnerId: nil,
                              runnerName: nil, runnerOnline: true),
        ])
        let rows = SessionWorkspaceMoveLogic.rows(answer, providerName: names)
        XCTAssertEqual(rows.map(\.isEnabled), [true, true])
        XCTAssertEqual(rows.map(\.detail), ["Runner offline", "Claude"])
    }

    /// A workspace's page lists its folders by name, the ones made from the page among them.
    func testThePageListsTheFoldersThereWithTheOnesMadeSince() throws {
        let wikova = try codexAnswer().targets[0]
        let made = [SessionMoveFolder(id: "f-new", name: "Audit"), SessionMoveFolder(id: "f-bugs", name: "Bugs", sessionCount: 12)]
        XCTAssertEqual(SessionWorkspaceMoveLogic.folders(of: wikova, adding: made).map(\.name),
                       ["Audit", "Bugs", "Infra"])
        XCTAssertEqual(SessionWorkspaceMoveLogic.folders(of: wikova, adding: []).map(\.sessionCount), [12, 3])
    }

    // MARK: the words

    /// Mock 03 ①: the same runner carries the conversation over as it is, and the agent works in the
    /// new workspace's directory from the next message.
    func testThePageSaysWhichRunnerAndHowTheConversationCarriesOver() throws {
        XCTAssertEqual(SessionMoveCopy.targetFooter(try codexAnswer().targets[0]),
                       "Same runner (wikova). The conversation carries over as it is. "
                       + "The agent works in /srv/wikova-develop from your next message.")
        let rebuilt = SessionMoveTarget(workspaceId: "w2", name: "wikids", runnerName: "mac-mini",
                                        runnerOnline: false, workDir: "/Users/me/wikids", conversation: .rebuilt)
        XCTAssertEqual(SessionMoveCopy.targetFooter(rebuilt),
                       "Another runner (mac-mini). The conversation is rebuilt from Orbit’s record, its earlier "
                       + "parts summarized for the agent. The agent works in /Users/me/wikids from your next "
                       + "message. mac-mini is offline: your next message waits for it.")
        let bare = SessionMoveTarget(workspaceId: "w3", name: "x", runnerName: "box", conversation: nil)
        XCTAssertEqual(SessionMoveCopy.targetFooter(bare), "It runs on box.")
    }

    /// Mock 03 ②: an idle session with unmerged changes. Still held, but the server lets it go first, so
    /// nothing is said about ending it and the button is Move.
    func testTheConfirmationOfAnIdleSessionWithUnmergedChanges() throws {
        let answer = try codexAnswer()
        let wikova = answer.targets[0]
        XCTAssertEqual(SessionMoveCopy.confirmTitle(wikova), "Move to wikova-develop?")
        XCTAssertEqual(SessionMoveCopy.confirmMessage(answer, to: wikova, from: "orbit"),
                       "The conversation moves with it. Your next message continues it in wikova-develop.\n\n"
                       + "3 changed files aren’t merged into main yet. They stay on branch "
                       + "orbit/review-import-3fa21c in orbit.")
        XCTAssertTrue(answer.needsEnd)
        XCTAssertEqual(SessionMoveCopy.confirmAction, "Move")
    }

    /// §5.3's other sentences: another runner's rebuild is said, merged changes stay on their branch,
    /// one unmerged file is one, and an ended session moves with Move.
    func testTheConfirmationIsPutTogetherFromTheAnswer() throws {
        let rebuilt = SessionMoveTarget(workspaceId: "w2", name: "site", runnerName: "mac-mini", conversation: .rebuilt)
        let merged = SessionMoveTargets(needsEnd: false, branch: "orbit/fix-1", changedFiles: 2,
                                        unmergedFiles: 0, mergeTarget: "main", targets: [rebuilt])
        XCTAssertEqual(SessionMoveCopy.confirmMessage(merged, to: rebuilt, from: "orbit"),
                       "The conversation moves with it. Your next message continues it in site.\n\n"
                       + "Earlier parts of the conversation are summarized for the agent.\n\n"
                       + "Changes made so far stay on branch orbit/fix-1 in orbit.")

        let one = SessionMoveTargets(branch: "orbit/fix-1", changedFiles: 4, unmergedFiles: 1,
                                     mergeTarget: "release", targets: [rebuilt])
        XCTAssertTrue(SessionMoveCopy.confirmMessage(one, to: rebuilt, from: "orbit").hasSuffix(
            "1 changed file isn’t merged into release yet. It stays on branch orbit/fix-1 in orbit."))

        // Nothing changed, or no branch: nothing is said about changes.
        let clean = SessionMoveTargets(branch: "orbit/fix-1", changedFiles: 0, targets: [rebuilt])
        let shared = SessionMoveTargets(branch: nil, changedFiles: 5, unmergedFiles: 5, targets: [rebuilt])
        for answer in [clean, shared] {
            XCTAssertFalse(SessionMoveCopy.confirmMessage(answer, to: rebuilt, from: "orbit").contains("branch"))
        }
    }

    func testTheProgressAndTheToast() {
        XCTAssertEqual(SessionMoveCopy.moving, "Moving…")
        XCTAssertEqual(SessionMoveCopy.movedToWorkspace("wikova-develop"), "Moved to wikova-develop")
        XCTAssertEqual(SessionMoveCopy.anotherWorkspaceGroup, "Move to Another Workspace")
    }

    /// The move's second line says only why it failed; a refusal keeps the server's sentence.
    func testARefusedMoveSaysTheServersReason() {
        XCTAssertEqual(SessionMoveCopy.couldNotMove, "Couldn't move the session")
        XCTAssertEqual(SessionMoveCopy.moveFailed(APIError.http(status: 409, body: #"{"message":"Stop the session first.","statusCode":409}"#)),
                       "Stop the session first.")
        XCTAssertEqual(SessionMoveCopy.moveFailed(APIError.http(status: 403, body: #"{"message":"Permission denied."}"#)),
                       "Permission denied.")
        XCTAssertEqual(SessionMoveCopy.moveFailed(URLError(.networkConnectionLost)), "the connection dropped")
    }
}

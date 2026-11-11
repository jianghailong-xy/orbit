import Foundation
import XCTest
@testable import OrbitKit

/// Where a project is coordinated from (docs/mocks/coordinator-move-workspace/04-change): Change
/// workspace's rows and its confirmation's words — held to the web's `lib/coordinatorWorkspace.ts`
/// and its tests — the Move panel's words for a coordinator, and the Apple shells that use them.
final class CoordinatorChangeTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    /// The file at `path` from the repository root, found by walking up from this test.
    private func source(_ path: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(path)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: path)
    }

    private func decode(_ json: String) throws -> SessionMoveTargets {
        try JSONDecoder().decode(SessionMoveTargets.self, from: Data(json.utf8))
    }

    private func names(_ slug: String) -> String {
        slug == "codex" ? "Codex" : "Claude"
    }

    /// The coordinator of "Website Revamp" in orbit: one workspace the conversation can go to, one
    /// only a new one can open in (its runner away), one nothing can open in.
    private func coordinatorAnswer(reason: String? = nil, needsEnd: Bool = false) throws -> SessionMoveTargets {
        let whole = reason.map { "\"\($0)\"" } ?? "null"
        return try decode(#"""
        {"workspaceId":"w1","reason":\#(whole),"needsEnd":\#(needsEnd),"branch":null,"changedFiles":0,
         "coordinates":{"projectId":"p1","title":"Website Revamp"},
         "targets":[
          {"workspaceId":"w2","name":"orbit-prod","provider":"claude","runnerId":"r1","runnerName":"workstation-gpu",
           "runnerOnline":true,"reason":null,"conversation":"continues","folders":[],"startsCoordinator":true},
          {"workspaceId":"w3","name":"wikova-develop","provider":"codex","runnerId":"r2","runnerName":"wikova",
           "runnerOnline":false,"reason":"Codex keeps this conversation on workstation-gpu","conversation":"rebuilt",
           "folders":[],"startsCoordinator":true},
          {"workspaceId":"w4","name":"HPC","provider":"claude","reason":"This workspace has no runner.",
           "conversation":"rebuilt","folders":[],"startsCoordinator":false}
         ]}
        """#)
    }

    // MARK: the wire

    func testTheCoordinatorFieldsDecodeAndAnOlderAnswerLacksThem() throws {
        let answer = try coordinatorAnswer()
        XCTAssertEqual(answer.coordinates, SessionMoveCoordinates(projectId: "p1", title: "Website Revamp"))
        XCTAssertEqual(answer.targets.map(\.startsCoordinator), [true, true, false])

        let older = try decode(#"{"targets":[{"workspaceId":"w2","name":"site"}]}"#)
        XCTAssertNil(older.coordinates)
        XCTAssertEqual(older.targets.map(\.startsCoordinator), [false])
        XCTAssertNil(try decode(#"{"coordinates":null,"targets":[]}"#).coordinates)
    }

    // MARK: the rows for a conversation that exists

    /// Per workspace: the conversation comes along, a new one opens (with the server's why), or
    /// nothing can. The current one leads, with no detail — its Current mark says it.
    func testTheRowsFromTheTargets() throws {
        let rows = CoordinatorChangeLogic.rows(try coordinatorAnswer(), currentID: "w1", currentName: "orbit",
                                               providerName: names)
        XCTAssertEqual(rows.map(\.name), ["orbit", "orbit-prod", "wikova-develop", "HPC"])
        XCTAssertEqual(rows.map(\.detail), ["", "Claude · workstation-gpu", "Codex · wikova", "This workspace has no runner."])
        XCTAssertEqual(rows.map(\.way), [nil, .move, .new, nil])
        XCTAssertEqual(rows.map(\.reason), [nil, nil, "Codex keeps this conversation on workstation-gpu",
                                            "This workspace has no runner."])
        XCTAssertEqual(rows.map(\.isCurrent), [true, false, false, false])
        XCTAssertEqual(rows.map(\.runnerOffline), [false, false, true, false])
        // Mock 04 (iPhone): the second line says which way the project goes.
        XCTAssertEqual(rows.map(\.subtitle), ["", "Claude · workstation-gpu · Conversation comes along",
                                              "Codex · wikova · New conversation", "This workspace has no runner."])
    }

    func testOnlyNewStartsWhileTheSessionCannotMove() throws {
        let rows = CoordinatorChangeLogic.rows(try coordinatorAnswer(reason: "Stop the session first."),
                                               currentID: "w1", currentName: "orbit", providerName: names)
        XCTAssertEqual(rows[1].way, .new)
        XCTAssertEqual(rows[1].reason, "Stop the session first.")
    }

    // MARK: the rows when there is no conversation to bring

    private func agent(_ json: String) throws -> Agent {
        try JSONDecoder().decode(Agent.self, from: Data(json.utf8))
    }

    func testTheRowsFromTheWorkspaces() throws {
        let workspaces = [
            try agent(#"{"id":"w2","name":"orbit-prod","lastProvider":"claude","runnerId":"r1","enabled":true}"#),
            try agent(#"{"id":"w1","name":"orbit","runnerId":"r1","enabled":true}"#),
            try agent(#"{"id":"w3","name":"HPC","enabled":true}"#),
            try agent(#"{"id":"w4","name":"mac-tools","runnerId":"r1","enabled":false}"#),
            try agent(#"{"id":"w5","name":"wikova","lastProvider":"codex","runnerId":"r2"}"#),
            try agent(#"{"id":"w6","name":"new","runnerId":"r3"}"#),
        ]
        let runners = ["r1": "workstation-gpu"]
        let online = ["r1": true, "r2": false]
        let rows = CoordinatorChangeLogic.rows(workspaces, currentWorkspaceID: "w1",
                                               runnerName: { runners[$0] }, runnerOnline: { online[$0] },
                                               providerName: names)
        XCTAssertEqual(rows.map(\.name), ["orbit", "orbit-prod", "HPC", "mac-tools", "wikova", "new"],
                       "the current workspace leads")
        XCTAssertEqual(rows.map(\.way), [nil, .new, nil, nil, .new, .new])
        XCTAssertEqual(rows.map(\.detail), ["Claude · workstation-gpu", "Claude · workstation-gpu",
                                            "This workspace has no runner.", "This workspace is disabled.",
                                            "Codex", "Claude"])
        XCTAssertEqual(rows.map(\.isCurrent), [true, false, false, false, false, false])
        XCTAssertEqual(rows.map(\.runnerOffline), [false, false, false, false, true, false],
                       "a runner whose liveness isn't known yet is not said to be offline")
    }

    // MARK: the confirmations

    func testBothWaysWhereTheConversationComesAlong() {
        XCTAssertEqual(CoordinatorChangeCopy.title(project: "Website Revamp", to: "orbit-prod"),
                       "Coordinate Website Revamp from orbit-prod?")
        XCTAssertEqual(CoordinatorChangeCopy.moveParagraphs(
            to: "orbit-prod", from: "orbit", needsEnd: true,
            files: "3 changed files aren’t merged into main yet. They stay on branch b in orbit."), [
            "Move conversation: this conversation goes to orbit-prod and continues there. It ends first. 3 changed files aren’t merged into main yet. They stay on branch b in orbit.",
            "Start a new one there: this conversation is completed and stays readable in orbit, and a new, empty one opens in orbit-prod.",
            "Either way, its tasks keep running where they are.",
        ])
        XCTAssertEqual(CoordinatorChangeCopy.moveParagraphs(to: "b", from: "a", needsEnd: false, files: nil).first,
                       "Move conversation: this conversation goes to b and continues there.")
    }

    func testWhyFirstWhenOnlyANewOneCanOpenThere() {
        XCTAssertEqual(CoordinatorChangeCopy.newParagraphs(to: "wikova", from: "orbit", outgoing: .open,
                                                           reason: "Codex keeps this conversation on workstation-gpu"), [
            "This conversation can’t come along: Codex keeps this conversation on workstation-gpu.",
            "It is completed — a turn in flight finishes first — and stays readable in orbit. A new, empty one opens in wikova.",
            "Its tasks keep running where they are.",
        ])
        XCTAssertEqual(CoordinatorChangeCopy.newAction("wikova", outgoing: .open), "Complete and start in wikova")
    }

    func testNothingToCompleteOrExplainWhenTheConversationIsOverOrGone() {
        XCTAssertEqual(CoordinatorChangeCopy.newParagraphs(to: "b", from: "a", outgoing: .completed, reason: nil).first,
                       "It stays completed and readable in a. A new, empty one opens in b.")
        XCTAssertEqual(CoordinatorChangeCopy.newParagraphs(to: "b", from: nil, outgoing: .none, reason: "x"), [
            "A new, empty one opens in b.",
            "Its tasks keep running where they are.",
        ])
        XCTAssertEqual(CoordinatorChangeCopy.newAction("b", outgoing: .none), "Start in b")
        XCTAssertEqual(CoordinatorChangeCopy.newAction("b", outgoing: .completed), "Start in b")
    }

    func testTheSheetsWords() {
        XCTAssertEqual(CoordinatorChangeCopy.sub("Website Revamp", from: "orbit"), "Website Revamp · coordinated from orbit")
        XCTAssertEqual(CoordinatorChangeCopy.sub("Website Revamp", from: nil), "Website Revamp")
    }

    /// The files sentence Change's Move conversation carries is the Move panel's own.
    func testTheFilesSentence() {
        XCTAssertNil(SessionMoveCopy.filesSentence(SessionMoveTargets(), from: "orbit"))
        XCTAssertEqual(SessionMoveCopy.filesSentence(SessionMoveTargets(branch: "b", changedFiles: 2), from: "orbit"),
                       "Changes made so far stay on branch b in orbit.")
        XCTAssertEqual(SessionMoveCopy.filesSentence(SessionMoveTargets(branch: "b", changedFiles: 3, unmergedFiles: 1),
                                                     from: "orbit"),
                       "1 changed file isn’t merged into main yet. It stays on branch b in orbit.")
        XCTAssertEqual(SessionMoveCopy.filesSentence(SessionMoveTargets(branch: "b", changedFiles: 3, unmergedFiles: 3,
                                                                        mergeTarget: "dev"), from: "orbit"),
                       "3 changed files aren’t merged into dev yet. They stay on branch b in orbit.")
    }

    func testWhatIsLeftBehindIsReadOffTheCard() {
        func status(_ state: ProjectCoordinationState, _ lifecycle: SessionLifecycleState?) -> ProjectCoordinatorStatus {
            ProjectCoordinatorStatus(projectId: "p1", state: state, coordination: .init(
                session: lifecycle.map { .init(id: "s1", lifecycleState: $0) }))
        }
        XCTAssertEqual(OutgoingCoordinator(status(.live, .open)), .open)
        XCTAssertEqual(OutgoingCoordinator(status(.live, .completed)), .completed)
        XCTAssertEqual(OutgoingCoordinator(status(.trashed, .trash)), .none)
        XCTAssertEqual(OutgoingCoordinator(status(.neverOpened, nil)), .none)
        XCTAssertEqual(OutgoingCoordinator(nil), .none)
        XCTAssertEqual(CoordinatorChangeLogic.conversationID(status(.live, .completed)), "s1")
        XCTAssertNil(CoordinatorChangeLogic.conversationID(status(.trashed, .trash)), "a conversation in Trash stays")
        XCTAssertNil(CoordinatorChangeLogic.conversationID(status(.neverOpened, nil)))
    }

    // MARK: the Move panel

    func testTheTitleLineAndTheGroupFooterNameTheProject() throws {
        let answer = try coordinatorAnswer()
        XCTAssertEqual(SessionMoveCopy.sessionLine("Coordinate the revamp", answer),
                       "Coordinate the revamp · Coordinator of Website Revamp")
        XCTAssertEqual(SessionMoveCopy.sessionLine("Fix it", SessionMoveTargets()), "Fix it")
        XCTAssertEqual(SessionMoveCopy.sessionLine("Fix it", nil), "Fix it")

        XCTAssertEqual(SessionWorkspaceMoveLogic.groupFooter(answer), "The project’s coordinator moves with it.")
        let stuck = SessionMoveTargets(reason: "It is running.", coordinates: answer.coordinates)
        XCTAssertEqual(SessionWorkspaceMoveLogic.groupFooter(stuck), "It is running.", "why it can't leave wins")
        XCTAssertNil(SessionWorkspaceMoveLogic.groupFooter(SessionMoveTargets()))
    }

    /// The Move panel's own confirmation for a coordinator, word for word as the web's `moveConfirmParagraphs`.
    func testTheMovePanelsCoordinatorConfirmation() throws {
        let answer = try coordinatorAnswer(needsEnd: true)
        let prod = answer.targets[0]
        XCTAssertEqual(SessionMoveCopy.confirmTitle(prod, answer), "Move the coordinator to orbit-prod?")
        XCTAssertEqual(SessionMoveCopy.confirmTitle(prod), "Move to orbit-prod?")
        XCTAssertEqual(SessionMoveCopy.confirmMessage(answer, to: prod, from: "orbit"),
                       "The conversation moves with it. Your next message continues it in orbit-prod.\n\n"
                       + "Website Revamp is coordinated from orbit-prod from now on, and its row moves to "
                       + "orbit-prod’s list. Its tasks keep running where they are.\n\n"
                       + "The session ends first. Until you message it again, Orbit’s updates for the project "
                       + "wait on the project page.")
        XCTAssertFalse(SessionMoveCopy.confirmMessage(try coordinatorAnswer(), to: prod, from: "orbit")
            .contains("ends first"))
    }

    // MARK: the web's words

    /// Every sentence above is the web's, in its own files.
    func testTheWordsAreTheWebs() throws {
        let lib = try source("src/web/src/lib/coordinatorWorkspace.ts")
        for literal in ["button: '\(CoordinatorChangeCopy.button)'",
                        "title: '\(CoordinatorChangeCopy.title)'",
                        "`${project} · coordinated from ${from}`",
                        "current: '\(CoordinatorChangeCopy.current)'",
                        "runnerOffline: '\(CoordinatorChangeCopy.runnerOffline)'",
                        "comesAlong: '\(CoordinatorChangeCopy.comesAlong)'",
                        "newConversation: '\(CoordinatorChangeCopy.newConversation)'",
                        "foot: '\(CoordinatorChangeCopy.foot)'",
                        "disabled: '\(CoordinatorChangeCopy.disabled)'",
                        "noRunner: '\(CoordinatorChangeCopy.noRunner)'",
                        "cancel: '\(CoordinatorChangeCopy.cancel)'",
                        "move: '\(CoordinatorChangeCopy.move)'",
                        "startThere: '\(CoordinatorChangeCopy.startThere)'",
                        "`Coordinate ${project} from ${to}?`",
                        "`this conversation goes to ${to} and continues there.`",
                        "'It ends first.'",
                        "`Move conversation: ${move.join(' ')}`",
                        "`Start a new one there: this conversation is completed and stays readable in ${from}, and a new, empty one opens in ${to}.`",
                        "'Either way, its tasks keep running where they are.'",
                        "`This conversation can’t come along: ${sentence(reason)}`",
                        "`It is completed — a turn in flight finishes first — and stays readable${where}. A new, empty one opens in ${to}.`",
                        "`It stays completed and readable${where}. A new, empty one opens in ${to}.`",
                        "`A new, empty one opens in ${to}.`",
                        "'Its tasks keep running where they are.'",
                        "`Complete and start in ${to}` : `Start in ${to}`"] {
            XCTAssertTrue(lib.contains(literal), "coordinatorWorkspace.ts no longer says \(literal)")
        }
        let folders = try source("src/web/src/lib/sessionFolders.ts")
        for literal in ["`Coordinator of ${project}`",
                        "coordinatorMoves: '\(SessionMoveCopy.coordinatorMoves)'",
                        "`Changes made so far stay on branch ${answer.branch} in ${fromWorkspace}.`",
                        "`${files} merged into ${answer.mergeTarget ?? 'main'} yet. ${they} on branch ${answer.branch} in ${fromWorkspace}.`"] {
            XCTAssertTrue(folders.contains(literal), "sessionFolders.ts no longer says \(literal)")
        }
        let card = try source("src/web/src/components/ProjectCoordinatorCard.tsx")
        XCTAssertTrue(card.contains("'\(ProjectPage.startNewCoordinatorDetail(finished: false))'"))
    }

    // MARK: the Apple shells

    private func app(_ relative: String) throws -> String {
        try source("src/macos/OrbitApp/Sources/OrbitApp/\(relative)")
    }

    /// The coordinator block's menu has exactly Change workspace… and Start a new coordinator, on
    /// both platforms; the Unavailable and Trash cards open the same Change.
    func testTheProjectPageOffersChangeWorkspace() throws {
        let view = try app("Views/ProjectsView.swift")
        let menuStart = try XCTUnwrap(view.range(of: "Menu {\n                        Button(CoordinatorChangeCopy.button)"),
                                      "the coordinator menu leads with Change workspace…")
        let menuEnd = try XCTUnwrap(view.range(of: "} label: {\n                        Text(ProjectPage.coordinatorPress(",
                                               range: menuStart.upperBound..<view.endIndex))
        let menu = String(view[menuStart.lowerBound..<menuEnd.lowerBound])
        XCTAssertTrue(menu.contains("Text(ProjectPage.startNewCoordinator)"))
        XCTAssertEqual(menu.components(separatedBy: "Button").count - 1, 2, "two items, no more")
        XCTAssertFalse(menu.contains("#if"), "the same menu on iOS and macOS")
        for part in ["if status.state == .unavailable || status.state == .trashed {\n                    Button(CoordinatorChangeCopy.button) { pageSheet = .coordinatorChange }",
                     "CoordinatorChangeSheet(projectTitle: document.title,",
                     "sessionID: CoordinatorChangeLogic.conversationID(store.coordinator),",
                     ".orbitConfirmation({ CoordinatorChangeCopy.title(project: document.title, to: $0.row.name) },",
                     "Button(CoordinatorChangeCopy.move) { moveCoordinatorConversation(store, to: pick.row, targets: targets) }",
                     ".keyboardShortcut(.defaultAction)",
                     "Button(CoordinatorChangeCopy.startThere) { replaceCoordinator(store, inWorkspace: pick.row.workspaceId) }",
                     "Button(CoordinatorChangeCopy.newAction(pick.row.name, outgoing: outgoing),",
                     "role: outgoing == .open ? .destructive : nil) {",
                     "Button(CoordinatorChangeCopy.cancel, role: .cancel) {}",
                     "await model.moveSession(sessionID, to: target, folder: nil,",
                     "endingFirst: targets.needsEnd) { changePhase = $0 }",
                     "files: SessionMoveCopy.filesSentence(targets, from: from ?? \"\"))"] {
            XCTAssertTrue(view.contains(part), "ProjectsView lacks `\(part)`")
        }
        for gone in ["StartCoordinatorCopy", "SessionMoveSheet(", "movingCoordinator"] {
            XCTAssertFalse(view.contains(gone), "ProjectsView still has `\(gone)`")
        }
        let sheet = try app("Views/CoordinatorChangeSheet.swift")
        for part in ["targets = try await app.sessionMoveTargets(sessionID)",
                     "CoordinatorChangeLogic.rows(\n                agents?.orderedItems ?? [],",
                     "CoordinatorChangeLogic.rows(\n            targets, currentID: currentWorkspaceID,",
                     ".disabled(row.way == nil)", "Text(row.subtitle)",
                     "Text(CoordinatorChangeCopy.current)", "Text(CoordinatorChangeCopy.runnerOffline)",
                     "Text(CoordinatorChangeCopy.sub(projectTitle, from: currentWorkspaceName))",
                     "Text(CoordinatorChangeCopy.foot)", ".navigationTitle(CoordinatorChangeCopy.title)"] {
            XCTAssertTrue(sheet.contains(part), "CoordinatorChangeSheet lacks `\(part)`")
        }
        XCTAssertTrue(try app("ProjectsModel.swift").contains(
            "try await api.replaceProjectCoordinator(projectID, workspaceID: workspaceID)"))
    }

    /// The Move panel keeps the coordinator's line and footer, and offers no Start new here….
    func testTheMovePanelNoLongerStartsACoordinator() throws {
        let sheet = try app("Views/SessionMoveSheet.swift")
        XCTAssertTrue(sheet.contains("SessionMoveCopy.sessionLine(SessionHeader.title(for: session, fallbackAgent: workspace.name),"))
        XCTAssertTrue(sheet.contains("SessionWorkspaceMoveLogic.groupFooter(targets)"))
        for gone in ["startsNew", "StartCoordinatorCopy", "startCoordinator(", "startingIn"] {
            XCTAssertFalse(sheet.contains(gone), "SessionMoveSheet still has `\(gone)`")
        }
        XCTAssertTrue(try app("Views/SessionMoveTargetPage.swift").contains("SessionMoveCopy.confirmTitle(current, answer)"))
        XCTAssertFalse(try app("AppModel.swift").contains("func startCoordinator(ofProject"))
    }
}

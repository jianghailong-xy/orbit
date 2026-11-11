import Foundation
import XCTest
@testable import OrbitKit

/// A project's coordinator changing workspace (docs/mocks/coordinator-move-workspace 03-final): the
/// Move panel's words for a coordinator and its Start new here… rows, the Start a new coordinator in…
/// picker and its confirmation — held to the web's `lib/sessionFolders.ts` and
/// `lib/coordinatorWorkspace.ts` — and the Apple shells that use them.
final class CoordinatorWorkspaceTests: XCTestCase {
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
        ["codex": "Codex", "claude": "Claude"][slug] ?? slug
    }

    /// Mock 03 ②: the coordinator of "Session list redesign", idle, with one workspace it can go to
    /// and one it can't where a new coordinator could open.
    private func coordinatorAnswer(needsEnd: Bool = true) throws -> SessionMoveTargets {
        try decode(#"""
        {"workspaceId":"w-orbit","reason":null,"needsEnd":\#(needsEnd),"branch":null,"changedFiles":0,
         "coordinates":{"projectId":"p1","title":"Session list redesign"},
         "targets":[
          {"workspaceId":"w-prod","name":"orbit-prod","provider":"claude","runnerName":"workstation-gpu",
           "runnerOnline":true,"reason":null,"conversation":"continues","folders":[],"startsCoordinator":true},
          {"workspaceId":"w-hpc","name":"HPC","provider":"codex","runnerName":"hpc","runnerOnline":true,
           "reason":"HPC can't run Codex","conversation":"rebuilt","folders":[],"startsCoordinator":true},
          {"workspaceId":"w-off","name":"off","provider":"claude","reason":"This workspace is disabled.",
           "conversation":"rebuilt","folders":[],"startsCoordinator":false}
         ]}
        """#)
    }

    // MARK: the wire

    func testTheCoordinatorFieldsDecodeAndAnOlderAnswerLacksThem() throws {
        let answer = try coordinatorAnswer()
        XCTAssertEqual(answer.coordinates, SessionMoveCoordinates(projectId: "p1", title: "Session list redesign"))
        XCTAssertEqual(answer.targets.map(\.startsCoordinator), [true, true, false])

        let older = try decode(#"{"targets":[{"workspaceId":"w2","name":"site"}]}"#)
        XCTAssertNil(older.coordinates)
        XCTAssertEqual(older.targets.map(\.startsCoordinator), [false])
        XCTAssertNil(try decode(#"{"coordinates":null,"targets":[]}"#).coordinates)
    }

    // MARK: the Move panel

    /// Start new here… only on a row the conversation can't reach but a new coordinator could open in,
    /// and only while the session itself can leave.
    func testStartNewHereIsOfferedWhereOnlyANewCoordinatorCanGo() throws {
        let rows = SessionWorkspaceMoveLogic.rows(try coordinatorAnswer(), providerName: names)
        XCTAssertEqual(rows.map(\.isEnabled), [true, false, false])
        XCTAssertEqual(rows.map(\.startsNew), [false, true, false])
        XCTAssertEqual(rows[1].detail, "HPC can't run Codex")

        let stuck = SessionMoveTargets(reason: "It is running.", coordinates: SessionMoveCoordinates(projectId: "p1", title: "P"),
                                       targets: try coordinatorAnswer().targets)
        XCTAssertEqual(SessionWorkspaceMoveLogic.rows(stuck, providerName: names).map(\.startsNew), [false, false, false])
        let plain = SessionMoveTargets(targets: try coordinatorAnswer().targets)
        XCTAssertEqual(SessionWorkspaceMoveLogic.rows(plain, providerName: names).map(\.startsNew), [false, false, false],
                       "any other session is never offered a coordinator")
    }

    func testTheTitleLineAndTheGroupFooterNameTheProject() throws {
        let answer = try coordinatorAnswer()
        XCTAssertEqual(SessionMoveCopy.sessionLine("Coordinate the session list redesign", answer),
                       "Coordinate the session list redesign · Coordinator of Session list redesign")
        XCTAssertEqual(SessionMoveCopy.sessionLine("Fix it", SessionMoveTargets()), "Fix it")
        XCTAssertEqual(SessionMoveCopy.sessionLine("Fix it", nil), "Fix it")

        XCTAssertEqual(SessionWorkspaceMoveLogic.groupFooter(answer), "The project’s coordinator moves with it.")
        let stuck = SessionMoveTargets(reason: "It is running.", coordinates: answer.coordinates)
        XCTAssertEqual(SessionWorkspaceMoveLogic.groupFooter(stuck), "It is running.", "why it can't leave wins")
        XCTAssertNil(SessionWorkspaceMoveLogic.groupFooter(SessionMoveTargets()))
    }

    /// Mock 03 ②: the coordinator's confirmation, word for word as the web's `moveConfirmParagraphs`.
    func testTheCoordinatorsConfirmation() throws {
        let answer = try coordinatorAnswer()
        let prod = answer.targets[0]
        XCTAssertEqual(SessionMoveCopy.confirmTitle(prod, answer), "Move the coordinator to orbit-prod?")
        XCTAssertEqual(SessionMoveCopy.confirmTitle(prod), "Move to orbit-prod?")
        XCTAssertEqual(SessionMoveCopy.confirmMessage(answer, to: prod, from: "orbit"),
                       "The conversation moves with it. Your next message continues it in orbit-prod.\n\n"
                       + "Session list redesign is coordinated from orbit-prod from now on, and its row moves to "
                       + "orbit-prod’s list. Its tasks keep running where they are.\n\n"
                       + "The session ends first. Until you message it again, Orbit’s updates for the project "
                       + "wait on the project page.")
        XCTAssertFalse(SessionMoveCopy.confirmMessage(try coordinatorAnswer(needsEnd: false), to: prod, from: "orbit")
            .contains("ends first"))
    }

    // MARK: Start a new coordinator in…

    private func agent(_ json: String) throws -> Agent {
        try JSONDecoder().decode(Agent.self, from: Data(json.utf8))
    }

    func testThePickerRows() throws {
        let workspaces = [
            try agent(#"{"id":"w-orbit","name":"orbit","lastProvider":"claude","runnerId":"r-gpu","enabled":true}"#),
            try agent(#"{"id":"w-wikova","name":"wikova-develop","lastProvider":"codex","runnerId":"r-wikova"}"#),
            try agent(#"{"id":"w-hpc","name":"HPC","lastProvider":"claude"}"#),
            try agent(#"{"id":"w-off","name":"off","runnerId":"r-gpu","enabled":false}"#),
            try agent(#"{"id":"w-new","name":"new","runnerId":"r-new"}"#),
        ]
        let runners = ["r-gpu": "workstation-gpu", "r-wikova": "wikova"]
        let online = ["r-gpu": true, "r-wikova": false]
        let rows = CoordinatorWorkspaceLogic.rows(workspaces, currentWorkspaceID: "w-orbit",
                                                  runnerName: { runners[$0] }, runnerOnline: { online[$0] },
                                                  providerName: names)
        XCTAssertEqual(rows.map(\.detail), ["Claude · workstation-gpu", "Codex · wikova",
                                            "This workspace has no runner.", "This workspace is disabled.", "Claude"])
        XCTAssertEqual(rows.map(\.reason), [nil, nil, "This workspace has no runner.", "This workspace is disabled.", nil])
        XCTAssertEqual(rows.map(\.isCurrent), [true, false, false, false, false])
        XCTAssertEqual(rows.map(\.runnerOffline), [false, true, false, false, false],
                       "a runner whose liveness isn't known yet is not said to be offline")
    }

    /// Mock 03 ⑤: the question, its paragraphs and its buttons, by what is being left behind.
    func testTheStartConfirmation() {
        XCTAssertEqual(StartCoordinatorCopy.title("orbit-prod"), "Start a new coordinator in orbit-prod?")
        XCTAssertEqual(StartCoordinatorCopy.paragraphs(project: "Session list redesign", to: "orbit-prod",
                                                       from: "orbit", outgoing: .open), [
            "The current conversation is completed — a turn in flight finishes first — and stays readable in orbit.",
            "Session list redesign is coordinated from a new, empty conversation in orbit-prod, and its row moves to orbit-prod’s list. Its tasks keep running where they are.",
        ])
        XCTAssertEqual(StartCoordinatorCopy.paragraphs(project: "P", to: "x", from: nil, outgoing: .completed).first,
                       "The current conversation stays completed and readable.")
        XCTAssertEqual(StartCoordinatorCopy.paragraphs(project: "P", to: "x", from: "orbit", outgoing: .none).count, 1)
        XCTAssertEqual(StartCoordinatorCopy.action("orbit-prod", outgoing: .open), "Complete and start in orbit-prod")
        XCTAssertEqual(StartCoordinatorCopy.action("orbit-prod", outgoing: .completed), "Start in orbit-prod")
        XCTAssertEqual(StartCoordinatorCopy.action("orbit-prod", outgoing: .none), "Start in orbit-prod")
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
    }

    // MARK: the web's words

    /// Every sentence above is the web's, in its own files.
    func testTheWordsAreTheWebs() throws {
        let lib = try source("src/web/src/lib/coordinatorWorkspace.ts")
        for literal in ["menuTitle: '\(StartCoordinatorCopy.menuTitle)'",
                        "menuDetail: '\(StartCoordinatorCopy.menuDetail)'",
                        "pickerTitle: '\(StartCoordinatorCopy.pickerTitle)'",
                        "current: '\(StartCoordinatorCopy.current)'",
                        "runnerOffline: '\(StartCoordinatorCopy.runnerOffline)'",
                        "pickerFoot: \"\(StartCoordinatorCopy.pickerFoot)\"",
                        "disabled: '\(StartCoordinatorCopy.disabled)'",
                        "noRunner: '\(StartCoordinatorCopy.noRunner)'",
                        "keep: '\(StartCoordinatorCopy.keep)'",
                        "startNewHere: '\(StartCoordinatorCopy.startNewHere)'",
                        "`Start a new coordinator in ${workspace}?`",
                        "`The current conversation is completed — a turn in flight finishes first — and stays readable${where}.`",
                        "`The current conversation stays completed and readable${where}.`",
                        "`${project} is coordinated from a new, empty conversation in ${to}, and its row moves to ${to}’s list. Its tasks keep running where they are.`",
                        "`Complete and start in ${workspace}` : `Start in ${workspace}`"] {
            XCTAssertTrue(lib.contains(literal), "coordinatorWorkspace.ts no longer says \(literal)")
        }
        let folders = try source("src/web/src/lib/sessionFolders.ts")
        for literal in ["`Coordinator of ${project}`",
                        "coordinatorMoves: '\(SessionMoveCopy.coordinatorMoves)'",
                        "`Move the coordinator to ${target.name}?`",
                        "`${answer.coordinates.title} is coordinated from ${target.name} from now on, and its row moves to ${target.name}’s list. Its tasks keep running where they are.`",
                        "'The session ends first. Until you message it again, Orbit’s updates for the project wait on the project page.'"] {
            XCTAssertTrue(folders.contains(literal), "sessionFolders.ts no longer says \(literal)")
        }
        let modal = try source("src/web/src/components/SessionMoveModal.tsx")
        XCTAssertTrue(modal.contains("` · ${MOVE_COPY.coordinatorOf(coordinates.title)}`"))
        let card = try source("src/web/src/components/ProjectCoordinatorCard.tsx")
        XCTAssertTrue(card.contains(">\n                Move…\n"), "the card's Move…")
    }

    // MARK: the Apple shells

    private func app(_ relative: String) throws -> String {
        try source("src/macos/OrbitApp/Sources/OrbitApp/\(relative)")
    }

    /// The Move panel draws the coordinator's line, its footer, and Start new here…, which asks
    /// Start a new coordinator in <name>? and starts the next coordinator there through the app.
    func testTheMovePanelOffersStartNewHere() throws {
        let sheet = try app("Views/SessionMoveSheet.swift")
        for part in ["SessionMoveCopy.sessionLine(SessionHeader.title(for: session, fallbackAgent: workspace.name),",
                     "SessionWorkspaceMoveLogic.groupFooter(targets)",
                     "if row.startsNew {",
                     "Button(StartCoordinatorCopy.startNewHere) { startingIn = row.target }",
                     ".alert(StartCoordinatorCopy.title(startingIn?.name ?? \"\"), isPresented: confirmingStart,",
                     "Button(StartCoordinatorCopy.action(target.name, outgoing: .open), role: .destructive) {",
                     "Button(StartCoordinatorCopy.keep, role: .cancel) {}",
                     "StartCoordinatorCopy.paragraphs(project: targets?.coordinates?.title ?? \"\",",
                     "await app.startCoordinator(ofProject: projectID, in: target)"] {
            XCTAssertTrue(sheet.contains(part), "SessionMoveSheet lacks `\(part)`")
        }
        let page = try app("Views/SessionMoveTargetPage.swift")
        XCTAssertTrue(page.contains("SessionMoveCopy.confirmTitle(current, answer)"))
        let model = try app("AppModel.swift")
        XCTAssertTrue(model.contains("try await api.replaceProjectCoordinator(projectID, workspaceID: target.workspaceId)"))
        XCTAssertTrue(model.contains("openProjectCoordinator(sessionID: opened.sessionId, agentID: opened.workspaceId ?? target.workspaceId)"))
    }

    /// The coordinator block's menu: Move… (iOS — the Move panel is), Start a new coordinator, and
    /// Start a new coordinator in…, which opens the picker; another workspace asks first.
    func testTheProjectPageOffersMoveAndStartIn() throws {
        let view = try app("Views/ProjectsView.swift")
        let menu = try XCTUnwrap(view.range(of: "Menu {\n                        #if os(iOS)"), "the coordinator menu")
        let tail = String(view[menu.lowerBound...].prefix(1200))
        var last = tail.startIndex
        for part in ["Button(StartCoordinatorCopy.move) { moveCoordinator(session.id) }", "#endif",
                     "Text(ProjectPage.startNewCoordinator)",
                     "Button { pageSheet = .coordinatorWorkspace } label: {",
                     "Text(StartCoordinatorCopy.menuTitle)"] {
            let at = try XCTUnwrap(tail.range(of: part, range: last..<tail.endIndex), "menu lacks `\(part)` in order")
            last = at.upperBound
        }
        for part in ["CoordinatorWorkspaceSheet(projectTitle: document.title,",
                     "guard row.isCurrent else {",
                     ".orbitConfirmation({ StartCoordinatorCopy.title($0.name) },",
                     "Button(StartCoordinatorCopy.action(row.name, outgoing: outgoing), role: .destructive) {",
                     "replaceCoordinator(store, inWorkspace: row.workspaceId)",
                     "Button(StartCoordinatorCopy.keep, role: .cancel) {}",
                     "if status.state == .unavailable || status.state == .trashed {",
                     "SessionMoveSheet(session: session, workspace: workspace,"] {
            XCTAssertTrue(view.contains(part), "ProjectsView lacks `\(part)`")
        }
        let picker = try app("Views/CoordinatorWorkspaceSheet.swift")
        for part in ["CoordinatorWorkspaceLogic.rows(", ".disabled(row.reason != nil)",
                     "Text(StartCoordinatorCopy.current)", "Text(StartCoordinatorCopy.runnerOffline)",
                     "Text(StartCoordinatorCopy.pickerFoot)", ".navigationTitle(StartCoordinatorCopy.pickerTitle)"] {
            XCTAssertTrue(picker.contains(part), "CoordinatorWorkspaceSheet lacks `\(part)`")
        }
        XCTAssertTrue(try app("ProjectsModel.swift").contains(
            "try await api.replaceProjectCoordinator(projectID, workspaceID: workspaceID)"))
    }
}

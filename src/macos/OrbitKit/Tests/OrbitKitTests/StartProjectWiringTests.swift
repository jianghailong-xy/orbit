import Foundation
import XCTest
@testable import OrbitKit

/// The wires between the start card's and the change card's logic and the SwiftUI that draws them.
///
/// `StartProjectTests` and `CriteriaChangeTests` prove what the derivations conclude; they prove
/// nothing about the cards unless the cards are attached to them, and no compiler here checks that
/// — SwiftUI does not exist on Linux, and `ApprovalCards.swift` and `ConsoleModel.swift` are
/// compiled only by the macOS and iOS jobs. So the attachment is asserted over the source, the way
/// `CriteriaDecisionWiringTests` does, each assertion written so that DETACHING the wire is what
/// turns it red. What it cannot see is layout; that is what the screenshots are for.
final class StartProjectWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "the start and change cards are still wired to OrbitKit."
            }
        }
    }

    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"
    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"
    private static let startedPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ProjectStartedCardView.swift"
    private static let tasksPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/CreatedTasksCard.swift"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.missing(relative)
    }

    /// One stretch of a file, so a match somewhere else cannot answer for the part asserted about.
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// The lines of a stretch that are CODE: a call commented out still contains its own words.
    private func code(_ source: String) -> String {
        source.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") && !$0.hasPrefix("///") }
            .joined(separator: " ")
    }

    // MARK: the console — asked on the coordinator's request, and never inferred

    func testTheStartCardIsDeliveredByTheRequestAndNotByTheTaskCount() throws {
        let console = try source(Self.consolePath)
        let refresh = code(try section(console,
                                       from: "func refreshRulerQuestions(force: Bool = false) async {",
                                       to: "\n    /// Whether this project is waiting to be started"))
        XCTAssertTrue(refresh.contains("adoptStartRequest()"),
                      "the read no longer adopts the coordinator's request, so no start card is drawn")
        let adopt = code(try section(console, from: "private func adoptStartRequest() {",
                                     to: "\n    /// Where the start card"))
        XCTAssertTrue(adopt.contains("StartProject.live(openItems: openItems, started: projectStarted)"),
                      "the card is asked on the open START_REQUEST of a project nobody has started")
        XCTAssertTrue(adopt.contains("deliver(.startProject(itemID: live.itemId))"),
                      "and delivered by the request's own item")
        XCTAssertFalse(adopt.contains("projectTaskCount"),
                       "a project holding a task is not a request to start it")
        XCTAssertTrue(console.contains("projectStarted = document.started"),
                      "\"started\" is read off the project's own startedAt")
        XCTAssertFalse(console.contains("projectStarted = document.coordinatorEnabled"),
                       "and not off Automatic, which is how a started project runs")
    }

    func testTheChangeCardIsDeliveredForAStartedProjectWhoseServerSaysWhatMoved() throws {
        let console = try source(Self.consolePath)
        let refresh = code(try section(console,
                                       from: "func refreshRulerQuestions(force: Bool = false) async {",
                                       to: "\n    /// Whether this project is waiting to be started"))
        XCTAssertTrue(refresh.contains("if criteriaChangeHeld { reopenConfirmationForANewVersion() deliver(.criteriaChange) }"),
                      "the change card is delivered on its own condition, and let back in for a new "
                          + "version the way the confirmation card is")
        XCTAssertTrue(console.contains("CriteriaChanges.held(acceptanceConfirmation, projectStatus: projectStatus,"),
                      "and that condition is OrbitKit's")
        XCTAssertTrue(console.contains("closedCards.remove(DeliveredDecisionCard(kind: .criteriaChange).id)"),
                      "a newer version of a started project's criteria asks again after a press here")
    }

    /// The bar counts each card by its own standing, and a card left on screen to explain itself —
    /// a request that no longer stands, a set confirmed at another end — is not pointed at.
    func testTheBarCountsTheTwoCardsByTheirOwnStanding() throws {
        let console = try source(Self.consolePath)
        XCTAssertTrue(console.contains("StartProject.isOpen(startStanding(itemID)), question: true)"))
        XCTAssertTrue(console.contains("CriteriaChanges.isOpen(acceptanceConfirmation), question: true)"))
    }

    // MARK: the presses

    func testStartPostsTheBodyOrbitKitBuildsAndLeavesTheRecordToTheRead() throws {
        let console = try source(Self.consolePath)
        let press = code(try section(console, from: "func startProject(itemID: String) async {",
                                     to: "\n    /// Confirm the criteria a started project moved to"))
        XCTAssertTrue(press.contains("startStanding(itemID) == .live"),
                      "a request that no longer stands is not sent")
        XCTAssertTrue(press.contains("api.startProject(projectID: projectID,"),
                      "the press goes to the start door")
        XCTAssertTrue(press.contains("StartProject.body(request: request, draft: draft,"),
                      "with the body OrbitKit builds from the request and the owner's settings")
        XCTAssertTrue(press.contains("close(.startProject(itemID: itemID))"),
                      "and the answered card gives way")
        XCTAssertTrue(press.contains("await refreshRulerQuestions(force: true)"),
                      "and the re-read that draws the receipt runs on both paths")
        XCTAssertFalse(press.contains("appendDecisionLine"),
                       "the press writes no line of its own: the receipt is the read's")
    }

    func testConfirmingTheNewCriteriaKeepsWhatItConfirmedForTheReceipt() throws {
        let console = try source(Self.consolePath)
        let press = code(try section(console, from: "func confirmCriteriaChange() async {",
                                     to: "\n    // MARK: the project's two owner cards"))
        XCTAssertTrue(press.contains("api.confirmAcceptanceCriteria(projectID: projectID,"),
                      "the same confirmation door, which for a started project only confirms")
        XCTAssertTrue(press.contains("confirmedChangeSummaries[digest] = CriteriaChanges.counts(changes)"),
                      "what the version changed is kept for its receipt, under the seal it signed")
        XCTAssertTrue(press.contains("close(.criteriaChange)"))
    }

    /// The receipt is the newest record, replacing an older one: the start's receipt gives way to
    /// the confirmation of the criteria that came after it.
    func testTheNewestConfirmationReplacesTheReceiptDrawnBeforeIt() throws {
        let console = try source(Self.consolePath)
        let adopt = code(try section(console, from: "private func adoptAcceptanceReceipt() {",
                                     to: "\n    /// Where one delivered proposal stands"))
        XCTAssertTrue(adopt.contains("confirmed != receipt.confirmation else { return }"),
                      "a record already drawn is kept only while it is the newest")
        XCTAssertTrue(adopt.contains("decisionCards.remove(at: drawn)"))
    }

    // MARK: the cards

    func testTheCardsAreDispatchedAndDrawnFromTheirDerivedStanding() throws {
        let file = try source(Self.cardPath)
        let dispatch = try section(file, from: "struct DeliveredDecisionCardView: View",
                                   to: "private struct CriteriaDecisionCard: View")
        XCTAssertTrue(dispatch.contains("case .startProject(let itemID):"))
        XCTAssertTrue(dispatch.contains("StartProjectCardView(console: console, itemID: itemID)"))
        XCTAssertTrue(dispatch.contains("case .criteriaChange:"))
        XCTAssertTrue(dispatch.contains("CriteriaChangeCardView(console: console)"))

        let start = try section(file, from: "private struct StartProjectCardView: View",
                                to: "private struct CriteriaChangeCardView: View")
        XCTAssertTrue(start.contains("let standing = console.startStanding(itemID)"),
                      "the standing is re-derived from the console's reads on every render")
        XCTAssertTrue(start.contains(".approvalChrome(.blue, dimmed: !StartProject.isOpen(standing))"),
                      "the confirmation card's surface, dimmed once its request no longer stands")
        XCTAssertTrue(start.contains(".disabled(starting || standing != .live || !draft.complete)"),
                      "Start is dead unless the request stands and the settings are ones the door "
                          + "takes")
        XCTAssertTrue(start.contains("StartProject.staleExplanation(standing)"),
                      "and a dead Start says why")
        // How it runs: the four settings, each with the platform's own control.
        XCTAssertTrue(start.contains("Menu {"), "Tasks land on is picked from a menu")
        XCTAssertTrue(start.contains("Toggle(isOn: lineBinding(.projectBranch, draft))"))
        XCTAssertTrue(start.contains("Toggle(isOn: lineBinding(.main, draft))"))
        // Each option's second line is what choosing it means, and on iOS 26 a fixed-size menu
        // draws a long second line empty — the card's own first screenshots, 2026-09-30. So the
        // menu is fixed-size on macOS only, where its button would otherwise stretch.
        let lineRow = try section(file, from: "private func lineRow(", to: "private func lineBinding(")
        let lines = lineRow.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        for (at, line) in lines.enumerated() where line == ".fixedSize()" {
            XCTAssertEqual(at > 0 ? lines[at - 1] : "", "#if os(macOS)",
                           "the Tasks land on menu is fixed-size on iOS, which blanks its subtitles")
        }
        XCTAssertTrue(start.contains("Text(RunSettings.automaticHint(draft.line))"),
                      "the Automatic sentence follows the line chosen")
        XCTAssertTrue(start.contains("in: 1...StartProject.maxConcurrentTasks)"),
                      "At most is a stepper bounded where the door bounds it")
        XCTAssertTrue(start.contains("let missing = draft.mergeCheckMissing"),
                      "the merge check row turns amber on the ready check's own rule")
        XCTAssertTrue(start.contains("console.startPlanChangeReply(criteriaDigest: request.criteriaDigest, question: .start)"),
                      "Chat about this talks about the criteria the coordinator asked to start on")
        XCTAssertTrue(start.contains("Text(Approvals.chatAction).approvalActionLabel()"),
                      "in the word the other composer handoffs share")
        XCTAssertTrue(start.contains("console.openCreatedTasks()"),
                      "View tasks opens the list the plan's tasks are in")

        let change = try section(file, from: "private struct CriteriaChangeCardView: View",
                                 to: "private struct StartSectionHead: View")
        XCTAssertTrue(change.contains("CriteriaChanges.rows(changes)"),
                      "the rows are the server's changes, as OrbitKit lays them out")
        XCTAssertTrue(change.contains(".approvalChrome(.blue, dimmed: !CriteriaChanges.isOpen(standing))"))
        XCTAssertTrue(change.contains(".disabled(confirming || !CriteriaChanges.answerable(standing))"))
        XCTAssertTrue(change.contains("console.startPlanChangeReply(standing, question: .criteriaChange)"))
        XCTAssertFalse((start + change).contains("\"Chat"),
                       "a card that spells the shared word itself has stopped sharing it")
    }

    /// The settings line is one view, drawn on the receipt of a start and on the Project started
    /// card, from the record's own settings.
    func testTheSettingsLineIsDrawnOnTheReceiptAndOnTheProjectStartedCard() throws {
        let started = try source(Self.startedPath)
        XCTAssertTrue(started.contains("RunSettingsSummaryText(settings: settings, differs: card.differsFromRequest)"),
                      "the Project started card no longer carries the settings the start recorded")
        let file = try source(Self.cardPath)
        let summary = try section(file, from: "struct RunSettingsSummaryText: View",
                                  to: "\n// MARK: -")
        XCTAssertTrue(summary.contains("RunSettings.parts(settings, differs: differs)"))
        XCTAssertTrue(summary.contains("part.differs ? Text(part.text).bold() : Text(part.text)"),
                      "what the owner changed from the suggestion is marked where it stands")
        XCTAssertTrue(summary.contains(".accessibilityLabel(RunSettings.spokenLine(settings, differs: differs))"),
                      "and said aloud, since bold is not")
        XCTAssertTrue(try source(Self.tasksPath).contains(".onChange(of: console.createdTasksOpenTick)"),
                      "the list View tasks names opens when it is asked to")
    }

    /// The create-project card says, under the criteria, that approving it is not confirming them.
    func testTheCreateProjectCardNotesWhenTheCriteriaAreConfirmed() throws {
        let file = try source(Self.cardPath)
        let block = try section(file, from: "private func criteriaBlock(_ create: CreateApprovalPreview)",
                                to: "var body: some View {")
        XCTAssertTrue(block.contains("if create.isProject {"))
        XCTAssertTrue(block.contains("Text(Approvals.createCriteriaConfirmedAtStart)"))
    }
}

import Foundation
import XCTest
@testable import OrbitKit

/// The wires between the closing cards' logic (`ProjectDone.swift`) and the SwiftUI that draws them.
///
/// `ProjectDoneTests` proves what the derivations conclude; it proves nothing about the cards unless
/// the cards are attached to them, and no compiler here checks that — SwiftUI does not exist on
/// Linux, and `OrbitApp` is compiled only by the macOS and iOS jobs. So the attachment is asserted
/// over the source, the way `StartProjectWiringTests` does, each assertion written so that DETACHING
/// the wire is what turns it red. What it cannot see is layout; that is what the screenshots are for.
final class ProjectDoneWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "the closing cards are still wired to OrbitKit."
            }
        }
    }

    private static let cards = "src/macos/OrbitApp/Sources/OrbitApp/Views/ProjectDoneCards.swift"
    private static let approvals = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"
    private static let console = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"
    private static let consoleView = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift"
    private static let review = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalReview.swift"
    private static let projects = "src/macos/OrbitApp/Sources/OrbitApp/Views/ProjectsView.swift"
    private static let projectsModel = "src/macos/OrbitApp/Sources/OrbitApp/ProjectsModel.swift"

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

    // MARK: the conversation

    /// The console reads the projection and the record off the document it already reads, adopts
    /// the slot after the open items, and delivers one card at a time.
    func testTheCoordinatorConversationAdoptsOneClosingCardFromItsReads() throws {
        let console = try source(Self.console)
        let refresh = code(try section(console, from: "func refreshRulerQuestions(force: Bool = false) async {",
                                       to: "private func adoptStartRequest() {"))
        XCTAssertTrue(refresh.contains("projectDone = document.doneSubject"),
                      "the closing cards are drawn from the project document the console reads")
        XCTAssertTrue(refresh.contains("adoptDoneSlot()"), "the slot is adopted from the reads")
        let adopt = code(try section(console, from: "private func adoptDoneSlot() {",
                                     to: "private func donePlacement("))
        XCTAssertTrue(adopt.contains("ProjectDone.live(openItems: openItems, status: projectDone?.status)"))
        XCTAssertTrue(adopt.contains("ProjectDone.slot(subject: projectDone, request: live, waitingKind: sessionWaitingKind,"))
        XCTAssertTrue(adopt.contains("case .none: break"), "a read that has not answered changes nothing on screen")
        XCTAssertTrue(adopt.contains("decisionCards.removeAll { $0.kind == .projectDone } deliver(.projectNotDone)"),
                      "why it is not done replaces the done card")
        XCTAssertTrue(adopt.contains("decisionCards.removeAll { $0.kind == .projectNotDone } deliver(.projectDone, placement: donePlacement(live))"),
                      "the done card replaces why it is not done")
        // A read asked for after a press here that still says the project is not DONE retires the
        // press's record: the project was reopened, and the card asks again (`ProjectDone.recorded`).
        XCTAssertTrue(refresh.contains("let documentAskedAt = Date() if let document = try? await api.projectCriteria(projectID: projectID) {"))
        XCTAssertTrue(refresh.contains("if document.status != \"DONE\", let at = doneRecordAt, documentAskedAt > at { doneRecord = nil doneRecordAt = nil }"),
                      "a reopened project keeps no receipt from an earlier press")
        XCTAssertTrue(console.contains("sessionWaitingKind = session.waitingKind"),
                      "Record as done… on the row puts the card up without a request")
        // Counted by the needs-you bar only while it asks.
        let below = code(try section(console, from: "var openBelowRows: [BelowRow] {",
                                     to: "var waitingBelow: WaitingBelow? {"))
        XCTAssertTrue(below.contains("case .projectDone: return waiting(doneCardAsking, question: true)"))
        XCTAssertTrue(below.contains("case .projectNotDone: return nil"))
    }

    /// Each press goes to its own door, with what the card shows.
    func testThePressesGoToTheOwnersDoors() throws {
        let console = try source(Self.console)
        let record = code(try section(console, from: "func recordProjectDone() async {",
                                      to: "func declineDoneRequest(note: String) async -> Bool {"))
        XCTAssertTrue(record.contains("ProjectDone.body(subject: subject, requestID: doneRequestRow?.itemId,"))
        XCTAssertTrue(record.contains("currentDigest: acceptanceConfirmation?.currentVersion.digest)"),
                      "unasked, the press names the seal standing now")
        XCTAssertTrue(record.contains("doneRecord = try await api.recordProjectDone(projectID: projectID, body) doneRecordAt = Date()"),
                      "the card turns into its receipt from the record the door wrote, and notes when")
        XCTAssertTrue(record.contains("statusMessage = \"\\(ProjectDone.notRecorded) — "))
        let decline = code(try section(console, from: "func declineDoneRequest(note: String) async -> Bool {",
                                       to: "func reopenProject() async {"))
        XCTAssertTrue(decline.contains("api.declineDoneRequest(projectID: projectID, itemID: row.itemId, note: note)"))
        let reopen = code(try section(console, from: "func reopenProject() async {",
                                      to: "func askCoordinatorAboutDone() async {"))
        XCTAssertTrue(reopen.contains("api.updateProjectStatus(projectID, to: .open) doneRecord = nil doneRecordAt = nil"))
        let ask = code(try section(console, from: "func askCoordinatorAboutDone() async {", to: "\n    }\n"))
        XCTAssertTrue(ask.contains("await send(overrideText: ProjectDone.settlementContext(subject))"),
                      "Ask the coordinator sends the card's own facts as one turn")
    }

    /// The transcript draws each kind, and both whole where they arrived: the done card is the
    /// question and then its receipt, in the conversation itself (mock ⑤ ①–③, the browser's inline
    /// `ProjectDoneCard`) — not a preview that opens a review, which is what it was before
    /// (evidence revision 1's first gap).
    func testTheTranscriptDrawsBothCardsWholeWhereTheyArrived() throws {
        let approvals = try source(Self.approvals)
        let dispatch = code(try section(approvals, from: "struct DeliveredDecisionCardView: View {",
                                        to: ".environment(\\.approvalReviewTarget, .delivered(card))"))
        XCTAssertTrue(dispatch.contains("case .projectDone: ProjectDoneCardView(console: console)"))
        XCTAssertTrue(dispatch.contains("case .projectNotDone: ProjectNotDoneCardView(console: console)"))
        let card = code(try section(approvals, from: "private struct ProjectDoneCardView: View {",
                                    to: "private struct ProjectNotDoneCardView: View {"))
        XCTAssertTrue(card.contains("request: row?.doneRequest,"))
        XCTAssertTrue(card.contains("onRecord: { await console.recordProjectDone() },"))
        XCTAssertTrue(card.contains("onNotYet: row == nil ? nil : { await console.declineDoneRequest(note: $0) },"),
                      "Not yet… is offered only on a card the coordinator asked for")
        XCTAssertTrue(card.contains("onReopen: { await console.reopenProject() })"))
        XCTAssertTrue(card.contains("openItems: ProjectDone.openItemsCount(console.openItems),"),
                      "Orbit checked counts the open-items read the card is drawn beside")
        XCTAssertTrue(card.contains(".environment(\\.approvalReviewTarget, nil)"),
                      "with no review target the card takes ApprovalReviewLayout's whole-card path")
        let notDone = code(try section(approvals, from: "private struct ProjectNotDoneCardView: View {",
                                       to: "/// The start card itself"))
        XCTAssertTrue(notDone.contains("onAskCoordinator: { Task { await console.askCoordinatorAboutDone() } })"))

        // The whole-card path is the layout's own, and the review is opened only for a target.
        let layout = code(try section(try source(Self.review), from: "struct ApprovalReviewLayout<",
                                      to: "struct ApprovalReviewSheet: View {"))
        XCTAssertTrue(layout.contains("} else if let target {"), "a preview needs a review target")
        XCTAssertTrue(layout.contains("ApprovalHeader(symbol: symbol, title: title, tone: tone, badge: badge) content actions"),
                      "without one the card is drawn whole: header, content, actions")

        let view = try source(Self.consoleView)
        let route = code(try section(view, from: "private func openReview(for row: TranscriptRow) {",
                                     to: "default:"))
        XCTAssertFalse(route.contains(".projectDone"),
                       "the needs-you bar scrolls to the done card; there is no review to open")
        XCTAssertFalse(route.contains(".projectNotDone"), "why it is not done is drawn whole, inline")
    }

    /// The card itself: the question in the review layout, the receipt once recorded, and the
    /// numbers, words and gaps all OrbitKit's.
    func testTheCardsDrawOrbitKitsWordsAndNumbers() throws {
        let cards = try source(Self.cards)
        let done = code(try section(cards, from: "struct ProjectDoneCard: View {",
                                    to: "struct ProjectDoneGapList: View {"))
        XCTAssertTrue(done.contains("if ProjectDone.recorded(subject, record: record) {"))
        XCTAssertTrue(done.contains("ApprovalReviewLayout(title: ProjectDone.heading,"))
        for call in ["ProjectDone.meta(projectTitle: subject.title, asked: request != nil, waiting: waiting)",
                     "return ProjectDone.requestWaiting(askedAt)",
                     "Text(request.judgment)", "ProjectDone.doneWhenHead(count)",
                     "Text(ProjectDone.cardTally(counts))", "ProjectDoneGapList(subject: subject, gaps: gaps)",
                     "ProjectDone.orbitCheckedLine(counts: counts, confirmedAt: confirmedAt,",
                     "Text(ProjectDone.recordingExplanation)", "Text(ProjectDone.recordLabel(counts))",
                     "Text(ProjectDone.notYet)", "TextField(ProjectDone.missingBeforeDone, text: $note, axis: .vertical)",
                     "Text(ProjectDone.notYetHint)", "Text(ProjectDone.sendToCoordinator)", "Text(ProjectDone.back)",
                     "if request != nil, onNotYet != nil { notYetButton }",
                     "ProjectDone.declineNote(note)"] {
            XCTAssertTrue(done.contains(call), "the done card no longer draws \(call)")
        }
        let receipt = code(try section(cards, from: "struct ProjectDoneReceiptCard: View {",
                                       to: "struct ProjectNotDoneCard: View {"))
        for call in ["title: ProjectDone.thisProjectIsDone", "ProjectDone.receiptMeta(subject, record: record)",
                     "ProjectDone.receiptLine(subject, record: record)", "ProjectDone.receiptTally(subject, record: record)",
                     "ProjectDone.seeWhatAccepted", "Text(ProjectDone.reopenProject)"] {
            XCTAssertTrue(receipt.contains(call), "the receipt no longer draws \(call)")
        }
        let why = code(try section(cards, from: "struct ProjectNotDoneCard: View {",
                                   to: "struct ProjectDoneRequestRow: View {"))
        for call in ["ProjectDone.WhyNotDone(subject: subject, withCoordinator: withCoordinator,",
                     "title: ProjectDone.whyHeading", "group(ProjectDone.waitingOnWork, why.waiting, waiting: true,",
                     "group(ProjectDone.needsYourCall, why.needsCall, waiting: false,",
                     "Text(ProjectDone.whyNotDoneTally(subject.counts))",
                     "Text(ProjectDone.rowState(criterion))",
                     "Text(ProjectDone.rowDetail(criterion, waitingOnWork: waiting))",
                     "ProjectDone.askedAside(waiting: ProjectDone.requestWaiting($0))",
                     "Text(ProjectDone.reviewDoneRequest)", "Text(ProjectDone.askCoordinator)",
                     "if why.saysCoordinatorIsOnIt {", "badge: ProjectDone.settledBadge(subject.doneBy))"] {
            XCTAssertTrue(why.contains(call), "the Why-not-done card no longer draws \(call)")
        }
    }

    // MARK: the project page and the list

    /// Open items lead with the closing row; Review and Record as done… open the same card over the
    /// page; the menu's Record as done does too on a current server; the header and the list say who
    /// recorded a done project, and Ready to close while the coordinator asks.
    func testTheProjectPageAndTheListCarryTheClosingRows() throws {
        let page = try source(Self.projects)
        let items = code(try section(page, from: "private func openItemsSection(",
                                     to: "private func startItem("))
        XCTAssertTrue(items.contains("ProjectDone.pageRow(status: document.status, derivedDone: document.derivedDone,"))
        XCTAssertTrue(items.contains("if let done { doneItem(done, store: store, now: now) }"))
        XCTAssertTrue(items.contains("store.openItems.map(ProjectPage.needsYouRows)"),
                      "the request is not drawn twice should a server list it among the owner's rows")
        let row = code(try section(page, from: "private func doneItem(", to: "private func reviewStart("))
        XCTAssertTrue(row.contains("ProjectDoneRequestRow(row: row, now: now, busy: store.busy) { pageSheet = .done }"))
        XCTAssertTrue(row.contains("ProjectOwnDoneRow(busy: store.busy) { pageSheet = .done }"))
        let sheets = code(try section(page, from: ".sheet(item: $pageSheet) { sheet in", to: "case .mergeCheck:"))
        XCTAssertTrue(sheets.contains("case .done: ProjectDoneSheet(store: store)"))
        let sheet = code(try section(page, from: "private struct ProjectDoneSheet: View {",
                                     to: "/// The merge check, where a command has room"))
        for call in ["ProjectDone.live(openItems: store.openItems, status: document.status.rawValue)",
                     "ProjectDoneCard(", "await store.loadDoneCard()",
                     "ProjectDone.body(subject: subject, requestID: row?.itemId,",
                     "openItems: ProjectDone.openItemsCount(store.openItems),",
                     "switch await store.recordDone(body) {",
                     "store.declineDone(itemID: row.itemId, note: note)", "store.setStatus(.open)"] {
            XCTAssertTrue(sheet.contains(call), "the card over the page no longer \(call)")
        }
        let menu = code(try section(page, from: "private func menu(", to: "Label(\"Record as cancelled\""))
        XCTAssertTrue(menu.contains("if document.derivedDone?.counts != nil { pageSheet = .done } else { confirmingStatus = .done }"),
                      "Record as done opens the owner's door on a current server and keeps the old one on an older")
        let header = code(try section(page, from: "private func header(", to: "// MARK: open items"))
        XCTAssertTrue(header.contains("if ProjectDone.readyToClose(status: document.status, openItems: store.openItems) {"))
        XCTAssertTrue(header.contains("Text(ProjectDone.readyToClose)"))
        XCTAssertTrue(header.contains("Text(ProjectDone.provenance(doneBy: document.doneBy,"))
        let list = code(try section(page, from: "struct ProjectRow: View {", to: "private var meterSegments:"))
        XCTAssertTrue(list.contains("if let provenance = project.doneProvenance { Text(provenance)"),
                      "a done project's row says who recorded it")

        let model = try source(Self.projectsModel)
        let record = code(try section(model, from: "func recordDone(", to: "func declineDone("))
        XCTAssertTrue(record.contains("try await api.recordProjectDone(projectID: projectID, body)"))
        XCTAssertTrue(code(try section(model, from: "func declineDone(", to: "func delete()"))
            .contains("api.declineDoneRequest(projectID: self.projectID, itemID: itemID, note: note)"))
    }

    /// The two rows a project page draws, in OrbitKit's words.
    func testThePageRowsSayOrbitKitsWords() throws {
        let cards = try source(Self.cards)
        let asked = code(try section(cards, from: "struct ProjectDoneRequestRow: View {",
                                     to: "struct ProjectOwnDoneRow: View {"))
        for call in ["Text(ProjectDone.readyToClose)", "Text(ProjectDone.heading)",
                     "Text(ProjectDone.requestRowDetail(row))",
                     "Text(\"\\(ProjectPage.who(row)) · \\(ProjectPage.waitingLabel(row, now: now))\")",
                     "Text(ProjectPage.actionLabel(.review) ?? \"\")"] {
            XCTAssertTrue(asked.contains(call), "the request's row no longer draws \(call)")
        }
        let own = code(try section(cards, from: "struct ProjectOwnDoneRow: View {", to: "// MARK: - the pieces"))
        XCTAssertTrue(own.contains("Text(ProjectDone.recordAsDoneRow) .font(.orbitSubtext.weight(.semibold)) .foregroundStyle(.secondary)"),
                      "nobody asked: the owner's own row is a grey hint, title and dot alike")
        XCTAssertTrue(own.contains("Text(ProjectDone.notAskedYet)"))
    }
}

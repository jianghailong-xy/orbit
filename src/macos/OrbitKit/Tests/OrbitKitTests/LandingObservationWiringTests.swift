import Foundation
import XCTest

/// THE APP'S HALF OF CONTRACT REVISION 29 (R29-11): the SwiftUI and console code that draws what
/// `LandingObservationTests` decides. OrbitApp does not compile on Linux, so the wires are read as
/// source — each check on its own stretch of a file, so a match elsewhere cannot answer for it.
final class LandingObservationWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found. If it was renamed, rename it here too — that is what "
                    + "this check is for."
            }
        }
    }

    private static let cards = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"
    private static let panel = "src/macos/OrbitApp/Sources/OrbitApp/Views/ObserveAgainPanel.swift"
    private static let console = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"
    private static let projects = "src/macos/OrbitApp/Sources/OrbitApp/Views/ProjectsView.swift"
    private static let api = "src/macos/OrbitKit/Sources/OrbitKit/Net/APIClient.swift"

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

    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    private func card() throws -> String {
        try section(try source(Self.cards), from: "private struct OwnerItemCardView: View",
                    to: "/// The one merge a person is asked to confirm")
    }

    // MARK: the card

    /// Accept and Observe again are drawn where the server listed them, each through the console,
    /// which owns the credential; Observe again asks for its reason first.
    func testTheTwoDoorsArePressesOnTheCard() throws {
        let card = try card()
        let presses = try section(card, from: "private func makePress(", to: "/// The Accept press:")
        XCTAssertTrue(presses.contains("case .accept:") && presses.contains("return { accept(row) }"),
                      "Accept is a press on the card")
        XCTAssertTrue(presses.contains("guard ExceptionCards.addressed(row, .accept) else { return nil }"))
        XCTAssertTrue(presses.contains("case .observe:") && presses.contains("observing = true"),
                      "Observe again opens its question rather than writing")
        let accept = try section(card, from: "private func accept(_ row: ProjectOpenItemRow) {",
                                 to: "/// The Abandon press")
        XCTAssertTrue(accept.contains("if await console.acceptItem(row) { receipt = ExceptionCards.accepted }"),
                      "the receipt only once the door took it")
        XCTAssertTrue(accept.contains("guard !sending else { return }"))
        XCTAssertTrue(card.contains("ObserveAgainPanel(console: console, sending: $sending) { observing = false }"),
                      "the question is the panel, drawn on the card")
    }

    /// A door is a row — its press beside its line of consequence on the Mac — and the rows stack, one
    /// per line, as the browser's door grid does. Side by side on the Mac, the third door the work not
    /// seen on its line brings (Observe again) left the window's layout unable to settle, and AppKit
    /// ended the app (probe run 40808934994).
    func testTheCardsDoorsStackOnePerLine() throws {
        let card = try card()
        XCTAssertTrue(card.contains("ApprovalActions(stacked: true) {"), "the card's doors stack")
        let stack = try section(try source(Self.cards), from: "struct ApprovalActions<Content: View>: View {",
                                to: "/// Answer an approval.")
        XCTAssertTrue(stack.contains("if stacked {\n            VStack(alignment: .leading, spacing: 8) { content() }"),
                      "stacked is a column on the Mac too")
        XCTAssertTrue(stack.contains("HStack(spacing: 8) { content() }"), "and every other card keeps its row")
    }

    /// The fifth kind wears its own word and the merge's mark; the handling rows follow the facts.
    func testTheCardSaysWhatItIsAndWhatIsHandlingIt() throws {
        let card = try card()
        XCTAssertTrue(card.contains("title: ExceptionCards.title(shownKind, isPause: isPause),"),
                      "the header is the model's word for the kind")
        XCTAssertTrue(card.contains(": shownKind == .landedWithoutConfirmation ? \"arrow.triangle.merge\""),
                      "with the merge's mark, as the banner and Android draw it")
        XCTAssertTrue(card.contains(".onChange(of: standing, initial: true) { _, now in"),
                      "and keeps it once the item has gone")
        let body = try section(card, from: "factBlock(row)\n", to: "if askingToHandle { markHandledPanel() }")
        XCTAssertTrue(body.contains("handlingBlock(row)"), "the handling rows come right after the facts")
        let block = try section(card, from: "@ViewBuilder private func handlingBlock(",
                                to: "/// One row of the fact block")
        XCTAssertTrue(block.contains("ExceptionCards.handlingRows("))
        XCTAssertTrue(block.contains("main: console.projectDone?.main ?? RunSettings.defaultMainBranch)"),
                      "an observation names the project's main branch, from the console's read")
        XCTAssertTrue(block.contains("factRow(fact)"), "in the fact block's own row shape")
    }

    /// The question asks what the browser's dialog asks, holds the door's line — a blank reason is no
    /// press, and the field stops at the ceiling — and keeps the words until the door took them.
    func testObserveAgainsQuestionHoldsTheDoorsOwnLine() throws {
        let panel = try source(Self.panel)
        XCTAssertTrue(panel.contains("Text(ExceptionCards.observeTitle)") && panel.contains("Text(ExceptionCards.observeBody)"))
        XCTAssertTrue(panel.contains("TextField(ExceptionCards.observeReason, text: $reason, axis: .vertical)"))
        XCTAssertTrue(panel.contains("ExceptionCards.observeMaxLength"))
        XCTAssertTrue(panel.contains(".disabled(sending || ExceptionCards.observeRequest(reason) == nil)"))
        XCTAssertTrue(panel.contains("Text(ExceptionCards.observeAgain).approvalActionLabel()"))
        let submit = try section(panel, from: "private func observe() {", to: "\n    }\n")
        XCTAssertTrue(submit.contains("guard !sending, ExceptionCards.observeRequest(reason) != nil else { return }"))
        let took = try XCTUnwrap(submit.range(of: "if await console.observeIntegration(reason: reason) {"))
        let cleared = try XCTUnwrap(submit.range(of: "reason = \"\""))
        XCTAssertLessThan(took.lowerBound, cleared.lowerBound, "the draft is cleared only where the door took it")
    }

    // MARK: the console and the doors

    /// The two presses' doors: the item's own Accept, the project's observation with the trimmed
    /// reason — each re-reading what the card is drawn from, and saying a refusal in the browser's
    /// own headline over the server's words.
    func testTheConsoleSendsBothPressesToTheirDoors() throws {
        let console = try source(Self.console)
        let accept = try section(console, from: "func acceptItem(_ row: ProjectOpenItemRow) async -> Bool {",
                                 to: "func observeIntegration(reason: String)")
        XCTAssertTrue(accept.contains("try await api.acceptOpenItem(projectID: projectID, itemID: row.itemId)"))
        XCTAssertTrue(accept.contains("await refreshRulerQuestions(force: true)"))
        XCTAssertTrue(accept.contains("statusMessage = \"\\(ExceptionCards.notAccepted) — \\(APIClient.failureReason(error)).\""))
        let observe = try section(console, from: "func observeIntegration(reason: String) async -> Bool {",
                                  to: "/// The merge candidate whose card this conversation has delivered")
        XCTAssertTrue(observe.contains("let request = ExceptionCards.observeRequest(reason) else { return false }"),
                      "the console holds the same line as the field")
        XCTAssertTrue(observe.contains("try await api.observeIntegration(projectID: projectID, request)"))
        XCTAssertTrue(observe.contains("await refreshRulerQuestions(force: true)"))
        XCTAssertTrue(observe.contains("statusMessage = \"\\(ExceptionCards.notObserved) — \\(APIClient.failureReason(error)).\""))

        let api = try source(Self.api)
        XCTAssertTrue(api.contains("try await postRaw(\"projects/\\(projectID)/open-items/\\(itemID)/accept\", body: Optional<Empty>.none)"),
                      "Accept is `POST /projects/:id/open-items/:itemId/accept`, with no body")
        XCTAssertTrue(api.contains("try await postRaw(\"projects/\\(projectID)/integration/observe\", body: req)"),
                      "Observe again is `POST /projects/:id/integration/observe` { reason }")
    }

    /// A press that names the fifth kind — the banner's, a row's, the project page's — lands on its
    /// card, which is drawn on the escalation card's row (`ExceptionCards.cards`).
    func testThePressOnTheFifthKindLandsOnItsCard() throws {
        let press = try section(try source(Self.console),
                                from: "private func rowID(forOwnerItem item: SessionOwnerItem) -> String? {",
                                to: "/// Where one delivered question stands")
        let arm = try section(press, from: "case .landedWithoutConfirmation:", to: "case .fusePaused:")
        XCTAssertTrue(arm.contains("DeliveredDecisionCard(kind: .escalatedItem(itemID: item.itemId)).id"))
    }

    // MARK: How it runs and the project page

    /// Delivery sits between Main branch and Automatic, as on the web; it is drawn only for a server
    /// that reads it, offers the agent's way only where the line allows, and writes at once.
    func testHowItRunsDrawsTheDelivery() throws {
        let view = try source(Self.projects)
        let block = try section(view, from: "private func runSettingsSection(", to: "private func lineSetting(")
        let order = ["mainBranchSetting(", "deliverySetting(", "automaticSetting("].map { block.range(of: $0)?.lowerBound }
        XCTAssertFalse(order.contains(nil))
        XCTAssertEqual(order.compactMap { $0 }, order.compactMap { $0 }.sorted())
        let delivery = try section(view, from: "private func deliverySetting(", to: "/// Automatic, moved here")
        XCTAssertTrue(delivery.contains("if RunSettings.deliveryShown(view) {"))
        XCTAssertTrue(delivery.contains("ForEach(RunSettings.deliveryChoices(line: view.line, main: main))"))
        XCTAssertTrue(delivery.contains("chosen: choice.mode == current)"))
        XCTAssertTrue(delivery.contains("notice = await store.updateIntegration(RunSettings.deliveryWrite(view, to: choice.mode))"))
        XCTAssertTrue(delivery.contains(".disabled(store.busy || !choice.offered)"),
                      "drawn but not offered where the line does not allow it")
        let line = try section(view, from: "private func lineSetting(", to: "private func lineOption(")
        XCTAssertTrue(line.contains("hint: RunSettings.lineMainHint(view, main: main))"),
                      "Directly into main's hint follows the delivery")
        let automatic = try section(view, from: "private func automaticSetting(", to: "private func atMostSetting(")
        XCTAssertTrue(automatic.contains("Text(RunSettings.automaticHint(view,"), "and so does Automatic's")
    }

    /// The project page's Open items row says what is handling it, as the web's row does.
    func testTheOpenItemsRowSaysWhatIsHandlingIt() throws {
        let row = try section(try source(Self.projects),
                              from: "private func openItem(_ row: ProjectOpenItemRow, store: ProjectDetailModel, now: Date)",
                              to: "private func perform(")
        XCTAssertTrue(row.contains("if let handling = row.handling {"))
        XCTAssertTrue(row.contains("Text(ExceptionCards.handlingLabel)"))
        XCTAssertTrue(row.contains("ExceptionCards.handlingLine("))
    }
}

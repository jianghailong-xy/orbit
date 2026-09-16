import Foundation
import XCTest
@testable import OrbitKit

/// The wires between the two cards' logic and the SwiftUI that draws them.
///
/// `CriteriaDecisionTests` proves what the derivation concludes; it proves nothing about the card
/// unless the card is attached to it, and no compiler here checks that — SwiftUI does not exist on
/// Linux and `ApprovalCards.swift` is compiled only by the macOS and iOS jobs. So the attachment is
/// asserted over the source, the same way `EvidenceDecisionWiringTests` does, and each assertion is
/// written so that DETACHING the wire is what turns it red.
///
/// The one it exists for is this project's stated criterion: a card that cannot be answered must
/// arrive DISABLED rather than lit-and-refused, and it must be disabled by the SERVER's derived
/// standing rather than by anything the card remembered. What it cannot see is layout — that is
/// what the beta and the screenshots are for.
final class CriteriaDecisionWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "the ruler cards are still wired to OrbitKit."
            }
        }
    }

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

    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"
    private static let bannerPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/NeedsYouBannerView.swift"
    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"
    private static let consoleViewPath =
        "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift"

    /// One card's own section of the file, so a match 900 lines away cannot answer for it — a bare
    /// `contains` over a whole file is how a scan like this goes falsely green.
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from), let end = source.range(of: to) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    private func weakeningCard() throws -> String {
        try section(try source(Self.cardPath),
                    from: "private struct CriteriaDecisionCard: View",
                    to: "private struct AcceptanceConfirmationCard: View")
    }

    private func confirmationCard() throws -> String {
        let file = try source(Self.cardPath)
        guard let start = file.range(of: "private struct AcceptanceConfirmationCard: View") else {
            throw WiringError.missing("AcceptanceConfirmationCard")
        }
        return String(file[start.lowerBound...])
    }

    private func receiptCard() throws -> String {
        try section(try source(Self.cardPath),
                    from: "private struct CriteriaDecisionReceiptView: View",
                    to: "private struct CriteriaDecisionCard: View")
    }

    // MARK: the rule this project stated

    func testBothActionsOnTheWeakeningCardAreDisabledByTheDerivedStanding() throws {
        let card = try weakeningCard()
        // Two buttons, and both gated on the same server-derived fact. Deleting either modifier —
        // or swapping `standing.answerable` for a local flag — is what turns this red.
        XCTAssertEqual(card.components(separatedBy: ".disabled(deciding || !standing.answerable)").count - 1,
                       2,
                       "Approve & re-seal and Refuse must BOTH be disabled while the standing says "
                           + "the door would refuse them: a lit button that is refused every time "
                           + "it is pressed is the bug this rule was written for")
        XCTAssertTrue(card.contains("guard let row = standing.row, standing.answerable"),
                      "and the press itself re-checks, so a race between render and tap cannot "
                          + "send a decision the standing says is dead")
    }

    func testTheWeakeningCardDerivesItsStandingOnEveryRenderAndKeepsNoCopy() throws {
        let card = try weakeningCard()
        XCTAssertTrue(card.contains("console.criteriaStanding(intentID)"),
                      "the standing is re-derived from the console's read, not stored in @State")
        XCTAssertFalse(card.contains("@State private var standing"),
                       "a frozen frame is the one thing this card may not keep")
        XCTAssertTrue(card.contains("CriteriaDecisions.staleExplanation(standing)"),
                      "and a disabled card says which refusal it would meet")
    }

    func testTheConfirmationCardIsGatedByTheServersThreeStates() throws {
        let card = try confirmationCard()
        XCTAssertTrue(card.contains(".disabled(confirming || !AcceptanceConfirmations.answerable(standing))"),
                      "confirming is offered exactly while the server says the set is unconfirmed "
                          + "or stale — never for a set already confirmed, and never when the "
                          + "standing could not be read at all")
        XCTAssertTrue(card.contains("AcceptanceConfirmations.checks(standing)"),
                      "and the body is the server's standing rather than a sentence composed here")
    }

    /// Dimmed whole, by OrbitKit's rule, in one place. Unhooking either card from its rule — or
    /// dimming by `answerable`, which would darken an unread card — is what turns this red.
    func testBothCardsAreDimmedWholeByTheirOpenRuleAndOnlyByTheChrome() throws {
        let weakening = try weakeningCard()
        let confirmation = try confirmationCard()
        XCTAssertTrue(weakening.contains(".approvalChrome(.orange, dimmed: CriteriaDecisions.isDimmed(standing))"),
                      "a stale weakening card is dimmed by the derived standing it is drawn from")
        XCTAssertTrue(confirmation.contains(".approvalChrome(.blue, dimmed: AcceptanceConfirmations.isDimmed(standing))"),
                      "and so is a confirmation already given at another end")
        XCTAssertFalse((weakening + confirmation).contains("0.72"),
                       "the chrome applies the opacity; a second one inside a card would multiply")
        XCTAssertTrue(try source(Self.cardPath).contains(".opacity(dimmed ? 0.72 : 1)"),
                      "the chrome is where the whole card is dimmed")
    }

    func testTheProvenanceRidesTheMetaLineAndTheBadgeCarriesTheState() throws {
        let card = try weakeningCard()
        XCTAssertTrue(card.contains("badge: CriteriaDecisions.badge(standing)"),
                      "the badge slot says which of the five states this card is in")
        XCTAssertTrue(card.contains("Text(CriteriaDecisions.meta(standing))"),
                      "and the provenance is on the meta line — the badge is what truncates, and "
                          + "`FROM ORBIT` arriving as `FR…IT` says nothing at all")
        XCTAssertFalse(card.contains("badge: CriteriaDecisions.provenanceLabel"),
                       "which is exactly the wiring this test exists to prevent coming back")
    }

    /// THE LINE UNDER THE TITLE IS OrbitKit'S HEADING, ON EVERY CARD THAT CANNOT BE ANSWERED.
    ///
    /// That line is where "Refused at another end" reaches a phone: on 2026-09-11 a refused card
    /// arrived dimmed, with a badge and nothing that said which answer it had been given. So the
    /// heading is drawn from the derived standing, exactly while the buttons are dead — detaching
    /// it, or gating it on anything else, is what turns this red.
    func testTheVerdictUnderTheTitleIsTheDerivedHeadingOnEveryCardThatCannotBeAnswered() throws {
        let card = try weakeningCard()
        guard let gate = card.range(of: "if !standing.answerable {") else {
            return XCTFail("the line under the title is no longer drawn for a card nobody can answer")
        }
        let drawn = card[gate.upperBound...].prefix(while: { $0 != "}" })
        XCTAssertTrue(drawn.contains("Text(CriteriaDecisions.heading(standing))"),
                      "the verdict is OrbitKit's heading for the derived standing — the words that "
                          + "name an answer given at another end")
    }

    /// A REWRITE IS DRAWN AS ONE MERGED LINE, FROM THE SERVER'S CUT.
    ///
    /// The thing this catches is the layout coming back: two paragraphs per rewrite is what put
    /// 483px of content in a 360px scroll box, and the way it would return is the view reading
    /// `entry.onRecord.text` again instead of the runs OrbitKit hands it. Nothing on Linux compiles
    /// this view, so the wire is asserted over its source.
    func testARewriteIsDrawnFromTheServersCutAsOneLine() throws {
        let card = try weakeningCard()
        XCTAssertTrue(card.contains("rewritten(change.words)"),
                      "the row's words are the server's cut, drawn as one run of text")
        XCTAssertTrue(card.contains("Text(run.text).strikethrough()"),
                      "what the rewrite drops is struck through IN PLACE rather than repeated "
                          + "underneath — the strikethrough is the mark, and it survives a "
                          + "monochrome screen where a red would not")
        XCTAssertTrue(card.contains("Text(run.text).underline()"),
                      "and what it adds is underlined, for the same reason")
        XCTAssertTrue(card.contains("CriteriaDecisions.inlineDiffLegend"),
                      "with the one line that says what those two marks mean")
        XCTAssertFalse(card.contains("CriteriaDecisions.hasRewrite(row.diff) ? \"\""),
                       "the legend is offered where there is a rewrite to read, not unconditionally")
    }

    // MARK: the bar, and the cards it points at

    func testTheBarPointsDownIntoThisConversationWhenItHoldsAQuestion() throws {
        let banner = try source(Self.bannerPath)
        XCTAssertTrue(banner.contains("if let below {"),
                      "the in-conversation question is what the bar says when there is one")
        XCTAssertTrue(banner.contains("chevron: \"chevron.down\""),
                      "and it points down, not away: the destination is in this transcript")
        XCTAssertTrue(banner.contains("onOpenBelow?(below.rowID)"),
                      "a press scrolls to the card rather than navigating anywhere")
    }

    func testTheBarCountsOpenQuestionsRatherThanCardsOnScreen() throws {
        let console = try source(Self.consolePath)
        XCTAssertTrue(console.contains("CriteriaDecisions.isOpen(criteriaStanding(intentID))"),
                      "a card that went stale stays on screen to explain itself, and stops being "
                          + "counted: pointing somebody at a dead card and calling it an open "
                          + "question is worse than saying nothing")
        XCTAssertTrue(console.contains("AcceptanceConfirmations.isOpen(acceptanceConfirmation)"),
                      "and the confirmation is counted by the same rule, from the same place")
        XCTAssertFalse(console.contains("var openQuestionRowIDs: [String] { decisionCards.map(\\.id) }"),
                       "counting every delivered card is exactly the version this replaced")
    }

    func testTheConsoleOnlyAsksAboutARulerItCoordinates() throws {
        let console = try source(Self.consolePath)
        XCTAssertTrue(console.contains("guard !isDraft, let projectID, !loadingRuler else { return }"),
                      "a session with no project makes neither read")
        XCTAssertTrue(console.contains("if projectID != nil { Task { [weak self] in await self?.refreshRulerQuestions() } }"),
                      "and one with a project reads them when its context loads — a card cannot "
                          + "drive the first read, because the read is what creates the card")
    }

    // MARK: the receipt, and the card that gives way to it

    /// THE RECORD OF AN ANSWER IS DRAWN FROM THE READ, NOT FROM THE WINDOW THAT PRESSED.
    ///
    /// The bug this exists for: a card's question leaves the pending read the moment it is answered,
    /// so a receipt the console remembered lived exactly as long as the console did. The account
    /// owner's report, 2026-09-16: a decision that was gone from the conversation after the app was
    /// reopened. Every link below is load-bearing — the receipts come off the criteria read, the
    /// card that read has an answer for gives way, and the row builder is handed the derived list
    /// rather than the stored cards.
    func testTheReceiptsComeOffTheReadAndTheCardsTheyAnswerForGiveWay() throws {
        let console = try source(Self.consolePath)
        XCTAssertTrue(console.contains("CriteriaDecisions.settledIntentIDs(criteriaDecisions)"),
                      "the cards that give way are the ones the READ names an answer for")
        XCTAssertTrue(console.contains("CriteriaDecisions.receiptCards(queue: criteriaDecisions"),
                      "and the receipts are derived from that same read on every render — delivered "
                          + "like a card instead, they would die with the window")
        XCTAssertTrue(try source(Self.consoleViewPath)
                        .contains("decisionCards: console.drawnDecisionCards"),
                      "the row builder is handed the derived list; handing it `decisionCards` is "
                          + "the version that draws a card beside the receipt for its own answer")
    }

    /// The receipt is a card the console draws AND a card the view dispatches, derived from the
    /// standing the read publishes rather than from anything a press left behind. A receipt with a
    /// button, or one keeping its own copy of the answer, is what this catches — nothing on Linux
    /// compiles that view.
    func testTheReceiptIsDispatchedAndDerivesItsAnswerFromTheRead() throws {
        let file = try source(Self.cardPath)
        XCTAssertTrue(file.contains("case .criteriaReceipt(let intentID):"),
                      "the delivered card dispatches by kind")
        XCTAssertTrue(file.contains("CriteriaDecisionReceiptView(console: console, intentID: intentID)"),
                      "and a receipt is drawn as a receipt — not as the card that asked the question")
        let receipt = try receiptCard()
        XCTAssertTrue(receipt.contains("console.criteriaStanding(intentID)"),
                      "the answer is re-derived from the read, never a frame kept here")
        XCTAssertFalse(receipt.contains("@State"),
                       "a receipt keeps nothing: a copy of the answer is the thing that died with "
                           + "the window this whole change is about")
        XCTAssertTrue(receipt.contains("CriteriaDecisions.recordedHeading"), "the record's heading")
        XCTAssertTrue(receipt.contains("CriteriaDecisions.recordedVerdict(answer)"),
                      "and the line saying which way it went and when")
        XCTAssertTrue(receipt.contains("CriteriaDecisions.meta(standing)"),
                      "with the provenance mark: a transcript is where an agent's words appear, and "
                          + "\u{201C}✓ Approved by you\u{201D} is a sentence an agent can type")
        XCTAssertFalse(receipt.contains(".disabled("),
                       "there is nothing on a receipt to press — the answer IS the card")
    }

    /// AND THE PRESS WRITES NOTHING OF ITS OWN. The line it used to append was the record — in that
    /// window only, which is precisely the bug: gone after a relaunch, and a decision that vanishes
    /// from the conversation it was made in is a decision nobody can go back and check.
    func testThePressLeavesNoRecordThatLivesOnlyInThisWindow() throws {
        let press = try section(try source(Self.consolePath),
                                from: "func decideCriteria(",
                                to: "func evidenceStanding(")
        XCTAssertFalse(press.contains("appendDecisionLine"),
                       "the press leaves the record to the read: a line written here is state in "
                           + "the console that pressed, and outlives nothing")
        XCTAssertTrue(press.contains("await refreshRulerQuestions(force: true)"),
                      "and it re-reads at once, because that read is what draws the receipt")
    }
}

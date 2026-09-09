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
}

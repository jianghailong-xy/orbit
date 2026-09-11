import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words about the settlement confirmation, and this is the tripwire
/// that keeps them saying them.
///
/// The browser drew the question on a project page only, while this client already drew it into
/// the coordinator conversation; since 2026-09-11 the browser draws it there too, as
/// `AcceptanceConfirmationCard.tsx`, with its sentences copied out of `AcceptanceConfirmations` by
/// hand. Nothing in a build catches a sentence re-worded at one end only — the Swift client and the
/// browser bundle share no compiler — so the check is a test that reads the other end's source.
///
/// Shaped after `CriteriaDecisionCopyParityTests` and `EvidenceDecisionCopyParityTests`, including the
/// part that matters most: a missing counterpart is a FAILURE and never an `XCTSkip`. A check that
/// quietly opts out reports green on exactly the day the thing it watches goes missing.
///
/// Every sentence is compared whole: a line with a count or a seal in it is rendered here with
/// sentinel values, which are then put back as the web template's own interpolations. One thing is
/// NOT compared, deliberately: the browser card's `FROM ORBIT` badge and its tooltip, which that
/// end draws in the card's head the way its other two Orbit cards do. This end has no badge on this
/// card, and its provenance rides the meta line — which both ends print, and which is compared.
final class AcceptanceConfirmationCopyParityTests: XCTestCase {

    private static let webCard = "src/web/src/components/AcceptanceConfirmationCard.tsx"
    private static let nativeCard = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"
    private static let console = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"

    /// Sentinels that cannot occur inside each other or inside any sentence: a count with no digit
    /// the copy uses, and two seals made of letters only.
    private static let count = 23
    private static let current = "deadbeefcafe" + String(repeating: "d", count: 52)
    private static let prior = "facadebeaded" + String(repeating: "f", count: 52)

    /// The repo root, found by walking up from this file until the web card is under foot.
    /// Not a fixed number of `..` hops: the depth of this file is not the thing being asserted.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(
                atPath: dir.appendingPathComponent(Self.webCard).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`, for the reason in the type's note above.
        throw ParityError.noRepo
    }

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        var description: String {
            switch self {
            case .noRepo:
                return "\(AcceptanceConfirmationCopyParityTests.webCard) was not found above this "
                    + "test file. OrbitKit's settlement confirmation is one half of a pair; if the web "
                    + "half moved, move this check with it rather than deleting it."
            case .missing(let relative):
                return "\(relative) was not found. The native card keeps two of its words outside "
                    + "OrbitKit; if it moved, move this check with it rather than deleting it."
            }
        }
    }

    private func source(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ParityError.missing(relative)
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// The web card's source with its string literals put back together.
    ///
    /// TypeScript wraps a long sentence as `'…' + '…'` or as template literals across lines, and
    /// where that wrap falls is a formatting decision while the words are the contract. So adjacent
    /// literals are joined whichever quotes they use, and a value sitting on the line under its `=`
    /// is pulled up.
    private func flatWebCard() throws -> String {
        try source(Self.webCard)
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*'", with: "= '", options: .regularExpression)
    }

    /// The other end declares this constant with exactly these words.
    private func assertDeclares(_ web: String, _ name: String, _ value: String, _ what: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(web.contains("\(name) = '\(value)'"),
                      "\(what) drifted: the web card no longer declares "
                          + "\(name) as \(value.debugDescription)",
                      file: file, line: line)
    }

    /// The other end writes this sentence as one template literal, interpolations and all.
    private func assertTemplate(_ web: String, _ rendered: String, _ values: [(String, String)],
                                _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let template = values.reduce(rendered) { text, pair in
            text.replacingOccurrences(of: pair.0, with: pair.1)
        }
        XCTAssertTrue(web.contains("`\(template)`"),
                      "\(what) drifted: the web card no longer contains `\(template)`",
                      file: file, line: line)
    }

    private func standing(_ state: StandardSetConfirmationStanding.State,
                          namingPrior: Bool = true) -> StandardSetConfirmationStanding {
        let material = (0..<Self.count).map {
            ConfirmedCriterionVersion(definitionId: "d\($0)", revision: 1, contentHash: "h\($0)")
        }
        let recorded = RecordedStandardSetConfirmation(
            criteriaDigest: state == .confirmed ? Self.current : Self.prior,
            criteriaMaterial: material,
            confirmedAt: "2026-09-11T03:00:00.000Z", confirmedById: "u1")
        return StandardSetConfirmationStanding(
            state: state,
            confirmed: state == .confirmed,
            currentVersion: StandardSetVersion(digest: Self.current, material: material),
            confirmation: state == .unconfirmed || !namingPrior ? nil : recorded)
    }

    private var count: String { "\(Self.count)" }
    private var currentSeal: String { CriteriaDecisions.shortSeal(Self.current) }
    private var priorSeal: String { CriteriaDecisions.shortSeal(Self.prior) }

    // MARK: the words on the card

    func testTheTitleAndTheActionsMatchTheWebCard() throws {
        let web = try flatWebCard()

        assertDeclares(web, "ACCEPTANCE_CONFIRMATION_TITLE", AcceptanceConfirmations.title,
                       "the card's title")
        assertDeclares(web, "ACCEPTANCE_CONFIRM_LABEL", AcceptanceConfirmations.confirmLabel,
                       "the confirm action")
        assertDeclares(web, "ACCEPTANCE_NOT_YET_LABEL", AcceptanceConfirmations.notYetLabel,
                       "the action that puts the question down")
        // Both forms: English is the only thing that makes them two, and the end that changed one
        // and not the other would say "Read the 1 criteria".
        assertTemplate(web, AcceptanceConfirmations.readLabel(count: Self.count),
                       [(count, "${count}")], "the reading toggle for several criteria")
        assertTemplate(web, AcceptanceConfirmations.readLabel(count: 1),
                       [("1", "${count}")], "the reading toggle for one criterion")
    }

    /// The line that says who is asking, about which version, and what is held on the answer — and
    /// the one it says instead when the standing could not be read.
    func testTheMetaLineMatchesTheWebCardWhole() throws {
        let web = try flatWebCard()

        assertDeclares(web, "ACCEPTANCE_PROVENANCE", CriteriaDecisions.provenanceLabel,
                       "the provenance the meta line opens with")
        assertTemplate(web, AcceptanceConfirmations.meta(standing(.unconfirmed)),
                       [(CriteriaDecisions.provenanceLabel, "${ACCEPTANCE_PROVENANCE}"),
                        (currentSeal, "${seal}"), (count, "${count}")],
                       "the meta line")
        assertTemplate(web, AcceptanceConfirmations.meta(nil),
                       [(CriteriaDecisions.provenanceLabel, "${ACCEPTANCE_PROVENANCE}")],
                       "the meta line of a standing that could not be read")
    }

    /// What holds and what does not, in each of the server's three states.
    func testTheBodyLinesMatchTheWebCardInEachState() throws {
        let web = try flatWebCard()

        let open = AcceptanceConfirmations.checks(standing(.unconfirmed))
        XCTAssertEqual(open.count, 2)
        assertTemplate(web, open[0].text, [(count, "${count}")],
                       "the line saying nobody has confirmed the set")
        assertTemplate(web, open[1].text, [(count, "${count}")],
                       "the line saying DONE waits on the answer")

        let staleBare = AcceptanceConfirmations.checks(standing(.stale, namingPrior: false))
        assertDeclares(web, "CONFIRMATION_CHANGED_SINCE", staleBare[0].text,
                       "the line saying the confirmation no longer stands")
        let staleNamed = AcceptanceConfirmations.checks(standing(.stale))
        assertTemplate(web, staleNamed[0].text,
                       [(staleBare[0].text, "${CONFIRMATION_CHANGED_SINCE}"),
                        (priorSeal, "${shortSeal(prior.criteriaDigest)}")],
                       "the seal a stale confirmation named")

        let confirmed = AcceptanceConfirmations.checks(standing(.confirmed))
        XCTAssertEqual(confirmed.count, 2)
        assertTemplate(web, confirmed[0].text, [(count, "${count}")],
                       "the line saying the set was confirmed")
        assertDeclares(web, "CONFIRMATION_EDIT_ENDS_IT", confirmed[1].text,
                       "the line saying an edit ends the confirmation")
    }

    /// The two explanations over a dead button: they are the sentences a reader acts on when the
    /// card will not take a confirmation.
    func testTheStaleExplanationsMatchTheWebCardWordForWord() throws {
        let web = try flatWebCard()

        assertDeclares(web, "CONFIRMATION_UNREAD_EXPLANATION",
                       AcceptanceConfirmations.staleExplanation(nil) ?? "",
                       "why a card that could not be re-read offers nothing")
        assertTemplate(web, AcceptanceConfirmations.staleExplanation(standing(.confirmed)) ?? "",
                       [(currentSeal, "${seal}")],
                       "why a card confirmed at another end offers nothing")
    }

    func testTheLineAConfirmationLeavesMatchesTheWebCard() throws {
        let web = try flatWebCard()

        assertTemplate(web, AcceptanceConfirmations.confirmedLine(standing(.confirmed)),
                       [(currentSeal, "${seal}"), (count, "${count}")],
                       "the line a confirmation leaves where it was pressed")
    }

    // MARK: the two words the native card keeps outside OrbitKit

    /// The reading toggle once it is open, and what a refused press says: written into the SwiftUI
    /// card and the console rather than into `AcceptanceConfirmations`, and on both cards all the same.
    func testTheTwoWordsKeptOutsideOrbitKitMatchTheWebCard() throws {
        let web = try flatWebCard()
        let card = try source(Self.nativeCard)
        let console = try source(Self.console)

        XCTAssertTrue(card.contains("\"Hide the criteria\""),
                      "the native card no longer calls its open reading toggle \"Hide the criteria\"")
        assertDeclares(web, "ACCEPTANCE_HIDE_CRITERIA_LABEL", "Hide the criteria",
                       "the open reading toggle")
        XCTAssertTrue(console.contains("\"That confirmation was not recorded — \\(error)\""),
                      "the native console no longer says \"That confirmation was not recorded\"")
        assertDeclares(web, "CONFIRMATION_NOT_RECORDED", "That confirmation was not recorded",
                       "what a refused confirmation says")
    }
}

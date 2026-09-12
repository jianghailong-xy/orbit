import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words about one weakening proposal, and this is the tripwire that
/// keeps them saying them.
///
/// `CriteriaDecision.swift` copied its visible strings out of `CriteriaDecisionCard.tsx` by hand,
/// the way `EvidenceDecisions` copies `EvidenceDecisionCard`'s. Until that web file landed on main
/// there was nothing here to compare against and the copy was on trust; it has landed, so the trust
/// becomes a check. Nothing in a build catches a heading re-worded at one end only — the Swift
/// client and the browser bundle share no compiler — so the check has to be a test that reads the
/// other end's source and compares the strings.
///
/// Shaped after `EvidenceDecisionCopyParityTests`, including the part that matters most: a missing
/// counterpart is a FAILURE and never an `XCTSkip`. A check that quietly opts out reports green on
/// exactly the day the thing it watches goes missing.
///
/// Not everything on the card is here, and deliberately: the title, the badge and the spelling of
/// the provenance mark differ by end for reasons the file header gives (a phone card header is one
/// line beside a badge). What is asserted is the copy that is meant to be the SAME sentence.
final class CriteriaDecisionCopyParityTests: XCTestCase {

    private static let webCard = "src/web/src/components/CriteriaDecisionCard.tsx"

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
        var description: String {
            "\(CriteriaDecisionCopyParityTests.webCard) was not found above this test file. "
                + "OrbitKit's weakening card is one half of a pair; if the web half moved, move "
                + "this check with it rather than deleting it."
        }
    }

    /// The web card's source with its string literals put back together.
    ///
    /// TypeScript wraps a long sentence as `'…' + '…'` — or, when a seal is spliced into it, as
    /// backtick templates joined the same way — across lines, and where that wrap falls is a
    /// formatting decision while the words are the contract. So adjacent literals are joined
    /// whichever quotes they use, and a value sitting on the line under its `=` is pulled up — which
    /// lets every assertion below name the declaration it is about rather than guess at the wrapping.
    private func flatWebCard() throws -> String {
        let source = try String(contentsOf: try repoRoot().appendingPathComponent(Self.webCard),
                                encoding: .utf8)
        return source
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*'", with: "= '", options: .regularExpression)
    }

    /// The other end declares this constant with exactly these words.
    ///
    /// Anchored on the declaration and not on the sentence alone: `Refuse` appears in prose on both
    /// ends, and a check a comment can satisfy is not a check.
    private func assertDeclares(_ web: String, _ name: String, _ value: String, _ what: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(web.contains("\(name) = '\(value)'"),
                      "\(what) drifted: the web card no longer declares "
                          + "\(name) as \(value.debugDescription)",
                      file: file, line: line)
    }

    /// The one string the web end writes inline, with no name to anchor on: matched as the literal.
    private func assertLiteral(_ web: String, _ value: String, _ what: String,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(web.contains("'\(value)'"),
                      "\(what) drifted: the web card no longer contains \(value.debugDescription)",
                      file: file, line: line)
    }

    /// A sentence the web end composes around interpolations, matched as the template it writes.
    private func assertContains(_ web: String, _ needle: String, _ what: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(web.contains(needle),
                      "\(what) drifted: the web card no longer contains \(needle.debugDescription)",
                      file: file, line: line)
    }

    /// This end's sentence, with the values it was rendered from put back as the web template's own
    /// interpolations — so the whole sentence is compared, and not only the words around a seal.
    private func template(_ rendered: String, _ values: [(String, String)]) -> String {
        values.reduce(rendered) { line, pair in
            line.replacingOccurrences(of: pair.0, with: pair.1)
        }
    }

    // MARK: the words on the card

    /// The heading in each of the three states, and the two answers.
    func testTheHeadingsAndActionsMatchTheWebCard() throws {
        let web = try flatWebCard()

        assertDeclares(web, "CRITERIA_DECISION_HEADING", CriteriaDecisions.liveHeading,
                       "the heading of a live card")
        assertDeclares(web, "CRITERIA_DECISION_STALE_HEADING", CriteriaDecisions.staleHeading,
                       "the heading of a card that can no longer be answered")
        assertDeclares(web, "CRITERIA_DECISION_UNREAD_HEADING", CriteriaDecisions.unreadHeading,
                       "the heading of a card that could not be re-read")
        assertDeclares(web, "CRITERIA_DECISION_REFUSED_HEADING", CriteriaDecisions.refusedHeading,
                       "the heading of a card refused at another end")
        assertDeclares(web, "CRITERIA_DECISION_APPROVED_HEADING", CriteriaDecisions.approvedHeading,
                       "the heading of a card approved at another end")
        assertDeclares(web, "APPROVE_LABEL", CriteriaDecisions.approveLabel, "the approve action")
        assertDeclares(web, "REFUSE_LABEL", CriteriaDecisions.refuseLabel, "the refuse action")
    }

    /// The two paragraphs, which are the ones a reader actually acts on — what refusing does NOT
    /// stop, and why a stale card shows nothing.
    func testTheTwoParagraphsMatchWordForWord() throws {
        let web = try flatWebCard()

        assertDeclares(web, "NOTHING_IS_ON_HOLD", CriteriaDecisions.nothingIsOnHold,
                       "the line saying what is not at stake")
        assertLiteral(web, CriteriaDecisions.goneBody, "the body of a stale card")
    }

    /// What a card answered at another end says about the answer — the sentence the account owner
    /// could not find on a dimmed card on 2026-09-11 — compared whole.
    ///
    /// Rendered here from sentinel seals and put back as the web template's own interpolations, so a
    /// word changed anywhere in it is a red, not only one beside a seal. The sentinels are letters
    /// only and neither contains the other, so replacing one cannot touch the other or the code.
    func testWhatACardAnsweredAtAnotherEndSaysMatchesWordForWord() throws {
        let web = try flatWebCard()
        let base = "deadbeefcafedeadbeefcafe"
        let resulting = "facadebeadedfacadebeaded"
        func said(_ decision: CriteriaDecisionAnswer) -> String {
            let read = PendingCriteriaDecisionQueue(
                readAt: "2026-09-11T15:41:00.000Z", projectId: "p", count: 0, decidableCount: 0,
                pending: [],
                settled: [SettledCriteriaDecision(
                    intentId: "i", decision: decision, decidedAt: "2026-09-11T15:40:00.000Z",
                    baseSeal: base, resultingSeal: decision == .approve ? resulting : base)])
            return CriteriaDecisions.staleExplanation(
                CriteriaDecisions.standing(queue: read, intentId: "i")) ?? ""
        }
        let interpolations = [
            (CriteriaDecisions.alreadySettledRefusal, "${CRITERIA_DECISION_ALREADY_SETTLED}"),
            (CriteriaDecisions.shortSeal(base), "${shortSeal(settled.baseSeal)}"),
            (CriteriaDecisions.shortSeal(resulting), "${shortSeal(settled.resultingSeal)}"),
        ]
        assertContains(web, "`\(template(said(.reject), interpolations))`",
                       "what a card refused at another end says")
        assertContains(web, "`\(template(said(.approve), interpolations))`",
                       "what a card approved at another end says")
    }

    // MARK: the words the diff is said in

    /// The vocabulary for what a proposal does to a criterion.
    ///
    /// This is the half the two ends are most likely to drift on, because it is said three times on
    /// each card — as the badge on a row, as the word the summary counts in, and in the line over
    /// the fold — and a client that re-worded only the badge would go on counting in the old word.
    func testTheDiffVocabularyMatchesTheWebCard() throws {
        let web = try flatWebCard()

        assertDeclares(web, "CRITERION_REWORDED_WORD", CriteriaDecisions.rewordedWord,
                       "the word a rewrite is counted in")
        assertDeclares(web, "CRITERION_DROPPED_WORD", CriteriaDecisions.droppedWord,
                       "the word a removal is counted in")
        assertDeclares(web, "CRITERION_ADDED_WORD", CriteriaDecisions.addedWord,
                       "the word an addition is counted in")
        assertDeclares(web, "CRITERION_REWORDED_LABEL", CriteriaDecisions.rewordedLabel,
                       "the badge on a rewritten criterion")
        assertDeclares(web, "CRITERION_ADDED_LABEL", CriteriaDecisions.addedLabel,
                       "the badge on a criterion being added")
        assertDeclares(web, "CRITERION_DROPPED_LABEL", CriteriaDecisions.droppedLabel,
                       "the badge on a criterion being dropped")
        assertDeclares(web, "METHOD_LABEL", CriteriaDecisions.methodLabel,
                       "what a rewritten procedure is labelled")
    }

    /// What the two marks on a rewritten line mean.
    ///
    /// It replaced `on record now`, which is the label the two versions used to be told apart by
    /// when they were two paragraphs. A rewrite is one line now, and this legend is the ONLY thing
    /// on either card that says what a strikethrough means — so an end that re-words it while the
    /// other does not leaves one set of readers guessing at a mark nothing explains.
    func testTheLegendForTheTwoMarksMatchesTheWebCard() throws {
        let web = try flatWebCard()

        assertDeclares(web, "INLINE_DIFF_LEGEND", CriteriaDecisions.inlineDiffLegend,
                       "the legend for the strikethrough and the underline")
    }

    /// The line that says how much of the ruler is being left alone, and the two it can be missing.
    ///
    /// It is the sentence the whole fold rests on: a reader shown three rows and no count cannot
    /// tell a proposal that reworded three criteria from one that replaced the set with three. Both
    /// halves are compared because English is the only thing that makes them two constants — the
    /// end that changed one and not the other would say "5 criterion".
    func testTheLineOverTheFoldMatchesTheWebCard() throws {
        let web = try flatWebCard()

        assertDeclares(web, "UNCHANGED_SUFFIX_ONE", CriteriaDecisions.unchangedSuffixOne,
                       "the fold's line for a single untouched criterion")
        assertDeclares(web, "UNCHANGED_SUFFIX_MANY", CriteriaDecisions.unchangedSuffixMany,
                       "the fold's line for several")
        assertDeclares(web, "CHANGE_SUMMARY_UNREADABLE", CriteriaDecisions.changeSummaryUnreadable,
                       "what a proposal nothing could be read out of says")
        assertDeclares(web, "CHANGE_SUMMARY_NOTHING_MOVES",
                       CriteriaDecisions.changeSummaryNothingMoves,
                       "what a restatement that moved nothing says")
    }

    // MARK: what the card reports the door said

    /// A card names the refusal it would meet in the door's own spelling. If one end re-spells a
    /// code, that end stops recognising the refusal the server sends and says nothing about it.
    func testTheRefusalCodesAreSpelledTheSameOnBothEnds() throws {
        let web = try flatWebCard()

        assertDeclares(web, "CRITERIA_DECISION_BASE_SEAL_MOVED",
                       CriteriaDecisions.baseSealMovedRefusal, "the base-seal-moved refusal")
        assertDeclares(web, "CRITERIA_DECISION_ALREADY_SETTLED",
                       CriteriaDecisions.alreadySettledRefusal, "the already-settled refusal")
    }
}

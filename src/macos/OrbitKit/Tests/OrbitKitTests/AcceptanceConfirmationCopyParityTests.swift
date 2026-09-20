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
/// Every sentence is compared whole: a line with a title, a count or a seal in it is rendered here
/// with sentinel values, which are then put back as the web template's own interpolations. One
/// thing is NOT compared, deliberately: the browser card's `FROM ORBIT` badge and its tooltip,
/// which that end draws in the card's head the way its other two Orbit cards do. This end has no
/// badge on this card, and nothing else about the card differs.
///
/// The second action's word is compared next door and on purpose: both ends take it from the one
/// constant three other controls already use (`Approvals.chatAction` here,
/// `OWNER_SEND_BACK_ACTION` there, pinned by `OwnerConfirmationCopyParityTests`). What is asserted
/// here is only that this card still reaches for that shared word rather than declaring a fourth
/// name for the same thing.
final class AcceptanceConfirmationCopyParityTests: XCTestCase {

    private static let webCard = "src/web/src/components/AcceptanceConfirmationCard.tsx"
    private static let console = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"

    /// Sentinels that cannot occur inside each other or inside any sentence: a count with no digit
    /// the copy uses, two seals made of letters only, and a project title made of neither.
    private static let count = 23
    private static let current = "deadbeefcafe" + String(repeating: "d", count: 52)
    private static let prior = "facadebeaded" + String(repeating: "f", count: 52)
    private static let project = "Aurora"

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
                return "\(relative) was not found. The native card keeps one of its words outside "
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

    private func standing(_ state: StandardSetConfirmationStanding.State)
        -> StandardSetConfirmationStanding {
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
            confirmation: state == .unconfirmed ? nil : recorded)
    }

    /// The confirmation the standing of that state has on record. Every recorded sentence is about
    /// this row — the count and the seal somebody signed — so the fixture builds it once here.
    private func recorded(_ state: StandardSetConfirmationStanding.State)
        -> RecordedStandardSetConfirmation {
        standing(state).confirmation!
    }

    private var count: String { "\(Self.count)" }
    private var currentSeal: String { CriteriaDecisions.shortSeal(Self.current) }
    private var priorSeal: String { CriteriaDecisions.shortSeal(Self.prior) }

    // MARK: the words on the card

    func testTheTitleAndTheActionsMatchTheWebCard() throws {
        let web = try flatWebCard()

        assertDeclares(web, "ACCEPTANCE_CONFIRMATION_TITLE", AcceptanceConfirmations.title,
                       "the card's title")
        assertDeclares(web, "ACCEPTANCE_START_LABEL", AcceptanceConfirmations.startLabel,
                       "the action that starts the project")
        assertDeclares(web, "ACCEPTANCE_SHOW_LESS_LABEL", AcceptanceConfirmations.showLessLabel,
                       "the reading toggle once the criteria are open")
        assertTemplate(web, AcceptanceConfirmations.readLabel(count: Self.count),
                       [(count, "${count}")], "the reading toggle")

        // The second action, at both ends, is the word three other controls already use. A card
        // that declared its own would be the fourth name for one thing.
        XCTAssertTrue(web.contains("{OWNER_SEND_BACK_ACTION}"),
                      "the web card no longer takes its second action's word from the constant the "
                          + "other composer handoffs share (`Approvals.chatAction` at this end)")
        XCTAssertEqual(OwnerConfirmations.sendBackAction, Approvals.chatAction,
                       "and that constant is the one this end's card reaches for")
    }

    /// The line that says which project, how many conditions, where the project stands, where its
    /// confirmation stands and which version — and the one it says instead when the standing could
    /// not be read.
    func testTheMetaLineMatchesTheWebCardWhole() throws {
        let web = try flatWebCard()

        // Where the PROJECT stands, off `coordinatorEnabled` — three words, because a read that did
        // not answer is neither of the other two.
        assertDeclares(web, "ACCEPTANCE_NOT_STARTED", AcceptanceConfirmations.notStarted,
                       "where a project nobody has started stands")
        assertDeclares(web, "ACCEPTANCE_STARTED", AcceptanceConfirmations.started,
                       "where a project that is handing work out stands")
        assertDeclares(web, "ACCEPTANCE_START_NOT_READ", AcceptanceConfirmations.startNotRead,
                       "what the line says when the project itself could not be read")
        // And where the CONFIRMATION stands, off the standing. The second field exists because the
        // first stopped answering both: an unconfirmed project may well have been started.
        assertDeclares(web, "ACCEPTANCE_CONFIRMED", AcceptanceConfirmations.confirmed,
                       "a set somebody has confirmed")
        assertDeclares(web, "ACCEPTANCE_CHANGED_SINCE_CONFIRMED",
                       AcceptanceConfirmations.changedSinceConfirmed,
                       "a set whose criteria moved under the confirmation")
        assertDeclares(web, "ACCEPTANCE_NOBODY_SAID_DONE",
                       AcceptanceConfirmations.nobodySaidDone,
                       "a set nobody has ever confirmed")
        // The count, then where the project stands, then where the confirmation does, then the
        // seal: order is the copy here, not just the words.
        assertTemplate(web, AcceptanceConfirmations.meta(standing(.unconfirmed), started: false,
                                                        projectTitle: Self.project),
                       [(Self.project, "${projectTitle}"), (count, "${count}"),
                        (AcceptanceConfirmations.notStarted, "${stands}"),
                        (AcceptanceConfirmations.nobodySaidDone, "${asked}"),
                        (currentSeal, "${shortSeal(standing.currentVersion.digest)}")],
                       "the meta line")
        assertTemplate(web, AcceptanceConfirmations.meta(nil, started: nil,
                                                         projectTitle: Self.project),
                       [(Self.project, "${projectTitle}")],
                       "the meta line of a standing that could not be read")
    }

    /// The one paragraph the card keeps: what starting binds the project to, and what ends it.
    func testTheParagraphAboutStartingMatchesTheWebCard() throws {
        let web = try flatWebCard()

        assertDeclares(web, "CONFIRMATION_CHANGED_SINCE", AcceptanceConfirmations.changedSince,
                       "the sentence saying a confirmation no longer stands")
        assertDeclares(web, "CONFIRMATION_EDIT_ENDS_IT", AcceptanceConfirmations.editEndsIt,
                       "the sentence saying an edit ends the confirmation")

        // The middle, which the browser writes as one template with those two round it: the tail is
        // taken off here so what is compared is the sentence and not the seam.
        let whole = AcceptanceConfirmations.startExplanation(count: Self.count,
                                                            standing: standing(.unconfirmed))
        XCTAssertTrue(whole.hasSuffix(AcceptanceConfirmations.editEndsIt), whole)
        let middle = String(whole.dropLast(AcceptanceConfirmations.editEndsIt.count))
        assertTemplate(web, "AGAIN" + middle, [("AGAIN", "${again}"), (count, "${count}")],
                       "what starting binds the project to")

        // And a second asking opens by saying why, with the space that separates the two sentences.
        XCTAssertTrue(
            AcceptanceConfirmations.startExplanation(count: Self.count, standing: standing(.stale))
                .hasPrefix(AcceptanceConfirmations.changedSince + " "),
            "a stale standing must open by saying why it is being asked again")
        XCTAssertTrue(web.contains("`${CONFIRMATION_CHANGED_SINCE} `"),
                      "the web card no longer opens a stale card with that sentence, or has lost "
                          + "the space that keeps it from running into the next one")
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

    /// The line a confirmation records: the count and the seal of the version that was SIGNED —
    /// which is the point of reading it off the record and not off the standing, so it is asserted
    /// on a confirmation whose set has since moved.
    func testTheLineAConfirmationLeavesMatchesTheWebCard() throws {
        let web = try flatWebCard()

        assertTemplate(web, AcceptanceConfirmations.confirmedLine(recorded(.confirmed)),
                       [(currentSeal, "${seal}"), (count, "${count}")],
                       "the line a confirmation leaves where it was pressed")
        let superseded = AcceptanceConfirmations.confirmedLine(recorded(.stale))
        XCTAssertTrue(superseded.contains(priorSeal), superseded)
        XCTAssertFalse(superseded.contains(currentSeal),
                       "the record must name the version somebody signed, not the one standing now")
        assertTemplate(web, superseded, [(priorSeal, "${seal}"), (count, "${count}")],
                       "the same line for a confirmation the criteria have since moved under")
    }

    /// The record itself: what it is headed, and the stamp under it saying who signed it and when.
    func testTheReceiptAConfirmationLeavesMatchesTheWebCard() throws {
        let web = try flatWebCard()

        assertDeclares(web, "ACCEPTANCE_RECEIPT_HEADING", AcceptanceConfirmations.receiptHeading,
                       "what the record of a confirmation is headed")
        // Both ends point at this row by id from elsewhere, so the id is one vocabulary: the row the
        // native transcript draws carries exactly what the web element declares.
        assertDeclares(web, "ACCEPTANCE_RECEIPT_ID",
                       DeliveredDecisionCard(
                           kind: .acceptanceConfirmationReceipt(confirmed: recorded(.confirmed))).id,
                       "the id of the row a confirmation's record is drawn in")
        // The time is passed in here and formatted there, for `OwnerConfirmations.receiptLine`'s
        // reason: a clock is the platform's business and not a contract between the two ends.
        assertTemplate(web, AcceptanceConfirmations.receiptStamp("08:00"),
                       [("08:00", "${receiptClock(confirmation.confirmedAt)}")],
                       "who signed it, and when")
    }

    /// A project that is already handing work out is not a project this card can start, and the two
    /// sentences it says to one are the web card's: the action is a confirmation rather than a
    /// start, and the paragraph is in that project's own tense.
    func testTheWordsForAProjectAlreadyRunningMatchTheWebCard() throws {
        let web = try flatWebCard()

        assertDeclares(web, "ACCEPTANCE_CONFIRM_LABEL", AcceptanceConfirmations.confirmLabel,
                       "the action that re-confirms a project already running")
        XCTAssertEqual(AcceptanceConfirmations.actionLabel(started: true),
                       AcceptanceConfirmations.confirmLabel,
                       "a started project must not be offered a start")
        XCTAssertEqual(AcceptanceConfirmations.actionLabel(started: false),
                       AcceptanceConfirmations.startLabel,
                       "and one that is not running is, exactly as before")
        XCTAssertEqual(AcceptanceConfirmations.actionLabel(started: nil),
                       AcceptanceConfirmations.startLabel,
                       "a project nobody has read keeps the card's own word rather than a guess")

        // The paragraph, in that project's tense — the same seam the not-started one is compared
        // at, so what is compared is the sentence and not the way the line is wrapped.
        let whole = AcceptanceConfirmations.startExplanation(count: Self.count,
                                                            standing: standing(.stale),
                                                            started: true)
        XCTAssertTrue(whole.hasPrefix(AcceptanceConfirmations.changedSince + " "), whole)
        XCTAssertTrue(whole.hasSuffix(AcceptanceConfirmations.editEndsIt), whole)
        let again = AcceptanceConfirmations.changedSince + " "
        let middle = String(String(whole.dropFirst(again.count))
            .dropLast(AcceptanceConfirmations.editEndsIt.count))
        XCTAssertFalse(middle.contains("Once this starts"),
                       "a project already running was told when this starts")
        assertTemplate(web, "AGAIN" + middle, [("AGAIN", "${again}"), (count, "${count}")],
                       "what confirming binds a project already running to")
    }

    // MARK: the words the second action hands to the composer

    /// What the composer says while a plan change is armed, and what the next send carries in front
    /// of the typed message. Neither is on the card, and both are copy: the carried paragraph is
    /// what an idle agent reads before the question.
    func testThePlanChangeWordsMatchTheWebCard() throws {
        let web = try flatWebCard()

        assertDeclares(web, "ACCEPTANCE_PLAN_CHANGE_PREFIX",
                       AcceptanceConfirmations.planChangePrefix,
                       "what the composer's bar says it is talking about")
        assertDeclares(web, "ACCEPTANCE_PLAN_CHANGE_PLACEHOLDER",
                       AcceptanceConfirmations.planChangePlaceholder,
                       "what the armed composer asks for")

        // One criterion, so the numbered list the paragraph ends on is a single line: it is put
        // back as the web's own `${numbered}` before the count is, because it is the only other
        // place a digit occurs.
        let carried = AcceptanceConfirmations.planChangeContext(
            projectTitle: Self.project, criteriaDigest: Self.prior, criteria: ["alpha"])
        assertTemplate(web, carried,
                       [(Self.project, "${plan.projectTitle}"),
                        ("\n\n1. alpha", "\\n\\n${numbered}"),
                        ("1", "${plan.criteria.length}"),
                        (priorSeal, "${shortSeal(plan.criteriaDigest)}")],
                       "the plan the next send carries")
    }

    // MARK: the word the native card keeps outside OrbitKit

    /// What a refused press says: written into the console rather than into
    /// `AcceptanceConfirmations`, and on both cards all the same.
    func testTheWordKeptOutsideOrbitKitMatchesTheWebCard() throws {
        let web = try flatWebCard()
        let console = try source(Self.console)

        // The words, not the tail: what follows the dash is the reason prose, which both ends build
        // from their own error (`APIClient.failureReason` here, `error.message` in the browser).
        XCTAssertTrue(console.contains("\"That confirmation was not recorded — "),
                      "the native console no longer says \"That confirmation was not recorded\"")
        assertDeclares(web, "CONFIRMATION_NOT_RECORDED", "That confirmation was not recorded",
                       "what a refused confirmation says")
    }
}

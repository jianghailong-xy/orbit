import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words about one confirmation, and this is the tripwire that keeps
/// them saying them.
///
/// The failure being prevented is the ordinary one for a pair of clients with no compiler between
/// them: the browser draws a card saying `Confirm done` while the phone draws one saying something
/// else, and the two are answering the same question. So this reads the web half's SOURCE and
/// compares its declarations with this end's strings — a check that has to live in a test, because
/// the Swift client and the browser bundle share nothing that would catch it.
///
/// The other ends are the web card (`OwnerConfirmationCard.tsx`), the words the session list and the
/// console header use (`WorkspaceView.tsx`), and the rule the task's panel is under
/// (`TaskDetailPanel.tsx`). Anchored on their declarations wherever one exists, and on their
/// template literals otherwise — never on a bare phrase, which a comment could satisfy. Two things
/// are NOT compared, deliberately: the receipt's clock time (the browser formats it with
/// `toLocaleTimeString`, a locale's business rather than a contract between the ends — see
/// `OwnerConfirmations.receiptTime`) and the provenance mark, which the native card draws as the
/// ruler card's `From Orbit` line rather than as the browser header's badge and tooltip.
final class OwnerConfirmationCopyParityTests: XCTestCase {

    private static let webCard = "src/web/src/components/OwnerConfirmationCard.tsx"
    private static let webConsole = "src/web/src/components/WorkspaceView.tsx"
    private static let webTaskPanel = "src/web/src/components/TaskDetailPanel.tsx"
    /// The review bar's words and the turn cards a review puts into a conversation
    /// (docs/owner-confirmation-review-contract.md §12).
    private static let webReview = "src/web/src/components/OwnerConfirmationReview.tsx"
    private static let webReviewTurns = "src/web/src/components/ConfirmationReviewTurnCards.tsx"

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
        // Deliberately a failure and not an `XCTSkip`: a check that quietly opts out is a check
        // that reports green on exactly the day the thing it watches went missing.
        throw ParityError.noRepo
    }

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case noFile(String)
        var description: String {
            switch self {
            case .noRepo:
                return "\(OwnerConfirmationCopyParityTests.webCard) was not found above this test "
                    + "file. OrbitKit's confirmation card is one half of a pair; if the web half "
                    + "moved, move this check with it rather than deleting it."
            case .noFile(let path):
                return "\(path) was not found in the repository. The confirmation card's words reach "
                    + "both clients from it; if it moved, move this check with it."
            }
        }
    }

    /// One web source with its string literals put back together.
    ///
    /// TypeScript wraps a long sentence as `'…' + '…'` — or as template literals, or one of each —
    /// across lines, and where that wrap falls is a formatting decision while the words are the
    /// contract. So adjacent literals are joined whichever quotes they use, and a value sitting on
    /// the line under its `=` is pulled up.
    private func flat(_ relativePath: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relativePath)
        guard let source = try? String(contentsOf: url, encoding: .utf8) else {
            throw ParityError.noFile(relativePath)
        }
        return source
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*['`]", with: "= '", options: .regularExpression)
    }

    /// The other end declares this constant with exactly these words, in either quote style — the
    /// web card writes `"What's missing?"` with double quotes because the sentence owns an
    /// apostrophe, and that is a quoting decision rather than a wording one.
    private func assertDeclares(_ web: String, _ name: String, _ value: String, _ what: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        let single = "\(name) = '\(value)'"
        let double = "\(name) = \"\(value)\""
        XCTAssertTrue(web.contains(single) || web.contains(double),
                      "\(what) drifted: the web end no longer declares "
                          + "\(name) as \(value.debugDescription)",
                      file: file, line: line)
    }

    private func assertContains(_ web: String, _ needle: String, _ what: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(web.contains(needle),
                      "\(what) drifted: the web end no longer contains \(needle.debugDescription)",
                      file: file, line: line)
    }

    /// This end's line, with the values it was rendered from put back as the web template's own
    /// interpolations — so the whole sentence is compared, and not only the words around a number.
    private func template(_ rendered: String, _ values: [(String, String)]) -> String {
        values.reduce(rendered) { line, pair in
            line.replacingOccurrences(of: pair.0, with: pair.1)
        }
    }

    // MARK: the words on the card

    func testTheHeadingAndActionsMatchTheWebCard() throws {
        let web = try flat(Self.webCard)

        assertDeclares(web, "OWNER_CONFIRMATION_HEADING", OwnerConfirmations.heading,
                       "the card's heading")
        assertDeclares(web, "OWNER_CONFIRM_ACTION", OwnerConfirmations.confirmAction,
                       "the confirm action")
        assertDeclares(web, "OWNER_SEND_BACK_ACTION", OwnerConfirmations.sendBackAction,
                       "the send-back action")
        assertDeclares(web, "OWNER_SEND_BACK_LABEL", OwnerConfirmations.sendBackLabel,
                       "the reason's label")
        assertDeclares(web, "OWNER_SEND_BACK_HINT", OwnerConfirmations.sendBackHint,
                       "why the reason is required")
        // Neither end takes the reason on the card any more: both hand it to their composer, and
        // this is the line that composer shows. It is compared for the reason every other string
        // here is — one confirmation worded two ways is two answers writing the same row.
        assertDeclares(web, "OWNER_SENDING_BACK_PREFIX", OwnerConfirmations.sendingBackPrefix,
                       "what the armed composer says it is answering")
    }

    /// The two boxes a person decides from, and the folds over them.
    func testTheDecisionBoxesMatchTheWebCard() throws {
        let web = try flat(Self.webCard)

        assertDeclares(web, "WHAT_SETTLES_IT", OwnerConfirmations.whatSettlesIt,
                       "the settle-it box's heading")
        assertDeclares(web, "WHAT_THE_RUN_REPORTED", OwnerConfirmations.whatTheRunReported,
                       "the report box's heading")
        assertDeclares(web, "OWNER_CONFIRMATION_NO_CRITERIA", OwnerConfirmations.noCriteria,
                       "the no-criteria line")
        assertDeclares(web, "OWNER_CONFIRMATION_NO_REPORT", OwnerConfirmations.noReport,
                       "the no-report line")
        assertDeclares(web, "OWNER_CONFIRMATION_SHOW_ALL", OwnerConfirmations.showAll,
                       "the show-all fold")
        assertDeclares(web, "OWNER_CONFIRMATION_SHOW_LESS", OwnerConfirmations.showLess,
                       "the show-less fold")
        assertDeclares(web, "OWNER_CONFIRMATION_YOURS", OwnerConfirmations.yours,
                       "the line saying whose call this is")

        // Where the report starts folding is a number both ends decide from, so it is compared:
        // a phone folding a sentence the browser shows whole is the two ends disagreeing about
        // what the run said.
        assertContains(web, "const REPORT_CLAMP = \(OwnerConfirmations.reportClamp);",
                       "the report's fold point")
    }

    /// The block right above Confirm done. Its whole sentences — counts, plurals, the branch and the
    /// landing put together — are proved against the shared fixture by `OwnerConfirmationIfConfirmedTests`
    /// and the web card's test; this holds the parts both ends declare to the same words.
    func testTheIfYouConfirmWordsMatchTheWebCard() throws {
        let web = try flat(Self.webCard)

        assertDeclares(web, "IF_YOU_CONFIRM", OwnerConfirmations.ifYouConfirm,
                       "the block's heading")
        assertDeclares(web, "IF_CONFIRMED_NOT_ON_MAIN", OwnerConfirmations.notOnMain,
                       "the unmerged branch's line")
        assertDeclares(web, "IF_CONFIRMED_NO_RECORD_ON_MAIN", OwnerConfirmations.noRecordOnMain,
                       "the branch nobody can place on main")
        assertDeclares(web, "IF_CONFIRMED_DOES_NOT_MERGE", OwnerConfirmations.doesNotMerge,
                       "what confirming does not do to the branch")
        assertDeclares(web, "IF_CONFIRMED_LINE_THEN_OWNER", OwnerConfirmations.lineThenOwner,
                       "the integration line's landing")
        assertDeclares(web, "IF_CONFIRMED_AUTO_MAIN", OwnerConfirmations.autoMain,
                       "Automatic's landing")
        assertDeclares(web, "IF_CONFIRMED_ENDS_SESSION", OwnerConfirmations.endsSession,
                       "the run the confirmation ends")
        // Drawn once, by the card (where it sits is the web card's own test).
        assertContains(web, "<OwnerConfirmationIfYouConfirm ifConfirmed={view.ifConfirmed} />",
                       "the card drawing the block")
        XCTAssertEqual(web.components(separatedBy: "<OwnerConfirmationIfYouConfirm ").count, 2,
                       "the block is drawn once, by the card")
    }

    /// The line the row and the console header say while one of these cards is waiting. It is
    /// declared by the card and used by the console, so both are checked: a client that declares
    /// the words but never says them is as wrong as one that says different ones.
    func testTheWaitingWordsMatchTheSessionRowAndHeader() throws {
        let card = try flat(Self.webCard)
        let console = try flat(Self.webConsole)

        assertDeclares(card, "WAITING_FOR_CONFIRMATION", OwnerConfirmations.waitingForConfirmation,
                       "what a waiting row says")
        assertContains(console, "WAITING_FOR_CONFIRMATION,",
                       "the console importing the waiting words")
        assertContains(console,
                       "if (s.waitingKind === 'OWNER_CONFIRMATION') return WAITING_FOR_CONFIRMATION;",
                       "the row choosing its words by kind")
        // And the other named kind: everything counted being one of the four owner items, the row
        // says that item's own word (`ownerItemWord`) rather than the approval wording nobody is
        // doing. That branch's words are held to this end's by `OwnerItemCardsTests`.
        assertContains(console,
                       "if (s.waitingKind === 'OWNER_ITEM') return ownerItemWord(s) "
                           + "?? 'Waiting for approval';",
                       "the row naming the owner item that is waiting")
        // And the header reads it the same way its row does, outside the generating gate: an owner
        // confirmation is held open by no turn, so it is still waiting once the conversation parks.
        assertContains(console,
                       "if ((session.pendingApprovals ?? 0) > 0) return waitingLabel(session);",
                       "the header word reading the same waiting label")
    }

    // MARK: where the card is drawn, and what it leaves

    /// One place to answer: the card exists in the session whose run reported, and its receipts are
    /// drawn in that same session. Both halves are the web card's own exported functions.
    func testTheCardAndItsReceiptsBelongToOneSession() throws {
        let web = try flat(Self.webCard)

        assertContains(web, "return view.waiting.sessionId === sessionId ? view.waiting : null",
                       "the card being drawn only in the reporting session")
        assertContains(web, "return view.decisions.filter((decided) => decided.sessionId === sessionId)",
                       "the receipts being drawn only in the reporting session")
    }

    /// The receipt's line and the report's heading, compared whole: the first is what a decision
    /// leaves in the conversation and the second is what the owner decided from.
    func testTheReceiptAndReportLinesMatchTheWebCard() throws {
        let web = try flat(Self.webCard)

        let bare = OwnerConfirmations.receiptLine(
            RecordedOwnerDecision(id: "d", decision: .confirm, decidedAt: "2026-09-16T08:00:00Z"),
            time: "08:00")
        let asWebTemplate = template(bare, [
            (OwnerConfirmations.confirmedHeading, "${action}"),
            ("08:00", "${decisionReceiptTime(decided.decidedAt, now)}"),
        ])
        assertContains(web, "`\(asWebTemplate)`", "the receipt's line")
        assertContains(web,
                       "decided.decision === 'CONFIRM' ? OWNER_CONFIRMED_HEADING : "
                           + "OWNER_SENT_BACK_HEADING",
                       "which action word the receipt's line quotes")
        assertDeclares(web, "OWNER_CONFIRMED_HEADING", OwnerConfirmations.confirmedHeading,
                       "a confirmation's heading")
        assertDeclares(web, "OWNER_SENT_BACK_HEADING", OwnerConfirmations.sentBackHeading,
                       "a send-back's heading")

        let report = OwnerConfirmationReport(text: "t", reportedAt: "2026-09-16T07:30:00Z")
        let heading = OwnerConfirmations.reportHeading(report, time: "07:30")
        let headingAsWebTemplate = template(heading, [
            (OwnerConfirmations.whatTheRunReported, "${WHAT_THE_RUN_REPORTED}"),
            ("07:30", "${decisionReceiptTime(report.reportedAt, now)}"),
        ])
        assertContains(web, "`\(headingAsWebTemplate)`",
                       "the report box's heading with its moment")
        assertContains(web, ": WHAT_THE_RUN_REPORTED",
                       "the report box's heading when the run said nothing")
    }

    /// What a confirmation's receipt can open to, and what a send-back's cannot.
    func testTheReceiptFoldsMatchTheWebCard() throws {
        let web = try flat(Self.webCard)
        assertDeclares(web, "OWNER_SHOW_WHAT_SETTLED_IT", OwnerConfirmations.showWhatSettledIt,
                       "the receipt's open fold")
        assertDeclares(web, "OWNER_HIDE_WHAT_SETTLED_IT", OwnerConfirmations.hideWhatSettledIt,
                       "the receipt's close fold")
    }

    // MARK: what a card that cannot be answered meets

    /// A stale card names the refusal it would meet in the door's own spelling. If one end
    /// re-spells a code, that end stops naming the refusal the server actually sends.
    func testTheStaleRefusalCodesAreSpelledTheSameOnBothEnds() throws {
        let web = try flat(Self.webCard)
        for code in OwnerConfirmations.staleCodes {
            assertContains(web, "'\(code)'", "the refusal code \(code)")
        }
        assertContains(web, "export const OWNER_CONFIRMATION_STALE_CODES",
                       "the list of refusals that mean the card is out of date")
    }

    // MARK: the review bar (docs/owner-confirmation-review-contract.md §6–§9, §12)

    /// Every word the bar says, declared at both ends with the same spelling. Where a sentence is put
    /// together around a value, the whole sentence is compared, with the value put back as the web
    /// template's own interpolation.
    func testTheReviewBarsWordsMatchTheWebBar() throws {
        let web = try flat(Self.webReview)
        let declared: [(String, String, String)] = [
            ("UNDER_REVIEW", OwnerConfirmations.underReview, "what a row under review says"),
            ("REVIEW_HEADING", OwnerConfirmations.reviewHeading, "the bar's label"),
            ("REVIEWER_FALLBACK", OwnerConfirmations.reviewerFallback, "an unreadable reviewer's name"),
            ("REVIEWING_SINCE", OwnerConfirmations.reviewingSincePrefix, "the under-review status"),
            ("REVIEW_WILL_ASK", OwnerConfirmations.reviewWillAsk, "the under-review note"),
            ("REVIEW_WILL_SHOW_HERE", OwnerConfirmations.reviewWillShowHere, "the receipt's under-review note"),
            ("REVIEW_NEEDS_YOU", OwnerConfirmations.reviewNeedsYou, "the first line's question prefix"),
            ("REVIEW_NOTHING_NEEDS_YOU", OwnerConfirmations.reviewNothingNeedsYou, "the first line's all-clear"),
            ("REVIEW_CHECKED", OwnerConfirmations.reviewChecked, "the Checked row"),
            ("REVIEW_NOT_CHECKED", OwnerConfirmations.reviewNotChecked, "the Not checked row"),
            ("REVIEW_LEFT_OPEN", OwnerConfirmations.reviewLeftOpen, "the Left open row"),
            ("REVIEW_PROBLEM", OwnerConfirmations.reviewProblem, "a Problem row"),
            ("NOT_REVIEWED", OwnerConfirmations.notReviewed, "the not-reviewed status"),
            ("NOT_REVIEWED_TAIL", OwnerConfirmations.notReviewedTail, "who has checked it"),
            ("NOT_REVIEWED_REVIEWER_ENDED", OwnerConfirmations.notReviewedReviewerEnded, "REVIEWER_ENDED"),
            ("NOT_REVIEWED_REVIEWER_STOPPED", OwnerConfirmations.notReviewedReviewerStopped, "REVIEWER_STOPPED"),
            ("NOT_REVIEWED_COORDINATOR_PAUSED", OwnerConfirmations.notReviewedCoordinatorPaused,
             "COORDINATOR_PAUSED"),
            ("NOT_REVIEWED_AUTOMATIC_OFF", OwnerConfirmations.notReviewedAutomaticOff, "AUTOMATIC_OFF"),
            ("NOT_REVIEWED_NO_COORDINATOR", OwnerConfirmations.notReviewedNoCoordinator, "NO_COORDINATOR"),
            ("NOT_REVIEWED_UNREACHABLE", OwnerConfirmations.notReviewedUnreachable, "UNREACHABLE"),
            ("REVIEW_OUTDATED", OwnerConfirmations.reviewOutdated, "the outdated status"),
            ("REVIEW_EARLIER_REPORT", OwnerConfirmations.reviewEarlierReport, "a newer report's note"),
            ("SHOW_OLD_REVIEW", OwnerConfirmations.showOldReview, "the old review's fold"),
            ("RETURNED_TO_AGENT", OwnerConfirmations.returnedToAgent, "the returned record's status"),
            ("RETURNED_FOOTER", OwnerConfirmations.returnedFooter, "the returned record's last line"),
            ("SENT_BACK_BY_REVIEWER", OwnerConfirmations.sentBackByReviewer, "the return's turn card"),
            ("REVIEW_EVIDENCE", OwnerConfirmations.reviewEvidence, "a question's evidence fold"),
            ("ANSWERS_SENT_WITH_CONFIRM", OwnerConfirmations.answersSentWithConfirm, "the answers' hint"),
            ("YOUR_ANSWERS", OwnerConfirmations.yourAnswers, "the receipt's answers"),
            ("ANSWER_NOT_SHOWN", OwnerConfirmations.answerNotShown, "an answer the owner was not shown"),
            ("BEFORE_REVIEW", OwnerConfirmations.beforeReview, "a decision made before the review"),
            ("REVIEW_REQUESTED", OwnerConfirmations.reviewRequested, "the reviewer's turn card"),
        ]
        for (name, value, what) in declared {
            assertDeclares(web, name, value, what)
        }

        // The sentences put together around a value, compared whole.
        assertContains(web, "`" + template(OwnerConfirmations.reviewingSince("14:55"), [
            (OwnerConfirmations.reviewingSincePrefix, "${REVIEWING_SINCE}"), ("14:55", "${time}"),
        ]) + "`", "Reviewing since <time>")
        assertContains(web, "`" + template(OwnerConfirmations.reviewNeedsYouLine("Q", more: 2), [
            (OwnerConfirmations.reviewNeedsYou, "${REVIEW_NEEDS_YOU}"), ("Q", "${text}"), ("2", "${more}"),
        ]) + "`", "Needs you: <question> (+N more)")
        assertContains(web, "`" + template(OwnerConfirmations.reviewNothingNeedsYouLine(3), [
            ("3", "${notChecked}"), (OwnerConfirmations.reviewNothingNeedsYou, "${REVIEW_NOTHING_NEEDS_YOU}"),
        ]) + "`", "<N> not checked · nothing needs you")
        assertContains(web, "'\(OwnerConfirmations.problemsFoundLine(1))'", "one problem found")
        assertContains(web, "`" + template(OwnerConfirmations.problemsFoundLine(4), [("4", "${problems}")]) + "`",
                       "N problems found")
        assertContains(web, "`" + template(OwnerConfirmations.noAnswerWithin("30 min"), [("30 min", "${window}")])
                           + "`", "No answer within <window>.")
        assertContains(web, "`" + template(OwnerConfirmations.writtenFor("aaaaaaa", now: "bbbbbbb"), [
            ("aaaaaaa", "${reviewed}"), ("bbbbbbb", "${now}"),
        ]) + "`", "Written for <commit> … <commit> now")
        assertContains(web, "`" + template(OwnerConfirmations.reviewDue("15:25"), [("15:25", "${time}")]) + "`",
                       "Due <time>")
        assertContains(web, "`" + template(OwnerConfirmations.underReviewLine("zz-reviewer"), [
            (OwnerConfirmations.underReview, "${UNDER_REVIEW}"),
            ("zz-reviewer", "${reviewerName(reviewerTitle)}"),
        ]) + "`", "the row's Under review · <reviewer>")
        // The window's three shapes: `30 min`, `2 h`, `1 h 30 min`.
        assertContains(web, "`${rest} min`", "a window under an hour")
        assertContains(web, "`${hours} h`", "a window of whole hours")
        assertContains(web, "`${hours} h ${rest} min`", "a window of hours and minutes")
        XCTAssertEqual(OwnerConfirmations.reviewWindowWords(5400), "1 h 30 min")
    }

    /// The question card's own words, which the answer blocks reuse at both ends (§7 Q2).
    func testTheAnswerBlocksReuseTheQuestionCardsWords() throws {
        let review = try flat(Self.webReview)
        assertContains(review, "import { OTHER_OPTION, RECOMMENDED } from './CoordinatorQuestionCard';",
                       "the web answer blocks reusing the question card's words")
        let question = try flat("src/web/src/components/CoordinatorQuestionCard.tsx")
        assertDeclares(question, "RECOMMENDED", CoordinatorQuestions.recommended, "the Recommended tag")
        assertDeclares(question, "OTHER_OPTION", CoordinatorQuestions.otherOption, "the Other row")
    }

    /// The card's mark, now that an agent's words stand on it twice, each in a box naming who wrote
    /// it (§10 G3) — and the console and the task panel saying Under review where they would say
    /// Waiting for your confirmation (§5 N3).
    func testTheMarkTheRowAndThePanelSayWhatAReviewMeans() throws {
        let card = try flat(Self.webCard)
        assertDeclares(card, "OWNER_CONFIRMATION_AUTHORSHIP_TITLE", OwnerConfirmations.authorshipTitle,
                       "what the card's mark says about itself")

        let console = try flat(Self.webConsole)
        assertContains(console, "if (session.confirmationUnderReview) return UNDER_REVIEW;",
                       "the header word under review")
        assertContains(console, "return { text: underReviewLine(s.confirmationUnderReview.reviewerTitle), tone: 'review' };",
                       "the row's line under review")

        let panel = try flat(Self.webTaskPanel)
        assertContains(panel, "ownerWaiting.review?.state === 'UNDER_REVIEW' ? UNDER_REVIEW : WAITING_FOR_CONFIRMATION",
                       "the task panel's pointer under review")

        let turns = try flat(Self.webReviewTurns)
        assertDeclares(turns, "OPEN_TASK_SESSION", OwnerConfirmations.openTaskSession,
                       "the Review requested card's way onto the run")
    }

    // MARK: the task panel's rule — one state, one place to answer

    /// The panel and the card are one rule in two places: while a run is waiting the panel only
    /// points at the card, and with nothing waiting it confirms the task itself. The criterion and
    /// the statuses it may confirm from are the door's own.
    func testTheTaskPanelsRuleMatchesTheWebPanel() throws {
        let panel = try flat(Self.webTaskPanel)

        let statuses = OwnerConfirmations.confirmableStatuses.map { "'\($0)'" }
            .joined(separator: ", ")
        assertContains(panel, "OWNER_CONFIRMABLE_STATUSES: readonly string[] = [\(statuses)];",
                       "the statuses an OWNER_CONFIRMED task is confirmed from")
        assertContains(panel, "task?.completionCriterion === 'OWNER_CONFIRMED'",
                       "how the panel recognises an OWNER_CONFIRMED task")
        assertContains(panel, "ownerWaiting === null",
                       "the panel refusing to offer a second place to answer")
        assertContains(panel, "sendOwnerDecision(taskId, null, 'CONFIRM')",
                       "the panel's own confirmation answering no run")
    }
}

import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words about one judgment, and this is the tripwire that keeps them
/// saying them.
///
/// The failure being prevented is specific and was named when the card was first built for both
/// ends: one end showing a line as 「机器已核」 while the other shows it as 「提交者自述」. Nothing in
/// a build catches that — the Swift client and the browser bundle share no compiler — so the check
/// has to be a test that reads the other end's source and compares the strings.
///
/// The other end is the web system card, `EvidenceDecisionCard.tsx`. Until 2026-09-10 it was the
/// AskUserQuestion special case in `ApprovalPanel.tsx`, with the option labels it was recognised by
/// in `DecisionRail.tsx`; both went when the card stopped being a question, and so did every
/// comparison of an option label, a chat action, a full-text fold or a position chip.
///
/// Anchored on the web card's declarations wherever it has one, and on its template literals
/// otherwise — never on a bare phrase, which a comment could satisfy. Two things are NOT compared,
/// deliberately: the claim clamp (the browser folds at one number, this client at a phone's and a
/// window's — see `claimClampCompact`) and the provenance mark, which the native card draws as the
/// ruler card's `From Orbit` line rather than as the browser header's badge and tooltip.
final class EvidenceDecisionCopyParityTests: XCTestCase {

    private static let webCard = "src/web/src/components/EvidenceDecisionCard.tsx"

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
        var description: String {
            "\(EvidenceDecisionCopyParityTests.webCard) was not found above this test file. "
                + "OrbitKit's evidence card is one half of a pair; if the web half moved, move this "
                + "check with it rather than deleting it."
        }
    }

    /// The web card's source with its string literals put back together.
    ///
    /// TypeScript wraps a long sentence as `'…' + '…'` — or as template literals, or one of each —
    /// across lines, and where that wrap falls is a formatting decision while the words are the
    /// contract. So adjacent literals are joined whichever quotes they use, and a value sitting on
    /// the line under its `=` is pulled up.
    private func flatWebCard() throws -> String {
        let source = try String(contentsOf: try repoRoot().appendingPathComponent(Self.webCard),
                                encoding: .utf8)
        return source
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

    private func assertContains(_ web: String, _ needle: String, _ what: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(web.contains(needle),
                      "\(what) drifted: the web card no longer contains \(needle.debugDescription)",
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

    func testTheHeadingsAndActionsMatchTheWebCard() throws {
        let web = try flatWebCard()

        assertDeclares(web, "DECISION_ASK_HEADING", EvidenceDecisions.askHeading,
                       "the heading of a live card")
        assertDeclares(web, "EVIDENCE_DECISION_STALE_HEADING", EvidenceDecisions.staleHeading,
                       "the heading of a card that can no longer be answered")
        assertDeclares(web, "EVIDENCE_DECISION_UNREAD_HEADING", EvidenceDecisions.unreadHeading,
                       "the heading of a card that could not be re-read")
        assertDeclares(web, "DECISION_CONFIRM_ACTION", EvidenceDecisions.confirmAction,
                       "the confirm action")
        // What the RECORD calls the answer. The BUTTON is not this: it is the shared
        // `Chat about this`, asserted below.
        assertDeclares(web, "DECISION_SEND_BACK_ACTION", EvidenceDecisions.sendBackAction,
                       "the send-back action")
        assertDeclares(web, "DECISION_SENDING_BACK_PREFIX", EvidenceDecisions.sendingBackPrefix,
                       "what the composer's bar says it is answering")
        assertDeclares(web, "DECISION_SEND_BACK_LABEL", EvidenceDecisions.sendBackLabel,
                       "what the armed composer asks for")
        assertDeclares(web, "DECISION_SEND_BACK_HINT", EvidenceDecisions.sendBackHint,
                       "the promise printed under the buttons")
        assertDeclares(web, "DECISION_NO_CLAIM", EvidenceDecisions.noClaim, "the empty-claim line")
        assertDeclares(web, "DECISION_NO_CRITERION", EvidenceDecisions.noCriterion,
                       "the no-criterion line")
        assertDeclares(web, "DECISION_NO_GAPS", EvidenceDecisions.noGaps, "the no-gaps line")
        assertDeclares(web, "DECISION_CRITERION_HEADING", EvidenceDecisions.criterionHeading,
                       "the heading over the criterion's own text")
        assertDeclares(web, "DECISION_CLAIM_HIDE", EvidenceDecisions.claimHide,
                       "the account's fold-up")
    }

    /// The second action, at both ends, is the word four other controls already use. A card that
    /// declared its own would be the sixth name for one thing — and the two ends would be free to
    /// drift apart on the one control they are supposed to share.
    func testTheSecondActionTakesItsWordFromTheSharedComposerHandoffControl() throws {
        let web = try flatWebCard()

        XCTAssertTrue(web.contains("{OWNER_SEND_BACK_ACTION}"),
                      "the web card no longer takes its second action's word from the constant the "
                          + "other composer handoffs share (`Approvals.chatAction` at this end)")
        // And what this end keeps as `sendBackAction` is the RECORD's word, not the button's:
        // rendering the receipt a send-back leaves with `Chat about this` would read as an answer
        // nobody gave.
        XCTAssertNotEqual(EvidenceDecisions.sendBackAction, Approvals.chatAction)
    }

    /// The counted strings, which are templates on one side and interpolations on the other.
    func testCountedLinesMatchTheWebCard() throws {
        let web = try flatWebCard()

        assertContains(web, "`\(template(EvidenceDecisions.gapsMore(7), [("7", "${rest}")]))`",
                       "「还有 N 条」")
        assertContains(web,
                       "`\(template(EvidenceDecisions.gapsHeading(5), [("5", "${row.gaps.length}")]))`",
                       "the gaps heading")
        assertContains(web,
                       "`\(template(EvidenceDecisions.claimFold(7), [("7", "${chars}")]))`",
                       "the folded account line")
        let held = EvidenceDecisions.checksHeading(held: 2, total: 2)
        assertContains(web, "`\(template(held, [("2", "${held}")]))`", "the folded checks line")
        let broken = EvidenceDecisions.checksHeading(held: 2, total: 3)
            .replacingOccurrences(of: held, with: "")
        assertContains(web, "`\(template(broken, [("1", "${checks.length - held}")]))`",
                       "the checks that did not hold")

        let row = EvidenceDecisionRow(
            taskId: "t", title: "x", criterion: nil, evidenceRevision: "1", claim: "c", gaps: [],
            citations: [EvidenceDecisionCitation(kind: "TOOL_CALL", ref: "a", resolved: true),
                        EvidenceDecisionCitation(kind: "TOOL_CALL", ref: "b", resolved: false)],
            decidability: EvidenceDecisionDecidability(decidable: true),
            independence: EvidenceDecisionIndependence(independent: true))
        let checks = EvidenceDecisions.checks(row).map(\.text)
        XCTAssertEqual(checks.count, 3)
        assertContains(web, "'\(checks[0])'", "the machine check on the criterion")
        assertContains(web,
                       "`\(template(checks[1], [("1/2", "${resolved.length}/${row.citations.length}")]))`",
                       "the machine check on the citations")
        assertContains(web, "'\(checks[2])'", "the machine check on independence")
    }

    /// Three shown and the rest counted is a contract between the clients, not a width judgment —
    /// so the number itself has to be the same on both sides, unlike the claim clamp.
    func testGapsShownIsTheSameNumberOnBothEnds() throws {
        let web = try flatWebCard()
        assertContains(web, "const DECISION_GAPS_SHOWN = \(EvidenceDecisions.gapsShown);",
                       "the number of gaps shown before counting")
    }

    // MARK: what a card that cannot be answered says

    /// A card names the refusal it would meet in the door's own spelling. If one end re-spells a
    /// code, that end stops naming the refusal the server actually sends.
    func testTheRefusalCodesAreSpelledTheSameOnBothEnds() throws {
        let web = try flatWebCard()
        assertDeclares(web, "EVIDENCE_DECISION_ALREADY_DECIDED",
                       EvidenceDecisions.alreadyDecidedRefusal, "the already-decided refusal")
        assertDeclares(web, "EVIDENCE_DECISION_SUPERSEDED", EvidenceDecisions.supersededRefusal,
                       "the superseded refusal")
    }

    /// The three explanations over dead buttons, compared whole: they are the sentences a reader
    /// acts on when a card will not take an answer.
    func testTheStaleExplanationsMatchTheWebCardWordForWord() throws {
        let web = try flatWebCard()
        let later = EvidenceDecisionRow(
            taskId: "t", title: "x", projectId: "p", criterion: nil, evidenceRevision: "12",
            claim: "c", gaps: [], citations: [],
            decidability: EvidenceDecisionDecidability(decidable: true),
            independence: EvidenceDecisionIndependence(independent: true))

        let superseded = EvidenceDecisions.staleExplanation(EvidenceDecisionStanding(
            taskId: "t", evidenceRevision: "11", state: .superseded(replacement: later))) ?? ""
        assertContains(web, template(superseded, [
            ("12", "${standing.replacement.evidenceRevision}"),
            ("11", "${standing.address.evidenceRevision}"),
            (EvidenceDecisions.supersededRefusal, "${EVIDENCE_DECISION_SUPERSEDED}"),
        ]), "the superseded explanation")

        let decided = EvidenceDecisions.staleExplanation(EvidenceDecisionStanding(
            taskId: "t", evidenceRevision: "11", state: .alreadyDecided)) ?? ""
        assertContains(web, template(decided, [
            (EvidenceDecisions.alreadyDecidedRefusal, "${EVIDENCE_DECISION_ALREADY_DECIDED}"),
        ]), "the already-decided explanation")

        let unread = EvidenceDecisions.staleExplanation(EvidenceDecisionStanding(
            taskId: "t", evidenceRevision: "11", state: .unread)) ?? ""
        assertContains(web, "'\(unread)'", "the unread explanation")
    }

    // MARK: what an answer leaves behind

    /// The line a recorded answer leaves where it was given, and which action word it quotes.
    func testTheRecordedLineMatchesTheWebCard() throws {
        let web = try flatWebCard()
        let bare = EvidenceDecisions.recordedLine(EvidenceDecisionResult(
            taskId: "t", evidenceRevision: "8", decision: .confirm, decidedAt: "2026-09-10"))
        assertContains(web, "`\(template(bare, [(EvidenceDecisions.confirmAction, "${action}"), ("8", "${result.evidenceRevision}")]))`",
                       "the recorded line")

        let sentBack = EvidenceDecisionResult(taskId: "t", evidenceRevision: "8",
                                              decision: .sendBack, note: "N",
                                              decidedAt: "2026-09-10")
        let withNote = EvidenceDecisions.recordedLine(sentBack)
        let line = EvidenceDecisions.recordedLine(EvidenceDecisionResult(
            taskId: "t", evidenceRevision: "8", decision: .sendBack, decidedAt: "2026-09-10"))
        XCTAssertTrue(withNote.hasPrefix(line), withNote)
        assertContains(web, "`\(template(withNote, [(line, "${line}"), ("N", "${result.note}")]))`",
                       "the reason after a recorded send-back")
        assertContains(web,
                       "result.decision === 'CONFIRM' ? DECISION_CONFIRM_ACTION : DECISION_SEND_BACK_ACTION",
                       "which action word the recorded line quotes")
    }

    /// The record that outlives the console: what it is called (by whom it was answered), the line
    /// that says which answer to which revision, and the label over a send-back's reason.
    ///
    /// Both ends draw this — the browser in the conversation, the phone in the console — and the
    /// clock is each end's own locale, so it goes back as the web's own interpolation rather than
    /// being compared as text.
    func testTheReceiptMatchesTheWebCardsWords() throws {
        let web = try flatWebCard()
        assertDeclares(web, "EVIDENCE_DECISION_RECORDED_HEADING", EvidenceDecisions.recordedHeading,
                       "the heading of a receipt the owner pressed")
        assertDeclares(web, "EVIDENCE_DECISION_AGENT_RECORDED_HEADING",
                       EvidenceDecisions.agentRecordedHeading,
                       "the heading of one a run of the session recorded")
        assertDeclares(web, "DECISION_RECEIPT_REASON", EvidenceDecisions.receiptReasonLabel,
                       "the label over a send-back's reason")

        let decided = RecordedEvidenceDecision(
            taskId: "t", title: "T", projectId: nil, evidenceRevision: "8", decision: .confirm,
            note: nil, decidedAt: "2026-09-16T09:45:00.000Z", decidedByType: "USER")
        let line = template(EvidenceDecisions.receiptLine(decided), [
            (EvidenceDecisions.confirmAction, "${action}"),
            ("8", "${decided.evidenceRevision}"),
            (EvidenceDecisions.receiptTime(decided.decidedAt), "${decisionReceiptTime(decided.decidedAt, now)}"),
        ])
        assertContains(web, "`\(line)`", "what a receipt says")
        assertContains(web,
                       "decided.decision === 'CONFIRM' ? DECISION_CONFIRM_ACTION : DECISION_SEND_BACK_ACTION",
                       "which action word the receipt's line quotes")
    }

    // MARK: while the coordinator is paused

    /// The folded card a version waiting for its coordinator is drawn as, the note the card it opens
    /// into carries, and the words for why it waits — the project's copy section, which the four
    /// clients say word for word (project 34cygPTQe5LPUT7tdUAzG).
    func testTheQueuedCardsWordsMatchTheWebCard() throws {
        let web = try flatWebCard()
        assertDeclares(web, "EVIDENCE_DECISION_QUEUED_HEADING", EvidenceDecisions.queuedHeading,
                       "the folded card's heading")
        assertDeclares(web, "EVIDENCE_DECISION_QUEUED_NOTE", EvidenceDecisions.queuedNote,
                       "what the folded card says under why it waits")
        assertDeclares(web, "DECISION_DECIDE_MYSELF_ACTION", EvidenceDecisions.decideMyselfAction,
                       "the folded card's one way in")
        assertDeclares(web, "EVIDENCE_DECISION_QUEUED_OPEN_NOTE", EvidenceDecisions.queuedOpenNote,
                       "what the opened card says under why it waits")
        assertDeclares(web, "EVIDENCE_DECISION_COORDINATOR_PAUSED", EvidenceDecisions.coordinatorPaused,
                       "why it waits while the coordinator is paused")
        assertDeclares(web, "EVIDENCE_DECISION_COORDINATOR_BACK", EvidenceDecisions.coordinatorBack,
                       "why it waits once the coordinator is back")
        assertDeclares(web, "DECISION_PAUSE_FIVE_HOUR_LIMIT", EvidenceDecisions.pauseFiveHourLimit,
                       "the 5-hour window")
        assertDeclares(web, "DECISION_PAUSE_WEEKLY_LIMIT", EvidenceDecisions.pauseWeeklyLimit,
                       "the weekly window")
        assertDeclares(web, "DECISION_PAUSE_USAGE_LIMIT", EvidenceDecisions.pauseUsageLimit,
                       "a usage limit that names no window")
        assertDeclares(web, "EVIDENCE_DECISION_SENT_TO_COORDINATOR", EvidenceDecisions.sentToCoordinator,
                       "the line a version that waited leaves once it is handed over")
    }

    /// The pause line's spellings and the sent line, compared whole: this end's rendering with the
    /// web template's own interpolations put back. The clock is each end's receipt clock, so it goes
    /// back as the web's interpolation rather than being compared as text.
    func testThePauseAndSentLinesMatchTheWebTemplates() throws {
        let web = try flatWebCard()
        let resets = "2026-10-12T11:00:00.000Z"
        let at = EvidenceDecisions.receiptTime(resets)
        let paused = (EvidenceDecisions.coordinatorPaused, "${EVIDENCE_DECISION_COORDINATOR_PAUSED}")
        let window = (EvidenceDecisions.pauseWeeklyLimit, "${pause.window}")

        let both = EvidenceDecisions.pauseLine(.paused(window: EvidenceDecisions.pauseWeeklyLimit,
                                                       retryAt: resets))
        assertContains(web, "`\(template(both, [paused, window, (at, "${at}")]))`",
                       "the pause line with its window and its reset")
        let windowOnly = EvidenceDecisions.pauseLine(.paused(window: EvidenceDecisions.pauseWeeklyLimit,
                                                             retryAt: nil))
        assertContains(web, "`\(template(windowOnly, [paused, window]))`",
                       "the pause line with its window and no retry armed")
        let retries = EvidenceDecisions.pauseLine(.paused(window: nil, retryAt: resets))
        assertContains(web, "`\(template(retries, [paused, (at, "${at}")]))`",
                       "the pause line of a failure that is not a usage limit, with its retry")
        XCTAssertEqual(EvidenceDecisions.pauseLine(.paused(window: nil, retryAt: nil)),
                       EvidenceDecisions.coordinatorPaused)
        XCTAssertEqual(EvidenceDecisions.pauseLine(.back), EvidenceDecisions.coordinatorBack)

        let delivered = "2026-10-09T12:05:00.000Z"
        let sent = EvidenceDecisions.sentLine(delivered)
        assertContains(web, "`\(template(sent, [(EvidenceDecisions.sentToCoordinator, "${EVIDENCE_DECISION_SENT_TO_COORDINATOR}"), (EvidenceDecisions.receiptTime(delivered), "${decisionReceiptTime(deliveredAt, now)}")]))`",
                       "the line a version that waited leaves")
    }

    /// Which window the line names is the transcript's own judgment at both ends: the web card maps
    /// `quotaWindowKind` onto the three words, and that function keys on the same two phrases
    /// `AutoRetryLogic.quotaWindowKind` does — so a phone and a browser name one window for one
    /// failure, and the line names the window the quota card above it names.
    func testThePauseWindowIsTheTranscriptsOwnJudgmentAtBothEnds() throws {
        let web = try flatWebCard()
        assertContains(web, "FIVE_HOUR: DECISION_PAUSE_FIVE_HOUR_LIMIT", "the 5-hour window's word")
        assertContains(web, "WEEKLY: DECISION_PAUSE_WEEKLY_LIMIT", "the weekly window's word")
        assertContains(web, "OTHER: DECISION_PAUSE_USAGE_LIMIT", "the word for a window nobody named")

        let judgment = try String(contentsOf: try repoRoot().appendingPathComponent(
            "src/web/src/lib/quotaWindow.ts"), encoding: .utf8)
        let phrases: [(String, String, AutoRetryLogic.QuotaWindow)] = [
            ("hit your session limit", "FIVE_HOUR", .fiveHour),
            ("hit your weekly limit", "WEEKLY", .weekly),
        ]
        for (phrase, kind, swift) in phrases {
            XCTAssertTrue(judgment.contains("m.includes('\(phrase)')) return '\(kind)'"),
                          "quotaWindow.ts no longer keys \(kind) on \(phrase.debugDescription)")
            XCTAssertEqual(AutoRetryLogic.quotaWindowKind("You've \(phrase) · resets 7pm (UTC)"), swift)
        }
        XCTAssertTrue(judgment.contains("return 'OTHER'"))
        XCTAssertEqual(AutoRetryLogic.quotaWindowKind("You've hit your usage limit."), .other)
    }
}

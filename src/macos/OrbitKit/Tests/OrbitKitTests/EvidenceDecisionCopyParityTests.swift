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
        assertDeclares(web, "DECISION_SEND_BACK_ACTION", EvidenceDecisions.sendBackAction,
                       "the send-back action")
        assertDeclares(web, "DECISION_SEND_ACTION", EvidenceDecisions.sendAction, "the send action")
        assertDeclares(web, "DECISION_NOTE_LABEL", EvidenceDecisions.noteLabel, "the reason's label")
        assertDeclares(web, "DECISION_NOTE_PLACEHOLDER", EvidenceDecisions.notePlaceholder,
                       "the reason's placeholder")
        assertDeclares(web, "DECISION_NO_CLAIM", EvidenceDecisions.noClaim, "the empty-claim line")
        assertDeclares(web, "DECISION_NO_CRITERION", EvidenceDecisions.noCriterion,
                       "the no-criterion line")
        assertDeclares(web, "DECISION_NO_GAPS", EvidenceDecisions.noGaps, "the no-gaps line")
    }

    /// The counted strings, which are templates on one side and interpolations on the other.
    func testCountedLinesMatchTheWebCard() throws {
        let web = try flatWebCard()

        assertContains(web, "`\(template(EvidenceDecisions.gapsMore(7), [("7", "${rest}")]))`",
                       "「还有 N 条」")
        assertContains(web,
                       "`\(template(EvidenceDecisions.gapsHeading(5), [("5", "${row.gaps.length}")]))`",
                       "the gaps heading")
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
}

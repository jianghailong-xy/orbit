import Foundation
import XCTest
@testable import OrbitKit

/// The wires between this logic and the SwiftUI that draws the evidence card on macOS and iOS.
///
/// OrbitKit is UI-free and that is what lets it be tested on Linux — but it also means the rules
/// proved next door (`EvidenceDecisionTests`, `EvidenceDecisionDoorTests`) prove nothing about the
/// card unless the card is actually attached to them. No compiler checks that on this platform:
/// SwiftUI does not exist here, and `ApprovalCards.swift` and `ConsoleModel.swift` are compiled only
/// by the macOS and iOS jobs. So the attachment is asserted the one way it can be from Linux — over
/// the source — and each assertion is written so that DETACHING the wire is what turns it red:
///
///  - every verdict control is disabled by the derived standing, and the send control by the
///    reason as well, so neither a dead card nor a send-back with no note can be pressed;
///  - the standing is re-derived from the console's read on every render and never kept;
///  - the body reads the ROW, through `EvidenceDecisions`;
///  - the console reads the queue with the ruler's reads, delivers only `cardRows`, and presses the
///    door with the request `EvidenceDecisions.request` builds;
///  - an AskUserQuestion is the ordinary question form, whatever its options say.
///
/// This is a weaker instrument than the web card's DOM test and it is used because it is the
/// strongest one available where these tests run. What it cannot see is layout.
final class EvidenceDecisionWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "the evidence card is still wired to OrbitKit."
            }
        }
    }

    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"
    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"

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

    /// One stretch of a file — from a marker to the next occurrence of another — so a match
    /// somewhere else cannot answer for the part being asserted about. (A bare `contains` over a
    /// whole file is how a scan like this goes falsely green.)
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    private func card() throws -> String {
        try section(try source(Self.cardPath),
                    from: "private struct EvidenceDecisionCard: View",
                    to: "private struct EvidenceDecisionFacts: View")
    }

    // MARK: the rule both clients are under

    func testEveryVerdictControlIsDisabledByTheDerivedStanding() throws {
        let card = try card()
        let confirm = try section(card, from: "private func confirmButton",
                                  to: "private func sendBackButton")
        let sendBack = try section(card, from: "private func sendBackButton",
                                   to: "/// The press re-checks")

        XCTAssertTrue(confirm.contains(".disabled(deciding || !standing.answerable)"),
                      "Confirm done must be dead while the standing says the door would refuse it: a lit "
                          + "button that is refused every time it is pressed is the bug this rule "
                          + "was written for")
        XCTAssertTrue(sendBack.contains(".disabled(deciding || !standing.answerable)"),
                      "and so must the answer that hands its reason to the composer")
    }

    /// The second answer is the composer handoff, not a box: the press arms the composer with the
    /// row it is about, and the card keeps no text and no second submit of its own. What the
    /// composer then does with the typed sentence is asserted next door
    /// (`ComposerHandoffWiringTests`).
    func testTheSecondAnswerArmsTheComposerInsteadOfOpeningABox() throws {
        let card = try card()
        let sendBack = try section(card, from: "private func sendBackButton",
                                   to: "/// The press re-checks")

        XCTAssertTrue(sendBack.contains("console.startEvidenceSendBackReply(row)"),
                      "the press must hand the reply to the composer, with the row it was drawn "
                          + "for; without the row there is nothing to answer")
        XCTAssertTrue(sendBack.contains("Text(Approvals.chatAction).approvalActionLabel()"),
                      "the second action must be labelled from the word the other composer "
                          + "handoffs share — not from `EvidenceDecisions.sendBackAction`, which is "
                          + "what the RECORD says about an answer already given")
        // The old box, gone from the card entirely: not a field, not a second submit, and no local
        // reason state. A card that kept one would be a second place to type the same sentence.
        XCTAssertFalse(card.contains("TextField"), "the card must not take text: the composer does")
        XCTAssertFalse(card.contains("EvidenceSendBackState"),
                       "the card holds no reason state — the composer's draft is the reason")
        XCTAssertFalse(card.contains("EvidenceDecisions.sendAction"),
                       "the in-card submit is gone; the composer's own Send is the submit")
        // And the promise, on the card rather than in a tooltip alone: a touch screen never shows
        // a hover.
        XCTAssertTrue(card.contains("Text(EvidenceDecisions.sendBackHint)"),
                      "the card must print what pressing it does not do")
    }

    func testThePressReChecksTheStandingItWasRenderedFrom() throws {
        let press = try section(try card(), from: "private func decide", to: "\n}\n")
        XCTAssertTrue(press.contains("guard let row = standing.row, standing.answerable, !deciding else { return }"),
                      "a race between a render and a tap cannot send an answer the standing says "
                          + "is dead")
        XCTAssertTrue(press.contains("await console.decideEvidence(row, decision)"),
                      "and the one answer this card presses itself is the confirm")
    }

    func testTheStandingIsDerivedOnEveryRenderAndNeverKept() throws {
        let card = try card()
        XCTAssertTrue(card.contains("console.evidenceStanding(taskID, evidenceRevision)"),
                      "the standing is re-derived from the console's read, not stored")
        XCTAssertFalse(card.contains("@State private var standing"),
                       "a frozen frame is the one thing this card may not keep")
        XCTAssertTrue(card.contains("EvidenceDecisions.heading(standing)"),
                      "the heading says which of the standings the reader is looking at")
        XCTAssertTrue(card.contains("EvidenceDecisions.staleExplanation(standing)"),
                      "and a card that cannot be answered says which refusal it would meet")
    }

    func testTheBodyIsReadFromTheRow() throws {
        let file = try source(Self.cardPath)
        let facts = try section(file, from: "private struct EvidenceDecisionFacts: View",
                                to: "private struct DisclosureToggle: View")
        for reading in ["EvidenceDecisions.foldedClaim(row.claim",
                        "EvidenceDecisions.gapPreview(row)",
                        "EvidenceDecisions.checks(row)",
                        "EvidenceDecisions.meta(row)"] {
            XCTAssertTrue(facts.contains(reading), "the card must read \(reading)")
        }
        XCTAssertTrue(try card().contains("if let row = standing.row {"),
                      "and it reads a row only while the read still publishes one")
    }

    // MARK: the console

    func testTheConsoleDeliversOnlyTheRowsTheCardFilterKeeps() throws {
        let console = try source(Self.consolePath)
        let refresh = try section(console, from: "func refreshRulerQuestions(force: Bool = false) async {",
                                  to: "private var settlementHeldOnConfirmation")
        XCTAssertTrue(refresh.contains("guard !isDraft, let projectID, !loadingRuler else { return }"),
                      "a session that coordinates no project makes no read")
        XCTAssertTrue(refresh.contains("api.pendingEvidenceDecisions(decidingSessionID: sessionID)"),
                      "the queue is read with the ruler's reads — the read is what creates a card, "
                          + "so no card on screen can be what drives it")
        XCTAssertTrue(refresh.contains("for row in EvidenceDecisions.cardRows(queue: queue, projectId: projectID) {"),
                      "and only this project's rows that the door would take from here become cards")
        XCTAssertTrue(console.contains("EvidenceDecisions.isOpen(evidenceStanding(taskID, evidenceRevision))"),
                      "the bar stops counting a card that went stale, by OrbitKit's rule")
    }

    /// The arming half of the handoff, on the console's side: the press hands the ROW over and
    /// everything the bar says is built from it — OrbitKit's prefix and OrbitKit's question — so
    /// the words a reader sees while typing are the browser's too
    /// (`EvidenceDecisionCopyParityTests`). What the send then does with them is asserted next door
    /// (`ComposerHandoffWiringTests`).
    func testTheArmingPressNamesTheVersionItIsAbout() throws {
        let console = try source(Self.consolePath)
        let arm = try section(console, from: "func startEvidenceSendBackReply(",
                              to: "/// Talk about a plan before the project is started on it")

        XCTAssertTrue(arm.contains("target: .evidenceDecision(row)"),
                      "the armed reply carries the row: the send that follows needs its address, "
                          + "and the reconcile needs to re-derive its standing")
        XCTAssertTrue(arm.contains("banner: EvidenceDecisions.sendingBackPrefix + row.title"),
                      "the bar names the task the evidence is about")
        XCTAssertTrue(arm.contains("placeholder: EvidenceDecisions.sendBackLabel"),
                      "and the composer asks for the reason the door requires")
    }

    func testThePressGoesToTheDoorAsTheRequestOrbitKitBuilds() throws {
        let console = try source(Self.consolePath)
        let press = try section(console, from: "func decideEvidence(",
                                to: "/// Confirm the standard set as it stands.")
        XCTAssertTrue(press.contains("guard let request = EvidenceDecisions.request(row: row, decision: decision, note: note,"),
                      "nothing is sent that OrbitKit would not build — and a send-back with no "
                          + "reason builds nothing")
        XCTAssertTrue(press.contains("decidingSessionID: sessionID) else { return }"),
                      "the answer is given FROM this session, which the door checks for independence")
        XCTAssertTrue(press.contains("api.decideEvidence(taskID: row.taskId, request)"))
    }

    // MARK: the receipt, which is a record rather than a question

    /// THE RECORD IS DRAWN FROM THE READ, NOT FROM THE WINDOW THAT PRESSED THE BUTTON.
    ///
    /// A receipt used to be an in-memory line written by the console that pressed
    /// (`appendDecisionLine(EvidenceDecisions.recordedLine(…))`) — so opening the console again, or
    /// relaunching the app, took the decision out of the conversation; the account owner reported
    /// exactly that (about the criteria receipt, on the web client, 2026-09-16). The answers are
    /// committed rows the pending read publishes for the deciding session, so the console derives
    /// the receipts from them on every refresh and lets go of each revision the read names.
    func testTheConsoleDerivesEvidenceReceiptsFromTheReadAndLetsTheAnsweredQuestionGo() throws {
        let console = try source(Self.consolePath)
        XCTAssertTrue(console.contains("EvidenceDecisions.receipts(queue: queue)"),
                      "the receipts are derived from the read's own answers")
        XCTAssertTrue(console.contains("placement: .at(receipt.moment)"),
                      "each carrying the door's own clock — the transcript resolves the row at "
                      + "render time")
        XCTAssertTrue(console.contains("kind: .evidenceDecisionReceipt(decided: receipt.decided)"),
                      "and delivered as rows of their own, carrying the answer they record")
        let press = try section(console, from: "func decideEvidence", to: "func confirmStandardSet")
        XCTAssertFalse(press.contains("appendDecisionLine"),
                       "a decision recorded from a card no longer leaves an in-memory line behind it")
    }

    /// The receipt card says what it is and what happened, and offers nothing to press.
    func testTheEvidenceReceiptCardIsARecordWithNoActions() throws {
        let card = try section(try source(Self.cardPath),
                               from: "private struct EvidenceDecisionReceiptCard: View",
                               to: "private struct AcceptanceConfirmationCard: View")
        XCTAssertTrue(card.contains("decided.recordedByAgent ? EvidenceDecisions.agentRecordedHeading"),
                      "the heading says whether the owner pressed a card or a run of the session "
                          + "reached the door")
        XCTAssertTrue(card.contains("EvidenceDecisions.receiptLine(decided)"),
                      "and the line is OrbitKit's, from the answer the row carries")
        XCTAssertFalse(card.contains("ApprovalActions"), "a record has no answers left to offer")
        XCTAssertFalse(card.contains("confirmButton"),
                       "and no button that would send a second decision to the door")
    }

    // MARK: one entry for one question

    func testAnAskUserQuestionIsTheOrdinaryFormAndTheCardIsADeliveredOne() throws {
        let file = try source(Self.cardPath)
        XCTAssertTrue(file.contains("case .question: QuestionCard(console: console, approval: approval)"),
                      "every AskUserQuestion renders as the form, including one whose options read "
                          + "Confirm completion / Send back")
        for gone in ["EvidenceDecisions.rows(", "QuestionApprovalCard", "loadPendingDecisions"] {
            XCTAssertFalse(file.contains(gone), "no question is taken for the evidence card: \(gone)")
        }
        let delivered = try section(file, from: "struct DeliveredDecisionCardView: View",
                                    to: "private struct CriteriaDecisionCard: View")
        XCTAssertTrue(delivered.contains("case .evidenceDecision(let taskID, let evidenceRevision):"))
        XCTAssertTrue(delivered.contains("EvidenceDecisionCard(console: console, taskID: taskID,"),
                      "the card is drawn from its delivered address")
    }
}

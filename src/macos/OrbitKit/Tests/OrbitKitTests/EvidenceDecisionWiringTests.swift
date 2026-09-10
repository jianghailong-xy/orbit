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
                                   to: "private func reasonBox")
        let reason = try section(card, from: "private func reasonBox", to: "private func decide")

        XCTAssertTrue(confirm.contains(".disabled(deciding || !standing.answerable)"),
                      "确认完成 must be dead while the standing says the door would refuse it: a lit "
                          + "button that is refused every time it is pressed is the bug this rule "
                          + "was written for")
        XCTAssertTrue(sendBack.contains(".disabled(deciding || !standing.answerable)"),
                      "and so must 退回重做, which opens the reason box")
        XCTAssertTrue(reason.contains(".disabled(deciding || !standing.answerable || !sendBack.canSend)"),
                      "the send control is dead without a reason as well — the door refuses a "
                          + "SEND_BACK with no note and writes nothing at all")
        XCTAssertTrue(reason.contains("decide(standing, .sendBack, note: sendBack.trimmedNote)"),
                      "and what it sends is the trimmed reason the state vouches for")
    }

    func testThePressReChecksTheStandingItWasRenderedFrom() throws {
        let press = try section(try card(), from: "private func decide", to: "\n}\n")
        XCTAssertTrue(press.contains("guard let row = standing.row, standing.answerable, !deciding else { return }"),
                      "a race between a render and a tap cannot send an answer the standing says "
                          + "is dead")
        XCTAssertTrue(press.contains("await console.decideEvidence(row, decision, note: note)"))
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

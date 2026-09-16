import Foundation
import XCTest
@testable import OrbitKit

/// WHERE the owner-confirmation card is drawn — the one thing about it that was wrong on the phone
/// while every derivation around it was right.
///
/// The account owner, on beta v0.1.2-beta.77 (2026-09-16), read this in an iOS session:
///
///     ↑ Your question …
///     [ Confirm this task is done?  WHAT THE RUN REPORTED … ]
///     Thought · 864 chars
///     <the run's report — the very text the card is quoting>
///
/// and this in the browser, at the same instant: the report, then the card. The card asks "confirm
/// this?" about something the reader has not reached yet.
///
/// Nothing derived it wrongly. The card is delivered by `ConsoleModel.refreshOwnerConfirmation`,
/// which the CONTROL PLANE triggers: `adoptServerSnapshot` re-reads the moment the run's row moves,
/// and that snapshot beats this turn's own transcript rows to the device. Every delivered card used
/// to anchor to "the item that was last when I arrived", so the card froze onto the owner's question
/// — the only row that had arrived — and the report then rendered below it.
///
/// The fix is `DeliveryAnchor`: an unanswered confirmation follows the TAIL, which is what the
/// browser has always done (`WorkspaceView.tsx` draws `SessionOwnerConfirmationCard` in a fixed slot
/// after the transcript, re-derived every render). These tests are the Linux-runnable half of that —
/// layout is what the beta and the owner's screenshot are for; ORDER is what this file settles.
final class OwnerConfirmationPlacementTests: XCTestCase {

    // MARK: the turn from the screenshot, as rows

    private let taskID = "34PmyC7rh8Lfjjh3L48Qx"
    private let requestID = "req-77"

    private func question(_ id: String) -> TranscriptItem {
        .user(UserBubble(id: id, text: "把它做完", pending: false, queued: false))
    }

    private func thought(_ id: String) -> TranscriptItem {
        .thinking(ThinkingBlock(id: id, text: "…", streamingText: "", seq: 2))
    }

    /// The row the card is asking about: the run's last message, the one it reported.
    private func report(_ id: String) -> TranscriptItem {
        .assistant(AssistantBubble(id: id, text: "Done — the gate is green.", streamingText: "",
                                   seq: 3, turnId: "t1", ts: "2026-09-16T11:17:04.000Z"))
    }

    private func state(_ items: [TranscriptItem]) -> TranscriptState {
        var s = TranscriptState()
        s.items = items
        return s
    }

    /// The card as the console would deliver it at this instant: the kind, anchored by the one rule
    /// that decides where a delivered card goes. Going through `DeliveryAnchor` rather than writing
    /// an anchor in by hand is the point of these tests — it is the thing that was wrong.
    private func deliveredNow(_ kind: DeliveredDecisionCard.Kind,
                              into items: [TranscriptItem]) -> DeliveredDecisionCard {
        DeliveredDecisionCard(kind: kind, afterItemID: DeliveryAnchor.onArrival(of: kind,
                                                                               items: items))
    }

    private func rows(items: [TranscriptItem], cards: [DeliveredDecisionCard],
                      working: Bool = false) -> [String] {
        TranscriptRows.build(state: state(items), statusCards: [], canPageOlder: false,
                             showWorkingIndicator: working, decisionCards: cards).map(\.id)
    }

    private var cardID: String { "owner-confirmation-\(taskID)@\(requestID)" }

    private func confirmation() -> DeliveredDecisionCard.Kind {
        .ownerConfirmation(taskID: taskID, requestID: requestID)
    }

    // MARK: the two orders the read can arrive in

    /// The benign timing: the turn's rows are already in when the read comes back. The card belongs
    /// under the report, and did even before this change.
    func testACardDeliveredAfterTheTurnsRowsSitsUnderTheReport() {
        let items = [question("i1"), thought("i2"), report("i3")]
        let card = deliveredNow(confirmation(), into: items)
        XCTAssertEqual(rows(items: items, cards: [card]),
                       ["i1", "i2", "i3", cardID, "transcript-bottom"])
    }

    /// The defect, in its own timing: the control plane's snapshot arrives first, so the read is
    /// answered while the transcript still holds nothing but the owner's question — and the thought
    /// and the report land afterwards. The card must STILL be under the report.
    ///
    /// This is the case that was red. Anchoring at delivery froze the card onto `i1` and the two
    /// rows that arrived next rendered below it, which is exactly the screenshot.
    func testACardDeliveredBeforeTheTurnsRowsStillSitsUnderTheReport() {
        // What the transcript held when the snapshot triggered the read.
        let atDelivery = [question("i1")]
        let card = deliveredNow(confirmation(), into: atDelivery)
        // What it holds by the time the frame is drawn.
        let items = [question("i1"), thought("i2"), report("i3")]
        XCTAssertEqual(rows(items: items, cards: [card]),
                       ["i1", "i2", "i3", cardID, "transcript-bottom"])
    }

    /// The extreme of the same timing — the read beats every row, including the owner's own line.
    /// A card with nothing to anchor to is the case `build` already trailed; it must not have become
    /// a leading row now that trailing is deliberate rather than a fallback.
    func testACardDeliveredIntoAnEmptyTranscriptStillSitsUnderWhatArrives() {
        let card = deliveredNow(confirmation(), into: [])
        XCTAssertEqual(rows(items: [question("i1"), report("i2")], cards: [card]),
                       ["i1", "i2", cardID, "transcript-bottom"])
    }

    /// And it keeps following: a reply that arrives while the owner is still deciding goes ABOVE the
    /// card, not below it. That is what "follows the tail" buys over "anchored at the last row" —
    /// web's card cannot be overtaken either, because it is re-derived into a fixed slot.
    func testTheCardStaysBelowEveryRowThatArrivesWhileItWaits() {
        let card = deliveredNow(confirmation(), into: [question("i1")])
        XCTAssertEqual(rows(items: [question("i1"), report("i2")], cards: [card]).last(where: {
            $0 != "transcript-bottom"
        }), cardID)
    }

    /// Where it sits among the tail's other rows: below the history, above the live turn. A run the
    /// owner sent back keeps working under the card rather than pushing it around, the same order
    /// `TranscriptRows.build` gives every trailing question.
    func testTheCardTrailsTheHistoryAndTheWorkingIndicatorTrailsIt() {
        let items = [question("i1"), report("i2")]
        let card = deliveredNow(confirmation(), into: [question("i1")])
        XCTAssertEqual(rows(items: items, cards: [card], working: true),
                       ["i1", "i2", cardID, "working-indicator", "transcript-bottom"])
    }

    // MARK: what this change may not take with it

    /// The other delivered cards sit where they ARRIVED, on purpose: a proposal delivered an hour
    /// ago must not walk back down to the tail every time somebody speaks, which is what the
    /// "N open questions below" bar points up at. Only the confirmation's arrival is somebody
    /// else's clock, so only the confirmation moved.
    func testTheOtherDeliveredQuestionsStillStayWhereTheyArrived() {
        let atDelivery = [question("i1")]
        let items = [question("i1"), report("i2")]
        let criteria = deliveredNow(.criteriaDecision(intentID: "in-1"), into: atDelivery)
        let evidence = deliveredNow(.evidenceDecision(taskID: taskID, evidenceRevision: "2"),
                                    into: atDelivery)
        let settlement = deliveredNow(.acceptanceConfirmation, into: atDelivery)
        XCTAssertEqual(criteria.afterItemID, "i1")
        XCTAssertEqual(evidence.afterItemID, "i1")
        XCTAssertEqual(settlement.afterItemID, "i1")
        XCTAssertEqual(rows(items: items, cards: [criteria, evidence, settlement]),
                       ["i1", "criteria-decision-in-1", "evidence-decision-\(taskID)@2",
                        "acceptance-confirmation", "i2", "transcript-bottom"])
    }

    /// The receipt of an ANSWERED confirmation is a record of something that happened, not a
    /// question waiting: it is drawn where the reader was when the decision was made and stays
    /// there. Following the tail would walk one decision's record down past the next one's.
    func testAnAnsweredConfirmationsReceiptKeepsThePlaceItWasGiven() {
        let atDelivery = [question("i1")]
        let receipt = deliveredNow(.ownerDecisionReceipt(taskID: taskID, decisionID: "d1"),
                                   into: atDelivery)
        XCTAssertEqual(receipt.afterItemID, "i1")
        XCTAssertEqual(rows(items: [question("i1"), report("i2")], cards: [receipt]),
                       ["i1", "owner-decision-receipt-\(taskID)@d1", "i2", "transcript-bottom"])
    }

    /// A newer report while an older decision's receipt is on screen: the receipt keeps its place up
    /// in the conversation and the new question trails below everything. Both halves of the rule at
    /// once, in the order a reader would have lived through them.
    func testAReceiptAboveAndTheNextQuestionBelowInOneTranscript() {
        let receipt = deliveredNow(.ownerDecisionReceipt(taskID: taskID, decisionID: "d1"),
                                   into: [question("i1")])
        let next = deliveredNow(confirmation(), into: [question("i1"), report("i2")])
        XCTAssertEqual(rows(items: [question("i1"), report("i2"), report("i3")],
                            cards: [receipt, next]),
                       ["i1", "owner-decision-receipt-\(taskID)@d1", "i2", "i3", cardID,
                        "transcript-bottom"])
    }

    // MARK: the wire from the console to the rule

    /// The rule above decides nothing unless the console asks it. `ConsoleModel.swift` is compiled
    /// only by the macOS and iOS jobs — SwiftUI does not exist on Linux — so the attachment is
    /// asserted over the source, the way `CriteriaDecisionWiringTests` does, and written so that
    /// putting the frozen anchor back is what turns it red.
    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found. If it moved, move this check with it rather than "
                    + "deleting it: it is the only gate on Linux that sees whether the confirmation "
                    + "card is still placed by DeliveryAnchor instead of frozen at delivery."
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

    /// One function's own body, so a match 700 lines away cannot answer for it — a bare `contains`
    /// over a whole file is how a scan like this goes falsely green. `appendDecisionLine` further
    /// down legitimately anchors a local line at `state.items.last?.id`, and must not be read as
    /// this one.
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"

    func testTheConsoleAnchorsADeliveredCardThroughTheRuleAndNotTheFrozenTail() throws {
        let body = try section(try source(Self.consolePath),
                               from: "private func deliver(_ kind: DeliveredDecisionCard.Kind) {",
                               to: "private func deliver(_ kind: DeliveredDecisionCard.Kind, "
                                   + "anchoredAt")
        XCTAssertTrue(body.contains("DeliveryAnchor.onArrival(of: kind, items: state.items)"),
                      "the one-argument deliver() must ask DeliveryAnchor where the card goes")
        XCTAssertFalse(body.contains("state.items.last?.id"),
                       "anchoring a delivery at the tail as it stands is the defect itself: the "
                       + "control plane's read arrives before this turn's rows do")
    }

    /// The confirmation is delivered by the plain `deliver(_:)` — the one the rule runs inside —
    /// rather than by the two-argument form, which exists for a record that carries its own moment.
    /// Passing an anchor here would route around `DeliveryAnchor` without changing it.
    func testTheConfirmationIsDeliveredWithoutAnAnchorOfItsOwn() throws {
        let body = try section(try source(Self.consolePath),
                               from: "func refreshOwnerConfirmation(force: Bool = false) async {",
                               to: "func ownerStanding(")
        XCTAssertTrue(
            body.contains("deliver(.ownerConfirmation(taskID: taskID, requestID: waiting.requestId))"),
            "the waiting question is delivered by the anchor-less deliver(_:)")
        XCTAssertFalse(body.contains("anchoredAt:"),
                       "an anchor spelled in here would route around the rule above")
    }
}

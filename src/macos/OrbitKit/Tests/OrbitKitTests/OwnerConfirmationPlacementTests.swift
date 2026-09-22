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
    private func report(_ id: String, ts: String = "2026-09-16T11:17:04.000Z") -> TranscriptItem {
        .assistant(AssistantBubble(id: id, text: "Done — the gate is green.", streamingText: "",
                                   seq: 3, turnId: "t1", ts: ts))
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
        DeliveredDecisionCard(kind: kind,
                              placement: .onArrival(afterItemID: DeliveryAnchor.onArrival(
                                  of: kind, items: items)))
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
        XCTAssertEqual(criteria.placement, .onArrival(afterItemID: "i1"))
        XCTAssertEqual(evidence.placement, .onArrival(afterItemID: "i1"))
        XCTAssertEqual(settlement.placement, .onArrival(afterItemID: "i1"))
        XCTAssertEqual(rows(items: items, cards: [criteria, evidence, settlement]),
                       ["i1", "criteria-decision-in-1", "evidence-decision-\(taskID)@2",
                        "acceptance-confirmation", "i2", "transcript-bottom"])
    }

    // MARK: the record of an answer, where it was MADE

    private static let reportSession = "34JbyLO3TvHgOmBBHLgZu"
    private var receiptID: String { "owner-decision-receipt-\(taskID)@d1" }

    private func decision(_ id: String, at stamp: String,
                          sessionId: String? = reportSession) -> RecordedOwnerDecision {
        RecordedOwnerDecision(id: id, decision: .confirm, decidedAt: stamp, requestId: requestID,
                              sessionId: sessionId)
    }

    private func read(_ decisions: [RecordedOwnerDecision]) -> OwnerConfirmationView {
        OwnerConfirmationView(taskId: taskID, title: "把确认卡接到原生端", status: "OPEN",
                              projectId: nil, completionCriterion: "OWNER_CONFIRMED",
                              acceptanceCriteria: "原生端能确认，且与 web 同一句话。",
                              waiting: nil, decisions: decisions)
    }

    /// The card the console adopts for a receipt, built the way `adoptOwnerReceipts` builds it: the
    /// address the card re-derives itself from, and the moment the transcript places it by.
    private func card(_ receipt: OwnerConfirmations.Receipt) -> DeliveredDecisionCard {
        DeliveredDecisionCard(kind: .ownerDecisionReceipt(taskID: receipt.taskId,
                                                          decisionID: receipt.decided.id),
                              placement: .at(receipt.moment))
    }

    /// The record of an ANSWERED confirmation is a record of something that happened, not a question
    /// waiting: it goes where it happened. The report it is about carries the clock before it, so
    /// the receipt lands under that REPORT — and above a row that arrived later, which is what tells
    /// the two rules apart: the last row loaded at this instant is i4, and a record placed by when
    /// it was read would sit under that instead.
    func testAnAnsweredReportsReceiptIsDrawnWhereTheDecisionWasMade() {
        let items = [question("i1"), thought("i2"), report("i3"),
                     report("i4", ts: "2026-09-16T12:00:00.000Z")]
        // The press that answered i3's report: seconds after the report's own clock, an hour before
        // the next row's.
        let receipts = OwnerConfirmations.receipts(read([decision("d1", at: "2026-09-16T11:17:05.000Z")]),
                                                   sessionID: Self.reportSession)
        XCTAssertEqual(receipts.map(\.moment), ["2026-09-16T11:17:05.000Z"])
        XCTAssertEqual(receipts.map(\.id), [receiptID])
        XCTAssertEqual(rows(items: items, cards: receipts.map(card)),
                       ["i1", "i2", "i3", receiptID, "i4", "transcript-bottom"])
    }

    /// THE SCREENSHOT'S CASE, corrected 2026-09-22. The conversation ran for a day after the
    /// decisions; this console holds only the tail of it, so every clocked row is LATER than the
    /// decision. It used to be dropped — "no honest place" — and the console that had adopted it
    /// earlier kept it, frozen to a row the window then trimmed, so it trailed at the BOTTOM of the
    /// conversation. Now it leads at the HEAD of the window: as close to where it happened as this
    /// device can get, and the load-earlier row below it pages the window back to the row itself.
    func testADecisionOlderThanEveryLoadedRowLeadsAtTheHeadAndNotAtTheTail() {
        let items = [question("i1"), thought("i2"), report("i3")]
        let receipts = OwnerConfirmations.receipts(
            read([decision("d1", at: "2026-09-15T09:00:00.000Z")]),
            sessionID: Self.reportSession)
        XCTAssertEqual(receipts.map(\.moment), ["2026-09-15T09:00:00.000Z"])
        XCTAssertEqual(rows(items: items, cards: receipts.map(card)),
                       [receiptID, "i1", "i2", "i3", "transcript-bottom"])
    }

    /// A newer report while an older decision's receipt is on screen: the receipt keeps its place up
    /// in the conversation and the next question trails below everything. Both halves of the rule at
    /// once, in the order a reader would have lived through them — a record is placed by its own
    /// moment, a question by what it is about.
    func testAReceiptAboveAndTheNextQuestionBelowInOneTranscript() {
        let items = [question("i1"), thought("i2"), report("i3")]
        let receipts = OwnerConfirmations.receipts(read([decision("d1", at: "2026-09-16T11:17:05.000Z")]),
                                                   sessionID: Self.reportSession)
        // i4 arrives AFTER the press — its own clock says so, which is what keeps it below the
        // record now that the row is resolved against every loaded row rather than against the
        // three this device happened to hold when the read came back.
        let later = report("i4", ts: "2026-09-16T12:00:00.000Z")
        let next = deliveredNow(confirmation(), into: items + [later])
        XCTAssertEqual(rows(items: items + [later], cards: receipts.map(card) + [next]),
                       ["i1", "i2", "i3", receiptID, "i4", cardID, "transcript-bottom"])
    }

    /// A decision that answered ANOTHER session's run belongs to that session and never to this one,
    /// whatever the clock says — the same filter the question card is under (`receiptsIn`).
    func testAReceiptForAnotherSessionsRunIsNotDrawnHere() {
        let items = [question("i1"), thought("i2"), report("i3")]
        XCTAssertEqual(
            OwnerConfirmations.receipts(read([decision("d1", at: "2026-09-16T11:17:05.000Z",
                                                       sessionId: "34AnotherSession")]),
                                        sessionID: Self.reportSession),
            [])
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

    /// And the third thing the same read does: the owner's RECEIPTS are adopted by their own moment
    /// rather than handed to the delivery path. Delivered, they anchor to what was last when THIS
    /// device's read came back, which is the stack at the bottom of the 2026-09-20 screenshot; the
    /// rule that places them is `OwnerConfirmations.receipts`, and this is the only gate that sees
    /// whether the console still asks it.
    func testTheOwnerReceiptsAreAdoptedByTheirMomentAndNotDelivered() throws {
        let source = try source(Self.consolePath)
        let refresh = try section(source,
                                  from: "func refreshOwnerConfirmation(force: Bool = false) async {",
                                  to: "func ownerStanding(")
        XCTAssertTrue(refresh.contains("adoptOwnerReceipts(read)"),
                      "the read no longer draws its receipts where they were made")
        XCTAssertFalse(refresh.contains("deliver(.ownerDecisionReceipt"),
                       "delivering a receipt anchors it to the moment this device read the answer, "
                       + "which is what piled three of them at the bottom of the conversation")

        let adopt = try section(source, from: "private func adoptOwnerReceipts(",
                                to: "/// Where one delivered proposal stands right now")
        XCTAssertTrue(adopt.contains("OwnerConfirmations.receipts(read, sessionID: sessionID)"),
                      "the receipt's place is the door's own clock, and the console has to ask for it")
        XCTAssertTrue(adopt.contains("placement: .at(receipt.moment)"),
                      "the adopted row must carry the door's own clock for the transcript to "
                      + "resolve against the rows it holds at render time — a captured row id is "
                      + "what the trimmed window outlives")
    }
}

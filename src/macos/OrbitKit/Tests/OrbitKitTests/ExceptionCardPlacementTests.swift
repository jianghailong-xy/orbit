import Foundation
import XCTest
@testable import OrbitKit

/// WHERE AN EXCEPTION CARD IS DRAWN — the sibling of `PromotionReceiptPlacementTests`, and the same
/// complaint one card over.
///
/// An item that became the owner's was a delivered card, and a delivered card anchors where it
/// ARRIVED. Its arrival is not its own: a task failed or a clock ran out, and the read that
/// publishes the item runs later still — on a console opened afterwards, at the tail. So a card
/// reading `waiting 34m` was drawn under the newest message in the conversation, which is where the
/// things that are true NOW go: the card's own clock and the card's own place telling the reader two
/// different stories about when it happened (the account owner's iOS screenshot, 2026-09-22, and the
/// mock it produced, `docs/mocks/escalated-card-placement.html`).
///
/// What these tests settle is WHERE the card lands and what it falls back to: the item's own moment
/// — `escalatedAt` where the read names one, `waitingSince` where it does not — resolved against the
/// rows' clocks by the rule the five records are placed by (`ReceiptAnchor`), the same rule web
/// applies (`exceptionCardRows` → `decisionReceiptAnchor`). Layout is the beta's and the owner's
/// screenshot's to judge; ORDER is what this file settles.
final class ExceptionCardPlacementTests: XCTestCase {

    // MARK: the fixture

    private func item(_ id: String, at stamp: String) -> TranscriptItem {
        .user(UserBubble(id: id, text: "…", ts: stamp, pending: false, queued: false))
    }

    private func state(_ items: [TranscriptItem]) -> TranscriptState {
        var s = TranscriptState()
        s.items = items
        return s
    }

    private func rows(items: [TranscriptItem], cards: [DeliveredDecisionCard],
                      canPageOlder: Bool = false) -> [String] {
        TranscriptRows.build(state: state(items), statusCards: [], canPageOlder: canPageOlder,
                             showWorkingIndicator: false, decisionCards: cards).map(\.id)
    }

    /// One open item, as the read serves it (§7.5). The two stamps are the whole point of most of
    /// these cases, so every one of them is named at the call site.
    private func openItem(_ id: String, kind: ProjectOpenItemKind = .taskFailed,
                          waitingSince: String, escalatedAt: String?,
                          reason: ProjectOpenItemAssigneeReason = .escalated) -> ProjectOpenItemRow {
        ProjectOpenItemRow(itemId: id, kind: kind, title: "Task failed: the WARC dependency",
                           waitingSince: waitingSince, assignee: .owner, assigneeReason: reason,
                           escalatedAt: escalatedAt)
    }

    /// The row the console delivers for an exception, built the way `refreshRulerQuestions` builds
    /// it: the item's own moment, against the transcript as it stands at delivery.
    private func card(_ row: ProjectOpenItemRow, items: [TranscriptItem]) -> DeliveredDecisionCard {
        DeliveredDecisionCard(kind: .escalatedItem(itemID: row.itemId),
                              placement: DeliveryAnchor.exception(row, items: items))
    }

    /// A conversation that outlived the escalation: it became the owner's between `i2` and `i3`, so
    /// the last row loaded is NOT where it belongs.
    private func transcript() -> [TranscriptItem] {
        [item("i1", at: "2026-09-22T09:00:00.000Z"),
         item("i2", at: "2026-09-22T09:25:00.000Z"),
         item("i3", at: "2026-09-22T10:00:00.000Z")]
    }

    private let escalated = "2026-09-22T09:30:00.000Z"

    // MARK: (a) where it became the owner's

    /// The card is drawn where the item BECAME THE OWNER'S, and `i3` — which arrived after it — stays
    /// below: that is what tells the moment rule apart from the arrival rule it replaces.
    func testAnExceptionIsDrawnWhereItBecameTheOwnersAndNotAtTheTail() {
        let items = transcript()
        let row = openItem("ex-1", waitingSince: "2026-09-22T07:00:00.000Z",
                           escalatedAt: escalated)

        XCTAssertEqual(rows(items: items, cards: [card(row, items: items)]),
                       ["i1", "i2", "open-item-ex-1", "i3", "transcript-bottom"])
    }

    /// An item that was never the coordinator's — a project with no coordinator lands one straight
    /// on the owner — has no escalation instant, and the moment it opened is what places it.
    func testAnItemThatNeverEscalatedIsPlacedByWhenItOpened() {
        let items = transcript()
        let row = openItem("ex-2", waitingSince: escalated, escalatedAt: nil,
                           reason: .noCoordinator)

        XCTAssertEqual(ExceptionCards.moment(row), escalated)
        XCTAssertEqual(rows(items: items, cards: [card(row, items: items)]),
                       ["i1", "i2", "open-item-ex-2", "i3", "transcript-bottom"])
    }

    /// The moment is the escalation and not the wait: the same item with its escalation two hours
    /// earlier belongs two rows earlier, even though nothing else about it changed.
    func testTheWaitIsNotWhatPlacesTheCard() {
        let items = transcript()
        let row = openItem("ex-3", waitingSince: "2026-09-22T07:00:00.000Z",
                           escalatedAt: "2026-09-22T08:30:00.000Z")

        XCTAssertEqual(rows(items: items, cards: [card(row, items: items)]),
                       ["open-item-ex-3", "i1", "i2", "i3", "transcript-bottom"],
                       "a wait older than the whole window put the card above it — the escalation "
                           + "is what the card is about, and it happened inside the conversation")
    }

    // MARK: (b) the two answers a moment can fail to give

    /// Older than every loaded row: drawn at the HEAD of the window — as close to where it happened
    /// as this device can get, and it walks down into place as older pages arrive. NOT at the tail,
    /// which is where the cards that are true NOW go and where this one used to pile up.
    func testAMomentOlderThanTheWindowLeadsTheHead() {
        let items = transcript()
        let row = openItem("ex-4", waitingSince: "2026-09-22T06:00:00.000Z",
                           escalatedAt: "2026-09-22T06:30:00.000Z")
        let cards = [card(row, items: items)]

        XCTAssertEqual(rows(items: items, cards: cards, canPageOlder: true),
                       ["open-item-ex-4", "load-older-0", "i1", "i2", "i3", "transcript-bottom"],
                       "and above the load-earlier row, so the way up to older rows is not hidden "
                           + "by the card that is older than all of them")
    }

    /// A stamp no clock can parse: the card goes where it arrived. Unlike a record — which has a row
    /// of its own to be read from, and is dropped rather than drawn in the wrong place — this is a
    /// question still waiting on the reader, and the only thing on screen that can be pressed.
    func testAStampNoClockCanParseFallsBackToWhereTheCardArrived() {
        let items = transcript()
        let row = openItem("ex-5", waitingSince: "not a stamp", escalatedAt: nil)

        XCTAssertEqual(DeliveryAnchor.exception(row, items: items),
                       .onArrival(afterItemID: "i3"))
        XCTAssertEqual(rows(items: items, cards: [card(row, items: items)]),
                       ["i1", "i2", "i3", "open-item-ex-5", "transcript-bottom"])
    }

    // MARK: (c) the card that asks for a merge keeps the rule it has

    /// The exception rule is for the two cards whose moment IS the item's own: the merge a person is
    /// asked to approve still arrives the way a question does — what it is about happened before the
    /// read found it — so it anchors where it arrived and this change did not move it.
    func testAMergeApprovalStillAnchorsWhereItArrived() {
        let items = transcript()
        XCTAssertEqual(DeliveryAnchor.onArrival(of: .promotionApproval(promotionID: "pr-1"),
                                                items: items),
                       "i3")
    }
}

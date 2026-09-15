import Foundation
import XCTest
@testable import OrbitKit

/// The screenshot this work started from: a wake a watch queued, drawn on iOS as a message the user
/// had typed — a raw UUID on the first line, the sentence saying a watch queued it, and the whole
/// JSON payload as the body, filling the phone. Nothing on either client read that text as anything
/// but prose, because nothing on this end read it at all.
///
/// These are the two halves of the fix: reading the message the delivery worker writes, and the card
/// the reading becomes. `WatchWakeCopyParityTests` is what holds the words to the browser's.
final class WatchWakeTests: XCTestCase {
    private typealias F = WatchFixture
    private let now = WatchFixture.now

    // MARK: reading the turn

    func testReadsAMatchWakeAndWhatChanged() throws {
        let wake = try XCTUnwrap(WatchWakeText.parse(F.matchWake()))
        XCTAssertEqual(wake.watchId, F.wakeWatchID)
        XCTAssertEqual(wake.kind, .matched)
        XCTAssertEqual(wake.generation, 1)
        XCTAssertEqual(wake.reason, F.wakeReason)
        XCTAssertEqual(wake.changedTargets,
                       [WatchWakeTarget(kind: .task, id: F.wakeTaskID, state: "SATISFIED", status: "FAILED")])
    }

    /// A CONTINUOUS watch's last wake puts a line between the head and the mark. The head is one
    /// line, not the first paragraph, so that extra sentence doesn't hide the whole wake.
    func testReadsTheLastWakeOfAContinuousBudget() throws {
        let reason = "ANY TASK_PROGRESS_AT_LEAST(5) 1/1; 2 crossings since 2026-09-14T11:58:40.000Z; wake 5 of 5"
        let wake = try XCTUnwrap(WatchWakeText.parse(
            F.matchWake(generation: 5, reason: reason, changed: [], last: true)))
        XCTAssertEqual(wake.generation, 5)
        XCTAssertEqual(wake.reason, reason)
        XCTAssertTrue(wake.changedTargets.isEmpty)
    }

    func testReadsTheThreeUnmatchedEnds() throws {
        XCTAssertEqual(WatchWakeText.parse(F.expiryWake())?.kind, .expired)
        for end in ["REVOKED", "UNRESOLVABLE"] {
            let wake = try XCTUnwrap(WatchWakeText.parse(F.endWake(end)), end)
            XCTAssertEqual(wake.kind.rawValue, end)
            // None of the three is a Match, so neither a generation nor a reason is claimed.
            XCTAssertNil(wake.generation, end)
            XCTAssertNil(wake.reason, end)
            XCTAssertTrue(wake.changedTargets.isEmpty, end)
        }
    }

    /// All three parts have to be there and agree, so a person quoting one of them keeps their own
    /// bubble — which is the whole reason the server writes the mark at all.
    func testLeavesAPersonTheirOwnBubbleWhenAnyPartIsMissingOrDisagrees() {
        let text = F.matchWake()
        // The head line alone: no payload.
        XCTAssertNil(WatchWakeText.parse(String(text.prefix(while: { $0 != "`" }))))
        XCTAssertNil(WatchWakeText.parse(
            text.replacingOccurrences(of: "This turn was queued by the watch", with: "I queued this")))
        // A payload naming another watch is not this turn's.
        XCTAssertNil(WatchWakeText.parse(F.matchWake(payloadWatchID: "another")))
        XCTAssertNil(WatchWakeText.parse("Orbit Watch is great\n\n\(F.fenced(["watchId": "x"]))"))
        XCTAssertNil(WatchWakeText.parse("look at what the watch said:\n\n\(text)"))
        XCTAssertNil(WatchWakeText.parse(""))
    }

    // MARK: the card it becomes

    func testTheCardNamesWhatHappenedAndWhyForEveryKind() throws {
        let titles = WatchWakeKind.allCases.map(WatchWakeCard.title)
        XCTAssertEqual(titles, ["Watch triggered", "Watch expired", "Watch stopped: access lost",
                                "Watch stopped: every target is gone"])
        // Each end says, in its own words, that this session will not be woken by it again.
        for kind in WatchWakeKind.allCases where kind != .matched {
            let wake = WatchWake(watchId: "w", kind: kind, generation: nil, reason: nil, changedTargets: [])
            XCTAssertFalse(WatchWakeCard.why(wake).isEmpty, kind.rawValue)
        }
        let expired = try XCTUnwrap(WatchWakeText.parse(F.expiryWake()))
        XCTAssertEqual(WatchWakeCard.why(expired),
                       "Its deadline passed before its condition held. It will not wake this session again.")
        let revoked = try XCTUnwrap(WatchWakeText.parse(F.endWake("REVOKED")))
        XCTAssertEqual(WatchWakeCard.why(revoked),
                       "This account can no longer read one of its targets, so it reports nothing about them.")
        let unresolvable = try XCTUnwrap(WatchWakeText.parse(F.endWake("UNRESOLVABLE")))
        XCTAssertEqual(WatchWakeCard.why(unresolvable),
                       "Every target it watched was deleted, so its condition can never be decided.")
    }

    /// The Match's own account — `ALL TASK_DONE 2/2` — read back into the words a person waits in.
    func testTheCardReadsAMatchReasonInWords() throws {
        let done = try XCTUnwrap(WatchWakeText.parse(F.matchWake(reason: "ALL TASK_DONE 2/2")))
        XCTAssertEqual(WatchWakeCard.why(done), "2 of 2 done")
        let both = try XCTUnwrap(WatchWakeText.parse(F.matchWake()))
        XCTAssertEqual(WatchWakeCard.why(both), "2 of 3 finished · 1 of 3 failed")
        XCTAssertEqual(WatchWakeCard.describeReason("ALL SESSION_TURN_SETTLED 3/3"), "3 of 3 finished their turn")
        // A reason in any other shape, or naming a leaf this build doesn't have, is shown as it is
        // rather than guessed at.
        XCTAssertEqual(WatchWakeCard.describeReason("because I said so"), "because I said so")
        XCTAssertEqual(WatchWakeCard.describeReason("ANY TASK_PROGRESS_AT_LEAST 1/1"),
                       "ANY TASK_PROGRESS_AT_LEAST 1/1")
        // A Match with no reason at all still says something true.
        let bare = WatchWake(watchId: "w", kind: .matched, generation: 1, reason: nil, changedTargets: [])
        XCTAssertEqual(WatchWakeCard.why(bare), "Its condition held.")
    }

    func testTheCardNamesChangedTargetsAndCountsTheRest() throws {
        let many = (0..<7).map { F.change(id: "T\($0)", status: $0 == 0 ? "DONE" : nil) }
        let wake = try XCTUnwrap(WatchWakeText.parse(F.matchWake(changed: many)))
        let shown = WatchWakeCard.changes(wake)
        XCTAssertEqual(shown.shown.count, 5)
        XCTAssertEqual(shown.more, 2)
        XCTAssertEqual(WatchProjection.moreTargets(shown.more), "+2 more")
        // The status is the point of the line: what that target is NOW.
        XCTAssertEqual(WatchWakeCard.changedLine(shown.shown[0]), "Task T0 is now DONE")
        XCTAssertEqual(WatchWakeCard.changedLine(shown.shown[1]), "Task T1")
        // A title where this client holds one — a phone card full of ids names nothing.
        XCTAssertEqual(WatchWakeCard.changedLine(shown.shown[0], name: "Land the redirect fix"),
                       "Task Land the redirect fix is now DONE")
        XCTAssertEqual(
            WatchWakeCard.changedLine(WatchWakeTarget(kind: .session, id: "0195c0de-1111", status: "ENDED")),
            "Session 0195c0de is now ENDED")
    }

    func testTheCardSaysNobodyTypedItAndKeepsTheOriginalBehindAFold() throws {
        let wake = try XCTUnwrap(WatchWakeText.parse(F.matchWake(generation: 3)))
        XCTAssertEqual(WatchWakeCard.meta(wake, ts: F.ago(240), now: now),
                       "Queued by a watch, not typed by you · generation 3 · 4m ago")
        // An end has no generation, and a card with no timestamp says neither.
        let expired = try XCTUnwrap(WatchWakeText.parse(F.expiryWake()))
        XCTAssertEqual(WatchWakeCard.meta(expired), "Queued by a watch, not typed by you")
        XCTAssertEqual(WatchWakeCard.rawSummary, "What the agent received")
        XCTAssertEqual(WatchWakeCard.viewWatch, "View watch")
        XCTAssertEqual(WatchWakeCard.undelivered, "The session has not confirmed it received this.")
    }

    /// Withdrawing a wake is not Cancel: nothing folds back into the composer and nothing sends it
    /// again, so the action says what it does and the line under it says what follows.
    func testTheQueuedFootSaysWhatWithdrawingCosts() {
        XCTAssertEqual(WatchWakeQueue.status, "Queued for next turn")
        XCTAssertEqual(WatchWakeQueue.withdraw, "Withdraw wake")
        XCTAssertEqual(WatchWakeQueue.consequence,
                       "If withdrawn, this session is not woken this time, and the watch won't send it again.")
        XCTAssertEqual(WatchWakeQueue.confirmTitle, "Withdraw this wake?")
        XCTAssertEqual(WatchWakeQueue.keep, "Keep it queued")
    }

    // MARK: the strip the watches sit on

    func testSeveralWatchesFoldBehindOneLineAndASingleOneDoesNot() throws {
        let one = try XCTUnwrap(WatchSessionSummary(sessionID: "S1", watches: [F.watch()]))
        XCTAssertFalse(one.collapses)
        XCTAssertEqual(one.waitingOn, "Waiting on a watch")
        XCTAssertEqual(one.conditions, "All tasks finish")

        let several = try XCTUnwrap(WatchSessionSummary(sessionID: "S1", watches: [
            F.watch(id: "W1", predicate: F.all("TASK_DONE"), targets: F.tasks(2)),
            F.watch(id: "W2", predicate: F.any("TASK_FAILED"), targets: F.tasks(3)),
            F.watch(id: "W3", predicate: F.all("SESSION_TURN_SETTLED"),
                    targets: [F.target("S9", kind: "SESSION")]),
        ]))
        XCTAssertTrue(several.collapses)
        XCTAssertEqual(several.waitingOn, "Waiting on 3 watches")
        // Closed, the one line still says what is being waited for — a watch over one target names it.
        XCTAssertEqual(several.conditions,
                       "All tasks are done · Any task fails · The session finishes its turn")
    }

    // MARK: the card a watch reads as

    func testTheWatchingCardsRowsAreTheBrowsersRowsInOrder() {
        let watch = F.watch(targets: F.tasks(7, met: 3), lastEvaluatedAt: F.ago(240))
        let rows = WatchProjection.facts(for: watch, observerTitle: "Coordinator: release", now: now)
        XCTAssertEqual(rows.map(\.label), ["Progress", "Updated", "Then", "Expires"])
        XCTAssertEqual(rows.map(\.value),
                       ["3 of 7 finished", "checked 4m ago", "Resume Coordinator: release", "in 1h"])
        // The label is said once: under EXPIRES the deadline is a span, not a sentence repeating it.
        XCTAssertEqual(WatchProjection.expiresIn(for: watch, now: now), "in 1h")
        XCTAssertEqual(WatchProjection.expiresIn(for: F.watch(expiresAt: F.ago(5)), now: now), "now")
        // Nothing waits on an ended watch, so it has no deadline row to draw.
        XCTAssertNil(WatchProjection.expiresIn(for: F.watch(state: "EXPIRED", expiresAt: F.ago(60)), now: now))
        XCTAssertEqual(WatchProjection.checked(for: F.watch(lastEvaluatedAt: nil), now: now), "never checked")
        // A watch nobody is resuming says so rather than naming a session it hasn't got.
        XCTAssertEqual(WatchProjection.facts(for: F.watch(action: "NOTIFY_USER", observer: nil),
                                             observerTitle: nil, now: now).first { $0.label == "Then" }?.value,
                       "Notify you")
    }

    /// A card that can't name what it waits on leaves several watches looking identical, which is
    /// what sent the account owner into the detail sheet to tell them apart.
    func testAWatchingCardNamesItsTargetsAndFallsBackToAShortId() {
        XCTAssertEqual(WatchProjection.targetTitle(kind: .task, id: F.wakeTaskID, name: "Land the redirect fix"),
                       "Land the redirect fix")
        XCTAssertEqual(WatchProjection.targetTitle(kind: .task, id: F.wakeTaskID, name: nil), "Task 0195c0de")
        XCTAssertEqual(WatchProjection.targetTitle(kind: .session, id: F.wakeTaskID, name: ""),
                       "Session 0195c0de")
        XCTAssertEqual(WatchProjection.targetTitle(kind: .unknown, id: "x", name: nil), "x")
        XCTAssertEqual(WatchProjection.shownTargets, 3)
    }
}

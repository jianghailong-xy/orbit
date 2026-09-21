import Foundation
import XCTest
@testable import OrbitKit

/// The exception-todo cards (§7.5, mock 5): which card a row is drawn as, what it says about who
/// has it and for how long, and — the part a wrong answer makes into a dead press — exactly which
/// buttons a card offers.
///
/// The fixture is the browser's own (`ProjectProgressStatus.test.tsx`): the same ids, the same
/// instants and the same `actions` lists the web test drives its cards with, so the two ends are
/// held to one set of facts rather than to two people's idea of them. Where a row's own words are
/// the server's (`title`, `detailLine`), the fixture carries the server's sentence and what is
/// asserted is that it arrives on the card unchanged.
final class ExceptionCardsTests: XCTestCase {

    /// 2026-09-13T12:00:00Z, the instant the web test's fixtures are all measured against.
    private let now = RelativeTime.parse("2026-09-13T12:00:00Z")!
    private let minute: TimeInterval = 60
    private let hour: TimeInterval = 3600

    private func at(_ secondsAgo: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-secondsAgo))
    }

    private func inFuture(_ seconds: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(seconds))
    }

    /// The web test's `item()`: a task that failed, with the coordinator holding it.
    private func item(_ over: (inout Row) -> Void = { _ in }) -> ProjectOpenItemRow {
        var r = Row()
        over(&r)
        return ProjectOpenItemRow(
            itemId: r.itemId,
            kind: r.kind,
            title: r.title,
            detailLine: r.detailLine,
            assignee: r.assignee,
            assigneeReason: r.assigneeReason,
            waitingSince: r.waitingSince,
            escalateAt: r.escalateAt,
            escalatedAt: r.escalatedAt,
            taskId: r.taskId,
            sessionId: r.sessionId,
            promotionId: r.promotionId,
            fuseEpisodeId: r.fuseEpisodeId,
            delivery: r.delivery,
            actions: r.actions,
            question: r.question
        )
    }

    /// The fixture's mutable shape, so one call can name only what it moves. The two instants are
    /// the web test's own: created 1h 58m before `now`, so two minutes short of the window's end.
    private struct Row {
        var itemId = "3mZLAZL3OvQix77hxsBQYH"
        var kind = ProjectOpenItemKind.taskFailed
        var title = "Task failed: 有存活 Monitor 的 warm engine 不回收（带硬上限）"
        var detailLine = "The acceptance command disagreed with what the task declared · exit 1, "
            + "expected 0 · attempt 2 of 3 in this chain"
        var assignee = ProjectOpenItemAssignee.coordinator
        var assigneeReason = ProjectOpenItemAssigneeReason.default
        var waitingSince = "2026-09-13T10:02:00.000Z"
        var escalateAt: String? = "2026-09-13T12:02:00.000Z"
        var escalatedAt: String?
        var taskId: String? = "34OEE9DwfWYjo3aRFuBgo"
        var sessionId: String? = "6XUcYl0KepT3lwbwsCe40k"
        var promotionId: String?
        var fuseEpisodeId: String?
        var delivery = ProjectOpenItemDelivery(state: .delivered, sessionId: "34OAa5LxnQ1JXpUOfN21W")
        var actions: [ProjectOpenItemAction] =
            [.openCoordinator, .openTaskSession, .retry, .cancelTask]
        var question: CoordinatorQuestion?
    }

    // MARK: which card

    func testTheFourExceptionsAreAllThePlainCard() {
        for kind in [ProjectOpenItemKind.integrationConflict, .integrationCheckFailed,
                     .integrationError, .taskFailed] {
            let row = item { $0.kind = kind }
            XCTAssertEqual(ExceptionCards.card(row), .openItem, "\(kind) is the coordinator's card")
            // Its heading is the server's own title, unchanged — this end composes no sentence of
            // its own about what happened.
            XCTAssertEqual(ExceptionCards.heading(row, now: now), row.title)
        }
    }

    func testAnItemThatBecameTheOwnersIsTheEscalatedCard() {
        for reason in [ProjectOpenItemAssigneeReason.escalated, .coordinatorEnded, .chainLimit,
                       .handedOver, .noCoordinator] {
            let row = item {
                $0.assignee = .owner
                $0.assigneeReason = reason
                $0.escalatedAt = at(6 * minute)
                $0.escalateAt = nil
            }
            XCTAssertEqual(ExceptionCards.card(row), .escalatedItem, "\(reason) escalates the card")
            XCTAssertNotNil(ExceptionCards.escalationHeading(row, now: now),
                            "\(reason) is a story the heading has to tell")
        }
    }

    func testAnOwnerItemThatWasAlwaysTheirsIsNotAnEscalation() {
        // A question, a merge approval and a pause are the owner's from birth: they say so in their
        // own title, and an escalation heading over them would be inventing a history.
        for reason in [ProjectOpenItemAssigneeReason.default, .unknown] {
            let row = item { $0.assignee = .owner; $0.assigneeReason = reason }
            XCTAssertNil(ExceptionCards.escalationHeading(row, now: now))
            XCTAssertEqual(ExceptionCards.card(row), .openItem)
        }
    }

    func testThePauseIsItsOwnCardAndTheTwoCardedKindsAreNeither() {
        let paused = item {
            $0.kind = .fusePaused
            $0.title = "The coordinator paused itself"
            $0.assignee = .owner
            $0.escalateAt = nil
        }
        XCTAssertEqual(ExceptionCards.card(paused), .fusePause)

        // A question and a merge approval have cards of their own, mounted beside these by the same
        // console: drawing them here too would be two cards about one decision.
        for kind in [ProjectOpenItemKind.coordinatorQuestion, .promotionApproval] {
            XCTAssertNil(ExceptionCards.card(item { $0.kind = kind }), "\(kind) has its own card")
            XCTAssertTrue(ExceptionCards.drawable(ProjectOpenItemsView(needsYou: [item { $0.kind = kind }])).isEmpty)
        }
    }

    func testThePauseIsDrawnFirstAndTheRestOldestFirst() {
        let old = item { $0.itemId = "old"; $0.waitingSince = at(2 * hour) }
        let young = item { $0.itemId = "young"; $0.waitingSince = at(5 * minute) }
        let pause = item { $0.itemId = "pause"; $0.kind = .fusePaused; $0.waitingSince = at(minute) }
        let view = ProjectOpenItemsView(needsYou: [pause, young], withCoordinator: [old])

        XCTAssertEqual(ExceptionCards.drawable(view).map(\.itemId), ["pause", "old", "young"])
    }

    // MARK: the standing, and the read that has not answered

    func testTheThreeStandingsOfOneAddress() {
        let row = item()
        let view = ProjectOpenItemsView(needsYou: [], withCoordinator: [row])

        // No read: not "gone". The card is redrawn with this and says it cannot read the item.
        XCTAssertEqual(ExceptionCards.standing(items: nil, itemId: row.itemId), .unread)
        XCTAssertEqual(ExceptionCards.standing(items: view, itemId: row.itemId), .open(row))
        // The read answered and this item is not in it.
        XCTAssertEqual(ExceptionCards.standing(items: view, itemId: "someone-else"), .gone)
    }

    func testAnUnreadOrFinishedItemIsNotCountedAsWaitingOnTheReader() {
        let mine = item { $0.assignee = .owner; $0.assigneeReason = .escalated; $0.escalatedAt = at(minute) }
        let theirs = item { $0.itemId = "theirs" }

        XCTAssertTrue(ExceptionCards.isOpen(.open(mine)))
        // Drawn to be READ, not to be acted on: the bar above the transcript is about what is the
        // reader's, so an item the coordinator is working through is not counted by it.
        XCTAssertFalse(ExceptionCards.isOpen(.open(theirs)))
        // An unreadable standing is not a question either: pointing somebody at a card that cannot
        // say what it is asking is worse than saying nothing.
        XCTAssertFalse(ExceptionCards.isOpen(.unread))
        XCTAssertFalse(ExceptionCards.isOpen(.gone))
    }

    // MARK: what it says

    func testTheHeadingsAreEachWayAnItemBecameTheOwners() {
        let escalated = item {
            $0.assignee = .owner; $0.assigneeReason = .escalated
            $0.waitingSince = at(2 * hour + 6 * minute); $0.escalatedAt = at(6 * minute)
        }
        XCTAssertEqual(ExceptionCards.escalationHeading(escalated, now: now),
                       "Now yours — no one acted on this for 2h")

        let ended = item { $0.assignee = .owner; $0.assigneeReason = .coordinatorEnded }
        XCTAssertEqual(ExceptionCards.escalationHeading(ended, now: now),
                       "Now yours — the coordinator conversation ended")

        let chain = item { $0.assignee = .owner; $0.assigneeReason = .chainLimit }
        XCTAssertEqual(ExceptionCards.escalationHeading(chain, now: now),
                       "Now yours — the 3rd failure in this chain")

        let handed = item { $0.assignee = .owner; $0.assigneeReason = .handedOver }
        XCTAssertEqual(ExceptionCards.escalationHeading(handed, now: now),
                       "Now yours — the coordinator handed it over")

        let none = item {
            $0.assignee = .owner; $0.assigneeReason = .noCoordinator; $0.waitingSince = at(20 * minute)
        }
        XCTAssertEqual(ExceptionCards.escalationHeading(none, now: now),
                       "Now yours — this project has no coordinator (waiting 20m)")
    }

    /// The window the clock took it away, read off the two instants rather than off the setting —
    /// and "a while", the web's own word, when the escalation instant is not there at all.
    func testHowLongTheCoordinatorHadItBeforeTheClockTookIt() {
        let withInstant = item {
            $0.assignee = .owner; $0.assigneeReason = .escalated
            $0.waitingSince = at(2 * hour); $0.escalatedAt = at(20 * minute)
        }
        XCTAssertEqual(ExceptionCards.escalationHeading(withInstant, now: now),
                       "Now yours — no one acted on this for 1h 40m")

        let without = item {
            $0.assignee = .owner; $0.assigneeReason = .escalated; $0.escalatedAt = nil
        }
        XCTAssertEqual(ExceptionCards.escalationHeading(without, now: now),
                       "Now yours — no one acted on this for a while")
    }

    func testTheFooterAndTheWaitingLine() {
        // The coordinator's items carry two numbers: how long it has had it, and how long before it
        // stops being its problem.
        let theirs = item {
            $0.waitingSince = at(18 * minute); $0.escalateAt = inFuture(102 * minute)
        }
        XCTAssertEqual(ExceptionCards.waitingLabel(theirs, now: now), "18m · goes to you in 1h 42m")
        XCTAssertEqual(ExceptionCards.ownerLine(theirs, now: now),
                       "Owner: coordinator · waiting 18m · goes to the owner in 1h 42m")

        // A window that has already run out says so rather than counting down into negative time.
        let late = item { $0.waitingSince = at(hour); $0.escalateAt = at(minute) }
        XCTAssertEqual(ExceptionCards.waitingLabel(late, now: now), "1h · due to come to you")
        XCTAssertEqual(ExceptionCards.ownerLine(late, now: now), "Owner: coordinator · waiting 1h")

        // The owner's own item has one number, and an escalated one is dated by when it arrived.
        let mine = item { $0.assignee = .owner; $0.waitingSince = at(2 * hour + 6 * minute) }
        XCTAssertEqual(ExceptionCards.waitingLabel(mine, now: now), "waiting 2h 6m")
        XCTAssertEqual(ExceptionCards.ownerLine(mine, now: now), "Owner: you · waiting 2h 6m")

        let escalated = item {
            $0.assignee = .owner; $0.escalatedAt = at(6 * minute)
        }
        XCTAssertEqual(ExceptionCards.waitingLabel(escalated, now: now), "escalated 6m ago")
    }

    func testAnUnreadableInstantSaysAWhileRatherThanANumberNobodyRead() {
        // A stamp this build cannot read is not "no wait", and it is not a number either: "a while"
        // is the web's own word for a span it does not have, and the other half of the line — the
        // window, which IS readable here — is still drawn.
        let broken = item { $0.waitingSince = "not-a-time"; $0.escalateAt = nil }
        XCTAssertEqual(ExceptionCards.waitingLabel(broken, now: now), "waiting a while")
        XCTAssertEqual(ExceptionCards.ownerLine(broken, now: now),
                       "Owner: coordinator · waiting a while")

        let halfReadable = item { $0.waitingSince = "not-a-time" }
        XCTAssertEqual(ExceptionCards.waitingLabel(halfReadable, now: now),
                       "a while · goes to you in 2m")
    }

    // MARK: what may be pressed

    /// The card's presses, in the server's order, with the labels the browser gives them.
    func testAFailedTasksPressesAreTheServersOwnListInItsOwnOrder() {
        let row = item()
        let presses = ExceptionCards.presses(row)

        XCTAssertEqual(presses.map(\.action), row.actions,
                       "every action the server listed is drawn, in the order it listed them")
        XCTAssertEqual(presses.map(\.label),
                       ["Open coordinator", "Open task session", "Retry", "Cancel task"])
        // Retry is the first of the writing ones, so it is the press the card emphasizes.
        XCTAssertEqual(ExceptionCards.primary(row), .retry)
    }

    func testAnEscalatedItemIsSentBackRatherThanRetried() {
        // What the server lists for an escalated task item (§4.7): the way back to the coordinator
        // that should have had it, the run, and stopping the task — and no RETRY, because the work
        // is the coordinator's to run again, not the owner's.
        let row = item {
            $0.assignee = .owner; $0.assigneeReason = .escalated
            $0.waitingSince = at(2 * hour + 6 * minute); $0.escalatedAt = at(6 * minute)
            $0.escalateAt = nil
            $0.actions = [.askCoordinatorAgain, .openTaskSession, .cancelTask]
        }
        let presses = ExceptionCards.presses(row)

        XCTAssertEqual(presses.map(\.action), row.actions)
        XCTAssertEqual(presses.map(\.label),
                       ["Ask the coordinator again", "Open task session", "Cancel task"])
        XCTAssertFalse(presses.contains { $0.label == "Retry" },
                       "the owner's press is to ask, and the server listed no RETRY")
        XCTAssertEqual(ExceptionCards.primary(row), .askCoordinatorAgain)
    }

    /// The negative control, both ways round: an action the server did NOT list is never drawn,
    /// however ordinary it is for this kind of row — and every action it DID list that this client
    /// can make is drawn.
    func testThePressSetIsExactlyTheServersListAndNothingElse() {
        // One action only: no other press may appear beside it, whatever the item looks like.
        let retryOnly = item { $0.actions = [.retry] }
        XCTAssertEqual(ExceptionCards.presses(retryOnly).map(\.action), [.retry])

        // Every one of the eight, in one list, to catch a filter that drops a drawable action.
        let everything = item {
            $0.actions = [.review, .answer, .resume, .openCoordinator, .openTaskSession, .retry,
                          .cancelTask, .askCoordinatorAgain]
            $0.promotionId = "3fFMHLbE7JTsr3vHFOzIDM"
            $0.fuseEpisodeId = "5Grmtl4G1LatjDDEmX492i"
        }
        XCTAssertEqual(ExceptionCards.presses(everything).map(\.action), everything.actions)

        // A kind this build has never heard of is a name with no press behind it: not drawn.
        let unknownAction = ProjectOpenItemRow(
            itemId: "i", kind: .taskFailed, title: "t", waitingSince: at(minute),
            taskId: "t1",
            actions: [ProjectOpenItemAction(rawValue: "SOMETHING_NEW") ?? .unknown, .retry])
        XCTAssertEqual(ExceptionCards.presses(unknownAction).compactMap(\.action),
                       [.retry], "the one action this build knows, and not the one it does not")
    }

    /// A press the server listed whose address this row does not carry is not drawn — not drawn
    /// dead: an item whose task is gone is still readable, and the two presses that need a task are
    /// simply not there.
    func testAPressThisRowCarriesNoTargetForIsNotDrawn() {
        let orphan = item { $0.taskId = nil; $0.sessionId = nil }
        XCTAssertEqual(ExceptionCards.presses(orphan).map(\.action),
                       [.openCoordinator], "only the way back to the conversation survives")
        XCTAssertNil(ExceptionCards.writeTarget(orphan, .retry))
        XCTAssertNil(ExceptionCards.writeTarget(orphan, .cancelTask))
        // The item's own address is always there, which is why "ask again" needs no target check.
        XCTAssertEqual(ExceptionCards.writeTarget(item(), .askCoordinatorAgain),
                       .item("3mZLAZL3OvQix77hxsBQYH"))

        // A merge approval's press needs a candidate, and a question's press needs nothing.
        let noCandidate = item { $0.actions = [.review] }
        XCTAssertTrue(ExceptionCards.presses(noCandidate).isEmpty)
        let withCandidate = item { $0.actions = [.review]; $0.promotionId = "pr-1" }
        XCTAssertEqual(ExceptionCards.presses(withCandidate).map(\.label), ["Review"])
        XCTAssertEqual(ExceptionCards.link(withCandidate, .review), .card("promotion-pr-1"))
        XCTAssertEqual(ExceptionCards.link(item(), .answer), .card("question-3mZLAZL3OvQix77hxsBQYH"))
    }

    /// The one press drawn from the kind rather than from the server's list, and the two facts it
    /// needs: the owner has it, and it is a kind a person can end by hand.
    func testMarkAsHandledIsOnlyTheOwnersOwnHandClosableExceptions() {
        let mine = item { $0.assignee = .owner; $0.assigneeReason = .escalated; $0.escalatedAt = at(minute) }
        XCTAssertTrue(ExceptionCards.markHandled(mine), "an exception the owner has is theirs to close")

        // An exception the coordinator is working through is not: the press would close a row
        // somebody else is holding.
        XCTAssertFalse(ExceptionCards.markHandled(item()))

        // The three kinds whose ending is not a hand-close: a question is the owner's to answer, and
        // a merge approval and a pause each have a press of their own (the server's own door refuses
        // all three).
        for kind in [ProjectOpenItemKind.coordinatorQuestion, .promotionApproval, .fusePaused] {
            let row = item { $0.kind = kind; $0.assignee = .owner }
            XCTAssertFalse(ExceptionCards.markHandled(row), "\(kind) is not closed by hand")
        }
        // A kind this build does not know is not a licence either.
        XCTAssertFalse(ExceptionCards.markHandled(item { $0.kind = .unknown; $0.assignee = .owner }))

        // And it is offered LAST, never as the card's primary press.
        XCTAssertEqual(ExceptionCards.presses(mine).compactMap(\.action), mine.actions)
    }

    func testTheOwnersOwnEndingIsNotOneOfTheServersActions() {
        // "Mark as handled" is drawn from the KIND, never from the row's own list: it is not on the
        // server's `actions` (its door landed without adding itself), so a card whose row lists
        // nothing but the way back still offers the ending — and the ending is not a "press by
        // action", which is how the two are kept apart in one list.
        let row = item {
            $0.assignee = .owner; $0.assigneeReason = .escalated; $0.escalatedAt = at(minute)
            $0.actions = [.askCoordinatorAgain]
        }
        XCTAssertTrue(ExceptionCards.markHandled(row))
        XCTAssertEqual(ExceptionCards.presses(row).compactMap(\.action), [.askCoordinatorAgain],
                       "the server listed one press, and the card draws one")
        XCTAssertFalse(row.actions.contains(.cancelTask))
        XCTAssertNil(ExceptionPress.markHandled(label: ExceptionCards.markHandled).action,
                     "the owner's own ending is not one of the server's actions")
        XCTAssertTrue(ExceptionPress.markHandled(label: ExceptionCards.markHandled).writes)
    }

    // MARK: the doors each press names

    func testEachWritingPressNamesTheAddressItsDoorTakes() {
        let row = item {
            $0.actions = [.retry, .cancelTask, .askCoordinatorAgain]
        }
        let targets = ExceptionCards.presses(row).compactMap { press -> ExceptionWriteTarget? in
            if case .write(_, _, let target) = press { return target }
            return nil
        }
        XCTAssertEqual(targets, [.task("34OEE9DwfWYjo3aRFuBgo"),
                                 .task("34OEE9DwfWYjo3aRFuBgo"),
                                 .item("3mZLAZL3OvQix77hxsBQYH")])
    }

    func testAWayInGoesWhereTheServerSaidAndNowhereElse() {
        // The browser's two anchors are rows of this same conversation, and its two session routes
        // are this app's session page; a row without the address draws no press at all.
        let row = item { $0.actions = [.review, .answer, .openCoordinator, .openTaskSession] }
        XCTAssertEqual(ExceptionCards.link(row, .review), nil, "no candidate, no way into a merge")
        XCTAssertEqual(ExceptionCards.link(row, .answer), .card("question-\(row.itemId)"))
        // The CONVERSATION the item was delivered to, and not the run the item is about: the
        // fixture carries a different id in each, and the press must name the coordinator's.
        XCTAssertEqual(ExceptionCards.link(row, .openCoordinator), .session("34OAa5LxnQ1JXpUOfN21W"))
        XCTAssertNotEqual(ExceptionCards.link(row, .openCoordinator), .session("6XUcYl0KepT3lwbwsCe40k"))
        XCTAssertEqual(ExceptionCards.link(row, .openTaskSession), .session("6XUcYl0KepT3lwbwsCe40k"))

        // No run, but a task: the way in falls back to the task's page — and to nothing without it.
        let taskOnly = item { $0.sessionId = nil }
        XCTAssertEqual(ExceptionCards.link(taskOnly, .openTaskSession), .task("34OEE9DwfWYjo3aRFuBgo"))
        XCTAssertNil(ExceptionCards.link(item { $0.sessionId = nil; $0.taskId = nil }, .openTaskSession))

        // No conversation has been delivered to: no way to open the coordinator.
        let undelivered = item {
            $0.delivery = ProjectOpenItemDelivery(state: .pending, sessionId: nil)
        }
        XCTAssertNil(ExceptionCards.link(undelivered, .openCoordinator))
    }

    // MARK: the fuse's own press

    func testThePauseDrawsResumeAndDrawsItDeadWithoutAnEpisode() {
        let paused = item {
            $0.kind = .fusePaused
            $0.title = "The coordinator paused itself"
            $0.assignee = .owner
            $0.escalateAt = nil
            $0.fuseEpisodeId = "5Grmtl4G1LatjDDEmX492i"
            $0.actions = [.resume]
        }
        XCTAssertEqual(ExceptionCards.card(paused), .fusePause)
        XCTAssertEqual(ExceptionCards.presses(paused).map(\.label), ["Resume"])
        XCTAssertEqual(ExceptionCards.presses(paused).map(\.action), [.resume])
        XCTAssertTrue(ExceptionCards.presses(paused).first?.writes == true,
                      "the pause's one press writes on the other end of it")

        // Drawn dead rather than absent when the row names no episode: hiding it would leave the
        // card with nothing to do (the browser draws it `disabled` for the same case).
        let noEpisode = item { $0.kind = .fusePaused; $0.actions = [.resume]; $0.fuseEpisodeId = nil }
        XCTAssertEqual(ExceptionCards.presses(noEpisode),
                       [.resumeFuse(label: "Resume", episodeID: nil)])
    }

    // MARK: the model

    func testTheRowDecodesTheServersOwnFieldNamesAndToleratesOnesItDoesNotKnow() throws {
        let json = """
        {
          "itemId": "i1",
          "kind": "INTEGRATION_CONFLICT",
          "title": "Merge conflict — needs a fix on the task branch",
          "detailLine": "3 files conflict with project/bg-jobs · nothing landed",
          "assignee": "OWNER",
          "assigneeReason": "ESCALATED",
          "waitingSince": "2026-09-13T09:00:00.000Z",
          "escalateAt": null,
          "escalatedAt": "2026-09-13T11:54:00.000Z",
          "taskId": "t1",
          "sessionId": null,
          "promotionId": null,
          "fuseEpisodeId": null,
          "delivery": { "state": "NOT_REQUIRED", "sessionId": null, "at": null },
          "actions": ["ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION"],
          "question": null,
          "somethingNewer": 7
        }
        """.data(using: .utf8)!
        let row = try JSONDecoder().decode(ProjectOpenItemRow.self, from: json)

        XCTAssertEqual(row.assignee, .owner)
        XCTAssertEqual(row.assigneeReason, .escalated)
        XCTAssertEqual(row.escalatedAt, "2026-09-13T11:54:00.000Z")
        XCTAssertEqual(row.delivery.state, .notRequired)
        XCTAssertEqual(row.actions, [.askCoordinatorAgain, .openTaskSession])

        // The two vocabularies this build does not know decode as `unknown` rather than failing the
        // read that carried them — a newer server must not blank a card.
        let newer = """
        { "itemId": "i2", "kind": "A_KIND_FROM_THE_FUTURE", "waitingSince": "x",
          "assignee": "SOMEBODY", "assigneeReason": "SOMEWHY", "actions": ["FLY"] }
        """.data(using: .utf8)!
        let future = try JSONDecoder().decode(ProjectOpenItemRow.self, from: newer)
        XCTAssertEqual(future.kind, .unknown)
        XCTAssertEqual(future.assignee, .unknown)
        XCTAssertEqual(future.assigneeReason, .unknown)
        XCTAssertEqual(future.actions, [.unknown])
        // A row nobody can classify is still not a hand-close, and draws no press at all.
        XCTAssertFalse(ExceptionCards.markHandled(future))
        XCTAssertTrue(ExceptionCards.presses(future).isEmpty)
    }

    // MARK: the ids the transcript is scrolled by

    func testTheTwoCardsKeepTheWebsOwnElementIds() {
        XCTAssertEqual(DeliveredDecisionCard(kind: .exceptionItem(itemID: "i1")).id, "open-item-i1")
        XCTAssertEqual(DeliveredDecisionCard(kind: .fusePause(itemID: "i1")).id, "fuse-i1")
    }

    func testTheExceptionCardsAnchorWhereTheyArrived() {
        // Nothing about these two says "below everything": the browser draws them where the item
        // was filed, and `DeliveryAnchor` places them the same way.
        let items = [TranscriptItem.user(UserBubble(id: "u1", text: "hi", pending: false, queued: false))]
        XCTAssertEqual(DeliveryAnchor.onArrival(of: .exceptionItem(itemID: "i1"), items: items), "u1")
        XCTAssertEqual(DeliveryAnchor.onArrival(of: .fusePause(itemID: "i1"), items: items), "u1")
        XCTAssertNil(DeliveryAnchor.onArrival(of: .exceptionItem(itemID: "i1"), items: []))
    }
}

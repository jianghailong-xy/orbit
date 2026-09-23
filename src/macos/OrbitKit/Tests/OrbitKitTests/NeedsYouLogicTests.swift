import XCTest
@testable import OrbitKit

final class NeedsYouLogicTests: XCTestCase {

    private func session(_ id: String, approvals: Int = 0, agentID: String? = nil,
                         agentName: String? = nil, title: String? = nil,
                         lastTurnAt: String? = nil) -> Session {
        Session(id: id, title: title, status: .running, agentId: agentID, assignedRunnerId: nil,
                pendingApprovals: approvals, branch: nil, updatedAt: nil,
                agent: agentName.map { SessionAgentRef(id: agentID ?? "a", name: $0, provider: nil,
                                                       model: nil, effort: nil) },
                lastTurnAt: lastTurnAt)
    }

    // MARK: byAgent

    func testByAgentCountsOnlyBlockedSessionsAndOmitsZeros() {
        let counts = NeedsYouLogic.byAgent([
            session("a", approvals: 1, agentID: "dev"),
            session("b", approvals: 2, agentID: "dev"),     // two blocked SESSIONS, not three approvals
            session("c", approvals: 0, agentID: "dev"),
            session("d", approvals: 1, agentID: "prod"),
            session("e", approvals: 0, agentID: "idle"),
        ])
        XCTAssertEqual(counts, ["dev": 2, "prod": 1])
        XCTAssertNil(counts["idle"])
    }

    /// The list payload nests the agent; `POST /sessions` answers with a flat `agentId` instead.
    /// Both shapes must land on the same agent (see `SessionFilter.forAgent`).
    func testByAgentPrefersNestedAgentAndFallsBackToFlatID() {
        let nested = session("a", approvals: 1, agentID: "flat", agentName: "Dev")
        let flatOnly = session("b", approvals: 1, agentID: "flat")
        XCTAssertEqual(NeedsYouLogic.byAgent([nested, flatOnly]), ["flat": 2])
    }

    func testByAgentSkipsSessionsWithNoAgent() {
        XCTAssertEqual(NeedsYouLogic.byAgent([session("a", approvals: 1)]), [:])
    }

    // MARK: banner

    func testBannerIsNilWhenNothingIsWaiting() {
        XCTAssertNil(NeedsYouLogic.banner(waiting: []))
    }

    /// The session on screen shows its own approval card inline, so the bar must not point at it.
    func testBannerExcludesTheFocusedSession() {
        let waiting = [session("focused", approvals: 1, agentID: "dev", agentName: "wikova-develop")]
        XCTAssertNil(NeedsYouLogic.banner(waiting: waiting, excluding: "focused"))
    }

    func testSingleWaitingSessionNamesItsWorkspace() {
        let waiting = [session("s1", approvals: 1, agentID: "dev", agentName: "wikova-develop")]
        let banner = NeedsYouLogic.banner(waiting: waiting)
        XCTAssertEqual(banner?.count, 1)
        XCTAssertEqual(banner?.text, "wikova-develop needs you")
        XCTAssertEqual(banner?.target.id, "s1")
    }

    func testSeveralWaitingSessionsCollapseToACount() {
        let waiting = [
            session("s1", approvals: 1, agentID: "dev", agentName: "wikova-develop"),
            session("s2", approvals: 1, agentID: "prod", agentName: "wikova-prod"),
        ]
        XCTAssertEqual(NeedsYouLogic.banner(waiting: waiting)?.text, "2 sessions need you")
    }

    /// Excluding the focused session drops the count too — two waiting, one of them on screen,
    /// reads as the single remaining workspace rather than "2 sessions".
    func testCountAndCopyBothDropTheFocusedSession() {
        let waiting = [
            session("focused", approvals: 1, agentID: "dev", agentName: "wikova-develop"),
            session("other", approvals: 1, agentID: "prod", agentName: "wikova-prod"),
        ]
        let banner = NeedsYouLogic.banner(waiting: waiting, excluding: "focused")
        XCTAssertEqual(banner?.count, 1)
        XCTAssertEqual(banner?.text, "wikova-prod needs you")
        XCTAssertEqual(banner?.target.id, "other")
    }

    /// A tap opens the one that has waited longest, whatever order the snapshot arrives in.
    func testTargetIsTheLongestWaitingSessionRegardlessOfInputOrder() {
        let newest = session("newest", approvals: 1, agentID: "a", agentName: "A",
                             lastTurnAt: "2026-08-14T10:00:00.000Z")
        let oldest = session("oldest", approvals: 1, agentID: "b", agentName: "B",
                             lastTurnAt: "2026-08-14T08:00:00.000Z")
        let middle = session("middle", approvals: 1, agentID: "c", agentName: "C",
                             lastTurnAt: "2026-08-14T09:00:00.000Z")
        XCTAssertEqual(NeedsYouLogic.banner(waiting: [newest, oldest, middle])?.target.id, "oldest")
        XCTAssertEqual(NeedsYouLogic.banner(waiting: [oldest, middle, newest])?.target.id, "oldest")
    }

    /// An agent-less / unnamed session still gets a sentence rather than an empty one.
    func testSingleSessionFallsBackToTitleThenAGenericNoun() {
        let titled = session("s1", approvals: 1, agentID: "dev", title: "Backfill worktree fences")
        XCTAssertEqual(NeedsYouLogic.banner(waiting: [titled])?.text,
                       "Backfill worktree fences needs you")
        let bare = session("s2", approvals: 1, agentID: "dev")
        XCTAssertEqual(NeedsYouLogic.banner(waiting: [bare])?.text, "A session needs you")
    }

    // MARK: questions in the conversation on screen

    /// The bar used to have nothing to say inside the session you were reading, because the only
    /// thing it knew about was an approval — which stops the turn and therefore sits at the tail
    /// where you cannot miss it. A held criteria proposal stops nothing, so the conversation runs
    /// on underneath it and it leaves the screen. This is that case.
    private func questionRow(_ id: String) -> BelowRow { BelowRow(rowID: id, isQuestion: true) }
    private func exceptionRow(_ id: String) -> BelowRow { BelowRow(rowID: id, isQuestion: false) }

    func testOneQuestionInThisConversationNamesItAndPointsAtIt() {
        let below = NeedsYouLogic.below(rows: [questionRow("criteria-decision-in-1")], side: .below)
        XCTAssertEqual(below?.count, 1)
        XCTAssertEqual(below?.text, "1 open question below")
        XCTAssertEqual(below?.rowID, "criteria-decision-in-1")
    }

    /// Several collapse to a count, and the destination is the FIRST in flow order — the oldest,
    /// the same FIFO the cross-session bar picks its target by.
    func testSeveralQuestionsCountAndTheTapGoesToTheOldest() {
        let below = NeedsYouLogic.below(rows: [questionRow("criteria-decision-in-1"),
                                               questionRow("acceptance-confirmation")],
                                        side: .below)
        XCTAssertEqual(below?.text, "2 open questions below")
        XCTAssertEqual(below?.rowID, "criteria-decision-in-1")
    }

    /// A card placed by its own moment can sit ABOVE a reader who is at the live tail — which is
    /// where a reader opening a conversation is — and the line has to say so: the press scrolls
    /// there either way, but a bar pointing the wrong way sends them looking down a conversation
    /// that goes on for another thousand rows. The chevron reads the same answer (`WaitingBelow.side`).
    func testACardAboveTheReaderSaysSo() {
        let above = NeedsYouLogic.below(rows: [exceptionRow("escalated-in-1")], side: .above)
        XCTAssertEqual(above?.text, "1 waiting above")
        XCTAssertEqual(above?.side, .above)

        let question = NeedsYouLogic.below(rows: [questionRow("criteria-decision-in-1")], side: .above)
        XCTAssertEqual(question?.text, "1 open question above")
    }

    /// Nothing has reported where the reader is: the system may be below the floor the transcript's
    /// scroll geometry needs, or the transcript may not have been laid out yet. The bar says the
    /// count and stops — a direction it cannot know is a direction it must not claim.
    func testWithNoReaderPlaceReportedTheBarDoesNotGuess() {
        let unknown = NeedsYouLogic.below(rows: [exceptionRow("escalated-in-1")], side: nil)
        XCTAssertEqual(unknown?.text, "1 waiting")
        XCTAssertNil(unknown?.side)

        let question = NeedsYouLogic.below(rows: [questionRow("criteria-decision-in-1"),
                                                  questionRow("acceptance-confirmation")],
                                           side: nil)
        XCTAssertEqual(question?.text, "2 open questions")
    }

    /// An exception the owner has to press is counted like a question — it leaves the screen the
    /// same way, and inside that conversation there is nothing else pointing at it — but it is not
    /// CALLED a question: the card it scrolls to reads "Escalated to you", and a line calling that a
    /// question sends the reader looking for something to say (the account owner's report,
    /// 2026-09-22). One exception, one question: the count is the same and the noun is neither.
    func testAnExceptionBelowIsCountedButNotCalledAQuestion() {
        let alone = NeedsYouLogic.below(rows: [exceptionRow("escalated-in-1")], side: .below)
        XCTAssertEqual(alone?.count, 1)
        XCTAssertEqual(alone?.text, "1 waiting below")
        XCTAssertEqual(alone?.rowID, "escalated-in-1")

        let mixed = NeedsYouLogic.below(rows: [exceptionRow("escalated-in-1"),
                                               questionRow("criteria-decision-in-1")],
                                        side: .below)
        XCTAssertEqual(mixed?.count, 2)
        XCTAssertEqual(mixed?.text, "2 waiting below")
        XCTAssertEqual(mixed?.rowID, "escalated-in-1",
                       "the destination is still the oldest thing waiting, whatever it is")
    }

    /// Nothing below means no bar at all — absent from the layout rather than present and empty,
    /// the same rule the cross-session bar answers nil for.
    func testNothingBelowIsNoBar() {
        XCTAssertNil(NeedsYouLogic.below(rows: [], side: nil))
    }

    // MARK: the four owner items (contract §7.6 V13)

    /// A project's coordinator conversation carrying one thing the account owner has to answer.
    /// Parked, because none of the four holds a turn open: the item is a row, and the conversation
    /// went on (or stopped) underneath it.
    private func coordinator(_ id: String, project: String?, items: [SessionOwnerItem],
                             approvals: Int? = nil) -> Session {
        Session(id: id, title: "Project coordinator", status: .awaitingInput, agentId: "orbit",
                assignedRunnerId: "runner",
                pendingApprovals: approvals ?? items.count,
                ownerItems: items,
                branch: nil, updatedAt: nil,
                projectId: "p-\(id)", projectTitle: project,
                agent: SessionAgentRef(id: "orbit", name: "orbit", provider: nil, model: nil, effort: nil),
                lastTurnAt: "2026-09-13T09:00:00Z")
    }

    private func ownerItem(_ kind: OwnerItemKind, since: String,
                           id: String = "item-1", title: String = "Waiting") -> SessionOwnerItem {
        SessionOwnerItem(itemId: id, kind: kind, title: title, since: since)
    }

    /// All four are "needs you": they are counted, they are grouped there, and the bar names the
    /// one that has waited longest — with the project, because that is what decides whether to go
    /// now. Each kind is asserted on its own, so a wording that drifts fails on its own line.
    func testOwnerItemsCountTowardNeedsYou() {
        let expected: [(OwnerItemKind, String)] = [
            (.promotionApproval, "Approve merge to main · Integration line"),
            (.coordinatorQuestion, "Question from coordinator · Integration line"),
            (.escalated, "Escalated to you · Integration line"),
            (.fusePaused, "Paused · Integration line"),
        ]
        for (kind, text) in expected {
            let session = coordinator("c1", project: "Integration line",
                                      items: [ownerItem(kind, since: "2026-09-13T10:00:00Z")])
            let groups = SessionGrouping.group([session])
            XCTAssertEqual(groups.needsYou.map(\.id), ["c1"], "\(kind) is something that needs you")
            XCTAssertTrue(groups.running.isEmpty, "\(kind) is not work in progress")
            // The macOS menu bar and its Dock badge are this same grouping, counted.
            XCTAssertEqual(MenuBar.summary(from: [session]).needsYou, 1, "\(kind) in the menu bar")
            XCTAssertEqual(MenuBar.summary(from: [session]).badge, "1", "\(kind) on the badge")

            let banner = NeedsYouLogic.banner(waiting: groups.needsYou)
            XCTAssertEqual(banner?.text, text)
            XCTAssertEqual(banner?.target.id, "c1", "and a tap lands in the coordinator conversation")
            XCTAssertEqual(banner?.ownerItem?.itemId, "item-1", "on the card the item is")
        }
    }

    /// An exception the coordinator is still working on never reaches this client as an owner item
    /// — the server does not put it on the row (`owner-decision-signal.ts`) — so a conversation
    /// carrying none is not in the bucket, is not counted in the menu bar, and lights no bar. The
    /// same fixture with one item is, which is what makes this witness the items and not the shape.
    func testCoordinatorItemsDoNotCount() {
        let handling = coordinator("c1", project: "Integration line", items: [], approvals: 0)
        let groups = SessionGrouping.group([handling])
        XCTAssertTrue(groups.needsYou.isEmpty, "the coordinator is handling it; the owner is not")
        XCTAssertEqual(groups.running.map(\.id), ["c1"], "it is an ordinary live conversation")
        XCTAssertEqual(MenuBar.summary(from: [handling]).needsYou, 0)
        XCTAssertNil(MenuBar.summary(from: [handling]).badge)
        XCTAssertNil(NeedsYouLogic.banner(waiting: groups.needsYou))

        let escalated = coordinator("c1", project: "Integration line",
                                    items: [ownerItem(.escalated, since: "2026-09-13T10:00:00Z")])
        XCTAssertEqual(SessionGrouping.group([escalated]).needsYou.map(\.id), ["c1"])
    }

    /// Several at once: the bar carries the oldest, across conversations, by the instant the
    /// server says each has been waiting since — not by which row the snapshot happened to list
    /// first, and not by the conversation's own recency, which is a different clock entirely.
    func testTheOldestOwnerItemIsTheOneNamed() {
        let newer = coordinator("c1", project: "Newer project",
                                items: [ownerItem(.coordinatorQuestion, since: "2026-09-13T12:00:00Z", id: "new")])
        let older = coordinator("c2", project: "Older project",
                                items: [ownerItem(.promotionApproval, since: "2026-09-13T08:00:00Z", id: "old")])
        let banner = NeedsYouLogic.banner(waiting: SessionGrouping.group([newer, older]).needsYou)
        XCTAssertEqual(banner?.ownerItem?.itemId, "old")
        XCTAssertEqual(banner?.target.id, "c2")
        XCTAssertEqual(banner?.text, "Approve merge to main · Older project")
        // Two conversations are waiting, and the bar still says so.
        XCTAssertEqual(banner?.count, 2)
    }

    /// An owner item wins over a blocked tool call: a stopped project is the thing with nowhere
    /// else to be seen from here, while an approval is on every list and the drawer's own badge.
    func testAnOwnerItemOutranksABlockedToolCall() {
        let blocked = session("s1", approvals: 1, agentID: "dev", agentName: "wikova-develop")
        let waiting = coordinator("c1", project: "Integration line",
                                  items: [ownerItem(.fusePaused, since: "2026-09-13T10:00:00Z")])
        let banner = NeedsYouLogic.banner(waiting: [blocked, waiting])
        XCTAssertEqual(banner?.text, "Paused · Integration line")
        XCTAssertEqual(banner?.target.id, "c1")
    }

    /// A kind a later control plane invents is counted (the server counted it) but not named: the
    /// bar falls through to the wording it has always had rather than saying half a sentence.
    func testAnUnknownKindDoesNotNameTheBar() {
        let unknown = coordinator("c1", project: "Integration line",
                                  items: [ownerItem(.unknown, since: "2026-09-13T10:00:00Z")])
        let banner = NeedsYouLogic.banner(waiting: SessionGrouping.group([unknown]).needsYou)
        XCTAssertEqual(banner?.text, "orbit needs you")
        XCTAssertNil(banner?.ownerItem)
    }

    /// The row decodes what the server sends, `ownerItems` included — the whole banner is derived
    /// from it, so a key that did not arrive would make every case above test only the fixture.
    func testOwnerItemsDecodeFromASessionRow() throws {
        let json = """
        {"id":"c1","status":"RUNNING","pendingApprovals":2,"projectTitle":"Integration line",
         "ownerItems":[{"itemId":"i1","kind":"PROMOTION_APPROVAL","title":"Merge 3 tasks into main?",
                        "since":"2026-09-13T10:00:00Z"},
                       {"itemId":"i2","kind":"WHAT_IS_THIS","title":"From a later server",
                        "since":"2026-09-13T11:00:00Z"}]}
        """
        let row = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(row.ownerItems?.count, 2)
        XCTAssertEqual(row.ownerItems?.first?.kind, .promotionApproval)
        XCTAssertEqual(row.ownerItems?.first?.title, "Merge 3 tasks into main?")
        // The unknown kind decodes rather than failing the row it arrived on.
        XCTAssertEqual(row.ownerItems?.last?.kind, .unknown)
        XCTAssertEqual(NeedsYouLogic.banner(waiting: [row])?.text,
                       "Approve merge to main · Integration line")
    }
}

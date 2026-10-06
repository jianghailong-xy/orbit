import XCTest
@testable import OrbitKit

/// The merge into main on the project's sessions page (owner decision 2026-10-06): the card under
/// the progress card, the merge check's line moving into it, the coordinator conversation's one
/// line, and the merges drawn on the page's timeline.
final class ProjectMergeCardTests: XCTestCase {
    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }
    private func date(_ iso: String) -> Date {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)!
    }

    private func candidate(_ state: PromotionState, conflicts: [String] = [], taskIds: [String] = ["t1", "t2"],
                           merged: ProjectPromotionView.Merged? = nil,
                           execution: ProjectPromotionView.Execution? = nil,
                           files: Int? = 10, commits: Int? = 5) -> ProjectPromotionView {
        ProjectPromotionView(promotionId: "pr-1", state: state,
                             sourceRef: "refs/heads/project/34ZurCP3bv9yLXGVyUGnx", sourceSha: "5e5bfca23aa1",
                             upstreamRef: "refs/heads/main", commitsAhead: commits, filesChanged: files,
                             taskIds: taskIds, conflicts: conflicts, askedAt: "2026-10-06T03:31:00Z",
                             merged: merged, execution: execution)
    }

    private func merge(_ id: String, at: String, automatic: Bool? = nil) -> PromotionCards.Receipt {
        PromotionCards.Receipt(promotion: ProjectPromotionView(
            promotionId: id, state: .merged, sourceRef: "refs/heads/project/p", sourceSha: "abc",
            upstreamRef: "refs/heads/main", taskIds: ["t1"],
            merged: .init(sha: "8d5a868e90df", at: at, automatic: automatic)))!
    }

    private func session(_ id: String, at: String?) -> Session {
        Session(id: id, title: id, status: .awaitingInput, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: nil, branch: nil, updatedAt: nil, pinnedAt: nil, createdAt: at, lastTurnAt: at)
    }

    private func integration(kind: String?, state: String = "RUNNING") -> ProjectIntegrationView {
        ProjectIntegrationView(integratingCount: 1, queuedCount: 0,
                               inFlight: ProjectIntegrationInFlight(state: state, startedAt: "2026-10-06T03:20:00Z",
                                                                    kind: kind, phase: "CHECK"))
    }

    // MARK: the card

    func testTheCardTakesTheCandidatesStateAndTheMergeChecksLineBeforeThat() {
        XCTAssertEqual(ProjectMergeCard.shape(promotion: candidate(.ready), integration: nil), .asking)
        XCTAssertEqual(ProjectMergeCard.shape(promotion: candidate(.confirmed), integration: nil), .merging)
        XCTAssertEqual(ProjectMergeCard.shape(promotion: candidate(.rechecking), integration: nil), .merging)
        XCTAssertEqual(ProjectMergeCard.shape(promotion: candidate(.blocked, conflicts: ["a.go"]), integration: nil),
                       .blocked)
        // Before there is anything to ask, the merge check running is what the card says.
        XCTAssertEqual(ProjectMergeCard.shape(promotion: candidate(.checking),
                                              integration: integration(kind: "CHECK_PROMOTION")), .checking)
        XCTAssertEqual(ProjectMergeCard.shape(promotion: nil, integration: integration(kind: "CHECK_PROMOTION")),
                       .checking)
        // A task landing on the project branch is the progress card's, and a merge already made is
        // the timeline's: neither draws the card.
        XCTAssertNil(ProjectMergeCard.shape(promotion: nil, integration: integration(kind: "LAND_TASK")))
        XCTAssertNil(ProjectMergeCard.shape(promotion: candidate(.merged), integration: nil))
        XCTAssertNil(ProjectMergeCard.shape(promotion: candidate(.declined), integration: nil))
        XCTAssertNil(ProjectMergeCard.shape(promotion: nil, integration: nil))
    }

    func testTheMergeJobsLineMovesFromTheProgressCardIntoTheMergeCard() {
        let now = date("2026-10-06T03:24:00Z")
        for kind in ["CHECK_PROMOTION", "LAND_PROMOTION"] {
            let view = integration(kind: kind)
            XCTAssertNil(ProjectMergeCard.progressLandingLine(view, now: now, updatedAt: now), kind)
            XCTAssertEqual(ProjectMergeCard.mergeLandingLine(view, now: now, updatedAt: now),
                           ProjectPage.landingLine(view, now: now, updatedAt: now), kind)
        }
        let task = integration(kind: "LAND_TASK")
        XCTAssertEqual(ProjectMergeCard.progressLandingLine(task, now: now, updatedAt: now),
                       ProjectPage.landingLine(task, now: now, updatedAt: now))
        XCTAssertNil(ProjectMergeCard.mergeLandingLine(task, now: now, updatedAt: now))
        // An older server names no kind: the line stays where it always was.
        XCTAssertNotNil(ProjectMergeCard.progressLandingLine(integration(kind: nil), now: now, updatedAt: now))
    }

    func testThePageCardSaysWhatIsAskedOfMainWithTheBranchUnderIt() {
        XCTAssertEqual(PromotionCards.pageTitle(candidate(.ready)), "Merge into main?")
        XCTAssertEqual(PromotionCards.pageTitle(candidate(.confirmed, execution: .init(state: "QUEUED", startedAt: "x"))),
                       "Merge into main queued")
        XCTAssertEqual(PromotionCards.pageTitle(candidate(.confirmed)), "Merge into main confirmed")
        XCTAssertEqual(PromotionCards.pageTitle(candidate(.rechecking,
                                                          execution: .init(state: "RUNNING", phase: "CHECK", startedAt: "x"))),
                       "Re-checking before merging into main…")
        XCTAssertEqual(PromotionCards.pageTitle(candidate(.confirmed,
                                                          execution: .init(state: "RUNNING", phase: "PUSH", startedAt: "x"))),
                       "Merging into main…")
        XCTAssertEqual(PromotionCards.pageTitle(candidate(.blocked, conflicts: ["a.go"])), "Can’t merge into main yet")
        XCTAssertEqual(PromotionCards.pageCounts(candidate(.ready)), "2 tasks · 10 files")
        XCTAssertEqual(PromotionCards.pageCounts(candidate(.ready, taskIds: ["t1"], files: 1)), "1 task · 1 file")
        XCTAssertEqual(PromotionCards.pageCounts(candidate(.ready, files: nil)), "2 tasks")
    }

    func testTheCardNamesTheTasksItCarriesAndCountsTheRest() throws {
        let titles = ["修复 D1", "日志默认关闭", "P6", "P7", "P8"]
        let view = ProjectPromotionView(promotionId: "pr", state: .ready, sourceRef: "p", sourceSha: "s",
                                        upstreamRef: "main", taskIds: ["t1", "t2", "t3", "t4", "t5"],
                                        tasks: titles.enumerated().map { PromotionTask(taskId: "t\($0.offset + 1)", title: $0.element) })
        let three = PromotionCards.taskTitles(view)
        XCTAssertEqual(three.shown, ["修复 D1", "日志默认关闭", "P6"])
        XCTAssertEqual(three.more, 2)
        XCTAssertEqual(PromotionCards.moreTasks(three.more), "+2 more")
        XCTAssertNil(PromotionCards.moreTasks(0))
        // A server older than `tasks` names none, and the card still counts what the merge carries.
        XCTAssertEqual(PromotionCards.taskTitles(candidate(.ready)).shown, [])
        XCTAssertEqual(PromotionCards.taskTitles(candidate(.ready)).more, 2)

        let wire = #"{"promotionId":"pr","state":"READY","sourceRef":"p","sourceSha":"s","upstreamRef":"main","taskIds":["t1"],"tasks":[{"taskId":"t1","title":"修复 D1"}]}"#
        let decoded = try JSONDecoder().decode(ProjectPromotionView.self, from: Data(wire.utf8))
        XCTAssertEqual(decoded.tasks, [PromotionTask(taskId: "t1", title: "修复 D1")])
    }

    // MARK: the conversation's one line

    func testTheConversationsLineIsOrangeOnlyWhileItWaitsOnTheReader() {
        let asking = PromotionCards.eventLine(candidate(.ready))
        XCTAssertEqual(asking.text, "Merge into main is waiting for you")
        XCTAssertEqual(asking.tone, .needsYou)
        XCTAssertEqual(PromotionCards.eventLine(candidate(.confirmed)).tone, .working)
        XCTAssertEqual(PromotionCards.eventLine(candidate(.confirmed)).text, "Merge into main confirmed")
        let blocked = PromotionCards.eventLine(candidate(.blocked, conflicts: ["a.go", "b.go"]))
        XCTAssertEqual(blocked.text, "Can’t merge into main yet · 2 files conflict")
        XCTAssertEqual(blocked.tone, .blocked)
        XCTAssertEqual(PromotionCards.eventLine(candidate(.blocked)).text, "Can’t merge into main yet · checks failed")
        XCTAssertEqual(PromotionCards.eventLine(nil).text, PromotionCards.supersededTitle)
        XCTAssertEqual(PromotionCards.eventLine(candidate(.declined)).tone, .quiet)
    }

    func testTheRecordsLinesSayWhatWentOntoMainAndWhoMergedIt() {
        let pressed = candidate(.merged, merged: .init(sha: "8d5a868e90df", at: "2026-10-06T03:42:00Z"))
        XCTAssertEqual(PromotionCards.receiptLine(pressed), "✓ Merged into main · 8d5a868 · 2 tasks")
        XCTAssertEqual(PromotionCards.timelineTitle(pressed), "Merged into main")
        XCTAssertEqual(PromotionCards.timelineDetail(pressed), "8d5a868 · 2 tasks · by you")
        XCTAssertEqual(PromotionCards.nowOnMainLine(pressed), "2 tasks")
        XCTAssertEqual(PromotionCards.changesLine(pressed), "5 commits · 10 files")
        XCTAssertNil(PromotionCards.changesLine(candidate(.merged, files: nil, commits: nil)))

        let automatic = candidate(.merged, merged: .init(sha: "8d5a868e90df", at: "2026-10-06T03:42:00Z",
                                                         automatic: true))
        XCTAssertEqual(PromotionCards.receiptLine(automatic), "✓ Merged into main · 8d5a868 · 2 tasks · automatically")
        XCTAssertEqual(PromotionCards.timelineDetail(automatic), "8d5a868 · 2 tasks · automatically")
    }

    // MARK: the timeline

    func testMergesSitAmongTheSessionsAtTheirOwnInstant() {
        let sessions = [session("s-now", at: "2026-10-06T03:58:00Z"),
                        session("s-p6", at: "2026-10-06T03:45:00Z"),
                        session("s-log", at: "2026-10-06T03:12:00Z"),
                        session("s-old", at: "2026-10-03T08:00:00Z")]
        let merges = [merge("m-old", at: "2026-10-04T10:00:00Z"), merge("m-today", at: "2026-10-06T03:42:00Z")]
        let out = ProjectTimeline.sections(sessions: sessions, merges: merges,
                                           now: date("2026-10-06T04:01:00Z"), calendar: utc)
        XCTAssertEqual(out.map(\.title), ["Today", "2–7 days ago"])
        XCTAssertEqual(out[0].items.map(\.id), ["s-now", "s-p6", merges[1].id, "s-log"])
        XCTAssertEqual(out[1].items.map(\.id), [merges[0].id, "s-old"])
    }

    func testAMergeOlderThanEverySessionStillShowsAndNoMergesIsTheSessionGrouping() {
        let sessions = [session("a", at: "2026-10-06T03:00:00Z")]
        let out = ProjectTimeline.sections(sessions: sessions, merges: [merge("m", at: "2026-09-01T00:00:00Z")],
                                           now: date("2026-10-06T04:00:00Z"), calendar: utc)
        XCTAssertEqual(out.map(\.title), ["Today", "Older"])
        XCTAssertEqual(out[1].items.count, 1)

        let plain = ProjectTimeline.sections(sessions: sessions, merges: [], now: date("2026-10-06T04:00:00Z"),
                                             calendar: utc)
        let grouping = SessionTimeGrouping.sections(sessions, pinnedFirst: false, now: date("2026-10-06T04:00:00Z"),
                                                    calendar: utc)
        XCTAssertEqual(plain.map(\.title), grouping.map(\.title))
        XCTAssertEqual(plain.flatMap { $0.items.map(\.id) }, grouping.flatMap { $0.sessions.map(\.id) })
    }
}

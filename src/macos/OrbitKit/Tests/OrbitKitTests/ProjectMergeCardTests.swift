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

    // MARK: who is in front of a blocked merge

    /// One of the project's current landings, as `ProjectIntegrationView.landTasks` serves it.
    private func landing(_ title: String = "同步项目线与 main：解开迁移台账冲突",
                         state: String = "QUEUED", phase: String? = nil,
                         targetRef: String = "refs/heads/project/34ZurCP3bv9yLXGVyUGnx",
                         reason: LandTaskBlockingReason? = LandTaskBlockingReason(
                            code: "WAITING_SERIAL_SLOT",
                            summary: "Waiting to land: the landing of “修合并树上的 11 个 Swift 失败” "
                                + "is running on this branch first")) -> ProjectLandTask {
        ProjectLandTask(taskId: "t9", taskTitle: title, landTask: LandTaskIntegrationView(
            jobId: "job-9", state: state, phase: phase, targetRef: targetRef, blockingReason: reason))
    }

    /// The owner's report of 2026-10-08: the card said "1 file conflict" and "Coordinator is
    /// resolving it", and never what the merge was behind — a landing on the project branch, itself
    /// queued behind another task's landing. Both links are in the project's own read.
    func testTheBlockedCardNamesTheLandingHoldingTheBranchAndWhatHoldsIt() {
        let blocked = candidate(.blocked, conflicts: ["a.go"])
        XCTAssertEqual(PromotionCards.blockedByLine(blocked, landings: [landing()]),
                       "“同步项目线与 main：解开迁移台账冲突” is landing on the project line · queued · "
                       + "Waiting to land: the landing of “修合并树上的 11 个 Swift 失败” is running on this branch first")
        // Running says which step the runner reported, in the same words the landing row uses.
        XCTAssertEqual(PromotionCards.blockedByLine(blocked, landings: [landing(state: "RUNNING", phase: "MAIN_SYNC")]),
                       "“同步项目线与 main：解开迁移台账冲突” is landing on the project line · syncing main · "
                       + "Waiting to land: the landing of “修合并树上的 11 个 Swift 失败” is running on this branch first")
        // With no reason from the server the sentence stops at what it does know.
        XCTAssertEqual(PromotionCards.blockedByLine(blocked, landings: [landing(reason: nil)]),
                       "“同步项目线与 main：解开迁移台账冲突” is landing on the project line · queued")
    }

    /// Nothing to name is said as nothing: an invented step would be worse than the sentence the
    /// card already had, which is at least true.
    func testTheBlockedCardSaysNothingWhenTheLineIsDoingNothingOnItsBranches() {
        let blocked = candidate(.blocked, conflicts: ["a.go"])
        XCTAssertNil(PromotionCards.blockedByLine(blocked, landings: []))
        XCTAssertNil(PromotionCards.blockedByLine(blocked, landings: [landing(targetRef: "refs/heads/orbit/elsewhere")]))
        // A landing that has stopped holds nothing: the line is idle, and this row is not the place
        // its failure is reported (the landing's own card and the exception item say that).
        XCTAssertNil(PromotionCards.blockedByLine(blocked, landings: [landing(state: "CONFLICT")]))
        // And the upstream is one of the branches this merge goes through: a landing on main counts.
        XCTAssertNotNil(PromotionCards.blockedByLine(candidate(.blocked),
                                                     landings: [landing(targetRef: "refs/heads/main")]))
    }

    /// The pair the owner could not tell apart: a runner that has stopped reporting, and a check
    /// that ran out of its budget. They are different facts — one about the reports, one the job's
    /// own verdict — and each is worded where it lives: the landing row says how long the silence
    /// has run, and the check the runner killed at its budget says it timed out.
    func testASilentLandingAndAJobThatTimedOutAreWordedDifferently() {
        let now = date("2026-10-08T06:00:00Z")
        let silent = ProjectIntegrationView(integratingCount: 1, inFlight: .init(
            taskTitle: "C5", state: "RUNNING", startedAt: "2026-10-08T05:30:00Z", kind: "LAND_TASK",
            phase: "FETCH", heartbeatAt: "2026-10-08T05:44:00Z"))
        let line = ProjectPage.landingLine(silent, now: now, updatedAt: now)!
        XCTAssertEqual(line.state, "No report")
        XCTAssertEqual(line.updated, "No report for 16m")
        XCTAssertFalse("\(line.state) \(line.updated ?? "")".lowercased().contains("timed out"))

        let killed = ProjectPromotionView(
            promotionId: "pr-1", state: .blocked, sourceRef: "refs/heads/project/p", sourceSha: "s",
            upstreamRef: "refs/heads/main", checks: [IntegrationCheckResult(
                name: "MERGE_CHECK", command: "npm test", exitCode: nil, timedOut: true)])
        XCTAssertEqual(PromotionCards.previewChecks(killed), "Checks timed out")
        XCTAssertTrue(PromotionCards.checksLine(killed).contains("✕ Timed out on the combined tree"))
        // Not two spellings of one fact: the job's own verdict says nothing about reports, and the
        // landing row's silence says nothing about the job.
        XCTAssertFalse(PromotionCards.checksLine(killed).contains(ProjectPage.landingNoReport))
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

import XCTest
@testable import OrbitKit

/// The queue a waiting merge is in (§2.2 J1): the sheet's rows, the sentence that names what is
/// ahead, and the wire shape both are read from.
///
/// The words are pinned against the web's by `ProjectMergeCopyParityTests`; what is checked here is
/// that each one says the fact it claims — a position is spelled, an unnamed row says whose it is,
/// and a head that has gone quiet is not described as running.
final class PromotionQueueTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-10-07T01:42:00Z")!

    private func at(_ minutesAgo: Int) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-Double(minutesAgo) * 60))
    }

    private func job(_ id: String = "job-1", kind: String = "LAND_PROMOTION", state: String = "QUEUED",
                     phase: String? = nil, title: String? = nil, mine: Bool = false,
                     automatic: Bool = false, projectId: String? = nil, taskId: String? = nil,
                     enqueuedMinutesAgo: Int = 70, startedMinutesAgo: Int? = nil,
                     reportedMinutesAgo: Int? = nil, stale: Bool = false) -> ProjectIntegrationQueueJob {
        ProjectIntegrationQueueJob(
            jobId: id, kind: kind, state: state, phase: phase, title: title, mine: mine,
            automatic: automatic, projectId: projectId, taskId: taskId,
            enqueuedAt: at(enqueuedMinutesAgo),
            startedAt: startedMinutesAgo.map(at), lastReportAt: reportedMinutesAgo.map(at), stale: stale)
    }

    private func queue(_ jobs: [ProjectIntegrationQueueJob]) -> ProjectIntegrationQueue {
        ProjectIntegrationQueue(targetRef: "refs/heads/main",
                                running: jobs.filter { $0.state == "RUNNING" }.count,
                                waiting: jobs.filter { $0.state == "QUEUED" }.count, jobs: jobs)
    }

    func testThePositionIsSpelledRatherThanCounted() {
        let mine = job("mine", title: "DeepSeek Harness", mine: true, projectId: "p1")
        let view = queue([
            job("head", state: "RUNNING", startedMinutesAgo: 4, reportedMinutesAgo: 1),
            mine, job("j3", mine: true), job("j4"),
        ])

        XCTAssertEqual(PromotionQueueCards.position("mine", in: view), "2nd of 4 for main")
        XCTAssertEqual(PromotionQueueCards.summary(view), "1 running · 3 waiting")
        XCTAssertEqual(PromotionQueueCards.title("refs/heads/main"), "Queue for main")
        XCTAssertEqual(PromotionQueueCards.position("absent", in: view), nil)
        XCTAssertEqual(PromotionQueueCards.position("absent", in: queue([])), nil)
    }

    func testAHeadIsNamedByWhatItIsAndWhoseItIs() {
        let mine = job("mine", mine: true, projectId: "p1")

        XCTAssertEqual(
            PromotionQueueCards.waitLine("mine", in: queue([
                job("head", kind: "LAND_TASK", state: "RUNNING", title: "修复 D3", mine: true),
                mine]), now: now),
            "Waiting to merge: the landing of “修复 D3” is running on main first")
        XCTAssertEqual(
            PromotionQueueCards.waitLine("mine", in: queue([
                job("head", state: "RUNNING", title: "Orbit Web 组件迁移", mine: true),
                mine]), now: now),
            "Waiting to merge: “Orbit Web 组件迁移” is running on main first")
        XCTAssertEqual(
            PromotionQueueCards.waitLine("mine", in: queue([
                job("head", kind: "LAND_TASK", state: "RUNNING"), mine]), now: now),
            "Waiting to merge: another account’s landing is running on main first")
        XCTAssertEqual(
            PromotionQueueCards.waitLine("mine", in: queue([
                job("head", state: "RUNNING"), mine]), now: now),
            "Waiting to merge: another account’s merge to main is running on main first")
    }

    func testAQuietHeadIsNotDescribedAsRunning() {
        let mine = job("mine", mine: true, projectId: "p1")
        let stuck = job("head", state: "RUNNING", title: "Orbit Web 组件迁移", mine: true,
                        startedMinutesAgo: 123, reportedMinutesAgo: 123, stale: true)

        XCTAssertEqual(
            PromotionQueueCards.waitLine("mine", in: queue([stuck, mine]), now: now),
            "Waiting to merge: “Orbit Web 组件迁移” has no report for 2h 3m — it may be stuck")
        XCTAssertEqual(PromotionQueueCards.jobStaleClause(stuck, now: now),
                       "no report for 2h 3m — it may be stuck")
        XCTAssertEqual(PromotionQueueCards.jobStaleClause(mine, now: now), nil)
    }

    func testNothingIsAheadOfTheHeadOrOfAJobTheQueueDoesNotHold() {
        let head = job("mine", mine: true, projectId: "p1")
        // A queued head is still ahead of nobody: this merge goes first.
        XCTAssertNil(PromotionQueueCards.waitLine("mine", in: queue([head, job("other")]), now: now))
        XCTAssertNil(PromotionQueueCards.waitLine("absent", in: queue([job("head", state: "RUNNING")]),
                                                  now: now))
    }

    func testARowIsNamedByItsTitleOrByWhoseItIs() {
        XCTAssertEqual(PromotionQueueCards.jobTitle(job(title: "DeepSeek Harness")),
                       "“DeepSeek Harness”")
        XCTAssertEqual(PromotionQueueCards.jobTitle(job(kind: "LAND_TASK", mine: true)), "Your landing")
        XCTAssertEqual(PromotionQueueCards.jobTitle(job(kind: "LAND_TASK")),
                       "Another account’s landing")
        XCTAssertEqual(PromotionQueueCards.jobTitle(job()), "Another account’s merge to main")
    }

    func testEachRowStatesWhatItIsDoingAndForHowLong() {
        XCTAssertEqual(PromotionQueueCards.jobStatus(job(state: "RUNNING", phase: "FETCH")),
                       "Merge to main · fetching")
        XCTAssertEqual(PromotionQueueCards.jobStatus(job(state: "RUNNING")), "Merge to main · running")
        XCTAssertEqual(PromotionQueueCards.jobStatus(job(kind: "LAND_TASK")), "Landing · queued")
        XCTAssertEqual(PromotionQueueCards.jobSpan(job(enqueuedMinutesAgo: 70), now: now), "1h 10m")
        XCTAssertEqual(PromotionQueueCards.jobSpan(job(state: "RUNNING", startedMinutesAgo: 4), now: now),
                       "4m")
    }

    func testTheWireShapeDecodesAsTheServerServesIt() throws {
        let json = """
        {"targetRef":"refs/heads/main","running":1,"waiting":1,"jobs":[
          {"jobId":"j1","kind":"LAND_PROMOTION","state":"RUNNING","phase":"FETCH",
           "title":"Orbit Web 组件迁移","mine":true,"automatic":false,
           "projectId":"34ODoUKJGEsfbgcJDGS4q","taskId":null,
           "enqueuedAt":"2026-10-06T23:05:25.864Z","startedAt":"2026-10-06T23:38:34.408Z",
           "lastReportAt":"2026-10-06T23:38:34.408Z","stale":true},
          {"jobId":"j2","kind":"LAND_PROMOTION","state":"QUEUED","phase":null,
           "title":null,"mine":false,"automatic":true,"projectId":null,"taskId":null,
           "enqueuedAt":"2026-10-07T00:41:55.372Z","startedAt":null,"lastReportAt":null,"stale":false}]}
        """
        let view = try JSONDecoder().decode(ProjectIntegrationQueue.self, from: Data(json.utf8))

        XCTAssertEqual(view.jobs.map(\.jobId), ["j1", "j2"])
        XCTAssertEqual(view.jobs[0].projectId, "34ODoUKJGEsfbgcJDGS4q")
        XCTAssertEqual(view.jobs[0].stale, true)
        XCTAssertNil(view.jobs[1].title)
        XCTAssertEqual(view.jobs[1].automatic, true)
        XCTAssertEqual(PromotionQueueCards.position("j2", in: view), "2nd of 2 for main")
    }
}

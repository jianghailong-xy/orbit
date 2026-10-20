import Foundation
import XCTest
@testable import OrbitKit

/// The entrances of 方案 A (owner 2026-10-19, board v4 04): which job rows carry an `Open landing ›`,
/// which card foot gets one, which merge round's row opens one, and what an older server draws
/// instead — a fact, not a broken link.
final class LandingEntranceTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    private func job(_ id: String, kind: String, taskId: String? = nil, taskTitle: String? = nil,
                     landingSessionId: String? = nil, state: String = "RUNNING",
                     phase: String? = "CHECK") -> ProjectIntegrationJob {
        ProjectIntegrationJob(
            jobId: id, kind: kind, state: state, phase: phase, taskId: taskId,
            taskTitle: taskTitle, generation: 1, startedAt: "2026-09-25T06:58:00.000Z",
            queuedAt: "2026-09-25T06:57:00.000Z", heartbeatAt: "2026-09-25T06:58:30.000Z",
            runnerName: "wikova", timedOut: false, limitSeconds: 600, retryable: false,
            liveness: "LIVE", landingSessionId: landingSessionId)
    }

    private func view(_ jobs: [ProjectIntegrationJob]) -> ProjectIntegrationView {
        ProjectIntegrationView(
            integratingCount: jobs.filter { $0.state == "RUNNING" }.count,
            queuedCount: jobs.filter { $0.state == "QUEUED" }.count,
            inFlight: jobs.first.map {
                ProjectIntegrationInFlight(taskTitle: $0.taskTitle, state: $0.state,
                                           startedAt: $0.startedAt, kind: $0.kind,
                                           phase: $0.phase, heartbeatAt: $0.heartbeatAt,
                                           jobId: $0.jobId, landingSessionId: $0.landingSessionId,
                                           taskId: $0.taskId, runner: $0.runnerName,
                                           claim: 1, round: 1, liveness: "LIVE")
            },
            inFlightJobs: jobs)
    }

    func testALandingCardsOneJobCarriesItsLandingSessionInTheJobsOwnRow() throws {
        let card = try XCTUnwrap(ProjectPage.landingCard(view([
            job("j1", kind: "LAND_TASK", taskId: "t1", taskTitle: "Ledger migration order",
                landingSessionId: "landing-1"),
        ]), now: now))
        XCTAssertEqual(card.jobs.count, 1)
        XCTAssertEqual(card.jobs[0].landingSessionId, "landing-1")
        XCTAssertFalse(card.jobs[0].mergeJob)
        // One job: the card's foot names its landing; a server that names none says so.
        XCTAssertEqual(LandingPageCopy.landingEntry(card.jobs[0].landingSessionId),
                       .link("landing-1"))
        XCTAssertEqual(LandingPageCopy.landingEntry(nil), .noPage)
        XCTAssertEqual(LandingPageCopy.landingEntry(nil).label,
                       "No landing page on this server yet")
    }

    func testSeveralJobsGiveEachTaskRowAWayInAndTheMergeRowNone() throws {
        let card = try XCTUnwrap(ProjectPage.landingCard(view([
            job("j1", kind: "LAND_TASK", taskId: "t1", taskTitle: "Ledger migration order",
                landingSessionId: "landing-1"),
            job("j2", kind: "CHECK_PROMOTION", landingSessionId: "landing-round"),
        ]), now: now))
        XCTAssertEqual(card.jobs.count, 2)
        XCTAssertEqual(card.jobs[0].landingSessionId, "landing-1")
        XCTAssertFalse(card.jobs[0].mergeJob)
        // The merge job's row names its own landing, but carries no entry: the merge card is that
        // round's way in (方案 A).
        XCTAssertTrue(card.jobs[1].mergeJob)
        XCTAssertEqual(card.jobs[1].landingSessionId, "landing-round")
        // The merge job lands no single task, so its row is named by its word, never left blank.
        XCTAssertEqual(card.jobs[1].title, "Merge check")
    }

    func testTheJobsSheetRowsEachCarryTheirOwnLanding() {
        let lines = ProjectPage.landingJobLines(view([
            job("j1", kind: "LAND_TASK", taskId: "t1", taskTitle: "Ledger", landingSessionId: "L1"),
            job("j2", kind: "LAND_PROMOTION", landingSessionId: "L2"),
        ]), now: now)
        XCTAssertEqual(lines.map(\.landingSessionId), ["L1", "L2"])
        XCTAssertEqual(lines.map(\.mergeJob), [false, true])
        // A row an older server lists without a landing session gets the grey sentence in the slot.
        let older = ProjectPage.landingJobLines(view([job("j3", kind: "LAND_TASK")]), now: now)
        XCTAssertNil(older.first?.landingSessionId)
        XCTAssertEqual(LandingPageCopy.landingEntry(older.first?.landingSessionId), .noPage)
    }

    func testTheMergeRoundsRowOpensTheCandidatesOwnOrItsMergeJobsLanding() {
        let mergeJob = job("m1", kind: "CHECK_PROMOTION", landingSessionId: "landing-from-job")
        // The candidate's own id wins while its row carries one.
        let withCandidate = ProjectPromotionView(
            promotionId: "p1", state: .checking, sourceRef: "refs/heads/project/p1",
            sourceSha: "aaaa", upstreamRef: "refs/heads/main",
            landingSessionId: "landing-from-candidate")
        XCTAssertEqual(ProjectMergeCard.roundLandingSessionId(withCandidate, view([mergeJob])),
                       "landing-from-candidate")
        // …and the merge job's answers while it does not.
        let withoutCandidate = ProjectPromotionView(
            promotionId: "p1", state: .confirmed, sourceRef: "refs/heads/project/p1",
            sourceSha: "aaaa", upstreamRef: "refs/heads/main")
        XCTAssertEqual(ProjectMergeCard.roundLandingSessionId(withoutCandidate, view([mergeJob])),
                       "landing-from-job")
        // BLOCKED adds no entry: no candidate id and no merge job in flight means no press at all.
        let blocked = ProjectPromotionView(
            promotionId: "p1", state: .blocked, sourceRef: "refs/heads/project/p1",
            sourceSha: "aaaa", upstreamRef: "refs/heads/main")
        XCTAssertNil(ProjectMergeCard.roundLandingSessionId(blocked, view([])))
        XCTAssertNil(ProjectMergeCard.roundLandingSessionId(nil, nil))
    }

    func testTheReceiptsFootOpensTheRoundsLandingOnlyWhereTheRowNamesOne() {
        let merged = ProjectPromotionView(
            promotionId: "p1", state: .merged, sourceRef: "refs/heads/project/p1",
            sourceSha: "aaaa", upstreamRef: "refs/heads/main",
            landingSessionId: "landing-1")
        XCTAssertEqual(ProjectMergeCard.receiptLandingSessionId(merged), "landing-1")
        let older = ProjectPromotionView(
            promotionId: "p2", state: .merged, sourceRef: "refs/heads/project/p1",
            sourceSha: "bbbb", upstreamRef: "refs/heads/main")
        XCTAssertNil(ProjectMergeCard.receiptLandingSessionId(older))
    }

    func testTheWorkOverviewDrawsAMergeJobAsALandingNotAsNothing() {
        // The sessions page hands a merge job's card to the merge card, but the Work overview draws
        // every job the integration read lists — the same card the browser and Android draw.
        let mergeOnly = view([job("m1", kind: "CHECK_PROMOTION", landingSessionId: "L1")])
        XCTAssertNil(ProjectMergeCard.taskLandingCard(mergeOnly, now: now),
                     "the sessions page still leaves a merge job to the merge card")
        let card = ProjectPage.landingCard(mergeOnly, now: now)
        XCTAssertEqual(card?.jobs.first?.mergeJob, true)
        XCTAssertEqual(card?.jobs.first?.title, "Merge check")
        XCTAssertEqual(card?.word, "Merge check")
    }
}

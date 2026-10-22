import Foundation
import XCTest
@testable import OrbitKit

/// The task page's Landing section (contract §2.7a, §7.2 V6): what a task's newest `LAND_TASK`
/// says in the web's `LandTaskStatus` words, and what a task with no attempt says from its read.
final class TaskLandingTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    private func at(_ minutesAgo: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: now.addingTimeInterval(-minutesAgo * 60))
    }

    private func job(_ over: (inout JobBuilder) -> Void = { _ in }) -> LandTaskIntegrationView {
        var b = JobBuilder(at: at)
        over(&b)
        return LandTaskIntegrationView(
            jobId: b.jobId, state: b.state, phase: b.phase, targetRef: b.targetRef,
            blockingReason: b.blockingReason, startedAt: b.startedAt,
            landingSessionId: b.landingSessionId, generation: b.generation,
            queuedAt: b.queuedAt, heartbeatAt: b.heartbeatAt, finishedAt: b.finishedAt,
            waitMs: b.waitMs, liveness: b.liveness, runnerName: b.runnerName)
    }

    private struct JobBuilder {
        let at: (Double) -> String
        var jobId = "j1"
        var state = "RUNNING"
        var phase: String? = "CHECK"
        var targetRef = "refs/heads/project/P1"
        var blockingReason: LandTaskBlockingReason? = nil
        var startedAt: String?
        var landingSessionId: String? = "L1"
        var generation: String? = "3"
        var queuedAt: String?
        var heartbeatAt: String?
        var finishedAt: String? = nil
        var waitMs: Int? = 60_000
        var liveness: String? = "LIVE"
        var runnerName: String? = "wikova"

        init(at: @escaping (Double) -> String) {
            self.at = at
            startedAt = at(6)
            queuedAt = at(7)
            heartbeatAt = at(0)
        }
    }

    private func integration(_ job: LandTaskIntegrationView?,
                             state: String = "RUNNING") -> TaskIntegrationView {
        TaskIntegrationView(state: state, jobId: job?.jobId, landTask: job, mainBranch: "main")
    }

    func testARunningLandingDrawsTheBadgeTheGenerationAndTheSixFacts() throws {
        let status = try XCTUnwrap(TaskLandingLogic.status(integration(job()), taskStatus: "DONE",
                                                          now: now))
        XCTAssertEqual(status.badge, TaskLandingStatus.Badge(label: "Landing", tone: "blue"))
        XCTAssertEqual(status.generation, "3")
        XCTAssertEqual(status.step, "checking", "a running attempt says the step, not stopped while")
        XCTAssertEqual(status.facts.map(\.label),
                       ["Target", "Queue wait", "Queued", "Started", "Heartbeat", "Finished"])
        XCTAssertEqual(status.facts.first?.value, "project/P1")
        XCTAssertEqual(status.facts[1].value, "1m")
        XCTAssertEqual(status.facts.last?.value, "—", "a landing that has not finished prints a dash")
        XCTAssertNil(status.reason)
        XCTAssertNil(status.receipt)
        XCTAssertNil(status.noReport)
        XCTAssertEqual(status.landingSessionId, "L1")
    }

    func testAStoppedLandingSaysWhatStoppedIt() throws {
        let stopped = job {
            $0.state = "CHECK_FAILED"
            $0.blockingReason = LandTaskBlockingReason(code: "CHECK_FAILED",
                                                       summary: "Task acceptance exited 1 (expected 0).")
        }
        let status = try XCTUnwrap(TaskLandingLogic.status(integration(stopped), now: now))
        XCTAssertEqual(status.badge, TaskLandingStatus.Badge(label: "Landing checks failed", tone: "red"))
        XCTAssertEqual(status.step, "stopped while checking")
        XCTAssertEqual(status.reason, "Task acceptance exited 1 (expected 0).")
    }

    func testASilentAndALeaseExpiredRunnerAreSaidInTheV6Words() throws {
        let silent = job { $0.liveness = "SILENT"; $0.heartbeatAt = $0.at(4) }
        XCTAssertEqual(TaskLandingLogic.status(integration(silent), now: now)?.noReport,
                       "No word from runner wikova for 4m")

        let expired = job { $0.liveness = "LEASE_EXPIRED"; $0.heartbeatAt = $0.at(23) }
        XCTAssertEqual(TaskLandingLogic.status(integration(expired), now: now)?.noReport,
                       "No report for 23m")

        let legacy = job { $0.liveness = "LEGACY"; $0.heartbeatAt = $0.at(12) }
        let status = try XCTUnwrap(TaskLandingLogic.status(integration(legacy), now: now))
        XCTAssertEqual(status.legacy, "Reports only between steps")
        XCTAssertNil(status.noReport, "a legacy claim's quiet is the protocol, not a stall")
    }

    func testAQueuedTaskWithNoAttemptSaysWaitingToLandAndWhy() throws {
        let status = try XCTUnwrap(TaskLandingLogic.status(
            TaskIntegrationView(state: "QUEUED"), now: now))
        XCTAssertEqual(status.badge, TaskLandingStatus.Badge(label: "Waiting to land", tone: "amber"))
        XCTAssertEqual(status.reason, "Waiting to land: the landing has not been queued yet")
        XCTAssertTrue(status.facts.isEmpty)
        XCTAssertNil(status.generation)
    }

    func testAReceiptSaysWhereTheWorkIsAndNoAttemptTakesItBack() throws {
        let upstream = try XCTUnwrap(TaskLandingLogic.status(
            TaskIntegrationView(state: "ON_UPSTREAM", mainBranch: "main"), now: now))
        XCTAssertEqual(upstream.badge, TaskLandingStatus.Badge(label: "On main", tone: "green"))
        XCTAssertTrue(upstream.facts.isEmpty)

        let onLine = job { $0.state = "LANDED" }
        let status = try XCTUnwrap(TaskLandingLogic.status(
            integration(onLine, state: "ON_INTEGRATION_LINE"), now: now))
        XCTAssertEqual(status.badge, TaskLandingStatus.Badge(label: "Landed", tone: "green"))
        XCTAssertNil(status.receipt, "a landed attempt needs no receipt sentence")

        let older = job { $0.state = "ERROR" }
        XCTAssertEqual(TaskLandingLogic.status(
            integration(older, state: "ON_INTEGRATION_LINE"), now: now)?.receipt,
            "Its work is on the project branch by an existing receipt.")
    }

    func testATaskWithNothingToSayDrawsNoSection() {
        XCTAssertNil(TaskLandingLogic.status(nil, now: now))
        XCTAssertNil(TaskLandingLogic.status(TaskIntegrationView(state: "NOT_APPLICABLE"), now: now))
    }
}

import Foundation
import XCTest
@testable import OrbitKit

/// The two slots the merge check card and the landing card draw their head with (owner decision
/// 2026-10-11, board docs/mocks/project-merge-check-row): the live clock at the right of the title,
/// and the state, the wait and the freshness in one line under it. The board's six states, one test
/// each. Web: `landingHead` in `src/web/src/components/ProjectPanoramaHeader.tsx`.
final class ProjectLandingHeadTests: XCTestCase {

    private func head(state: String, timedOut: Bool = false, clock: String = "2m 40s",
                      clockLabel: String = "Elapsed", wait: String? = nil,
                      updated: String? = nil) -> ProjectPage.LandingHead {
        ProjectPage.landingHead(state: state, timedOut: timedOut, clockLabel: clockLabel, clock: clock,
                                wait: wait, updated: updated)
    }

    /// A job running with the reports current: the clock at the right, the state leading the line.
    func testRunningLeadsWithTheClockAndItsState() {
        let row = head(state: "checking", updated: "Updated 2m ago")
        XCTAssertEqual(row.right, "2m 40s")
        XCTAssertTrue(row.isClock)
        // The freshness's own capital folds away: the line reads as one sentence.
        XCTAssertEqual(row.detail, "checking · updated 2m ago")
    }

    /// What a job waited for a runner sits between the state and the freshness, as the row's own
    /// `Waited` field did — and only when there was a wait.
    func testTheWaitIsAClauseOfTheLineAndOnlyWhenThereWasOne() {
        XCTAssertEqual(head(state: "checking", wait: "1m 20s", updated: "Updated just now").detail,
                       "checking · waited 1m 20s · updated just now")
        XCTAssertEqual(head(state: "queued", wait: nil, updated: "Updated just now").detail,
                       "queued · updated just now")
        XCTAssertEqual(head(state: "checking").detail, "checking")
    }

    /// A queue whose turn has not come: the same shape, the clock still.
    func testQueuedIsTheSameRowWithTheClockStandingStill() {
        let row = head(state: "queued", clock: "1m 5s", wait: nil, updated: "Updated just now")
        XCTAssertEqual(row.right, "1m 5s")
        XCTAssertTrue(row.isClock)
        XCTAssertEqual(row.detail, "queued · updated just now")
    }

    /// This app unable to read the server: the clock freezes at the last read and the state word is
    /// the whole of what the line has to say about it.
    func testAnUnreadableServerFreezesTheClockAndSaysSo() {
        let row = head(state: "Update unavailable", updated: "Updated 12m ago")
        XCTAssertEqual(row.right, "2m 40s")
        XCTAssertTrue(row.isClock)
        XCTAssertEqual(row.detail, "Update unavailable · updated 12m ago")
    }

    /// A job the server judged timed out has no clock left that moves: the state takes the right
    /// slot, and the line measures the silence against the limit it went past.
    func testATimedOutJobLosesTheClockAndLeadsWithItsStateInTheLine() {
        let row = head(state: "Timed out", timedOut: true, clock: "110m", clockLabel: "No report for",
                       updated: "limit 10m")
        XCTAssertEqual(row.right, "Timed out")
        XCTAssertFalse(row.isClock)
        XCTAssertEqual(row.detail, "No report for 110m · limit 10m")
    }

    /// An older server's silence IS the state word, so the line is its own sentence — never "No
    /// report · No report for 5m".
    func testAnOlderServersSilenceIsSaidOnce() {
        let row = head(state: ProjectPage.landingNoReport, clock: "5m", clockLabel: "No report for",
                       updated: "No report for 5m")
        XCTAssertEqual(row.right, "5m")
        XCTAssertTrue(row.isClock)
        XCTAssertEqual(row.detail, "No report for 5m")
        XCTAssertEqual(head(state: ProjectPage.landingNoReport, updated: ProjectPage.landingNoReportYet).detail,
                       ProjectPage.landingNoReportYet)
    }

    /// The card and the line share the one function, so a card can never word a job differently from
    /// the row beside it — and both read a real job the same way.
    func testTheCardAndTheLineComposeTheSameHead() {
        let line = ProjectPage.LandingLine(what: "C5 · 托管 runner", running: false, state: "queued",
                                           clock: "1m 5s", word: "Landing", clockLabel: "Queued for",
                                           updated: "Updated just now")
        XCTAssertEqual(line.head, head(state: "queued", clock: "1m 5s", clockLabel: "Queued for",
                                       updated: "Updated just now"))
        // A merge check the read hands over as WORKING: "Merge check  2m 40s" over "checking · …".
        let now = Date()
        let view = ProjectIntegrationView(
            integratingCount: 1, queuedCount: 0,
            inFlight: ProjectIntegrationInFlight(taskTitle: nil, state: "RUNNING",
                                                 startedAt: iso(ago: 160, from: now),
                                                 kind: "CHECK_PROMOTION", phase: "CHECK",
                                                 heartbeatAt: iso(ago: 0, from: now)),
            landTasks: [], inFlightJobs: nil)
        let read = try! XCTUnwrap(ProjectPage.landingLine(view, now: now))
        XCTAssertEqual(read.word, ProjectPage.integrationJobWords["CHECK_PROMOTION"])
        XCTAssertTrue(read.head.isClock)
        XCTAssertTrue(read.head.right.hasPrefix("2m "), "the clock is the read's own: \(read.head.right)")
        XCTAssertEqual(read.head.detail, "checking · updated just now")
    }

    private func iso(ago: TimeInterval, from now: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: now.addingTimeInterval(-ago))
    }

    // MARK: - §7.2 V6 (board docs/mocks/landing-session/v4/05)

    /// The claim as the server sends it once it derives liveness: the step clock against its budget,
    /// the claim and its round, and the liveness sentence. Five readings, three kinds.
    private func v6(kind: String = "LAND_TASK", liveness: String, check: ProjectIntegrationCheck? = nil,
                    typicalMs: Int? = nil, claim: Int? = 1, round: Int? = 1,
                    stepAgo: TimeInterval = 110.5, heartbeatAgo: TimeInterval = 0,
                    outputAgo: TimeInterval = 6.4, timedOut: Bool = false, limitSeconds: Int? = nil,
                    firstStartedAgo: TimeInterval? = nil) -> ProjectPage.LandingLine {
        let now = Date()
        let taskTitle = kind == "LAND_TASK" ? "C5 · 托管 runner" : nil
        let view = ProjectIntegrationView(
            integratingCount: 1, queuedCount: 0,
            inFlight: ProjectIntegrationInFlight(
                taskTitle: taskTitle, state: "RUNNING", startedAt: iso(ago: stepAgo, from: now),
                kind: kind, phase: "CHECK", heartbeatAt: iso(ago: heartbeatAgo, from: now),
                jobId: "j-c5", taskId: taskTitle == nil ? nil : "t-c5", runner: "wikova",
                claim: claim, round: round, check: check, stepStartedAt: iso(ago: stepAgo, from: now),
                outputMovedAt: iso(ago: outputAgo, from: now), progressProtocol: "v2",
                typicalMs: typicalMs, liveness: liveness),
            landTasks: firstStartedAgo.map { first in
                [ProjectLandTask(taskId: "t-c5", taskTitle: "C5", landTask: LandTaskIntegrationView(
                    jobId: "j-c5", state: "RUNNING", phase: "CHECK", targetRef: "refs/heads/project/p",
                    startedAt: iso(ago: first, from: now)))]
            } ?? [],
            inFlightJobs: [ProjectIntegrationJob(
                jobId: "j-c5", kind: kind, state: "RUNNING", phase: "CHECK",
                taskId: taskTitle == nil ? nil : "t-c5", taskTitle: taskTitle, startedAt: iso(ago: stepAgo, from: now),
                queuedAt: iso(ago: stepAgo + 30, from: now), heartbeatAt: iso(ago: heartbeatAgo, from: now),
                runnerName: "wikova", timedOut: timedOut, limitSeconds: limitSeconds,
                claim: claim, round: round, check: check, stepStartedAt: iso(ago: stepAgo, from: now),
                outputMovedAt: iso(ago: outputAgo, from: now), typicalMs: typicalMs, liveness: liveness)])
        return ProjectPage.landingLine(view, now: now, updatedAt: now)!
    }

    private var acceptance: ProjectIntegrationCheck {
        ProjectIntegrationCheck(name: "TASK_ACCEPTANCE", index: 1, count: 3, budgetSeconds: 3600,
                                startedAt: iso(ago: 110.5, from: Date()))
    }
    private var mergeCheck: ProjectIntegrationCheck {
        ProjectIntegrationCheck(name: "MERGE_CHECK", index: 1, count: 3, budgetSeconds: 3600,
                                startedAt: iso(ago: 110.5, from: Date()))
    }

    func testTheFiveReadingsDrawTheStepClockAndTheServersLiveness() {
        XCTAssertEqual(v6(liveness: "LIVE", check: acceptance).head,
                       ProjectPage.LandingHead(right: "1m 50s of 60m", isClock: true,
                                               detail: "checking · output 6s ago · claim 1 · round 1 of 3"))
        XCTAssertEqual(v6(liveness: "QUIET", check: acceptance, outputAgo: 840.5).head,
                       ProjectPage.LandingHead(right: "1m 50s of 60m", isClock: true,
                                               detail: "checking · no output for 14m · within its 60m budget · claim 1 · round 1 of 3"))
        // SILENT freezes the clock at the runner's last word and stops the ring; LEGACY keeps the
        // clock but says why its quiet is not a stall, with no freshness to misread.
        let silent = v6(liveness: "SILENT", check: acceptance, stepAgo: 600.5, heartbeatAgo: 240.5)
        XCTAssertEqual(silent.head,
                       ProjectPage.LandingHead(right: "6m 0s of 60m", isClock: true,
                                               detail: "checking · no word from runner wikova for 4m · claim 1 · round 1 of 3"))
        XCTAssertFalse(silent.running)
        let legacy = v6(liveness: "LEGACY", check: acceptance, stepAgo: 720.5, heartbeatAgo: 720.5)
        XCTAssertEqual(legacy.head,
                       ProjectPage.LandingHead(right: "12m 0s of 60m", isClock: true,
                                               detail: "checking · reports only between steps · claim 1 · round 1 of 3"))
        XCTAssertFalse(legacy.head.detail.contains("Updated"))
        XCTAssertTrue(legacy.running)
        // LEASE_EXPIRED is the server's one timeout, worded as main words it.
        let expired = v6(liveness: "LEASE_EXPIRED", check: acceptance, heartbeatAgo: 1_380.5, timedOut: true, limitSeconds: 600)
        XCTAssertEqual(expired.head, ProjectPage.LandingHead(right: "Timed out", isClock: false,
                                                             detail: "No report for 23m · limit 10m"))
        XCTAssertTrue(expired.timedOut)
    }

    func testEachKindSaysItsOwnWordAndOnlyAMergeCheckCarriesTheUsualDuration() {
        let check = v6(kind: "CHECK_PROMOTION", liveness: "LIVE", check: mergeCheck, typicalMs: 18 * 60_000)
        XCTAssertEqual(check.word, "Merge check")
        XCTAssertEqual(check.head.detail, "checking · output 6s ago · usually ~18m · claim 1 · round 1 of 3")
        let merge = v6(kind: "LAND_PROMOTION", liveness: "LIVE", check: mergeCheck, typicalMs: 18 * 60_000)
        XCTAssertEqual(merge.word, "Merge to main")
        // A task's own acceptance command has no usual duration.
        XCTAssertEqual(v6(liveness: "LIVE", check: acceptance).head.detail,
                       "checking · output 6s ago · claim 1 · round 1 of 3")
    }

    func testATakeoverNamesTheFirstStartTheClaimRowStillCarries() {
        let line = v6(liveness: "LIVE", check: acceptance, claim: 2, firstStartedAgo: 470)
        let claimedAt = ProjectPage.landingClockTime(Date().addingTimeInterval(-110))
        let first = ProjectPage.landingClockTime(Date().addingTimeInterval(-470))
        XCTAssertTrue(line.head.detail.contains("Taken over \(claimedAt) · first started \(first)"),
                      line.head.detail)
        // A promotion lands no task: no landTask row, so no first start to name.
        let promotion = v6(kind: "CHECK_PROMOTION", liveness: "LIVE", check: mergeCheck,
                           typicalMs: 18 * 60_000, claim: 2)
        XCTAssertTrue(promotion.head.detail.contains("Taken over"))
        XCTAssertFalse(promotion.head.detail.contains("first started"))
    }

    func testAServerWithoutTheFieldsIsWordForWordTheOlderOne() {
        let now = Date()
        let view = ProjectIntegrationView(
            integratingCount: 1, queuedCount: 0,
            inFlight: ProjectIntegrationInFlight(taskTitle: "T2", state: "RUNNING",
                                                 startedAt: iso(ago: 80.5, from: now),
                                                 kind: "LAND_TASK", phase: "CHECK",
                                                 heartbeatAt: iso(ago: 0, from: now)),
            landTasks: [], inFlightJobs: nil)
        let line = ProjectPage.landingLine(view, now: now, updatedAt: now)!
        XCTAssertNil(line.liveness)
        XCTAssertEqual(line.head, ProjectPage.LandingHead(right: "1m 20s", isClock: true,
                                                          detail: "checking · updated just now"))
        // The timed-out detail says nothing about a push for a merge check, which never pushes.
        let job = ProjectIntegrationJob(jobId: "j", kind: "CHECK_PROMOTION", state: "RUNNING", phase: "CHECK",
                                        startedAt: iso(ago: 110, from: now), queuedAt: iso(ago: 140, from: now),
                                        heartbeatAt: iso(ago: 1_380, from: now), runnerName: "wikova",
                                        timedOut: true, limitSeconds: 600)
        let detail = ProjectPage.landingJobLines(
            ProjectIntegrationView(integratingCount: 0, queuedCount: 0, inFlight: nil, inFlightJobs: [job]),
            now: now, updatedAt: now)[0].detail
        XCTAssertEqual(detail, "Runner wikova took it at "
            + "\(ProjectPage.landingClockTime(Date().addingTimeInterval(-110))) · stopped at checking")
    }
}

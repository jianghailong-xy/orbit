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
}

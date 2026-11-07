import Foundation
import XCTest
@testable import OrbitKit

/// One request the app made, at a second of the simulated clock.
private struct Request: Equatable {
    let at: TimeInterval
    let what: String
}

/// A simulated clock and server behind the app's own poll (`AppPoll`): each tick runs at the
/// second it is driven to, and every read it makes is recorded.
@MainActor
private final class Harness {
    let start = Date(timeIntervalSince1970: 1_000_000)
    var second: TimeInterval = 0
    var serverUp = true
    var requests: [Request] = []
    private(set) var poll: AppPoll!

    init(jitter: Double = 0) {
        poll = AppPoll(readOpenList: { [unowned self] in
            self.requests.append(Request(at: self.second, what: "open"))
            return self.serverUp
        }, readFloors: { [unowned self] in
            self.requests.append(Request(at: self.second, what: "floors"))
        }, jitter: { jitter })
    }

    /// Tick once a second from `from` through `to`, as the app's loop would wake for any read due.
    func run(from: TimeInterval, to: TimeInterval, visible: Bool = true, live: Bool = true) async {
        var t = from
        while t <= to {
            second = t
            await poll.tick(at: start.addingTimeInterval(t), visible: visible, live: live)
            t += 1
        }
    }

    func reads(_ what: String) -> [TimeInterval] { requests.filter { $0.what == what }.map(\.at) }
}

/// The app's poll (AppModel's tick) against a clock and a request record: what it reads while the
/// app is hidden (§4 R3) and while its reads fail (offline, R2).
@MainActor
final class AppPollTests: XCTestCase {
    /// Offline, the Open list's read backs off 4 → 8 → 16 → 30 s and stays at 30 until a read gets
    /// through; the floors wait with it. It used to keep failing every 4 s — about 30 failed requests
    /// a minute.
    func testAFailingReadBacksOffFourEightSixteenThirty() async {
        let app = Harness()
        await app.run(from: 0, to: 0)
        app.serverUp = false
        await app.run(from: 1, to: 99)
        app.serverUp = true
        await app.run(from: 100, to: 126)
        XCTAssertEqual(app.reads("open"), [0, 4, 12, 28, 58, 88, 118, 122, 126])
        let opens = app.reads("open")
        XCTAssertEqual(zip(opens.dropFirst(), opens).map { $0 - $1 }, [4, 8, 16, 30, 30, 30, 4, 4])
        XCTAssertEqual(app.reads("floors"), [0, 118, 122, 126], "the floors wait while the reads fail")
    }

    /// Jitter only ever stretches a backoff, by up to a quarter; a poll whose reads get through keeps
    /// its plain cadence.
    func testTheBackoffIsJitteredUpward() {
        for jitter in [0.0, 0.3, 0.999] {
            XCTAssertEqual(PollSchedule.backoff(4, failures: 0, jitter: jitter), 4)
            for (failures, base) in [(1, 8.0), (2, 16.0), (3, 30.0), (4, 30.0), (9, 30.0)] {
                let wait = PollSchedule.backoff(4, failures: failures, jitter: jitter)
                XCTAssertGreaterThanOrEqual(wait, base)
                XCTAssertLessThanOrEqual(wait, base * 1.25)
            }
        }
        XCTAssertEqual(PollSchedule.backoff(15, failures: 1, jitter: 0), 30)
        XCTAssertEqual(PollSchedule.backoff(15, failures: 3, jitter: 0), 30)
    }

    /// Hidden for ten minutes, the poll makes no request at all; shown again, it makes one conditional
    /// read of the Open list at once — nothing else in that tick — and the floors follow at the next.
    func testAHiddenAppMakesNoRequestsAndOneConditionalReadWhenShown() async {
        let app = Harness()
        await app.run(from: 0, to: 9)
        XCTAssertEqual(app.reads("open"), [0, 4, 8])
        await app.run(from: 10, to: 609, visible: false)
        XCTAssertTrue(app.requests.filter { $0.at >= 10 && $0.at < 610 }.isEmpty, "no request while hidden")
        XCTAssertNil(app.poll.nextWake(visible: false, live: true), "the loop sleeps until it is shown")
        await app.run(from: 610, to: 614)
        XCTAssertEqual(app.requests.filter { $0.at == 610 }, [Request(at: 610, what: "open")],
                       "one conditional read on the way back")
        XCTAssertEqual(app.requests.filter { $0.at == 614 }.map(\.what), ["open", "floors"])
        XCTAssertEqual(app.requests.filter { $0.at > 610 && $0.at < 614 }, [], "nothing between")
    }

    /// The same with the stream down — hidden still means no request at all.
    func testHiddenMakesNoRequestsWithTheStreamDownToo() async {
        let app = Harness()
        await app.run(from: 0, to: 0, live: false)
        await app.run(from: 1, to: 600, visible: false, live: false)
        XCTAssertEqual(app.requests, [Request(at: 0, what: "open"), Request(at: 0, what: "floors")])
    }

    /// A hide shorter than one interval owes nothing: the next read comes when it was due anyway.
    func testAQuickHideDoesNotReadEarly() async {
        let app = Harness()
        await app.run(from: 0, to: 0)
        await app.run(from: 1, to: 2, visible: false)
        await app.run(from: 3, to: 8)
        XCTAssertEqual(app.reads("open"), [0, 4, 8])
        XCTAssertEqual(app.reads("floors"), [0, 4, 8], "on time, so not a catch-up: the floors ride along")
    }
}

/// A page's own poll (`ViewPoll`, §4 R1–R3 and R6) against a clock: with the control stream live it
/// reads on a hint and otherwise once a minute; with it down at the page's own cadence, backing off
/// while reads fail; never while the app is hidden; and the bounded exception — a landing or merge
/// running, which no event reports — every 4 s while visible.
final class PollScheduleTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 2_000_000)

    /// Drive a schedule second by second (or `step`), reading whenever it says a read is due, and
    /// return the seconds it read at.
    private func reads(_ schedule: inout PollSchedule, through end: TimeInterval, step: TimeInterval = 1,
                       live: Bool = true, visible: Bool = true, failures: Int = 0,
                       inFlight: TimeInterval? = nil, hints: [TimeInterval] = []) -> [TimeInterval] {
        var read: [TimeInterval] = []
        var pending = hints.sorted()
        // Counted in whole steps, so the clock never drifts: 310 steps of a tenth is exactly 31 s.
        let perSecond = (1 / step).rounded()
        for i in 0...Int((end * perSecond).rounded()) {
            let t = Double(i) / perSecond
            let now = start.addingTimeInterval(t)
            while let first = pending.first, first <= t + 1e-9 {
                schedule.hint(at: start.addingTimeInterval(first))
                pending.removeFirst()
            }
            if schedule.isDue(at: now, live: live, visible: visible, failures: failures, inFlight: inFlight) {
                schedule.noteRead(at: now)
                read.append(t)
            }
        }
        return read
    }

    private func page(interval: TimeInterval = 4) -> PollSchedule {
        PollSchedule(interval: interval, lastReadAt: start)   // the page's own first read, at 0
    }

    /// Live and quiet, a Completed / Trash list or a project page reads at most once a minute.
    func testWithTheStreamLiveAPageReadsAtMostOnceAMinute() {
        var schedule = page()
        let read = reads(&schedule, through: 600)
        XCTAssertEqual(read, [60, 120, 180, 240, 300, 360, 420, 480, 540, 600])
    }

    /// A burst of hints is one read, a second after the first of them.
    func testABurstOfHintsIsOneReadASecondAfterTheFirst() {
        var schedule = page()
        let read = reads(&schedule, through: 100, step: 0.1, hints: [30.0, 30.2, 30.7])
        XCTAssertEqual(read, [31, 91])
    }

    /// Hints never read a page sooner than its own cadence after the last read.
    func testHintsNeverReadSoonerThanThePagesCadence() {
        var schedule = page()
        XCTAssertEqual(reads(&schedule, through: 10, hints: [1, 5, 6]), [4, 8])
    }

    /// With the stream down, a page keeps its own cadence — and backs off while the app's reads fail.
    func testWithTheStreamDownAPageKeepsItsCadenceAndBacksOffOffline() {
        var schedule = page()
        XCTAssertEqual(reads(&schedule, through: 20, live: false), [4, 8, 12, 16, 20])
        var offline = page()
        XCTAssertEqual(reads(&offline, through: 100, live: false, failures: 2), [16, 32, 48, 64, 80, 96])
        var longer = page()
        XCTAssertEqual(reads(&longer, through: 100, live: false, failures: 5), [30, 60, 90])
    }

    /// A live stream does not stop a failing page from backing off: a hint waits out the backoff, and
    /// the safety read is never sooner than its minute.
    func testWithTheStreamLiveFailingReadsBackOffToo() {
        var hinted = page()
        XCTAssertEqual(reads(&hinted, through: 70, failures: 2, hints: [1]), [16])
        var quiet = page()
        XCTAssertEqual(reads(&quiet, through: 130, failures: 3), [60, 120])
    }

    /// Hidden, a page reads nothing — hints, stream or not.
    func testAHiddenPageReadsNothing() {
        for live in [true, false] {
            var schedule = page()
            XCTAssertEqual(reads(&schedule, through: 600, live: live, visible: false, hints: [10, 20, 30]), [])
        }
    }

    // MARK: the bounded exception — what no event reports (contract §2.7a)

    /// A landing or merge card running is read every 4 s while the page can be seen, stream or not.
    func testARunningCardIsReadEveryFourSecondsWhileVisible() {
        var live = page(interval: 15)
        XCTAssertEqual(reads(&live, through: 20, inFlight: 4), [4, 8, 12, 16, 20])
        var down = page(interval: 15)
        XCTAssertEqual(reads(&down, through: 20, live: false, inFlight: 4), [4, 8, 12, 16, 20])
    }

    /// A running card on a page that cannot be seen is not read at all.
    func testARunningCardIsNotReadWhileHidden() {
        var schedule = page(interval: 15)
        XCTAssertEqual(reads(&schedule, through: 600, visible: false, inFlight: 4), [])
    }

    /// No card running: the Landings window reads at most once a minute with the stream live, on the
    /// project's hints otherwise, and every 15 s with the stream down.
    func testWithNoCardRunningTheLandingsWindowFollowsTheStream() {
        var live = page(interval: 15)
        XCTAssertEqual(reads(&live, through: 240), [60, 120, 180, 240])
        var hinted = page(interval: 15)
        XCTAssertEqual(reads(&hinted, through: 70, hints: [3, 40]), [15, 41])
        var down = page(interval: 15)
        XCTAssertEqual(reads(&down, through: 60, live: false), [15, 30, 45, 60])
        var offline = page(interval: 15)
        XCTAssertEqual(reads(&offline, through: 60, live: false, failures: 1), [30, 60])
    }

    /// What counts as running: a landing job claimed and working, or a merge into main checked or
    /// landing. A queued one waits on the stream like everything else.
    func testWhatCountsAsALandingOrMergeRunning() {
        func job(_ state: String) -> ProjectIntegrationJob {
            ProjectIntegrationJob(jobId: "j1", kind: "LAND_TASK", state: state, phase: nil, taskId: "t1",
                                  taskTitle: "A task", generation: 1, startedAt: "2026-11-07T08:00:00.000Z",
                                  queuedAt: "2026-11-07T07:59:00.000Z", heartbeatAt: nil, runnerName: nil,
                                  timedOut: false, limitSeconds: nil, retryable: false, liveness: "LIVE",
                                  landingSessionId: nil)
        }
        XCTAssertFalse(ProjectPage.landingRunning(nil))
        XCTAssertFalse(ProjectPage.landingRunning(ProjectIntegrationView()))
        XCTAssertFalse(ProjectPage.landingRunning(ProjectIntegrationView(queuedCount: 2, inFlightJobs: [job("QUEUED")])))
        XCTAssertTrue(ProjectPage.landingRunning(ProjectIntegrationView(integratingCount: 1)))
        XCTAssertTrue(ProjectPage.landingRunning(ProjectIntegrationView(inFlightJobs: [job("QUEUED"), job("RUNNING")])))

        func promotion(_ state: PromotionState) -> ProjectPromotionView {
            ProjectPromotionView(promotionId: "p1", state: state, sourceRef: "refs/heads/project/p1",
                                 sourceSha: "aaaa", upstreamRef: "refs/heads/main")
        }
        XCTAssertFalse(ProjectPage.mergeRunning(nil))
        for state in [PromotionState.checking, .confirmed, .rechecking] {
            XCTAssertTrue(ProjectPage.mergeRunning(promotion(state)), "\(state)")
        }
        for state in [PromotionState.ready, .merged, .blocked, .declined, .cancelled, .superseded, .unknown] {
            XCTAssertFalse(ProjectPage.mergeRunning(promotion(state)), "\(state)")
        }
    }
}

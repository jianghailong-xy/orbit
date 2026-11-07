import Foundation
import XCTest
@testable import OrbitKit

/// One request the app made, at a second of the simulated clock.
private struct Request: Equatable {
    let at: TimeInterval
    let what: String
}

/// A simulated clock and server behind the app's own poll (`AppPoll`): each tick runs at the
/// moment it is driven to, and every read it makes is recorded.
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

    /// Tick every `step` from `from` through `to`, as the app's loop would wake for any read due,
    /// with a hint taken at each of `hints` (a version each, when given) before the tick at it.
    func run(from: TimeInterval, to: TimeInterval, step: TimeInterval = 1, visible: Bool = true,
             live: Bool = true, hints: [(TimeInterval, String?)] = []) async {
        var pending = hints.sorted { $0.0 < $1.0 }
        let perSecond = (1 / step).rounded()
        for i in Int((from * perSecond).rounded())...Int((to * perSecond).rounded()) {
            let t = Double(i) / perSecond
            second = t
            while let first = pending.first, first.0 <= t + 1e-9 {
                poll.hint(version: first.1, at: start.addingTimeInterval(first.0))
                pending.removeFirst()
            }
            await poll.tick(at: start.addingTimeInterval(t), visible: visible, live: live)
        }
    }

    func reads(_ what: String) -> [TimeInterval] { requests.filter { $0.what == what }.map(\.at) }
    func gaps(_ what: String) -> [TimeInterval] {
        let at = reads(what)
        return zip(at.dropFirst(), at).map { $0 - $1 }
    }
}

/// The app's poll (AppModel's loop) against a clock and a request record (docs/list-freshness-design.md
/// §4): with the stream live the Open list is read on a hint and once a minute (R1); with it down,
/// backing off 4 → 8 → 16 → 30 s (R2); never while the app is hidden (R3).
@MainActor
final class AppPollTests: XCTestCase {
    /// Live and quiet, the Open list is read at most once a minute — it used to be every 4 s,
    /// 13–15 whole builds a minute per device — while the floors keep looking every 4 s, each behind
    /// its own gate.
    func testWithTheStreamLiveAndNoHintTheOpenListIsReadAtMostOnceAMinute() async {
        let app = Harness()
        await app.run(from: 0, to: 600)
        XCTAssertEqual(app.reads("open"), stride(from: 0, through: 600, by: 60).map { $0 })
        XCTAssertTrue(app.gaps("open").allSatisfy { $0 >= 60 }, "at most one Open read in any minute")
        XCTAssertEqual(app.reads("floors"), stride(from: 0, through: 600, by: 4).map { $0 })
    }

    /// One hint is exactly one Open read, a second after it — within 1.5 s — and nothing more until
    /// the minute's safety read.
    func testAHintIsExactlyOneReadWithinASecondAndAHalf() async {
        let app = Harness()
        await app.run(from: 0, to: 0)
        await app.run(from: 0.1, to: 59.9, step: 0.1, hints: [(30.5, "v2")])
        let after = app.reads("open").filter { $0 > 30.5 }
        XCTAssertEqual(after.count, 1)
        XCTAssertEqual(after.first ?? 0, 31.5, accuracy: 1e-6)
        XCTAssertLessThanOrEqual((after.first ?? 99) - 30.5, 1.5)
        XCTAssertEqual(app.reads("open").count, 2, "the first read at 0, the hint's, nothing else")
    }

    /// A burst of hints is one read; the same version again moves nothing; the safety read counts
    /// from the hint's read.
    func testABurstOfHintsIsOneReadAndARepeatedVersionNone() async {
        let app = Harness()
        await app.run(from: 0, to: 0)
        await app.run(from: 0.1, to: 100, step: 0.1,
                      hints: [(20, "v2"), (20.2, "v3"), (20.7, "v4"), (40, "v4"), (41, "v4")])
        let opens = app.reads("open")
        XCTAssertEqual(opens.count, 3)
        XCTAssertEqual(opens[1], 21, accuracy: 1e-6)
        XCTAssertEqual(opens[2], 81, accuracy: 1e-6, "the minute's safety read, a minute after the last")
    }

    /// Each connection tells its own versions, and its first hint is always read.
    func testANewConnectionsFirstHintIsRead() async {
        let app = Harness()
        await app.run(from: 0, to: 0)
        await app.run(from: 1, to: 10, hints: [(5, "v2")])
        XCTAssertEqual(app.poll.hint(version: "v2", at: app.start.addingTimeInterval(11)), false)
        app.poll.streamChanged()
        XCTAssertEqual(app.poll.hint(version: "v2", at: app.start.addingTimeInterval(12)), true)
        await app.run(from: 12, to: 20)
        XCTAssertEqual(app.reads("open"), [0, 6, 13])
    }

    /// An Open read made outside the tick (an event that needs one, a reconnect) answers the hints
    /// before it.
    func testAReadOutsideTheTickAnswersTheHintsBeforeIt() async {
        let app = Harness()
        await app.run(from: 0, to: 0)
        app.poll.hint(version: "v2", at: app.start.addingTimeInterval(10))
        app.poll.noteOpenRead(at: app.start.addingTimeInterval(10.5))
        await app.run(from: 10.5, to: 71, step: 0.5)
        XCTAssertEqual(app.reads("open"), [0, 70.5], "only the safety read, a minute after it")
    }

    /// With the stream down, the reads back off 4 → 8 → 16 → 30 s even though every one gets through,
    /// and the stream live again starts over: the next drop is 4 s again.
    func testWithTheStreamDownTheReadsBackOffFourEightSixteenThirty() async {
        let app = Harness()
        await app.run(from: 0, to: 59)
        // The stream drops at 60: the read it owes at once, then 4, 8, 16 and 30 s apart.
        await app.run(from: 60, to: 200, live: false)
        XCTAssertEqual(app.reads("open"), [0, 60, 64, 72, 88, 118, 148, 178])
        XCTAssertEqual(app.gaps("open").dropFirst().map { $0 }, [4, 8, 16, 30, 30, 30])
        XCTAssertEqual(app.poll.downReads, 7)
        await app.run(from: 201, to: 210)
        XCTAssertEqual(app.poll.downReads, 0, "live again: the ramp starts over")
        XCTAssertEqual(app.reads("open").filter { $0 > 200 }, [], "and live, the minute's read counts from the last")
        await app.run(from: 211, to: 260, live: false)
        XCTAssertEqual(app.reads("open").filter { $0 > 200 }, [211, 215, 223, 239])
        XCTAssertTrue(app.reads("floors").contains(100) && app.reads("floors").contains(104),
                      "the floors keep their own gates while the reads get through")
    }

    /// Offline, the Open list's read backs off the same way and the floors wait with it, until a
    /// read gets through.
    func testAFailingReadBacksOffAndTheFloorsWait() async {
        let app = Harness()
        await app.run(from: 0, to: 0, live: false)
        app.serverUp = false
        await app.run(from: 1, to: 99, live: false)
        app.serverUp = true
        await app.run(from: 100, to: 126, live: false)
        XCTAssertEqual(app.reads("open"), [0, 4, 12, 28, 58, 88, 118])
        XCTAssertEqual(app.reads("floors").filter { $0 > 0 }, [118, 122, 126], "the floors wait while the reads fail")
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

    /// Hidden for ten minutes, the poll makes no request at all — hints included; shown again, it
    /// makes one conditional read of the Open list at once, nothing else in that tick, and the floors
    /// follow at their next wake.
    func testAHiddenAppMakesNoRequestsAndOneConditionalReadWhenShown() async {
        let app = Harness()
        await app.run(from: 0, to: 9)
        XCTAssertEqual(app.reads("open"), [0])
        await app.run(from: 10, to: 609, visible: false, hints: [(100, "v2"), (300, "v3")])
        XCTAssertTrue(app.requests.filter { $0.at >= 10 && $0.at < 610 }.isEmpty, "no request while hidden")
        XCTAssertNil(app.poll.nextWake(visible: false, live: true), "the loop sleeps until it is shown")
        await app.run(from: 610, to: 614)
        XCTAssertEqual(app.requests.filter { $0.at == 610 }, [Request(at: 610, what: "open")],
                       "one conditional read on the way back")
        XCTAssertEqual(app.requests.filter { $0.at > 610 && $0.at < 614 }, [], "nothing between")
        XCTAssertEqual(app.requests.filter { $0.at == 614 }.map(\.what), ["floors"])
        XCTAssertEqual(app.reads("open").filter { $0 >= 610 }, [610])
    }

    /// The same with the stream down — hidden still means no request at all.
    func testHiddenMakesNoRequestsWithTheStreamDownToo() async {
        let app = Harness()
        await app.run(from: 0, to: 0, live: false)
        await app.run(from: 1, to: 600, visible: false, live: false)
        XCTAssertEqual(app.requests, [Request(at: 0, what: "open"), Request(at: 0, what: "floors")])
    }

    /// A hide shorter than the minute owes nothing: the next read comes when it was due anyway.
    func testAQuickHideDoesNotReadEarly() async {
        let app = Harness()
        await app.run(from: 0, to: 0)
        await app.run(from: 1, to: 20, visible: false)
        await app.run(from: 21, to: 60)
        XCTAssertEqual(app.reads("open"), [0, 60])
        XCTAssertEqual(app.reads("floors").filter { $0 <= 24 }, [0, 21], "the floors pick up where they were")
    }
}

/// The gate the per-console and per-page loops pause on (`VisibilityGate.pause`), against a clock and
/// a request record: hidden for ten minutes, no loop makes a request; shown again, each reads once.
@MainActor
final class VisibilityGateTests: XCTestCase {
    /// One loop shaped like the app's: pause, then read, until cancelled — a worktree bar every 5 s,
    /// a pending operation every 3 s, a sign-in every 2 s, a reply card every 60 s.
    private final class Clock {
        var now: TimeInterval = 0
        var hideAt: TimeInterval = .infinity
        var stopAt: TimeInterval = .infinity
        var requests: [(at: TimeInterval, what: String)] = []
    }

    private func loop(_ name: String, every seconds: TimeInterval, gate: VisibilityGate,
                      record: @escaping (String) -> Void) -> Task<Void, Never> {
        Task { @MainActor in
            while !Task.isCancelled {
                await gate.pause(seconds)
                if Task.isCancelled { return }
                record(name)
            }
        }
    }

    func testHiddenForTenMinutesTheLoopsMakeNoRequestAndOneEachWhenShown() async {
        let clock = Clock()
        var gate: VisibilityGate!
        gate = VisibilityGate(sleep: { seconds in
            // Each loop's sleep moves the simulated clock to its own wake; the app hides at `hideAt`.
            if clock.now + seconds >= clock.stopAt {
                try? await Task.sleep(nanoseconds: 3_600_000_000_000)
                return
            }
            clock.now += seconds
            if clock.now >= clock.hideAt { gate.set(false) }
            await Task.yield()
        })
        let loops = [("worktree", 5.0), ("operations", 3.0), ("signIn", 2.0), ("reply", 60.0)]
        clock.hideAt = 60
        let tasks = loops.map { name, every in
            loop(name, every: every, gate: gate) { clock.requests.append((clock.now, $0)) }
        }
        defer { tasks.forEach { $0.cancel() } }

        // Run until every loop is waiting to be shown.
        for _ in 0..<10_000 where gate.waiting < loops.count { await Task.yield() }
        XCTAssertEqual(gate.waiting, loops.count, "every loop waits to be shown")
        let hiddenFrom = clock.now
        let before = clock.requests.count

        // Ten minutes pass hidden: nothing reads.
        clock.now = hiddenFrom + 600
        for _ in 0..<100 { await Task.yield() }
        XCTAssertEqual(clock.requests.count, before, "no request while hidden")

        // Shown: each loop reads once, at once, then waits out its own cadence.
        clock.hideAt = .infinity
        clock.stopAt = clock.now + 1
        let shownAt = clock.now
        gate.set(true)
        for _ in 0..<1_000 where clock.requests.filter({ $0.at >= shownAt }).count < loops.count { await Task.yield() }
        for _ in 0..<100 { await Task.yield() }
        let after = clock.requests.filter { $0.at >= shownAt }
        XCTAssertEqual(after.map(\.what).sorted(), loops.map(\.0).sorted(), "one read each on the way back")
        XCTAssertTrue(after.allSatisfy { $0.at == shownAt })
    }

    /// A loop cancelled while it waits to be shown ends — it does not hang on the gate.
    func testACancelledLoopStopsWaiting() async {
        let gate = VisibilityGate(sleep: { _ in })
        gate.set(false)
        let waiter = Task { @MainActor in await gate.waitUntilVisible() }
        for _ in 0..<100 where gate.waiting == 0 { await Task.yield() }
        XCTAssertEqual(gate.waiting, 1)
        waiter.cancel()
        await waiter.value
        for _ in 0..<100 where gate.waiting > 0 { await Task.yield() }
        XCTAssertEqual(gate.waiting, 0)
    }

    /// Visible, a pause is the loop's own sleep and nothing more.
    func testAVisibleGateIsJustTheSleep() async {
        var slept: [TimeInterval] = []
        let gate = VisibilityGate(sleep: { slept.append($0) })
        await gate.pause(3)
        await gate.pause(5)
        XCTAssertEqual(slept, [3, 5])
        XCTAssertEqual(gate.waiting, 0)
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

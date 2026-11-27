import Foundation
import XCTest
@testable import OrbitKit

/// A clock the tests move by hand: every sleep on it ends when the clock passes its deadline.
@MainActor
private final class SimClock {
    private(set) var now: TimeInterval = 0
    private var sleepers: [(until: TimeInterval, wake: CheckedContinuation<Void, Never>)] = []
    let origin = Date(timeIntervalSince1970: 3_000_000)

    var date: Date { origin.addingTimeInterval(now) }

    func sleep(_ seconds: TimeInterval) async {
        let until = now + max(0, seconds)
        await withCheckedContinuation { sleepers.append((until, $0)) }
    }

    /// Wake every sleeper left, so no task is left parked on this clock when a test ends.
    func stop() async {
        let left = sleepers
        sleepers = []
        for sleeper in left { sleeper.wake.resume() }
        await settle()
    }

    /// Let every task that can run, run.
    func settle() async {
        for _ in 0..<200 { await Task.yield() }
    }

    /// Move to `t` a second at a time, waking each sleeper whose deadline has passed, and calling
    /// `each` at every second on the way (an event arriving, the app's tick).
    func advance(to t: TimeInterval, each: (TimeInterval) async -> Void = { _ in }) async {
        while now < t {
            now = min(t, now + 1)
            let due = sleepers.filter { $0.until <= now }
            sleepers.removeAll { $0.until <= now }
            for sleeper in due { sleeper.wake.resume() }
            await settle()
            await each(now)
            await settle()
        }
    }
}

/// The macOS app's reads, built the way `AppModel` and its models build them, on the OrbitKit types
/// they use: the tick (`AppPoll`), the gate (`VisibilityGate`), each model's nudges and floor
/// (`ListReads`) and the event routing (`ControlEventRoute`). Every request goes to one record.
@MainActor
private final class MacApp {
    let clock: SimClock
    let gate: VisibilityGate
    var requests: [(at: TimeInterval, path: String)] = []
    var live = true

    private(set) var poll: AppPoll!
    let watchNudges: ListReads
    let watchChanges: ListReads
    let projects: ListReads
    let createdTasks: ListReads
    private var runnersNotBefore: TimeInterval = 15
    private var ownerRequestsNotBefore: TimeInterval = 0
    private var managedNotBefore: TimeInterval = 0
    private var consoleRunnerLoop: Task<Void, Never>?
    /// The console's created-tasks loop: every 15 s while a row is live (`CreatedTasksModel.startPolling`).
    private var createdTasksLoop: Task<Void, Never>?

    init(clock: SimClock) {
        self.clock = clock
        gate = VisibilityGate(sleep: { [clock] in await clock.sleep($0) })
        let now: () -> Date = { [clock] in clock.date }
        let sleep: (TimeInterval) async -> Void = { [clock] in await clock.sleep($0) }
        watchNudges = ListReads(key: "watches", delay: 2, gate: gate, now: now, sleep: sleep)
        watchChanges = ListReads(key: "watches", delay: 1, gate: gate, now: now, sleep: sleep)
        projects = ListReads(key: "projects", delay: 2, gate: gate, now: now, sleep: sleep)
        createdTasks = ListReads(key: "created-tasks:S1", delay: 2, gate: gate, now: now, sleep: sleep)
        poll = AppPoll(readOpenList: { [unowned self] in
            self.record("GET /api/sessions?view=open&since=")
            // The open console adopts its row from the list and asks for its task's confirmation.
            self.consoleRead("owner-confirmation", "GET /api/tasks/T1/owner-confirmation")
            return true
        }, readFloors: { [unowned self] in await self.floors() }, jitter: { 0 })
    }

    private func record(_ path: String) {
        requests.append((clock.now, path))
    }

    // MARK: the models' reads

    /// `WatchesModel.load`: the four reads `followedWatches` makes.
    func loadWatches() {
        watchNudges.noteRead()
        watchChanges.noteRead()
        for state in ["ACTIVE", "PAUSED", "all", "needsAttention"] { record("GET /api/watches?\(state)") }
    }

    /// `ProjectsModel.load`: the list and the sidebar's summaries.
    func loadProjects() {
        projects.noteRead()
        record("GET /api/projects")
        record("GET /api/projects/sidebar")
    }

    func loadCreatedTasks() {
        createdTasks.noteRead()
        record("GET /api/sessions/S1/created-tasks")
    }

    /// `ConsoleModel.owedWhileHidden`: a console's read goes through the gate under its own key.
    func consoleRead(_ name: String, _ path: String) {
        gate.read("console.S1.\(name)") { [unowned self] in
            if name == "runner" { self.runnersNotBefore = self.clock.now + 15 }   // `onRunnersRead`
            self.record(path)
        }
    }

    /// `AppModel.pollFloors`, each floor behind its own cadence.
    private func floors() async {
        if clock.now >= runnersNotBefore {
            runnersNotBefore = clock.now + 15
            record("GET /api/runners")
        }
        if watchNudges.isDue(at: clock.date, interval: live ? 60 : 30) { loadWatches() }
        if clock.now >= ownerRequestsNotBefore {
            ownerRequestsNotBefore = clock.now + (live ? 60 : 30)
            record("GET /api/owner-requests")
        }
        if projects.isDue(at: clock.date, interval: live ? 60 : 15) { loadProjects() }
        if clock.now >= managedNotBefore {
            managedNotBefore = clock.now + 30
            record("GET /api/managed-runner")
        }
    }

    // MARK: the loop and the console

    /// The app's tick at `now`, as `startPolling` drives it.
    func tick() async {
        await poll.tick(at: clock.date, visible: gate.isVisible, live: live)
    }

    /// The focused console's own loops: its runner row every 60 s (`ConsoleModel.startStreaming`) and
    /// its created-tasks card every 15 s while a row is live.
    func openConsole() {
        consoleRunnerLoop = Task { @MainActor [unowned self] in
            while !Task.isCancelled {
                await self.clock.sleep(60)
                self.consoleRead("runner", "GET /api/runners")
            }
        }
        createdTasksLoop = Task { @MainActor [unowned self] in
            self.loadCreatedTasks()
            while !Task.isCancelled {
                await self.gate.pause(15)
                guard self.createdTasks.isDue(at: self.clock.date, interval: 15) else { continue }
                self.loadCreatedTasks()
            }
        }
    }

    func closeConsole() {
        consoleRunnerLoop?.cancel()
        createdTasksLoop?.cancel()
    }

    // MARK: events

    /// One control event, routed the way `AppModel.apply` routes it.
    func apply(_ type: String, data: String = "{}") {
        let json = #"{"type":"\#(type)","sessionId":"S1","agentId":null,"ts":"2026-11-20T15:30:00Z","data":\#(data)}"#
        let event = try! JSONDecoder().decode(ControlEvent.self, from: Data(json.utf8))
        switch event.type {
        case .sessionCreated, .sessionUpdated, .sessionEnded, .approvalRequested, .approvalResolved, .taskChanged:
            watchNudges.nudge { [unowned self] in self.loadWatches() }
        default:
            break
        }
        switch event.type {
        case .taskChanged, .taskListChanged, .approvalRequested, .approvalResolved:
            projects.nudge { [unowned self] in self.loadProjects() }
        default:
            break
        }
        switch ControlEventRoute.of(event) {
        case .tasks:
            createdTasks.nudge { [unowned self] in self.loadCreatedTasks() }
            // `startLibraryRefreshDrain`: hidden, the queue only gathers and the drain is owed.
            gate.read("app.library") { [unowned self] in self.record("GET /api/tasks/rows") }
        case .watches:
            watchChanges.nudge { [unowned self] in self.loadWatches() }
        case .sessionRow, .approvalRow, .sessionLeft, .openList:
            // `scheduleControlRefresh`: hidden, the Open list is owed to the poll as a hint.
            if gate.isVisible { record("GET /api/sessions?view=open&since=") } else { poll.hint(version: nil, at: clock.date) }
        case .listHint(let version):
            poll.hint(version: version, at: clock.date)
        default:
            break
        }
    }

    /// The console's own stream: a queued turn moved (`queued_turns_changed`).
    func queuedTurnsChanged() {
        consoleRead("queued-turns", "GET /api/sessions/S1/turns?view=active")
    }

    func reads(_ path: String, from: TimeInterval, to: TimeInterval) -> Int {
        requests.filter { $0.path == path && $0.at >= from && $0.at <= to }.count
    }

    func requests(from: TimeInterval, to: TimeInterval) -> [String] {
        requests.filter { $0.at >= from && $0.at <= to }.map(\.path)
    }
}

/// The Mac app hidden for ten minutes while its control stream stays connected and busy
/// (docs/list-freshness-design.md §4 R3/R4). Orbitd 0.1.261-beta.64 (build 13365) made 311 list reads
/// in those ten minutes on 2026-11-20 — watches ×144, sessions ×84, projects and the sidebar ×36 each,
/// runners ×10, the managed runner ×1 — and 61 owner-confirmation reads and 13 session-page reads.
@MainActor
final class HiddenAppReadsTests: XCTestCase {
    /// Hidden for ten simulated minutes, with session, approval and task events every few seconds,
    /// `sessions.list_changed` hints every five, watch events and the console's queued-turn nudges:
    /// no model makes a request. Shown again, each list on screen is read exactly once.
    func testHiddenTenMinutesNoModelReadsAndShownEachListIsReadOnce() async throws {
        let clock = SimClock()
        let app = MacApp(clock: clock)
        app.openConsole()

        // Visible for a minute first, as the app was before the hide.
        await clock.advance(to: 60) { t in
            if Int(t) % 5 == 0 { app.apply("sessions.list_changed", data: #"{"version":"v\#(Int(t))"}"#) }
            if Int(t) % 7 == 0 { app.apply("session.updated") }
            await app.tick()
        }
        XCTAssertGreaterThan(app.requests(from: 0, to: 60).count, 0, "visible, the app reads")

        // ⌘H at 60 s.
        app.gate.set(false)
        let hiddenFrom: TimeInterval = 61, hiddenTo: TimeInterval = 660
        await clock.advance(to: hiddenTo) { t in
            let s = Int(t)
            if s % 5 == 0 { app.apply("sessions.list_changed", data: #"{"version":"h\#(s)"}"#) }
            if s % 3 == 0 { app.apply("session.updated") }
            if s % 8 == 0 { app.apply("approval.requested") }
            if s % 11 == 0 { app.apply("task.changed", data: #"{"taskId":"T1","taskIds":["T1"]}"#) }
            if s % 13 == 0 { app.apply("session.error") }
            if s % 17 == 0 { app.apply("watch.changed", data: #"{"id":"w1"}"#) }
            if s % 19 == 0 { app.queuedTurnsChanged() }
            await app.tick()
        }
        XCTAssertEqual(app.requests(from: hiddenFrom, to: hiddenTo), [], "no request in ten hidden minutes")
        XCTAssertEqual(app.poll.nextWake(visible: false, live: true), nil, "the tick sleeps until shown")
        XCTAssertEqual(Set(app.gate.owedReads), ["watches", "projects", "created-tasks:S1", "app.library",
                                                  "console.S1.queued-turns", "console.S1.runner"],
                       "what the events asked for is owed, once per list")

        // Shown again at 661 s; the tick wakes at once and every second after, for ten seconds.
        let shownAt: TimeInterval = 661
        await clock.advance(to: shownAt) { _ in app.gate.set(true) }
        await app.tick()
        await clock.advance(to: shownAt + 10) { _ in await app.tick() }
        let window = (shownAt, shownAt + 10)
        func once(_ path: String, file: StaticString = #filePath, line: UInt = #line) {
            XCTAssertEqual(app.reads(path, from: window.0, to: window.1), 1, path, file: file, line: line)
        }
        once("GET /api/sessions?view=open&since=")
        once("GET /api/tasks/T1/owner-confirmation")
        for state in ["ACTIVE", "PAUSED", "all", "needsAttention"] { once("GET /api/watches?\(state)") }
        once("GET /api/projects")
        once("GET /api/projects/sidebar")
        once("GET /api/runners")
        once("GET /api/managed-runner")
        once("GET /api/owner-requests")
        once("GET /api/tasks/rows")
        once("GET /api/sessions/S1/created-tasks")
        once("GET /api/sessions/S1/turns?view=active")
        XCTAssertEqual(app.gate.owedReads, [], "nothing is left owed")
        app.closeConsole()
        await clock.stop()
    }

    /// A hide shorter than a minute owes only what was asked for in it, and the safety reads keep
    /// their own cadence: shown, the events' reads are made once and nothing else comes early.
    func testAShortHideOwesOnlyWhatWasAsked() async {
        let clock = SimClock()
        let app = MacApp(clock: clock)
        await clock.advance(to: 30) { _ in await app.tick() }
        app.apply("watch.changed", data: #"{"id":"w1"}"#)
        await clock.advance(to: 32) { _ in await app.tick() }
        XCTAssertEqual(app.reads("GET /api/watches?ACTIVE", from: 31, to: 32), 1, "visible, a watch event reads")

        app.gate.set(false)
        await clock.advance(to: 50) { t in
            if Int(t) == 40 { app.apply("watch.changed", data: #"{"id":"w1"}"#) }
            await app.tick()
        }
        XCTAssertEqual(app.requests(from: 33, to: 50), [])
        await clock.advance(to: 51) { _ in app.gate.set(true) }
        await clock.advance(to: 55) { _ in await app.tick() }
        XCTAssertEqual(app.reads("GET /api/watches?ACTIVE", from: 51, to: 55), 1, "the owed watch read, once")
        XCTAssertEqual(app.reads("GET /api/sessions?view=open&since=", from: 51, to: 55), 0,
                       "no Open read was owed, and the minute's is not due")
        await clock.stop()
    }
}

/// One list's nudges and floor (`ListReads`), against a clock: a burst is one read, hidden it is owed
/// and made once when shown, and a read since the ask answers it.
@MainActor
final class ListReadsTests: XCTestCase {
    func testABurstOfNudgesIsOneReadAfterTheDelay() async {
        let clock = SimClock()
        let gate = VisibilityGate(sleep: { await clock.sleep($0) })
        let list = ListReads(key: "l", delay: 2, gate: gate, now: { clock.date }, sleep: { await clock.sleep($0) })
        var reads: [TimeInterval] = []
        for _ in 0..<5 { list.nudge { reads.append(clock.now) } }
        await clock.settle()
        XCTAssertTrue(list.nudging)
        await clock.advance(to: 3)
        XCTAssertEqual(reads, [2])
    }

    func testHiddenNudgesAreOneOwedReadMadeWhenShown() async {
        let clock = SimClock()
        let gate = VisibilityGate(sleep: { await clock.sleep($0) })
        let list = ListReads(key: "l", delay: 2, gate: gate, now: { clock.date }, sleep: { await clock.sleep($0) })
        var reads: [TimeInterval] = []
        gate.set(false)
        await clock.advance(to: 600) { _ in list.nudge { reads.append(clock.now) } }
        XCTAssertEqual(reads, [], "nothing read while hidden")
        XCTAssertEqual(gate.owedReads, ["l"])
        gate.set(true)
        await clock.settle()
        XCTAssertEqual(reads, [600], "one read on the way back")
        XCTAssertEqual(gate.owedReads, [])
    }

    func testAReadSinceTheAskAnswersTheNudge() async {
        let clock = SimClock()
        let gate = VisibilityGate(sleep: { await clock.sleep($0) })
        let list = ListReads(key: "l", delay: 2, gate: gate, now: { clock.date }, sleep: { await clock.sleep($0) })
        var reads = 0
        await clock.advance(to: 10)
        list.nudge { reads += 1 }
        await clock.advance(to: 11)
        list.noteRead()   // a page's own read
        await clock.advance(to: 15)
        XCTAssertEqual(reads, 0)
        XCTAssertFalse(list.isDue(at: clock.date, interval: 60))
        XCTAssertTrue(list.isDue(at: clock.date.addingTimeInterval(56), interval: 60))
    }
}

/// The gate's owed reads (`VisibilityGate.read`): made at once while visible; hidden, one per key,
/// made once each when shown; forgotten on sign-out.
@MainActor
final class VisibilityGateOwedReadsTests: XCTestCase {
    func testVisibleReadsAtOnce() async {
        let gate = VisibilityGate(sleep: { _ in })
        var made: [String] = []
        gate.read("a") { made.append("a") }
        XCTAssertEqual(made, ["a"])
        XCTAssertEqual(gate.owedReads, [])
    }

    func testHiddenOwesOneReadPerKeyInTheOrderFirstAskedAndTheLatestAskWins() async {
        let gate = VisibilityGate(sleep: { _ in })
        var made: [String] = []
        gate.set(false)
        for i in 0..<100 {
            gate.read("watches") { made.append("watches \(i)") }
            gate.read("projects") { made.append("projects \(i)") }
        }
        XCTAssertEqual(made, [])
        XCTAssertEqual(gate.owedReads, ["watches", "projects"])
        gate.set(true)
        XCTAssertEqual(made, ["watches 99", "projects 99"])
        gate.set(false)
        gate.set(true)
        XCTAssertEqual(made.count, 2, "made once")
    }

    func testForgottenReadsAreNotMade() async {
        let gate = VisibilityGate(sleep: { _ in })
        var made = 0
        gate.set(false)
        gate.read("a") { made += 1 }
        gate.forgetOwedReads()
        gate.set(true)
        XCTAssertEqual(made, 0)
    }
}

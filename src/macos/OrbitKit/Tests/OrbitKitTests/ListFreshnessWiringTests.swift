import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold the macOS and iOS shell to the list budget of docs/list-freshness-design.md §4, whose
/// rules are OrbitKit's and tested there against a clock and a request record (`AppPoll`,
/// `PollSchedule`, `ControlPlaneLoop`, `ControlEventRoute`): that the app's tick, its control-plane
/// loop, its event routing and its page polls are those types and nothing of their own; that the Mac
/// stops its timed reads while no window of it can be seen; and that a reconnect reads the Open list
/// and what is on screen, not every library. Each check reads the slice of the file it is about.
final class ListFreshnessWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "OrbitApp/Sources/OrbitApp/\(path) wasn't found above this test. If it moved, point this check "
                + "at its new home — don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp")
                .appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return code(try String(contentsOf: candidate, encoding: .utf8))
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }

    /// From the first `start` through the next `end` after it.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    // MARK: the app's tick (R2, R3)

    /// The tick is `AppPoll`: the Open list's conditional read, then the floors, when it says so —
    /// never a fixed sleep — and the loop sleeps until the next read is due, or until it is shown.
    func testTheTickIsTheTestedAppPoll() throws {
        let app = try source("AppModel.swift")
        let start = try slice(app, from: "func startPolling() {", to: "\n    }\n")
        XCTAssertTrue(start.contains("let poll = AppPoll(readOpenList: { [weak self] in await self?.loadSessions() ?? false },"))
        XCTAssertTrue(start.contains("readFloors: { [weak self] in await self?.pollFloors() })"))
        XCTAssertTrue(start.contains("await poll.tick(at: Date(), visible: self.appVisible, live: self.controlPlaneLive)"))
        XCTAssertTrue(start.contains("await self.pollSleep(until: poll.nextWake(visible: self.appVisible, live: self.controlPlaneLive))"))
        XCTAssertFalse(start.contains("Task.sleep(nanoseconds: 4_000_000_000)"), "no read on a fixed cadence of its own")
        XCTAssertFalse(start.contains("await self.loadSessions()"), "the Open list is read by AppPoll alone")

        let floors = try slice(app, from: "private func pollFloors() async {", to: "\n    }")
        for read in ["await refreshRunnerSnapshotIfDue()", "await refreshFocusedSessionDetailIfNeeded()",
                     "await refreshWatchesIfDue()", "await projects?.refreshIfDue(live: controlPlaneLive)",
                     "await managedRunner?.refreshIfDue()"] {
            XCTAssertTrue(floors.contains(read), "a floor: \(read)")
        }

        let sleep = try slice(app, from: "private func pollSleep(until wake: Date?) async {", to: "\n    }")
        XCTAssertTrue(sleep.contains("let seconds = wake.map { max(0, $0.timeIntervalSinceNow) } ?? 3_600"),
                      "with nothing due — the app cannot be seen — it sleeps until it is woken")
        XCTAssertTrue(sleep.contains("pollSleeper = sleeper"))
        XCTAssertTrue(sleep.contains("withTaskCancellationHandler"), "cancelling the poll ends the sleep too")
        let shown = try slice(app, from: "func setAppVisible(_ visible: Bool) {", to: "\n    }")
        XCTAssertTrue(shown.contains("if visible { pollSleeper?.cancel() }"), "shown again, it wakes for the read it owes")
        XCTAssertTrue(app.contains("var pollFailures: Int { appPoll?.failures ?? 0 }"), "pages back off with the tick")
    }

    /// The Mac's windows decide whether the app can be seen: hidden, minimized, covered or closed is
    /// not seen — and a closing window is left out of the count.
    func testTheMacStopsItsTimedReadsWhileNoWindowCanBeSeen() throws {
        let app = try source("AppModel.swift")
        let boot = try slice(app, from: "func bootstrap() {", to: "\n    }\n")
        XCTAssertTrue(boot.contains("Task { await runnerControl?.migrateLaunchAgent() }\n        observeWindowVisibility()\n        #endif"),
                      "installed once, at launch, on the Mac")
        let observe = try slice(app, from: "private func observeWindowVisibility() {", to: "\n    }\n")
        for name in ["NSApplication.didHideNotification", "NSApplication.didUnhideNotification",
                     "NSApplication.didChangeOcclusionStateNotification",
                     "NSWindow.didMiniaturizeNotification", "NSWindow.didDeminiaturizeNotification",
                     "NSWindow.didChangeOcclusionStateNotification", "NSWindow.didBecomeKeyNotification",
                     "NSWindow.willCloseNotification"] {
            XCTAssertTrue(observe.contains(name), "watched: \(name)")
        }
        XCTAssertTrue(observe.contains("Task { @MainActor in self?.setAppVisible(Self.anyWindowVisible(excluding: closing)) }"))
        let visible = try slice(app, from: "private static func anyWindowVisible(excluding closing: ObjectIdentifier?) -> Bool {",
                                to: "\n    }")
        for test in ["guard !NSApp.isHidden else { return false }", "ObjectIdentifier(window) != closing",
                     "window.level == .normal", "window.isVisible", "!window.isMiniaturized",
                     "window.occlusionState.contains(.visible)"] {
            XCTAssertTrue(visible.contains(test), "a window counts only when \(test)")
        }
        XCTAssertTrue(app.contains("#if os(macOS)\n    private func observeWindowVisibility() {"), "the observer is the Mac's")
    }

    // MARK: the control-plane stream (R4)

    /// The stream is `ControlPlaneLoop`, health and backoff included, and a 401 refreshes the session
    /// instead of stopping the stream for good.
    func testTheControlPlaneIsTheTestedLoop() throws {
        let app = try source("AppModel.swift")
        let run = try slice(app, from: "private func runControlPlane() async {", to: "\n    }\n")
        XCTAssertTrue(run.contains("let loop = ControlPlaneLoop(stream: stream,"))
        XCTAssertTrue(run.contains("refreshSession: { await api.refreshSession() },"))
        XCTAssertTrue(run.contains("case .live:\n                self.controlPlaneLive = true\n                await self.reconcileOnConnect()"))
        XCTAssertTrue(run.contains("case .event(let ev):\n                self.apply(ev)"))
        XCTAssertFalse(run.contains("policy.noteHealthy()"), "health is the loop's to judge, on the first message")
        XCTAssertFalse(run.contains("status == 401"), "a 401 no longer stops the stream")
    }

    /// A reconnect reads the Open list, the console on screen, the sidebar's workspaces and the section
    /// on screen — not the watch list, every Wiki page and every library, 12–20 requests a time.
    func testAReconnectReadsTheOpenListAndWhatIsOnScreen() throws {
        let app = try source("AppModel.swift")
        let reconnect = try slice(app, from: "private func reconcileOnConnect() async {", to: "\n    }\n")
        XCTAssertTrue(reconnect.contains("await loadSessions()"))
        XCTAssertTrue(reconnect.contains("await refreshFocusedSessionDetailIfNeeded()"))
        XCTAssertTrue(reconnect.contains("Task { await agents.reloadWorkspaces() }"), "the workspaces alone once loaded")
        XCTAssertTrue(reconnect.contains("if selectedSection == .wiki {"), "the Wiki only while it is on screen")
        XCTAssertFalse(reconnect.contains("watches.load()"), "the watch list waits for watch.changed and its floor")
        XCTAssertTrue(reconnect.contains("lifecycleHints &+= 1") && reconnect.contains("projectHints &+= 1"),
                      "each page poll on screen reads once")
        let agents = try source("AgentsModel.swift")
        let reload = try slice(agents, from: "func reloadWorkspaces() async {", to: "\n    }")
        XCTAssertTrue(reload.contains("api.agents()") && reload.contains("await refreshRunnerSnapshot()"))
        XCTAssertFalse(reload.contains("api.providers()"), "not the provider and pool libraries")
    }

    // MARK: event routing (R5)

    /// `apply` switches on `ControlEventRoute`, with no default arm: an unknown type reads nothing,
    /// `watch.changed` the watch list, `project.criteria_decisions.changed` that project's decisions.
    func testEventsAreRoutedByTheTestedRoute() throws {
        let app = try source("AppModel.swift")
        let apply = try slice(app, from: "private func apply(_ ev: ControlEvent) {", to: "\n    }\n")
        let routed = try slice(apply, from: "switch ControlEventRoute.of(ev) {", to: "case .nothing:\n            break")
        XCTAssertFalse(routed.contains("default:"), "every route is decided, none falls through to the Open list")
        XCTAssertTrue(try slice(apply, from: "case .watches:", to: "case .wiki:").contains("watches?.changed()"))
        let decisions = try slice(apply, from: "case .projectDecisions(let projectID):", to: "case .watches:")
        XCTAssertTrue(decisions.contains("consoleRegistry?.criteriaDecisionsChanged(projectID: projectID)"))
        XCTAssertFalse(decisions.contains("scheduleControlRefresh()"))
        XCTAssertTrue(try slice(apply, from: "case .openList:", to: "case .nothing:").contains("scheduleControlRefresh()"))

        let registry = try source("ConsoleRegistry.swift")
        let changed = try slice(registry, from: "func criteriaDecisionsChanged(projectID: String?) {", to: "\n    }")
        XCTAssertTrue(changed.contains("key == nil || PublicID.storageKey(own) == key"), "that project's consoles")
        XCTAssertTrue(changed.contains("Task { await model.refreshRulerQuestions(force: true) }"))
        let watches = try source("WatchesModel.swift")
        let reread = try slice(watches, from: "func changed() {", to: "\n    }")
        XCTAssertTrue(reread.contains("guard changedTask == nil else { return }"), "once for a burst")
        XCTAssertTrue(reread.contains("await self.load()"))
        XCTAssertFalse(reread.contains("isLive"), "a new watch is not live yet, and must still be read")
    }

    // MARK: page polls (R6)

    /// Every page poll is `ViewPoll`, which reads only what `PollSchedule` says is due.
    func testPagePollsAreTheTestedSchedule() throws {
        let poll = try source("ViewPoll.swift")
        XCTAssertTrue(poll.contains("var schedule = PollSchedule(interval: interval, lastReadAt: Date())"))
        XCTAssertTrue(poll.contains("schedule.hint(at: now)"))
        XCTAssertTrue(poll.contains("guard schedule.isDue(at: now, live: app.controlPlaneLive, visible: app.appVisible,\n"
                                    + "                                 failures: app.pollFailures, inFlight: inFlight()) else { continue }"))

        let agents = try source("Views/AgentsView.swift")
        XCTAssertTrue(agents.contains("await ViewPoll.run(app, every: 4, hints: { app.lifecycleHints }) {\n"
                                      + "                await agents.loadSessions(agentID: agent.id, view: view)"),
                      "Completed / Trash: the stream's hints, a minute's safety read, 4 s without the stream")
        XCTAssertFalse(agents.contains("try? await Task.sleep(nanoseconds: 4_000_000_000)"))
        let folder = try source("Views/SessionFolderPage.swift")
        XCTAssertTrue(folder.contains("await ViewPoll.run(app, every: 4, hints: { app.lifecycleHints }) {"))
        XCTAssertFalse(folder.contains("try? await Task.sleep(nanoseconds: 4_000_000_000)"))

        let landings = try source("Views/ProjectLandingsWindowView.swift")
        XCTAssertTrue(landings.contains("inFlight: { model.cardRunning ? 4 : nil }"), "4 s only while a card runs")
        let page = try source("Views/SessionProjectPage.swift")
        XCTAssertTrue(page.contains("inFlight: { app.projectSessionsLandingRunning ? 4 : nil }"))
        XCTAssertTrue(page.contains("inFlight: { app.projectSessionsMergeRunning ? 4 : nil }"))
        XCTAssertFalse(page.contains("private static func poll("), "no 4-second loop of its own")
        let model = try source("AppModel.swift")
        XCTAssertTrue(model.contains("var projectSessionsLandingRunning: Bool { ProjectPage.landingRunning(projectSessionsIntegration) }"))
        XCTAssertTrue(model.contains("var projectSessionsMergeRunning: Bool { ProjectPage.mergeRunning(projectSessionsMerge?.current) }"))
    }

    /// A row moving into or within Completed / Trash, and a project's own moves, are the pages' hints.
    func testEventsHintThePagesTheyMove() throws {
        let app = try source("AppModel.swift")
        let apply = try slice(app, from: "private func apply(_ ev: ControlEvent) {", to: "\n    }\n")
        XCTAssertTrue(try slice(apply, from: "case .sessionLeft:", to: "case .openList:").contains("lifecycleHints &+= 1"))
        XCTAssertTrue(try slice(apply, from: "case .sessionRow:", to: "case .approvalRow:")
            .contains("if agents?.agentSessions.contains(where: { $0.id == summary.id }) == true {\n                    lifecycleHints &+= 1"))
        let nudge = try slice(app, from: "private func nudgeProjects() {", to: "\n    }")
        XCTAssertTrue(nudge.contains("projects?.nudge()") && nudge.contains("projectHints &+= 1"))
    }

    /// The runners pages keep their cadence — no event reports a machine checking in — but stop while
    /// the app cannot be seen, and the app's runner snapshot takes their reads instead of its own.
    func testRunnerPagesStopWhileHiddenAndShareTheSnapshot() throws {
        let runners = try source("Views/SkillsRunnersView.swift")
        XCTAssertTrue(runners.contains("await ViewPoll.run(model, every: 15, inFlight: { 15 }) { await runners.load() }"))
        XCTAssertTrue(runners.contains("await ViewPoll.run(model, every: 15, inFlight: { 15 }) {\n"
                                       + "                await runners.load()\n                await runners.loadSessionCounts()"))
        XCTAssertTrue(try source("Views/RunnerEnginePage.swift")
            .contains("await ViewPoll.run(model, every: 10, inFlight: { 10 }) { await runners.load() }"))
        let model = try source("RunnersModel.swift")
        let load = try slice(model, from: "func load() async {", to: "\n    }")
        XCTAssertTrue(load.contains("runners = try await api.runners()\n            onRead?(runners)"))
        let app = try source("AppModel.swift")
        XCTAssertTrue(app.contains("runnersModel.onRead = { [weak self] rows in self?.adoptRunnerRows(rows) }"))
        let adopt = try slice(app, from: "private func adoptRunnerRows(_ rows: [Runner]) {", to: "\n    }")
        XCTAssertTrue(adopt.contains("agents?.adoptRunnerSnapshot(rows)"))
        XCTAssertTrue(adopt.contains("runnerSnapshotRefreshNotBefore = Date().addingTimeInterval(Self.runnerSnapshotRefreshInterval)"))
    }

    /// The Tasks page's loops and a landing's live log read nothing while the app cannot be seen.
    func testTheTasksPageAndTheLandingLogStopWhileHidden() throws {
        let tasks = try source("Views/TasksView.swift")
        for loop in ["private func listRefreshLoop(_ tasks: TasksModel) async {",
                     "private func navigationRefreshLoop(_ tasks: TasksModel) async {",
                     "private func pollLanding() async {"] {
            XCTAssertTrue(try slice(tasks, from: loop, to: "\n    }").contains("if !model.appVisible { continue }"), loop)
        }
        XCTAssertTrue(try source("Views/LandingSessionPageView.swift")
            .contains("if app.appVisible, let api, let page = try? await api.landingLog(sessionID: sessionID, selectors) {"))
    }

    /// The floors the stream keeps current wait a minute between reads while it is live.
    func testTheFloorsTheStreamKeepsCurrentWaitAMinuteWhileItIsLive() throws {
        let app = try source("AppModel.swift")
        XCTAssertTrue(try slice(app, from: "private func refreshWatchesIfDue(now: Date = Date()) async {", to: "\n    }")
            .contains("controlPlaneLive ? PollSchedule.liveFallback : Self.watchesRefreshInterval)"))
        XCTAssertTrue(try slice(source("ProjectsModel.swift"), from: "func refreshIfDue(now: Date = Date(), live: Bool = false) async {",
                                to: "\n    }")
            .contains("refreshNotBefore = now.addingTimeInterval(live ? PollSchedule.liveFallback : 15)"))
    }
}

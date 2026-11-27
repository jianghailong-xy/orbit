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
                     "await watches?.refreshIfDue(live: controlPlaneLive)", "await projects?.refreshIfDue(live: controlPlaneLive)",
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
        XCTAssertTrue(run.contains("case .live:\n                self.controlPlaneLive = true\n                self.appPoll?.streamChanged()\n"
                                   + "                await self.reconcileOnConnect()"))
        XCTAssertTrue(run.contains("case .down:\n                self.controlPlaneLive = false\n                self.appPoll?.streamChanged()"),
                      "each connection tells its own versions")
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
        XCTAssertTrue(reconnect.contains("await alignOnScreenAfterConnect()"))
        let align = try slice(app, from: "private func alignOnScreenAfterConnect() async {", to: "\n    }\n")
        XCTAssertTrue(align.contains("await refreshFocusedSessionDetailIfNeeded()"))
        XCTAssertTrue(align.contains("Task { await agents.reloadWorkspaces() }"), "the workspaces alone once loaded")
        XCTAssertTrue(align.contains("if selectedSection == .wiki {"), "the Wiki only while it is on screen")
        XCTAssertTrue(align.contains("Task { await wiki.loadSpaces() }"), "otherwise the drawer's number alone")
        XCTAssertFalse(reconnect.contains("watches.load()") || align.contains("watches.load()"),
                       "the watch list waits for watch.changed and its floor")
        XCTAssertTrue(align.contains("lifecycleHints &+= 1") && align.contains("projectHints &+= 1"),
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
        XCTAssertTrue(reread.contains("changes.nudge { [weak self] in await self?.load() }"), "once for a burst, owed while hidden")
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
                     "private func pollLanding() async {",
                     "private func pollBusyDetail() async {"] {
            XCTAssertTrue(try slice(tasks, from: loop, to: "\n    }").contains("if !model.appVisible { continue }"), loop)
        }
        XCTAssertTrue(try source("Views/LandingSessionPageView.swift")
            .contains("if app.appVisible, let api, let page = try? await api.landingLog(sessionID: sessionID, selectors) {"))
    }

    /// The floors the stream keeps current wait a minute between reads while it is live.
    func testTheFloorsTheStreamKeepsCurrentWaitAMinuteWhileItIsLive() throws {
        XCTAssertTrue(try slice(source("WatchesModel.swift"), from: "func refreshIfDue(now: Date = Date(), live: Bool) async {",
                                to: "\n    }")
            .contains("let interval = live ? PollSchedule.liveFallback : Self.floorInterval"))
        XCTAssertTrue(try slice(source("ProjectsModel.swift"), from: "func refreshIfDue(now: Date = Date(), live: Bool = false) async {",
                                to: "\n    }")
            .contains("reads.isDue(at: now, interval: live ? PollSchedule.liveFallback : 15)"))
    }

    // MARK: the list hint (P2: docs/list-freshness-design.md §3, §4 R1–R2)

    /// `sessions.list_changed` is the poll's hint — a read for a burst, and the loop woken for it — and
    /// never a read of its own; the reads made outside the tick tell the poll, so a hint they answer
    /// is not read twice.
    func testTheListHintDrivesThePoll() throws {
        let app = try source("AppModel.swift")
        let apply = try slice(app, from: "private func apply(_ ev: ControlEvent) {", to: "\n    }\n")
        let hint = try slice(apply, from: "case .listHint(let version):", to: "case .tags:")
        XCTAssertTrue(hint.contains("if appPoll?.hint(version: version, at: Date()) == true { pollSleeper?.cancel() }"))
        XCTAssertFalse(hint.contains("loadSessions") || hint.contains("scheduleControlRefresh"), "the poll reads for it")
        let refresh = try slice(app, from: "private func scheduleControlRefresh() {", to: "\n    }\n")
        XCTAssertTrue(refresh.contains("self.appPoll?.noteOpenRead(at: Date())\n                await self.loadSessions()"))
        let reconnect = try slice(app, from: "private func reconcileOnConnect() async {", to: "\n    }\n")
        XCTAssertTrue(reconnect.contains("appPoll?.noteOpenRead(at: Date())\n        await loadSessions()"))
        let run = try slice(app, from: "private func runControlPlane() async {", to: "\n    }\n")
        XCTAssertTrue(run.contains("self.appPoll?.streamChanged()\n                // Down, the Open list is read on the stream-down ramp rather than the minute's.\n                self.pollSleeper?.cancel()")
                      || run.contains("self.appPoll?.streamChanged()\n                self.pollSleeper?.cancel()"),
                      "down, the loop wakes for the stream-down cadence")
        // The poll keeps its tested defaults: 4 s down, a minute live.
        let start = try slice(app, from: "func startPolling() {", to: "\n    }\n")
        XCTAssertFalse(start.contains("liveInterval:"), "the minute's safety read is AppPoll's default")
    }

    /// The stream asks for the hint; without `hints=list_changed` the server never sends it.
    func testTheStreamDeclaresTheHint() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var text: String?
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitKit/Sources/OrbitKit/Realtime/ControlStream.swift")
            if FileManager.default.fileExists(atPath: candidate.path) {
                text = try String(contentsOf: candidate, encoding: .utf8)
                break
            }
            dir.deleteLastPathComponent()
        }
        let stream = try XCTUnwrap(text, "Realtime/ControlStream.swift wasn't found above this test")
        XCTAssertTrue(stream.contains("var req = URLRequest(url: ControlStreamURL.events(baseURL))"))
    }

    /// `tag.changed` re-reads the tag library, and the Open list whose rows draw the tags.
    func testTagChangedReadsTheTagLibrary() throws {
        let app = try source("AppModel.swift")
        let apply = try slice(app, from: "private func apply(_ ev: ControlEvent) {", to: "\n    }\n")
        let tags = try slice(apply, from: "case .tags:", to: "case .nothing:")
        XCTAssertTrue(tags.contains("whenSeen(\"tags\") { app in Task { await app.loadSessionTags() } }"))
        XCTAssertTrue(tags.contains("scheduleControlRefresh()"))
        let load = try slice(app, from: "func loadSessionTags() async {", to: "\n    }")
        XCTAssertTrue(load.contains("api.listSessionTags()"))
    }

    // MARK: the per-console and per-page loops (R3, R6)

    /// The Mac's visibility reaches the loops that are not page polls (`VisibilityGate.app`).
    func testTheGateFollowsTheAppsVisibility() throws {
        let app = try source("AppModel.swift")
        let shown = try slice(app, from: "func setAppVisible(_ visible: Bool) {", to: "\n    }")
        XCTAssertTrue(shown.contains("VisibilityGate.app.set(visible)"))
    }

    /// Each per-console and per-page loop pauses on the gate between reads — no request while the app
    /// cannot be seen, one at once when it is shown — and none sleeps on its own any more. The ones
    /// that only mean something while an operation is in flight still end when it settles.
    func testEveryConsoleAndPageLoopPausesWhileHidden() throws {
        let loops: [(file: String, from: String, to: String, pause: String)] = [
            ("WorktreeModel.swift", "func startPolling() async {", "\n    }\n", "await VisibilityGate.app.pause(pending ? 3 : 5)"),
            ("WorktreeModel.swift", "for _ in 0..<Self.diffRefreshPolls {", "\n        }\n", "await VisibilityGate.app.pause(Self.diffRefreshInterval)"),
            ("CreatedTasksModel.swift", "func startPolling() async {", "\n    }\n", "await VisibilityGate.app.pause(Self.pollInterval)"),
            ("ConsoleRegistry.swift", "private func pollOperations() async {", "\n    }\n", "await VisibilityGate.app.pause(3)"),
            ("Views/WikiJobView.swift", ".task(id: jobID) {", ".refreshable", "await VisibilityGate.app.pause(5)"),
            ("Views/WikiActivityView.swift", "while !Task.isCancelled, wiki.jobsUnderWay {", "}\n", "await VisibilityGate.app.pause(5)"),
            ("Views/WikiScreens.swift", "while !Task.isCancelled, WikiPlanLogic.jobUnderWay(wiki.plan) {", "}\n", "await VisibilityGate.app.pause(30)"),
            ("Views/ProviderPoolViews.swift", "private func waitForApproval() async {", "\n    }\n", "await VisibilityGate.app.pause(CodexSignIn.pollInterval)"),
            ("Views/CodexResetCreditView.swift", ".task(id: console.runnerID) {", ".accessibilityElement", "await VisibilityGate.app.pause(30)"),
            ("Views/SessionReplyCardView.swift", ".task(id: requestId) {", "private func load() async {", "await VisibilityGate.app.pause(60)"),
            ("RunnerSignInModel.swift", "private func startPolling() {", "\n    }\n", "await VisibilityGate.app.pause(RunnerSignInModel.pollInterval)"),
            // Found on 2026-11-20 (Orbitd 13365 hidden ten minutes): loops that slept on their own.
            ("Views/MachineSetupCard.swift", "await agents.refreshRunnerSnapshot()", ".onChange(of: runner",
             "await VisibilityGate.app.pause(MachineSetup.refreshSeconds(for: runner))"),
            ("Views/ScheduledPage.swift", "while !Task.isCancelled, scheduled?.draft(forSession: panel.sessionID) == nil {", "}\n",
             "await VisibilityGate.app.pause(3)"),
            ("Views/AddRunnerSheet.swift", "await runners.load()\n            if let baseline {", "\n    }\n",
             "await VisibilityGate.app.pause(5)"),
            ("Views/WelcomeCard.swift", "if let arrived = RunnerPageFormat.newlyOnline(", "await runners.load()",
             "await VisibilityGate.app.pause(5)"),
            ("RunnersModel.swift", "private func awaitUpdateNowAnswer(_ id: String) async {", "\n    }\n",
             "await VisibilityGate.app.pause(RunnerUpdateNow.answerPollInterval)"),
            ("RunnersModel.swift", "let askedAt = asked.requestedAt", "return nil",
             "await VisibilityGate.app.pause(ClaudeRegion.checkPollInterval)"),
            ("ConsoleModel.swift", "while !Task.isCancelled, Date().timeIntervalSince(started) < ClaudeRegion.checkWait {", "\n        }\n",
             "await VisibilityGate.app.pause(ClaudeRegion.checkPollInterval)"),
            ("ConsoleModel.swift", "codexResetPollTask = Task { [weak self] in", "\n    }\n", "await VisibilityGate.app.pause(2.5)"),
            ("AppModel.swift", "func refreshMainCheckoutSoon() {", "\n    }\n", "await VisibilityGate.app.pause(seconds)"),
        ]
        for loop in loops {
            let body = try slice(try source(loop.file), from: loop.from, to: loop.to)
            XCTAssertTrue(body.contains(loop.pause), "\(loop.file): \(loop.from) pauses on the gate")
            XCTAssertFalse(body.contains("Task.sleep"), "\(loop.file): \(loop.from) no sleep of its own")
        }
        // In flight only: the pending operations and the sign-ins stop when nothing is left to wait on.
        let registry = try slice(try source("ConsoleRegistry.swift"), from: "private func pollOperations() async {", to: "\n    }\n")
        XCTAssertTrue(registry.contains("while !Task.isCancelled, !pendingOperations.isEmpty {"))
        let runner = try slice(try source("RunnerSignInModel.swift"), from: "private func startPolling() {", to: "\n    }\n")
        XCTAssertTrue(runner.contains("if next.status?.inFlight != true { break }"))
    }

    // MARK: what an event asks for while the app cannot be seen (R3/R4; Orbitd 13365, 2026-11-20)

    /// Every read `apply` and the reconnect ask for goes through the gate: made at once while the app
    /// can be seen, owed while it cannot — the Open list as a hint to the poll, everything else once
    /// per list — and made once when it is shown. Hidden ten minutes, 0.1.261-beta.64 read 311 lists.
    func testTheAppsEventReadsAreOwedWhileHidden() throws {
        let app = try source("AppModel.swift")
        let whenSeen = try slice(app, from: "private func whenSeen(_ key: String, _ read: @escaping (AppModel) -> Void) {", to: "\n    }")
        XCTAssertTrue(whenSeen.contains("VisibilityGate.app.read(\"app.\\(key)\") { [weak self] in"))

        let apply = try slice(app, from: "private func apply(_ ev: ControlEvent) {", to: "\n    }\n")
        for (from, to, read) in [
            ("case .projectDecisions(let projectID):", "case .watches:", "whenSeen(\"criteria-decisions:"),
            ("case .wiki:", "case .terminals:", "whenSeen(\"wiki\")"),
            ("case .terminals:", "case .folders:", "whenSeen(\"terminals\")"),
            ("case .folders:", "case .providers:", "whenSeen(\"folders\")"),
            ("case .providers:", "case .sessionRow:", "whenSeen(\"providers\")"),
            ("case .tags:", "case .account:", "whenSeen(\"tags\")"),
            ("case .account:", "case .nothing:", "whenSeen(\"account\")"),
        ] {
            XCTAssertTrue(try slice(apply, from: from, to: to).contains(read), "\(from) \(read)")
        }
        XCTAssertTrue(apply.contains("whenSeen(\"clone:\\(workspaceID)\") { $0.consoleRegistry?.cloneStateMoved(workspaceID: workspaceID) }"))
        XCTAssertTrue(try slice(app, from: "private func patchCoordinatorHandoff(_ summary: ControlSessionSummary) {", to: "\n    }\n")
            .contains("whenSeen(\"unlisted-session:\\(id)\") { $0.refreshUnlistedSession(id, adoptingAgent: false) }"))

        // The Open list's whole-list refresh: owed to the poll as a hint, also when hidden mid-burst.
        let refresh = try slice(app, from: "private func scheduleControlRefresh() {", to: "\n    }\n")
        XCTAssertTrue(refresh.contains("guard appVisible else {\n            appPoll?.hint(version: nil, at: Date())\n            return\n        }"))
        XCTAssertTrue(refresh.contains("guard self.appVisible else {\n                    self.appPoll?.hint(version: nil, at: Date())\n                    break"))
        // The task and workspace libraries: the queue gathers, the drain is owed.
        let drain = try slice(app, from: "private func startLibraryRefreshDrain() {", to: "\n    }\n")
        XCTAssertTrue(drain.contains("guard appVisible else {\n            whenSeen(\"library\") { $0.startLibraryRefreshDrain() }"))
        XCTAssertTrue(drain.contains("guard self.appVisible else {\n                    self.whenSeen(\"library\") { $0.startLibraryRefreshDrain() }"))
        // A connection made while hidden reads nothing; the alignment waits for the app to be shown.
        let reconnect = try slice(app, from: "private func reconcileOnConnect() async {", to: "\n    }\n")
        XCTAssertTrue(reconnect.contains("guard appVisible else {\n            appPoll?.hint(version: nil, at: Date())\n"
                                         + "            VisibilityGate.app.read(\"app.reconnect\") { [weak self] in"))
        // What was owed is the account's: it goes with a sign-out or another instance.
        XCTAssertTrue(try slice(app, from: "func logout() {", to: "\n    }\n").contains("VisibilityGate.app.forgetOwedReads()"))
        XCTAssertTrue(try slice(app, from: "private func configure(_ url: URL) {", to: "\n    }\n").contains("VisibilityGate.app.forgetOwedReads()"))
    }

    /// The models that read on a nudge — watches, projects, a console's created tasks, the Wiki — read
    /// through `ListReads` or the gate, so a hidden app owes one read each; and every read they make
    /// counts for their floor, so the read made on the way back is not made twice.
    func testTheModelsNudgesAreOwedWhileHidden() throws {
        let watches = try source("WatchesModel.swift")
        XCTAssertTrue(try slice(watches, from: "func nudge() {", to: "\n    }").contains("nudges.nudge { [weak self] in await self?.load() }"))
        XCTAssertTrue(try slice(watches, from: "func load() async {", to: "\n    }").contains("nudges.noteRead()\n        changes.noteRead()"))
        XCTAssertFalse(watches.contains("Task.sleep"), "no delay of its own")

        let projects = try source("ProjectsModel.swift")
        XCTAssertTrue(try slice(projects, from: "    func nudge() {", to: "\n    }").contains("reads.nudge { [weak self] in"))
        XCTAssertTrue(try slice(projects, from: "    func load() async {", to: "\n    }").contains("reads.noteRead()"))

        let created = try source("CreatedTasksModel.swift")
        XCTAssertTrue(try slice(created, from: "func nudge() {", to: "\n    }").contains("reads.nudge { [weak self] in await self?.load() }"))
        XCTAssertTrue(try slice(created, from: "func load() async {", to: "\n    }").contains("reads.noteRead()"))
        XCTAssertTrue(try slice(created, from: "func startPolling() async {", to: "\n    }\n")
            .contains("guard reads.isDue(at: Date(), interval: Self.pollInterval) else { continue }"))

        XCTAssertTrue(try slice(source("WikiModel.swift"), from: "func nudge() {", to: "\n    }")
            .contains("VisibilityGate.app.read(\"wiki.loaded\")"))
        XCTAssertTrue(try slice(source("WikiChatModel.swift"), from: "func nudge() {", to: "\n    }")
            .contains("VisibilityGate.app.read(origin == .drive ? \"drive-chat.loaded\" : \"wiki-chat.loaded\")"))
    }

    /// The conversation on screen reads nothing while hidden, whatever asks: its stream's events and
    /// reconnects (queued turns, approvals, the background tray), the Open list's rows (its task's
    /// owner confirmation, its project's questions), and its own minute loops (the runner row, the
    /// evidence queue). Each read is owed under its own key and made once when the app is shown.
    func testTheConsoleReadsNothingWhileHidden() throws {
        let console = try source("ConsoleModel.swift")
        let owed = try slice(console, from: "private func owedWhileHidden(_ name: String,", to: "\n    }")
        XCTAssertTrue(owed.contains("guard !VisibilityGate.app.isVisible else { return false }"))
        XCTAssertTrue(owed.contains("VisibilityGate.app.read(\"console.\\(sessionID).\\(name)\") { [weak self] in"))
        for (function, name) in [("func refreshMadeWorkspace() async {", "made-workspace"),
                                 ("private func refreshRunner() async {", "runner"),
                                 ("private func loadContextIfUnread() async {", "context"),
                                 ("func refreshRulerQuestions(force: Bool = false) async {", "ruler"),
                                 ("func refreshScheduleCards(force: Bool = false) async {", "schedule-cards"),
                                 ("func refreshOwnerConfirmation(force: Bool = false) async {", "owner-confirmation"),
                                 ("func refreshEvidenceDecisions(force: Bool = false) async {", "evidence"),
                                 ("private func refreshApprovals() async {", "approvals"),
                                 ("private func refreshQueuedTurns() async {", "queued-turns"),
                                 ("private func refreshBackground(force: Bool = false) async {", "background")] {
            let body = try slice(console, from: function, to: "\n    }")
            let gate = try XCTUnwrap(body.range(of: "if owedWhileHidden(\"\(name)\""), "\(function) is owed while hidden")
            XCTAssertFalse(body[..<gate.lowerBound].contains("api."), "\(function) asks the gate before any request")
        }
        // The runners a console reads are the app's snapshot too: one `/runners` on the way back.
        XCTAssertTrue(try slice(console, from: "private func refreshRunner() async {", to: "\n    }").contains("onRunnersRead(rows)"))
        XCTAssertEqual(try source("ConsoleRegistry.swift").components(separatedBy: "model.onRunnersRead = { [weak self] rows in self?.onRunnersRead(rows) }").count, 3)
        XCTAssertTrue(try source("AppModel.swift").contains("consoleRegistry?.onRunnersRead = { [weak self] rows in self?.adoptRunnerRows(rows) }"))
    }
}

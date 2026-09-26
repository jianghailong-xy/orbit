import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold the "Tasks created here" card's wiring to the source instead: where it stands in the
/// band above the composer, that its poll lives and dies with the console's stream, which events
/// make it read again, that its words are OrbitKit's, and that View all narrows every read of the
/// Tasks page by the session. Each check reads the slice of the file it's about, so a match
/// somewhere else can't pass it.
final class CreatedTasksWiringTests: XCTestCase {
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
                return try String(contentsOf: candidate, encoding: .utf8)
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

    /// Background processes → Tasks created here → the branch bar: the session's output, tasks
    /// beside code, in the order the web stacks them.
    func testTheCardStandsBetweenTheBackgroundTrayAndTheBranchBar() throws {
        let band = code(try slice(source("Views/Console/ConsoleView.swift"),
                                  from: "ComposerBand {", to: "ComposerView(console: console)"))
        let tray = try XCTUnwrap(band.range(of: "BackgroundTrayView(procs: console.state.background"))
        let card = try XCTUnwrap(band.range(of: "CreatedTasksCard(console: console)"))
        let bar = try XCTUnwrap(band.range(of: "WorktreeBar(console: console)"))
        XCTAssertLessThan(tray.lowerBound, card.lowerBound)
        XCTAssertLessThan(card.lowerBound, bar.lowerBound)
    }

    /// Read on focus and polled from the console's focus state, like the branch bar — not from a
    /// `.task` on the card, which a pushed iPhone console can freeze.
    func testThePollLivesAndDiesWithTheConsolesStream() throws {
        let console = code(try source("ConsoleModel.swift"))
        let start = try slice(console, from: "func startStreaming() {", to: "\n    }")
        XCTAssertTrue(start.contains("await self?.createdTasks.startPolling()"))
        let stop = try slice(console, from: "func stopStreaming() {", to: "\n    }")
        XCTAssertTrue(stop.contains("createdTasksPollTask?.cancel()"))
        XCTAssertEqual(console.components(separatedBy: "self.createdTasks = CreatedTasksModel(").count - 1,
                       2, "both consoles build the card's model: the live one and the (inert) draft")
        let card = code(try source("Views/CreatedTasksCard.swift"))
        XCTAssertFalse(card.contains(".task {") || card.contains(".task(id:"),
                       "the card reads what the model polls; it runs no loop of its own")
    }

    /// A reconnect (no replay on the stream), a task event (maybe a task this session just made) and a
    /// run starting or settling on a task the card draws all make the focused card read again.
    func testTaskEventsAndReconnectsMakeTheFocusedCardReadAgain() throws {
        let app = code(try source("AppModel.swift"))
        XCTAssertTrue(try slice(app, from: "case .connected:", to: "case .event(let ev):")
            .contains("nudgeCreatedTasks()"))
        XCTAssertTrue(try slice(app, from: "case .taskChanged:\n", to: "case .taskListChanged:")
            .contains("nudgeCreatedTasks()"))
        XCTAssertTrue(try slice(app, from: "case .sessionCreated, .sessionUpdated:",
                                to: "case .approvalRequested, .approvalResolved:")
            .contains("nudgeCreatedTasks(taskID: taskID)"))

        let nudge = code(try slice(source("CreatedTasksModel.swift"),
                                   from: "func nudgeCreatedTasks(", to: "\n    }"))
        XCTAssertTrue(nudge.contains("focusedConsoleSessionID"), "only the card on screen reads again")
        XCTAssertTrue(nudge.contains("draws(taskID: taskID)"),
                      "a run on a task the card doesn't draw can't change it")
    }

    /// Every word on the card and on the Tasks page's chip is `SessionCreatedTasksCopy`'s, which
    /// `SessionCreatedTasksCopyParityTests` holds to the fixture the browser is proved against.
    func testTheWordsAreOrbitKits() throws {
        let card = code(try source("Views/CreatedTasksCard.swift"))
        for word in ["Tasks created here", "View all in Tasks", "Open project ›", "Replaces ", " running", " done"] {
            XCTAssertFalse(card.contains("\"\(word)") || card.contains("\(word)\""),
                           "the card spells \(word.debugDescription) itself")
        }
        for use in ["SessionCreatedTasksCopy.line(tasks)", "SessionCreatedTasksCopy.title",
                    "SessionCreatedTasksCopy.viewAll", "SessionCreatedTasksCopy.openProject",
                    "SessionCreatedTasksCopy.replaces(", "SessionCreatedTasksCopy.separator"] {
            XCTAssertTrue(card.contains(use), "the card no longer reads \(use)")
        }
        let chip = code(try slice(source("Views/TasksView.swift"),
                                  from: "private func creatorChip(", to: "\n    }"))
        XCTAssertTrue(chip.contains("SessionCreatedTasksCopy.createdIn(creator.sessionTitle)"))
        XCTAssertTrue(chip.contains("tasks.clearCreatorFilter()"), "the chip is removable")
    }

    /// View all narrows the page, its tab counts and the rows events fold in — the same scope on every
    /// read, so no read of the whole account can land in the session's page. The prerequisite picker
    /// and the drawer's No-list count are not the page and stay unscoped.
    func testViewAllNarrowsEveryReadOfThePage() throws {
        let model = code(try source("TasksModel.swift"))
        let scoped = "creatorSessionId: creatorFilter?.sessionID"
        for (start, end) in [("func load(refreshCounts:", "private func scheduleCountsRefresh("),
                             ("func loadMore() async {", "func loadNavigation() async {"),
                             ("private func reconcileFirstPageRows(", "func loadDetail(")] {
            XCTAssertTrue(try slice(model, from: start, to: end).contains(scoped), "\(start) reads unscoped")
        }
        let counts = try slice(model, from: "private func scheduleCountsRefresh(", to: "func loadMore() async {")
        XCTAssertTrue(counts.contains("taskCounts(listId: listID, creatorSessionId: creatorID)"))
        XCTAssertTrue(counts.contains("let key = countsScope"), "counts are keyed by both scopes")
        XCTAssertTrue(try slice(model, from: "private func applyChangedTask(", to: "\n    }")
            .contains("creatorSessionID: creatorFilter?.sessionID"))
        XCTAssertFalse(try slice(model, from: "func loadNavigation() async {", to: "\n    }")
            .contains("creatorSessionId"))
        XCTAssertFalse(try slice(model, from: "func loadDependencyCandidates(", to: "\n    }")
            .contains("creatorSessionId"))

        let viewAll = code(try slice(source("CreatedTasksModel.swift"),
                                     from: "func showTasksCreated(", to: "\n    }"))
        XCTAssertTrue(viewAll.contains("selectedSection = .tasks"))
        XCTAssertTrue(viewAll.contains("tasks?.showCreated(in:"))
    }

    /// On a phone the card's three ways out — a task row, `Open project ›`, `View all in Tasks ›` —
    /// open over the console, on its own stack, so the back swipe returns to the conversation. A
    /// move to the Tasks or Projects section left the swipe that section's list (the owner's report,
    /// 2026-09-25). The wide shells keep the section move; the view decides which, not the model.
    func testOnAPhoneTheCardsWaysOutOpenOverTheConsole() throws {
        let card = code(try source("Views/CreatedTasksCard.swift"))
        XCTAssertTrue(card.contains("openPage(.taskDetail(taskID: row.id)) { app.route(to: .task(row.id)) }"),
                      "a row opens its task over the console on a phone, in the Tasks pane otherwise")
        XCTAssertTrue(card.contains("openPage(.projectDetail(projectID: project.id)) { app.openProject(project.id) }"))
        XCTAssertTrue(card.contains("openPage(.createdTasks(sessionID: console.sessionID))"))
        let open = try slice(card, from: "private func openPage(", to: "\n    }")
        XCTAssertTrue(open.contains("if overConsole { app.push(page) } else { elsewhere() }"),
                      "a push on the stack on screen — the console's — where the console says so")
        XCTAssertTrue(card.contains("@Environment(\\.opensPagesOverConsole) private var overConsole"),
                      "and the console's environment is what says so, not a width read of the card's own")

        // The Agents stack renders what a console opens over itself; otherwise the push is a blank page.
        let agents = code(try slice(try source("Views/CompactShell.swift"),
                                    from: "case .agents:", to: "// PROJECTS"))
        XCTAssertTrue(agents.contains(".environment(\\.opensPagesOverConsole, true)"),
                      "the phone's stack is the one place that tells its console to push")
        XCTAssertTrue(agents.contains("case .taskDetail(let taskID):       TaskDetailPage(taskID: taskID)"))
        XCTAssertTrue(agents.contains("case .projectDetail(let projectID): ProjectDetailView(projectID: projectID)"))
        XCTAssertTrue(agents.contains("case .createdTasks(let sessionID):  CreatedTasksPage(sessionID: sessionID)"))
        XCTAssertTrue(agents.contains("case .watches:                      FollowingListView(rowNavigation: .push)"))
        XCTAssertTrue(agents.contains("case .watchDetail(let watchID):     WatchDetailView(watchID: watchID)"))

        // The View all page reads every task the session created, fifty at a time, and a row opens
        // its task on the same stack.
        let page = code(try slice(try source("Views/CreatedTasksPage.swift"),
                                  from: "struct CreatedTasksPage: View {", to: "\n}"))
        XCTAssertTrue(page.contains("app.push(.taskDetail(taskID: task.id))"))
        let read = code(try slice(try source("AppModel.swift"),
                                  from: "func tasksCreated(inSession sessionID: String", to: "\n    }"))
        XCTAssertTrue(read.contains("creatorSessionId: sessionID"))
    }

    /// The same rule for every other door out of a conversation (the owner, 2026-09-25: "change them
    /// to the same behaviour"): a link in the transcript — as prose or as a card — and the Watching
    /// card's target rows and `Manage in Watches ›` all hand the console's answer to the model, which
    /// pushes a task, another session or the Following page over the console on a phone.
    func testEveryDoorOutOfAConversationPushesOverItOnAPhone() throws {
        let app = code(try source("AppModel.swift"))
        let opener = try slice(app, from: "func openFromConversation(_ route: Route, overConsole: Bool) {",
                               to: "\n    }")
        XCTAssertTrue(opener.contains("guard overConsole else { return self.route(to: route) }"),
                      "off a phone's conversation nothing changes: it is a route")
        XCTAssertTrue(opener.contains("case .task(let id):    push(.taskDetail(taskID: id))"))
        XCTAssertTrue(opener.contains("case .session(let id): pushConsole(id)"))
        let pushConsole = try slice(app, from: "func pushConsole(_ id: String) {", to: "\n    }")
        XCTAssertTrue(pushConsole.contains("push(.console(sessionID: id, origin: .conversation))"),
                      "another conversation goes on top of this one, not in its place")
        XCTAssertTrue(pushConsole.contains("refreshUnlistedSession(id, adoptingAgent: false)"),
                      "and the list under both conversations keeps its agent")

        let prose = code(try source("Views/Console/SelectableText.swift"))
        XCTAssertTrue(prose.contains("context.coordinator.opensOverConsole = context.environment.opensPagesOverConsole"))
        XCTAssertTrue(prose.contains("self.app?.openFromConversation(route, overConsole: self.opensOverConsole)"))
        XCTAssertTrue(prose.contains("self.app?.openOrbitLink(url, overConsole: self.opensOverConsole)"))
        XCTAssertTrue(code(try source("Views/OrbitLinkCardView.swift"))
            .contains("app.open(cards.destination(for: ref), overConsole: overConsole)"))

        let watching = code(try source("Views/WatchingCard.swift"))
        XCTAssertTrue(watching.contains("model.openFromConversation(destination, overConsole: overConsole)"),
                      "a watch's target opens over the conversation")
        XCTAssertTrue(watching.contains("if overConsole { model.push(.watches) } else { model.selectedSection = .following }"),
                      "and so does the Following page its strip leads to")
    }

    /// An open card in the band never draws as a header and a footer with nothing between them (the
    /// owner's report, 2026-09-25: the Watching strip opened above an open Tasks created here card
    /// took the band's whole share and left the card's rows at no height). The strip's facts are
    /// capped and scroll inside; each list keeps two rows however little room is left.
    func testAnOpenCardKeepsItsRowsWhenAnotherOpensAboveIt() throws {
        let card = code(try source("Views/CreatedTasksCard.swift"))
        XCTAssertEqual(card.components(separatedBy: ".frame(minHeight: Self.listFloor(items), maxHeight: Self.listCap)")
            .count - 1, 2, "both of the list's scrolling shapes keep the floor")
        XCTAssertFalse(card.contains(".frame(maxHeight: Self.listCap)"), "no scrolling shape without one")
        let watching = code(try source("Views/WatchingCard.swift"))
        XCTAssertTrue(watching.contains(".frame(minHeight: Self.factsFloor, maxHeight: Self.factsCap)"),
                      "the strip's facts scroll inside past a cap, above a floor")
        XCTAssertTrue(code(try source("Views/WorktreeBar.swift"))
            .contains(".frame(minHeight: CGFloat(min(procs.count, 2)) * 30, maxHeight: 320)"),
                      "and the Background processes list keeps its floor too")
    }
}

import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. These hold the Projects
/// section and the drawer that leads to it to the source they are: the section's stack is the only
/// copy of which project is showing, the three-column shells select through a projection of it, and
/// the iPhone drawer leads with the work — Projects, Tasks — above the Workspaces, with the open
/// projects closing the rail where the task lists and Recents used to be.
final class ProjectsWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    private func appSource(_ relative: String) throws -> String {
        let path = "src/macos/OrbitApp/Sources/OrbitApp/\(relative)"
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(path)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: path)
    }

    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    func testTheCompactProjectsSectionIsAStackBoundToItsOwnStack() throws {
        let shell = try appSource("Views/CompactShell.swift")
        let projects = code(try slice(shell, from: "case .projects:", to: "case .runners:"))
        XCTAssertTrue(projects.contains("NavigationStack(path: $model.nav.path)"))
        XCTAssertTrue(projects.contains("ProjectsListView(rowNavigation: .push)"))
        XCTAssertTrue(projects.contains("case .projectDetail(let projectID, _):"))
        XCTAssertTrue(projects.contains("ProjectDetailView(projectID: projectID)"))
        // A project's task opens over the project's page on this stack, so the back swipe returns to
        // the project. It used to open in Tasks — whose every-task scope is the tasks outside
        // projects since 2026-09-26 — where back landed on a list the task is not in.
        XCTAssertTrue(projects.contains("case .taskDetail(let taskID):       TaskDetailPage(taskID: taskID)"),
                      "a project's task is a page of the Projects stack")
    }

    /// A task row on a project's page — and the other task links on it: the graph, the held tasks,
    /// an item's task — pushes the task over the page, on the phone and in the wide shells alike.
    /// The wide shells' pane draws that task over its project with the way back to it, and the task
    /// page's project line, over that project's page, goes back down to it instead of stacking a
    /// second copy of the page (the web's project page opens its tasks the same way).
    func testAProjectsTaskOpensOverItsPageAndItsProjectLineGoesBack() throws {
        let view = code(try appSource("Views/ProjectsView.swift"))
        let open = try slice(view, from: "private func openTask(_ taskID: String) {", to: "\n    }")
        XCTAssertTrue(open.contains("model.push(.taskDetail(taskID: taskID))"))
        XCTAssertFalse(open.contains("route(to: .task"), "not in Tasks")

        let pane = try slice(view, from: "struct ProjectDetailPane: View {", to: "\n}\n")
        let task = try XCTUnwrap(pane.range(of: "if let taskID = model.nav.taskDetailOnTop, model.nav.projectBeneathTask != nil {"),
                                 "the pane draws a task only over its project's page")
        let project = try XCTUnwrap(pane.range(of: "} else if let id = model.selectedProjectID {"))
        XCTAssertTrue(task.lowerBound < project.lowerBound, "the task on top wins over the page under it")
        XCTAssertTrue(pane.contains("TaskDetailPage(taskID: taskID)"))
        XCTAssertTrue(pane.contains("Button { model.nav.pop() }"), "with the way back to the page")

        let tasks = code(try appSource("Views/TasksView.swift"))
        let line = try slice(tasks, from: "private func projectLine(_ project: TaskProjectRef) -> some View {", to: "label: {")
        XCTAssertTrue(line.contains("model.openTaskProject(project.id)"))

        let app = code(try appSource("AppModel.swift"))
        let back = try slice(app, from: "func openTaskProject(_ id: String) {", to: "\n    }")
        let pop = try XCTUnwrap(back.range(of: "if nav.returnToProject(id) { return }"))
        let openIt = try XCTUnwrap(back.range(of: "openProject(id)"))
        XCTAssertTrue(pop.lowerBound < openIt.lowerBound, "back down when the page is right there, open it otherwise")

        // Selecting in the wide shells' list takes a task open over the project with it — except
        // selecting the same project again, which is no change.
        let selected = try slice(app, from: "var selectedProjectID: String? {", to: "\n    }\n")
        XCTAssertTrue(selected.contains("if nav.projectBeneathTask != nil {"))
        XCTAssertTrue(selected.contains("nav.pop()"))
    }

    func testTheThreeColumnShellsSelectThroughAProjectionOfTheStack() throws {
        let main = code(try appSource("Views/MainView.swift"))
        XCTAssertTrue(main.contains("case .projects:\n            ProjectsListView()"))
        XCTAssertTrue(main.contains("case .projects:\n            ProjectDetailPane()"))
        let app = code(try appSource("AppModel.swift"))
        let selected = try slice(app, from: "var selectedProjectID: String? {", to: "\n    }\n")
        XCTAssertTrue(selected.contains("get { nav.selectedProjectID }"))
        XCTAssertTrue(selected.contains("nav.replaceTop(with: .projectDetail(projectID: id))"))
        let list = code(try appSource("Views/ProjectsView.swift"))
        XCTAssertTrue(list.contains("List(selection: rowNavigation == .selection ? $model.selectedProjectID : nil)"))
        XCTAssertTrue(list.contains("model.push(.projectDetail(projectID: project.id))"))
    }

    func testTheDrawerLeadsWithTheWorkAndClosesWithTheOpenProjects() throws {
        let shell = try appSource("Views/CompactShell.swift")
        let rail = code(try slice(shell, from: "            List {", to: "            .listStyle(.plain)"))
        let order = ["ForEach(AppSection.workSections)", "workspacesHeader", "agentsRows", "projectRows"]
        let positions = order.map { rail.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil), "the rail lost one of \(order)")
        XCTAssertEqual(positions.compactMap { $0 }, positions.compactMap { $0 }.sorted(),
                       "the rail reads work, then Workspaces, then the open projects")
        XCTAssertFalse(rail.contains("recentsRows"), "Recents is not in the drawer")
        XCTAssertFalse(rail.contains("taskRows"), "the task lists are not in the drawer")
        let row = code(try slice(shell, from: "private func projectRow(", to: ".drawerRow()"))
        XCTAssertTrue(row.contains("model.openProject(project.id, origin: .drawer)"))
    }

    /// A project's page the drawer opened gives the left edge back to the drawer, as a Recents console
    /// does (the owner's report, 2026-09-29: the swipe went back to the Projects list instead). The
    /// edge strip is up while that page is on top, and the page turns the system back-swipe off; the
    /// two read the same fact, so they cannot disagree about who has the edge.
    func testADrawerOpenedProjectPageHandsTheLeftEdgeToTheDrawer() throws {
        let shell = code(try appSource("Views/CompactShell.swift"))
        XCTAssertTrue(shell.contains(
            "if !drawerOpen && (isAtRoot || model.consoleFromRecents || model.projectFromDrawer) {"),
                      "the drawer-open strip is up on that page")
        let projects = try slice(shell, from: "case .projects:", to: "case .runners:")
        XCTAssertTrue(projects.contains(".background { SwipeBackGestureToggle(enabled: !model.projectFromDrawer) }"),
                      "and the system back-swipe is off there")
        let toggle = try slice(shell, from: "private func setSwipeBacks(enabled: Bool) {", to: "\n        }")
        XCTAssertTrue(toggle.contains("interactiveContentPopGestureRecognizer?.isEnabled = enabled"),
                      "iOS 26's swipe-back from anywhere in the content included")

        let app = code(try appSource("AppModel.swift"))
        XCTAssertTrue(app.contains("var projectFromDrawer: Bool { nav.projectFromDrawer }"))
        let open = try slice(app, from: "func openProject(_ id: String, origin: NavOrigin = .list) {", to: "\n    }")
        XCTAssertTrue(open.contains("nav.path = [.projectDetail(projectID: id, origin: origin)]"),
                      "the origin rides the frame the drawer's row puts up")
    }

    func testTheProjectPageDrawsTheWebsSectionsInTheWebsOrder() throws {
        let view = code(try appSource("Views/ProjectsView.swift"))
        let page = try slice(view, from: "private func page(", to: ".projectPageListStyle()")
        let order = ["openItemsSection(", "overviewSection(", "coordinatorSection(", "runSettingsSection(",
                     "goalSection(", "graphSection(", "blockersSection(", "runQueueSection(", "criteriaSection(",
                     "instructionsSection(", "tasksSection("]
        let positions = order.map { page.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil), "the page lost one of \(order)")
        XCTAssertEqual(positions.compactMap { $0 }, positions.compactMap { $0 }.sorted(),
                       "the sections read in the web's order (ProjectPageSectionsCopyParityTests holds the web's)")
        let overview = try slice(view, from: "private func overviewSection(", to: "private func overviewCell(")
        XCTAssertTrue(overview.contains("model.selectedSection = .runners"),
                      "the stalled banner's press goes where an engine signs in")
    }

    /// A project nobody has started (mock board3 ②) says so in its header, and its Open items lead
    /// with the start: the coordinator's request — whose Review lands on the card in the coordinator
    /// conversation, by Answer's own door and origin, rather than a second copy drawn here — or,
    /// while nobody has asked, the owner's own Start…, which opens that same card over the page.
    func testANotStartedProjectLeadsItsOpenItemsWithTheStart() throws {
        let view = code(try appSource("Views/ProjectsView.swift"))
        XCTAssertTrue(view.contains(
            "if document.status == .open && document.started == false { return StartProject.notStarted }"),
                      "the status tag says Not started for an open project nobody has started")
        let items = try slice(view, from: "private func openItemsSection(", to: "private func startItem(")
        XCTAssertTrue(items.contains("StartProject.pageRow(status: document.status, started: document.started,"))
        XCTAssertTrue(items.contains("if let start { startItem(start, store: store, now: now) }"))
        XCTAssertTrue(items.contains("ProjectPage.openItemsHint(needsYou: needsYou.count + asking,"),
                      "the request needs you and is counted; the owner's own Start… is not")

        let row = try slice(view, from: "private func startItem(", to: "private func reviewStart(")
        XCTAssertTrue(row.contains("case .asked(let row):"))
        XCTAssertTrue(row.contains("StartProject.requestSummary($0.settings)"))
        XCTAssertTrue(row.contains("reviewStart(store)"))
        XCTAssertTrue(row.contains("case .own:"))
        XCTAssertTrue(row.contains("pageSheet = .start"))
        XCTAssertFalse(row.contains("StartProjectCard("),
                       "a request is answered on its card in the conversation; the page draws no second copy")

        // Review is Answer's door with the start card as where it lands — one door, one origin.
        let review = try slice(view, from: "private func reviewStart(", to: "\n    }")
        XCTAssertTrue(review.contains("openCoordinator(store, focus: nil, startCard: true)"))
        let open = try slice(view, from: "private func openCoordinator(", to: "private func replaceCoordinator(")
        XCTAssertTrue(open.contains("focus: item, focusStartCard: startCard)"))
        let app = code(try appSource("AppModel.swift"))
        let door = try slice(app, from: "func openProjectCoordinator(", to: "\n    }\n")
        XCTAssertTrue(door.contains(
            "if focusStartCard { consoleRegistry?.model(for: id, agentID: agent).focusStartCard() }"))
        XCTAssertEqual(door.components(separatedBy: "origin: ").count - 1, 1,
                       "Review opens the conversation through Answer's entrance and its origin, not one of its own")
        let console = code(try appSource("ConsoleModel.swift"))
        let focus = try slice(console, from: "func focusStartCard() {", to: "\n    }")
        XCTAssertTrue(focus.contains("pendingStartCard = true"))
        XCTAssertTrue(focus.contains("await refreshRulerQuestions(force: true)"),
                      "spent by the read, like an owner item's press: the console is not on screen yet")
        let spend = try slice(console, from: "private func scrollToPendingOwnerItem() {",
                              to: "guard let item = pendingOwnerItem")
        XCTAssertTrue(spend.contains("if case .startProject = $0.kind { return true }"))
        XCTAssertTrue(spend.contains("requestScroll(to: card.id)"))

        // Start… opens the same card, set by the default rule, saying nothing a coordinator said.
        let sheet = try slice(view, from: "private struct OwnerStartProjectSheet: View {",
                              to: "private struct MergeCheckEditor: View {")
        XCTAssertTrue(sheet.contains("StartProjectCard("))
        XCTAssertTrue(sheet.contains("askedAt: nil,"))
        XCTAssertTrue(sheet.contains("StartProject.defaultSettings(view: store.integration,"))
        XCTAssertTrue(sheet.contains("StartProject.ownerRequest(settings: settings,"))
        XCTAssertTrue(sheet.contains("StartProject.body(request: request, draft: draft,"))
        XCTAssertTrue(sheet.contains("requestId: nil"))
        XCTAssertFalse(sheet.contains("onChatAbout"), "there is no conversation to talk in over the page")
        let cards = code(try appSource("Views/ApprovalCards.swift"))
        let card = try slice(cards, from: "struct StartProjectCard: View {",
                             to: "private struct CriteriaChangeCardView: View")
        XCTAssertTrue(card.contains("aside: asked ? StartProject.suggestedByCoordinator : nil)"))
        XCTAssertTrue(card.contains("if asked {"), "Orbit checked the plan only where a ready check ran")
        XCTAssertTrue(card.contains("if let onChatAbout { chatButton(onChatAbout) }"))
        let conversation = try slice(cards, from: "private struct StartProjectCardView: View {",
                                     to: "struct StartProjectCard: View {")
        XCTAssertTrue(conversation.contains("StartProjectCard("),
                      "the conversation's card and the page's are one card")
    }

    /// How it runs (mock board3 ③): once the project is started, one block holds every setting the
    /// start card set — Automatic among them, gone from the coordinator card — each written as it is
    /// changed at the door that owns it, and Pause project beside them.
    func testHowItRunsIsOneBlockAndAutomaticLeftTheCoordinatorCard() throws {
        let view = code(try appSource("Views/ProjectsView.swift"))
        let coordinator = try slice(view, from: "private func coordinatorSection(", to: "private func color(")
        XCTAssertFalse(coordinator.contains("Toggle("), "Automatic is How it runs', not the coordinator card's")
        XCTAssertFalse(coordinator.contains("Automatic"))

        let block = try slice(view, from: "private func runSettingsSection(", to: "private func lineSetting(")
        XCTAssertTrue(block.contains("if RunSettings.shown(started: document.started) {"))
        XCTAssertTrue(block.contains("sectionHeader(StartProject.howItRuns, detail: RunSettings.appliesFromNextTask)"))
        XCTAssertTrue(block.contains("Text(RunSettings.notLoaded)"))
        let order = ["lineSetting(", "automaticSetting(", "atMostSetting(", "mergeCheckSetting(",
                     "escalationSetting(", "pauseSetting("]
        let positions = order.map { block.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil), "the block lost one of \(order)")
        XCTAssertEqual(positions.compactMap { $0 }, positions.compactMap { $0 }.sorted(),
                       "the rows read in the web's order (ProjectRunSettingsCopyParityTests holds the web's)")

        let line = try slice(view, from: "private func lineSetting(", to: "private func lineOption(")
        XCTAssertTrue(line.contains("if view.locked {"))
        XCTAssertTrue(line.contains("systemImage: \"lock.fill\")"), "a locked line is drawn locked")
        XCTAssertTrue(line.contains("RunSettings.lineLocked(since:"), "and says why it can no longer move")
        let option = try slice(view, from: "private func lineOption(", to: "private func automaticSetting(")
        XCTAssertTrue(option.contains("store.updateIntegration(RunSettings.lineWrite(view, to: line))"))
        let automatic = try slice(view, from: "private func automaticSetting(", to: "private func atMostSetting(")
        XCTAssertTrue(automatic.contains("store.updateAuthorization(automatic: next)"))
        XCTAssertTrue(automatic.contains("RunSettings.automaticHint("))
        let atMost = try slice(view, from: "private func atMostSetting(", to: "private func mergeCheckSetting(")
        XCTAssertTrue(atMost.contains("Stepper(RunSettings.atMost"))
        XCTAssertTrue(atMost.contains("store.stepConcurrency(to: next)"))
        let check = try slice(view, from: "private func mergeCheckSetting(", to: "private func escalationSetting(")
        XCTAssertTrue(check.contains("RunSettings.mergeCheckMissing(onLine: view.line,"))
        XCTAssertTrue(check.contains("pageSheet = .mergeCheck"))
        // Its editor keeps a refused save on the sheet — the door's words under the command as typed —
        // and closes only on one that went through: an alert raised on the page while the sheet went
        // down would be lost with it.
        let editor = try slice(view, from: "private struct MergeCheckEditor: View {", to: "private extension View {")
        XCTAssertTrue(editor.contains("if let refused {"))
        let save = try slice(editor, from: "private func save() {", to: "\n    }\n")
        XCTAssertTrue(save.contains("if let failure = await store.updateIntegration(write) {"))
        XCTAssertFalse(try slice(save, from: "if let failure", to: "} else {").contains("dismiss()"),
                       "a refused save keeps the sheet up")
        XCTAssertTrue(save.components(separatedBy: "} else {").last?.contains("dismiss()") == true)
        let escalate = try slice(view, from: "private func escalationSetting(", to: "private func pauseSetting(")
        XCTAssertTrue(escalate.contains(".pickerStyle(.menu)"))
        XCTAssertTrue(escalate.contains("RunSettings.escalationOptions(current: seconds)"))
        XCTAssertTrue(escalate.contains("store.updateIntegration(RunSettings.escalationWrite(view, to: next))"))
        let pause = try slice(view, from: "private func pauseSetting(", to: "private func goalSection(")
        XCTAssertTrue(pause.contains("Button(paused ? RunSettings.resume : RunSettings.pause)"))
        XCTAssertTrue(pause.contains("store.setPaused(!paused)"))
        XCTAssertTrue(pause.contains("RunSettings.pauseFootnote(pausedAt: document.pausedAt, now: now)"))

        // The writes: the integration door, now written from this client too, and the project's own
        // with `automatic` — never `coordinatorEnabled`, whose off the server also reads as a pause.
        let model = code(try appSource("ProjectsModel.swift"))
        XCTAssertTrue(model.contains("api.updateProjectAuthorization("))
        XCTAssertTrue(model.contains("UpdateProjectAuthorizationRequest(automatic: automatic,"))
        XCTAssertTrue(model.contains("api.updateProjectIntegration(self.projectID, body)"))
        XCTAssertTrue(model.contains("api.pauseProject(self.projectID)"))
        XCTAssertTrue(model.contains("api.resumeProject(self.projectID)"))
        XCTAssertFalse(model.contains("coordinatorEnabled:"), "Automatic is written as `automatic`")
    }

    func testAnOwnerItemOpensItsCardInTheCoordinatorConversation() throws {
        let app = code(try appSource("AppModel.swift"))
        let open = try slice(app, from: "func openProjectCoordinator(", to: "\n    }\n")
        XCTAssertTrue(open.contains(".focus(ownerItem: item)"),
                      "a press on an owner item lands on its card, the way the needs-you banner's does")
        XCTAssertTrue(open.contains("show(.console(sessionID: id, origin: .list), agent: agent)"))

        // A project page a phone opened over this conversation goes back down to it, card focused
        // first: putting the conversation on top again stacked a second copy of it over the first.
        let focus = try XCTUnwrap(open.range(of: ".focus(ownerItem: item)"))
        let back = try XCTUnwrap(open.range(of: "if nav.returnToConsole(id) { return }"),
                                 "the coordinator door goes back to the conversation under the page")
        let show = try XCTUnwrap(open.range(of: "show(.console(sessionID: id, origin: .list), agent: agent)"))
        XCTAssertTrue(focus.lowerBound < back.lowerBound && back.lowerBound < show.lowerBound,
                      "focus the card, go back if the conversation is right there, open it otherwise")
    }
}

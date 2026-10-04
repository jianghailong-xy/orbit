import Foundation
import XCTest
@testable import OrbitKit

/// The iOS project row and its sessions page (design §4–5). Source checks cover the SwiftUI
/// connections Linux cannot compile; navigation and grouping values have their own executable tests.
final class SessionProjectPageWiringTests: XCTestCase {
    private struct SourceMissing: Error { let path: String }

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

    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    private func slice(_ text: String, from start: String, to end: String,
                       file: StaticString = #filePath, line: UInt = #line) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`", file: file, line: line)
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`", file: file, line: line)
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    private func branches(of needle: String, in text: String,
                          file: StaticString = #filePath, line: UInt = #line) throws -> [String] {
        let at = try XCTUnwrap(text.range(of: needle), "no `\(needle)`", file: file, line: line)
        var stack: [String] = []
        for row in text[..<at.lowerBound].split(separator: "\n", omittingEmptySubsequences: false) {
            let directive = row.components(separatedBy: "//")[0].trimmingCharacters(in: .whitespaces)
            if directive.hasPrefix("#if ") {
                stack.append(String(directive.dropFirst(4)))
            } else if directive.hasPrefix("#elseif "), !stack.isEmpty {
                stack[stack.count - 1] = String(directive.dropFirst(8))
            } else if directive == "#else", let open = stack.popLast() {
                stack.append("!" + open)
            } else if directive == "#endif" {
                _ = stack.popLast()
            }
        }
        return stack
    }

    func testTheWorkspaceAndFolderListsDrawTheGroupingResult() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        let listing = try slice(agents, from: "private var projectListing: SessionProjectListing {", to: "\n    }")
        for part in ["SessionProjectGrouping.listing(shownSessions,",
                     "projects: app.projects?.sidebarProjects ?? [], view: view,",
                     "byTag: tagFilter != nil || groupByTag, searching: isSearching,",
                     "runnerOffline: agents.runnerIsOffline(agent.runnerId)",
                     "coordinators: agents.allSessions + app.sessions",
                     "contentSessions: view == .open ? app.sessions : agents.allSessions"] {
            XCTAssertTrue(listing.contains(part), "the workspace grouping carries `\(part)`")
        }
        let folders = try slice(agents, from: "private var folderListing: SessionFolderListing {", to: "\n    }")
        XCTAssertTrue(folders.contains("SessionFolderGrouping.listing(shownSessions,"))
        XCTAssertTrue(folders.contains("folders: projectListing.folders"))
        XCTAssertTrue(folders.contains("projectListing.entries.map(\\.timeGroupingSession)"))
        XCTAssertTrue(agents.contains("let projectRows = Dictionary(uniqueKeysWithValues: projectListing.projects.map { ($0.id, $0) })"))
        XCTAssertTrue(agents.contains("listRow(session, projects: projectRows)"))
        let row = try slice(agents, from: "@ViewBuilder private func listRow(_ s: Session, projects: [String: SessionProjectRow])", to: "\n    }")
        XCTAssertTrue(row.contains("if let project = projects[s.id]"))
        XCTAssertTrue(row.contains("projectRow(project)"), "the recency projection is rendered as a project, never as a session")
        XCTAssertTrue(row.contains("sessionRow(s)"))
        XCTAssertEqual(try branches(of: "private var projectListing: SessionProjectListing {", in: agents), ["os(iOS)"])

        let page = code(try appSource("Views/SessionFolderPage.swift"))
        let folderListing = try slice(page, from: "private var projectListing: SessionProjectListing {", to: "\n    }")
        XCTAssertTrue(folderListing.contains("SessionProjectGrouping.listing(app.agents?.agentSessions ?? [],"))
        XCTAssertTrue(folderListing.contains("folderID: address.folderID"))
        XCTAssertTrue(folderListing.contains("searching: isSearching"))
        XCTAssertTrue(page.contains("return projectListing.entries.map(\\.timeGroupingSession)"))
        XCTAssertTrue(page.contains("let projectRows = Dictionary(uniqueKeysWithValues: projectListing.projects.map { ($0.id, $0) })"))
        XCTAssertTrue(page.contains("listRow(session, projects: projectRows)"))
        let folderRow = try slice(page, from: "@ViewBuilder private func listRow(_ s: Session, projects: [String: SessionProjectRow])", to: "\n    }")
        XCTAssertTrue(folderRow.contains("if let project = projects[s.id]"))
        XCTAssertTrue(folderRow.contains("projectRow(project)"))
        XCTAssertTrue(folderRow.contains("sessionRow(s)"))
    }

    func testTheRowUsesTheGroupingTargetAndItsProgressOpensSessions() throws {
        for relative in ["Views/AgentsView.swift", "Views/SessionFolderPage.swift"] {
            let source = code(try appSource(relative))
            let row = try slice(source, from: "private func projectRow(_ row: SessionProjectRow)", to: "\n    }")
            XCTAssertTrue(row.contains("SessionProjectAddress(projectID: row.projectId"))
            XCTAssertTrue(row.contains("let onOpen = {"))
            XCTAssertTrue(row.contains("SessionProjectRowView(row: row, onOpen: onOpen,"))
            XCTAssertTrue(row.contains("switch row.target"))
            XCTAssertTrue(row.contains("case .session(let id):"))
            XCTAssertTrue(row.contains("$0.id == id"))
            XCTAssertTrue(row.contains("app.openProjectMember(session, push: rowNavigation == .push)"))
            XCTAssertTrue(row.contains("case .project: app.openProjectSessions("))
            XCTAssertTrue(row.contains("onSessions: { app.openProjectSessions("))
            XCTAssertTrue(row.contains(".sessionProjectRowActions(row, onOpen: onOpen,"),
                          "the row and its Open Session menu share the grouping target's callback")
            XCTAssertTrue(row.contains("app.openProject(row.projectId)"))
            XCTAssertTrue(row.contains("movingSession = coordinator"))
        }
        let agents = code(try appSource("Views/AgentsView.swift"))
        let workspaceMove = try slice(agents, from: ".sheet(item: $movingSession) { s in", to: "\n        }")
        XCTAssertTrue(workspaceMove.contains("agents.agent(s.agent?.id ?? s.agentId ?? agent.id)"))
        XCTAssertTrue(workspaceMove.contains("SessionMoveSheet(session: s, workspace: workspace, listed: agents.allSessions)"))
        let folder = code(try appSource("Views/SessionFolderPage.swift"))
        let folderMove = try slice(folder, from: ".sheet(item: $movingSession) { s in", to: "\n        }")
        XCTAssertTrue(folderMove.contains("app.agents?.agent(s.agent?.id ?? s.agentId ?? address.agentID)"))
        XCTAssertTrue(folderMove.contains("SessionMoveSheet(session: s, workspace: workspace, listed: app.agents?.allSessions ?? [])"))
    }

    func testTheTwoShellsOpenTheProjectSessionsPageTheirOwnWay() throws {
        let compact = code(try appSource("Views/CompactShell.swift"))
        let frames = try slice(compact, from: "case .compose(let agentID, let folderID):", to: "default:")
        XCTAssertTrue(frames.contains("case .sessionProject(let address):"))
        XCTAssertTrue(frames.contains("SessionProjectPage(address: address)"))

        let agents = code(try appSource("Views/AgentsView.swift"))
        let column = try slice(agents, from: "if let address = app.projectSessionsColumn, rowNavigation == .selection {", to: "} else")
        XCTAssertTrue(column.contains("SessionProjectPage(address: address, rowNavigation: rowNavigation)"))
        XCTAssertEqual(try branches(of: "if let address = app.projectSessionsColumn, rowNavigation == .selection {", in: agents), ["os(iOS)"])

        let app = code(try appSource("AppModel.swift"))
        let open = try slice(app, from: "func openProjectSessions(_ address: SessionProjectAddress) {", to: "\n    }")
        XCTAssertTrue(open.contains("nav.enterProjectSessions(address)"))
        let leave = try slice(app, from: "func leaveProjectSessions(_ projectID: String? = nil) {", to: "\n    }")
        XCTAssertTrue(leave.contains("nav.leaveProjectSessions(projectID)"))
    }

    func testTheProjectPageHasNoSearchAndOtherListsKeepTheColumnsSearch() throws {
        let page = code(try appSource("Views/SessionProjectPage.swift"))
        for forbidden in ["searchQuery", "searchResults", "runSearch", "searchSessions", "sessionListSearch"] {
            XCTAssertFalse(page.contains(forbidden), "the project page does not connect `\(forbidden)`")
        }
        let agents = code(try appSource("Views/AgentsView.swift"))
        XCTAssertTrue(agents.contains(".sessionListSearch(text: $searchQuery,"))
        XCTAssertTrue(agents.contains("isEnabled: app.projectSessionsColumn == nil || rowNavigation != .selection"),
                      "only the project column removes the root search field")
        XCTAssertTrue(agents.contains("SessionFolderPage(address: address, rowNavigation: rowNavigation, searchQuery: $searchQuery)"))
        XCTAssertTrue(agents.contains("searchQuery: $searchQuery, rowNavigation: rowNavigation)"))
        let search = code(try appSource("Views/SessionListSearch.swift"))
        XCTAssertTrue(search.contains("isEnabled: Bool = true"), "existing search callers keep their field")
        XCTAssertTrue(search.contains("if !isEnabled {\n            self"))
        XCTAssertTrue(search.contains("searchable(text: text"))
    }

    func testTheRowsUseTheCompactAndRegularSessionLayouts() throws {
        let source = code(try appSource("Views/SessionProjectPage.swift"))
        let row = try slice(source, from: "struct SessionProjectRowView: View {", to: "\n}\n")
        XCTAssertTrue(row.contains("SessionListPresentation.resolve(isCompactWidth: horizontalSizeClass == .compact) == .regular"))
        XCTAssertTrue(row.contains("regularIOSRow"))
        XCTAssertTrue(row.contains("compactRow"))
        let compact = try slice(row, from: "private var compactRow: some View {", to: "\n    }")
        XCTAssertTrue(compact.contains("spacing: 3"))
        XCTAssertTrue(compact.contains(".padding(.vertical, 2)"), "the compact row uses the 75pt session layout")
        let regular = try slice(row, from: "private var regularIOSRow: some View {", to: "\n    }")
        XCTAssertTrue(regular.contains("spacing: 4"))
        XCTAssertTrue(regular.contains(".padding(.vertical, 5)"))
        XCTAssertTrue(row.contains("square.grid.2x2"))
        XCTAssertTrue(row.contains("Text(row.title)"))
        XCTAssertFalse(row.contains(".bold()") || row.contains(".semibold"), "项目条目标题与会话行同一字重（owner 10-04）")
        XCTAssertTrue(row.contains("row.line.text"))
        XCTAssertFalse(row.contains("SessionCoordinatorBadge"))
        XCTAssertFalse(row.contains("NeedsYouCountCapsule"), "attention is a dot, never a count")
        XCTAssertTrue(row.contains("SpinnerGlyph(color: .secondary)"))
        XCTAssertTrue(row.contains("BreathingGlyph(systemImage: \"terminal\")"))
        XCTAssertTrue(row.contains(".fill(.orange)"))
        XCTAssertTrue(row.contains("row.lastTurnAt"), "time follows the group's newest activity")
    }

    func testTheProgressLabelHasItsOwnFullHeightTapTarget() throws {
        let source = code(try appSource("Views/SessionProjectPage.swift"))
        let row = try slice(source, from: "struct SessionProjectRowView: View {", to: "\n}\n")
        XCTAssertTrue(row.contains("Button(action: onOpen)"))
        let progress = try slice(row, from: "private var progressTap: some View {", to: "\n    }")
        XCTAssertTrue(progress.contains("Button(action: onSessions)"))
        XCTAssertTrue(progress.contains("GeometryReader { proxy in"))
        XCTAssertTrue(progress.contains(".frame(height: proxy.size.height)"), "the progress tap follows the whole content row height")
        XCTAssertTrue(progress.contains(".contentShape(Rectangle())"))
        XCTAssertTrue(progress.contains(".padding(.vertical, 15)"))
        XCTAssertTrue(progress.contains(".offset(y: -15)"), "the tag's tap area reaches the first scan line")
        XCTAssertTrue(row.contains(".overlay(alignment: .leading) { progressTap }"), "the progress control is a sibling to the row button")
    }

    func testThePageHeaderShowsTheProjectNameCountAndTwoNavigationActions() throws {
        let source = code(try appSource("Views/SessionProjectPage.swift"))
        let page = try slice(source, from: "struct SessionProjectPage: View {", to: "\n}\n")
        let title = try slice(page, from: "private var title: some View {", to: "\n    }")
        XCTAssertTrue(title.contains("Text(titleText)"))
        XCTAssertTrue(title.contains("SessionProjectCopy.pageSubtitle(sessions: sessions.count)"))
        XCTAssertTrue(title.contains(".foregroundStyle(.secondary)"))
        XCTAssertTrue(page.contains("ToolbarItem(placement: .principal) { title }"))
        let back = try slice(page, from: "if rowNavigation == .selection {", to: "\n            }")
        XCTAssertTrue(back.contains("app.leaveProjectSessions(address.projectID)"))
        XCTAssertTrue(back.contains("chevron.backward"))
        let menu = try slice(page, from: "private var projectMenu: some View {", to: "\n    }")
        XCTAssertTrue(menu.contains("SessionProjectCopy.openProject"))
        XCTAssertTrue(menu.contains("SessionProjectCopy.openCoordinator"))
        let coordinatorLookup = try slice(page, from: "private var availableCoordinator: Session? {", to: "\n    }")
        XCTAssertTrue(coordinatorLookup.contains("coordinator ?? (app.sessions + (app.agents?.allSessions ?? [])).first"),
                      "Open Coordinator can use the cross-workspace Completed cache as well as the Open snapshot")
        XCTAssertFalse(menu.contains("New session"))
        XCTAssertFalse(page.contains("startComposingSession"))
    }

    func testTheProjectRowHasExactlyTheAllowedMenuAndSwipeActions() throws {
        let source = code(try appSource("Views/SessionProjectPage.swift"))
        let actions = try slice(source, from: "private struct SessionProjectRowActions: ViewModifier {", to: "\n}\n")
        let menu = try slice(actions, from: "private var menu: some View {", to: "\n    }")
        let order = try [
            XCTUnwrap(menu.range(of: "SessionProjectCopy.openSession")?.lowerBound),
            XCTUnwrap(menu.range(of: "SessionProjectCopy.sessions")?.lowerBound),
            XCTUnwrap(menu.range(of: "SessionProjectCopy.openProject")?.lowerBound),
            XCTUnwrap(menu.range(of: "Divider()")?.lowerBound),
            XCTUnwrap(menu.range(of: "actionButton(pinAction)")?.lowerBound),
            XCTUnwrap(menu.range(of: "SessionProjectCopy.move")?.lowerBound),
        ]
        XCTAssertEqual(order, order.sorted())
        XCTAssertEqual(menu.components(separatedBy: "Button(action:").count - 1, 4)
        XCTAssertFalse(menu.contains("SessionProjectCopy.openCoordinator"))
        XCTAssertTrue(menu.contains("Button(action: onOpen)"))
        XCTAssertTrue(menu.contains(".disabled(!canOpenSession)"))
        let canOpen = try slice(actions, from: "private var canOpenSession: Bool {", to: "\n    }")
        XCTAssertTrue(canOpen.contains("if case .session = row.target { return true }"))
        XCTAssertTrue(canOpen.contains("return false"), "a project-page fallback is not an openable session")
        for forbidden in ["Complete", "Share", "Delete", "Approve", "Answer", "Respond"] {
            XCTAssertFalse(actions.contains(forbidden), "project entries cannot offer `\(forbidden)`")
        }
        XCTAssertTrue(actions.contains("leading: leadingActions"))
        XCTAssertTrue(actions.contains("trailing: trailingActions"))
        XCTAssertTrue(actions.contains(".swipeActions(edge: .leading"))
        XCTAssertTrue(actions.contains(".swipeActions(edge: .trailing"))
        XCTAssertTrue(actions.contains("private var leadingActions: [RowSwipeAction] { row.coordinator == nil ? [] : [pinAction] }"))
        let trailing = try slice(actions, from: "private var trailingActions: [RowSwipeAction] {", to: "\n    }")
        XCTAssertTrue(trailing.contains("RowSwipeAction(title: \"Move\""))
        XCTAssertTrue(trailing.contains("perform: onMove"))
        let pin = try slice(actions, from: "private var pinAction: RowSwipeAction {", to: "\n    }")
        XCTAssertTrue(pin.contains("SessionProjectCopy.unpin : SessionProjectCopy.pin"))
        XCTAssertTrue(pin.contains("app.setPinned(coordinator, pinned: !pinned)"))
    }

    func testThePageLoadsOpenAndCompletedAcrossAllWorkspacesAndDeduplicates() throws {
        let app = code(try appSource("AppModel.swift"))
        let load = try slice(app, from: "func loadProjectSessions(_ address: SessionProjectAddress) async {", to: "\n    }")
        XCTAssertTrue(load.contains("api.listSessions(view: .open, projectId: address.projectID)"))
        XCTAssertTrue(load.contains("api.listSessions(view: .completed, projectId: address.projectID)"))
        XCTAssertTrue(load.contains("let rows = try await open + completed"))
        XCTAssertTrue(load.contains("var seen = Set<String>()"))
        XCTAssertTrue(load.contains("seen.insert($0.id).inserted"))
        XCTAssertTrue(load.contains("$0.effectiveLifecycleState != .trash"))
        XCTAssertTrue(load.contains(".sorted { ($0.lastTurnAt ?? $0.createdAt ?? \"\") > ($1.lastTurnAt ?? $1.createdAt ?? \"\") }"))
        XCTAssertFalse(load.contains("view: address.view"))
        XCTAssertFalse(load.contains("view: .trash"))
        XCTAssertFalse(load.contains("agentID:"))
        XCTAssertFalse(load.contains("agentId:"))
        XCTAssertFalse(load.contains("runnerId:"))
        XCTAssertTrue(load.contains("projectSessionsAddress == address, !Task.isCancelled"), "an old request cannot replace another project's rows")
        XCTAssertTrue(load.contains("$0.projectMembership?.projectId == address.projectID"))
        XCTAssertTrue(load.contains("sessionDetails.store(row)"))
        let open = try slice(app, from: "func openProjectMember(_ session: Session, push: Bool) {", to: "\n    }")
        XCTAssertTrue(open.contains("sessionDetails.store(session)"))
        XCTAssertTrue(open.contains("selectedAgentID = agentID"), "opening a cross-workspace member follows its workspace")
        XCTAssertTrue(open.contains("self.push(node)"))
        XCTAssertTrue(open.contains("nav.selectConsole(node)"))
    }

    func testThePageDrawsProgressCoordinatorThenOrdinaryMemberRows() throws {
        let source = code(try appSource("Views/SessionProjectPage.swift"))
        let page = try slice(source, from: "struct SessionProjectPage: View {", to: "\n}\n")
        let order = try [
            XCTUnwrap(page.range(of: "            progressCard")?.lowerBound),
            XCTUnwrap(page.range(of: "Section(SessionProjectCopy.coordinatorSection)")?.lowerBound),
            XCTUnwrap(page.range(of: "ForEach(timeSections)")?.lowerBound),
        ]
        XCTAssertEqual(order, order.sorted())
        XCTAssertTrue(page.contains("$0.projectMembership?.role != .coordinator"))
        let sections = try slice(page, from: "private var timeSections: [SessionTimeSection] {", to: "\n    }")
        XCTAssertTrue(sections.contains("SessionTimeGrouping.sections(sessions.filter"))
        XCTAssertTrue(sections.contains("pinnedFirst: false"))
        XCTAssertTrue(page.contains(".task(id: address)"))
        XCTAssertTrue(page.contains("await app.loadProjectSessions(address)"))
        let progress = try slice(page, from: "private var progressCard: some View {", to: "\n    }")
        XCTAssertTrue(progress.contains("project?.taskCounts"))
        XCTAssertTrue(progress.contains("SessionProjectProgressBar(counts: counts"))
        XCTAssertTrue(progress.contains("SessionProjectCopy.pageProgress(done: counts.done, total: counts.total,"))
        XCTAssertEqual(progress.components(separatedBy: "running: runningCount").count - 1, 2)
        XCTAssertFalse(progress.contains("buckets.running"))
        let running = try slice(page, from: "private var runningCount: Int {", to: "\n    }")
        XCTAssertTrue(running.contains("sessions.filter { session in"))
        XCTAssertTrue(running.contains("if case .spinner = SessionStatusGlyph.make(for: session, watching: app.watches?.summary(for: session.id)).shape"))
        XCTAssertTrue(running.contains("}.count"))
        XCTAssertTrue(progress.contains("app.openProject(address.projectID)"))
        XCTAssertTrue(progress.contains("chevron.right"))

        let row = try slice(page, from: "@ViewBuilder private func sessionRow(_ session: Session)", to: "\n    }")
        for part in ["AgentSessionRow(session: session", "app.openProjectMember(session, push: true)",
                     "let scope: SessionView = session.effectiveLifecycleState == .completed ? .completed : .open",
                     "showsPin: scope == .open", ".sessionRowActions(session, scope: scope", "onTag: { taggingSession = session }",
                     "onShare: { sharingSession = session }", "onMove: { movingSession = session }", ".tag(session.id)"] {
            XCTAssertTrue(row.contains(part), "member rows preserve `\(part)`")
        }
        XCTAssertFalse(row.contains("address.view"), "member actions and appearance use the session's lifecycle")
        let sessionActions = code(try appSource("Views/SessionRowActions.swift"))
        let move = try slice(sessionActions, from: "private var moveAction: RowSwipeAction? {", to: "\n    }")
        XCTAssertTrue(move.contains("membership.role != .coordinator { return nil }"), "a non-coordinator member cannot move its project")
    }

    func testTheProjectUILayerIsCompiledForIOSOnly() throws {
        let page = try appSource("Views/SessionProjectPage.swift")
        for part in ["struct SessionProjectRowView: View", "struct SessionProjectPage: View",
                     "func sessionProjectRowActions("] {
            XCTAssertEqual(try branches(of: part, in: page), ["os(iOS)"])
        }
        let app = code(try appSource("AppModel.swift"))
        for part in ["func openProjectSessions(_ address: SessionProjectAddress)",
                     "func leaveProjectSessions(_ projectID: String? = nil)",
                     "func loadProjectSessions(_ address: SessionProjectAddress)",
                     "var projectSessionsColumn: SessionProjectAddress?"] {
            XCTAssertEqual(try branches(of: part, in: app), ["os(iOS)"])
        }
        let agents = code(try appSource("Views/AgentsView.swift"))
        let mac = try slice(agents, from: "ForEach(agents.agentSessions) { s in", to: "\n            }")
        XCTAssertFalse(mac.contains("SessionProject"))
        XCTAssertFalse(mac.contains("projectRow("))
    }
}

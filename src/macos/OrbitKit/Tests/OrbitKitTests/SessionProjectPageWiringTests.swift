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
        let listing = try slice(agents, from: "private static func projectListing(_ inputs: SessionListInputs, _ lines: SessionLineCache) -> SessionProjectListing {", to: "\n    }")
        for part in ["SessionProjectGrouping.listing(shownSessions,",
                     "let shownSessions = inputs.shownSessions",
                     "projects: inputs.projects, view: inputs.view,",
                     "byTag: inputs.byTag, searching: inputs.searching,",
                     "runnerOffline: inputs.runnerOffline,",
                     "let coordinators = inputs.allSessions.filter(isCoordinator) + inputs.accountSessions.filter(isCoordinator)",
                     "line: { lines.line(for: $0, watching: inputs.watch(for: $0.id)) }",
                     "coordinators: coordinators,",
                     "contentSessions: inputs.view == .open ? inputs.accountSessions : inputs.allSessions"] {
            XCTAssertTrue(listing.contains(part), "the workspace grouping carries `\(part)`")
        }
        let inputs = try slice(agents, from: "private var listInputs: SessionListInputs {", to: "\n    }")
        for part in ["accountSessions: app.sessions, allSessions: agents.allSessions,",
                     "projects: app.projects?.sidebarProjects ?? [],",
                     "watches: app.watches?.summaries ?? [:],",
                     "searching: isSearching,"] {
            XCTAssertTrue(inputs.contains(part), "the workspace grouping's inputs carry `\(part)`")
        }
        let folders = try slice(agents, from: "private static func folderListing(_ projectListing: SessionProjectListing, _ inputs: SessionListInputs) -> SessionFolderListing {", to: "\n    }")
        XCTAssertTrue(folders.contains("SessionFolderGrouping.listing(inputs.shownSessions,"))
        XCTAssertTrue(folders.contains("folders: projectListing.folders"))
        XCTAssertTrue(folders.contains("projectListing.entries.map(\\.timeGroupingSession)"))
        XCTAssertTrue(agents.contains("let projectRows = Dictionary(uniqueKeysWithValues: projectListing.projects.map { ($0.id, $0) })"))
        XCTAssertTrue(agents.contains("listRow(session, projects: projectRows)"))
        let row = try slice(agents, from: "@ViewBuilder private func listRow(_ s: Session, projects: [String: SessionProjectRow])", to: "\n    }")
        XCTAssertTrue(row.contains("if let project = projects[s.id]"))
        XCTAssertTrue(row.contains("projectRow(project)"), "the recency projection is rendered as a project, never as a session")
        XCTAssertTrue(row.contains("sessionRow(s)"))
        XCTAssertEqual(try branches(of: "private static func projectListing(_ inputs: SessionListInputs, _ lines: SessionLineCache) -> SessionProjectListing {", in: agents), ["os(iOS)"])

        let page = code(try appSource("Views/SessionFolderPage.swift"))
        let folderListing = try slice(page, from: "private static func projectListing(_ inputs: SessionListInputs, _ lines: SessionLineCache) -> SessionProjectListing {", to: "\n    }")
        XCTAssertTrue(folderListing.contains("SessionProjectGrouping.listing(inputs.sessions,"))
        XCTAssertTrue(folderListing.contains("folderID: inputs.folderID"))
        XCTAssertTrue(folderListing.contains("searching: inputs.searching"))
        let pageInputs = try slice(page, from: "private var listInputs: SessionListInputs {", to: "\n    }")
        for part in ["sessions: app.agents?.agentSessions ?? [],", "folderID: address.folderID,",
                     "searching: isSearching,", "watches: app.watches?.summaries ?? [:],"] {
            XCTAssertTrue(pageInputs.contains(part), "the folder page's grouping inputs carry `\(part)`")
        }
        XCTAssertTrue(page.contains("return projectListing.entries.map(\\.timeGroupingSession)"))
        XCTAssertTrue(page.contains("let projectRows = Dictionary(uniqueKeysWithValues: projectListing.projects.map { ($0.id, $0) })"))
        XCTAssertTrue(page.contains("listRow(session, projects: projectRows)"))
        let folderRow = try slice(page, from: "@ViewBuilder private func listRow(_ s: Session, projects: [String: SessionProjectRow])", to: "\n    }")
        XCTAssertTrue(folderRow.contains("if let project = projects[s.id]"))
        XCTAssertTrue(folderRow.contains("projectRow(project)"))
        XCTAssertTrue(folderRow.contains("sessionRow(s)"))
    }

    /// Both lists regroup only when an input changed: the body reads the memo, and the grouping is
    /// static so it cannot read a fact the memo's key leaves out (`SessionListingMemo`).
    func testBothListsGroupThroughTheMemoFromTheirInputsAlone() throws {
        for relative in ["Views/AgentsView.swift", "Views/SessionFolderPage.swift"] {
            let source = code(try appSource(relative))
            XCTAssertTrue(source.contains("@State private var listingMemo = SessionListingMemo<SessionListGrouping>()"), relative)
            XCTAssertTrue(source.contains("let grouping = listingMemo.value(for: listInputs, compute: Self.grouping)"), relative)
            XCTAssertTrue(source.contains("let projectRows = grouping.projectRows"), relative)
            let grouping = try slice(source, from: "private static func grouping(_ inputs: SessionListInputs, _ lines: SessionLineCache) -> SessionListGrouping {",
                                     to: "\n    }")
            XCTAssertTrue(grouping.contains("Self.projectListing(inputs, lines)"), relative)
            XCTAssertFalse(source.contains("private var projectListing"), "\(relative) regroups outside the memo")
            for name in ["projectListing", "timeSections"] {
                let function = try slice(source, from: "private static func \(name)(", to: "\n    }")
                XCTAssertFalse(function.contains("app."), "\(relative)'s \(name) reads a model the memo does not key on")
            }
        }
    }

    func testTheRowOpensSessionsAndItsMenuUsesTheGroupingTarget() throws {
        for relative in ["Views/AgentsView.swift", "Views/SessionFolderPage.swift"] {
            let source = code(try appSource(relative))
            let row = try slice(source, from: "private func projectRow(_ row: SessionProjectRow)", to: "\n    }")
            XCTAssertTrue(row.contains("SessionProjectAddress(projectID: row.projectId"))
            XCTAssertTrue(row.contains("let onOpen = {"))
            XCTAssertTrue(row.contains("SessionProjectRowView(row: row, onOpen: { app.openProjectSessions("),
                          "a tap on the row opens the project's sessions page")
            XCTAssertTrue(row.contains("switch row.target"))
            XCTAssertTrue(row.contains("case .session(let id):"))
            XCTAssertTrue(row.contains("$0.id == id"))
            XCTAssertTrue(row.contains("app.openProjectMember(session, push: rowNavigation == .push)"))
            XCTAssertTrue(row.contains("case .project: app.openProjectSessions("))
            XCTAssertTrue(row.contains("onSessions: { app.openProjectSessions("))
            XCTAssertTrue(row.contains(".sessionProjectRowActions(row, onOpen: onOpen,"),
                          "the Open Session menu keeps the grouping target")
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
        XCTAssertTrue(frames.contains("case .sessionProject(let address, asDestination: false):"))
        XCTAssertTrue(frames.contains("case .sessionProject(let address, asDestination: true):"))
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
        XCTAssertFalse(row.contains("square.grid.2x2"))
        XCTAssertTrue(row.contains("Text(row.title)"))
        let firstLine = try slice(row, from: "private var firstLine: some View {", to: "\n    }")
        XCTAssertTrue(firstLine.contains(".lineLimit(1)"))
        XCTAssertTrue(firstLine.contains(".fixedSize()"))
        XCTAssertFalse(firstLine.contains(".fixedSize(horizontal: regular, vertical: false)"))
        XCTAssertFalse(row.contains(".bold()") || row.contains(".semibold"), "项目条目标题与会话行同一字重（owner 10-04）")
        XCTAssertTrue(row.contains("row.line.text"))
        XCTAssertFalse(row.contains("SessionCoordinatorBadge"))
        XCTAssertFalse(row.contains("NeedsYouCountCapsule"), "attention is a dot, never a count")
        XCTAssertTrue(row.contains("SpinnerGlyph(color: .secondary)"))
        XCTAssertTrue(row.contains("BreathingGlyph(systemImage: \"terminal\")"))
        XCTAssertTrue(row.contains(".fill(.orange)"))
        XCTAssertTrue(row.contains("row.lastTurnAt"), "time follows the group's newest activity")
    }

    func testTheWholeRowIsOneButtonWithTheProgressChipInline() throws {
        let source = code(try appSource("Views/SessionProjectPage.swift"))
        let row = try slice(source, from: "struct SessionProjectRowView: View {", to: "\n}\n")
        XCTAssertTrue(row.contains("Button(action: onOpen)"))
        XCTAssertFalse(row.contains("onSessions"), "the row has one tap target")
        XCTAssertFalse(row.contains("progressTap"))
        XCTAssertFalse(row.contains("progressChip.hidden()"))
    }

    func testThePageHeaderShowsTheProjectNameCountAndOneProjectAction() throws {
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
        let open = try slice(page, from: "private var openProjectButton: some View {", to: "\n    }")
        XCTAssertTrue(open.contains("Button { openProject() }"))
        XCTAssertTrue(open.contains("SessionProjectCopy.openProject"))
        XCTAssertTrue(page.contains("ToolbarItem(placement: .topBarTrailing) { openProjectButton }"))
        XCTAssertFalse(page.contains("SessionProjectCopy.openCoordinator"),
                       "the page has one way into the project (owner 10-06); the coordinator is the section above")
        XCTAssertFalse(page.contains("availableCoordinator"))
        XCTAssertFalse(open.contains("New session"))
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

    func testTheProjectSessionsLoadAvoidsAsyncLets() throws {
        let app = code(try appSource("AppModel.swift"))
        let load = try slice(app, from: "func loadProjectSessions(_ address: SessionProjectAddress) async {", to: "\n    }")
        XCTAssertFalse(load.contains("async let"), "project session reads must avoid async-let teardown")
        XCTAssertTrue(load.contains("let openRead = Task { try await api.listSessions(view: .open,"))
        XCTAssertTrue(load.contains("let completedRead = Task { try await api.listSessions(view: .completed,"))
        XCTAssertTrue(load.contains("defer {\n                openRead.cancel()\n                completedRead.cancel()\n            }"))
        XCTAssertTrue(load.contains("let rows = try await openRead.value + completedRead.value"))
    }

    func testThePageLoadsOpenAndCompletedAcrossAllWorkspacesAndDeduplicates() throws {
        let app = code(try appSource("AppModel.swift"))
        let load = try slice(app, from: "func loadProjectSessions(_ address: SessionProjectAddress) async {", to: "\n    }")
        XCTAssertTrue(load.contains("api.listSessions(view: .open, projectId: address.projectID)"))
        XCTAssertTrue(load.contains("api.listSessions(view: .completed, projectId: address.projectID)"))
        XCTAssertTrue(load.contains("let rows = try await openRead.value + completedRead.value"))
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
        let pushed = try slice(open, from: "if push {", to: "} else {")
        XCTAssertTrue(pushed.contains("self.push(node)"))
        XCTAssertFalse(pushed.contains("selectedAgentID"),
                       "a phone leaves the Workspace beneath alone, so back lands on the one the project's page "
                       + "was entered from (owner, 2026-10-06)")
        let selected = try slice(open, from: "} else {", to: "nav.selectConsole(node)")
        XCTAssertTrue(selected.contains("selectedAgentID = agentID"),
                      "a wide shell's column follows a cross-workspace member into its workspace")
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
        let sections = try slice(page, from: "private var timeSections: [ProjectTimelineSection] {", to: "\n    }")
        XCTAssertTrue(sections.contains("ProjectTimeline.sections(sessions: sessions.filter"),
                      "the page's recency sections are the session grouping's, merges drawn among them")
        XCTAssertTrue(sections.contains("merges: merge?.receipts ?? []"))
        XCTAssertTrue(page.contains(".task(id: address)"))
        XCTAssertTrue(page.contains("await app.loadProjectSessions(address)"))
        let progress = try slice(page, from: "private var progressLine: some View {", to: "\n    }")
        XCTAssertTrue(progress.contains("project?.taskCounts"))
        XCTAssertTrue(progress.contains("SessionProjectProgressBar(counts: counts"))
        XCTAssertTrue(progress.contains("SessionProjectCopy.pageProgress(done: counts.done, total: counts.total,"))
        XCTAssertEqual(progress.components(separatedBy: "running: runningCount").count - 1, 2)
        XCTAssertFalse(progress.contains("buckets.running"))
        let running = try slice(page, from: "private var runningCount: Int {", to: "\n    }")
        XCTAssertTrue(running.contains("sessions.filter { session in"))
        XCTAssertTrue(running.contains("if case .spinner = SessionStatusGlyph.make(for: session, watching: app.watches?.summary(for: session.id)).shape"))
        XCTAssertTrue(running.contains("}.count"))
        XCTAssertFalse(progress.contains("openProject()"),
                       "the progress line carries no link of its own (owner 10-06); the header button is the way in")
        XCTAssertFalse(progress.contains("chevron.right"))
        let open = try slice(page, from: "private func openProject() {", to: "\n    }")
        XCTAssertTrue(open.contains("app.openProjectFromConversation(address.projectID, overConsole: rowNavigation == .push)"),
                      "a phone pushes the project's page over the sessions page, so back returns to it")

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

    func testTheSummaryCardCarriesTheProjectPagesLandingLine() throws {
        let source = code(try appSource("Views/SessionProjectPage.swift"))
        let page = try slice(source, from: "struct SessionProjectPage: View {", to: "\n}\n")
        let card = try slice(page, from: "private var progressCard: some View {", to: "\n    }")
        let order = try [XCTUnwrap(card.range(of: "progressLine")?.lowerBound),
                         XCTUnwrap(card.range(of: "landingLine")?.lowerBound)]
        XCTAssertEqual(order, order.sorted())
        let landing = try slice(page, from: "@ViewBuilder private var landingLine: some View {", to: "\n    }")
        XCTAssertTrue(landing.contains("integration.inFlight != nil"), "no landing in flight leaves the card as it was")
        XCTAssertTrue(landing.contains("TimelineView(.periodic(from: .now, by: 1))"))
        XCTAssertTrue(landing.contains("ProjectMergeCard.progressLandingLine(integration, now: context.date,"),
                      "a merge job's live line is the merge card's, not the progress card's")
        XCTAssertTrue(landing.contains("!ProjectMergeCard.isMergeJob(integration.inFlight)"))
        XCTAssertTrue(landing.contains("updatedAt: app.projectSessionsIntegrationReadAt"))
        XCTAssertTrue(landing.contains("refreshFailed: app.projectSessionsIntegrationReadFailed"))
        XCTAssertTrue(landing.contains("ProjectLandingRow(line: line)"), "the same row the project page draws")
        XCTAssertTrue(landing.contains("app.openProject(address.projectID)"))

        let app = code(try appSource("AppModel.swift"))
        let load = try slice(app, from: "func loadProjectSessions(_ address: SessionProjectAddress) async {", to: "\n    }")
        XCTAssertTrue(load.contains("let integrationRead = Task { try await api.projectIntegration(address.projectID) }"))
        XCTAssertTrue(load.contains("projectSessionsIntegration = nil"), "another project's landing never shows here")
        let store = try XCTUnwrap(load.range(of: "projectSessionsIntegration = integration"))
        let guardRange = try XCTUnwrap(load.range(of: "guard projectSessionsAddress == address, !Task.isCancelled else { return }\n        if let integration"))
        XCTAssertLessThan(guardRange.lowerBound, store.lowerBound)
        XCTAssertTrue(load.contains("projectSessionsIntegrationReadFailed = true"))
    }

    /// The merge into main lives on this page (owner decision 2026-10-06): its card under the
    /// progress card, its records on the timeline, and both sheets hosted by the page itself.
    func testThePageCarriesTheMergeIntoMainUnderTheProgressCardAndOnItsTimeline() throws {
        let source = code(try appSource("Views/SessionProjectPage.swift"))
        let page = try slice(source, from: "struct SessionProjectPage: View {", to: "\n}\n")
        let order = try [
            XCTUnwrap(page.range(of: "            progressCard")?.lowerBound),
            XCTUnwrap(page.range(of: "            mergeCard")?.lowerBound),
            XCTUnwrap(page.range(of: "Section(SessionProjectCopy.coordinatorSection)")?.lowerBound),
        ]
        XCTAssertEqual(order, order.sorted(), "the merge card sits between the progress card and the coordinator")
        let merge = try slice(page, from: "private var merge: ProjectMergeModel? {", to: "\n    }")
        XCTAssertTrue(merge.contains("$0.projectID == address.projectID"),
                      "another project's merge must never show on this page")
        let card = try slice(page, from: "@ViewBuilder private var mergeCard: some View {", to: "\n    }\n")
        XCTAssertTrue(card.contains("ProjectMergeCard.shape(promotion: merge.current,"))
        XCTAssertTrue(card.contains("ProjectMergeCard.mergeLandingLine($0, now: context.date,"))
        XCTAssertTrue(card.contains("promotionReview = PromotionReviewTarget(id: $0)"))
        XCTAssertTrue(page.contains("case .merge(let receipt): mergeRow(receipt)"))
        XCTAssertTrue(page.contains("case .session(let session): sessionRow(session)"))
        XCTAssertTrue(page.contains("PromotionReviewSheet(source: merge, promotionID: target.id)"),
                      "the page opens the conversation's own review, reading the page's model")
        XCTAssertTrue(page.contains(".sheet(item: $promotionReceipt) { PromotionReceiptSheet(promotion: $0.promotion) }"))
        let task = try slice(page, from: ".task(id: address) {", to: "\n        }")
        XCTAssertEqual(task.components(separatedBy: "await app.loadProjectMerge(address)").count - 1, 2,
                       "the merge is read on arrival and on every poll")

        let app = code(try appSource("AppModel.swift"))
        let load = try slice(app, from: "func loadProjectMerge(_ address: SessionProjectAddress, force: Bool = false) async {",
                             to: "\n    }")
        XCTAssertTrue(load.contains("projectSessionsMerge?.projectID != address.projectID"))
        XCTAssertTrue(load.contains("ProjectMergeModel(projectID: address.projectID, api: api)"))
        XCTAssertFalse(load.contains("async let"))
        let model = try appSource("ProjectMergeModel.swift")
        XCTAssertFalse(code(model).contains("async let"), "the model's reads follow loadProjectSessions' rule")
        XCTAssertEqual(try branches(of: "final class ProjectMergeModel: PromotionReviewSource", in: model), ["os(iOS)"])

        // The banner's press on a merge waiting for the owner opens this page, not the conversation.
        let banner = try slice(app, from: "func openNeedsYouItem(_ s: Session, _ item: SessionOwnerItem, projectInColumn: Bool = false) {",
                               to: "\n    }")
        XCTAssertTrue(banner.contains("if item.kind == .promotionApproval, let projectID = s.projectMembership?.projectId {"))
        XCTAssertTrue(banner.contains("return openProjectSessions(projectID, inColumn: projectInColumn)"))
    }

    /// A read that failed with no rows in hand says why in one sentence, with Retry, and stays up
    /// through the page's 4-second polls rather than blinking out while each one is in flight.
    func testAFailedReadStaysUpWithItsReasonAndRetry() throws {
        let source = code(try appSource("Views/SessionProjectPage.swift"))
        let page = try slice(source, from: "struct SessionProjectPage: View {", to: "\n}\n")
        let overlay = try slice(page, from: ".overlay {", to: "\n        }")
        let failed = try slice(overlay, from: "if sessions.isEmpty, let failure = app.projectSessionsError {",
                               to: "} else if")
        XCTAssertFalse(failed.contains("projectSessionsLoading"))
        XCTAssertTrue(failed.contains("Text(CodexSignIn.sentence(failure))"))
        XCTAssertTrue(failed.contains("Button(\"Retry\") { Task { await app.loadProjectSessions(address) } }"))
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

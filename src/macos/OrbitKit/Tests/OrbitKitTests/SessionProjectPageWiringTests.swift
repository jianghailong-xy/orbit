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
                     // The line the project row is composed from reads the account's recaps switch
                     // (the grouping's inputs carry it, so a toggle regroups).
                     "line: { lines.line(for: $0, watching: inputs.watch(for: $0.id),",
                     "recaps: inputs.recaps) }",
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
        XCTAssertTrue(title.contains("loading && sessions.isEmpty"),
                      "no member count while no member is known")
        XCTAssertTrue(page.contains("private var loading: Bool { app.projectSessionsLoading || app.projectSessionsAddress != address }"),
                      "nothing is known for the page before its own load has begun")
        XCTAssertTrue(title.contains("SessionProjectCopy.pageSubtitleLoading"))
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
        XCTAssertTrue(load.contains("let kept = SessionFilter.removing(trashingSessions, from: rows)\n"
                                    + "            projectSessions = SessionProjectMembers.members(of: address.projectID, in: kept)"),
                      "one rule — this project's, never Trash, each once, newest first (SessionProjectMembersTests) — "
                        + "over the read less the rows on their way to Trash")
        XCTAssertFalse(load.contains("view: address.view"))
        XCTAssertFalse(load.contains("view: .trash"))
        XCTAssertFalse(load.contains("agentID:"))
        XCTAssertFalse(load.contains("agentId:"))
        XCTAssertFalse(load.contains("runnerId:"))
        XCTAssertTrue(load.contains("projectSessionsAddress == address, !Task.isCancelled"), "an old request cannot replace another project's rows")
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
            XCTUnwrap(page.range(of: "            firstCard")?.lowerBound),
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
        // A press opens the jobs the row counts, on a server that lists them; on an older one, the
        // project page, as it always did.
        let press = try slice(landing, from: "Button {", to: "} label: {")
        let steps = try ["if integration.inFlightJobs != nil {", "showsLandingJobs = true", "} else {",
                         "app.openProject(address.projectID)"].map {
            try XCTUnwrap(press.range(of: $0)?.lowerBound, "the press keeps `\($0)`")
        }
        XCTAssertEqual(steps, steps.sorted())

        let app = code(try appSource("AppModel.swift"))
        let load = try slice(app, from: "func loadProjectSessions(_ address: SessionProjectAddress) async {", to: "\n    }")
        XCTAssertTrue(load.contains("projectSessionsIntegration = nil"), "another project's landing never shows here")
        XCTAssertFalse(load.contains("projectIntegration("), "the landing read does not wait behind the member lists")
        let integration = try slice(app, from: "func loadProjectIntegration(_ address: SessionProjectAddress) async {",
                                    to: "\n    }")
        XCTAssertTrue(integration.contains("let integration = try? await api.projectIntegration(address.projectID)"))
        let store = try XCTUnwrap(integration.range(of: "projectSessionsIntegration = integration"))
        let guardRange = try XCTUnwrap(integration.range(of: "guard projectSessionsAddress == address, !Task.isCancelled else { return }\n        if let integration"))
        XCTAssertLessThan(guardRange.lowerBound, store.lowerBound)
        XCTAssertTrue(integration.contains("projectSessionsIntegrationReadFailed = true"))
        let task = try slice(page, from: ".task(id: address) {", to: "\n        }")
        XCTAssertEqual(task.components(separatedBy: "await app.loadProjectIntegration(address)").count - 1, 2,
                       "the landing is read on arrival and on every poll")
    }

    /// The jobs a landing row counts open over this page (docs/mocks/landing-jobs-sheet), from the
    /// progress card's row and from the merge card's alike, on a server that lists them. The sheet
    /// is the page's, not either row's — their TimelineViews redraw every second — and it reads the
    /// page's own landing read; a Retry that went through reads it again at once, outside the polls.
    func testTheLandingRowsOpenTheJobsInFlightOverThePage() throws {
        let source = code(try appSource("Views/SessionProjectPage.swift"))
        let page = try slice(source, from: "struct SessionProjectPage: View {", to: "\n}\n")
        XCTAssertTrue(page.contains("@State private var showsLandingJobs = false"))
        let landing = try slice(page, from: "@ViewBuilder private var landingLine: some View {", to: "\n    }")
        XCTAssertFalse(landing.contains(".sheet("), "the row redraws every second; the sheet is the page's")
        let card = try slice(page, from: "@ViewBuilder private var mergeCard: some View {", to: "\n    }\n")
        XCTAssertTrue(card.contains("onLanding: app.projectSessionsIntegration?.inFlightJobs == nil"))
        XCTAssertTrue(card.contains("? nil : { showsLandingJobs = true },"), "the merge job's row opens the same jobs")
        XCTAssertFalse(card.contains(".sheet("))

        let sheet = try slice(page, from: ".sheet(isPresented: $showsLandingJobs) {", to: "\n        }\n")
        for part in ["ProjectLandingJobsSheet(",
                     "ProjectPage.landingJobLines($0, now: now, updatedAt: app.projectSessionsIntegrationReadAt,",
                     "refreshFailed: app.projectSessionsIntegrationReadFailed)",
                     "try await app.retryIntegrationJob(address.projectID, jobID: jobID)",
                     "await app.loadProjectIntegration(address)",
                     "app.openFromConversation(.task(taskID), overConsole: rowNavigation == .push)"] {
            XCTAssertTrue(sheet.contains(part), "the jobs sheet keeps `\(part)`")
        }
        let retry = try XCTUnwrap(sheet.range(of: "try await app.retryIntegrationJob("))
        let reload = try XCTUnwrap(sheet.range(of: "await app.loadProjectIntegration(address)"))
        XCTAssertLessThan(retry.lowerBound, reload.lowerBound, "the line is read again once the Retry went through")
        let close = try XCTUnwrap(sheet.range(of: "showsLandingJobs = false"))
        let open = try XCTUnwrap(sheet.range(of: "app.openFromConversation(.task(taskID)"))
        XCTAssertLessThan(close.lowerBound, open.lowerBound, "the sheet goes down before the task opens")
        let hosted = try XCTUnwrap(page.range(of: ".sheet(isPresented: $showsLandingJobs) {"))
        let polls = try XCTUnwrap(page.range(of: ".task(id: address) {"))
        XCTAssertLessThan(hosted.lowerBound, polls.lowerBound, "hosted on the list, beside the page's other sheets")

        let app = code(try appSource("AppModel.swift"))
        let write = try slice(app, from: "func retryIntegrationJob(_ projectID: String, jobID: String) async throws {",
                              to: "\n    }")
        XCTAssertTrue(write.contains("guard let api else { throw APIError.notConfigured }"))
        XCTAssertTrue(write.contains("_ = try await api.retryIntegrationJob(projectID, jobID: jobID)"))
        XCTAssertEqual(try branches(of: "func retryIntegrationJob(_ projectID: String, jobID: String)", in: app),
                       ["os(iOS)"])

        let merge = try slice(source, from: "private struct ProjectMergeCardView: View {", to: "\n}\n")
        XCTAssertTrue(merge.contains("let onLanding: (() -> Void)?"))
        let row = try slice(merge, from: "@ViewBuilder private func landingRow(_ line: ProjectPage.LandingLine) -> some View {",
                            to: "\n    }\n")
        for part in ["if let onLanding {", "Button(action: onLanding) {", "ProjectLandingRow(line: line)",
                     "Image(systemName: \"chevron.right\")", ".buttonStyle(.plain)"] {
            XCTAssertTrue(row.contains(part), "the merge card's landing row keeps `\(part)`")
        }
        XCTAssertEqual(merge.components(separatedBy: "if let landing { landingRow(landing) }").count - 1, 2,
                       "the checking and the merging card both draw the row a press opens the jobs from")
        XCTAssertFalse(merge.contains("if let landing { ProjectLandingRow(line: landing) }"))
    }

    /// The merge into main lives on this page (owner decision 2026-10-06): its card under the
    /// progress card, its records on the timeline, and both sheets hosted by the page itself.
    func testThePageCarriesTheMergeIntoMainUnderTheProgressCardAndOnItsTimeline() throws {
        let source = code(try appSource("Views/SessionProjectPage.swift"))
        let page = try slice(source, from: "struct SessionProjectPage: View {", to: "\n}\n")
        let order = try [
            XCTUnwrap(page.range(of: "            firstCard")?.lowerBound),
            XCTUnwrap(page.range(of: "            mergeCard")?.lowerBound),
            XCTUnwrap(page.range(of: "Section(SessionProjectCopy.coordinatorSection)")?.lowerBound),
        ]
        XCTAssertEqual(order, order.sorted(), "the merge card sits between the first card and the coordinator")
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

    /// The merge card has one moving mark, and it is the landing row's ring — the project page's
    /// Integrating mark, beside the word `fetching`. The merging head wears the same tile and merge
    /// mark as the asking card rather than a spinner (owner decision 2026-10-07): a spinner there
    /// said "work is happening" a fourth time, in a mark neither this card nor this app uses.
    func testTheMergingCardsHeadCarriesTheMergeMarkRatherThanASpinner() throws {
        let page = code(try appSource("Views/SessionProjectPage.swift"))
        let merging = try slice(page, from: "@ViewBuilder private func merging(_ view: ProjectPromotionView) -> some View {",
                                to: "\n    }\n")
        XCTAssertTrue(merging.contains("header(PromotionCards.pageTitle(view), symbol: \"arrow.triangle.merge\")"))
        XCTAssertFalse(merging.contains("ProgressView"), "the landing row below is this card's moving mark")
    }

    /// A blocked candidate's card names what is in front of it — the landing holding the branch,
    /// off the project's own read — instead of leaving "Coordinator is resolving it" as the whole
    /// answer (the owner's report of 2026-10-08).
    func testTheBlockedCardNamesTheLandingInFrontOfIt() throws {
        let page = code(try appSource("Views/SessionProjectPage.swift"))
        let card = try slice(page, from: "private var mergeCard: some View {", to: "\n    }")
        XCTAssertTrue(card.contains("PromotionCards.blockedByLine(view, landings: $0.landTasks)"),
                      "the blocked card names who is in front of it, from the project's landings")
        let blocked = try slice(page, from: "@ViewBuilder private func blocked(_ view: ProjectPromotionView) -> some View {",
                                to: "\n    }\n")
        XCTAssertTrue(blocked.contains("PromotionCards.blockedByLabel"),
                      "and it draws only when there is something to name")
    }

    /// A blocked candidate nobody holds draws no "Coordinator is resolving it": the press is read off
    /// the project's items as a holder — unread, the item, or nobody — and drawn only when there is
    /// somebody to name (2026-10-09, a card that said the coordinator was resolving work already on
    /// main). The card opens its whole review from Details, as the web strip's blocked card does.
    func testTheBlockedCardNamesNobodyWhenNobodyHoldsIt() throws {
        let page = code(try appSource("Views/SessionProjectPage.swift"))
        let blocked = try slice(page, from: "@ViewBuilder private func blocked(_ view: ProjectPromotionView) -> some View {",
                                to: "\n    }\n")
        XCTAssertTrue(blocked.contains("PromotionCards.holder(of: view.promotionId, in: merge.openItems)"))
        XCTAssertTrue(blocked.contains("if let resolving = PromotionCards.resolvingLine(holder, now: now) {"),
                      "the press is drawn only when somebody holds the candidate")
        XCTAssertTrue(blocked.contains("onDetails(view.promotionId)"), "and the whole card is a press away")

        let cards = code(try appSource("Views/ApprovalCards.swift"))
        let sheet = try slice(cards, from: "struct PromotionReviewSheet: View {", to: "\n}\n")
        XCTAssertTrue(sheet.contains("PromotionCards.holder(of: promotionID, in: source.promotionOpenItems)"))
        XCTAssertTrue(sheet.contains("if let resolving = PromotionCards.resolvingLine(holder) {"),
                      "the review's press says nobody's name either")
    }

    /// A read that failed with no rows in hand says why in one sentence, with Retry, and stays up
    /// through the page's 4-second polls rather than blinking out while each one is in flight.
    func testAFailedReadStaysUpWithItsReasonAndRetry() throws {
        let source = code(try appSource("Views/SessionProjectPage.swift"))
        let page = try slice(source, from: "struct SessionProjectPage: View {", to: "\n}\n")
        let overlay = try slice(page, from: ".overlay {", to: "\n        }")
        let failed = try slice(overlay, from: "if sessions.isEmpty, app.projectSessionsAddress == address, let failure = app.projectSessionsError {",
                               to: "} else if")
        XCTAssertFalse(failed.contains("projectSessionsLoading"))
        XCTAssertTrue(failed.contains("Text(CodexSignIn.sentence(failure))"))
        XCTAssertTrue(failed.contains("Button(\"Retry\") { Task { await app.loadProjectSessions(address) } }"))
    }

    /// The page never opens on nothing while the app holds the project's members: a new address
    /// opens on the Open list's members, a workspace list's rows and the Completed members its page
    /// last read (`SessionProjectMembersTests`), before any read answers, and the read replaces them.
    /// What the model holds for another address is never drawn, and nothing is counted before the
    /// page's own load has begun.
    func testThePageOpensOnWhatTheAppAlreadyHoldsRatherThanOnNone() throws {
        let app = code(try appSource("AppModel.swift"))
        let load = try slice(app, from: "func loadProjectSessions(_ address: SessionProjectAddress) async {", to: "\n    }")
        let entering = try slice(load, from: "if projectSessionsAddress != address {", to: "\n        }")
        XCTAssertTrue(entering.contains("projectSessions = SessionProjectMembers.members("))
        XCTAssertTrue(entering.contains("in: sessions + (agents?.allSessions ?? []) + (projectCompletedSessions[key] ?? []))"))
        XCTAssertFalse(load.contains("projectSessions = []"), "an address change no longer starts the page at 0")
        let opened = try XCTUnwrap(load.range(of: "projectSessions = SessionProjectMembers.members("))
        let read = try XCTUnwrap(load.range(of: "let rows = try await openRead.value + completedRead.value"))
        XCTAssertLessThan(opened.lowerBound, read.lowerBound, "the members are in hand before any read answers")
        XCTAssertTrue(load.contains("projectCompletedSessions[key] = projectSessions.filter { $0.effectiveLifecycleState != .open }"),
                      "coming back to the project opens on its Completed members too")

        let source = code(try appSource("Views/SessionProjectPage.swift"))
        let page = try slice(source, from: "struct SessionProjectPage: View {", to: "\n}\n")
        XCTAssertTrue(page.contains("private var sessions: [Session] { app.projectSessionsAddress == address ? app.projectSessions : [] }"),
                      "another address's rows are never drawn as this page's")
        let title = try slice(page, from: "private var title: some View {", to: "\n    }")
        XCTAssertFalse(title.contains("app.projectSessionsLoading"),
                       "the first frame, before the page's load has begun, counts nothing")
    }

    /// The page's reads run side by side, each on its own 4-second poll, so nothing waits behind the
    /// member lists; and a poll of the members asks for neither list again unless something moved —
    /// the Open members are the app's Open list's, the Completed list is read again only for a member
    /// that left Open or after `SessionProjectMembers.completedRefresh`.
    func testThePagesReadsRunSideBySideAndAPollAsksForNoListThatDidNotMove() throws {
        let source = code(try appSource("Views/SessionProjectPage.swift"))
        let page = try slice(source, from: "struct SessionProjectPage: View {", to: "\n}\n")
        let task = try slice(page, from: ".task(id: address) {", to: "\n        }")
        XCTAssertTrue(task.contains("await withTaskGroup(of: Void.self) { group in"))
        XCTAssertFalse(task.contains("async let"), "project reads avoid async-let teardown")
        XCTAssertEqual(task.components(separatedBy: "group.addTask { @MainActor in").count - 1, 4)
        for reads in ["await app.loadProjectSessions(address)\n                    await Self.poll { await app.pollProjectSessions(address) }",
                      "await app.loadProjectIntegration(address)\n                    await Self.poll { await app.loadProjectIntegration(address) }",
                      "await app.loadProjectMerge(address)\n                    await Self.poll { await app.loadProjectMerge(address) }",
                      "await app.projects?.load()\n                    await app.loadProjectStart(address)\n                    await app.loadProjectDone(address)\n                    await Self.poll {\n                        await app.loadProjectStart(address)\n                        await app.loadProjectDone(address)\n                    }"] {
            XCTAssertTrue(task.contains(reads), "a read of its own: `\(reads)`")
        }
        let poll = try slice(page, from: "private static func poll(_ read: () async -> Void) async {", to: "\n    }")
        XCTAssertTrue(poll.contains("try? await Task.sleep(for: .seconds(4))"))
        XCTAssertTrue(poll.contains("if Task.isCancelled { break }"))
        let refresh = try slice(page, from: ".refreshable {", to: "\n        }")
        for part in ["await withTaskGroup(of: Void.self) { group in",
                     "group.addTask { @MainActor in await app.loadProjectSessions(address) }",
                     "group.addTask { @MainActor in await app.loadProjectIntegration(address) }",
                     "group.addTask { @MainActor in await app.loadProjectMerge(address, force: true) }",
                     "group.addTask { @MainActor in await app.loadProjectStart(address) }",
                     "group.addTask { @MainActor in await app.loadProjectDone(address) }"] {
            XCTAssertTrue(refresh.contains(part), "pull to refresh keeps `\(part)`")
        }

        let app = code(try appSource("AppModel.swift"))
        let members = try slice(app, from: "func pollProjectSessions(_ address: SessionProjectAddress) async {", to: "\n    }")
        XCTAssertTrue(members.contains("guard projectSessionsError == nil, let readAt = projectSessionsReadAt, openListAnswered else {\n"
                                       + "            return await loadProjectSessions(address)\n        }"),
                      "until a read has answered, or before the server answered the app's Open list, a poll is the read")
        XCTAssertTrue(members.contains("SessionProjectMembers.poll(shown: projectSessions, projectID: address.projectID,"))
        XCTAssertTrue(members.contains("openList: sessions"))
        XCTAssertTrue(members.contains("if poll.members != projectSessions { projectSessions = poll.members }"),
                      "a poll that changed nothing redraws nothing")
        XCTAssertFalse(members.contains("view: .open"), "the Open members are the app's Open list's")
        let due = try XCTUnwrap(members.range(of: "guard poll.moved || Date().timeIntervalSince(readAt) >= SessionProjectMembers.completedRefresh else { return }"))
        let completed = try XCTUnwrap(members.range(of: "try await api.listSessions(view: .completed, projectId: address.projectID)"))
        XCTAssertLessThan(due.lowerBound, completed.lowerBound, "the Completed list is asked for only when it may have moved")
        XCTAssertFalse(members.contains("async let"))

        let model = code(try appSource("ProjectMergeModel.swift"))
        let merge = try slice(model, from: "func load(force: Bool = false) async {", to: "\n    }")
        let started = try ["let mergedRead: Task<[ProjectPromotionView], Error>? = mergedDue",
                           "let itemsRead: Task<ProjectOpenItemsView, Error>? = itemsDue",
                           "let criteriaRead: Task<ProjectCriteriaDocument, Error>? = criteriaDue"].map {
            try XCTUnwrap(merge.range(of: $0)?.lowerBound, "`\($0)`")
        }
        let firstWait = try XCTUnwrap(merge.range(of: "try? await mergedRead?.value")?.lowerBound)
        XCTAssertTrue(started.allSatisfy { $0 < firstWait }, "the merge card's follow-up reads go side by side")
    }

    /// A project nobody has started says so on its progress line and offers its start under it
    /// (docs/mocks/project-start-sessions-page): the project page's own rule, the start card over
    /// this page, and the open items read only while the sidebar says nobody has started it.
    func testAProjectNobodyStartedOffersItsStartUnderTheProgressLine() throws {
        let raw = try appSource("Views/SessionProjectPage.swift")
        let source = code(raw)
        let page = try slice(source, from: "struct SessionProjectPage: View {", to: "\n}\n")
        let card = try slice(page, from: "private var progressCard: some View {", to: "\n    }")
        let order = try ["progressLine", "startLine", "landingLine"].map {
            try XCTUnwrap(card.range(of: $0)?.lowerBound)
        }
        XCTAssertEqual(order, order.sorted(), "the start sits under the progress line, inside the card")
        let progress = try slice(page, from: "private var progressLine: some View {", to: "\n    }")
        XCTAssertTrue(progress.contains("notStarted ? SessionProjectCopy.pageNotStarted(tasks: counts.total)"))
        let notStarted = try slice(page, from: "private var notStarted: Bool {", to: "\n    }")
        XCTAssertTrue(notStarted.contains("project?.status == .open && project?.started == false"))
        let rule = try slice(page, from: "private var startRow: StartProject.PageRow? {", to: "\n    }")
        XCTAssertTrue(rule.contains("StartProject.pageRow(status: project.status, started: project.started,"),
                      "the project page's own rule decides the row")
        XCTAssertTrue(rule.contains("openItems: app.projectSessionsOpenItems)"))

        let row = try slice(page, from: "@ViewBuilder private var startLine: some View {",
                            to: "private func openStart(")
        let asked = try slice(row, from: "case .asked(let item):", to: "case .own:")
        for part in ["Circle().fill(Color.orange)", "Text(StartProject.readyToStart)",
                     "SessionProjectCopy.startAsked(ago)", "SessionProjectCopy.startSuggestion(settings)",
                     "SessionProjectCopy.startReview", ".buttonStyle(.borderedProminent)", "openStart(.asked)"] {
            XCTAssertTrue(asked.contains(part), "the coordinator's request keeps `\(part)`")
        }
        let own = try slice(row, from: "case .own:", to: ".buttonBorderShape(.capsule)")
        for part in ["SessionProjectCopy.startNotAsked", "Text(StartProject.rowOwn)",
                     ".buttonStyle(.bordered)", "openStart(.own)"] {
            XCTAssertTrue(own.contains(part), "the owner's own start keeps `\(part)`")
        }
        XCTAssertFalse(row.contains("needsYouBadge"), "a start request is counted nowhere, so it carries no badge")
        XCTAssertFalse(row.contains(".background("), "the row sits on the progress card's own grey")

        let sheet = try slice(page, from: ".sheet(item: $startSheet) { sheet in", to: ".task(id: address) {")
        XCTAssertTrue(sheet.contains("app.projects?.detail(address.projectID)"))
        XCTAssertTrue(sheet.contains("case .asked: RequestedStartProjectSheet(store: store"))
        XCTAssertTrue(sheet.contains("case .own: OwnerStartProjectSheet(store: store"))
        XCTAssertTrue(sheet.contains(".task { await store.load() }"), "the card's reads are refreshed as it opens")
        let task = try slice(page, from: ".task(id: address) {", to: "\n        }")
        XCTAssertEqual(task.components(separatedBy: "await app.loadProjectStart(address)").count - 1, 2,
                       "the start is read on arrival and on every poll")

        let requested = try slice(source, from: "private struct RequestedStartProjectSheet: View {", to: "\n}\n")
        XCTAssertTrue(requested.contains("StartProject.live(openItems: store.openItems, started: $0.started)"))
        XCTAssertTrue(requested.contains("askedAt: row.waitingSince,"))
        XCTAssertTrue(requested.contains("requestId: itemID"), "the press answers the request it was drawn for")
        XCTAssertFalse(requested.contains("onChatAbout"), "Chat about this stays the conversation's")
        XCTAssertEqual(try branches(of: "private struct RequestedStartProjectSheet: View", in: raw), ["os(iOS)"])

        let app = code(try appSource("AppModel.swift"))
        let load = try slice(app, from: "func loadProjectStart(_ address: SessionProjectAddress) async {",
                             to: "\n    }")
        XCTAssertTrue(load.contains("guard row?.status == .open, row?.started == false else {"),
                      "a started project's page reads nothing more than before")
        XCTAssertTrue(load.contains("api.projectOpenItems(projectID: address.projectID)"))
        XCTAssertTrue(load.contains("projectSessionsAddress == address, !Task.isCancelled"))
        XCTAssertFalse(load.contains("async let"))
        let sessions = try slice(app, from: "func loadProjectSessions(_ address: SessionProjectAddress) async {",
                                 to: "\n    }")
        XCTAssertTrue(sessions.contains("projectSessionsOpenItems = nil"), "another project's request never shows here")
    }

    /// The page's own ending (docs/mocks/project-done-sessions-page, owner decision 2026-10-10): a
    /// project that is done draws the settled card the conversation draws, in the progress card's
    /// place — from the project document read the page keeps for that state and nothing else.
    func testAProjectThatIsDoneDrawsItsEndingInTheProgressCardsPlace() throws {
        let raw = try appSource("Views/SessionProjectPage.swift")
        let source = code(raw)
        let page = try slice(source, from: "struct SessionProjectPage: View {", to: "\n}\n")
        let card = try slice(page, from: "@ViewBuilder private var firstCard: some View {", to: "\n    }")
        XCTAssertTrue(card.contains("if let subject = doneSubject, ProjectPage.drawsEnding(subject) {"),
                      "the shared rule — DONE, and a projection to tally — decides the card")
        XCTAssertTrue(card.contains("ProjectNotDoneCard(subject: subject, withCoordinator: 0, askedAt: nil)"),
                      "the settled card the conversation draws, asked nothing and waiting on nobody")
        XCTAssertTrue(card.contains("} else {\n            progressCard\n        }"),
                      "and the progress card wherever the ending does not stand")
        let subject = try slice(page, from: "private var doneSubject: ProjectDoneSubject? {", to: "\n    }")
        XCTAssertTrue(subject.contains("app.projectSessionsAddress == address ? app.projectSessionsDone : nil"),
                      "never what the model still holds for another address")

        let app = code(try appSource("AppModel.swift"))
        let load = try slice(app, from: "func loadProjectDone(_ address: SessionProjectAddress) async {",
                             to: "\n    }")
        XCTAssertTrue(load.contains("guard row?.status != .open else {"),
                      "the sidebar's rows are the Open projects: only a project that may be done is read")
        XCTAssertTrue(load.contains("api.projectCriteria(projectID: address.projectID)"))
        XCTAssertTrue(load.contains("projectSessionsAddress == address, !Task.isCancelled"))
        XCTAssertTrue(load.contains("projectSessionsDone = document.doneSubject"))
        XCTAssertFalse(load.contains("async let"))
        let sessions = try slice(app, from: "func loadProjectSessions(_ address: SessionProjectAddress) async {",
                                 to: "\n    }")
        XCTAssertTrue(sessions.contains("projectSessionsDone = nil"), "another project's ending never shows here")
        let task = try slice(page, from: ".task(id: address) {", to: "\n        }")
        XCTAssertEqual(task.components(separatedBy: "await app.loadProjectDone(address)").count - 1, 2,
                       "the ending is read on arrival and on every poll")
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
                     "func pollProjectSessions(_ address: SessionProjectAddress)",
                     "func loadProjectIntegration(_ address: SessionProjectAddress)",
                     "func loadProjectDone(_ address: SessionProjectAddress)",
                     "var projectSessionsColumn: SessionProjectAddress?"] {
            XCTAssertEqual(try branches(of: part, in: app), ["os(iOS)"])
        }
        let agents = code(try appSource("Views/AgentsView.swift"))
        let mac = try slice(agents, from: "ForEach(agents.agentSessions) { s in", to: "\n            }")
        XCTAssertFalse(mac.contains("SessionProject"))
        XCTAssertFalse(mac.contains("projectRow("))
    }
}

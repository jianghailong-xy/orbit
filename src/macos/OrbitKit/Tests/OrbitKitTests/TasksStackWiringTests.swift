import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. These hold the Tasks
/// section's navigation to the source it now *is*: **the section's stack in `NavState` is the only
/// copy**. The compact shell binds a `NavigationStack(path:)` to it and every row carries its own
/// destination value; the three-column shells keep their `List(selection:)`, a projection onto the
/// same stack; and the second page this section pushes — the searchable directory of every named
/// task list — is a frame on it rather than a boolean beside it.
///
/// This is the section that already had the incident this project is about: a task deleted under the
/// viewer could leave compact navigation on a spinner under a non-nil selection, and the fix at the
/// time was to clear the detail store by hand. Each check reads the slice of the file it is about, so
/// a match somewhere else can't pass it.
final class TasksStackWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }

    private func appSource(_ relative: String) throws -> String {
        try source("src/macos/OrbitApp/Sources/OrbitApp/\(relative)")
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

    /// The compact Tasks section is a `NavigationStack` whose path IS the section's stack, and its
    /// rows push their own destinations onto it. The collapsed `NavigationSplitView` it replaced is
    /// gone from this case, and with it the last `isPresented` push on this section's stack.
    func testTheCompactTasksSectionIsAStackBoundToTheSectionsStack() throws {
        let tasks = code(try slice(try appSource("Views/CompactShell.swift"),
                                   from: "case .tasks:", to: "// AGENTS"))
        XCTAssertTrue(tasks.contains("NavigationStack(path: $model.taskStack)"),
                      "the stack SwiftUI moves is the one this section keeps")
        XCTAssertTrue(tasks.contains("TasksListView(rowNavigation: .push)"),
                      "and the list's rows are the shape that pushes")
        XCTAssertTrue(tasks.contains("navigationDestination(for: NavNode.self)"),
                      "each frame type renders one page, keyed by the value that was pushed")
        XCTAssertTrue(tasks.contains("TaskDetailPage(taskID: taskID)"),
                      "the task's own page renders the frame that was pushed")
        XCTAssertTrue(tasks.contains("TaskListsDirectoryPage()"),
                      "and the second page this section pushes is a frame like the first")
        XCTAssertFalse(tasks.contains("NavigationSplitView"),
                       "a collapsed split cannot push a value: it only ever had a selection")
        XCTAssertFalse(tasks.contains("navigationDestination(isPresented:"),
                       "no boolean push left on the Tasks stack")
        XCTAssertFalse(tasks.contains("TaskDetailView()"),
                       "the detail pane the split hosted beside the list is a pushed page here")
    }

    /// One row, two containers. The row view is built once — actions included — and what differs is
    /// who moves the screen: the three-column `List`'s selection, or the compact row's own
    /// destination value. Neither shape draws a highlight it cannot open, because both read the same
    /// stack.
    func testOneRowInTwoContainersAndOnlyTheCompactOnePushes() throws {
        let source = try appSource("Views/TasksView.swift")
        let row = code(try slice(source, from: "private func taskRow(",
                                 to: "private func rowMenu("))
        let selectionBranch = try XCTUnwrap(row.range(of: "case .selection:"))
        let pushBranch = try XCTUnwrap(row.range(of: "case .push:"), "the compact branch")
        let tag = try XCTUnwrap(row.range(of: ".tag(task.id)"), "the three-column row stays tag-driven")
        let pushed = try XCTUnwrap(
            row.range(of: "Button { model.push(.taskDetail(taskID: task.id)) } label: {"),
            "the compact row carries its destination")
        XCTAssertLessThan(tag.lowerBound, pushBranch.lowerBound,
                          "`.tag` belongs to the selection branch, not the pushing one")
        XCTAssertLessThan(pushBranch.lowerBound, pushed.lowerBound,
                          "and the push belongs to the pushing branch")
        XCTAssertFalse(row.contains("NavigationLink"),
                       "the compact row is not a link: the disclosure indicator a "
                       + "`NavigationLink(value:)` draws cannot be hidden on iOS 17/18, so the row "
                       + "pushes its frame through `AppModel.push` instead")
        XCTAssertLessThan(selectionBranch.lowerBound, pushBranch.lowerBound)
        XCTAssertEqual(row.components(separatedBy: "TaskRowView(task: task").count - 1, 1,
                       "the row itself is built once and shared by both branches")

        // Who gets which shape: the compact shell asks for the pushing one, and the three-column
        // shell takes the default. `MainView` reaches the list through `SectionContent`, so the
        // default is what it gets.
        XCTAssertTrue(code(try appSource("Views/CompactShell.swift"))
            .contains("TasksListView(rowNavigation: .push)"))
        let main = code(try appSource("Views/MainView.swift"))
        XCTAssertFalse(main.contains("rowNavigation:"),
                       "the three-column shell keeps the List's selection")
        XCTAssertTrue(main.contains("TasksListView()"),
                      "and reaches the list with its default shape")

        // The projection those three-column rows select through.
        let projection = code(try slice(source, from: "private var listSelection: Binding<String?>? {",
                                        to: "private func scopeBinding("))
        XCTAssertTrue(projection.contains("guard rowNavigation == .selection else { return nil }"),
                      "the compact list has nothing to select — its rows push")
        XCTAssertTrue(projection.contains("get: { model.selectedTaskID }"),
                      "the selection IS the task page on top of the stack")
        XCTAssertTrue(projection.contains("set: { model.selectedTaskID = $0 }"),
                      "and selecting swaps the page the detail pane shows")
    }

    /// Every fact the shells read is a read of the stack, and every write is a stack transition or
    /// the store-sync funnel underneath it: nothing here keeps a copy that could disagree with what
    /// SwiftUI has pushed.
    func testTheModelKeepsNoCopyOfWhatTheStackAlreadySays() throws {
        // Sliced from the raw file (its end anchors are the comments that follow each block), then
        // stripped, so a comment can't stand in for the code a check is about.
        let app = try appSource("AppModel.swift")

        let selection = code(try slice(app, from: "var selectedTaskID: String? {",
                                       to: "/// The Tasks stack, as the compact shell binds it."))
        XCTAssertTrue(selection.contains("get { nav.taskDetailOnTop }"),
                      "the selection is the task page on top, not a field beside the stack")
        XCTAssertTrue(selection.contains("nav.replaceTop(with: .taskDetail(taskID: id))"),
                      "and selecting replaces the page the detail pane shows")
        XCTAssertTrue(selection.contains("syncTaskDetailStore()"),
                      "with the detail store following it in the same write")

        let directory = code(try slice(app, from: "var taskListsDirectoryPresented: Bool {",
                                       to: "/// Written through to `lastAgentKey`"))
        XCTAssertTrue(directory.contains("get { nav.taskListsDirectoryOnTop }"),
                      "the directory is a frame like any other, not a flag beside the stack")
        XCTAssertTrue(directory.contains("nav.push(.taskListsDirectory)"),
                      "and it is the second page this section pushes")
        XCTAssertTrue(directory.contains("nav.pop()"),
                      "which picking a list closes by popping back onto the list")

        // The one door SwiftUI's own pushes and pops come through: the back button and the edge
        // swipe move the stack directly, so the binding's setter is where the store has to follow —
        // the pushed page reads it the moment it appears.
        let stack = code(try slice(app, from: "var taskStack: [NavNode] {",
                                   to: "/// Follow the stack's task page into the model"))
        XCTAssertTrue(stack.contains("nav.path = newValue"),
                      "the compact shell's stack is this section's")
        XCTAssertTrue(stack.contains("syncTaskDetailStore()"),
                      "and the page SwiftUI pushed names itself in the store as it lands")
        let sync = code(try slice(app, from: "private func syncTaskDetailStore() {", to: "\n    }"))
        XCTAssertTrue(sync.contains("tasks?.setSelectedDetailID(selectedTaskID)"),
                      "the detail store's single slot mirrors the stack, nothing else")

        // A row pushes by hand now (`AppModel.push`) rather than through the binding, so that door
        // has to follow the store too — and only for this stack: the store is read off the stack on
        // screen, so syncing under another section would name nil and strand this one's page.
        let push = code(try slice(app, from: "func push(_ node: NavNode) {", to: "\n    }"))
        XCTAssertTrue(push.contains("nav.push(node)"),
                      "a compact row's tap is a stack transition like any other")
        XCTAssertTrue(push.contains("if nav.section == .tasks { syncTaskDetailStore() }"),
                      "and the task page it puts up names itself in the store as it lands")

        let root = code(try slice(app, from: "var sectionAtRoot: Bool {",
                                  to: "/// ⌘D: complete the open"))
        XCTAssertTrue(root.contains("case .tasks:   return nav.sectionAtRoot"),
                      "at root is an empty stack, not two fields that could disagree with it")

        // The ways in and the ways out, all under the names their callers already used: a route
        // opens a task, a detail 404 clears the one on screen, and signing out drops every stack.
        let route = code(try slice(app, from: "case .task(let id):", to: "case .runner(let id):"))
        XCTAssertTrue(route.contains("taskListsDirectoryPresented = false"))
        XCTAssertTrue(route.contains("selectedTaskID = id"))
        let missing = code(try slice(app, from: "tasksModel.onSelectedDetailMissing = {",
                                     to: "tasksModel.setSectionActive("))
        XCTAssertTrue(missing.contains("guard self?.selectedTaskID == id else { return }"),
                      "only the task that is actually on screen closes with its 404")
        XCTAssertTrue(missing.contains("self?.selectedTaskID = nil"))
        let reset = code(try slice(app, from: "private func resetNavigation() {",
                                   to: "/// Wire up notifications."))
        XCTAssertTrue(reset.contains("nav = NavState()"))
        XCTAssertTrue(reset.contains("selectedTaskID = nil"))
    }

    /// The two things this section kept *about itself* are gone with the boolean push they existed
    /// for: the stored directory flag, and the section-switch cleanup that lowered it on the way out.
    /// What is left is one stack per section, cleared by one sign-out.
    func testTheBooleanPushAndItsSectionSwitchCleanupAreGone() throws {
        let app = try appSource("AppModel.swift")
        XCTAssertFalse(code(app).contains("var taskListsDirectoryPresented = false"),
                       "the directory is a frame on the stack, not a stored flag")
        let setter = code(try slice(app, from: "var selectedSection: AppSection {",
                                    to: "/// Latches the one-shot default-landing"))
        XCTAssertFalse(setter.contains("taskListsDirectoryPresented"),
                       "a section switch leaves the Tasks stack alone, like every other section's")
        XCTAssertFalse(setter.contains("selectedTaskID"),
                       "and drops no selection the stack is keeping")

        // The acceptance for this step is a plain `grep` for the boolean destination, so that is
        // pinned from the suite as well as from the completion note: it has to be zero hits in the
        // list that used to raise the directory and in the shell that hosted it.
        let tasksView = try appSource("Views/TasksView.swift")
        XCTAssertFalse(tasksView.contains("navigationDestination(isPresented:"),
                       "the list no longer raises a page with a boolean")
        XCTAssertFalse(try appSource("Views/CompactShell.swift").contains("navigationDestination(isPresented:"),
                       "nor does the shell")
        // The page the boolean used to raise: its *type* is what this file kept, and the stack's
        // destination raises it (`CompactShell`'s `.taskListsDirectory` arm — pinned above).
        XCTAssertTrue(tasksView.contains("struct TaskListsDirectoryPage: View {"),
                      "the page it raised is a page of its own now, not a destination modifier")
    }

    /// Each pushed page renders the frame it was pushed with rather than reading a selection back out
    /// of the stack, so a page can only show the task it is the page of — and the directory closes by
    /// lowering itself, not by a flag over whatever the shell happened to be showing.
    func testEachPushedPageRendersTheFrameItWasPushedWith() throws {
        let source = try appSource("Views/TasksView.swift")
        let detail = code(try slice(source, from: "struct TaskDetailPage: View {",
                                    to: "private struct TaskDetailContent: View {"))
        XCTAssertTrue(detail.contains("let taskID: String"))
        XCTAssertTrue(detail.contains("TaskDetailContent(tasks: tasks, taskID: taskID).id(taskID)"))
        XCTAssertFalse(detail.contains("model.selectedTaskID"),
                       "the page does not read back the selection it is the page of")

        let directory = code(try slice(source, from: "struct TaskListsDirectoryPage: View {",
                                       to: "#endif"))
        XCTAssertTrue(directory.contains("TaskListsDirectoryView(tasks: tasks)"))
        let close = code(try slice(source, from: "private func open(_ scope: TaskScope) {",
                                   to: "struct TaskListsDirectoryPage: View {"))
        XCTAssertTrue(close.contains("model.taskListsDirectoryPresented = false"),
                      "picking a list pops this page off the stack")
        XCTAssertTrue(close.contains("tasks.selectScope(scope)"),
                      "onto the list that was picked")
    }
}

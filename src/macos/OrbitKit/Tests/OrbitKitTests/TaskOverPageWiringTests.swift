import Foundation
import XCTest

/// A task link opens where it was pressed (owner decision 2026-11-12): on the wide shells — macOS
/// and the iPad's split view — a task pressed in a conversation, a wiki page or a watch card opens
/// the task detail *over* that page, and closing it returns to the page as it was. The phone keeps
/// its own answer (push over the console), and the Tasks and Projects sections keep theirs (a
/// section switch), because those pages are a task's home.
///
/// SwiftUI doesn't exist on Linux, so nothing here compiles the shells; each check reads the slice
/// of the file it is about, so a match somewhere else can't pass it.
final class TaskOverPageWiringTests: XCTestCase {
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

    /// The model's own answer: an overlay that is no frame of any section's stack, so the page under
    /// it keeps its section, its stack and its scroll. Its detail store follows it, and closing puts
    /// that store back on the stack's page.
    func testTheTaskOverThePageIsNotAFrameOfTheStacks() throws {
        let app = code(try source("AppModel.swift"))
        let open = try slice(app, from: "func openTaskOverPage(_ id: String) {", to: "\n    }")
        XCTAssertTrue(open.contains("taskOverPageID = id"), "the task is the overlay's, not a frame")
        XCTAssertTrue(open.contains("tasks?.setSelectedDetailID(id)"),
                      "the one detail slot every detail read loads into follows it")
        let close = try slice(app, from: "func closeTaskOverPage() {", to: "\n    }")
        XCTAssertTrue(close.contains("taskOverPageID = nil"))
        XCTAssertTrue(close.contains("syncTaskDetailStore()"),
                      "closing hands the detail slot back to the stack's page — the conversation never moved")
        let isOpen = try slice(app, from: "func taskDetailIsOpen(_ id: String) -> Bool {", to: "\n    }")
        XCTAssertTrue(isOpen.contains("taskOverPageID.map(PublicID.storageKey)"),
                      "the page's polls and 404 guards read both containers")
        XCTAssertTrue(app.contains("var taskOverPageID: String?"))
        let reset = try slice(app, from: "private func resetNavigation() {", to: "\n    }")
        XCTAssertTrue(reset.contains("taskOverPageID = nil"), "signing out takes the overlay with it")
        let main = code(try source("Views/MainView.swift"))
        XCTAssertTrue(main.contains(".onChange(of: model.selectedSection) { _, _ in model.closeTaskOverPage() }"),
                      "choosing another page from the sidebar takes the overlay down with it")
        let missing = try slice(app, from: "tasksModel.onSelectedDetailMissing = {", to: "\n        }")
        XCTAssertTrue(missing.contains("if self?.taskOverPageID == id { self?.closeTaskOverPage() }"),
                      "a task deleted under the overlay takes the sheet down with it")
    }

    /// Where it is drawn: `MainView` is the macOS and iPad shell (the phone's `CompactShell` is the
    /// other), so that is the one place that says a task opens over the page, and the one place the
    /// panel exists. The content is the Tasks section's own page — no second look.
    func testOnlyTheWideShellDrawsTheTaskOverThePage() throws {
        let main = code(try source("Views/MainView.swift"))
        XCTAssertTrue(main.contains(".environment(\\.opensTasksOverPage, true)"),
                      "every page inside the wide shell says the same thing")
        XCTAssertTrue(main.contains("if model.taskOverPageID != nil { TaskOverPagePanel() }"))
        let detail = try slice(main, from: "} detail: {", to: "\n        }\n        .task")
        XCTAssertTrue(detail.contains("SectionDetail(section: model.selectedSection)"),
                      "the page stays mounted under the task — that is what keeps its scroll")
        XCTAssertFalse(detail.contains(".sheet("), "a sheet would cover the sidebar and the page's own state")
        let panel = try slice(main, from: "struct TaskOverPagePanel: View {", to: "\n}")
        XCTAssertTrue(panel.contains("TaskDetailPage(taskID: taskID, overPage: true)"),
                      "the existing task detail page, reused")
        XCTAssertTrue(panel.contains("Button { model.closeTaskOverPage() }"),
                      "one way down, back onto the page as it was")
        XCTAssertFalse(panel.contains("TaskDetailView()"),
                       "not the Tasks pane: that one reads the section's stack and would need a switch")

        let compact = code(try source("Views/CompactShell.swift"))
        XCTAssertFalse(compact.contains("opensTasksOverPage"),
                       "the phone keeps pushing over the console, never drawing this panel")
        let page = code(try source("Views/TasksView.swift"))
        let detailPage = try slice(page, from: "struct TaskDetailPage: View {", to: "\n}")
        XCTAssertTrue(detailPage.contains("var overPage = false"),
                      "a stack push and the Tasks pane keep the page they always had")
    }

    /// Every listed door hands the shell's answer to the one door: a task in a conversation, a wiki
    /// footnote or source, a watch card, an Orbit link card and the Markdown prose handler.
    func testEveryTaskLinkDoorAsksTheWideShellWhereToOpen() throws {
        let console = code(try source("Views/Console/ConsoleView.swift"))
        XCTAssertTrue(console.contains("@Environment(\\.opensTasksOverPage) private var opensTasksOverPage"))
        XCTAssertTrue(console.contains("appModel.openFromConversation(.task(taskID), overConsole: opensPagesOverConsole,"))
        XCTAssertTrue(console.contains("overPage: opensTasksOverPage)"))
        XCTAssertTrue(console.contains("appModel.openOrbitLink(url, overPage: opensTasksOverPage) ? .handled : .leaving(url)"),
                      "macOS prose links resolve through the app's door, so the console sets it")

        let composer = code(try source("Views/ComposerView.swift"))
        XCTAssertTrue(composer.contains("@Environment(\\.opensTasksOverPage) private var opensTasksOverPage"))
        XCTAssertTrue(composer.contains("app.openFromConversation(.task(taskID), overConsole: opensPagesOverConsole,"))
        XCTAssertTrue(composer.contains("overPage: opensTasksOverPage)"))
        XCTAssertTrue(composer.contains("private struct OpensTasksOverPageKey: EnvironmentKey"),
                      "the flag and the console's sit together, one answer for every page")

        let prose = code(try source("Views/Console/SelectableText.swift"))
        XCTAssertTrue(prose.contains("context.coordinator.opensOverPage = context.environment.opensTasksOverPage"))
        XCTAssertTrue(prose.contains("overPage: self.opensOverPage)"))

        let card = code(try source("Views/OrbitLinkCardView.swift"))
        XCTAssertTrue(card.contains("@Environment(\\.opensTasksOverPage) private var overPage"))
        XCTAssertTrue(card.contains("app.open(cards.destination(for: ref), overConsole: overConsole, overPage: overPage)"))

        let watching = code(try source("Views/WatchingCard.swift"))
        XCTAssertTrue(watching.contains("model.openFromConversation(destination, overConsole: overConsole, overPage: overPage)"))

        let wake = code(try source("Views/WatchWakeCardView.swift"))
        XCTAssertTrue(wake.contains("@Environment(\\.opensTasksOverPage) private var opensTasksOverPage"))
        XCTAssertTrue(wake.contains("model.openFromConversation(destination, overConsole: overConsole,"))
        XCTAssertTrue(wake.contains("overPage: opensTasksOverPage)"))

        let doc = code(try source("Views/WikiDocScreens.swift"))
        XCTAssertTrue(doc.contains("model.open(.task(id: PublicID.toPublic(id)), overPage: opensTasksOverPage)"),
                      "a footnote's task opens over the document")

        let screens = code(try source("Views/WikiScreens.swift"))
        XCTAssertTrue(screens.contains("if rowNavigation == .push { model.push(.taskDetail(taskID: PublicID.toPublic(id))) }"),
                      "the phone pushes a source's task over the entry")
        XCTAssertTrue(screens.contains("else { model.open(.task(id: PublicID.toPublic(id)), overPage: opensTasksOverPage) }"),
                      "a wide shell opens it over the entry instead")

        let cards = code(try source("OrbitLinkCards.swift"))
        XCTAssertTrue(cards.contains("case .task(let id):      openFromConversation(.task(id), overConsole: overConsole, overPage: overPage)"),
                      "the one door passes the answer to a task and to nothing else")
        XCTAssertTrue(cards.contains("case .session(let id):   openFromConversation(.session(id), overConsole: overConsole)"),
                      "a session link keeps its own routing")
    }

    /// Inside the open task: a dependency (or the verifier) replaces it instead of stacking, and the
    /// project line is the way out to the project — the one press that leaves the overlay.
    func testDependenciesReplaceTheOpenTaskAndTheProjectLineLeadsOut() throws {
        let tasks = code(try source("Views/TasksView.swift"))
        let content = try slice(tasks, from: "private struct TaskDetailContent: View {", to: "\n}\n")
        XCTAssertTrue(content.contains("var overPage = false"))
        let open = try slice(content, from: "private func openRoute(_ route: Route) {", to: "\n    }")
        XCTAssertTrue(open.contains("if case .task(let id) = route { return model.openTaskOverPage(id) }"),
                      "a task opens on top of the one already open — replace, never stack")
        XCTAssertTrue(open.contains("model.closeTaskOverPage()"),
                      "anything else leaves the overlay for the page it names")
        let project = try slice(content, from: "private func openTaskProject(_ id: String) {", to: "\n    }")
        XCTAssertTrue(project.contains("if overPage { model.closeTaskOverPage() }"),
                      "the project line is how the reader gets to the project")
        XCTAssertTrue(content.contains("if !row.isFocus { openRoute(.task(row.id)) }"),
                      "a dependency row goes through that one press")
        XCTAssertTrue(content.contains("TaskDependencyGraphView(graph: graph) { openRoute(.task($0)) }"),
                      "and so does a press in the graph")
        XCTAssertTrue(content.contains("Button { openTaskProject(project.id) } label: {"),
                      "the header's project line is the one that leads out")
        let delete = try slice(content, from: "Button(\"Delete task\", role: .destructive) {", to: "} message: {")
        XCTAssertTrue(delete.contains("if overPage { model.closeTaskOverPage() }"),
                      "a deleted task does not leave its sheet on a spinner")
    }
}

import Foundation
import XCTest

/// The native task page is the web panel's blocks in the web panel's order, drawn the way the owner
/// approved on 2026-09-26 (docs/mocks/ios-task-detail.html): grouped cards, at most two presses under
/// the title with `Mark done` in the menu, and a comment box that stays on screen. These read the
/// SwiftUI source (and the web source it follows) — the source is not compiled here; `client.yml`
/// is what compiles it.
///
/// If the web panel reorders or adds a block, `testTheWebPanelStillDrawsTheBlocksInThisOrder` goes
/// red first: decide whether the phone follows, then move both halves together.
final class TaskDetailWiringTests: XCTestCase {

    private enum TaskDetailWiringMissing: Error { case file(String) }

    private static let tasksView = "src/macos/OrbitApp/Sources/OrbitApp/Views/TasksView.swift"
    private static let parts = "src/macos/OrbitApp/Sources/OrbitApp/Views/TaskDetailParts.swift"
    private static let webPanel = "src/web/src/components/TaskDetailPanel.tsx"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw TaskDetailWiringMissing.file(relative)
    }

    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw TaskDetailWiringMissing.file("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// Where each marker first appears in `text`, failing on any that does not.
    private func positions(_ markers: [String], in text: String, line: UInt = #line) throws -> [Int] {
        try markers.map { marker in
            guard let range = text.range(of: marker) else {
                XCTFail("missing: \(marker)", line: line)
                throw TaskDetailWiringMissing.file(marker)
            }
            return text.distance(from: text.startIndex, to: range.lowerBound)
        }
    }

    // MARK: the order

    private static let pageOrder = [
        "header(task)", "banners(task)", "actions(task)", "verifierSection(task)", "detailsSection(task)",
        "dependenciesSection(task)", "descriptionSection(task)", "acceptanceSection(task)", "inputsSection(task)",
        "attributionSection(task)", "followedBySection(task)", "runsSection(task)", "commentsSection(task)",
    ]

    func testThePageDrawsTheWebPanelsBlocksInItsOrder() throws {
        let view = try source(Self.tasksView)
        let page = try section(view, from: "private func page(_ task: TaskItem) -> some View {",
                               to: "private func header(_ task: TaskItem)")
        let order = try positions(Self.pageOrder, in: page)
        XCTAssertEqual(order, order.sorted(), "head, presses, [check], Details … Comments — the web's order")
        XCTAssertTrue(page.contains("List {"), "one list of grouped cards, the project page's surface")
        XCTAssertTrue(page.contains(".taskPageListStyle()"))
        XCTAssertTrue(page.contains(".safeAreaInset(edge: .bottom) { composer(task) }"),
                      "the comment box stays on screen instead of waiting at the bottom of the page")
        XCTAssertTrue(page.contains(".refreshable { await reload() }"))
        let style = try section(view, from: "@ViewBuilder func taskPageListStyle() -> some View {", to: "#else")
        XCTAssertTrue(style.contains(".listStyle(.insetGrouped)") && style.contains(".headerProminence(.increased)"))
    }

    func testTheWebPanelStillDrawsTheBlocksInThisOrder() throws {
        let web = try source(Self.webPanel)
        let body = try section(web, from: "<div className=\"tdp-body\">", to: "<div className=\"tdp-compose\">")
        let order = try positions([
            "showVerifierCard &&", ">Details<", ">Dependencies<", ">Description<", ">Acceptance<", "<TaskInputs ",
            "<TaskAttributionCard ", "<TaskFollowedBy ", ">Runs (", ">Comments (",
        ], in: body)
        XCTAssertEqual(order, order.sorted(), "the web panel's blocks moved — decide whether the phone follows")
        let head = try section(web, from: "<div className=\"tdp-head-actions\">", to: "<Popconfirm")
        XCTAssertFalse(head.contains("Mark done"), "the browser offers no Mark done beside its presses either")
    }

    // MARK: the head

    func testTheBarShowsTheTitleOnlyOnceItHasScrolledAway() throws {
        let view = try source(Self.tasksView)
        let content = try section(view, from: "private struct TaskDetailContent: View {", to: "private var detailPollKey")
        XCTAssertTrue(content.contains("#if os(iOS)\n        // The session and project pages' bar"))
        XCTAssertTrue(content.contains(".navigationTitle(\"\")"))
        XCTAssertTrue(content.contains("ToolbarItem(placement: .principal) { TaskNavTitle(task: task) }"))
        XCTAssertTrue(content.contains("if !headerOnScreen, let task = tasks.detail, task.id == taskID {"))
        let page = try section(view, from: "private func page(_ task: TaskItem) -> some View {",
                               to: "private func header(_ task: TaskItem)")
        XCTAssertTrue(page.contains(".onAppear { headerOnScreen = true }"))
        XCTAssertTrue(page.contains(".onDisappear { headerOnScreen = false }"))
    }

    func testAtMostTwoPressesAndMarkDoneLivesInTheMenu() throws {
        let view = try source(Self.tasksView)
        let presses = try section(view, from: "private func actions(_ task: TaskItem) -> some View {",
                                  to: "private func runDisabledHint")
        XCTAssertFalse(presses.contains("Mark done"), "a second `done` beside Confirm done read as the same press")
        XCTAssertTrue(presses.contains("if row.stacked {"), "the long pointer stacks rather than wraps")
        XCTAssertTrue(presses.contains("HStack(spacing: 10) {"))
        XCTAssertEqual(presses.components(separatedBy: ".frame(maxWidth: .infinity)").count - 1, 6,
                       "every label fills its half: three leading presses and three trailing ones")
        XCTAssertEqual(presses.components(separatedBy: ".lineLimit(1)").count - 1, 6, "and none of them wraps")
        XCTAssertTrue(presses.contains("TaskDetailCopy.runNow"), "the detail's first run says what the browser's does")

        let menu = try section(view, from: "ToolbarItem(placement: .primaryAction) {\n                    Menu {",
                               to: ".accessibilityLabel(\"Task actions\")")
        let order = try positions(["Label(SharePanelCopy.copyAsMarkdown,", "Label(\"Mark done\"",
                                   "Label(\"Delete task\""], in: menu)
        XCTAssertEqual(order, order.sorted(), "… Copy as Markdown / Mark done / Delete task")
        XCTAssertTrue(menu.contains("Task { await tasks.setStatus(task.id, .done) }"))
    }

    // MARK: the blocks

    func testEveryHeadingIsTheBrowsersWord() throws {
        let view = try source(Self.tasksView)
        for heading in ["detailsHeading", "dependenciesHeading", "descriptionHeading", "acceptanceHeading",
                        "inputsHeading", "attributionHeading", "followedByHeading", "runsHeading", "commentsHeading"] {
            XCTAssertTrue(view.contains("sectionHeader(TaskDetailCopy.\(heading)"), "\(heading) is not drawn")
        }
    }

    func testTheDetailsRowsAreFormRowsAndTheProvenanceReadsUnderTheCard() throws {
        let view = try source(Self.tasksView)
        let details = try section(view, from: "private func detailsSection(_ task: TaskItem) -> some View {",
                                  to: "private func detailRow(")
        let order = try positions(["assigneePicker(task)", "providerPicker(task)", "modelPicker(task)",
                                   "listPicker(task)", "TaskDetailCopy.startAtLabel", "TaskDetailCopy.createdFromLabel"],
                                  in: details)
        XCTAssertEqual(order, order.sorted(), "the browser's field order")
        XCTAssertTrue(details.contains("editingSchedule = true"), "Start at opens its sheet")
        XCTAssertTrue(details.contains("TaskDetailLogic.createdFootnote("), "Created by and Created, as one footnote")
        XCTAssertFalse(details.contains("detailRow(TaskDetailCopy.createdByLabel"))
        let pickers = try section(view, from: "private func assigneePicker(_ task: TaskItem)",
                                  to: "// MARK: dependencies")
        XCTAssertEqual(pickers.components(separatedBy: ".pickerStyle(.menu)").count - 1, 4,
                       "Assignee, Provider, Model and List are the platform's menu pickers")
    }

    func testTheNewBlocksReadAndWriteThroughTheModel() throws {
        let view = try source(Self.tasksView)
        let load = try section(view, from: ".task(id: taskID) {\n            await loadDetail()",
                               to: ".task(id: detailPollKey)")
        for read in ["tasks.loadAttribution(taskID)", "tasks.loadDependencyGraph(taskID)", "model.watches?.load()"] {
            XCTAssertTrue(load.contains(read), "the page opens without \(read)")
        }
        XCTAssertTrue(view.contains("await tasks.setRunAt(task.id, date)"))
        XCTAssertTrue(view.contains("await tasks.setRunAt(task.id, nil)"))
        XCTAssertTrue(view.contains("await tasks.saveAcceptance(task.id, request)"))
        XCTAssertTrue(view.contains("await tasks.addInput(taskID, filename:"))
        XCTAssertTrue(view.contains("await tasks.removeInput(taskID, inputID: input.id)"))
        XCTAssertTrue(view.contains("TaskFollowSheet(task: task, store: store)"))
        XCTAssertTrue(view.contains("TaskDetailLogic.followers(of: task.id, in: store?.watches ?? [])"))
        XCTAssertTrue(view.contains("TaskDetailLogic.attributionRows(view)"))
        XCTAssertTrue(view.contains("TaskDetailLogic.dependencyGraph(for: task, loaded: tasks.dependencyGraph)"))
        XCTAssertTrue(view.contains("TaskDependencyGraphView(graph: graph)"))
        // Removing an input or a prerequisite is asked first, in the browser's words.
        XCTAssertTrue(view.contains("confirmationDialog(TaskDetailCopy.removeInputTitle"))
        XCTAssertTrue(view.contains("confirmationDialog(TaskDetailCopy.removePrerequisiteTitle"))
    }

    func testLongTextFoldsFromItsLengthAndTheSheetsSaveExplicitly() throws {
        let parts = try source(Self.parts)
        let fold = try section(parts, from: "struct FoldableMarkdown: View {", to: "struct TaskDependencyGraphView")
        XCTAssertTrue(fold.contains("TaskDetailLogic.folds(source)"),
                      "decided from the text, never from a measured row height")
        XCTAssertFalse(fold.contains("GeometryReader"))
        let schedule = try section(parts, from: "struct TaskScheduleSheet: View {", to: "struct TaskAcceptanceSheet")
        XCTAssertTrue(schedule.contains("Button(TaskDetailCopy.saveSchedule) { save() }"),
                      "a wheel scrolled through times must not schedule each of them")
        XCTAssertTrue(schedule.contains("Button(TaskDetailCopy.cancelSchedule, role: .destructive)"))
        let acceptance = try section(parts, from: "struct TaskAcceptanceSheet: View {", to: "struct TaskFollowSheet")
        XCTAssertTrue(acceptance.contains(".disabled(saving || !draft.canSave(over: current))"))
        XCTAssertTrue(acceptance.contains("draft.patch(over: current)"))
        let follow = try section(parts, from: "struct TaskFollowSheet: View {", to: "private func follow()")
        XCTAssertTrue(follow.contains("TaskDetailLogic.followConditions"))
        XCTAssertTrue(follow.contains("@State private var idempotencyKey"), "one key per sheet")
    }
}

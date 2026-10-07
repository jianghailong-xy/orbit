import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. These hold the project
/// page's crossings card to the source it is: the page reads the crossings with its other reads,
/// draws them last — where the web draws them — on the one page both apps and the iPhone's compact
/// shell share, answers only a question, and answers it in two presses whose second one reaches the
/// decision door — the door at which confirming a move moves the task.
final class ProjectCrossingsWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    private func source(_ path: String) throws -> String {
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

    private func appSource(_ relative: String) throws -> String {
        try source("src/macos/OrbitApp/Sources/OrbitApp/\(relative)")
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

    /// The crossings are read beside the page's other reads, on a task handle cancelled with them —
    /// never a sibling `async let`, whose teardown iOS 27's runtime can abort on — and a failed read
    /// keeps an earlier answer rather than emptying the card.
    func testThePageReadsItsCrossingsWithItsOtherReads() throws {
        let model = code(try appSource("ProjectsModel.swift"))
        let load = try slice(model, from: "func load(refreshGraph: Bool = true) async {", to: "\n    }\n")
        XCTAssertTrue(load.contains("let crossingsRead = Task { try await api.projectCrossings(projectID: projectID) }"))
        XCTAssertTrue(load.contains("crossingsRead.cancel()"), "cancelled with the page's other reads")
        XCTAssertFalse(load.contains("async let"), "the page's reads avoid async-let teardown")
        XCTAssertTrue(load.contains("if let rows = try? await crossingsRead.value {\n            crossings = rows\n            crossingsUnread = false\n        } else {\n            crossingsUnread = crossings == nil\n        }"))
    }

    /// An answer goes to the decision door with the row it was given on; taken, the page re-reads,
    /// so the row says what it left — a confirmed move reads as moved; refused, the door's own code
    /// and reason come back for that row.
    func testAnAnswerReachesTheDecisionDoorAndThePageRereads() throws {
        let model = code(try appSource("ProjectsModel.swift"))
        let decide = try slice(model, from: "func decideCrossing(_ crossing: ProjectCrossing,", to: "\n    }\n")
        let send = try XCTUnwrap(decide.range(of: "try await api.decideProjectCrossing(projectID: projectID, crossing: crossing, decision)"))
        let refused = try XCTUnwrap(decide.range(of: "return ProjectCrossings.refusal(error)"))
        let reread = try XCTUnwrap(decide.range(of: "onChanged()\n        await load()\n        return nil"))
        XCTAssertTrue(send.lowerBound < refused.lowerBound && refused.lowerBound < reread.lowerBound)
        XCTAssertTrue(decide.contains("answeringCrossing = crossing.id\n        defer { answeringCrossing = nil }"),
                      "the row is busy until the re-read has its new state")

        let client = code(try source("src/macos/OrbitKit/Sources/OrbitKit/Net/APIClient.swift"))
        let door = try slice(client, from: "public func decideProjectCrossing(", to: "\n    }\n")
        XCTAssertTrue(door.contains("try await postRaw(\"projects/\\(projectID)/handoffs/\\(ProjectCrossings.doorID(crossing))/decision\","))
        XCTAssertTrue(door.contains("body: ProjectCrossings.request(crossing, decision))"))
    }

    /// Last on the page, after the tasks, where the web draws it — on the one page the Mac, the iPad
    /// and the iPhone's compact shell all draw.
    func testTheCardIsTheLastSectionOfTheSharedProjectPage() throws {
        let view = code(try appSource("Views/ProjectsView.swift"))
        let page = try slice(view, from: "private func page(", to: ".projectPageListStyle()")
        let tasks = try XCTUnwrap(page.range(of: "tasksSection(store, document)"))
        let crossings = try XCTUnwrap(page.range(of: "crossingsSection(store)"))
        XCTAssertTrue(tasks.upperBound < crossings.lowerBound)
        let shell = code(try appSource("Views/CompactShell.swift"))
        XCTAssertTrue(shell.contains("case .projectDetail(let projectID, _):\n                            ProjectDetailView(projectID: projectID)"),
                      "the iPhone pushes the same page")

        let ios = try source("src/ios/project.yml")
        XCTAssertTrue(ios.contains("- path: ../macos/OrbitApp/Sources/OrbitApp\n        name: Shared"),
                      "the iOS app builds the shared sources")
        XCTAssertFalse(ios.contains("ProjectCrossingRow.swift"), "and does not exclude the card's row")
        XCTAssertFalse(ios.contains("ProjectsView.swift"))
    }

    /// The section: the questions first, in the web's order, under the web's title and count; one
    /// question open at a time; a refusal shown only on the row whose question is open; and a read
    /// that failed with nothing to show says so instead of drawing nothing.
    func testTheSectionHoldsOneQuestionAtATime() throws {
        let view = code(try appSource("Views/ProjectsView.swift"))
        let section = try slice(view, from: "private func crossingsSection(_ store: ProjectDetailModel) -> some View {",
                                to: "private func answerCrossing(")
        XCTAssertTrue(section.contains("ForEach(ProjectCrossings.ordered(rows)) { row in"))
        XCTAssertTrue(section.contains("let asking = crossingAsk?.id == row.id"))
        XCTAssertTrue(section.contains("confirming: asking ? crossingAsk?.decision : nil,"))
        XCTAssertTrue(section.contains("refusal: asking && crossingRefusal?.id == row.id ? crossingRefusal?.refusal : nil,"))
        XCTAssertTrue(section.contains("crossingAsk = ProjectCrossingAsk(id: row.id, decision: decision)"),
                      "asking on one row closes the question open on another")
        XCTAssertTrue(section.contains("onAnswer: { decision in answerCrossing(row, decision, store: store) })"))
        XCTAssertTrue(section.contains("sectionHeader(ProjectCrossings.title,\n                              detail: ProjectCrossings.waiting(ProjectCrossings.waitingCount(rows)))"))
        XCTAssertTrue(section.contains("} else if store.crossingsUnread {"))
        XCTAssertTrue(section.contains("Label(ProjectCrossings.unreadable, systemImage: \"exclamationmark.triangle\")"))

        let answer = try slice(view, from: "private func answerCrossing(", to: "\n    }\n")
        let sent = try XCTUnwrap(answer.range(of: "if let refusal = await store.decideCrossing(row, decision) {"))
        let kept = try XCTUnwrap(answer.range(of: "crossingRefusal = ProjectCrossingRefusal(id: row.id, refusal: refusal)"))
        let closed = try XCTUnwrap(answer.range(of: "} else {\n                crossingAsk = nil"))
        XCTAssertTrue(sent.lowerBound < kept.lowerBound && kept.lowerBound < closed.lowerBound,
                      "refused, the question stays open beside the reason; taken, it closes")
    }

    /// The row: only a question offers presses; the first press only asks; the second names the
    /// move, says its consequence and the crossing key, and is the only one that answers.
    func testTheRowAnswersOnlyAQuestionAndOnlyOnTheSecondPress() throws {
        let row = code(try appSource("Views/ProjectCrossingRow.swift"))
        let body = try slice(row, from: "var body: some View {", to: "private var moveSubject: some View {")
        let gate = try XCTUnwrap(body.range(of: "if ProjectCrossings.isAnswerable(row.state) {"))
        let second = try XCTUnwrap(body.range(of: "secondPress(ProjectCrossings.prompt(row, confirming), decision: confirming)"))
        let first = try XCTUnwrap(body.range(of: "firstPress"))
        XCTAssertTrue(gate.lowerBound < second.lowerBound && gate.lowerBound < first.lowerBound)
        XCTAssertTrue(body.contains("Text(ProjectCrossings.meaning(row))"), "what the state means, for its kind")
        XCTAssertTrue(body.contains("if row.isMove {\n                moveSubject"), "a move names the task it moves")

        let firstPress = try slice(row, from: "private var firstPress: some View {", to: "private func secondPress(")
        XCTAssertTrue(firstPress.contains("onAsk(.approve)") && firstPress.contains("onAsk(.deny)"))
        XCTAssertFalse(firstPress.contains("onAnswer"), "the first press only asks")

        let secondPress = try slice(row, from: "private func secondPress(", to: "private func refused(")
        XCTAssertTrue(secondPress.contains("Text(ProjectCrossings.question(prompt))"))
        XCTAssertTrue(secondPress.contains("Text(prompt.consequence)"))
        XCTAssertTrue(secondPress.contains("Text(ProjectCrossings.shortKey(row.crossingKey))"))
        XCTAssertTrue(secondPress.contains("onAnswer(decision)"))
        XCTAssertTrue(secondPress.contains("Text(ProjectCrossings.confirmLabel(prompt))"))
        XCTAssertTrue(secondPress.contains("onCancel()"))

        // The Mac's Swift 6.4 compiler crashes on a ternary over labelled tuples, which Linux's 6.1
        // builds; nothing on this page's new code takes that shape.
        for file in ["Views/ProjectCrossingRow.swift", "Views/ProjectsView.swift", "ProjectsModel.swift"] {
            let text = code(try appSource(file))
            XCTAssertNil(text.range(of: #"\?\s*\(\s*\w+\s*:"#, options: .regularExpression),
                         "\(file) has a ternary over a labelled tuple")
        }
    }
}

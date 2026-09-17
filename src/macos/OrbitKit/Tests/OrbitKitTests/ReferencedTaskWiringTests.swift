import Foundation
import XCTest
@testable import OrbitKit

/// The wires between the reading of the `<referenced-task>` blocks and the SwiftUI surface that
/// draws them.
///
/// `ReferencedTaskTests` proves the reading; it proves nothing about what a reader sees unless the
/// view reads it, and no compiler here checks that — SwiftUI does not exist on Linux, and
/// `AttachedNoteView.swift` is compiled only by the macOS and iOS jobs. So the attachment is
/// asserted over the source, the way `BackgroundJobsWiringTests` does, and each assertion is written
/// so that CUTTING the wire is what turns it red.
///
/// The two it exists for:
///  - every referenced task opens as a card whose title is the link, rather than as the plain-text
///    table whose id a reader could see and not tap;
///  - a note carrying both kinds of block draws each of them once, neither swallowing the other.
///
/// What it cannot see is how any of it looks — that is what the beta and the screenshots are for.
final class ReferencedTaskWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "the view still reads the block it is drawing."
            }
        }
    }

    private static let notePath = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/AttachedNoteView.swift"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.missing(relative)
    }

    /// One view's own stretch of the file, so a match 200 lines away cannot answer for it — a bare
    /// `contains` over a whole file is how a scan like this goes falsely green. `to` left out is the
    /// rest of the file, for the view that sits last in it.
    private func section(_ source: String, from: String, to: String? = nil) throws -> String {
        guard let start = source.range(of: from) else { throw WiringError.missing(from) }
        guard let to else { return String(source[start.lowerBound...]) }
        guard let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    // MARK: the blocks open as cards

    /// The entry reads the blocks, and the line that names the note shut carries their counts.
    func testTheAttachedEntryReadsTheBlocksAndCountsThemOnTheShutLine() throws {
        let entry = try section(try source(Self.notePath),
                                from: "struct AttachedNoteEntry", to: "struct BackgroundJobsNoteView")

        // Read from what the inventory did not take, so a note carrying both draws each block once:
        // reading the whole note twice is what would draw the jobs as rows AND again as text.
        XCTAssertTrue(entry.contains("ReferencedTaskText.parse(jobs?.rest ?? attached.text)"),
                      "the entry must read the references out of what the inventory left")
        XCTAssertTrue(entry.contains("ReferencedTaskNote.summary(tasks.tasks)"),
                      "the count on the shut line is the whole point of it: \"referenced task\" "
                          + "alone never said whether opening it was worth the tap")
        XCTAssertTrue(entry.contains("ReferencedTaskNoteView(tasks: tasks.tasks)"),
                      "a note that read as references opens as cards")
        // Whatever neither reading took is still drawn, and a note neither could read is untouched.
        XCTAssertTrue(entry.contains("if !rest.isEmpty { verbatim(rest) }"),
                      "another block the same note carried is drawn as it always was")
        XCTAssertTrue(entry.contains("verbatim(attached.text)"),
                      "any other block still opens verbatim")
    }

    /// A card is the status, what the line said after it, the title as the link, the outcome and the
    /// ids — each off the reading rather than off a field spelled out a second time here.
    func testACardDrawsTheStatusTheTitleTheOutcomeAndTheIds() throws {
        let cards = try section(try source(Self.notePath), from: "struct ReferencedTaskNoteView")

        for wire in ["ReferencedTaskNote.pill(task)", "task.suffixes", "Text(task.title)",
                     "ReferencedTaskNote.outcome(task)", "ReferencedTaskNote.meta(task)"] {
            XCTAssertTrue(cards.contains(wire), "a card is drawn off \(wire)")
        }
        // The title is the row, and a task title runs long: the ids sit under it, not beside it.
        XCTAssertTrue(cards.contains(".lineLimit(2)"), "the title is held to two lines")
    }

    /// The title opens the task. This is the wire the whole change is for: the id was in the block
    /// all along, as text nobody could tap.
    func testTheTitleOpensTheTaskThroughTheSchemeBothShellsRoute() throws {
        let cards = try section(try source(Self.notePath), from: "struct ReferencedTaskNoteView")

        XCTAssertTrue(cards.contains("@Environment(\\.openURL) private var openURL"),
                      "the card opens links through the environment action both app shells install")
        XCTAssertTrue(cards.contains("if let url = ReferencedTaskNote.link(task) { openURL(url) }"),
                      "tapping the title opens the task it names")

        // And the link that wire carries is one this app routes rather than hands to a browser.
        let task = ReferencedTask(id: "34OAsTIS8JuGm5H2j95qO", title: "t", status: "DONE",
                                  suffixes: [], list: "(无列表)", assignee: "orbit", runs: 1,
                                  executed: 1, lastRun: "SUCCEEDED, 59 turns")
        XCTAssertEqual(ReferencedTaskNote.link(task).flatMap(ReferenceLink.route),
                       .task("34OAsTIS8JuGm5H2j95qO"))
    }
}

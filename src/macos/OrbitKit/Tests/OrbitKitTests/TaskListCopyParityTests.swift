import Foundation
import XCTest
@testable import OrbitKit

/// The Tasks list says the same words on the phone and in the browser, and this is the tripwire
/// that keeps it saying them.
///
/// `TaskListCopy` spells every sentence the web page also shows — the view's name, the pinned
/// section, the one line about the tasks on project pages, the lock's two sentences, the empty
/// states — and nothing in a build catches one of them re-worded at one end: the Swift client and
/// the browser bundle share no compiler. So this reads the web sources and looks for each.
///
/// Deliberately NOT compared: the phone's menu entries (`Select Tasks`, `Sort By`, `Filter by
/// Label…`) and its header over the rest of the rows (`Newest first`). The web has neither — it
/// draws selection as checkboxes and the order as column-header carets — so there is nothing on
/// the other end to match.
final class TaskListCopyParityTests: XCTestCase {

    private static let webPage = "src/web/src/pages/TaskListView.tsx"
    private static let webSchedule = "src/web/src/lib/taskSchedule.ts"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(TaskListCopyParityTests.webPage) was not found above this test file. The "
                    + "web Tasks page is one half of a pair; if it moved, move this check with it "
                    + "rather than deleting it."
            case .missing(let relative):
                return "\(relative) was not found. The Tasks list's words are written at both ends; "
                    + "if one moved, move this check with it rather than deleting it."
            }
        }
    }

    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webPage).path) {
                return dir
            }
            dir.deleteLastPathComponent()
        }
        throw ParityError.noRepo
    }

    /// The source with adjacent string literals joined, so a sentence the web folded across lines
    /// (`'…' + '…'`) reads as the one sentence it is.
    private func source(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { throw ParityError.missing(relative) }
        return text
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
    }

    func testTheViewsAreNamedAsTheWebNamesThem() throws {
        let page = try source(Self.webPage)
        XCTAssertTrue(page.contains("'\(TaskListCopy.allTasks)'"), "web no longer calls the view \(TaskListCopy.allTasks)")
        XCTAssertTrue(page.contains("'\(TaskListCopy.noList)'"), "web no longer calls the tasks in no list \(TaskListCopy.noList)")
        XCTAssertTrue(page.contains("label: '\(TaskListCopy.tasksView)'"))
        XCTAssertTrue(page.contains("label: '\(TaskListCopy.batchesView)'"))
        XCTAssertTrue(page.contains("placeholder=\"\(TaskListCopy.searchTasks)\""))
    }

    func testThePinnedSectionAndTheLineAboutProjectsAreTheWebs() throws {
        let page = try source(Self.webPage)
        XCTAssertTrue(page.contains(">\(TaskListCopy.happeningNow)<"), "the pinned section's name")
        XCTAssertTrue(page.contains(TaskListCopy.scopeNoteLead), "the scope note's first sentence")
        // The count sits between the two halves on the web, bolded; the tail follows it.
        XCTAssertTrue(page.contains("tasks in{' '}"), "the scope note's middle")
        XCTAssertTrue(page.contains("projects are on their project pages."), "the scope note's tail")
        let tail = TaskListCopy.scopeNote(tasks: 1, projects: 1).tail
        XCTAssertTrue(tail.hasSuffix("projects are on their project pages."))
        XCTAssertTrue(page.contains(">\(TaskListCopy.projectsLink)<"), "the link to Projects")
        XCTAssertTrue(page.contains(TaskListCopy.steeringSession), "a list's steering session")
    }

    func testALockedRowSaysWhatTheWebRowsTooltipSays() throws {
        let page = try source(Self.webPage)
        XCTAssertTrue(page.contains("'\(TaskListCopy.prerequisiteCancelled)'"))
        XCTAssertTrue(page.contains("'\(TaskListCopy.waitingForPrerequisites)'"))
        XCTAssertTrue(page.contains("\(TaskListCopy.startsPrefix){starts.local}"), "the scheduled-start marker")
        XCTAssertTrue(page.contains(">\(TaskListCopy.unassigned)<"))
    }

    func testTheEmptyStatesAreTheWebsSentences() throws {
        let page = try source(Self.webPage)
        for sentence in [TaskListCopy.noneReady, TaskListCopy.noneRunning, TaskListCopy.noneInList,
                         TaskListCopy.noneUnlisted, TaskListCopy.noneYet] {
            XCTAssertTrue(page.contains("'\(sentence)'"), "web no longer says: \(sentence)")
        }
        XCTAssertTrue(page.contains("`No tasks match “${query.trim()}”.`"))
        XCTAssertEqual(TaskListCopy.noneMatch("x"), "No tasks match “x”.")
    }

    func testTheBatchTableAndTheBulkBarAreTheWebsWords() throws {
        let page = try source(Self.webPage)
        XCTAssertTrue(page.contains("Showing the {rows.length.toLocaleString()} largest of {labelTotal.toLocaleString()} labels."))
        XCTAssertEqual(TaskListCopy.showingLargest(30, of: 63), "Showing the 30 largest of 63 labels.")
        XCTAssertTrue(page.contains("{selectedRows.length} selected"))
        // A button's text node in JSX: `>` then the label then `</Button>`, whatever the indentation.
        for label in [TaskListCopy.run, TaskListCopy.stop, TaskListCopy.setAssignee, TaskListCopy.delete] {
            let pattern = ">\\s*" + NSRegularExpression.escapedPattern(for: label) + "\\s*</Button>"
            XCTAssertNotNil(page.range(of: pattern, options: .regularExpression), "the bulk bar's \(label)")
        }
    }

    func testTheScheduledStartIsFormattedLikeTheWebs() throws {
        let schedule = try source(Self.webSchedule)
        // month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        XCTAssertTrue(schedule.contains("month: 'short'"))
        XCTAssertTrue(schedule.contains("minute: '2-digit'"))
    }
}

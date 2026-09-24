import Foundation
import XCTest
@testable import OrbitKit

/// The projects index says the same words on both clients, and this is the tripwire that keeps it
/// so: `ProjectAttention.swift` is a port of `src/web/src/lib/projectAttention.ts`, and nothing in
/// either build notices a lane title or a chip re-worded at one end only.
///
/// A missing counterpart is a FAILURE, never an `XCTSkip`: a check that quietly opts out reports
/// green on exactly the day the thing it watches goes missing.
final class ProjectAttentionCopyParityTests: XCTestCase {

    private static let webSource = "src/web/src/lib/projectAttention.ts"

    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webSource).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo
    }

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        var description: String {
            "\(ProjectAttentionCopyParityTests.webSource) was not found above this test file. "
                + "OrbitKit's ProjectAttention is one half of a pair; if the web half moved, move "
                + "this check with it rather than deleting it."
        }
    }

    /// The web source with adjacent string literals joined and wrapped values pulled up, so a
    /// sentence is compared as words rather than as wherever the formatter broke the line.
    private func web() throws -> String {
        let source = try String(contentsOf: try repoRoot().appendingPathComponent(Self.webSource),
                                encoding: .utf8)
        return source
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "([=:])\\s*\\n\\s*(['`])", with: "$1 $2",
                                  options: .regularExpression)
    }

    func testLaneTitlesAndNotesAreTheWebsOwn() throws {
        let web = try web()
        for section in ProjectAttentionSection.allCases {
            XCTAssertTrue(web.contains("key: '\(section.rawValue)',"),
                          "the web no longer has a lane keyed \(section.rawValue)")
            XCTAssertTrue(web.contains("title: '\(section.title)',"),
                          "lane \(section.rawValue): the web no longer titles it \(section.title.debugDescription)")
            XCTAssertTrue(web.contains("note: '\(section.note)',"),
                          "lane \(section.rawValue): the web's note drifted from \(section.note.debugDescription)")
        }
    }

    func testOwnerItemChipsAreTheWebsOwn() throws {
        let web = try web()
        func item(_ kind: OwnerItemKind, _ count: Int) -> ProjectListOwnerItem {
            ProjectListOwnerItem(kind: kind, count: count, oldestWaitingSince: "2026-01-01T00:00:00Z")
        }
        XCTAssertTrue(web.contains(
            "PROMOTION_APPROVAL: () => '\(ProjectAttention.ownerItemSays(item(.promotionApproval, 1))!)',"))
        XCTAssertTrue(web.contains(
            "FUSE_PAUSED: () => '\(ProjectAttention.ownerItemSays(item(.fusePaused, 1))!)',"))

        // Rendered with a sentinel count and put back into the web's template spelling.
        let escalated = ProjectAttention.ownerItemSays(item(.escalated, 23))!
            .replacingOccurrences(of: "23", with: "${item.count}")
        XCTAssertTrue(web.contains("ESCALATED: (item) => `\(escalated)`,"),
                      "the escalated chip drifted from \(escalated.debugDescription)")

        XCTAssertEqual(ProjectAttention.ownerItemSays(item(.coordinatorQuestion, 1)),
                       "Needs you · 1 question from coordinator")
        XCTAssertEqual(ProjectAttention.ownerItemSays(item(.coordinatorQuestion, 2)),
                       "Needs you · 2 questions from coordinator")
        XCTAssertTrue(web.contains(
            "`Needs you · ${item.count} question${item.count === 1 ? '' : 's'} from coordinator`"),
                      "the question chip's template drifted")
    }

    func testCoordinatorAndBlockerWordsAreTheWebsOwn() throws {
        let web = try web()
        let phrases: [(String, String)] = [
            ("INTEGRATION_CONFLICT", "resolving a merge conflict"),
            ("INTEGRATION_CHECK_FAILED", "checks failed"),
            ("INTEGRATION_ERROR", "handling an integration error"),
            ("TASK_FAILED", "handling a failed task"),
        ]
        for (kind, phrase) in phrases {
            XCTAssertTrue(web.contains("\(kind): '\(phrase)',"), "coordinator phrase for \(kind) drifted")
        }
        for literal in ["'Coordinator'", "'Needs you'", "'Auto-remediation'", "'Coordinator-owned'",
                        "CRITICAL: 'Critical'", "WARNING: 'Warning'", "INFO: 'Info'",
                        "settled · still open`", "`Running · no activity ${days}d`",
                        "`Ready · no activity ${days}d`"] {
            XCTAssertTrue(web.contains(literal), "the web no longer says \(literal)")
        }
    }
}

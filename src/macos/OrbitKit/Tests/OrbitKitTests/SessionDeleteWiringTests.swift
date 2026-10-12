import Foundation
import XCTest
@testable import OrbitKit

/// Delete (a move to Trash) answers the tap itself: the row leaves every list it is loaded in and its
/// console closes before the request goes, the toast comes the moment the server has the move rather
/// than after the lists have all been read again, and a refusal brings the row back
/// (docs/mocks/toast-system/04-rules.html). Until the move settles, no read may put the row back —
/// not one that left before the server had it, nor the re-read of a delete just before.
///
/// SwiftUI doesn't exist on Linux, so nothing here compiles the app. Each check reads the part of the
/// source it is about.
final class SessionDeleteWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

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

    private func slice(_ text: String, from start: String, to end: String,
                       file: StaticString = #filePath, line: UInt = #line) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`", file: file, line: line)
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`", file: file, line: line)
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    /// Where each of `needles` first appears in `text`, failing on one that does not.
    private func positions(_ needles: [String], in text: String,
                           file: StaticString = #filePath, line: UInt = #line) throws -> [String.Index] {
        try needles.map { try XCTUnwrap(text.range(of: $0), "no `\($0)`", file: file, line: line).lowerBound }
    }

    /// The row and its console go on the tap, before the request; the toast comes as soon as the
    /// server has the move and the lists are read again behind it, and only then may they show the
    /// session again. A refusal lets them show it at once, says why, and reads them again to put it back.
    func testTheRowLeavesOnTheTapAndTheToastDoesNotWaitForTheReread() throws {
        let app = code(try appSource("AppModel.swift"))
        let delete = try slice(app, from: "func deleteSession(_ id: String) {", to: "\n    }\n")
        let refused = try slice(delete, from: "catch {", to: "return\n")
        let moved = String(delete[try XCTUnwrap(delete.range(of: refused)).upperBound...])

        let tap = try positions(["let name = toastSessionTitle(id)", "hideTrashedSession(id)", "dropIfOpen(id)",
                                 "try await api.deleteSession(id)"], in: delete)
        XCTAssertEqual(tap, tap.sorted(), "the title is read before the row goes, and the row goes before the request")

        let undo = try positions(["revealTrashedSession(id)", "showToast(\"Couldn't move to Trash\"",
                                  "await reloadSessionLists()"], in: refused)
        XCTAssertEqual(undo, undo.sorted(), "a refusal lets the row back before the read that brings it")

        let settled = try positions(["sessionDetails.remove(id)", "showToast(\"Moved to Trash\"",
                                     "await reloadSessionLists()", "revealTrashedSession(id)"], in: moved)
        XCTAssertEqual(settled, settled.sorted(),
                       "the toast doesn't wait for the re-read, and the row stays out until that has landed")
        XCTAssertEqual(delete.components(separatedBy: "dropIfOpen(id)").count - 1, 1,
                       "the console closes once, on the tap")
    }

    /// Hidden from every loaded list at once — the Open snapshot without announcing anything, the
    /// pane's own lists, and on iOS the project page's members, Completed ones included, since a poll
    /// draws those from what its page last read.
    func testHidingTakesTheRowOutOfEveryLoadedList() throws {
        let app = code(try appSource("AppModel.swift"))
        let hide = try slice(app, from: "private func hideTrashedSession(_ id: String) {", to: "\n    }\n")
        for part in ["trashingSessions.insert(id)", "agents?.hideTrashedSession(id)",
                     "applySessionSnapshot(SessionFilter.removing(id, from: sessions), notify: false)",
                     "projectSessions = SessionFilter.removing(id, from: projectSessions)",
                     "projectCompletedSessions = projectCompletedSessions.mapValues { SessionFilter.removing(id, from: $0) }"] {
            XCTAssertTrue(hide.contains(part), "hiding writes `\(part)`")
        }
        let iOS = try slice(hide, from: "#if os(iOS)", to: "#endif")
        XCTAssertTrue(iOS.contains("projectSessions"), "the project page is iOS only")

        let reveal = try slice(app, from: "private func revealTrashedSession(_ id: String) {", to: "\n    }\n")
        for part in ["guard trashingSessions.remove(id) != nil else { return }", "agents?.revealTrashedSession(id)",
                     "openListReader?.invalidate()"] {
            XCTAssertTrue(reveal.contains(part), "revealing does `\(part)`")
        }

        let agents = code(try appSource("AgentsModel.swift"))
        let paneHide = try slice(agents, from: "func hideTrashedSession(_ id: String) {", to: "\n    }\n")
        for part in ["trashing.insert(id)", "agentSessions = SessionFilter.removing(id, from: agentSessions)",
                     "allSessions = SessionFilter.removing(id, from: allSessions)"] {
            XCTAssertTrue(paneHide.contains(part), "the pane's hide writes `\(part)`")
        }
        let paneReveal = try slice(agents, from: "func revealTrashedSession(_ id: String) {", to: "\n    }\n")
        XCTAssertTrue(paneReveal.contains("trashing.remove(id)"))
    }

    /// Every read keeps the rows on their way to Trash out: the Open snapshot as its first act — before
    /// the notification diff and every list derived from it — the pane's own Completed / Trash read,
    /// and both of the project page's member reads.
    func testNoReadPutsARowOnItsWayToTrashBack() throws {
        let app = code(try appSource("AppModel.swift"))
        let apply = try slice(app, from: "private func applySessionSnapshot(_ list: [Session], notify: Bool = true) {",
                              to: "\n    }\n")
        let first = try XCTUnwrap(apply.split(separator: "\n").dropFirst().first)
        XCTAssertTrue(first.trimmingCharacters(in: .whitespaces)
                        .hasPrefix("let list = SessionFilter.removing(trashingSessions, from: list)"),
                      "the snapshot is filtered before anything reads it: `\(first)`")

        let agents = code(try appSource("AgentsModel.swift"))
        let load = try slice(agents, from: "func loadSessions(agentID: String, view: SessionView, reset: Bool = false) async {",
                             to: "\n    }\n")
        let read = try positions(["let read = try await api.listSessions(view: view)",
                                  "let all = SessionFilter.removing(trashing, from: read)", "allSessions = all",
                                  "agentSessions = SessionFilter.forAgent(all, agentID: agentID, view: view)"], in: load)
        XCTAssertEqual(read, read.sorted())

        let project = try slice(app, from: "func loadProjectSessions(_ address: SessionProjectAddress) async {",
                                to: "\n    }\n")
        XCTAssertTrue(project.contains("let kept = SessionFilter.removing(trashingSessions, from: rows)"))
        XCTAssertTrue(project.contains("projectSessions = SessionProjectMembers.members(of: address.projectID, in: kept)"))
        let poll = try slice(app, from: "func pollProjectSessions(_ address: SessionProjectAddress) async {",
                             to: "\n    }\n")
        XCTAssertTrue(poll.contains("let kept = SessionFilter.removing(trashingSessions, from: rows)"))
        XCTAssertTrue(poll.contains("let completed = SessionProjectMembers.members(of: address.projectID, in: kept)"))
    }

    /// Undo can come while the move's own re-read is still out; the restore lets the row back before
    /// its request, so its own re-read shows it.
    func testUndoLetsTheRowBackBeforeTheRestore() throws {
        let app = code(try appSource("AppModel.swift"))
        let restore = try slice(app, from: "func moveSessionToOpen(_ id: String) {", to: "\n    }\n")
        let order = try positions(["revealTrashedSession(id)", "try await api.restoreSession(id)",
                                   "await reloadSessionLists()"], in: restore)
        XCTAssertEqual(order, order.sorted())
    }
}

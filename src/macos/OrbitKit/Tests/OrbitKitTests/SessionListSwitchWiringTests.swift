import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app. These checks hold the Agents
/// pane's session list to the wiring that keeps a switched-away load from writing. Switching the
/// workspace or the Open/Completed/Trash view cancels the view's `.task`, but the fetch that task
/// was awaiting rides a callback-based transport cancellation doesn't reach — its late reply resumes
/// in `AgentsModel.loadSessions` after the switch, holding the OLD (agent, view). Without a currency
/// check that reply overwrites the list its replacement is showing (and, in a quiet account, stays
/// there: the app poll skips unchanged pushes). The guard: only the load still named by
/// `lastSessionQuery` may write — to the list, the spinner, or the error. Each check reads the slice
/// of the file it is about.
final class SessionListSwitchWiringTests: XCTestCase {
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

    /// `loadSessions` derives currency from `lastSessionQuery` (repointed synchronously by the
    /// replacing load, so a cancelled task's late reply fails the check), and every write after an
    /// await is behind it: the Open adoption, the list the fetch lands, the spinner's defer, and
    /// the error text.
    func testALoadSupersededMidFlightWritesNothing() throws {
        let agents = code(try appSource("AgentsModel.swift"))
        let load = try slice(agents, from: "func loadSessions(agentID: String, view: SessionView, reset: Bool = false) async {",
                             to: "\n    }\n")

        let order = try positions(["let isCurrent = { self.lastSessionQuery.map",
                                   "let read = try await api.listSessions(view: view)",
                                   "guard isCurrent() else { return }",
                                   "agentSessions = SessionFilter.forAgent(all, agentID: agentID, view: view)"], in: load)
        XCTAssertEqual(order, order.sorted(),
                       "the currency check exists before the fetch and gates the write after it")

        for part in ["defer { if isCurrent() { sessionsLoading = false } }",
                     "if isCurrent() { adoptOpen(all, agentID: agentID) }",
                     "catch { if isCurrent() { errorText = friendly(error) } }"] {
            XCTAssertTrue(load.contains(part), "a superseded load doesn't touch `\(part)`")
        }
    }
}

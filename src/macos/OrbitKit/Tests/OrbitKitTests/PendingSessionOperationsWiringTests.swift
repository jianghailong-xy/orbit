import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold to the source where a merge or commit result card comes from: the request a console
/// made, followed by `ConsoleRegistry` until the runner answers — not the console's own poll, which
/// stops with its focus. `PendingSessionOperationsTests` covers the bookkeeping itself. Each check
/// reads the slice of the file it's about, so a match somewhere else can't pass it.
final class PendingSessionOperationsWiringTests: XCTestCase {
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

    /// The owner's report, 2026-10-01: on iOS the "Merged into main" card only showed while that
    /// session was open. A request the server took is handed on before the bar reads it back — that
    /// read may already carry the result — and a preview, which only checks again, isn't.
    func testAnAcceptedMergeOrCommitIsHandedOn() throws {
        let model = code(try source("WorktreeModel.swift"))
        for (function, request, handOn) in [("func commit() async {", "api.commit(", "accepted(.commit)"),
                                            ("func merge(target: String?) async {", "api.merge(", "accepted(.merge)")] {
            let body = try slice(model, from: function, to: "\n    }")
            let sent = try XCTUnwrap(body.range(of: request))
            let handed = try XCTUnwrap(body.range(of: handOn), "`\(function)` no longer hands its request on")
            let read = try XCTUnwrap(body.range(of: "await loadDetail()"))
            XCTAssertLessThan(sent.upperBound, handed.lowerBound, "only once the server took it")
            XCTAssertLessThan(handed.upperBound, read.lowerBound, "and before the read that may answer it")
        }
        XCTAssertTrue(try slice(model, from: "func recoverMerge(", to: "\n    }")
            .contains(#"if action != "preview" { accepted(.merge) }"#))
    }

    /// A read already in flight when a request is accepted can carry the status from before it — none
    /// at all on a first merge, which would settle the request as superseded and lose its card.
    func testOnlyAReadStartedAfterTheRequestAnswersIt() throws {
        let model = code(try source("WorktreeModel.swift"))
        let load = try slice(model, from: "func loadDetail() async {", to: "\n    }")
        let stamp = try XCTUnwrap(load.range(of: "let acceptedBefore = acceptedCount"))
        let read = try XCTUnwrap(load.range(of: "try await api.sessionDetail(sessionID)"))
        XCTAssertLessThan(stamp.upperBound, read.lowerBound)
        XCTAssertTrue(load.contains("if acceptedBefore == acceptedCount { onDetail(next) }"))
        XCTAssertTrue(try slice(model, from: "private func accepted(", to: "\n    }").contains("acceptedCount += 1"))
    }

    /// The bar's poll stops with the console's focus, so a result card raised from it was missed
    /// when the user left the session, or shown late on coming back. It raises none now.
    func testTheConsolesPollRaisesNoResultCard() throws {
        let retry = try slice(code(try source("WorktreeModel.swift")),
                              from: "private func surfaceRetry(", to: "static func resultCard(")
        for card in ["Merged into", "Merge conflict in", "Merge into", "recovery.title",
                     "Commit failed", "Changes committed", "No changes to commit"] {
            XCTAssertFalse(retry.contains(card), "`\(card)` is the followed request's card, not the poll's")
        }
    }

    /// Every live console hands its requests and reads to the registry, which polls until each one
    /// settles and sends its card down the sink every session result takes — so it lands wherever
    /// the user is. Focus doesn't stop it; sign-out does.
    func testTheRegistryFollowsEachRequestToItsCard() throws {
        let registry = code(try source("ConsoleRegistry.swift"))
        let make = try slice(registry, from: "private func makeModel(", to: "return model")
        XCTAssertTrue(make.contains(
            "model.worktree.onAccepted = { [weak self] kind in self?.follow(kind, in: sessionID) }"))
        XCTAssertTrue(make.contains("self.pendingOperations.settle(sessionID: sessionID, with: detail)"))

        let poll = try slice(registry, from: "private func pollOperations() async {", to: "\n    }")
        XCTAssertTrue(poll.contains("try await api.sessionDetail(operation.sessionID)"))
        XCTAssertTrue(poll.contains("pendingOperations.settle(operation, with: detail)"))
        XCTAssertTrue(poll.contains("await models[settled.sessionID]?.worktree.loadDetail()"),
                      "an answer the registry reads first reaches the bar on screen too, not a poll later")
        let report = try slice(registry, from: "private func report(", to: "\n    }")
        XCTAssertTrue(report.contains("WorktreeModel.resultCard(of: operation.kind, in: detail)"))
        XCTAssertTrue(report.contains("onToast(card, operation.sessionID)"))

        XCTAssertFalse(try slice(registry, from: "func focus(", to: "\n    }").contains("operationsPoll"))
        XCTAssertTrue(try slice(registry, from: "func reset() {", to: "\n    }").contains("operationsPoll?.cancel()"))

        let app = code(try source("AppModel.swift"))
        XCTAssertTrue(try slice(app, from: "consoleRegistry?.onToast = {", to: "\n        }")
            .contains("self?.showToast(request.message, sessionID: sessionID,"),
                      "and that sink is the app's one toast host")
    }
}

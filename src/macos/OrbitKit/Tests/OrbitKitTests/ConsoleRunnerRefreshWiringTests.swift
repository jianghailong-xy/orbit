import Foundation
import XCTest

/// The console's runner row — the model menu's names, the plan-usage gauge, the `/` catalogue — is
/// one GET /runners read. It used to be made once, when the console opened, and a failure there
/// left all three degraded until the console was opened again. `ConsoleModel.swift` compiles only
/// in the macOS and iOS jobs, so the wires that undo that are asserted over its source: the opening
/// read is retried, every reconnect reads the row again, and so does a streaming console once a
/// minute.
final class ConsoleRunnerRefreshWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    private func console() throws -> String {
        let relative = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"
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

    /// From `start` up to the next `end`, its code lines only (trimmed, joined by spaces): a call
    /// commented out still contains its own words.
    private func code(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return text[lower.lowerBound..<upper.lowerBound]
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") }
            .joined(separator: " ")
    }

    func testTheReadsAConsoleMakesWhenItOpensAreRetried() throws {
        let source = try console()
        let fetch = try code(source, from: "private func fetchRunners() async -> [Runner]? {",
                             to: "private func refreshRunner() async {")
        XCTAssertTrue(fetch.contains("for attempt in 0..<3 {"), "the read is tried more than once")
        XCTAssertTrue(fetch.contains("if let rows = try? await api.runners() { return rows }"),
                      "and stops at the first answer")

        let session = try code(source, from: "private func loadContext() async {",
                               to: "applySlashItems(from: sessionRunner)")
        XCTAssertTrue(session.contains("if let rows = await fetchRunners() {"),
                      "a session's console reads its runner through the retry")
        XCTAssertFalse(session.contains("api.runners()"), "and makes no read of its own beside it")

        let draft = try code(source, from: "func prepareDraft() async {",
                             to: "applySlashItems(from: agentRunner)")
        XCTAssertTrue(draft.contains("if let rows = await fetchRunners() {"),
                      "a draft reads its workspace's runner through the retry")
        XCTAssertFalse(draft.contains("api.runners()"), "and makes no read of its own beside it")
    }

    func testEveryReconnectReadsTheRunnerRowAgain() throws {
        let source = try console()
        let reconnect = try code(source, from: "if isReconnect {", to: "isReconnect = true")
        XCTAssertTrue(reconnect.contains("Task { [weak self] in await self?.refreshRunner() }"),
                      "foregrounding, a network coming back and a dropped stream all re-read the row")

        let refresh = try code(source, from: "private func refreshRunner() async {",
                               to: "private func loadContext() async {")
        XCTAssertTrue(refresh.contains(
            "guard let rows = try? await api.runners() else { clearCodexResetAdmission() return }"),
                      "a failed re-read keeps what is on screen, and only the reset admission fails closed")
        XCTAssertTrue(refresh.contains(
            "if let runner { adoptRunnerSnapshot(runner) } else { clearRunnerSnapshot() }"),
                      "an answer is adopted the way the opening read adopts it")
        XCTAssertTrue(refresh.contains("applySlashItems(from: runner)"),
                      "the `/` catalogue comes back with it")
    }

    func testAStreamingConsoleReadsTheRunnerRowEveryMinute() throws {
        let source = try console()
        let start = try code(source, from: "func startStreaming() {", to: "func stopStreaming() {")
        XCTAssertTrue(start.contains("runnerPollTask = Task { [weak self] in"),
                      "the minute re-read starts with the stream")
        XCTAssertTrue(start.contains("try? await Task.sleep(nanoseconds: 60_000_000_000)"),
                      "once a minute, as web's `refetchInterval` on the console's runners query")
        XCTAssertTrue(start.contains(
            "guard let self, !Task.isCancelled else { return } await self.refreshRunner()"),
                      "and it reads the row the way a reconnect does")
        let stop = try code(source, from: "func stopStreaming() {", to: "func run() async {")
        XCTAssertTrue(stop.contains("runnerPollTask?.cancel()"), "it stops with the stream")
    }
}

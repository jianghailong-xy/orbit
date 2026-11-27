import Foundation
import XCTest

/// A window the stream cannot resume (`resync`, or a catch-up out of budget) is kept under a reader
/// who scrolled up, its bottom a gap at the last seq, and re-seeded from a tail page only at the tail
/// (web efa1ae09cd, `replaceWindow`). `ConsoleModel.swift` and `ConsoleView.swift` compile only in the
/// macOS and iOS jobs, so the console's wires are asserted over their source; the rule they call is tested in
/// `TranscriptWindowReplacementTests`.
final class TranscriptWindowReplacementWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let what: String
        var description: String {
            "\(what) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(what: relative)
    }

    private func app(_ file: String) throws -> String {
        try source("src/macos/OrbitApp/Sources/OrbitApp/" + file)
    }

    /// From `start` up to the next `end`, its code lines only (trimmed, joined by spaces): a call
    /// commented out still contains its own words.
    private func code(_ text: String, from start: String, to end: String) throws -> String {
        guard let lower = text.range(of: start),
              let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else {
            throw SourceMissing(what: "`\(start)` … `\(end)`")
        }
        return text[lower.lowerBound..<upper.lowerBound]
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") }
            .joined(separator: " ")
    }


    func testAResyncAndAnExhaustedCatchUpReplaceTheWindowByWhereTheReaderIs() throws {
        let console = try app("ConsoleModel.swift")
        let loop = try code(console, from: "func run() async {", to: "private func seedTailPage() async {")
        XCTAssertTrue(loop.contains("if outcome == .resync { await replaceWindow() }"),
                      "a resync asks whether to keep the window, rather than re-seeding under the reader")
        let catchUp = try code(console, from: "private func catchUpToTail(",
                               to: "private func replaceWindow() async {")
        XCTAssertTrue(catchUp.hasSuffix("await replaceWindow() }"),
                      "a catch-up out of budget goes the same way as a resync")

        let replace = try code(console, from: "private func replaceWindow() async {",
                               to: "func reconnectNow()")
        XCTAssertTrue(replace.contains("if let gap = reducer.replaceWindow(readerAtTail: !readingHistory) {"),
                      "the reader's place decides it: scrolled up keeps the window")
        XCTAssertTrue(replace.contains("newerCursor = gap"),
                      "kept, its bottom is a gap at the last seq: the window is detached, as one opened at a record")
        XCTAssertTrue(replace.contains("await seedTailPage()"), "at the tail it is re-seeded from a tail page")
        XCTAssertFalse(replace.contains("resetForResync()"), "only the reducer's rule drops the window")
        XCTAssertFalse(console.contains("reseedFromTailPage"), "no path re-seeds without asking")
    }

    /// A reopened window reads its gap in one page before the stream opens (web 4e53172f02, `catchUp`);
    /// a dropped stream still pages through what it missed. Whatever the read did — landed, replaced the
    /// window, or failed and left it — the stream resumes from the window's own max seq, so a failed read
    /// falls back to replaying the gap from the kept seq. The read's own rule is driven in
    /// OrbitAppTests' `ReopenCatchUpTests`.
    func testAReopenReadsItsGapOnceBeforeTheStreamResumesFromTheWindow() throws {
        let console = try app("ConsoleModel.swift")
        let loop = try code(console, from: "func run() async {", to: "private func seedTailPage() async {")
        XCTAssertTrue(loop.contains("var catchUpPending = !coldOpen"), "a restored window is the reopen")
        XCTAssertTrue(loop.contains("if catchUpPending { await catchUpOnReopen() } else if catchUpAfterFailure { await catchUpToTail() }"),
                      "the reopen reads one page; only a failed attempt pages through its gap")
        let reopen = try XCTUnwrap(loop.range(of: "await catchUpOnReopen()"))
        let connect = try XCTUnwrap(loop.range(of: "stream.events(sessionID: sessionID, sinceSeq: reducer.state.maxSeq)",
                                               range: reopen.upperBound..<loop.endIndex),
                                    "the stream opens after the read, from the window's max seq")
        XCTAssertLessThan(reopen.lowerBound, connect.lowerBound)

        let read = try code(console, from: "func catchUpOnReopen() async {", to: "private func catchUpToTail(")
        XCTAssertTrue(read.contains("guard let page = try? await api.eventPageAfter(sessionID: sessionID, after: reducer.state.maxSeq, limit: Self.tailPage, timeout: Self.pageTimeout) else { return }"),
                      "one page after the kept max seq; a failed read returns with the window untouched")
        XCTAssertTrue(read.contains("if page.after != nil, !readingHistory { await replaceWindow() return }"),
                      "wider than a page at the tail: replaced from a tail page, not paged through")
        XCTAssertFalse(read.contains("for "), "the reopen itself never loops over pages")
    }

    func testAKeptWindowHoldsTheStreamOffUntilTheReaderReachesTheLatest() throws {
        let console = try app("ConsoleModel.swift")
        let loop = try code(console, from: "func run() async {", to: "private func seedTailPage() async {")
        let catchUp = try XCTUnwrap(loop.range(of: "await catchUpToTail()"))
        let held = try XCTUnwrap(loop.range(of: "if detached { continue }", range: catchUp.upperBound..<loop.endIndex),
                                 "a window the catch-up kept does not open the stream")
        let connect = try XCTUnwrap(loop.range(of: "stream.events(sessionID: sessionID", range: catchUp.upperBound..<loop.endIndex))
        XCTAssertLessThan(held.lowerBound, connect.lowerBound, "checked before the connect")
        XCTAssertTrue(loop.contains("if detached { try? await Task.sleep(nanoseconds: 200_000_000) continue }"),
                      "the loop holds off while the window is detached, as for a record")

        let view = try app("Views/Console/ConsoleView.swift")
        XCTAssertTrue(view.contains("console.setReadingHistory(!pinned)"), "the transcript says where the reader is")
        XCTAssertTrue(view.contains(".onAppear { Task { await console.loadNewer() } }"),
                      "scrolling down a detached window pages forward")
        let jump = try code(view, from: "private func jumpToLatest(_ proxy: ScrollViewProxy) {", to: "#if os(iOS)")
        XCTAssertTrue(jump.contains("if console.detached {"))
        XCTAssertTrue(jump.contains("Task { await console.jumpToLatest() }"), "and the jump control takes a tail page")
    }
}

import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold the needs-you bar to the board the owner picked on 2026-10-21
/// (`docs/mocks/needs-you-capsule`, A): a glass capsule under the nav bar, not an amber band — the
/// amber in one 30pt circle whose mark says which kind is waiting, two lines (what, where) and how
/// long, no chevron when the press goes elsewhere, and on iOS 26 floating over the transcript as the
/// composer band does. Each check reads the slice of the file it is about.
final class NeedsYouCapsuleWiringTests: XCTestCase {
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

    private var banner: String {
        get throws { code(try source("Views/NeedsYouBannerView.swift")) }
    }

    /// The capsule is the nav bar's own glass on iOS 26, and the band it replaced is gone: no amber
    /// wash, no bar material behind the line, no dot.
    func testTheBarIsAGlassCapsuleNotABand() throws {
        let view = try banner
        let surface = try slice(view, from: "func needsYouCapsule()", to: "\n    }")
        XCTAssertTrue(surface.contains("glassEffect(.regular.interactive(), in: .capsule)"))
        XCTAssertTrue(view.contains(".frame(minHeight: 44)"), "the height of the nav bar's controls")
        XCTAssertFalse(view.contains("needsYouTint"), "the amber wash is gone")
        XCTAssertFalse(view.contains(".background(.bar)"), "and the band material with it")
        XCTAssertFalse(view.contains("Circle()\n                    .fill(.orange)"), "the 7pt dot is the circle now")
    }

    /// The amber is the Landing head's circle and nothing else — the words stay primary/secondary.
    func testTheAmberIsTheCircleAlone() throws {
        let view = try banner
        XCTAssertTrue(view.contains(".frame(width: 30, height: 30)"))
        XCTAssertTrue(view.contains(".background(Color.orange.opacity(0.15), in: Circle())"),
                      "`ProjectLandingRow.mark`'s own recipe")
        let lines = try slice(view, from: "VStack(alignment: .leading, spacing: 0) {", to: "if let chevron {")
        XCTAssertFalse(lines.contains(".orange"), "never amber words")
    }

    /// One mark per kind, so the four read apart at a glance; the hand for a blocked tool call.
    func testEachKindHasItsOwnMark() throws {
        let symbols = try slice(try banner, from: "var symbol: String {", to: "\n    }")
        for (glyph, symbol) in [("merge", "arrow.triangle.merge"), ("question", "questionmark.bubble.fill"),
                                ("warning", "exclamationmark.triangle.fill"), ("pause", "pause.fill"),
                                ("hand", "hand.raised.fill")] {
            XCTAssertTrue(symbols.contains("case .\(glyph): return \"\(symbol)\""), "\(glyph) → \(symbol)")
        }
    }

    /// Two lines and the wait: the first line the banner's words, the second its `detail`, the age
    /// from its `since`, "+N" for the others behind it.
    func testTheBarSaysWhatWhereAndHowLong() throws {
        let view = try banner
        XCTAssertTrue(view.contains("bar(text: banner.text, detail: banner.detail, since: banner.since, more: banner.more,"))
        XCTAssertTrue(view.contains("if let since { NeedsYouAge(since: since) }"))
        XCTAssertTrue(view.contains("RelativeTime.elapsed(since, now: context.date)"),
                      "a duration still running, kept current")
        XCTAssertTrue(view.contains("Text(\"+\\(more)\")"))
    }

    /// Where the press goes elsewhere the capsule carries no chevron — the whole of it is the press;
    /// in the conversation on screen the chevron stays, pointing the way the card lies.
    func testOnlyTheInConversationBarPoints() throws {
        let view = try banner
        XCTAssertTrue(view.contains("glyph: banner.glyph, chevron: nil,"))
        XCTAssertTrue(view.contains(#"chevron: below.side == .above ? "chevron.up" : "chevron.down""#))
    }

    /// On iOS 26 a conversation's bar is a safe-area BAR, so the transcript's scroll-edge effect
    /// runs on under the capsule as it does under the composer band; the capsule then stands on
    /// nothing. Everywhere else — the session list, an older system — it stands on the page's colour.
    func testItFloatsOverTheTranscriptOnIOS26() throws {
        let console = code(try source("Views/Console/ConsoleView.swift"))
        let top = try slice(console, from: "func needsYouTop<Bar: View>(", to: "\n    }\n")
        XCTAssertTrue(top.contains("safeAreaBar(edge: .top, spacing: 0) { content.environment(\\.floatsOverTranscript, true) }"))
        XCTAssertTrue(top.contains("safeAreaInset(edge: .top, spacing: 0, content: bar)"))
        XCTAssertTrue(console.contains(".needsYouTop {\n            if hSize == .compact {"))
        XCTAssertTrue(try banner.contains(".background(floats ? Color.clear : Color(uiColor: .systemBackground))"))
    }
}

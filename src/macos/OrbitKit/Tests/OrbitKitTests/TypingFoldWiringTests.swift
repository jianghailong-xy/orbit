import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold the phone's typing fold to the source instead (`docs/mocks/typing-focus-ios.html`, ②):
/// while the composer holds the keyboard, the band's cards, the bars under the nav bar and the nav bar
/// itself give the transcript their room, on a compact width only, and all of them come back when the
/// keyboard goes. Each check reads the slice of the file it's about, so a match somewhere else can't
/// pass it.
final class TypingFoldWiringTests: XCTestCase {
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

    private var console: String {
        get throws { code(try source("Views/Console/ConsoleView.swift")) }
    }

    /// One decision, made in one place: a compact width, while the composer holds the keyboard.
    /// The wide shells — iPad's split, the Mac — never fold.
    func testTheFoldIsACompactWidthWhileTheComposerHoldsTheKeyboard() throws {
        let decision = try slice(try console, from: "private func foldsChrome(", to: "\n    }")
        let phone = try slice(decision, from: "#if os(iOS)", to: "#else")
        XCTAssertTrue(phone.contains("hSize == .compact"))
        XCTAssertTrue(phone.contains("console?.composerEditing == true"))
        let mac = try slice(decision, from: "#else", to: "#endif")
        XCTAssertTrue(mac.contains("false"))
    }

    /// The session's cards fold; the one-off cards above them — the error line, the handover and the
    /// run-conflict question — are about the message being sent, so they stay in sight.
    func testTheSessionsCardsFoldAndTheOneOffCardsStay() throws {
        let band = try slice(try console, from: "ComposerBand {", to: "ComposerView(console: console)")
        let folded = try slice(band, from: "VStack(spacing: 0) {",
                               to: ".modifier(TypingFold(folded: foldsChrome(console)))")
        for card in ["WatchingCardStack(sessionID: console.sessionID)",
                     "BackgroundTrayView(procs: console.state.background",
                     "CreatedTasksCard(console: console)",
                     "WorktreeBar(console: console)"] {
            XCTAssertTrue(folded.contains(card), "\(card) folds with the band's other cards")
        }
        for card in ["console.statusMessage", "TaskRunHandedOverCard(", "TaskRunHandoffCard("] {
            XCTAssertFalse(folded.contains(card), "\(card) is about the send and stays")
            XCTAssertTrue(band.contains(card))
        }
    }

    /// Folded, not removed: an `if` would rebuild the cards when the keyboard goes — an open list
    /// shut, the branch bar's sheet host gone, a "View tasks ›" press made meanwhile lost.
    func testTheCardsAreFoldedNotRemoved() throws {
        let fold = try slice(try console, from: "private struct TypingFold: ViewModifier {", to: "\n}\n")
        XCTAssertTrue(fold.contains(".frame(height: folded ? 0 : nil, alignment: .top)"))
        XCTAssertTrue(fold.contains(".allowsHitTesting(!folded)"))
        XCTAssertTrue(fold.contains(".accessibilityHidden(folded)"))
        XCTAssertFalse(fold.contains("if folded"), "a branch on the flag swaps the cards' identity")
    }

    /// The nav bar, the needs-you bar and the sticky question go with the cards, read off the same
    /// decision — and something stands behind the status bar in the nav bar's place.
    func testTheBarsAboveFoldOnTheSameDecision() throws {
        let view = try console
        XCTAssertTrue(view.contains(
            ".toolbar(foldsChrome(registry.peek(sessionID)) ? .hidden : .automatic, for: .navigationBar)"))

        let inset = try slice(view, from: ".safeAreaInset(edge: .top, spacing: 0) {\n            if hSize == .compact {",
                              to: "NeedsYouBannerView(")
        XCTAssertTrue(inset.contains("if foldsChrome(console) {"))
        XCTAssertTrue(inset.contains(".background(.bar, ignoresSafeAreaEdges: .top)"),
                      "without the nav bar's backdrop the transcript scrolls under the clock")

        XCTAssertTrue(view.contains("TranscriptView(console: console, hidesStickyQuestion: foldsChrome(console))"))
        XCTAssertTrue(view.contains("if #available(iOS 18, macOS 15, *), !hidesStickyQuestion, let q = stuckBubble {"))
    }

    /// The flag is the editor's own focus, not a copy of it: the field binds to the console's
    /// `composerEditing`, so a console left while typing cannot come back folded.
    func testTheComposersEditorBindsTheConsolesFlag() throws {
        let composer = code(try source("Views/ComposerView.swift"))
        XCTAssertTrue(composer.contains("isEditing: $console.composerEditing.animation(Self.editingChange)"))
        XCTAssertFalse(composer.contains("private var iosEditing"), "one flag, on the console")
        let model = code(try source("ConsoleModel.swift"))
        XCTAssertTrue(model.contains("var composerEditing = false"))
    }
}

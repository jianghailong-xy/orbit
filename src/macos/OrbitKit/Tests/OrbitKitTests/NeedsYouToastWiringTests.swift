import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold the needs-you notice to the owner's 2026-11-15 board `docs/mocks/needs-you-capsule/12-once`:
/// a conversation that starts waiting on you is noticed once, as a toast in the toast host's column,
/// naming which conversation and what — never a resident "N sessions need you" bar — and what waits
/// in the conversation on screen is its nav bar capsule's to say (07-console-one-capsule). Each check
/// reads the slice of the file it is about.
final class NeedsYouToastWiringTests: XCTestCase {
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

    /// Noticed once: each wait not seen at the last look becomes one notice, the first look after
    /// launch or a return to the foreground only takes stock, and a notice whose conversation stopped
    /// waiting goes.
    func testAWaitIsNoticedOnceFromTheSnapshot() throws {
        let model = code(try source("AppModel.swift"))
        XCTAssertTrue(model.contains("private(set) var needsYouSessions: [Session] = [] { didSet { noticeNewlyWaiting() } }"))
        let notice = try slice(model, from: "private func noticeNewlyWaiting() {", to: "\n    }\n")
        XCTAssertTrue(notice.contains("guard let seen = needsYouSeen else { return }"), "the first look only takes stock")
        XCTAssertTrue(notice.contains("NeedsYouLogic.newlyWaiting(needsYouSessions, seen: seen, excluding: focusedConsoleSessionID)"))
        // A conversation's notice goes when it stops waiting; a terminal's is the other look's to
        // clear (`noticeNewlyWaitingTerminals`, in `TerminalsTests`).
        XCTAssertTrue(notice.contains("needsYouToasts.removeAll { $0.terminal == nil && !keys.contains($0.id) }"))
        XCTAssertTrue(model.contains("func retakeNeedsYouStock() {\n        needsYouSeen = nil\n        terminalsSeen = nil\n    }"))
        let app = try String(contentsOf: repoFile("src/ios/Sources/OrbitiOSApp.swift"), encoding: .utf8)
        XCTAssertTrue(app.contains("model.retakeNeedsYouStock()"), "a return to the foreground is not news")
        XCTAssertTrue(model.contains("static let needsYouToastLimit = 3"))
        XCTAssertTrue(model.contains("static let needsYouToastSeconds: TimeInterval = 6"))
        XCTAssertFalse(model.contains("needsYouBanner("), "no resident summary")
    }

    /// Drawn by the toast host, first in its column, in the commit toast's glass; a press opens the
    /// conversation at its card; felt once as it comes.
    func testTheToastHostDrawsTheNotices() throws {
        let host = code(try source("Views/ToastHost.swift"))
        let column = try slice(host, from: "VStack(alignment: wide ? .trailing : .center, spacing: 8) {", to: "pinned\n")
        XCTAssertTrue(column.contains("ForEach(model.needsYouToasts) { notice in"), "first in the column")
        XCTAssertTrue(column.contains("NeedsYouToastMore(count: model.needsYouToastsMore)"))
        XCTAssertTrue(host.contains(".sensoryFeedback(.warning, trigger: model.needsYouToasts.count) { old, new in new > old }"))
        let card = code(try source("Views/NeedsYouToast.swift"))
        XCTAssertTrue(card.contains("model.openNeedsYouToast(notice, projectInColumn: projectInColumn)"))
        XCTAssertTrue(card.contains("glassEffect(.regular, in: shape)"), "the toast's glass, nothing laid around it")
        XCTAssertTrue(card.contains("model.dismissNeedsYouToast(notice.id)"), "a flick up sends it away")
    }

    /// Nothing resident is left: no page mounts a bar, and the hamburger carries the count.
    func testNoPageMountsABarAndTheHamburgerCounts() throws {
        for file in ["Views/AgentsView.swift", "Views/Console/ConsoleView.swift", "Views/CompactShell.swift",
                     "Views/MainView.swift"] {
            XCTAssertFalse(code(try source(file)).contains("NeedsYouBannerView"), file)
            XCTAssertFalse(code(try source(file)).contains("needsYouOverPage"), file)
        }
        let shell = code(try source("Views/CompactShell.swift"))
        let toggle = try slice(shell, from: "private struct DrawerToggleButton: View {", to: "\n}\n")
        XCTAssertTrue(toggle.contains("let waiting = model.needsYouSessions.count"))
    }

    /// What waits in the conversation on screen is said by the nav bar's capsule (07-console-one-capsule),
    /// which points the way its card lies, while its card is out of sight.
    func testTheConversationsOwnCapsulePoints() throws {
        let console = code(try source("Views/Console/ConsoleView.swift"))
        let capsule = try slice(console, from: "private func waitingCapsule(_ here: WaitingBelow) -> some View {",
                                to: ".accessibilityHint(")
        XCTAssertTrue(capsule.contains(#"here.side == .above ? "chevron.up" : "chevron.down""#))
        XCTAssertTrue(capsule.contains("console.requestScroll(to: here.rowID)"))
        let principal = try slice(console, from: "ToolbarItem(placement: .principal) {", to: "principalQuestion(proxy)")
        XCTAssertTrue(principal.contains("let here = hidesStickyQuestion ? nil : console.waitingBelow"))
        XCTAssertTrue(principal.contains("$0.side == .above || !atBottom || console.detached"),
                      "said while its card is out of sight")
        XCTAssertTrue(principal.contains(".transition(reduceMotion ? .opacity : .push(from: .bottom))"),
                      "one capsule changing, not two swapped (08-motion)")
        let model = code(try source("ConsoleModel.swift"))
        XCTAssertTrue(model.contains("NeedsYouLogic.here(rows: rows, approvalIDs: state.pendingApprovals.map(\\.id),"),
                      "its own approvals too")
    }

    private func repoFile(_ relative: String) throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }
}

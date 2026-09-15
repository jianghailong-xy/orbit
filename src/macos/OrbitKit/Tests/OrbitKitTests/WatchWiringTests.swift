import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell. These hold the wiring the
/// screenshot scenario depends on to the source instead: a session waiting on a watch shows the native
/// Watching card, above — never in place of — the Background processes tray; its header, row and glyph
/// are handed the watch; Following is a section with a list and a detail on every shell; a watch route
/// opens it, and control events nudge the list. Each check reads the slice of the file it's about, so
/// a match somewhere else can't pass it.
final class WatchWiringTests: XCTestCase {
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

    func testTheConsoleShowsTheWatchingCardAboveTheBackgroundTray() throws {
        let band = try slice(source("Views/Console/ConsoleView.swift"),
                             from: "ComposerBand {", to: "ComposerView(console: console)")
        let card = try XCTUnwrap(band.range(of: "WatchingCardStack(sessionID: console.sessionID)"))
        let tray = try XCTUnwrap(band.range(of: "BackgroundTrayView(procs: console.state.background)"))
        XCTAssertLessThan(card.lowerBound, tray.lowerBound)
    }

    func testTheWatchingCardSpeaksForTheWatchNotForAProcess() throws {
        let card = code(try source("Views/WatchingCard.swift"))
        // The strip is read-only: no control comes from the state machine here, and the one action
        // it offers is the way to the Following page, where Pause and Stop live.
        XCTAssertFalse(card.contains("WatchStateMachine.controls"),
                       "the strip took back View/Edit/Pause/Stop — controls belong to the detail page")
        XCTAssertTrue(card.contains("model.selectedSection = .following"),
                      "the strip's only action is the way to the Following page")
        // The one line the strip is by default: the fixed label, the lone target by name or the
        // targets by count, and the soonest deadline (`WatchProjection.stripLabel` et al, held to
        // the browser's `STRIP_*` declarations by `WatchStripCopyParityTests`).
        XCTAssertTrue(card.contains("WatchProjection.stripLabel"))
        XCTAssertTrue(card.contains("WatchProjection.targetTitle(kind:"))
        XCTAssertTrue(card.contains("summary.lineTime(now: now)"))
        // Opened, each watch reads as the browser's rows, in the browser's order.
        XCTAssertTrue(card.contains("WatchRowLabel.until"))
        XCTAssertTrue(card.contains("WatchProjection.checked(for: watch, now: now)"))
        XCTAssertTrue(card.contains("WatchProjection.stripThen"))
        XCTAssertTrue(card.contains("WatchProjection.expiresIn(for: watch, now: now)"))
        for borrowed in ["BackgroundTrayView", "bgRunningLabel", "Background process", "\"terminal\""] {
            XCTAssertFalse(card.contains(borrowed), "the Watching card borrows \(borrowed)")
        }
    }

    func testTheHeaderRowAndGlyphAreHandedTheWatch() throws {
        let subtitleCalls = code(try source("Views/Console/ConsoleView.swift"))
            .components(separatedBy: "SessionHeader.subtitle(for:").dropFirst()
        XCTAssertEqual(subtitleCalls.count, 2, "the iOS nav title and the macOS status bar")
        for call in subtitleCalls {
            XCTAssertTrue(call.prefix(120).contains("watching:"), String(call.prefix(120)))
        }
        let row = try slice(source("Views/AgentsView.swift"),
                            from: "struct AgentSessionRow: View {", to: "private func lineColor(")
        XCTAssertTrue(row.contains("SessionLine.make(for: session, live: !deleted, watching: watching)"))
        XCTAssertTrue(row.contains("StatusGlyphView(glyph: .make(for: session, watching: watching))"))
        XCTAssertFalse(code(row).contains("SessionHeader.statusWord(for: session))"),
                       "every status word the row speaks is handed the watch")
    }

    func testFollowingIsASectionWithAListAndADetailOnEveryShell() throws {
        let main = try source("Views/MainView.swift")
        let content = try slice(main, from: "struct SectionContent: View {", to: "struct SectionDetail: View {")
        XCTAssertTrue(content.contains("case .following:\n            FollowingListView()"))
        let detail = try slice(main, from: "struct SectionDetail: View {", to: "struct ComingSoon: View {")
        XCTAssertTrue(detail.contains("case .following:\n            WatchDetailView()"))
        let compact = try slice(source("Views/CompactShell.swift"), from: "case .following:", to: "case .skills:")
        XCTAssertTrue(compact.contains("FollowingListView()"))
        XCTAssertTrue(compact.contains("WatchDetailView()"))
    }

    func testAWatchRouteOpensTheWatchAndEventsNudgeTheList() throws {
        let app = try source("AppModel.swift")
        let route = try slice(app, from: "func route(to route: Route) {", to: "private func openSession(")
        XCTAssertTrue(route.contains("case .watch(let id):"))
        XCTAssertTrue(route.contains("selectedWatchID"))
        let apply = try slice(app, from: "private func apply(_ ev: ControlEvent) {", to: "private func mergeSessionSummary(")
        XCTAssertTrue(apply.contains("watches?.nudge()"))
        let configure = try slice(app, from: "private func configure(_ url: URL) {", to: "// MARK: settings")
        XCTAssertTrue(configure.contains("watchesModel.onMatched"))
        XCTAssertTrue(configure.contains("Notifications.content(for: event)"))
    }
}

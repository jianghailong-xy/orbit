import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold a phone's folded composer band to the source (the owner, 2026-10-16): while the reader
/// goes back through the history, the parking strip and the composer fold to one small centred pill,
/// as Safari's address bar does (2026-11-11); a tap opens them where the reader is, the jump to the
/// latest waits for the band to open, and coming back to the tail opens them again. When the band folds is `TailPinning.foldsBand`'s, proved in `TailPinningTests`; the
/// bar's words are `FoldedBand`'s, in `FoldedBandTests`. Each check reads the slice it is about.
final class ComposerBandFoldWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "OrbitApp/Sources/OrbitApp/\(path) wasn't found above this test. If it moved, point this check "
                + "at its new home — don't delete the check."
        }
    }

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

    private var bar: String {
        get throws { code(try source("Views/Console/FoldedBandBar.swift")) }
    }

    /// One decision: a phone on iOS 26, where the band floats over the transcript, with the reader
    /// back in the history and the keyboard down — and the bar not just tapped open. The wide shells
    /// and the Mac never fold.
    func testTheBandFoldsOnAPhoneReadingBackWithTheKeyboardDown() throws {
        let decision = try slice(try console, from: "private func foldsBand(", to: "\n    }")
        let phone = try slice(decision, from: "#if os(iOS)", to: "#else")
        for part in ["#available(iOS 26.0, *)", "hSize == .compact", "!console.composerEditing",
                     "!bandOpened", "readingBack || console.detached"] {
            XCTAssertTrue(phone.contains(part), "the fold needs \(part)")
        }
        XCTAssertTrue(try slice(decision, from: "#else", to: "#endif").contains("false"))
    }

    /// The reading is the tracker's, off the very sample the pin is decided on, with the folded band's
    /// inset — its pill and its foot off the screen's edge — handed to the tested rule.
    func testTheTrackerAsksTailPinningWhetherTheReaderIsBackFarEnough() throws {
        let tracker = try slice(try console, from: "private struct ScrollTracker", to: "private struct AnchorRow: ViewModifier {")
        XCTAssertTrue(tracker.contains("TailPinning.foldsBand(pinned: pinned, sample: now"),
                      "the fold is asked of the rule, with the pin this same reading decided")
        XCTAssertTrue(tracker.contains("CGFloat.foldedBandPill + .foldedBandPillFoot"),
                      "the folded band keeps its pill and its foot over the list, off the screen's edge")
    }

    /// Folded, not removed: the band stays in the tree behind its bar, so an open list, the branch
    /// bar's sheet host and the composer's field keep their state. And it is never cut to its frame —
    /// glass cut there loses its rim and shadow.
    func testTheBandFoldsBehindItsBarAndIsNotRemoved() throws {
        let band = try slice(try console, from: "private func composerBand(", to: "private func bandMembers(")
        XCTAssertTrue(band.contains(".modifier(ComposerBandFold(folded: folded))"))
        XCTAssertTrue(band.contains("ZStack(alignment: .bottom)"), "the bar takes the band's place, at its foot")
        XCTAssertFalse(band.contains("if folded {\n            bandMembers"), "a branch on the flag swaps the band's identity")
        let fold = try slice(try bar, from: "struct ComposerBandFold: ViewModifier {", to: "\n}\n")
        XCTAssertTrue(fold.contains(".frame(height: folded ? 0 : nil, alignment: .bottom)"))
        XCTAssertTrue(fold.contains(".allowsHitTesting(!folded)"))
        XCTAssertTrue(fold.contains(".accessibilityHidden(folded)"))
        XCTAssertFalse(fold.contains(".clipped()"))
        XCTAssertFalse(fold.contains("clipShape"))
    }

    /// The pill stands centred, its foot off the screen's edge: the band stands on the safe area, so
    /// the pill reaches into it by the difference, and the folded band is exactly what the rule was
    /// told it keeps over the list. It hugs what it says, and fades alone under Reduce Motion.
    func testThePillStandsCentredOverTheHomeIndicator() throws {
        let band = try slice(try console, from: "private func composerBand(", to: "private func bandMembers(")
        XCTAssertTrue(band.contains("if #available(iOS 26.0, *), folded {"))
        XCTAssertTrue(band.contains(".padding(.bottom, .foldedBandPillFoot - windowBottomInset)"))
        XCTAssertTrue(band.contains("reduceMotion ? .opacity"))
        let inset = try slice(try console, from: "private var windowBottomInset: CGFloat {", to: "\n    }")
        XCTAssertTrue(inset.contains("safeAreaInsets.bottom"), "the window's own inset, which nothing moves")
        let pill = try bar
        XCTAssertTrue(pill.contains(".frame(height: .foldedBandPill)"))
        XCTAssertTrue(pill.contains(".glassEffect(.regular.interactive(), in: Capsule())"))
        XCTAssertFalse(pill.contains("maxWidth: .infinity"), "the pill hugs what it says")
    }

    /// One thing in the pill: a draft first, else the marks, else the placeholder (`FoldedBand.lead`);
    /// a turn in flight is a dot at its head.
    func testThePillLeadsWithTheDraftThenTheMarks() throws {
        let pill = try bar
        XCTAssertTrue(pill.contains("FoldedBand.lead(draft: draft, hasMarks:"))
        for lead in ["case .draft(let words):", "case .marks:", "case .placeholder:"] {
            XCTAssertTrue(pill.contains(lead), "the pill draws \(lead)")
        }
        XCTAssertTrue(pill.contains("if turnActive {\n                    Circle().fill(Color.accentColor)"))
    }

    /// A tap opens the band where the reader is, and so does putting the keyboard away; their next
    /// drag folds it again. Folding as the keyboard went — by the very drag that took it — landed in
    /// the middle of the keyboard's layout, and the band opened again and carried the reader down.
    func testATapOrTheKeyboardGoingOpensTheBandUntilTheReadersNextDrag() throws {
        let view = try console
        let band = try slice(view, from: "private func composerBand(", to: "private func bandMembers(")
        XCTAssertTrue(band.contains("open: { bandOpened = true }"))
        let keyboard = try slice(band, from: ".onChange(of: console.composerEditing) { _, editing in", to: "}")
        XCTAssertTrue(keyboard.contains("if !editing { bandOpened = true"))
        let trackers = try slice(view, from: "private func tracker(ruler:", to: "private func repinAfterResize")
        XCTAssertTrue(trackers.contains("dragged: { if bandOpened.wrappedValue { bandOpened.wrappedValue = false } }"))
        let tracker = try slice(view, from: "private struct ScrollTracker", to: "private struct AnchorRow: ViewModifier {")
        XCTAssertTrue(tracker.contains("if phase == .interacting { dragged() }"), "a finger on the list, not its coast")
    }

    /// While the band is folded only its pill stands there (the owner, 2026-11-11, Safari's one
    /// pill): no jump in it, and the floating disc is back once the band opens.
    func testThePillCarriesNoJumpAndTheDiscWaitsForTheBand() throws {
        let view = try console
        let overlay = try slice(view, from: ".overlay(alignment: .bottom) {", to: "scrollToBottomButton(proxy: proxy)")
        XCTAssertTrue(overlay.contains("!bandFolded"))
        XCTAssertFalse(view.contains("jumpRequest"))
        XCTAssertFalse(try bar.contains("jump"), "the pill carries no jump")
        let band = try slice(view, from: "private func composerBand(", to: "private func bandMembers(")
        XCTAssertTrue(band.contains("FoldedBandBar(console: console, open: { bandOpened = true })"))
    }

    /// The marks read the cards' own logic, so the bar can't say what the cards don't.
    func testTheBarsMarksReadTheCardsOwnLogic() throws {
        let bar = try bar
        for use in ["WorktreeBarLogic.mode(", "WorktreeBarLogic.primary(", "WorktreeBarLogic.turnActive(",
                    "SessionTaskCard(created: console.createdTasks.snapshot",
                    "FoldedBand.processes(console.state.background)", "FoldedBand.branch("] {
            XCTAssertTrue(bar.contains(use), "the bar reads \(use)")
        }
        // `FoldedBand.branch` writes the merge slot's chips word for word; the slot has to still say them.
        let slot = code(try source("Views/WorktreeBar.swift"))
        XCTAssertTrue(slot.contains("WTChip(title: \"✓ Merged\" + (elsewhere ? \" → \\(detail.mergeTarget!)\" : \"\"))"))
        XCTAssertTrue(slot.contains("WTChip(title: \"✓ In \\(landed)\")"))
        XCTAssertTrue(slot.contains("WTPillButton(title: \"Merging…\", disabled: true) {}"))
    }
}

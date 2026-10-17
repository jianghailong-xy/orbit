import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold a phone's folded composer band to the source (the owner, 2026-10-16): while the reader
/// goes back through the history, the parking strip and the composer fold to one thin bar; a tap opens
/// them where the reader is, the bar's ↓ is the jump to the latest, and coming back to the tail opens
/// them again. When the band folds is `TailPinning.foldsBand`'s, proved in `TailPinningTests`; the
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
    /// inset — its bar, its foot and the screen's own bottom inset — handed to the tested rule.
    func testTheTrackerAsksTailPinningWhetherTheReaderIsBackFarEnough() throws {
        let tracker = try slice(try console, from: "private struct ScrollTracker", to: "private struct AnchorRow: ViewModifier {")
        XCTAssertTrue(tracker.contains("TailPinning.foldsBand(pinned: pinned, sample: now"),
                      "the fold is asked of the rule, with the pin this same reading decided")
        XCTAssertTrue(tracker.contains("CGFloat.foldedBandBar + .composerBandFoot"),
                      "the folded band keeps its bar and its foot over the list")
        XCTAssertTrue(tracker.contains("window?.safeAreaInsets.bottom"),
                      "over the screen's own bottom inset, which no bar or keyboard moves")
        let band = code(try source("Views/ComposerView.swift"))
        XCTAssertTrue(try slice(band, from: "struct ComposerBand<Content: View>: View {", to: "\n}\n")
                        .contains(".padding(.bottom, .composerBandFoot)"),
                      "the open band stands on the same foot the folded one is measured with")
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

    /// The bar stands in the band's gutter and on its foot, so the folded band is exactly what the
    /// rule was told it keeps over the list.
    func testTheBarStandsInTheBandsGutterAndOnItsFoot() throws {
        let band = try slice(try console, from: "private func composerBand(", to: "private func bandMembers(")
        XCTAssertTrue(band.contains("if #available(iOS 26.0, *), folded {"))
        XCTAssertTrue(band.contains(".padding(.horizontal, 16)"))
        XCTAssertTrue(band.contains(".padding(.bottom, .composerBandFoot)"))
        XCTAssertTrue(try bar.contains(".frame(height: .foldedBandBar)"))
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

    /// While the band is folded its bar carries the jump: the floating disc gives way to it, and the
    /// bar's ↓ makes the disc's own jump.
    func testTheFloatingDiscGivesWayToTheBarsJump() throws {
        let view = try console
        let overlay = try slice(view, from: ".overlay(alignment: .bottom) {", to: "scrollToBottomButton(proxy: proxy)")
        XCTAssertTrue(overlay.contains("!bandFolded"))
        XCTAssertTrue(view.contains(".onChange(of: jumpRequest) { jumpToLatest(proxy) }"))
        let disc = try slice(view, from: "private func scrollToBottomButton(", to: "} label: { pressed in")
        XCTAssertTrue(disc.contains("jumpToLatest(proxy)"), "the disc and the bar make one jump")
        let band = try slice(view, from: "private func composerBand(", to: "private func bandMembers(")
        XCTAssertTrue(band.contains("jump: { jumpRequest &+= 1 }"))
    }

    /// The marks read the cards' own logic, so the bar can't say what the cards don't.
    func testTheBarsMarksReadTheCardsOwnLogic() throws {
        let bar = try bar
        for use in ["WorktreeBarLogic.mode(", "WorktreeBarLogic.primary(", "WorktreeBarLogic.turnActive(",
                    "SessionTaskCard(created: console.createdTasks.snapshot",
                    "FoldedBand.processes(console.state.background)", "FoldedBand.branch(",
                    "if turnActive { TurnArc() }"] {
            XCTAssertTrue(bar.contains(use), "the bar reads \(use)")
        }
        // `FoldedBand.branch` writes the merge slot's chips word for word; the slot has to still say them.
        let slot = code(try source("Views/WorktreeBar.swift"))
        XCTAssertTrue(slot.contains("WTChip(title: \"✓ Merged\" + (elsewhere ? \" → \\(detail.mergeTarget!)\" : \"\"))"))
        XCTAssertTrue(slot.contains("WTChip(title: \"✓ In \\(landed)\")"))
        XCTAssertTrue(slot.contains("WTPillButton(title: \"Merging…\", disabled: true) {}"))
    }
}

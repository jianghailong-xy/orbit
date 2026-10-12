import Foundation
import XCTest
@testable import OrbitKit

/// The wires between the reading of the `<background-jobs>` block and the three SwiftUI surfaces
/// that draw it.
///
/// `BackgroundJobsTests` proves the reading; it proves nothing about what a reader sees unless the
/// views read it, and no compiler here checks that — SwiftUI does not exist on Linux, and
/// `AttachedNoteView.swift` / `UserTurnRow.swift` / `BackgroundWakeCardView.swift` are compiled only
/// by the macOS and iOS jobs. So the attachment is asserted over the source, the way
/// `MarkdownCheckboxWiringTests` does, and each assertion is written so that CUTTING the wire is
/// what turns it red.
///
/// The two it exists for:
///  - the block opens as rows rather than as the one line four lines wide it always was, with the
///    narration, the absolute paths and the Monitor section left to the fold under them;
///  - a wake turn draws no bubble for a block nobody typed;
///  - a wake written into the running turn (a steer) says how far it got, and offers no Cancel.
///
/// What it cannot see is how any of it looks — that is what the beta and the screenshots are for.
final class BackgroundJobsWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "the views still read the block they are drawing."
            }
        }
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.missing(relative)
    }

    /// One view's own stretch of the file, so a match 200 lines away cannot answer for it — a bare
    /// `contains` over a whole file is how a scan like this goes falsely green.
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    private static let notePath = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/AttachedNoteView.swift"
    private static let bubblesPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/MessageBubbles.swift"
    private static let rowPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/UserTurnRow.swift"
    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/BackgroundWakeCardView.swift"

    // MARK: the block opens as rows

    /// The entry reads the block, and the line that names it shut carries the count.
    func testTheAttachedEntryReadsTheBlockAndCountsItOnTheShutLine() throws {
        let entry = try section(try source(Self.notePath),
                                from: "struct AttachedNoteEntry", to: "struct BackgroundJobsNoteView")

        XCTAssertTrue(entry.contains("BackgroundJobsText.parse(attached.text)"),
                      "the entry must read the block it is about to draw")
        XCTAssertTrue(entry.contains("⊕ Orbit attached: \\(attached.kind)"),
                      "the shut line still names what was attached")
        XCTAssertTrue(entry.contains("BackgroundJobsNote.summary(jobs)"),
                      "the count on the shut line is the whole point of it: \"background jobs\" "
                          + "alone never said whether opening it was worth the tap")
        XCTAssertTrue(entry.contains("BackgroundJobsNoteView(jobs: jobs)"),
                      "a block that read as jobs opens as rows")
        // Anything that is not the inventory opens exactly as it always has.
        XCTAssertTrue(entry.contains("verbatim(attached.text)"),
                      "any other block still opens verbatim")
    }

    /// A row is the outcome, the command, and the ids — and the fold under the rows keeps the block
    /// whole, under a name of its own.
    func testARowDrawsTheMarkTheCommandTheOutcomeAndTheIds() throws {
        let note = try source(Self.notePath)
        let rows = try section(note, from: "struct BackgroundJobsNoteView", to: "private var raw")

        for wire in ["mark(job)", "BackgroundJobsNote.name(job)", "BackgroundJobsNote.outcome(job)",
                     "BackgroundJobsNote.meta(job)", "BackgroundJobsNote.runningTitle",
                     "BackgroundJobsNote.endedTitle"] {
            XCTAssertTrue(rows.contains(wire), "a row is drawn off \(wire)")
        }
        // The command is the row's name, and a forty-line heredoc is not forty lines of row.
        XCTAssertTrue(rows.contains(".lineLimit(2)"), "the command is held to two lines")

        let fold = try section(note, from: "private var raw", to: "private func mark")
        XCTAssertTrue(fold.contains("Text(jobs.text)"),
                      "the fold shows the block exactly as the agent received it")
        XCTAssertTrue(fold.contains("BackgroundJobsNote.rawSummary"),
                      "the fold is named by the one string the parity check holds to the web's — and "
                          + "apart from the wake card's own fold, which sits right above it")

        // The three marks a row can open on, each off the reading rather than off a status spelled
        // out a second time here.
        let glyphs = try section(note, from: "private func mark", to: "\n}")
        XCTAssertTrue(glyphs.contains("BackgroundJobsNote.mark(job)"),
                      "the glyph comes from the reading")
        for (outcome, glyph) in [("case .ok", "checkmark.circle.fill"),
                                 ("case .failed", "xmark.circle.fill"),
                                 ("case .running", "clock")] {
            XCTAssertTrue(glyphs.contains(outcome) && glyphs.contains(glyph),
                          "\(outcome) needs its own glyph (\(glyph))")
        }
    }

    /// The person's own bubble draws the entry rather than dumping the note's text into it.
    func testTheUserBubbleDrawsTheEntryRatherThanTheBlocksOwnText() throws {
        let bubble = try section(try source(Self.bubblesPath),
                                 from: "struct UserBubbleView", to: "struct AssistantBubbleView")

        XCTAssertTrue(bubble.contains("AttachedNoteEntry(attached: attached)"),
                      "the bubble draws the entry, which is what decides rows or verbatim")
        XCTAssertFalse(bubble.contains("Text(attached.text)"),
                       "the whole block as one Text is what this replaced: four lines of wrapped ｜")
    }

    // MARK: the turn nobody typed

    /// The card holds the leftover block, and the bubble under it is drawn only for words somebody
    /// actually typed.
    func testAWakeTurnPutsTheLeftoverBlockInTheCardAndDrawsNoEmptyBubble() throws {
        let row = try source(Self.rowPath)
        // Once delivered the block is read off the recorded note, never out of the person's words.
        XCTAssertTrue(row.contains("let wakeNote: String? = queued == nil ? b.note : b.text"),
                      "a delivered wake is no longer read off the note the apiserver recorded")
        let branch = try section(row, from: "BackgroundWakeText.parse(wakeNote)",
                                 to: "UserBubbleView(bubble: b, onCancelQueued: cancel)")

        XCTAssertTrue(branch.contains("attached: attachedRest(background)"),
                      "whatever the card did not take rides in the card, because nobody typed this "
                          + "turn")
        XCTAssertTrue(branch.contains("BackgroundWakeCard.drawsBubble(text: b.text)"),
                      "the bubble is drawn off the person's words alone")
        XCTAssertFalse(branch.contains("background.rest.isEmpty") || branch.contains("!background.rest"),
                       "a leftover block must not be what brings a bubble back: that is the empty "
                           + "bubble this fixed, signed with the reader's own name")

        let card = try section(try source(Self.cardPath), from: "struct BackgroundWakeCardView",
                               to: "private func jobRow")
        XCTAssertTrue(card.contains("var attached: (kind: String, text: String)?"),
                      "the wake has a slot for it")
        XCTAssertTrue(card.contains("if let attached { AttachedNoteEntry(attached: attached) }"),
                      "and draws it in its own fold")
    }

    /// A job that ends while a turn runs is written into that turn (a steer). Its line says how far it
    /// got wherever it is drawn, and while it waits for the runner it offers no Cancel: the server
    /// refuses to withdraw a steer (409), so a Cancel there would be a button that only ever fails.
    func testASteeredWakeSaysHowFarItGotAndOffersNoCancel() throws {
        // One branch draws the wake queued and delivered (`UserTurnRow`); the queue's Cancel is the
        // one `QueuedControls` hands it, which a steer never gets.
        let row = try source(Self.rowPath)
        let controls = try section(row, from: "struct QueuedControls", to: "struct UserTurnRow")
        XCTAssertTrue(controls.contains("bubble.turnId == nil || bubble.steer"),
                      "a steered wake waiting for the runner must not be offered a Cancel")
        let branch = try section(row,
                                 from: "} else if let background = BackgroundWakeText.parse(wakeNote) {",
                                 to: "} else {")
        XCTAssertTrue(branch.contains("onCancelQueued: cancel,"), "the wake's Cancel is not the queue's")
        XCTAssertTrue(branch.contains("steerState: BackgroundWakeCard.steerState("),
                      "it says how far it has got instead — and still does once written into the turn")
        XCTAssertTrue(branch.contains("queued: queued != nil"), "and is drawn as not yet an event while queued")

        let card = try section(try source(Self.cardPath), from: "struct BackgroundWakeCardView",
                               to: "private func jobRow")
        XCTAssertTrue(card.contains("if let steerState {"), "the line draws the state it is handed")
        XCTAssertTrue(card.contains("if queued {"), "and its dashed outline off `queued`, not off a Cancel")
    }

    /// The rule the bubble is drawn off, on its own: whitespace is not a message.
    func testOnlyWordsSomebodyTypedDrawABubble() {
        XCTAssertFalse(BackgroundWakeCard.drawsBubble(text: ""))
        XCTAssertFalse(BackgroundWakeCard.drawsBubble(text: "   \n\t\n "))
        XCTAssertTrue(BackgroundWakeCard.drawsBubble(text: "继续"))
    }
}

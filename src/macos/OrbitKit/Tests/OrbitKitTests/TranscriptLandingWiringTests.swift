import Foundation
import XCTest

/// The row a conversation was opened at (a waiting card, a record a link named) is held in place
/// while the rest of it lands, and an open-at-waiting-card request lapses after 10 s (web
/// 0138628478). `ConsoleView.swift` and `ConsoleModel.swift` compile only in the macOS and iOS jobs,
/// so the transcript's wires are asserted over their source; the rule they call is tested in
/// `TranscriptLandingTests`.
final class TranscriptLandingWiringTests: XCTestCase {
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


    func testAWaitingCardAndARecordJumpAreHeldInPlace() throws {
        let view = try app("Views/Console/ConsoleView.swift")
        let card = try code(view, from: ".onChange(of: console.cardRequest, initial: true) { _, request in",
                            to: ".onChange(of: heldScroll)")
        XCTAssertTrue(card.contains("landing = TranscriptLanding(rowID: request.rowID, sessionID: sessionID, place: .top, at: Date())"),
                      "the waiting card is held by its top")
        XCTAssertFalse(card.contains("asyncAfter"), "held until it is let go, not re-aimed on a fixed clock")
        XCTAssertFalse(card.contains("addingTimeInterval"), "no fixed 2.5 s hold")

        let record = try code(view, from: ".onChange(of: console.recordRequest, initial: true) { _, request in",
                              to: ".onChange(of: console.cardRequest")
        XCTAssertTrue(record.contains("landing = TranscriptLanding(rowID: request.rowID, sessionID: sessionID, place: .center, at: Date())"),
                      "a record jump is held where it lands, in the middle of the view")

        // Made in the hop that carries the scroll, after a session switch's own clearing of the hold
        // in the same update, for the session the request was made in.
        for handler in [card, record] {
            let hop = try XCTUnwrap(handler.range(of: "let sessionID = console.sessionID DispatchQueue.main.async {"))
            let made = try XCTUnwrap(handler.range(of: "landing = TranscriptLanding("))
            XCTAssertLessThan(hop.upperBound, made.lowerBound)
        }
    }

    func testAHeldRowIsPutBackOnEveryPublishAndEveryContentResize() throws {
        let view = try app("Views/Console/ConsoleView.swift")
        let publish = try code(view, from: ".onChange(of: console.stateRevision) {", to: "recomputeStuck()")
        let keep = try XCTUnwrap(publish.range(of: "if keepLanding(proxy) {"), "a publish puts the held row back")
        let tail = try XCTUnwrap(publish.range(of: "proxy.scrollTo(bottomID, anchor: .bottom)"))
        XCTAssertLessThan(keep.lowerBound, tail.lowerBound, "before, and instead of, the tail follow")

        let keepLanding = try code(view, from: "private func keepLanding(_ proxy: ScrollViewProxy) -> Bool {",
                                   to: "private func landingAnchor(")
        XCTAssertTrue(keepLanding.contains("held.keep(in: console.sessionID, contentHeight: nil, at: Date())"))
        XCTAssertTrue(keepLanding.contains("landing = nil"), "a hold past its quiet is let go")
        XCTAssertTrue(keepLanding.contains("held.puttingBack(from: Double(ruler.contentOffset))"),
                      "a publish's put-back is measured too")
        XCTAssertTrue(keepLanding.contains("proxy.scrollTo(held.rowID, anchor: landingAnchor(held))"))

        // A row measured, an image loaded, a translation: the content's height changed.
        let tracker = try code(view, from: "private struct ScrollTracker", to: "/// Publishes the id of the item currently under")
        XCTAssertTrue(tracker.contains("let held = landingHolds(now.offset, now.contentHeight != was.contentHeight ? now.contentHeight : nil)"),
                      "every geometry reading is handed to the hold, with its offset and any new height")
        XCTAssertTrue(tracker.contains("let pinned = !held && TailPinning.pinned("),
                      "and the tail is not pinned while a row is held (web measure(): !landingRef.current)")
        let holds = try code(view, from: "private func landingHolds(offset: Double, resizedTo height: Double?) -> Bool {",
                             to: "private func keepLanding(")
        let read = try XCTUnwrap(holds.range(of: "held.read(offset: offset, at: Date())"),
                                 "the reading settles whether the last put-back moved the list")
        let checked = try XCTUnwrap(holds.range(of: "held.keep(in: console.sessionID, contentHeight: height, at: Date())"))
        XCTAssertLessThan(read.lowerBound, checked.lowerBound, "before the quiet is checked")
        XCTAssertTrue(holds.contains("if height != nil { holdScroll(to: held.rowID, anchor: landingAnchor(held), animated: false, putsBack: true) }"),
                      "put back as a held scroll: this arrives off a layout report")
        let trackers = try code(view, from: "private func tracker(ruler:", to: "private func repinAfterResize")
        XCTAssertEqual(trackers.components(separatedBy: "landingHolds: { landingHolds(offset: $0, resizedTo: $1) }").count - 1, 2,
                       "on both platforms")

        let repin = try code(view, from: "private func repinAfterResize() {", to: "#if os(iOS)")
        XCTAssertTrue(repin.contains("landing == nil"), "a viewport resize does not carry a held row off to the tail")
    }

    func testTheHoldIsReleasedByTheReaderAJumpASendAndASessionSwitch() throws {
        let view = try app("Views/Console/ConsoleView.swift")
        XCTAssertFalse(view.contains("cardHold"), "one hold, the landing")
        let trackers = try code(view, from: "private func tracker(ruler:", to: "private func repinAfterResize")
        XCTAssertEqual(trackers.components(separatedBy: "readerScrolled: { landing = nil; console.readerTookOver() }").count - 1, 2,
                       "the reader's own scroll lets go, on both platforms")
        let tracker = try code(view, from: "private struct ScrollTracker", to: "/// Publishes the id of the item currently under")
        XCTAssertTrue(tracker.contains("if phase == .interacting { readerScrolled() }"))
        let jump = try code(view, from: "private func jumpToLatest(_ proxy: ScrollViewProxy) {", to: "if console.detached {")
        XCTAssertTrue(jump.contains("landing = nil"), "a jump to the bottom lets go")
        let switched = try code(view, from: ".onChange(of: console.sessionID) {", to: "console.setReadingHistory(false)")
        XCTAssertTrue(switched.contains("landing = nil"), "another session lets go")
        XCTAssertTrue(view.contains("atBottom = true; landing = nil; console.readerTookOver()"), "a send lets go")
        let bar = try code(view, from: ".onChange(of: console.scrollRequest) { _, request in", to: "DispatchQueue.main.async")
        XCTAssertTrue(bar.contains("landing = nil"), "and so does the reader asking for another card")
    }

    func testAnOpenAtWaitingCardRequestLapsesOnTheLandingClock() throws {
        let console = try app("ConsoleModel.swift")
        let follow = try code(console, from: "private func followPendingWaitingCard() {", to: "func cardRequestFollowed() {")
        XCTAssertTrue(follow.contains("guard TranscriptLanding.waitingRequestStands(askedAt: asked, now: Date()) else {"),
                      "the request lapses after web's 10 s")
        XCTAssertFalse(console.contains("addingTimeInterval(60)"), "not 60 s")
        let focus = try code(console, from: "func focusWaitingCard() {", to: "private func followPendingWaitingCard() {")
        XCTAssertTrue(focus.contains("pendingWaitingCardAt = Date()"))
    }

    /// Only a put-back that moved the list restarts the quiet (web `keepLanding`): a new content
    /// height alone does not, or a session that keeps streaming would hold the row, and suspend the
    /// tail pin, for as long as it runs.
    func testOnlyAPutBackThatMovedTheListRestartsTheQuiet() throws {
        let view = try app("Views/Console/ConsoleView.swift")
        let made = try code(view, from: ".onChange(of: heldScroll) { _, held in", to: ".onAppear {")
        XCTAssertTrue(made.contains("if held.putsBack, var row = landing, row.rowID == held.rowID { row.puttingBack(from: Double(ruler.contentOffset)) landing = row }"),
                      "a held put-back records the offset it starts from, for the next reading to compare")
        XCTAssertTrue(view.contains("var putsBack = false"), "the held scroll says it is a put-back")
        XCTAssertFalse(view.contains("movedAt"), "the view never restarts the wait itself")

        let landing = try source("src/macos/OrbitKit/Sources/OrbitKit/Transcript/TranscriptLanding.swift")
        let keep = try code(landing, from: "public func keep(in sessionID: String, contentHeight: Double?, at now: Date) -> Bool {",
                            to: "public mutating func puttingBack(")
        XCTAssertFalse(keep.contains("movedAt ="), "a new height is not evidence the row moved")
    }

    func testTailPinningSaysTheHoldSuspendsThePinAsWebDoes() throws {
        let pinning = try source("src/macos/OrbitKit/Sources/OrbitKit/Transcript/TailPinning.swift")
        XCTAssertTrue(pinning.contains("`TranscriptLanding`"), "the parity note names the hold")
        XCTAssertTrue(pinning.contains("!landingRef.current"), "and web's own reading of it")
        let web = try source("src/web/src/components/WorkspaceView.tsx")
        XCTAssertTrue(web.contains("atBottomRef.current = !reviewPositionHeldRef.current && !landingRef.current && pinnedToTail("),
                      "web's pin is still suspended by its landing; if this moved, update TailPinning's note")
    }
}

import Foundation
import XCTest
@testable import OrbitKit

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

    private static let rowPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/UserTurnRow.swift"
    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/BackgroundWakeCardView.swift"

    // MARK: the turn nobody typed

    /// A wake draws a bubble only for words somebody actually typed.
    func testAWakeTurnDrawsNoEmptyBubble() throws {
        let row = try source(Self.rowPath)
        // Once delivered the block is read off the recorded note, never out of the person's words.
        XCTAssertTrue(row.contains("let wakeNote: String? = queued == nil ? b.note : b.text"),
                      "a delivered wake is no longer read off the note the apiserver recorded")
        let branch = try section(row, from: "BackgroundWakeText.parse(wakeNote)",
                                 to: "UserBubbleView(bubble: b, onCancelQueued: cancel, steer: steer, onPutBack: putBack)")

        XCTAssertTrue(branch.contains("BackgroundWakeCard.drawsBubble(text: b.text)"),
                      "the bubble is drawn off the person's words alone")
        XCTAssertFalse(branch.contains("background.rest.isEmpty") || branch.contains("!background.rest"),
                       "a leftover block must not be what brings a bubble back: that is the empty "
                           + "bubble this fixed, signed with the reader's own name")
    }

    /// A job that ends while a turn runs is written into that turn (a steer). Its line says how far it
    /// got wherever it is drawn, and while it waits for the runner it offers no Cancel: a steer is
    /// taken back only by its own Withdraw, which a wake nobody typed is never offered.
    func testASteeredWakeSaysHowFarItGotAndOffersNoCancel() throws {
        // One branch draws the wake queued and delivered (`UserTurnRow`); the queue's Cancel is the
        // one `QueuedControls` hands it, which a steer never gets.
        let row = try source(Self.rowPath)
        let controls = try section(row, from: "struct QueuedControls", to: "struct UserTurnRow")
        XCTAssertTrue(controls.contains("bubble.turnId == nil || bubble.steer"),
                      "a steered wake waiting for the runner must not be offered a Cancel")
        let branch = try section(row,
                                 from: "} else if let jobNews = BackgroundWakeText.parse(wakeNote) {",
                                 to: "} else {")
        XCTAssertTrue(branch.contains("onCancelQueued: cancel,"), "the wake's Cancel is not the queue's")
        XCTAssertTrue(branch.contains("steerState: BackgroundWakeCard.steerState("),
                      "it says how far it has got instead — and still does once written into the turn")
        XCTAssertTrue(branch.contains("queued: queued != nil"), "and is drawn as not yet an event while queued")

        let card = try section(try source(Self.cardPath), from: "struct BackgroundWakeCardView",
                               to: "private func wakeupRow")
        XCTAssertTrue(card.contains("if let steerState {"), "the line draws the state it is handed")
        XCTAssertTrue(card.contains("if queued {"), "and its dashed outline off `queued`, not off a Cancel")
    }

    /// A job's end, new output or stall draws no line (board C1): the branch draws the wake only once
    /// `BgJobCard.wakeupsOnly` has left a wakeup in it, and a typed word keeps its bubble.
    func testAJobsNewsDrawsNoLineOnlyAWakeupDoes() throws {
        let row = try source(Self.rowPath)
        let branch = try section(row, from: "} else if let jobNews = BackgroundWakeText.parse(wakeNote) {",
                                 to: "} else if queued == nil, OrbitEvent.draws(b) {")
        XCTAssertTrue(branch.contains("if let background = BgJobCard.wakeupsOnly(jobNews) {"),
                      "a job's news is drawn as a line again")
        XCTAssertFalse(row.contains("BackgroundWakeCardView(wake: jobs"),
                       "a SubAgent's or a workflow's end draws the job's news beside it again")
        let card = try source(Self.cardPath)
        XCTAssertFalse(card.contains("wake.jobs"), "the wake line still reads jobs: their card says them")
    }

    /// The rule the bubble is drawn off, on its own: whitespace is not a message.
    func testOnlyWordsSomebodyTypedDrawABubble() {
        XCTAssertFalse(BackgroundWakeCard.drawsBubble(text: ""))
        XCTAssertFalse(BackgroundWakeCard.drawsBubble(text: "   \n\t\n "))
        XCTAssertTrue(BackgroundWakeCard.drawsBubble(text: "继续"))
    }
}

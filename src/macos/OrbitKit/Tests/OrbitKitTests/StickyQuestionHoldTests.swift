import Foundation
import XCTest
@testable import OrbitKit

/// The sticky question header's hold (`StickyQuestionHold`), against the geometry that froze the
/// iPhone app — and the wire from `ConsoleView`'s `recomputeStuck` to it.
final class StickyQuestionHoldTests: XCTestCase {

    /// One settle of the transcript under the fallback rule: the header's state goes in, the offset
    /// the list reports WITH that state comes out of `offsetWith`, and the rule decides the next
    /// state. Run until it stops changing, or report that it never does.
    private func settle(from showing: Bool, offsetWith: (Bool) -> Double, passes: Int = 12) -> (Bool, Int) {
        var showing = showing
        for pass in 0..<passes {
            let next = StickyQuestionHold.fallbackNames(contentOffset: offsetWith(showing), showing: showing)
            if next == showing { return (showing, pass) }
            showing = next
        }
        return (showing, passes)
    }

    /// The simulator's own log of the freeze (2026-10-06): with the header shown the list read -66,
    /// with it hidden 81 — and no row ever claimed the top line, so every pass took the fallback.
    /// One 40-point threshold flipped the header on every frame; the hold settles it hidden, which is
    /// right: the question was on screen.
    func testTheGeometryThatFrozeThePhoneSettlesInsteadOfFlipping() {
        let measured: (Bool) -> Double = { showing in showing ? -66 : 81 }
        // What the single threshold did: each state's reading sends it to the other.
        XCTAssertFalse(-66 > 40)
        XCTAssertTrue(81 > 40)

        let (fromShown, passes) = settle(from: true, offsetWith: measured)
        XCTAssertFalse(fromShown, "the header hides, and stays hidden")
        XCTAssertLessThanOrEqual(passes, 1, "one change, then still")
        let (fromHidden, still) = settle(from: false, offsetWith: measured)
        XCTAssertFalse(fromHidden)
        XCTAssertEqual(still, 0, "a hidden header is not shown by the reading its own absence produced")
    }

    /// Any move the header makes by itself smaller than the gap between the two thresholds settles —
    /// the measured 147 points with room to spare — wherever the transcript sits.
    func testAnyMoveTheHeaderMakesByItselfSettles() {
        let gap = StickyQuestionHold.fallbackShowAfter - StickyQuestionHold.fallbackHideAt
        XCTAssertGreaterThan(gap, 147 * 2)
        for hidden in stride(from: -200.0, through: 1200, by: 7) {
            for move in [32.0, 147, 200] {
                let measured: (Bool) -> Double = { showing in showing ? hidden - move : hidden }
                for start in [true, false] {
                    let (_, passes) = settle(from: start, offsetWith: measured)
                    XCTAssertLessThan(passes, 12, "flips forever at offset \(hidden), move \(move)")
                }
            }
        }
    }

    /// What the fallback is for is unchanged: a conversation opened at the end of a long transcript
    /// shows its last question at once, and a list back at its top hides it.
    func testALongTranscriptStillShowsItsQuestionAtOnceAndHidesAtTheTop() {
        XCTAssertTrue(StickyQuestionHold.fallbackNames(contentOffset: 2400, showing: false))
        XCTAssertTrue(StickyQuestionHold.fallbackNames(contentOffset: 2400, showing: true))
        XCTAssertTrue(StickyQuestionHold.fallbackNames(contentOffset: 120, showing: true),
                      "shown, it stays until the list is back at its top")
        XCTAssertFalse(StickyQuestionHold.fallbackNames(contentOffset: 40, showing: true))
        XCTAssertFalse(StickyQuestionHold.fallbackNames(contentOffset: 0, showing: false))
        XCTAssertFalse(StickyQuestionHold.fallbackNames(contentOffset: 120, showing: false),
                       "hidden, a short scroll does not raise it before any row has claimed the top")
    }

    /// With a row claiming the top line: the named question straddling the line itself keeps the
    /// header — hiding it would let the list up and put the row below the question back under the
    /// line, which names it again — and every other answer is the anchor's own.
    func testTheNamedQuestionUnderTheTopLineKeepsItsHeader() {
        XCTAssertEqual(StickyQuestionHold.named(found: nil, anchor: "q1", showing: "q1"), "q1")
        XCTAssertNil(StickyQuestionHold.named(found: nil, anchor: "a0", showing: "q1"),
                     "a row above the question at the line: nothing is above the fold")
        XCTAssertEqual(StickyQuestionHold.named(found: "q1", anchor: "q2", showing: "q2"), "q1",
                       "an earlier question takes over as before")
        XCTAssertEqual(StickyQuestionHold.named(found: "q1", anchor: "r1", showing: nil), "q1")
        XCTAssertNil(StickyQuestionHold.named(found: nil, anchor: "q1", showing: nil),
                     "hidden, a question at the line does not raise the header")

        // The two frames that used to alternate: shown, the question is at the line; hidden, its reply.
        var stuck: String? = "q1"
        for _ in 0..<6 {
            let anchor = stuck == nil ? "r1" : "q1"
            let found: String? = anchor == "r1" ? "q1" : nil
            stuck = StickyQuestionHold.named(found: found, anchor: anchor, showing: stuck)
            XCTAssertEqual(stuck, "q1", "the header holds instead of flipping")
        }
    }

    // MARK: the wire

    private func consoleView() throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let relative = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift"
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw NSError(domain: "StickyQuestionHoldTests", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "\(relative) was not found above this test; move this check with it"])
    }

    /// `recomputeStuck` asks the hold for both answers, and keeps no bare threshold of its own: a
    /// `contentOffset > 40` written back inline is the frame-by-frame flip again.
    func testRecomputeStuckDecidesThroughTheHold() throws {
        let source = try consoleView()
        guard let start = source.range(of: "private func recomputeStuck() {"),
              let end = source.range(of: "if found != stuckID { stuckID = found }",
                                     range: start.upperBound..<source.endIndex) else {
            return XCTFail("recomputeStuck was not found in ConsoleView.swift")
        }
        let body = source[start.lowerBound..<end.upperBound]
            .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.hasPrefix("//") }.joined(separator: " ")
        XCTAssertTrue(body.contains("found = StickyQuestionHold.named(found: found, anchor: anchor, showing: stuckID)"))
        XCTAssertTrue(body.contains("StickyQuestionHold.fallbackNames(contentOffset: Double(ruler.contentOffset), showing: stuckID != nil)"))
        XCTAssertFalse(body.contains("ruler.contentOffset > 40"), "the bare threshold is back")
    }
}

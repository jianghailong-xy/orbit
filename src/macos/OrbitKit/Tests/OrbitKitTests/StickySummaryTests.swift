import Foundation
import XCTest
@testable import OrbitKit

/// The bar pinned to the top of the console, over a turn nobody typed.
///
/// The account owner's screenshot (2026-09-17): `↑ Your question  Orbit Watch 01a0ade6-0b07-718…`
/// with the card directly under it reading "Queued by a watch, not typed by you". The bar then named
/// a watch's wake in the card's own words — and so "↑ Watch triggered" took it over the reply the
/// agent simply carried on with, until the wake became a line in that reply (2026-10-09), as a
/// background job's news had. Neither is the head of a round now, so the bar points at neither and
/// keeps the person's question. The last test is the guard that was already there and must survive:
/// pasting a wake's head line into the composer is a message the person typed.
final class StickySummaryTests: XCTestCase {
    private typealias F = WatchFixture

    /// A job that failed, in the wording the apiserver writes today
    /// (`runner-api/background-job-wake.ts`). Shortened to the fields the card reads.
    private static let jobNote = """
        <background-job-wake>
          A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:
            bgj_13c53745a88a｜job｜bash scripts/run-pg-spec.sh｜pg matrix
              ended｜failed｜exit code 124
              output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–512
              (no output)
          The control plane recorded this for you; the user did not say it.
        </background-job-wake>
        """

    /// A wakeup coming due (`runner-api/scheduled-wakeup.ts`), which carries no job at all.
    private static let wakeupNote = """
        <scheduled-wakeup>
          The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:
            2026-09-17T06:00:00.000Z scheduled 600 seconds out, due 2026-09-17T06:10:00.000Z
            reason: watching CI run
            what you left for this turn:
              read the CI result and fix what failed
          The control plane recorded this for you; the user did not say it.
        </scheduled-wakeup>
        """

    // MARK: the turns the control plane opens

    /// A watch's wake, in all four of the ways a watch wakes a session, is a line inside the answer
    /// the agent is still giving: the bar does not point at it, and keeps naming the question that
    /// answer belongs to. Named in the card's words it read "↑ Watch triggered" over the reply.
    func testAWatchsWakeIsNoTurnTheBarPointsAt() {
        for wake in [F.matchWake(), F.expiryWake(), F.endWake("REVOKED"), F.endWake("UNRESOLVABLE")] {
            XCTAssertNotNil(WatchWakeText.parse(wake), "the fixture is a wake")
            XCTAssertFalse(StickySummary.isAnchor(text: wake), wake.prefix(60).description)
        }
    }

    /// A background job's news is a line inside the answer the agent is still giving, not the head
    /// of a round: the bar does not point at it, and keeps naming the question that answer belongs
    /// to. Named in its own words it took the bar for the rest of the answer, and a run of jobs kept
    /// the question off the screen altogether.
    func testABackgroundJobIsNoTurnTheBarPointsAt() {
        XCTAssertFalse(StickySummary.isAnchor(text: "", note: Self.jobNote))
    }

    func testAScheduledWakeupIsNoTurnTheBarPointsAt() {
        XCTAssertFalse(StickySummary.isAnchor(text: "", note: Self.wakeupNote))
    }

    /// Words somebody typed on the same turn are a bubble under the line, and the bar names them as it
    /// names any question.
    func testWordsTypedOnAWakesTurnAreStillAQuestion() {
        XCTAssertTrue(StickySummary.isAnchor(text: "and check the dark theme too", note: Self.jobNote))
        let summary = StickySummary.of(text: "and check the dark theme too", note: Self.jobNote)
        XCTAssertEqual(summary.label, StickySummary.yourQuestion)
        XCTAssertEqual(summary.text, "and check the dark theme too")
    }

    /// Every other turn is still one the bar points at: a person's message — including one the
    /// control plane appended a note to that is not a wake, and one quoting a wake's head line.
    func testEveryOtherTurnIsStillOneTheBarPointsAt() {
        XCTAssertTrue(StickySummary.isAnchor(text: "部署"))
        XCTAssertTrue(StickySummary.isAnchor(
            text: "what does this mean?\n\nOrbit Watch \(F.wakeWatchID) matched at generation 1: \(F.wakeReason)"))
        XCTAssertTrue(StickySummary.isAnchor(text: "check the dark theme too",
                                             note: "Continue where the previous turn left off."))
    }

    // MARK: the turns somebody did type

    /// What the bar has always said, unchanged — including for a message the control plane appended
    /// a note to that is not a wake (a continuation nudge), which is still the person's message.
    func testAPersonsMessageKeepsItsLabelAndItsOwnWords() {
        XCTAssertEqual(StickySummary.of(text: "部署").label, StickySummary.yourQuestion)
        XCTAssertEqual(StickySummary.of(text: "部署").label, "↑ Your question")
        XCTAssertEqual(StickySummary.of(text: "部署").text, "部署")
        let nudged = StickySummary.of(text: "check the dark theme too",
                                      note: "Continue where the previous turn left off.")
        XCTAssertEqual(nudged.label, StickySummary.yourQuestion)
        XCTAssertEqual(nudged.text, "check the dark theme too")
    }

    /// The guard `WatchWakeText.parse` already holds, read through this bar: a person who pastes a
    /// wake's head line into the composer is a person typing. All three parts have to be there —
    /// head, mark, and a payload naming the same watch — and a paste has one.
    func testAPersonWhoPastedAWakesHeadLineStillGetsTheirOwnLabel() {
        let pasted = "Orbit Watch \(F.wakeWatchID) matched at generation 1: \(F.wakeReason)"
        let summary = StickySummary.of(text: "what does this mean?\n\n\(pasted)")
        XCTAssertEqual(summary.label, StickySummary.yourQuestion)
        XCTAssertEqual(summary.text, "what does this mean?\n\n\(pasted)")
        // Even opening with it, which is the shape that comes closest to a wake.
        let opening = StickySummary.of(text: "\(pasted)\n\nwhat does this mean?")
        XCTAssertEqual(opening.label, StickySummary.yourQuestion)
        XCTAssertEqual(opening.text, "\(pasted)\n\nwhat does this mean?")
    }
}

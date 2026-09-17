import Foundation
import XCTest
@testable import OrbitKit

/// The bar pinned to the top of the console, on a turn nobody typed.
///
/// The account owner's screenshot (2026-09-17): `↑ Your question  Orbit Watch 01a0ade6-0b07-718…`
/// with the card directly under it reading "Queued by a watch, not typed by you". The bubble had
/// already been fixed (`WatchWake.swift`); this bar was the place still calling a wake the person's
/// own words, and drawing a truncated UUID as what they had said.
///
/// So each turn is checked for both halves of what the bar draws: the label that says whose turn it
/// was, and the line that says what it said — and for a wake both come from the card it points at,
/// never from the payload. The last test is the guard that was already there and must survive:
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

    // MARK: the four ways a watch wakes a session

    /// A Match: the label is the card's title and the line is the card's own account of the
    /// condition — "2 of 3 finished · 1 of 3 failed", not `ANY_OF(ALL TASK_TERMINAL 2/3, …)` and
    /// certainly not the head line's UUID.
    func testAMatchIsLabelledAndReadAsTheCardReadsIt() {
        let summary = StickySummary.of(text: F.matchWake())
        XCTAssertEqual(summary.label, "↑ Watch triggered")
        XCTAssertEqual(summary.text, "2 of 3 finished · 1 of 3 failed")
        // The two ways the screenshot's bar was wrong, named outright so a regression says which.
        XCTAssertNotEqual(summary.label, StickySummary.yourQuestion)
        XCTAssertFalse(summary.text.contains(F.wakeWatchID), "the bar drew the payload's raw id")
    }

    func testTheDeadlinePassingIsLabelledAndReadAsTheCardReadsIt() {
        let summary = StickySummary.of(text: F.expiryWake())
        XCTAssertEqual(summary.label, "↑ Watch expired")
        XCTAssertEqual(summary.text,
                       "Its deadline passed before its condition held. It will not wake this session again.")
    }

    func testLosingAccessToATargetIsLabelledAndReadAsTheCardReadsIt() {
        let summary = StickySummary.of(text: F.endWake("REVOKED"))
        XCTAssertEqual(summary.label, "↑ Watch stopped: access lost")
        XCTAssertEqual(summary.text,
                       "This account can no longer read one of its targets, so it reports nothing about them.")
    }

    /// The longest label there is. It leaves the line no room on a phone, and that was decided
    /// rather than worked around: the label truncates like any other text (`ConsoleView`'s bar no
    /// longer pins it at its full width), and no abbreviation is invented for it here.
    func testEveryTargetBeingGoneIsLabelledAndReadAsTheCardReadsIt() {
        let summary = StickySummary.of(text: F.endWake("UNRESOLVABLE"))
        XCTAssertEqual(summary.label, "↑ Watch stopped: every target is gone")
        XCTAssertEqual(summary.text,
                       "Every target it watched was deleted, so its condition can never be decided.")
    }

    // MARK: the turns the control plane opens

    /// A background job's wake is read off the recorded note, not the turn's text: the block IS the
    /// turn, and the person's words are empty.
    func testABackgroundJobIsLabelledAndReadAsItsCardReadsIt() {
        let summary = StickySummary.of(text: "", note: Self.jobNote)
        XCTAssertEqual(summary.label, "↑ Background job failed")
        XCTAssertEqual(summary.text, "pg matrix exited 124.")
    }

    func testAScheduledWakeupIsLabelledAndReadAsItsCardReadsIt() {
        let summary = StickySummary.of(text: "", note: Self.wakeupNote)
        XCTAssertEqual(summary.label, "↑ Scheduled wakeup")
        XCTAssertEqual(summary.text, "watching CI run")
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

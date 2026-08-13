import XCTest
@testable import OrbitKit

/// What the auto-retry card says and offers, across the states one outage moves through: armed →
/// firing → gave up, plus the two the user can cause (switched off, and the session moving on).
final class AutoRetryLogicTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000_000)
    private let quotaMsg = "You've hit your session limit · resets 6:20pm (Europe/Berlin)"
    private let apiMsg = "API Error: 529 {\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}"

    private func notice(_ variant: AutoRetryNotice.Variant, stale: Bool = false,
                        afterUserMsg: Bool = false) -> AutoRetryNotice {
        AutoRetryNotice(id: "i1", message: variant == .quota ? quotaMsg : apiMsg,
                        variant: variant, seq: 7, stale: stale, afterUserMsg: afterUserMsg)
    }

    private func state(_ n: AutoRetryNotice, live: Bool = true, retryAt: Date? = nil,
                       attempts: Int = 0, hasRetryText: Bool = true) -> AutoRetryLogic.State {
        AutoRetryLogic.state(notice: n, live: live, retryAt: retryAt, attempts: attempts,
                             provider: "deepseek", runnerName: "wikova", hasRetryText: hasRetryText,
                             now: now, rand: { 0 })
    }

    /// While a retry is armed the card is a status, not an alarm: neutral, counting down, with the
    /// switch offered so it can be turned off.
    func testArmedQuotaIsNeutralAndCountsDown() {
        let s = state(notice(.quota), retryAt: now.addingTimeInterval(660))
        XCTAssertTrue(s.armed)
        XCTAssertFalse(s.firing)
        XCTAssertFalse(s.needsYou, "handled — nothing is being asked of the reader")
        XCTAssertEqual(s.title, "5-hour limit reached")
        XCTAssertEqual(s.body, "The 5-hour quota for deepseek on “wikova” is used up.")
        XCTAssertEqual(s.countdown, "in 11 min")
        XCTAssertTrue(s.showsResetAt, "a quota leads with the moment its window resets")
        XCTAssertFalse(s.showsMessage, "the quota's own sentence is already restated in the body")
        XCTAssertTrue(s.showsAutoRow)
        XCTAssertEqual(s.retryNowTitle, "Retry now anyway")
        XCTAssertEqual(s.retryNowNote, "The quota hasn’t reset yet — this will likely fail again.")
    }

    /// A provider error leads with the error itself — which one it was is the only thing the reader
    /// can act on if it keeps happening — and its couple of minutes need no absolute time.
    func testArmedApiErrorShowsTheErrorVerbatim() {
        let s = state(notice(.apiError), retryAt: now.addingTimeInterval(30))
        XCTAssertEqual(s.title, "Provider unavailable")
        XCTAssertEqual(s.body, "The deepseek API could not answer — nothing about your message caused it.")
        XCTAssertTrue(s.showsMessage)
        XCTAssertFalse(s.showsResetAt)
        XCTAssertEqual(s.countdown, "in 30 sec")
        XCTAssertEqual(s.autoLabel, "Auto-retry — this usually clears")
    }

    /// Its moment has passed: the server is re-sending right now, so the card stops offering a
    /// manual retry that would race it.
    func testFiringDropsTheManualRetry() {
        let s = state(notice(.apiError), retryAt: now.addingTimeInterval(-1))
        XCTAssertTrue(s.firing)
        XCTAssertFalse(s.armed)
        XCTAssertFalse(s.needsYou, "something IS happening — this is not the reader's problem yet")
        XCTAssertNil(s.retryNowTitle)
        XCTAssertNil(s.countdown)
    }

    /// Nothing armed and the attempts spent: the ball is back in the user's court, so the card
    /// escalates and stops offering a switch that would do nothing.
    func testGaveUpEscalatesAndOffersNoSwitch() {
        let s = state(notice(.apiError), retryAt: nil, attempts: 3)
        XCTAssertTrue(s.gaveUp)
        XCTAssertTrue(s.needsYou)
        XCTAssertFalse(s.canArm)
        XCTAssertFalse(s.showsAutoRow)
        XCTAssertEqual(s.title, "Auto-retry gave up")
        XCTAssertEqual(s.body, "Tried 3 times — the API is still failing. Over to you.")
        XCTAssertEqual(s.retryNowTitle, "Retry now")
    }

    /// Switched off by the user: still open, still theirs to move, but flippable — and the re-armed
    /// instant is re-derived from the same reply the server read it off.
    func testSwitchedOffCanBePutBack() {
        let s = state(notice(.quota), retryAt: nil, attempts: 1)
        XCTAssertFalse(s.armed)
        XCTAssertTrue(s.needsYou)
        XCTAssertTrue(s.canArm)
        XCTAssertTrue(s.showsAutoRow, "off is rendered, not implied by the row disappearing")
        XCTAssertEqual(s.autoDetail, "Off — nothing will re-send until you do.")
        XCTAssertNotNil(s.rearmAt)
        XCTAssertTrue(s.body.hasSuffix("Auto-retry is off."))
    }

    /// A Codex quota names no zone, so no moment can be determined — the switch is not offered
    /// rather than offered dead.
    func testNoParsableResetMeansNoRearm() {
        let n = AutoRetryNotice(id: "i1", message: "You've hit your usage limit. Try again later.",
                                variant: .quota, seq: 3)
        let s = state(n, retryAt: nil)
        XCTAssertNil(s.rearmAt)
        XCTAssertFalse(s.canArm)
        XCTAssertFalse(s.showsAutoRow)
    }

    /// A card the session moved past is history: no countdown, no controls, no alarm — even while
    /// the session has a retry armed for a LATER failure.
    func testStaleCardIsHistoryNotAnAlarm() {
        let s = state(notice(.quota, stale: true), live: false, retryAt: now.addingTimeInterval(600))
        XCTAssertFalse(s.armed)
        XCTAssertFalse(s.needsYou)
        XCTAssertFalse(s.showsAutoRow)
        XCTAssertNil(s.countdown)
        XCTAssertNil(s.retryNowTitle)
    }

    /// The bubble that would be re-sent sits directly above — quoting it inside the card is the
    /// same sentence twice, and it is the tallest thing in there.
    func testQuoteIsSuppressedWhenTheMessageIsRightAbove() {
        XCTAssertFalse(state(notice(.quota, afterUserMsg: true)).quotesRetryText)
        XCTAssertTrue(state(notice(.quota, afterUserMsg: false)).quotesRetryText)
        XCTAssertFalse(state(notice(.quota), hasRetryText: false).quotesRetryText,
                       "nothing to re-send — a first-run failure whose prompt never became a bubble")
    }

    /// Seconds matter: a provider-error retry is 30 seconds out, and rounding that up to "in 1 min"
    /// reads as a countdown that isn't moving.
    func testCountdownWording() {
        XCTAssertEqual(AutoRetryLogic.countdownText(seconds: 27), "in 27 sec")
        XCTAssertEqual(AutoRetryLogic.countdownText(seconds: 0.4), "in 1 sec")
        XCTAssertEqual(AutoRetryLogic.countdownText(seconds: 61), "in 2 min")
        XCTAssertEqual(AutoRetryLogic.countdownText(seconds: 3 * 3600), "in 3 hr")
        XCTAssertEqual(AutoRetryLogic.countdownText(seconds: 3 * 86_400), "in 3 days")
    }

    /// Naming the wrong window tells the user to wait days for a quota that comes back in hours.
    func testQuotaWindowIsNamedByItsLength() {
        XCTAssertEqual(AutoRetryLogic.quotaWindow("You've hit your session limit · resets 6pm (UTC)").title,
                       "5-hour limit reached")
        XCTAssertEqual(AutoRetryLogic.quotaWindow("You've hit your weekly limit · resets 1pm (UTC)").title,
                       "Weekly limit reached")
        XCTAssertEqual(AutoRetryLogic.quotaWindow("You've hit your usage limit.").title,
                       "Usage limit reached")
    }
}

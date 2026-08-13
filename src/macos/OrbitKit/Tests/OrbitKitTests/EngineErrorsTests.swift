import XCTest
@testable import OrbitKit

/// Telling the three prose-shaped failures apart. Each arrives as an ordinary assistant reply with
/// a `success` result, so this classification is the only thing standing between the user and a
/// transcript where the agent appears to answer "API Error: 529". Kept in step with the same
/// predicates in @orbit/shared (events.ts / retry.ts).
final class EngineErrorsTests: XCTestCase {

    func testApiErrorTextKeysOnThePrefix() {
        XCTAssertTrue(EngineErrors.isApiErrorText("API Error: 500 Internal server error"))
        XCTAssertTrue(EngineErrors.isApiErrorText("  API Error: 529"), "leading whitespace is still the prefix")
        XCTAssertFalse(EngineErrors.isApiErrorText("The API Error you asked about is a 500"),
                       "a reply that mentions one is an ordinary reply")
        XCTAssertFalse(EngineErrors.isApiErrorText(nil))
        XCTAssertFalse(EngineErrors.isApiErrorText(""))
    }

    /// The status, when there is one, is authoritative: a 400 whose message happens to contain the
    /// word "timeout" is still a 400, and re-sending it burns quota reproducing the same failure.
    func testRetryableOnlyForTheProviderSFaults() {
        XCTAssertTrue(EngineErrors.isRetryableApiErrorText("API Error: 529 {\"type\":\"overloaded_error\"}"))
        XCTAssertTrue(EngineErrors.isRetryableApiErrorText("API Error: 500 Internal server error"))
        XCTAssertTrue(EngineErrors.isRetryableApiErrorText("API Error: 429 rate limited"))
        XCTAssertFalse(EngineErrors.isRetryableApiErrorText("API Error: 400 prompt is too long — timeout"))
        XCTAssertFalse(EngineErrors.isRetryableApiErrorText("API Error: 401 invalid x-api-key"))
        XCTAssertFalse(EngineErrors.isRetryableApiErrorText("API Error: 404 model not found"))
    }

    /// A transport failure never reached a response to have a status, so its wording is all there is.
    func testRetryableFromWordingWhenThereIsNoStatus() {
        XCTAssertTrue(EngineErrors.isRetryableApiErrorText("API Error: Connection error."))
        XCTAssertTrue(EngineErrors.isRetryableApiErrorText("API Error: connection closed mid-response"))
        XCTAssertTrue(EngineErrors.isRetryableApiErrorText("API Error: Overloaded"))
        XCTAssertFalse(EngineErrors.isRetryableApiErrorText("API Error: content filtered"),
                       "an error we cannot place is not retried — the default is a plain error line")
        XCTAssertFalse(EngineErrors.isRetryableApiErrorText("Connection error."),
                       "not an API error at all")
    }

    /// The reply must OPEN with the provider's sentence. An answer that investigates a quota quotes
    /// one mid-paragraph, and rendering that as the provider refusing to answer would replace the
    /// reply with a card saying the opposite of what it says.
    func testUsageLimitMustOpenTheReply() {
        XCTAssertTrue(EngineErrors.isUsageLimitErrorText(
            "You've hit your session limit · resets 6:20pm (Europe/Berlin)"))
        XCTAssertTrue(EngineErrors.isUsageLimitErrorText("You've hit your weekly limit · resets 1pm (UTC)"))
        XCTAssertTrue(EngineErrors.isUsageLimitErrorText(
            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage"))
        XCTAssertFalse(EngineErrors.isUsageLimitErrorText(
            "I checked the logs and the run failed because the account had hit your usage limit yesterday."))
    }

    /// Three spaced attempts, then the session goes back to the user rather than spending more of
    /// their quota on an error that clearly is not the transient kind.
    func testApiErrorBackoffLadderThenGivesUp() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let noJitter = { 0.0 }
        XCTAssertEqual(EngineErrors.apiErrorRetryAt(attempts: 0, now: now, rand: noJitter),
                       now.addingTimeInterval(30))
        XCTAssertEqual(EngineErrors.apiErrorRetryAt(attempts: 1, now: now, rand: noJitter),
                       now.addingTimeInterval(120))
        XCTAssertEqual(EngineErrors.apiErrorRetryAt(attempts: 2, now: now, rand: noJitter),
                       now.addingTimeInterval(300))
        XCTAssertNil(EngineErrors.apiErrorRetryAt(attempts: 3, now: now, rand: noJitter))
        XCTAssertEqual(EngineErrors.maxApiErrorRetries, 3)
    }

    /// The jitter spreads sessions that all came due at once — an overload is a fact about the
    /// provider, so releasing every session that hit it in lockstep reproduces it.
    func testApiErrorRetryJitterStaysInsideItsStep() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let at = EngineErrors.apiErrorRetryAt(attempts: 0, now: now, rand: { 0.99 })
        let delay = at!.timeIntervalSince(now)
        XCTAssertGreaterThanOrEqual(delay, 30)
        XCTAssertLessThanOrEqual(delay, 30 * 1.25)
    }

    private func berlin(_ y: Int, _ mo: Int, _ d: Int, _ h: Int, _ mi: Int) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Berlin")!
        return cal.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi))!
    }

    /// A bare time is today's in the runtime's zone…
    func testQuotaResetParsesABareTimeToday() {
        let now = berlin(2026, 8, 12, 14, 0)
        let at = EngineErrors.parseQuotaResetAt(
            "You've hit your session limit · resets 6:20pm (Europe/Berlin)", now: now)
        XCTAssertEqual(at, berlin(2026, 8, 12, 18, 20))
    }

    /// …unless it already passed there, which means tomorrow (the runtime omits the date when the
    /// reset is today, so a time in the past can only be the next day's).
    func testQuotaResetRollsToTomorrowWhenTheTimeHasPassed() {
        let now = berlin(2026, 8, 12, 22, 0)
        let at = EngineErrors.parseQuotaResetAt(
            "You've hit your session limit · resets 6:20pm (Europe/Berlin)", now: now)
        XCTAssertEqual(at, berlin(2026, 8, 13, 18, 20))
    }

    /// The date appears only when the reset is not today; the year is never printed.
    func testQuotaResetParsesADatedReset() {
        let now = berlin(2026, 8, 1, 9, 0)
        let at = EngineErrors.parseQuotaResetAt(
            "You've hit your weekly limit · resets Aug 3, 1pm (Europe/Berlin)", now: now)
        XCTAssertEqual(at, berlin(2026, 8, 3, 13, 0))
    }

    /// No zone, no instant. Codex names none ("try again at Aug 9th, 2026 1:26 PM"), so its card
    /// offers no re-arm rather than one pinned to a guess.
    func testQuotaResetGivesUpWithoutAParsableZone() {
        let now = berlin(2026, 8, 12, 14, 0)
        XCTAssertNil(EngineErrors.parseQuotaResetAt(
            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase "
            + "more credits or try again at Aug 9th, 2026 1:26 PM.", now: now))
        XCTAssertNil(EngineErrors.parseQuotaResetAt("resets 6:20pm (Mars/Olympus)", now: now))
        XCTAssertNil(EngineErrors.parseQuotaResetAt(nil, now: now))
    }
}

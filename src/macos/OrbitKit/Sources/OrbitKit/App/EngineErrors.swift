import Foundation

/// Failures a runtime reports as ordinary assistant text, and what may be done about them.
///
/// A spent quota, an overloaded provider and a content-filtered request all arrive as a plain
/// `assistant` message with a `success` result — nothing upstream marks the turn as failed — so a
/// transcript that renders them verbatim shows the agent apparently answering "API Error: 529".
/// Telling them apart is what lets the reply become an error line (an error to read) or an
/// auto-retry card (a pause that fixes itself).
///
/// Keep in sync with `isApiErrorText` / `isRetryableApiErrorText` / `isUsageLimitErrorText` in
/// @orbit/shared (src/shared/src/events.ts) and the retry timing in src/shared/src/retry.ts — the
/// card promises what the server's sweeper will actually do, so the two must agree.
public enum EngineErrors {

    /// Does this text carry an API error (content filtering, a 4xx/5xx)? Keys on the stable
    /// `API Error:` prefix Claude Code uses. Heuristic, intentionally narrow.
    public static func isApiErrorText(_ text: String?) -> Bool {
        guard let text else { return false }
        return text.drop(while: { $0.isWhitespace }).hasPrefix("API Error")
    }

    /// HTTP statuses an `API Error:` line may carry that describe the *provider*, not this request:
    /// 529 is Anthropic's "overloaded", 500/502/503/504 the generic upstream failures, 408/429 mean
    /// the call was early rather than wrong. Every one succeeds on a plain re-send once the far side
    /// recovers. Deliberately absent: 400 (context overflow / content filtering), 401/403 and 404 —
    /// facts about the request that a re-send reproduces exactly.
    private static let retryableStatuses: Set<Int> = [408, 429, 500, 502, 503, 504, 529]

    /// Transport-level phrasings that carry no status code — the call never reached a response to
    /// have one. Only wording actually observed is listed: a missing entry costs a manual retry,
    /// a guessed one costs a silent retry loop.
    private static let retryableMarkers = [
        "mid-response", "mid-stream",     // the stream died between request and reply
        "connection error", "timed out", "timeout",
        "internal server error",          // a 500 in prose, when there was no response to read a status off
        "overloaded",                     // likewise a 529
    ]

    private static let statusPattern = try? NSRegularExpression(pattern: "^\\s*api error:?\\s*(\\d{3})\\b")

    /// Is this the transient kind — the provider briefly unable to answer, rather than anything
    /// about the message? Such a failure says nothing about the work, which is what makes it safe to
    /// re-send on the user's behalf. Default is NOT retryable: guessing wrong means an automatic
    /// loop re-sending into a wall.
    public static func isRetryableApiErrorText(_ text: String?) -> Bool {
        guard let text, isApiErrorText(text) else { return false }
        let lower = text.lowercased()
        // The status, when there is one, is authoritative: a 400 whose message happens to contain
        // the word "timeout" is still a 400.
        if let status = statusPattern.flatMap({ re -> Int? in
            let range = NSRange(lower.startIndex..., in: lower)
            guard let m = re.firstMatch(in: lower, range: range), m.numberOfRanges > 1,
                  let r = Range(m.range(at: 1), in: lower) else { return nil }
            return Int(lower[r])
        }) {
            return retryableStatuses.contains(status)
        }
        return retryableMarkers.contains { lower.contains($0) }
    }

    /// Wording, in the provider's own words, marking a run killed by an exhausted account quota.
    /// Only messages observed in the wild are listed — add one when a new runtime's shows up rather
    /// than guessing at its phrasing.
    private static let usageLimitMarkers = [
        "hit your usage limit",     // Codex app-server
        "hit your session limit",   // Claude Code, rolling 5-hour window
        "hit your weekly limit",    // Claude Code, 7-day window
    ]

    /// How far in the quota sentence may begin. Every phrasing leads with "You've " and nothing
    /// else, so this is an allowance for a variant lead-in, not a search window: past it the marker
    /// is the model *quoting* a quota error, and rendering that reply as the provider refusing to
    /// answer replaces it with a card saying the opposite of what it says.
    private static let usageLimitMaxOffset = 40

    /// Was this run killed by the account's quota running out? The reply must *open* with the
    /// provider's sentence, not merely contain it.
    public static func isUsageLimitErrorText(_ text: String?) -> Bool {
        guard let text else { return false }
        let lower = text.drop(while: { $0.isWhitespace }).lowercased()
        return usageLimitMarkers.contains { marker in
            guard let r = lower.range(of: marker) else { return false }
            return lower.distance(from: lower.startIndex, to: r.lowerBound) <= usageLimitMaxOffset
        }
    }

    /// How long to wait before re-sending a message a transient provider error killed, indexed by
    /// attempts already spent. Seconds, not the quota's minutes: an overloaded API is usually back
    /// within one, and a failure the user is watching should not sit visibly idle longer than the
    /// thing it waits on. The length is also the cap.
    private static let apiErrorBackoff: [TimeInterval] = [30, 2 * 60, 5 * 60]

    /// How many auto-retries a transient provider error gets before it is handed back.
    public static var maxApiErrorRetries: Int { apiErrorBackoff.count }

    /// When a re-send after a transient provider error would fire, or nil once the attempts are
    /// spent. The jitter is the same precaution the server takes: an overload is a fact about the
    /// provider, so every session that hit it comes due at once, and releasing them in lockstep
    /// reproduces it.
    public static func apiErrorRetryAt(attempts: Int, now: Date,
                                       rand: () -> Double = { .random(in: 0..<1) }) -> Date? {
        guard attempts >= 0, attempts < apiErrorBackoff.count else { return nil }
        let step = apiErrorBackoff[attempts]
        return now.addingTimeInterval(step + (rand() * step * 0.25).rounded(.down))
    }

    /// Claude Code's own rendering of when the quota comes back:
    ///   "You've hit your session limit · resets 6:20pm (Europe/Berlin)"
    ///   "You've hit your weekly limit · resets Aug 3, 1pm (Europe/Berlin)"
    /// The date appears only when the reset is not today; the parenthesised zone is an IANA name.
    private static let resetsAt = try? NSRegularExpression(
        pattern: "resets\\s+(?:([A-Za-z]{3})[a-z]*\\.?\\s+(\\d{1,2}),\\s*)?(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?m\\.?\\s*\\(([^)]+)\\)",
        options: [.caseInsensitive])

    private static let months = ["jan", "feb", "mar", "apr", "may", "jun",
                                 "jul", "aug", "sep", "oct", "nov", "dec"]

    /// When the quota comes back, read out of the runtime's own message. Nil when the text carries
    /// no parsable reset time — including every Codex phrasing, which names no time zone
    /// ("try again at Aug 9th, 2026 1:26 PM") and so cannot be pinned to an instant.
    ///
    /// This is the *fallback* source, used to re-derive the moment a re-armed retry should fire.
    /// The authoritative one is the server's own armed `retryAt`; this exists because cancelling
    /// drops the server's copy, so putting the switch back needs the instant computed again.
    ///
    /// The runtime omits the date when the reset is today, so a bare time already past in its zone
    /// means tomorrow. A dated one already past means next year (the year is never printed).
    public static func parseQuotaResetAt(_ text: String?, now: Date) -> Date? {
        guard let text, let re = resetsAt else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let m = re.firstMatch(in: text, range: range) else { return nil }
        func group(_ i: Int) -> String? {
            guard let r = Range(m.range(at: i), in: text) else { return nil }
            return String(text[r])
        }
        guard let hourStr = group(3), let meridiem = group(5), let zoneName = group(6),
              let zone = TimeZone(identifier: zoneName),   // unknown IANA zone: no guessing
              let hour12 = Int(hourStr), (1...12).contains(hour12) else { return nil }
        let hour = (hour12 % 12) + (meridiem.lowercased() == "p" ? 12 : 0)
        let minute = group(4).flatMap { Int($0) } ?? 0
        guard minute <= 59 else { return nil }

        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        func at(year: Int, month: Int, day: Int) -> Date? {
            cal.date(from: DateComponents(year: year, month: month, day: day,
                                          hour: hour, minute: minute, second: 0))
        }
        if let monName = group(1), let dayStr = group(2), let day = Int(dayStr) {
            guard let month = months.firstIndex(of: monName.lowercased()) else { return nil }
            let year = cal.component(.year, from: now)
            guard let dated = at(year: year, month: month + 1, day: day) else { return nil }
            // A printed date that already passed is next year's — the runtime never prints one.
            return dated >= now ? dated : at(year: year + 1, month: month + 1, day: day)
        }
        let today = cal.dateComponents([.year, .month, .day], from: now)
        guard let y = today.year, let mo = today.month, let d = today.day,
              let bare = at(year: y, month: mo, day: d) else { return nil }
        return bare > now ? bare : cal.date(byAdding: .day, value: 1, to: bare)
    }
}

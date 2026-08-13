import Foundation

/// Relative timestamp shown under a user bubble — a 1:1 port of the web transcript's `relTime`:
/// "just now", "5m ago", "3h ago", "2d ago", "1w ago"; older than ~4 weeks falls back to a short
/// absolute month/day. Pure (now is injectable) so it's deterministic in tests.
public enum RelativeTime {
    public static func format(_ iso: String, now: Date = Date()) -> String? {
        guard let date = parse(iso) else { return nil }
        let diff = now.timeIntervalSince(date)
        let min = 60.0, hour = 3600.0, day = 86_400.0, week = 604_800.0
        if diff < min  { return "just now" }
        if diff < hour { return "\(Int(diff / min))m ago" }
        if diff < day  { return "\(Int(diff / hour))h ago" }
        if diff < week { return "\(Int(diff / day))d ago" }
        if diff < 4 * week { return "\(Int(diff / week))w ago" }
        return monthDay.string(from: date)
    }

    // Formatters are built ONCE and reused. Each `ISO8601DateFormatter()` spins up an ICU date
    // parser, which is orders of magnitude more expensive than the parse itself — and these sit on
    // the app's hottest paths: the recency sort behind the drawer's Recents (which called this from
    // inside a `sorted` comparator, so O(n log n) formatters per render), the session list's time
    // bucketing, every row's relative time, and every transcript bubble's timestamp. Allocating per
    // call was tens of milliseconds of main-thread work per list refresh with many open sessions.
    //
    // Sharing them is safe because each is fully configured here and never mutated afterwards — a
    // Foundation formatter is only unsafe while being reconfigured. That's exactly why the two
    // `formatOptions` variants are two instances: `parse` used to re-assign `formatOptions` on one
    // formatter for its second attempt, which a shared instance must not do.
    private static let iso8601Fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let iso8601Whole: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let monthDay: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "M/d"
        return f
    }()

    /// ISO-8601 from the runner — try with then without fractional seconds (some payloads omit it).
    /// Shared (not private) so recency sorting (`RecentsLogic`) and the app-side models that read a
    /// timestamp off a DTO (the auto-retry card's `retryAt`) parse them all the same way.
    public static func parse(_ iso: String) -> Date? {
        iso8601Fractional.date(from: iso) ?? iso8601Whole.date(from: iso)
    }
}

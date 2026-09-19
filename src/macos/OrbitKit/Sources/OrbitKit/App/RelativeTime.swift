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

    /// How long something has been going, for a row that is still doing it: "8s", "12m", "2h",
    /// "3d". Deliberately not `format`'s wording — "12m ago" would date a finished event, while
    /// this is a duration that is still running. No "just now" floor either: the first minute is
    /// where a turn that is about to come straight back looks different from one settling in.
    public static func elapsed(_ iso: String, now: Date = Date()) -> String? {
        guard let date = parse(iso) else { return nil }
        let diff = max(0, now.timeIntervalSince(date))
        let min = 60.0, hour = 3600.0, day = 86_400.0
        if diff < min  { return "\(Int(diff))s" }
        if diff < hour { return "\(Int(diff / min))m" }
        if diff < day  { return "\(Int(diff / hour))h" }
        return "\(Int(diff / day))d"
    }

    /// A span in the web's own words: "45s", "12m", "3h 20m", "23h", "2d 4h", "12d"
    /// (`src/web/src/lib/watches.ts` `formatSpan`). Ported rather than approximated because both
    /// clients write the same sentences around it — "waiting 3h 20m", "asked 2h 10m ago" — and two
    /// roundings of one duration read as two different facts.
    public static func span(_ seconds: TimeInterval) -> String {
        let abs = Swift.max(0, seconds)
        let minute = 60.0, hour = 3600.0, day = 86_400.0
        if abs < minute { return "\(Swift.max(1, Int(abs)))s" }
        if abs < hour { return "\(Int(abs / minute))m" }
        if abs < day {
            let h = Int(abs / hour)
            let m = Int(abs.truncatingRemainder(dividingBy: hour) / minute)
            return h < 6 && m > 0 ? "\(h)h \(m)m" : "\(h)h"
        }
        let d = Int(abs / day)
        let h = Int(abs.truncatingRemainder(dividingBy: day) / hour)
        return d < 3 && h > 0 ? "\(d)d \(h)h" : "\(d)d"
    }

    /// "just now" under ten seconds, "3h 20m ago" above it — the web's `ago`, for the footnotes
    /// the two clients share. Nil when the instant cannot be read at all.
    public static func ago(_ iso: String, now: Date = Date()) -> String? {
        guard let date = parse(iso) else { return nil }
        let diff = now.timeIntervalSince(date)
        return diff < 10 ? "just now" : "\(span(diff)) ago"
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

import Foundation

/// What a stretch of reasoning says on its folded row.
///
/// A bare "Thinking" told a reader nothing about whether opening it was worth it, and a turn
/// stacks ten of them (measured on this deployment: a DeepSeek turn closes 10 blocks at the
/// median, 51 at p90, totalling 23k characters at the median and 122k at p90). The row states how
/// long the stretch took and how much it came to, so that judgement can be made without opening it.
///
/// The web twin is `src/web/src/lib/thinkingDraft.ts`; the wording is deliberately identical, so a
/// reader moving between the clients reads the same row.
///
/// Duration comes from the runner's own event clock (`RunEvent.ts` on the first `thinking_delta`
/// and on the durable `thinking` that closes the block) rather than from `Date()`, so it stays a
/// pure function of the stream and a reload of a persisted transcript reports the same number.
public enum ThinkingSummary {
    /// The runner stamps `2026-09-15T17:51:52.123Z`; a formatter without `.withFractionalSeconds`
    /// returns nil for exactly that shape, so both are tried.
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoWhole = ISO8601DateFormatter()

    public static func date(_ stamp: String?) -> Date? {
        guard let stamp else { return nil }
        return isoFractional.date(from: stamp) ?? isoWhole.date(from: stamp)
    }

    /// Seconds between two stamps. Nil when either is missing or unparseable, or when they do not
    /// advance — a stretch is reported with no duration rather than with a wrong one.
    public static func elapsed(from: String?, to: String?) -> TimeInterval? {
        guard let start = date(from), let end = date(to), end > start else { return nil }
        return end.timeIntervalSince(start)
    }

    /// Whole seconds under a minute. Never "0s": rounding a 400ms block to zero reads as "it did
    /// not happen".
    public static func duration(_ seconds: TimeInterval) -> String {
        let total = max(1, Int(seconds.rounded()))
        if total < 60 { return "\(total)s" }
        let minutes = total / 60
        let rest = total % 60
        return rest == 0 ? "\(minutes)m" : "\(minutes)m \(rest)s"
    }

    /// Size in characters rather than words: the reasoning is as often CJK as English, and a word
    /// count reads as 1 for a whole Chinese paragraph.
    public static func size(_ chars: Int) -> String {
        if chars < 1000 { return "\(chars) chars" }
        let thousands = String(format: "%.1f", Double(chars) / 1000)
        let trimmed = thousands.hasSuffix(".0") ? String(thousands.dropLast(2)) : thousands
        return "\(trimmed)k chars"
    }

    /// The whole row for a settled stretch: `Thought for 1m 47s · 3 blocks · 21k chars`. The block
    /// count appears only when blocks were folded together, and the duration only when the clock
    /// that measured it survived.
    public static func settledLabel(chars: Int, blocks: Int, startedTs: String?, finishedTs: String?) -> String {
        var parts: [String] = []
        if let seconds = elapsed(from: startedTs, to: finishedTs) {
            parts.append("Thought for \(duration(seconds))")
        } else {
            parts.append("Thought")
        }
        if blocks > 1 { parts.append("\(blocks) blocks") }
        parts.append(size(chars))
        return parts.joined(separator: " · ")
    }
}

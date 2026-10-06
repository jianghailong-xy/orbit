import Foundation

/// The part of the sticky "↑ Your question" header's decision that has to hold still while the
/// header itself moves the transcript.
///
/// The header is an in-flow inset: showing it pushes the list down by its height, hiding it lets the
/// list back up. A rule that reads the list's geometry to decide whether to show the header therefore
/// reads geometry the header has just changed, and where the two readings disagree it flips on every
/// frame. That froze the iPhone app on 2026-10-06 (task ⑥'s screenshot probe, sampled on the
/// simulator): a coordinator conversation whose "Is this project done?" card became its far shorter
/// receipt was left barely taller than the screen, with a card — a row that claims no top line —
/// under the top edge. With the header shown the list's offset read -66, with it hidden 81, either
/// side of the single 40-point threshold, and the main thread laid the list out again some sixty
/// times a second until the app was killed.
///
/// So each way out of a state gets its own threshold, far enough apart that the header's own move
/// cannot carry the reading across both.
public enum StickyQuestionHold {
    /// With no row claiming the top line, the offset a hidden header has to pass before it shows:
    /// far enough that hiding it again — which moved the measured offset by 147 points — cannot bring
    /// the reading back under `fallbackHideAt`. A transcript opened at the end of a long conversation
    /// is far past it; one barely taller than the screen never reaches it, and is short enough that
    /// its question is in view anyway.
    public static let fallbackShowAfter: Double = 400
    /// …and the offset at or under which a shown one hides: the list is back at its top.
    public static let fallbackHideAt: Double = 40

    /// Whether the fallback — no row has claimed the top line yet — names the last question, given
    /// whether the header is showing now.
    public static func fallbackNames(contentOffset: Double, showing: Bool) -> Bool {
        contentOffset > (showing ? fallbackHideAt : fallbackShowAfter)
    }

    /// The question to name once the row under the top line has answered `found`: that answer —
    /// except that a question the header names already, straddling the top line itself, stays named.
    /// Hiding the header there would let the list up by the header's height, put the row below the
    /// question back under the line, and name the same question again on the next frame.
    public static func named(found: String?, anchor: String, showing stuck: String?) -> String? {
        if found == nil, let stuck, anchor == stuck { return stuck }
        return found
    }
}

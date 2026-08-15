import Foundation

// Separating what a person typed from what Orbit appended to it.
//
// Two features add context to a message at delivery — `#`-reference expansion and a task list's
// condition board. Both deliberately leave the stored turn alone, so the durable record of what
// was sent is the person's own words. But the runner echoes what it *received* into the
// transcript, and the transcript is what a client renders: the result was a one-line question
// followed by a block of generated status text, inside the user's own bubble, looking for all the
// world like they had typed it.
//
// Web fixes this in `src/web/src/lib/deliveredMessage.ts`; this is the same rule for iOS and
// macOS, which share OrbitKit. It matters more here than it looks: the reducer falls back to
// comparing message text when reconciling an optimistic bubble against its durable event, and on
// iOS those two race. An unsplit body never equals the text the person typed, so a `#`-reference
// message would strand its bubble on "Sending…" and append a duplicate beside it.

/// The blocks Orbit appends at delivery. Nothing else is ever removed from a person's message.
let injectedTags = ["referenced-list", "referenced-task", "list-conditions"]

public struct DeliveredMessage: Equatable, Sendable {
    /// What the person typed.
    public let text: String
    /// What was appended to it, verbatim and in the order it was appended.
    public let injected: [String]
}

/// Split a delivered message into what was typed and what was appended to it.
///
/// Works backwards from the end — where delivery appends — rather than matching anywhere, because
/// a person is entitled to write `<list-conditions>` in the middle of a sentence without having it
/// silently eaten.
///
/// Finding the closing tag first and then its opening, rather than one pattern spanning both, is
/// what makes two *identical adjacent* blocks come out as two: a single pattern with a
/// backreference and an end anchor has its lazy middle expand straight past the first close to
/// reach the anchor, swallowing both into one. A message naming two tasks produces exactly that.
public func splitDeliveredMessage(_ raw: String) -> DeliveredMessage {
    var text = raw
    var injected: [String] = []
    while true {
        guard let (tag, closeRange) = trailingCloseTag(in: text) else { break }
        let opening = "\n\n<\(tag)"
        guard let openRange = text.range(of: opening, options: .backwards,
                                         range: text.startIndex..<closeRange.lowerBound) else { break }
        // `<tag>` or `<tag ...>`, never `<tag-something-else>`.
        let afterName = openRange.upperBound
        guard afterName < text.endIndex,
              text[afterName] == ">" || text[afterName].isWhitespace else { break }
        let block = String(text[openRange.lowerBound..<closeRange.upperBound])
        injected.insert(block.trimmingCharacters(in: .whitespacesAndNewlines), at: 0)
        text = String(text[text.startIndex..<openRange.lowerBound])
    }
    return DeliveredMessage(text: text, injected: injected)
}

/// The tag whose closing element ends `text` (ignoring trailing whitespace), and that element's
/// range. Nil when the string does not end in one of ours.
private func trailingCloseTag(in text: String) -> (tag: String, range: Range<String.Index>)? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    for tag in injectedTags {
        let close = "\n</\(tag)>"
        guard trimmed.hasSuffix("</\(tag)>"),
              let range = text.range(of: close, options: .backwards) else { continue }
        // Only when nothing but whitespace follows it — delivery appends at the end, and matching
        // mid-string would eat a tag the person wrote themselves.
        let rest = text[range.upperBound...]
        guard rest.allSatisfy({ $0.isWhitespace }) else { continue }
        return (tag, range)
    }
    return nil
}

private let injectedTagLabels: [String: String] = [
    "referenced-list": "referenced list",
    "referenced-task": "referenced task",
    "list-conditions": "list conditions",
]

/// "referenced list, list conditions ×2" — what was attached, counted where it repeats.
///
/// Named rather than merely counted: "2 blocks attached" tells the reader nothing about why the
/// reply mentions something they never asked about, which is the entire reason this line exists.
public func describeInjected(_ blocks: [String]) -> String {
    var order: [String] = []
    var counts: [String: Int] = [:]
    for block in blocks {
        let tag = injectedTags.first { block.hasPrefix("<\($0)>") || block.hasPrefix("<\($0) ") } ?? "context"
        if counts[tag] == nil { order.append(tag) }
        counts[tag, default: 0] += 1
    }
    return order.map { tag in
        let label = injectedTagLabels[tag] ?? tag
        let n = counts[tag] ?? 0
        return n > 1 ? "\(label) ×\(n)" : label
    }.joined(separator: ", ")
}

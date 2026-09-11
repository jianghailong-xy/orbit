import Foundation

// Separating what a person typed from what Orbit appended to it.
//
// Orbit can add context to a message at delivery — `#`-reference expansion, a task list's
// condition board, the background work a returning engine is told about, and the standing role of
// a conversation promoted to project coordinator. These deliberately leave the stored turn alone,
// so the durable record of what was sent is the person's own words. But the runner echoes what it
// *received* into the transcript, and the transcript is what a client renders: the result was a
// one-line question followed by a block of generated context, inside the user's own bubble, looking
// for all the world like they typed it.
//
// Where the person's words end is what the apiserver recorded when it stored the event
// (`controlPlaneNote`, see `splitRecordedNote`), never what the text happens to look like: someone
// who types a `<background-jobs>` block into the composer sees it in their bubble exactly as typed.
// An event with no note is still read the older way, from its end (`splitDeliveredMessage`), which
// is what keeps the bubbles of messages stored before notes were recorded as they were.
//
// Web fixes this in `src/web/src/lib/deliveredMessage.ts`; this is the same rule for iOS and
// macOS, which share OrbitKit. It matters more here than it looks: the reducer falls back to
// comparing message text when reconciling an optimistic bubble against its durable event, and on
// iOS those two race. An unsplit body never equals the text the person typed, so a message with
// anything appended would strand its bubble on "Sending…" and append a duplicate beside it.

/// The blocks an event with no recorded note is still read for. Nothing else is ever removed from a
/// person's message — `<list-conditions>` and `<background-jobs>` included: those two are told apart
/// by the note alone, so typing one into the composer never makes it disappear.
let injectedTags = [
    "referenced-list",
    "referenced-task",
    "orbit_project_coordinator_context",
]

public struct DeliveredMessage: Equatable, Sendable {
    /// What the person typed.
    public let text: String
    /// What was appended to it, verbatim and in the order it was appended.
    public let injected: [String]
}

/// A `user` event's text split where the apiserver recorded that the person's words end.
///
/// `controlPlaneNote` is exactly what delivery appended, stored beside an echo that is left whole,
/// so the split is a slice rather than a reading of the text. It is compared and cut byte for byte,
/// the way the apiserver cut it, and not by `Character`: a `\r` the person typed last and the `\n`
/// a note opens with are one `Character`. `note` comes back trimmed, as the block the model read.
/// Nil when the event carries no such note, or one that is not the end of its text.
public func splitRecordedNote(_ text: String?, note: String?) -> (text: String, note: String)? {
    guard let text, let note else { return nil }
    let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, text.utf8.suffix(note.utf8.count).elementsEqual(note.utf8) else { return nil }
    return (String(decoding: text.utf8.dropLast(note.utf8.count), as: UTF8.self), trimmed)
}

/// Split a delivered message into what was typed and what was appended to it.
///
/// Works backwards from the end — where delivery appends — rather than matching anywhere, because
/// a person is entitled to write `<referenced-task>` in the middle of a sentence without having it
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

/// What each of Orbit's blocks is called where it is shown — the same table as web's `TAG_LABEL`.
/// `<list-conditions>` and `<background-jobs>` have names too, though no text is ever read for
/// them: only a recorded note shows them (`describeNote`).
let injectedTagLabels: [String: String] = [
    "referenced-list": "referenced list",
    "referenced-task": "referenced task",
    "orbit_project_coordinator_context": "project coordinator context",
    "list-conditions": "list conditions",
    "background-jobs": "background jobs",
]

/// The tag `text` opens with, as `<tag>` or `<tag …>`. Nil when it opens with anything else.
private func openingTag(_ text: String) -> String? {
    guard text.first == "<" else { return nil }
    let tag = text.dropFirst().prefix { $0.isASCII && ($0.isLetter || $0.isNumber || "_-".contains($0)) }
    guard !tag.isEmpty, let next = text.dropFirst(1 + tag.count).first,
          next == ">" || next.isWhitespace else { return nil }
    return String(tag)
}

/// What a block opening with `tag` is called: its label when it is one of Orbit's, and "context"
/// when it is not.
private func blockName(_ tag: String?) -> String {
    tag.flatMap { injectedTagLabels[$0] } ?? "context"
}

/// Each name once, in the order first seen, counted where it repeats.
private func countNames(_ names: [String]) -> String {
    var order: [String] = []
    var counts: [String: Int] = [:]
    for name in names {
        if counts[name] == nil { order.append(name) }
        counts[name, default: 0] += 1
    }
    return order.map { name in
        let n = counts[name] ?? 0
        return n > 1 ? "\(name) ×\(n)" : name
    }.joined(separator: ", ")
}

/// "referenced list, referenced task ×2" — what was attached, counted where it repeats.
///
/// Named rather than merely counted: "2 blocks attached" tells the reader nothing about why the
/// reply mentions something they never asked about, which is the entire reason this line exists.
public func describeInjected(_ blocks: [String]) -> String {
    countNames(blocks.map { blockName(openingTag($0)) })
}

/// A recorded note named the same way: "background jobs, project coordinator context".
///
/// Only a name. The note was told apart from the person's words by where the apiserver recorded it
/// ends (`splitRecordedNote`), so nothing here decides what is shown as theirs. Delivery can append
/// several blocks to one message, so each is named by its opening tag and skipped past its closing
/// one; an opening that is not one of Orbit's blocks is still named, generically.
public func describeNote(_ note: String) -> String {
    var names: [String] = []
    var rest = note.trimmingCharacters(in: .whitespacesAndNewlines)
    while !rest.isEmpty {
        let tag = openingTag(rest)
        names.append(blockName(tag))
        guard let tag, let close = rest.range(of: "\n</\(tag)>") else { break }
        rest = rest[close.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return countNames(names)
}

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
// An event that carries no note is shown exactly as it was echoed. Events stored before notes were
// recorded had theirs backfilled by the apiserver's own rule (2026-09-11), so no client needs a
// reading of the text to fall back on.
//
// Web fixes this in `src/web/src/lib/deliveredMessage.ts`; this is the same rule for iOS and
// macOS, which share OrbitKit. It matters more here than it looks: the reducer falls back to
// comparing message text when reconciling an optimistic bubble against its durable event, and on
// iOS those two race. An unsplit body never equals the text the person typed, so a message with
// anything appended would strand its bubble on "Sending…" and append a duplicate beside it.

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

/// What each of Orbit's blocks is called where it is shown — the same table as web's `TAG_LABEL`.
/// None of them is ever read out of a person's text: only a recorded note shows one (`describeNote`),
/// which is also what keeps a paste of one inside the bubble it was typed into.
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

/// "referenced list, referenced task ×2" — what a recorded note holds, counted where it repeats.
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

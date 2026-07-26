import Foundation

/// Splitting a ⌘K search snippet into matched / unmatched runs, so the view can mark the match.
///
/// A direct port of the web `splitHighlight`, kept in OrbitKit so macOS and iOS share it and it can
/// be unit-tested. The server sends the snippet with its whitespace already collapsed, which is why
/// it can't also send a match offset — collapsing shifts every position — so the match is located
/// here instead.
public enum SessionSearchHighlight {
    public struct Segment: Equatable, Sendable {
        public let text: String
        public let match: Bool

        public init(text: String, match: Bool) {
            self.text = text
            self.match = match
        }
    }

    /// Split `text` into consecutive segments, marking every case-insensitive occurrence of
    /// `query`. A query that isn't found degrades to one unmatched segment — the row still renders,
    /// just without a highlight.
    public static func split(_ text: String, query: String) -> [Segment] {
        // Collapse the query the same way the server collapsed the snippet, or a query typed with a
        // double space would never be found in a snippet that now has a single one.
        let needle = query
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: " ", omittingEmptySubsequences: true)
            .joined(separator: " ")
        if text.isEmpty { return [] }
        guard !needle.isEmpty else { return [Segment(text: text, match: false)] }

        var out: [Segment] = []
        var cursor = text.startIndex
        while cursor < text.endIndex,
              let found = text.range(of: needle, options: .caseInsensitive, range: cursor..<text.endIndex) {
            if found.lowerBound > cursor {
                out.append(Segment(text: String(text[cursor..<found.lowerBound]), match: false))
            }
            out.append(Segment(text: String(text[found]), match: true))
            cursor = found.upperBound
        }
        if out.isEmpty { return [Segment(text: text, match: false)] }
        if cursor < text.endIndex {
            out.append(Segment(text: String(text[cursor...]), match: false))
        }
        return out
    }
}

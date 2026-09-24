import Foundation

// Where a card goes in a conversation, and what is left of the text around it.
//
// One more pass over `parseMarkdownBlocks`' output — the block model both app shells already render
// — so nothing here has to know how markdown is parsed, and the transcript keeps rendering the
// blocks it always did once a card is spliced in. `OrbitRenderBlock` is deliberately a wrapper and
// not new cases on `MarkdownBlock`: `OrbitApp` switches over that enum exhaustively, and it compiles
// only in CI, so a new case there would leave every open branch of that app unbuildable.
//
// What becomes a card:
//   * a bare page URL of this deployment, anywhere in a paragraph — the card takes the URL's place
//     and the words either side become paragraphs of their own. Empty fragments are dropped, so a
//     paragraph that was nothing but the URL is nothing but the card.
//   * a paragraph that is nothing but `[名字](orbit-task:<id>)` — the way an agent is instructed to
//     reference work. In a sentence, a list item or a table cell the same reference stays the name
//     link it is today: 69% of them are written mid-sentence, and a paragraph of them would be a
//     wall of cards.
//
// What does not: every other link (another site, `[名字](https://…)`, `<https://…>` to somewhere
// else), every other block type, and every path this deployment does not serve pages for.

/// A block of a rendered conversation: markdown as it always was, or a card standing where a link
/// used to be.
public enum OrbitRenderBlock: Equatable, Sendable {
    case markdown(MarkdownBlock)
    case card(OrbitLinkRef)
}

public enum OrbitLinkPlacement {
    /// The paragraph that is nothing but a reference link, and the destination it points at.
    private static let loneReference = Pattern("^\\[([^\\]]*)\\]\\((orbit-(?:task|session|project|list):[^)\\s]+)\\)$")

    /// Rewrite a parsed conversation so every link a card can stand for is one.
    ///
    /// `host` is the server this client is signed in to; a page URL naming any other host is left
    /// alone, whatever its path says.
    public static func place(_ blocks: [MarkdownBlock], host: String) -> [OrbitRenderBlock] {
        blocks.flatMap { place($0, host: host) }
    }

    private static func place(_ block: MarkdownBlock, host: String) -> [OrbitRenderBlock] {
        guard case .paragraph(let text) = block else { return [.markdown(block)] }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let groups = loneReference.groups(trimmed), groups.count > 2,
           let destination = groups[2],
           let target = OrbitLinkParser.target(forReference: destination) {
            return [.card(OrbitLinkRef(target: target, source: .reference(destination)))]
        }

        let matches = OrbitLinkScanner.pageURLs(in: text, host: host)
        guard !matches.isEmpty else { return [.markdown(block)] }

        var out: [OrbitRenderBlock] = []
        var cursor = text.startIndex
        for match in matches {
            append(&out, .paragraph(text: String(text[cursor..<match.range.lowerBound])))
            out.append(.card(match.ref))
            cursor = match.range.upperBound
        }
        append(&out, .paragraph(text: String(text[cursor...])))
        return out
    }

    /// The text either side of a card, as a paragraph — unless there is nothing left of it.
    private static func append(_ out: inout [OrbitRenderBlock], _ block: MarkdownBlock) {
        guard case .paragraph(let text) = block else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isOnlyPunctuation(trimmed) else { return }
        out.append(.markdown(.paragraph(text: trimmed)))
    }

    /// Whether a fragment is nothing but the sentence's own punctuation.
    ///
    /// The full stop that ended `见 https://…/abc。` is not part of the URL — it is what made the
    /// link a sentence, and it is left behind when the link becomes a card. Drawn as a paragraph of
    /// its own it would be a line containing one full stop under the card, so it goes with the words
    /// it belonged to, which the card has already replaced.
    private static func isOnlyPunctuation(_ text: String) -> Bool {
        let punctuation = ".,;:!?…·、。，；：！？'\"“”‘’()[]{}<>「」『』（）【】《》"
        return text.allSatisfy { $0.isWhitespace || punctuation.contains($0) }
    }
}

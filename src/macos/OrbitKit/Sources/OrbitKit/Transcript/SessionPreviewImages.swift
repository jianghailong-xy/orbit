import Foundation

/// One page of the iOS full-screen image viewer, gathered from the transcript.
public struct PreviewImageRef: Equatable, Sendable {
    public enum Source: Equatable, Sendable {
        /// Fetched through the attachment store by this id.
        case attachment(String)
        /// A tool result's inline bytes, which have no attachment id.
        case data(Data)
    }

    /// Names this one occurrence — the same attachment shown in two messages is two pages — and is
    /// what the thumbnail it was tapped from passes in, so the viewer opens on the right page.
    public let key: String
    public let source: Source

    public init(key: String, source: Source) {
        self.key = key
        self.source = source
    }
}

/// Every image in a session's transcript, in the order the transcript shows them, so the viewer opened
/// on any one of them pages straight across messages, tool calls and thinking blocks — web parity,
/// where one lightbox pages the whole transcript. Pure, so the order and the keys are tested here; the
/// view layer only decodes and presents.
///
/// Gathered when a thumbnail is tapped, never while rendering: it parses every message that carries an
/// attachment image.
public enum SessionPreviewImages {
    /// A user turn's attached image.
    public static func attachmentKey(itemID: String, attachmentID: String) -> String {
        "\(itemID)/attachment/\(attachmentID)"
    }

    /// An image written into a message's Markdown as `![alt](orbit-attachment:<id>)`.
    public static func markdownKey(itemID: String, source: String) -> String {
        "\(itemID)/markdown/\(source)"
    }

    /// The `index`-th of a tool result's images, counted over its bytes before any fail to decode.
    public static func toolKey(cardID: String, index: Int) -> String {
        "\(cardID)-img\(index)"
    }

    /// `toolImages` gives a card's bytes: its own `resultImages`, unless an open card has fetched back
    /// a screenshot the server clipped from the preview.
    public static func collect(_ items: [TranscriptItem],
                               toolImages: (ToolCard) -> [Data] = { $0.resultImages }) -> [PreviewImageRef] {
        var refs: [PreviewImageRef] = []
        var seen = Set<String>()
        func add(_ key: String, _ source: PreviewImageRef.Source) {
            // An image repeated within one message is one page: its copies share a key.
            if seen.insert(key).inserted { refs.append(PreviewImageRef(key: key, source: source)) }
        }
        func addMarkdownImages(_ markdown: String, itemID: String) {
            // Only an attachment image is a tappable thumbnail — a remote one isn't — and most messages
            // carry none, so they skip the parse.
            guard markdown.contains(AttachmentLink.scheme + ":") else { return }
            for case .image(let source, _) in parseMarkdownBlocks(markdown) {
                guard let id = AttachmentLink.attachmentID(source: source) else { continue }
                add(markdownKey(itemID: itemID, source: source), .attachment(id))
            }
        }

        for item in items {
            switch item {
            case .user(let bubble):
                // The thumbnails sit above the words.
                for attachment in bubble.attachments where attachment.isImage {
                    add(attachmentKey(itemID: bubble.id, attachmentID: attachment.id), .attachment(attachment.id))
                }
                addMarkdownImages(bubble.text, itemID: bubble.id)
            case .assistant(let bubble):
                addMarkdownImages(bubble.displayText, itemID: bubble.id)
            case .thinking(let block):
                addMarkdownImages(block.displayText, itemID: block.id)
            case .toolCall(let card):
                for (index, data) in toolImages(card).enumerated() {
                    add(toolKey(cardID: card.id, index: index), .data(data))
                }
            case .interrupt, .error, .authError, .autoRetry:
                break
            }
        }
        return refs
    }
}

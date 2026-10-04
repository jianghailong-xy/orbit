import Foundation

/// A prose file link. Uploaded links keep the original filename in the Markdown title;
/// their label is reader-facing text and their `orbit-attachment:` URL has no extension.
public struct MarkdownFileRef: Equatable, Sendable {
    public let href: String
    public let label: String
    public let name: String?

    public var fileName: String {
        if AttachmentLink.attachmentID(source: href) != nil {
            if let name, !name.isEmpty { return name }
            return label.isEmpty ? "file" : label
        }
        return AttachmentLink.fileName(inPath: href)
    }

    public var isImage: Bool { AttachmentLink.looksLikeImage(path: fileName) }

    /// Legacy attachment links may have neither a filename nor an extension in their label.
    /// Let the image decoder identify those, while known documents still load only on a tap.
    public var shouldLoadImage: Bool {
        isImage || (AttachmentLink.attachmentID(source: href) != nil
            && name == nil && (fileName as NSString).pathExtension.isEmpty)
    }

    public struct Match {
        public let range: Range<String.Index>
        public let ref: MarkdownFileRef
    }

    private static let linkPattern = try! NSRegularExpression(
        pattern: #"\[([^\]\n]+)\]\(([^)\s]+)(?:\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'))?\)"#
    )

    /// The same matches drive file cards and the session image pager, so an uploaded screenshot
    /// joins the gallery in the same position as the card the reader tapped.
    public static func matches(in text: String) -> [Match] {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return linkPattern.matches(in: text, range: range).compactMap { match in
            guard let whole = Range(match.range(at: 0), in: text),
                  let labelRange = Range(match.range(at: 1), in: text),
                  let hrefRange = Range(match.range(at: 2), in: text),
                  let url = URL(string: String(text[hrefRange])),
                  AttachmentLink.isFileReference(url) else { return nil }
            // Markdown image syntax keeps its existing image renderer.
            if whole.lowerBound > text.startIndex,
               text[text.index(before: whole.lowerBound)] == "!" { return nil }
            let nameRange = Range(match.range(at: 3), in: text) ?? Range(match.range(at: 4), in: text)
            let ref = MarkdownFileRef(href: String(text[hrefRange]),
                                      label: String(text[labelRange]).trimmingCharacters(in: .whitespaces),
                                      name: nameRange.map {
                                          String(text[$0]).replacingOccurrences(of: #"\\([\\'"])"#,
                                                                               with: "$1", options: .regularExpression)
                                      })
            return Match(range: whole, ref: ref)
        }
    }
}

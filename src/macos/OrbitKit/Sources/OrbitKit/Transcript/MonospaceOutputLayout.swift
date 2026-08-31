import Foundation

/// The safe presentation boundary for raw tool output in the native transcript.
///
/// A transcript row is one self-sizing `List` cell. Giving that cell a single `Text` containing a
/// very large Bash result makes UIKit measure and draw the whole result as one enormous view. Keep
/// a small preview in the row and route output beyond either the logical-line or byte budget
/// to a dedicated, bounded viewer instead.
public struct MonospaceOutputLayout: Equatable, Sendable {
    public static let previewLineLimit = 16
    public static let previewByteLimit = 4_096
    public static let inlineLineLimit = 200
    public static let inlineByteLimit = 8_192

    public let text: String
    public let lineCount: Int
    public let utf8Count: Int
    public let previewText: String
    public let previewByteClipped: Bool

    public init(text: String) {
        self.text = text

        guard !text.isEmpty else {
            lineCount = 0
            utf8Count = 0
            previewText = ""
            previewByteClipped = false
            return
        }

        let stats = Self.stats(for: text)
        lineCount = stats.separatorCount + 1
        utf8Count = stats.utf8Count

        let linePreview = stats.previewEnd.map { text[..<$0] } ?? text[...]
        (previewText, previewByteClipped) = Self.byteCappedPreview(linePreview)
    }

    public var hiddenLineCount: Int {
        max(0, lineCount - Self.previewLineLimit)
    }

    /// A many-line result and a giant unbroken line are both collapsible. The latter has no useful
    /// "N more lines" count, but can be much taller after wrapping on a phone than a normal log.
    public var isCollapsible: Bool {
        hiddenLineCount > 0 || previewByteClipped || requiresDedicatedViewer
    }

    /// Full output above either budget must never be placed back into the transcript cell. The
    /// native viewer is fixed to the screen and lets TextKit lay out only its visible viewport.
    public var requiresDedicatedViewer: Bool {
        lineCount > Self.inlineLineLimit || utf8Count > Self.inlineByteLimit
    }

    /// The string it is safe for the transcript row itself to render. In particular, an already
    /// expanded short preview that is replaced asynchronously by a large `/full` result becomes a
    /// preview again instead of inheriting the old expanded state and creating a giant cell.
    public func transcriptText(expanded: Bool) -> String {
        guard !requiresDedicatedViewer else { return previewText }
        guard isCollapsible else { return text }
        return expanded ? text : previewText
    }

    private static func stats(for text: String) -> (
        separatorCount: Int,
        utf8Count: Int,
        previewEnd: String.Index?
    ) {
        var separatorCount = 0
        var utf8Count = 0
        var previewEnd: String.Index?
        var previousWasCarriageReturn = false
        let scalars = text.unicodeScalars
        var index = scalars.startIndex

        while index != scalars.endIndex {
            let scalar = scalars[index]
            utf8Count += utf8Width(of: scalar)

            let isSeparator: Bool
            switch scalar.value {
            case 0x0D: // CR; a following LF belongs to the same separator.
                isSeparator = true
                previousWasCarriageReturn = true
            case 0x0A: // LF
                isSeparator = !previousWasCarriageReturn
                previousWasCarriageReturn = false
            case 0x000B, 0x000C, 0x0085, 0x2028, 0x2029: // VT, FF, NEL, LS, PS
                isSeparator = true
                previousWasCarriageReturn = false
            default:
                isSeparator = false
                previousWasCarriageReturn = false
            }

            if isSeparator {
                separatorCount += 1
                if separatorCount == previewLineLimit {
                    previewEnd = index
                }
            }
            index = scalars.index(after: index)
        }

        return (separatorCount, utf8Count, previewEnd)
    }

    /// Cap by encoded size rather than Swift grapheme count. A single `Character` can contain an
    /// arbitrarily long combining sequence, and emoji/CJK use several bytes per scalar.
    private static func byteCappedPreview(_ source: Substring) -> (String, Bool) {
        let scalars = source.unicodeScalars
        var byteCount = 0
        var index = scalars.startIndex

        while index != scalars.endIndex {
            let scalar = scalars[index]
            let nextCount = byteCount + utf8Width(of: scalar)
            if nextCount > previewByteLimit {
                return (String(source[..<index]) + "…", true)
            }
            byteCount = nextCount
            index = scalars.index(after: index)
        }

        return (String(source), false)
    }

    private static func utf8Width(of scalar: Unicode.Scalar) -> Int {
        switch scalar.value {
        case ...0x7F: 1
        case ...0x7FF: 2
        case ...0xFFFF: 3
        default: 4
        }
    }
}

import SwiftUI
#if os(iOS)
import UIKit
#endif

// iOS partial-text selection for the transcript. SwiftUI's `.textSelection(.enabled)` is unreliable
// inside the `List` that backs the transcript — the collection view's own recognizers swallow the
// long-press, so on iPhone you often can't start a selection at all, and the copy affordances the
// macOS build reveals on hover never show. `SelectableText` renders a message's prose in a read-only,
// self-sizing `UITextView` instead: long-press brings up the native loupe + handles, so any substring
// can be selected and copied (web parity — a browser lets you drag-select any run of a message). It's
// iOS-only; macOS keeps the plain `Text` (its drag-select already works and NSTableView doesn't fight
// it). See MarkdownView / MessageBubbles for the call sites.

/// The base type role for a selectable prose leaf — picks the concrete `UIFont` on iOS. Mirrors the
/// `Font.orbit*` tokens, which on iOS are semantic text styles, so these track Dynamic Type for free.
/// Cross-platform (the macOS build ignores it and keeps its `Text` chain).
enum ProseRole: Hashable {
    case body          // orbitProse       — assistant / user prose
    case aside         // orbitProseAside  — thinking, tool-card markdown
    case heading(Int)  // orbitHeading     — h1–h4 ramp
    case tableCell     // orbitTableCell
    case code          // orbitMono        — fenced code (no wrap)
}

/// The resolved text colour for a selectable leaf. A small enum rather than a raw `Color` so the iOS
/// path can map to a *dynamic* `UIColor` (baking a converted `Color` would freeze light/dark).
enum ProseInk: Hashable {
    case transcript    // long-form reply ink (web --text-1)
    case secondary     // thinking, blockquotes
    case primary       // user bubble (system label)
}

#if os(iOS)
/// A read-only, self-sizing `UITextView` that renders inline-Markdown (or plain) text with native
/// partial selection + Copy. Look matches the `Font.orbit*` tokens and the web transcript: the same
/// Dynamic-Type-tracked sizes (`preferredFont(forTextStyle:)`), the same faint inline-code tint, and
/// list markers that hang so wrapped lines align under the text.
struct SelectableText: UIViewRepresentable {
    let text: String
    var role: ProseRole = .body
    var ink: ProseInk = .transcript
    /// Parse `text` as inline Markdown (bold/italic/code/links/strikethrough). Off for the user
    /// bubble and fenced code, which are rendered verbatim.
    var markdown: Bool = false
    /// Tint inline `code` runs, mirroring the web `.md code` chip. Off inside headings (a bar behind a
    /// filename in a big bold heading reads as clutter — matches `inlineMarkdown(codeBackground:)`).
    var codeBackground: Bool = true
    /// A list marker (`•` / `1.`) prepended in secondary ink with a hanging indent, so a list item is
    /// one selectable run and its wrapped lines align under the text (web's `.md li`).
    var leadingMarker: String? = nil

    // Referenced only so the view re-renders (and rebuilds its baked fonts) when the system text size
    // changes — the fonts are snapshotted at build time, not auto-adjusted by the text view.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var wraps: Bool { role != .code }

    /// Remembers what a text view was last built from, so `updateUIView` can no-op when nothing
    /// changed. That matters twice over: the transcript re-evaluates its rows on every stream publish
    /// (~5×/sec during a turn), and reassigning `attributedText` each time would both re-parse the
    /// Markdown (a known battery hotspot) and *clear the user's active selection* mid-read.
    final class Coordinator { var key: Int? }
    func makeCoordinator() -> Coordinator { Coordinator() }

    private var renderKey: Int {
        var hasher = Hasher()
        hasher.combine(text)
        hasher.combine(role)
        hasher.combine(ink)
        hasher.combine(markdown)
        hasher.combine(codeBackground)
        hasher.combine(leadingMarker)
        hasher.combine(dynamicTypeSize)
        return hasher.finalize()
    }

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.isEditable = false
        tv.isSelectable = true
        tv.isScrollEnabled = false            // self-sizes; the transcript List does the scrolling
        tv.backgroundColor = .clear
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        tv.textContainer.maximumNumberOfLines = 0
        tv.textContainer.lineBreakMode = wraps ? .byWordWrapping : .byClipping
        tv.adjustsFontForContentSizeCategory = false   // fonts are baked per build (see dynamicTypeSize)
        tv.dataDetectorTypes = []             // links come from the Markdown, not from detection
        tv.setContentCompressionResistancePriority(.required, for: .vertical)
        return tv
    }

    func updateUIView(_ tv: UITextView, context: Context) {
        let key = renderKey
        guard context.coordinator.key != key else { return }   // nothing changed — keep any live selection
        context.coordinator.key = key
        tv.linkTextAttributes = [.foregroundColor: UIColor.tintColor]
        tv.attributedText = build()
    }

    // iOS 16+: report the fitted size for the proposed width so the List row is exactly the text's
    // height. Prose wraps to the proposed width; code measures its natural (unwrapped) width and its
    // caller (a horizontal ScrollView) scrolls the overflow.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let maxWidth: CGFloat
        if wraps, let w = proposal.width, w.isFinite {
            maxWidth = w
        } else {
            maxWidth = .greatestFiniteMagnitude
        }
        let fit = uiView.sizeThatFits(CGSize(width: maxWidth, height: .greatestFiniteMagnitude))
        let width = maxWidth.isFinite ? min(maxWidth, ceil(fit.width)) : ceil(fit.width)
        return CGSize(width: width, height: ceil(fit.height))
    }

    // MARK: - Attributed string

    private func build() -> NSAttributedString {
        let base = baseFont()
        let color = ink.uiColor
        let para = NSMutableParagraphStyle()
        para.lineSpacing = (role == .code) ? 2 : ProseLayout.lineSpacing
        if !wraps { para.lineBreakMode = .byClipping }

        let result = NSMutableAttributedString()

        if let marker = leadingMarker {
            // Hang the wrapped lines under the text: the marker is followed by a tab to a stop at the
            // marker's width, and every line indents to that same width.
            let markerRun = marker + "\t"
            let indent = ceil((markerRun as NSString).size(withAttributes: [.font: base]).width)
            para.firstLineHeadIndent = 0
            para.headIndent = indent
            para.tabStops = [NSTextTab(textAlignment: .left, location: indent, options: [:])]
            para.defaultTabInterval = indent
            result.append(NSAttributedString(string: markerRun, attributes: [
                .font: base, .foregroundColor: ProseInk.secondary.uiColor, .paragraphStyle: para,
            ]))
        }

        let source = markdown ? inlineMarkdownAttributed(text) : AttributedString(text)
        for run in source.runs {
            let piece = String(source[run.range].characters)
            let intent = run.inlinePresentationIntent
            var font = base
            var traits: UIFontDescriptor.SymbolicTraits = []
            if intent?.contains(.stronglyEmphasized) == true { traits.insert(.traitBold) }
            if intent?.contains(.emphasized) == true { traits.insert(.traitItalic) }
            if intent?.contains(.code) == true { font = monoFont(matching: base) }
            if !traits.isEmpty { font = font.withTraits(traits) }

            var attrs: [NSAttributedString.Key: Any] = [
                .font: font, .foregroundColor: color, .paragraphStyle: para,
            ]
            if intent?.contains(.code) == true, codeBackground {
                attrs[.backgroundColor] = UIColor.secondaryLabel.withAlphaComponent(0.08)
            }
            if intent?.contains(.strikethrough) == true {
                attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            }
            if let link = run.link { attrs[.link] = link }
            result.append(NSAttributedString(string: piece, attributes: attrs))
        }
        return result
    }

    private func baseFont() -> UIFont {
        switch role {
        case .body:      return .preferredFont(forTextStyle: .body)
        case .aside:     return .preferredFont(forTextStyle: .callout)
        case .tableCell: return .preferredFont(forTextStyle: .subheadline)
        case .code:      return monoFont(matching: .preferredFont(forTextStyle: .footnote))
        case .heading(let level):
            // Mirror `Font.orbitHeading(_:)` + the call site's `.bold()`.
            let style: UIFont.TextStyle = level == 1 ? .title2 : (level == 2 ? .title3 : .headline)
            return UIFont.preferredFont(forTextStyle: style).withTraits(.traitBold)
        }
    }

    private func monoFont(matching f: UIFont) -> UIFont {
        UIFont.monospacedSystemFont(ofSize: f.pointSize, weight: .regular)
    }
}

private extension ProseInk {
    var uiColor: UIColor {
        switch self {
        case .transcript: return .transcriptInk
        case .secondary:  return .secondaryLabel
        case .primary:    return .label
        }
    }
}

private extension UIColor {
    /// The dynamic UIKit twin of `Color.transcriptInk` (web `--text-1`: #1F2329 light / #C9CED5 dark),
    /// so a selected reply keeps the right ink in both appearances.
    static let transcriptInk = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xC9 / 255, green: 0xCE / 255, blue: 0xD5 / 255, alpha: 1)
            : UIColor(red: 0x1F / 255, green: 0x23 / 255, blue: 0x29 / 255, alpha: 1)
    }
}

private extension UIFont {
    func withTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
        let merged = fontDescriptor.symbolicTraits.union(traits)
        guard let descriptor = fontDescriptor.withSymbolicTraits(merged) else { return self }
        return UIFont(descriptor: descriptor, size: 0)   // 0 keeps the descriptor's point size
    }
}
#endif

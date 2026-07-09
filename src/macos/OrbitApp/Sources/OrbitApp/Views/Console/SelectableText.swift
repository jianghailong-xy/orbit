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
/// One laid-out paragraph inside a `SelectableText`. A leaf view (the user bubble, a fenced code
/// block) is a single segment; a run of Markdown prose is several — headings, paragraphs and list
/// items sharing ONE text view so a long-press can drag a selection straight across them. That
/// sharing is the point: a `UITextView` is a single selection domain, so the old one-view-per-block
/// layout capped a selection at a single block (you couldn't select two paragraphs, or a heading and
/// the paragraph beneath it, in one gesture). See `MarkdownView.proseGroups`.
struct ProseSegment: Hashable {
    var text: String
    var role: ProseRole = .body
    /// Parse `text` as inline Markdown (bold/italic/code/links/strikethrough). Off for the user
    /// bubble and fenced code, which are rendered verbatim.
    var markdown: Bool = false
    /// Tint inline `code` runs, mirroring the web `.md code` chip. Off inside headings (a bar behind a
    /// filename in a big bold heading reads as clutter — matches `inlineMarkdown(codeBackground:)`).
    var codeBackground: Bool = true
    /// A list marker (`•` / `1.`) laid in secondary ink with a hanging indent, so the marker copies
    /// with the item and its wrapped lines align under the text (web's `.md li`).
    var leadingMarker: String? = nil
    /// List nesting depth; each level adds a 16pt head indent (web's nested lists).
    var indent: Int = 0
    /// Gap above this paragraph — the inter-block separation (8pt between blocks, 6pt between list
    /// items), baked into the paragraph style so one text view reproduces the old block `VStack` gaps.
    var spacingBefore: CGFloat = 0
}

/// A read-only, self-sizing `UITextView` that renders inline-Markdown (or plain) prose with native
/// partial selection + Copy. Look matches the `Font.orbit*` tokens and the web transcript: the same
/// Dynamic-Type-tracked sizes (`preferredFont(forTextStyle:)`), the same faint inline-code tint, and
/// list markers that hang so wrapped lines align under the text. One view holds one or more
/// `ProseSegment`s, so a selection can span a whole run of prose blocks — not just one.
struct SelectableText: UIViewRepresentable {
    let segments: [ProseSegment]
    var ink: ProseInk = .transcript

    /// Leaf: a single run of text — the user bubble, a fenced code block, or one standalone block.
    init(text: String, role: ProseRole = .body, ink: ProseInk = .transcript,
         markdown: Bool = false, codeBackground: Bool = true, leadingMarker: String? = nil) {
        self.segments = [ProseSegment(text: text, role: role, markdown: markdown,
                                      codeBackground: codeBackground, leadingMarker: leadingMarker)]
        self.ink = ink
    }

    /// Merged: several prose paragraphs sharing one selection domain (see `MarkdownView.proseGroups`).
    init(segments: [ProseSegment], ink: ProseInk = .transcript) {
        self.segments = segments
        self.ink = ink
    }

    // Referenced only so the view re-renders (and rebuilds its baked fonts) when the system text size
    // changes — the fonts are snapshotted at build time, not auto-adjusted by the text view.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    // Only a lone fenced-code leaf renders unwrapped (its natural width scrolls in a horizontal
    // ScrollView); prose always wraps to the proposed width.
    private var wraps: Bool { !segments.allSatisfy { $0.role == .code } }

    /// Remembers what a text view was last built from, so `updateUIView` can no-op when nothing
    /// changed. That matters twice over: the transcript re-evaluates its rows on every stream publish
    /// (~5×/sec during a turn), and reassigning `attributedText` each time would both re-parse the
    /// Markdown (a known battery hotspot) and *clear the user's active selection* mid-read.
    final class Coordinator { var key: Int? }
    func makeCoordinator() -> Coordinator { Coordinator() }

    private var renderKey: Int {
        var hasher = Hasher()
        hasher.combine(segments)
        hasher.combine(ink)
        hasher.combine(dynamicTypeSize)
        return hasher.finalize()
    }

    func makeUIView(context: Context) -> UITextView {
        let tv = SelectableTextView()
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
        let color = ink.uiColor
        let result = NSMutableAttributedString()
        for (i, seg) in segments.enumerated() {
            append(seg, into: result, color: color, trailingNewline: i < segments.count - 1)
        }
        return result
    }

    /// Append one paragraph. `trailingNewline` opens the next segment (the break is styled here so it
    /// belongs to *this* paragraph); the next segment's own `spacingBefore` then adds the block gap.
    private func append(_ seg: ProseSegment, into result: NSMutableAttributedString,
                        color: UIColor, trailingNewline: Bool) {
        let base = baseFont(for: seg.role)
        let para = NSMutableParagraphStyle()
        para.lineSpacing = (seg.role == .code) ? 2 : ProseLayout.lineSpacing
        para.paragraphSpacingBefore = seg.spacingBefore
        if seg.role == .code { para.lineBreakMode = .byClipping }

        // List nesting: every line hangs at `indent × 16`; a marker hangs further so wrapped lines
        // align under the item's text rather than under its bullet.
        let indentBase = CGFloat(seg.indent) * 16
        para.firstLineHeadIndent = indentBase
        para.headIndent = indentBase

        if let marker = seg.leadingMarker {
            let markerRun = marker + "\t"
            let markerWidth = ceil((markerRun as NSString).size(withAttributes: [.font: base]).width)
            para.headIndent = indentBase + markerWidth
            para.tabStops = [NSTextTab(textAlignment: .left, location: indentBase + markerWidth, options: [:])]
            para.defaultTabInterval = markerWidth
            result.append(NSAttributedString(string: markerRun, attributes: [
                .font: base, .foregroundColor: ProseInk.secondary.uiColor, .paragraphStyle: para,
            ]))
        }

        let source = seg.markdown ? inlineMarkdownAttributed(seg.text) : AttributedString(seg.text)
        for run in source.runs {
            // Soft breaks inside a paragraph become LINE SEPARATORs so they wrap without picking up
            // paragraph spacing — only the real block break (the styled `\n` below) gets the gap.
            // `SelectableTextView.copy` restores them to `\n` so pasted prose keeps normal newlines.
            let piece = String(source[run.range].characters).replacingOccurrences(of: "\n", with: "\u{2028}")
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
            if intent?.contains(.code) == true, seg.codeBackground {
                attrs[.backgroundColor] = UIColor.secondaryLabel.withAlphaComponent(0.08)
            }
            if intent?.contains(.strikethrough) == true {
                attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            }
            if let link = run.link { attrs[.link] = link }
            result.append(NSAttributedString(string: piece, attributes: attrs))
        }

        if trailingNewline {
            result.append(NSAttributedString(string: "\n", attributes: [.font: base, .paragraphStyle: para]))
        }
    }

    private func baseFont(for role: ProseRole) -> UIFont {
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

/// A read-only `UITextView` whose Copy normalises the soft-break sentinel (U+2028, used inside a
/// merged prose run so wrapped lines don't pick up inter-block spacing) back to `\n`, so copied prose
/// pastes with ordinary newlines rather than stray line-separator characters.
final class SelectableTextView: UITextView {
    override func copy(_ sender: Any?) {
        super.copy(sender)
        if let s = UIPasteboard.general.string, s.contains("\u{2028}") {
            UIPasteboard.general.string = s.replacingOccurrences(of: "\u{2028}", with: "\n")
        }
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

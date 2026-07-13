import SwiftUI

// The shared type ramp for both clients. Views reference these semantic tokens instead of bare
// `.system(size:)` / raw text styles, so one table owns every font decision and the two platforms
// can diverge where their conventions do:
//
//   • iOS values are all *semantic* text styles (body/subheadline/footnote/…), so every token
//     tracks Dynamic Type for free. iOS body is 17pt — the pre-token ramp was inherited from the
//     macOS design (fixed 11–14pt) and read one to two sizes too small on iPhone.
//   • macOS values pin (approximately) the pre-token look: fixed sizes, body 14. macOS has no
//     user-facing Dynamic Type, so fixed sizes lose nothing there. A few call sites moved ±1pt
//     where the old ramp was internally inconsistent; anything larger is called out in the PR.
//
// Token            role                                              iOS (semantic → pt)   macOS
// orbitProse       transcript prose: assistant/user/approval text    .body        17       14
// orbitProseAside  secondary long-form: thinking, tool-card md       .callout     16       12
// orbitHeading(n)  markdown heading ramp h1–h4                       22/20/17/17           20/17/15/14
// orbitTableCell   markdown table cells                              .subheadline 15       13
// orbitControl     text inputs: composer field, approval free-text   .body        17       14
// orbitSubtext     one-line content previews (sticky question)       .subheadline 15       13
// orbitListSubtitle list second lines, composer footer controls      .subheadline 15       10 (.caption)
// orbitLabel       small UI labels/buttons: Show more, banners       .footnote    13       12
// orbitMono        code blocks, tool output, commands, paths, branch .footnote    13 mono  11.5 mono
// orbitDiffLine    diff body lines                                   .caption     12 mono  11 mono
// orbitMonoFine    diff gutters/gaps, tiny mono badges               .caption2    11 mono  10 mono
// orbitSectionLabel tracked-out micro headers (OUTPUT / ERROR)       .caption2    11       9
// orbitMeta        glance metadata: timestamps, badges, chevrons     .caption2    11       10 (.caption2)
// orbitGlyph       row-scale icons: status glyphs, + button, avatar  .subheadline 15       15
// orbitHeroGlyph   decorative hero/brand glyphs (login logo)         44 (static)           44
//
// Rule of thumb when adding UI: reading text → prose family; tappable words → orbitLabel or
// larger; monospaced content → the mono family; only true glance-metadata may use orbitMeta.
// Bare `system(size:)` in views fails CI (client.yml `font-tokens`) — this file is the one
// place fixed sizes may live.
extension Font {
    #if os(iOS)
    static let orbitProse: Font = .body
    static let orbitProseAside: Font = .callout
    static let orbitTableCell: Font = .subheadline
    static let orbitControl: Font = .body
    static let orbitSubtext: Font = .subheadline
    static let orbitListSubtitle: Font = .subheadline
    static let orbitLabel: Font = .footnote
    static let orbitMono: Font = .system(.footnote, design: .monospaced)
    static let orbitDiffLine: Font = .system(.caption, design: .monospaced)
    static let orbitMonoFine: Font = .system(.caption2, design: .monospaced)
    static let orbitSectionLabel: Font = .caption2
    static let orbitMeta: Font = .caption2
    static let orbitGlyph: Font = .subheadline
    // Deliberately Dynamic-Type-static: a brand mark, not text (its container doesn't scale).
    static let orbitHeroGlyph: Font = .system(size: 44)

    static func orbitHeading(_ level: Int) -> Font {
        // .headline is 17pt semibold — same size as orbitProse, so an h3/h4 distinguishes itself
        // by weight alone (the call site's .bold()), mirroring how deep headings flatten on web.
        switch level {
        case 1:  return .title2      // 22
        case 2:  return .title3      // 20
        default: return .headline    // 17 semibold
        }
    }
    #else
    static let orbitProse: Font = .system(size: 14)
    static let orbitProseAside: Font = .system(size: 12)
    static let orbitTableCell: Font = .system(size: 13)
    static let orbitControl: Font = .system(size: 14)
    static let orbitSubtext: Font = .system(size: 13)
    static let orbitListSubtitle: Font = .caption
    static let orbitLabel: Font = .system(size: 12)
    static let orbitMono: Font = .system(size: 11.5, design: .monospaced)
    static let orbitDiffLine: Font = .system(size: 11, design: .monospaced)
    static let orbitMonoFine: Font = .system(size: 10, design: .monospaced)
    static let orbitSectionLabel: Font = .system(size: 9)
    static let orbitMeta: Font = .caption2
    static let orbitGlyph: Font = .system(size: 15)
    static let orbitHeroGlyph: Font = .system(size: 44)

    static func orbitHeading(_ level: Int) -> Font {
        // The pre-token fixed ramp, kept verbatim: a notch above the 14pt macOS prose so an h4
        // never renders smaller than the paragraphs it heads.
        switch level {
        case 1:  return .system(size: 20)
        case 2:  return .system(size: 17)
        case 3:  return .system(size: 15)
        default: return .system(size: 14)
        }
    }
    #endif
}

extension Font {
    /// The Orbit `>_` mark inside an agent avatar — monospaced, scaled to the avatar diameter. A
    /// brand glyph (not text), so it stays Dynamic-Type-static like `orbitHeroGlyph`. Identical on
    /// both platforms (the avatar owns the size), so it lives outside the forked table above.
    static func orbitAgentGlyph(_ diameter: CGFloat) -> Font {
        .system(size: diameter * 0.4, weight: .bold, design: .monospaced)
    }

    /// A thin control-affordance glyph sized for a fixed disc (e.g. the transcript scroll-to-bottom
    /// arrow). Like `orbitHeroGlyph`, it's a mark in a fixed-size container, not text, so it stays
    /// Dynamic-Type-static — a scaling glyph would overflow the disc. Identical on both platforms.
    static let orbitControlGlyph: Font = .system(size: 15, weight: .regular)
}

/// Additive line leading (points on top of the font's own line height) for transcript prose.
/// Forked because it was tuned once against macOS's 14pt body; iOS prose is 17pt and CJK wants more
/// leading than Latin, so the same flat value read tighter there. Referenced by MarkdownView and the
/// streaming AssistantBubble/Thinking rows so the plain→Markdown swap can't shift the layout.
enum ProseLayout {
    #if os(iOS)
    static let lineSpacing: CGFloat = 7
    #else
    static let lineSpacing: CGFloat = 5
    #endif
}

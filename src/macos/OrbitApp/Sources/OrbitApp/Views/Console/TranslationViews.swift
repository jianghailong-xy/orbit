import SwiftUI
import OrbitKit

// Settings › Translation in a conversation (board docs/mocks/session-translation/01-board.png,
// frames 4–6 and 8): the line under a translated message with its per-message Show original, the
// "Translating…" and "Translates when the reply is done" chips, and the failure rows with Retry /
// Send as written / Cancel. What each line says is `SessionTranslation.userFoot` / `replyFoot` in OrbitKit, where it
// is tested; these only draw it and call the console's doors.

/// What the open conversation can do about a translation, provided by `ConsoleView`. `on` is the
/// account's switch with the server able to translate: a reply streaming then is greyed (2A).
struct TranslationActions {
    var on: Bool
    /// "Show both languages" (02-bilingual.png): a translated message also shows its English, and its
    /// foot loses the flip. Off is today's UI.
    var bilingual: Bool = false
    /// "Agents work in": the language that text is in, named by the foot and the collapsed press.
    var agentLanguage: TranslationLanguage = .agentDefault
    var retryTurn: (String) -> Void
    var sendAsWritten: (String) -> Void
    /// Withdraw a held message that failed to translate; its words and files go back to the composer.
    var cancelTurn: (UserBubble) -> Void
    var retryReply: (Int) -> Void
}

private struct TranslationActionsKey: EnvironmentKey {
    static let defaultValue: TranslationActions? = nil
}

extension EnvironmentValues {
    var translationActions: TranslationActions? {
        get { self[TranslationActionsKey.self] }
        set { self[TranslationActionsKey.self] = newValue }
    }
}

/// One line of foot parts: words, a grey chip, or link-styled presses, separated by "·".
struct TranslationFootView: View {
    let parts: [SessionTranslation.FootPart]
    var alignment: HorizontalAlignment = .leading
    let onAction: (SessionTranslation.FootAction) -> Void

    /// A failure's line, whatever its sentence: only a failure offers Retry.
    private var failed: Bool {
        parts.contains {
            if case .action(_, let action) = $0 { return action == .retryTurn || action == .retryReply }
            return false
        }
    }

    var body: some View {
        if !parts.isEmpty {
            // One line while it fits. A reason's sentence (policy board docs/ux/translation-failure-policy.html,
            // frame 7) can be longer than the column: then the sentence wraps on its own lines, with its
            // presses on the line under it, all of it under the bubble rather than cut off.
            ViewThatFits(in: .horizontal) {
                row(parts).fixedSize(horizontal: true, vertical: false)
                wrapped
            }
            .font(.orbitMeta)
        }
    }

    /// The words wrapped, then "Retry · Send as written · Cancel" on a line of their own.
    private var wrapped: some View {
        let words = parts.filter { if case .action = $0 { return false } else { return true } }
        let presses = parts.filter { if case .action = $0 { return true } else { return false } }
        return VStack(alignment: alignment, spacing: 2) {
            ForEach(Array(words.enumerated()), id: \.offset) { _, part in
                if case .text(let w) = part {
                    Text(w).foregroundStyle(failed ? Color.red : Color.secondary)
                        .multilineTextAlignment(alignment == .trailing ? .trailing : .leading)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    row([part])
                }
            }
            if !presses.isEmpty { row(presses).fixedSize(horizontal: true, vertical: false) }
        }
        .accessibilityIdentifier("translation.foot.wrapped")
    }

    private func row(_ parts: [SessionTranslation.FootPart]) -> some View {
        HStack(spacing: 4) {
            ForEach(Array(parts.enumerated()), id: \.offset) { i, part in
                if i > 0, !isChip(part) { Text("·").foregroundStyle(.tertiary) }
                switch part {
                case .text(let words):
                    Text(words).foregroundStyle(failed ? Color.red : Color.secondary)
                case .chip(let words):
                    Text(words)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Color.primary.opacity(0.06), in: Capsule())
                case .action(let label, let action):
                    Button { onAction(action) } label: { Text(label).underline() }
                        .buttonStyle(.plain)
                        .foregroundStyle(failed ? Color.red : Color.secondary)
                        .contentShape(Rectangle())
                }
            }
        }
        .lineLimit(1)
    }

    private func isChip(_ part: SessionTranslation.FootPart) -> Bool {
        if case .chip = part { return true }
        return false
    }
}

/// "Show both languages", interleaved (docs/mocks/session-translation/03-interleaved.png): a reply
/// drawn pair by pair — each block in the owner's language, its original right under it, a size
/// smaller and grey, no divider inside a pair and the usual block gap between pairs. An item's
/// original sits under its own words, indented with them; a heading's under the heading, in the
/// regular weight. Code, tables and images are drawn once, from the translation. Never collapsed.
struct InterleavedReplyView: View {
    let pairs: [BilingualPairs.Pair]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(pairs.enumerated()), id: \.offset) { _, pair in
                pairView(pair)
                    .padding(.leading, CGFloat(pair.depth) * 16)
                    .padding(.top, pair.kind == .heading ? 4 : 0)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("translation.interleaved")
    }

    @ViewBuilder private func pairView(_ pair: BilingualPairs.Pair) -> some View {
        switch pair.kind {
        case .item:
            // The marker drawn here, as MarkdownView draws a list's, so the original can sit under
            // the item's words rather than under its bullet.
            HStack(alignment: .top, spacing: 6) {
                Text(pair.number.map { "\($0)." } ?? "•").monospacedDigit().foregroundStyle(.secondary)
                words(pair)
            }
        case .quote:
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5).fill(Color.secondary.opacity(0.4)).frame(width: 3)
                words(pair)
            }
        default:
            words(pair)
        }
    }

    private func words(_ pair: BilingualPairs.Pair) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            MarkdownView(source: pair.text)
            if let original = pair.original {
                Text(BilingualEnglishView.inline(original))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("translation.original")
            }
        }
    }
}

/// "Show both languages" (docs/mocks/session-translation/02-bilingual.png): the English the agent
/// read or wrote, under a dashed divider, a size smaller and grey — the owner's message, and a reply
/// whose blocks do not pair (frame 4 of 03-interleaved.png). A reply's English over
/// `BilingualEnglish.collapseLines` lines starts as a two-line faded preview with "Show English · N
/// lines", which opens it in place (frame 3); per message and never kept.
struct BilingualEnglishView: View {
    let english: String
    /// The language the agent works in, which `english` is in ("Show <Language> · N lines").
    var agentLanguage: TranslationLanguage = .agentDefault
    var collapsible = false
    var alignment: HorizontalAlignment = .leading
    @State private var open = false

    var body: some View {
        let lines = BilingualEnglish.lineCount(english)
        let collapsed = collapsible && !open && lines > BilingualEnglish.collapseLines
        VStack(alignment: alignment, spacing: 6) {
            DashedDivider()
            Text(Self.inline(english))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .lineLimit(collapsed ? 2 : nil)
                .fixedSize(horizontal: false, vertical: true)
                .mask {
                    if collapsed {
                        LinearGradient(colors: [.black, .black.opacity(0.15)], startPoint: .center, endPoint: .bottom)
                    } else {
                        Rectangle()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .accessibilityIdentifier("translation.english")
            if collapsed {
                Button { open = true } label: {
                    Text(TranslationCopy.showEnglishLabel(lines: lines, agentLanguage)).underline()
                }
                .buttonStyle(.plain)
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
        }
    }
}

extension BilingualEnglishView {
    /// The English's inline Markdown (code spans, emphasis, links) drawn as such, its line breaks kept;
    /// words that do not parse are drawn as written.
    static func inline(_ english: String) -> AttributedString {
        (try? AttributedString(markdown: english,
                               options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(english)
    }
}

/// A one-point dashed rule the width of its container.
private struct DashedDivider: View {
    var body: some View {
        Line()
            .stroke(Color.secondary.opacity(0.45), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            .frame(height: 1)
            .frame(maxWidth: .infinity)
    }

    private struct Line: Shape {
        func path(in rect: CGRect) -> Path {
            var p = Path()
            p.move(to: CGPoint(x: rect.minX, y: rect.midY))
            p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            return p
        }
    }
}

/// The composer's tag (6A): "<Language> → <Agent language>", pressing which opens Settings › General, where
/// Translation is. Drawn only while the account translates.
struct ComposerTranslationTag: View {
    let language: TranslationLanguage
    let agentLanguage: TranslationLanguage
    /// Until when the server is skipping a failing translator (`SessionTranslation.temporarilyUnavailableUntil`,
    /// policy board frame 6): till then the tag reads "… · unavailable, messages will wait". The server
    /// does not announce the instant passing, so the tag redraws itself then.
    var unavailableUntil: Date? = nil
    let open: () -> Void

    var body: some View {
        if let until = unavailableUntil {
            TimelineView(.explicit([until])) { context in
                tag(unavailable: context.date < until)
            }
        } else {
            tag(unavailable: false)
        }
    }

    private func tag(unavailable: Bool) -> some View {
        Button(action: open) {
            Text(language.tag(to: agentLanguage, unavailable: unavailable))
                .font(.orbitMeta)
                .foregroundStyle(unavailable ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.secondary))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(unavailable ? Color.orange.opacity(0.12) : Color.primary.opacity(0.06), in: Capsule())
        }
        .buttonStyle(.plain)
        .help(TranslationCopy.title)
        .accessibilityLabel(language.tag(to: agentLanguage, unavailable: unavailable))
    }
}

/// An approval card refused because the owner's words could not be translated (1A): why, naming "your
/// answer" (policy board frame 5), then Retry and Send as written, each press sending the same decision again.
struct UntranslatedDecisionRow: View {
    let console: ConsoleModel
    let approval: PendingApproval

    var body: some View {
        if let held = console.untranslatedDecisions[approval.id] {
            TranslationFootView(parts: held.foot) { action in
                Task {
                    await console.decide(approval, behavior: held.behavior, answers: held.answers,
                                         remember: held.remember, sendAsWritten: action == .sendAsWritten)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

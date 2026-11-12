import SwiftUI
import OrbitKit

// Settings › Translation in a conversation (board docs/mocks/session-translation/01-board.png,
// frames 4–6 and 8): the line under a translated message with its per-message Show original, the
// "Translating…" and "Translates when the reply is done" chips, and the failure rows with Retry /
// Send as written. What each line says is `SessionTranslation.userFoot` / `replyFoot` in OrbitKit, where it
// is tested; these only draw it and call the console's doors.

/// What the open conversation can do about a translation, provided by `ConsoleView`. `on` is the
/// account's switch with the server able to translate: a reply streaming then is greyed (2A).
struct TranslationActions {
    var on: Bool
    var retryTurn: (String) -> Void
    var sendAsWritten: (String) -> Void
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

    private var failed: Bool {
        parts.contains {
            if case .text(let t) = $0 {
                return t == TranslationCopy.sendFailed || t == TranslationCopy.replyFailed
            }
            return false
        }
    }

    var body: some View {
        if !parts.isEmpty {
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
            .font(.orbitMeta)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
        }
    }

    private func isChip(_ part: SessionTranslation.FootPart) -> Bool {
        if case .chip = part { return true }
        return false
    }
}

/// The composer's tag (6A): "<Language> → English", pressing which opens Settings › Sessions, where
/// Translation is. Drawn only while the account translates.
struct ComposerTranslationTag: View {
    let language: TranslationLanguage
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            Text(language.tag)
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Color.primary.opacity(0.06), in: Capsule())
        }
        .buttonStyle(.plain)
        .help(TranslationCopy.title)
        .accessibilityLabel(language.tag)
    }
}

/// An approval card refused because the owner's words could not be translated (1A): the same
/// "Couldn't translate, so it wasn't sent · Retry · Send as written" as a message, each press sending
/// the same decision again.
struct UntranslatedDecisionRow: View {
    let console: ConsoleModel
    let approval: PendingApproval

    var body: some View {
        if let held = console.untranslatedDecisions[approval.id] {
            TranslationFootView(parts: [.text(TranslationCopy.sendFailed),
                                        .action(TranslationCopy.retry, .retryTurn),
                                        .action(TranslationCopy.sendAsWritten, .sendAsWritten)]) { action in
                Task {
                    await console.decide(approval, behavior: held.behavior, answers: held.answers,
                                         remember: held.remember, sendAsWritten: action == .sendAsWritten)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

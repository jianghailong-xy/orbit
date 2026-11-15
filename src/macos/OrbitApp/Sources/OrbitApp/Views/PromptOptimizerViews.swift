import SwiftUI
import OrbitKit

// Prompt optimizer in the composer (board docs/mocks/prompt-optimizer/01-board.png, frames 2–6):
// the ✦ Optimize button, the suggestion card (above the composer on a Mac, a sheet over it on a
// phone), the failure line and the Undo toast. Every rule is OrbitKit's (`PromptOptimizer`,
// `PromptOptimizerState`); these only draw it, so each takes what it shows and what its presses do.

/// The tint of text the optimizer added from context (frame 4).
private let addedTint = Color.green.opacity(0.18)

/// Frame 2's ✦ Optimize beside Send, and frame 3's busy "Optimizing…", which cancels when pressed.
struct PromptOptimizeButton: View {
    let busy: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if busy {
                    ProgressView().controlSize(.mini)
                    Text(PromptOptimizerCopy.optimizing)
                } else {
                    Text("✦")
                    Text(PromptOptimizerCopy.optimize)
                }
            }
            .font(.orbitLabel.weight(.medium))
            .foregroundStyle(busy ? Color.secondary : Color.accentColor)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 9)
            .frame(height: 26)
            .background(busy ? Color.primary.opacity(0.05) : Color.accentColor.opacity(0.10), in: Capsule())
            .overlay(Capsule().strokeBorder(busy ? Color.primary.opacity(0.12) : Color.accentColor.opacity(0.25),
                                            lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(busy ? PromptOptimizerCopy.cancelHelp : PromptOptimizerCopy.optimizeHelp)
        .accessibilityIdentifier(PromptOptimizerCopy.buttonIdentifier)
        .accessibilityLabel(busy ? PromptOptimizerCopy.optimizing : PromptOptimizerCopy.optimize)
    }
}

/// Frame 4: the suggestion. Its text with what context added tinted, "Show in <language>" when there
/// is a gloss, the "Used:" chips, and Use / Edit, then use / Try again; × dismisses. The same card is
/// the body of the phone's sheet (`sheet: true`), where it fills the sheet instead of floating.
struct PromptOptimizationCard: View {
    let optimization: PromptOptimization
    let basedOnEarlierDraft: Bool
    @Binding var showingGloss: Bool
    let glossLanguage: TranslationLanguage
    var sheet = false
    let use: () -> Void
    let editThenUse: () -> Void
    let tryAgain: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if sheet {
                ScrollView { content }
                    .frame(maxHeight: .infinity)
            } else {
                // Short, it is as tall as its words; long, it scrolls inside 260 pt.
                ViewThatFits(in: .vertical) {
                    content
                    ScrollView { content }
                }
                .frame(maxHeight: 260)
            }
            Divider()
            actions
        }
        .background(sheet ? Color.clear : cardFill)
        .clipShape(RoundedRectangle(cornerRadius: sheet ? 0 : 14, style: .continuous))
        .overlay {
            if !sheet {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.accentColor.opacity(0.28), lineWidth: 1)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer.optimization.card")
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            if basedOnEarlierDraft {
                Text(PromptOptimizerCopy.basedOnEarlierDraft)
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }
            promptText
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if optimization.gloss != nil {
                Button(showingGloss ? PromptOptimizerCopy.showOriginal
                                    : PromptOptimizerCopy.showIn(glossLanguage)) {
                    showingGloss.toggle()
                }
                .buttonStyle(.plain)
                .font(.orbitLabel.weight(.medium))
                .foregroundStyle(Color.accentColor)
            }
            if !optimization.chips.isEmpty { chips }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private var cardFill: Color {
        #if os(macOS)
        Color(nsColor: .textBackgroundColor)
        #else
        Color(uiColor: .systemBackground)
        #endif
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text("✦").foregroundStyle(Color.accentColor)
            Text(PromptOptimizerCopy.cardTitle)
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(Color.accentColor)
            Spacer(minLength: 8)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font((sheet ? Font.orbitControl : Font.orbitLabel).weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(PromptOptimizerCopy.dismiss)
            .accessibilityLabel(PromptOptimizerCopy.dismiss)
            #if os(macOS)
            // Esc dismisses wherever focus is; in the box the field's own Esc does the same.
            .keyboardShortcut(.cancelAction)
            #endif
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, sheet ? 10 : 4)
        .background(Color.accentColor.opacity(0.08))
    }

    /// The prompt, its additions tinted and its `code` spans monospaced; or, flipped, the gloss.
    private var promptText: Text {
        if showingGloss, let gloss = optimization.gloss { return Text(gloss) }
        var out = AttributedString()
        for run in PromptOptimizer.runs(optimization.segments) {
            var piece = AttributedString(run.text)
            if run.added { piece.backgroundColor = addedTint }
            if run.code { piece.font = Font.system(.body, design: .monospaced) }
            out.append(piece)
        }
        return Text(out)
    }

    private var chips: some View {
        FlowLayout(spacing: 6) {
            Text(PromptOptimizerCopy.used)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(height: 22)
            ForEach(optimization.chips, id: \.self) { chip in
                Text(chip)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.horizontal, 7)
                    .frame(height: 22)
                    .overlay(Capsule().strokeBorder(Color.primary.opacity(0.14), lineWidth: 1))
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 8) {
            Button(PromptOptimizerCopy.use, action: use)
                .buttonStyle(.borderedProminent)
            Button(PromptOptimizerCopy.editThenUse, action: editThenUse)
                .buttonStyle(.bordered)
            Button(PromptOptimizerCopy.tryAgain, action: tryAgain)
                .buttonStyle(.borderless)
            Spacer(minLength: 4)
            #if os(macOS)
            Text(PromptOptimizerCopy.escDismisses)
                .font(.caption).foregroundStyle(.tertiary)
                .lineLimit(1)
            #endif
        }
        .controlSize(sheet ? .regular : .small)
        .padding(.horizontal, 14)
        .padding(.vertical, sheet ? 12 : 8)
    }
}

/// Frame 6: "Couldn't optimize this draft. Try again" over the composer. The draft is untouched.
struct PromptOptimizationFailureLine: View {
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Text(PromptOptimizerCopy.failed)
                .foregroundStyle(Color.red)
            Button(PromptOptimizerCopy.tryAgain, action: retry)
                .buttonStyle(.plain)
                .underline()
                .foregroundStyle(Color.red)
                .fontWeight(.medium)
            Spacer(minLength: 0)
            Button(action: dismiss) {
                Image(systemName: "xmark").font(.orbitLabel.weight(.semibold)).foregroundStyle(.secondary)
                    .frame(width: 22, height: 22).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(PromptOptimizerCopy.dismiss)
        }
        .font(.orbitLabel)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.red.opacity(0.25)))
    }
}

/// Frame 5: "Draft replaced with the optimized prompt · Undo", for a few seconds after Use. On a Mac
/// ⌘Z presses it while it shows.
struct PromptOptimizationUndoToast: View {
    let undo: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Text(PromptOptimizerCopy.replaced)
                .foregroundStyle(Color.white)
            Button(PromptOptimizerCopy.undo, action: undo)
                .buttonStyle(.plain)
                .underline()
                .foregroundStyle(Color(red: 0.55, green: 0.70, blue: 1.0))
                .keyboardShortcut("z", modifiers: .command)
        }
        .font(.orbitLabel)
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Color.black.opacity(0.85), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

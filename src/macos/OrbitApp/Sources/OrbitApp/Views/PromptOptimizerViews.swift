import SwiftUI
import OrbitKit

// Prompt optimizer in the composer (board docs/mocks/prompt-optimizer/01-board.png, frames 2–6):
// the ✦ Optimize button, the suggestion (a card above the composer on a Mac, `PromptOptimizationSheet`
// over it on a phone), the failure line and the Undo toast. Every rule is OrbitKit's (`PromptOptimizer`,
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

/// Frame 4: the suggestion. Its text with what context added tinted — or, with a gloss (D2), the gloss
/// first with "The agent receives the <language> version." — "Show in <language>" when there is a gloss, the "Used:" chips, and Use / Edit, then use / Try again; × dismisses. A Mac's;
/// a phone shows `PromptOptimizationSheet`.
struct PromptOptimizationCard: View {
    let optimization: PromptOptimization
    let basedOnEarlierDraft: Bool
    @Binding var showingPrompt: Bool
    let glossLanguage: TranslationLanguage
    let use: () -> Void
    let editThenUse: () -> Void
    let tryAgain: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            // Short, it is as tall as its words; long, it scrolls inside 260 pt.
            ViewThatFits(in: .vertical) {
                content
                ScrollView { content }
            }
            .frame(maxHeight: 260)
            // Under the words and always in view, however long they are: the gloss's toggle and
            // the "Used:" chips (frame 4).
            if optimization.gloss != nil || !optimization.chips.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    if optimization.gloss != nil {
                        Text(PromptOptimizerCopy.agentReceives(optimization.promptLanguage))
                            .font(.orbitLabel).foregroundStyle(.secondary)
                        Button(showingPrompt ? PromptOptimizerCopy.showIn(glossLanguage)
                                             : PromptOptimizerCopy.showPrompt(optimization.promptLanguage)) {
                            showingPrompt.toggle()
                        }
                        .buttonStyle(.plain)
                        .font(.orbitLabel.weight(.medium))
                        .foregroundStyle(Color.accentColor)
                    }
                    if !optimization.chips.isEmpty { chips }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14)
                .padding(.top, 4)
                .padding(.bottom, 10)
            }
            Divider()
            actions
        }
        .background(cardFill)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.accentColor.opacity(0.28), lineWidth: 1)
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
                    .font(Font.orbitLabel.weight(.semibold))
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
        .padding(.vertical, 4)
        .background(Color.accentColor.opacity(0.08))
    }

    /// The gloss the card opens on (D2); or, flipped — and always without a gloss — the prompt, its
    /// additions tinted and its `code` spans monospaced.
    private var promptText: Text {
        if !showingPrompt, let gloss = optimization.gloss { return Text(gloss) }
        return promptRuns(optimization, codeStyle: .body)
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
            Button(action: use) {
                #if os(macOS)
                // The key inside the button, as the web draws it; the box's Tab presses it.
                HStack(spacing: 6) {
                    Text(PromptOptimizerCopy.use)
                    Text(PromptOptimizerCopy.useKey).font(.caption).opacity(0.75)
                }
                #else
                Text(PromptOptimizerCopy.use)
                #endif
            }
            .buttonStyle(.borderedProminent)
            .accessibilityLabel(PromptOptimizerCopy.use)
            Button(PromptOptimizerCopy.editThenUse, action: editThenUse)
                .buttonStyle(.bordered)
            Button(PromptOptimizerCopy.tryAgain, action: tryAgain)
                .buttonStyle(.borderless)
            Spacer(minLength: 4)
            #if os(macOS)
            Text(PromptOptimizerCopy.keysHint)
                .font(.caption).foregroundStyle(.tertiary)
                .lineLimit(1)
            #endif
        }
        .controlSize(.small)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

/// The prompt the agent receives: what context added tinted, `code` spans monospaced in `codeStyle`.
private func promptRuns(_ optimization: PromptOptimization, codeStyle: Font.TextStyle) -> Text {
    var out = AttributedString()
    for run in PromptOptimizer.runs(optimization.segments) {
        var piece = AttributedString(run.text)
        if run.added { piece.backgroundColor = addedTint }
        if run.code { piece.font = Font.system(codeStyle, design: .monospaced) }
        out.append(piece)
    }
    return Text(out)
}

#if os(iOS)
/// Frame 4 on a phone: a sheet as tall as what it holds (long, it still drags to full height). A
/// standard header — × to dismiss, the title, ↻ to try again — then the owner's own language first:
/// the gloss, which is what Use inserts, with "Sent to the agent in English · Show" under it opening
/// the prompt the agent gets beneath, smaller and grey. Without a gloss the prompt itself is the text.
/// Then what was used, as one grey line, and Use / Edit full width where the thumb is.
struct PromptOptimizationSheet: View {
    let optimization: PromptOptimization
    let basedOnEarlierDraft: Bool
    /// Here: whether the prompt the agent gets shows under the gloss.
    @Binding var showingPrompt: Bool
    let use: () -> Void
    let edit: () -> Void
    let tryAgain: () -> Void
    let dismiss: () -> Void

    @State private var headerHeight: CGFloat = 0
    @State private var contentHeight: CGFloat = 0
    @State private var actionsHeight: CGFloat = 0
    /// Starts on the fitted detent before anything is measured (the floor below).
    @State private var detent: PresentationDetent = .height(200)

    /// The fitted detent: the header, the words and the buttons, plus room for the drag indicator.
    private var fitted: PresentationDetent {
        .height(max(headerHeight + contentHeight + actionsHeight + 12, 200))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerHeight = $0 }
            ScrollView {
                content
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            actions
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { actionsHeight = $0 }
        }
        .padding(.top, 12)
        .presentationDetents([fitted, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        // Follow the words as they change (Show / Hide), unless the owner dragged it to full height.
        .onChange(of: fitted) { _, now in if detent != .large { detent = now } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer.optimization.card")
    }

    private var header: some View {
        ZStack {
            Label { Text(PromptOptimizerCopy.cardTitle) } icon: { Image(systemName: "sparkles") }
                .font(.headline)
                .labelStyle(.titleAndIcon)
            HStack {
                circleButton("xmark", PromptOptimizerCopy.dismiss, action: dismiss)
                Spacer()
                circleButton("arrow.clockwise", PromptOptimizerCopy.tryAgain, action: tryAgain)
            }
        }
        .padding(.horizontal, 16)
    }

    private func circleButton(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(.primary)
                .frame(width: 44, height: 44)
                .background(Circle().fill(Color(uiColor: .tertiarySystemFill)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            if basedOnEarlierDraft {
                Text(PromptOptimizerCopy.basedOnEarlierDraft)
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Group {
                if let gloss = optimization.gloss { Text(gloss) } else { promptRuns(optimization, codeStyle: .body) }
            }
            .font(.body)
            .textSelection(.enabled)
            if optimization.gloss != nil {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "globe")
                    Text(PromptOptimizerCopy.sentToAgent(optimization.promptLanguage) + " ·")
                    Button(showingPrompt ? PromptOptimizerCopy.hide : PromptOptimizerCopy.show) {
                        showingPrompt.toggle()
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                if showingPrompt {
                    promptRuns(optimization, codeStyle: .footnote)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .padding(.leading, 12)
                        .overlay(alignment: .leading) {
                            Rectangle().fill(Color.secondary.opacity(0.35)).frame(width: 2)
                        }
                }
            }
            if !optimization.chips.isEmpty {
                Text(PromptOptimizerCopy.usedLine(optimization.chips))
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.top, 14)
    }

    private var actions: some View {
        VStack(spacing: 10) {
            Button(action: use) {
                Text(PromptOptimizerCopy.use).fontWeight(.semibold).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            Button(action: edit) {
                Text(PromptOptimizerCopy.edit).fontWeight(.semibold).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(.primary)
        }
        .controlSize(.large)
        .buttonBorderShape(.capsule)
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 8)
    }
}
#endif

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
        #if os(iOS)
        // A phone's: a centred capsule, Undo in bold accent rather than an underlined link.
        HStack(spacing: 14) {
            Text(PromptOptimizerCopy.replaced)
            Button(PromptOptimizerCopy.undo, action: undo)
                .buttonStyle(.plain)
                .fontWeight(.semibold)
                .foregroundStyle(Color.accentColor)
        }
        .font(.subheadline)
        .padding(.horizontal, 18).padding(.vertical, 12)
        .background(.regularMaterial, in: Capsule())
        .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
        .frame(maxWidth: .infinity)
        #else
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
        #endif
    }
}

import SwiftUI
import OrbitKit

/// The card a session page draws when no engine ever ran on it.
///
/// A thin renderer: every word and every decision is `SessionRunStart`'s (OrbitKit), which is
/// where the tests are. The shell is the app's existing repair card — same icon, same warning
/// tint, same button styles as `AntigravityRepairCardView` and `DshRepairCardView` beside it, so
/// this is not a new card style, only a new reason.
struct SessionRunStartCardView: View {
    let console: ConsoleModel
    let card: SessionRunStart.Card
    /// Opens Move for this session, the console's own sheet: the region card's Move to another machine.
    var onMove: (() -> Void)? = nil
    @Environment(AppModel.self) private var appModel
    /// Use another provider's list of the credentials the session's Claude Code can move to.
    @State private var choosingProvider = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(SessionRunStart.title, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange).font(.orbitProse.bold())
            VStack(alignment: .leading, spacing: 4) {
                Text(card.why).font(.orbitLabel.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Text(bodyText).font(.orbitLabel).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // The machine facts: the refusal's code and ref, the runner's own words. Monospaced
            // and selectable, because the thing a reader does with a git error is copy it.
            if !card.lines.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(card.lines, id: \.self) { line in
                        Text(line).font(.orbitMeta.monospaced()).foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
            }
            // The presses wrap where a row can't hold them all — a phone holds two of the region
            // card's three (board 03) — in the card's order, the order they are read in.
            FlowLayout(spacing: 8) {
                ForEach(card.actions.filter(drawable), id: \.kind) { action in
                    if action.primary {
                        Button(action.label) { press(action) }
                            .buttonStyle(.borderedProminent)
                            .disabled(busy(action))
                    } else {
                        Button(action.label) { press(action) }
                            .buttonStyle(.bordered)
                            .disabled(busy(action))
                    }
                }
            }
            .font(.orbitLabel)
            if let footer = card.footer {
                Text(footer).font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .composerBandWash(.orange, opacity: 0.08)
        .accessibilityIdentifier("session-run-start")
        .orbitConfirmation(ClaudeRegionCopy.CLAUDE_REGION_USE_ANOTHER_PROVIDER, isPresented: $choosingProvider) {
            ForEach(otherProviders) { choice in
                Button(SessionProviderChoices.providerName(on: console.engine, choice)) {
                    Task { await console.selectProvider(choice.slug) }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    /// The body, and after it the page it cites (the region check's Supported regions), in the link colour.
    private var bodyText: AttributedString {
        typealias Colour = AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute
        var text = AttributedString(card.body)
        if let link = card.link, let url = URL(string: link.url) {
            var words = AttributedString(link.label)
            words.link = url
            words[Colour.self] = Color.accentColor
            text += AttributedString(" ") + words
        }
        return text
    }

    /// The credentials the session's Claude Code can move to here, the same ones its Provider menu
    /// offers: every one but its own that can run on this machine.
    private var otherProviders: [ProviderChoice] {
        console.providerSwitchChoices.filter { $0.slug != console.provider && $0.unavailable == nil }
    }

    /// Whether this console can make the press: a press that goes nowhere is not drawn (web parity).
    private func drawable(_ action: SessionRunStart.Action) -> Bool {
        switch action.kind {
        case .startItAgain, .sendItAgain, .openRunner, .chatAboutThis: return true
        case .otherProvider: return !otherProviders.isEmpty
        case .moveSession: return onMove != nil
        // Only where the runner checks at all (`region` is nil where it doesn't).
        case .checkAgain: return console.runnerRegion != nil
        }
    }

    private func press(_ action: SessionRunStart.Action) {
        PlatformHaptics.tap()
        switch action.kind {
        case .startItAgain: Task { await console.startRefusedRunAgain() }
        case .sendItAgain: Task { await console.retryLastMessage() }
        case .chatAboutThis: console.chatAboutRunStart()
        case .openRunner:
            if let runnerID = console.runnerID { appModel.route(to: .runner(runnerID)) }
        case .otherProvider: choosingProvider = true
        case .moveSession: onMove?()
        case .checkAgain: Task { await console.checkRegionAgain() }
        }
    }

    private func busy(_ action: SessionRunStart.Action) -> Bool {
        switch action.kind {
        case .startItAgain: return console.startingRun || console.taskID == nil
        case .sendItAgain: return console.sending || console.retryInFlight
        case .openRunner: return console.runnerID == nil
        case .chatAboutThis, .otherProvider, .moveSession: return false
        case .checkAgain: return console.regionChecking || console.runnerOnline == false
        }
    }
}

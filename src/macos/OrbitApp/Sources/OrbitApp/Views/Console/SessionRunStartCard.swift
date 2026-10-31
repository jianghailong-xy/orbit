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
            // card's three (board 03) — and keep their order wherever it can.
            CardActionRows(spacing: 8) {
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

/// The card's presses in rows: each takes the first row with room left for it, and a new row when
/// none has — so a row holds as many as fit and they read in order wherever all of them do (a Mac,
/// a wide pane). On a phone the region card's three come out as board 03 draws them: Use another
/// provider and Check again, then Move to another machine.
private struct CardActionRows: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: rows.map(\.width).max() ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.items {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var items: [Int]; var width: CGFloat; var height: CGFloat }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = []
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if let fit = rows.indices.first(where: { rows[$0].width + spacing + size.width <= width }) {
                rows[fit].items.append(index)
                rows[fit].width += spacing + size.width
                rows[fit].height = max(rows[fit].height, size.height)
            } else {
                rows.append(Row(items: [index], width: size.width, height: size.height))
            }
        }
        return rows
    }
}

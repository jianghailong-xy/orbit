import SwiftUI
#if os(iOS)
import UIKit
#endif
import OrbitKit

// The pieces the runner list, a runner's page and its engine page are drawn from (ios-list.png,
// ios-detail.png): the status dot and slot bar, the machine tile, a Needs Attention row, an engine's
// row with its quota windows, a workspace's row. Each draws what it is handed. The words and what
// the page makes of a runner's numbers are OrbitKit's (`RunnerAttention`, `RunnerPageCopy`,
// `RunnerPageFormat`), where they are tested; iOS and macOS draw these same views.

/// The inks the runner pages speak in: the mock's on light — the system green/orange/red read too
/// faint on white — and the system colours on dark. The same inks the Providers pages' `PoolTone`
/// uses; that one lives with the iOS-only pool pages, and these pages are macOS's as well.
enum RunnerInk {
    static let green = Color(light: Color(red: 0.141, green: 0.541, blue: 0.239), dark: .green)   // #248A3D
    static let amber = Color(light: Color(red: 0.702, green: 0.353, blue: 0), dark: .orange)      // #B35A00
    static let red = Color(light: Color(red: 0.788, green: 0.149, blue: 0.106), dark: .red)       // #C9261B
    /// A gauge at or past its limit: the system orange, the mock's #FF9500.
    static let full = Color.orange
    /// A gauge's empty track.
    static let track = Color.primary.opacity(0.08)
    /// Offline's dot: grey, not red — offline is a state, not a fault.
    static let idle = Color(red: 0.659, green: 0.659, blue: 0.678)                                // #A8A8AD

    /// What the page sits on, so the tile's status dot can be ringed in it.
    static var pageBackground: Color {
        #if os(iOS)
        Color(uiColor: .systemGroupedBackground)
        #else
        Color.orbitSurface
        #endif
    }

    static func dot(_ presence: RunnerPageFormat.Presence) -> Color {
        switch presence {
        case .online: return Color.green
        case .draining: return Color.orange
        case .offline: return idle
        }
    }

    static func status(_ tone: RunnerPageFormat.Tone) -> Color {
        switch tone {
        case .ok: return green
        case .warn: return amber
        case .muted: return Color.secondary
        }
    }

    static func attention(_ tone: RunnerAttentionTone) -> Color {
        switch tone {
        case .bad: return red
        case .warn: return amber
        case .idle: return Color.secondary
        }
    }

    static func attentionWash(_ tone: RunnerAttentionTone) -> Color {
        switch tone {
        case .bad: return Color.red.opacity(0.12)
        case .warn: return Color.orange.opacity(0.13)
        case .idle: return Color.gray.opacity(0.14)
        }
    }
}

/// A section's heading as the runner pages write it: title case in the secondary colour, and a few
/// words at its far end ("Checked 6m ago", a count).
struct RunnerSectionHeader: View {
    let title: String
    let trailing: String?

    init(_ title: String, trailing: String? = nil) {
        self.title = title
        self.trailing = trailing
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
            Spacer(minLength: 8)
            if let trailing {
                Text(trailing)
                    .fontWeight(.regular)
                    .lineLimit(1)
            }
        }
        .font(.orbitLabel.weight(.semibold))
        .foregroundStyle(Color.secondary)
        .textCase(nil)
    }
}

/// Online green, draining amber, offline grey.
struct RunnerStatusDot: View {
    let presence: RunnerPageFormat.Presence
    var size: CGFloat = 8

    var body: some View {
        Circle()
            .fill(RunnerInk.dot(presence))
            .frame(width: size, height: size)
    }
}

/// A thin gauge across whatever width it is given, 0…1.
struct RunnerGauge: View {
    let fraction: Double
    let tint: Color
    var height: CGFloat = 5

    var body: some View {
        Capsule()
            .fill(RunnerInk.track)
            .frame(height: height)
            .overlay(alignment: .leading) {
                GeometryReader { geo in
                    Capsule()
                        .fill(tint)
                        .frame(width: geo.size.width * CGFloat(min(1, max(0, fraction))), height: height)
                }
            }
    }
}

/// A list row's slot bar, the web card's runner-util: 44×5, amber once every slot is taken.
struct RunnerSlotBar: View {
    let slots: RunnerPageFormat.Slots

    var body: some View {
        RunnerGauge(fraction: slots.fraction, tint: slots.full ? RunnerInk.full : Color.accentColor)
            .frame(width: 44)
    }
}

/// The disclosure a pushing row draws by hand — a `Button` row has none of its own, and a
/// `NavigationLink`'s cannot be moved or matched on iOS 17/18 (see `AppModel.push`).
struct RunnerChevron: View {
    var body: some View {
        Image(systemName: "chevron.forward")
            .font(.orbitLabel.weight(.semibold))
            .foregroundStyle(Color.secondary.opacity(0.6))
            .accessibilityHidden(true)
    }
}

/// The machine in the page head: a grey tile, and its status dot in the corner ringed in the page's
/// own colour (the Codex pool page's head, with a machine for a mark).
struct RunnerMachineTile: View {
    let presence: RunnerPageFormat.Presence

    var body: some View {
        RoundedRectangle(cornerRadius: 15, style: .continuous)
            .fill(LinearGradient(colors: [Color(red: 0.557, green: 0.573, blue: 0.604),
                                          Color(red: 0.373, green: 0.388, blue: 0.420)],
                                 startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: 56, height: 56)
            .overlay {
                Image(systemName: "desktopcomputer")
                    .font(.title2)
                    .foregroundStyle(Color.white)
            }
            .overlay(alignment: .bottomTrailing) {
                RunnerStatusDot(presence: presence, size: 16)
                    .overlay { Circle().strokeBorder(RunnerInk.pageBackground, lineWidth: 3) }
                    .offset(x: 3, y: 3)
            }
            .accessibilityHidden(true)
    }
}

/// One quota window: its name and how much is used, the gauge, and when it resets — the Codex pool
/// page's `CodexWindowRow`, amber from 90% (`PlanUsageRow.nearLimit`).
struct RunnerWindowRow: View {
    let row: PlanUsageRow
    let resets: String?

    var body: some View {
        let warn = row.nearLimit
        VStack(alignment: .leading, spacing: 4) {
            if let group = row.groupLabel {
                Text(group).font(.orbitLabel.weight(.semibold))
            }
            HStack(alignment: .firstTextBaseline) {
                Text(row.label)
                    .font(.orbitLabel.weight(.semibold))
                Spacer(minLength: 8)
                Text(verbatim: "\(row.percent)%\(row.remaining ? " remaining" : "")")
                    .font(.orbitLabel)
                    .foregroundStyle(Color.secondary)
                    .monospacedDigit()
            }
            RunnerGauge(fraction: Double(row.percent) / 100, tint: warn ? RunnerInk.full : Color.accentColor)
            if let resets {
                Text(resets)
                    .font(.orbitMeta)
                    .foregroundStyle(warn ? RunnerInk.amber : Color.secondary)
            }
        }
    }
}

/// The glyph a Needs Attention item is drawn with.
private func runnerAttentionGlyph(_ kind: RunnerAttentionKind) -> String {
    switch kind {
    case .offline: return "power"
    case .engineSignedOut: return "person.crop.circle.badge.exclamationmark"
    case .checkoutStuck: return "arrow.triangle.branch"
    case .quotaNearLimit: return "gauge.with.dots.needle.67percent"
    case .diskLow: return "internaldrive"
    case .cannotSelfUpdate: return "arrow.up.circle"
    case .engineNotUpdating: return "arrow.triangle.2.circlepath"
    }
}

/// One Needs Attention item: what happened, why it matters, and — under the words — what to do.
struct RunnerAttentionRow<Action: View>: View {
    let item: RunnerAttentionItem
    let detail: AttributedString
    let action: Action

    init(item: RunnerAttentionItem, detail: AttributedString, @ViewBuilder action: () -> Action) {
        self.item = item
        self.detail = detail
        self.action = action()
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: runnerAttentionGlyph(item.kind))
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(RunnerInk.attention(item.tone))
                .frame(width: 28, height: 28)
                .background(RunnerInk.attentionWash(item.tone),
                            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.headline)
                Text(detail)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                action
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }
}

/// An in-row press drawn as a tinted capsule — Set a Reserve…, Copy Command. Its own style, so a
/// list row that holds one doesn't hand the whole row's tap to it.
struct RunnerCapsuleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RunnerCapsule(pressed: configuration.isPressed) { configuration.label }
    }
}

/// The capsule itself: tinted, or grey while it can't be pressed. Also drawn on its own where the
/// press belongs to the whole row (an engine row's Sign In, which opens the engine's page).
struct RunnerCapsule<Label: View>: View {
    var pressed = false
    /// Nil follows the environment; a value says it outright, for a capsule that isn't a button.
    var enabled: Bool? = nil
    let label: Label
    @Environment(\.isEnabled) private var isEnabled

    init(pressed: Bool = false, enabled: Bool? = nil, @ViewBuilder label: () -> Label) {
        self.pressed = pressed
        self.enabled = enabled
        self.label = label()
    }

    var body: some View {
        let on = enabled ?? isEnabled
        label
            .font(.orbitListSubtitle.weight(.semibold))
            .foregroundStyle(on ? Color.accentColor : Color.secondary)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(on ? Color.accentColor.opacity(pressed ? 0.2 : 0.12) : Color.primary.opacity(0.06),
                        in: Capsule())
            .padding(.top, 7)
    }
}

/// One engine on the runner's page: its mark and name, its version and where its sign-ins stand, a
/// failed update that has become its problem, Sign In when a login it needs is out, and — while it
/// is signed in with one account — its quota windows.
struct RunnerEngineRow: View {
    let health: RunnerEngineHealth
    let runner: Runner
    let offline: Bool
    let now: Date

    var body: some View {
        let windows = RunnerPageFormat.engineWindows(runner, engine: health.engine)
        HStack(spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                ProviderMark(provider: health.engine, size: 28, label: RunnerPageFormat.engineName(health.engine))
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(RunnerPageFormat.engineName(health.engine))
                    Text(statusLine)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(Color.secondary)
                    if let failed = RunnerPageFormat.updateFailedLine(health, now: now) {
                        Text(failed)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(RunnerInk.amber)
                    }
                    if health.engine == "antigravity" {
                        if RunnerPageFormat.antigravityCanSignIn(runner) {
                            RunnerCapsule(enabled: !offline) { Text(health.auth == "yes" && health.authSource == "google" ? "Re-sign in" : "Sign in with Google") }
                            GoogleSignInTermsView()
                        } else if let hint = EngineAuth.antigravityLoginHint(runner.antigravity?.googleLogin) {
                            Text(hint)
                                .font(.orbitLabel)
                                .foregroundStyle(Color.secondary)
                        }
                    } else if RunnerPageFormat.needsSignIn(health) {
                        RunnerCapsule(enabled: !offline) { Text(RunnerPageCopy.RUNNER_SIGN_IN) }
                    }
                    if !windows.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(windows) { row in
                                RunnerWindowRow(row: row, resets: RunnerPageFormat.resetsLine(row, now: now))
                            }
                        }
                        .padding(.top, 8)
                    }
                }
            }
            Spacer(minLength: 0)
            if health.installed == true {
                RunnerChevron()
            }
        }
        .padding(.vertical, 2)
    }

    /// `2.1.284 · Signed in`, the state in its colour.
    private var statusLine: AttributedString {
        typealias Colour = AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute
        let status = RunnerPageFormat.engineStatus(health, runner: runner)
        let version = health.installed == true ? RunnerPageFormat.engineVersion(health.version) : nil
        var line = AttributedString(version ?? "")
        if let status {
            if version != nil { line += AttributedString(RunnerPageCopy.RUNNER_LINE_SEPARATOR) }
            var words = AttributedString(status.text)
            if status.tone != .muted { words[Colour.self] = RunnerInk.status(status.tone) }
            line += words
        }
        return line
    }
}

/// One of the runner's workspaces: where it works, and how many of its sessions are running.
struct RunnerWorkspaceRow: View {
    let workspace: Agent
    let running: Int

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "folder")
                .font(.orbitListSubtitle)
                .foregroundStyle(Color.secondary)
                .frame(width: 28, height: 28)
                .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(workspace.name)
                    .lineLimit(1)
                let line = RunnerPageFormat.workspaceLine(workspace)
                if !line.isEmpty {
                    Text(line)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if running > 0 {
                Text(RunnerPageCopy.runnerWorkspaceRunning(count: running))
                    .font(.orbitListSubtitle.weight(.medium))
                    .foregroundStyle(Color.accentColor)
            }
            RunnerChevron()
        }
        .padding(.vertical, 2)
    }
}

/// A sentence with some of its words set apart: the names it names in the weight of a title, and a
/// command or a path in monospace on a faint chip — the mock's inline `code`.
func runnerStyledText(_ text: String, strong: [String] = [], code: [String] = []) -> AttributedString {
    typealias FontKey = AttributeScopes.SwiftUIAttributes.FontAttribute
    var out = AttributedString(text)
    for word in strong where !word.isEmpty {
        if let range = out.range(of: word) {
            out[range][FontKey.self] = Font.orbitListSubtitle.weight(.semibold)
        }
    }
    for word in code where !word.isEmpty {
        if let range = out.range(of: word) {
            out[range][FontKey.self] = Font.orbitMono
            out[range].backgroundColor = Color.secondary.opacity(0.12)
        }
    }
    return out
}

/// A line whose first word is drawn in its own colour and weight: `Online` in green, `Offline` grey.
func runnerLeadingWord(_ line: String, word: String, colour: Color) -> AttributedString {
    typealias Colour = AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute
    typealias FontKey = AttributeScopes.SwiftUIAttributes.FontAttribute
    var out = AttributedString(line)
    if line.hasPrefix(word), let range = out.range(of: word) {
        out[range][Colour.self] = colour
        out[range][FontKey.self] = Font.orbitListSubtitle.weight(.medium)
    }
    return out
}

extension View {
    /// A row that pushes or opens something: on iOS the list's own row press; on macOS — where a
    /// form's button is a bordered push button — the row as drawn, clickable across its width.
    @ViewBuilder func runnerRowButtonStyle() -> some View {
        #if os(macOS)
        self.buttonStyle(.plain)
        #else
        self
        #endif
    }

    /// A line over the page's foot for a moment: why a press didn't go through, or what one did that
    /// isn't on screen by itself.
    func runnerNotice(_ text: String?) -> some View {
        overlay(alignment: .bottom) {
            if let text {
                Text(text)
                    .font(.orbitListSubtitle.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.horizontal, 24)
                    .padding(.bottom, 24)
                    .transition(.opacity)
            }
        }
        .animation(.default, value: text)
    }
}

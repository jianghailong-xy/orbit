import SwiftUI
import OrbitKit

/// Circular agent identity mark: the Orbit terminal glyph (`>_`) on a provider-tinted gradient. The
/// data model carries no per-agent avatar, so identity reads from the provider color + the shared
/// mark. Used as the hero of the new-session empty state and in the agent switcher.
struct AgentAvatar: View {
    let provider: String?
    var size: CGFloat = 64

    var body: some View {
        Circle()
            .fill(Self.gradient(for: provider))
            .overlay {
                Text(">_")
                    .font(.system(size: size * 0.4, weight: .bold, design: .monospaced))
                    .foregroundStyle(.white)
                    .offset(y: -size * 0.03)
            }
            .overlay { Circle().strokeBorder(.white.opacity(0.16), lineWidth: 1) }
            .frame(width: size, height: size)
            .shadow(color: Self.tint(for: provider).opacity(0.35), radius: size * 0.12, y: size * 0.06)
    }

    /// Provider accent: Claude coral by default, a distinct hue for Codex/DeepSeek so a runner with
    /// several providers reads at a glance.
    static func tint(for provider: String?) -> Color {
        switch provider?.lowercased() {
        case "codex", "openai": return Color(red: 0.28, green: 0.68, blue: 0.47)   // green
        case "deepseek":        return Color(red: 0.36, green: 0.55, blue: 0.85)   // blue
        default:                return Color(red: 0.85, green: 0.47, blue: 0.34)   // claude coral
        }
    }

    static func gradient(for provider: String?) -> LinearGradient {
        let base = tint(for: provider)
        return LinearGradient(colors: [base, base.opacity(0.78)],
                              startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

/// Agent picker opened from the new-session hero. Lists every agent (drawer order) with its model,
/// marks the current one, and reports a pick back to the caller — which switches the composing agent.
/// A flat list (not runner-grouped) keeps it light; the caller owns the switch so this view needs no
/// environment (which doesn't always propagate into a sheet).
struct AgentSwitchSheet: View {
    let agents: [Agent]
    let currentID: String
    let onSelect: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(agents) { agent in
                Button {
                    // Dismiss first, then switch: the switch rebuilds the presenting NewSessionView
                    // (its `.id(agent.id)` changes), so tearing the sheet down ourselves first avoids
                    // dismissing through a view that's already gone.
                    dismiss()
                    if agent.id != currentID { onSelect(agent.id) }
                } label: {
                    HStack(spacing: 12) {
                        AgentAvatar(provider: agent.provider, size: 38)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(agent.name).foregroundStyle(.primary).lineLimit(1)
                            if let model = agent.model, !model.isEmpty {
                                Text(AgentDefaults.friendlyName(model))
                                    .font(.orbitListSubtitle).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer(minLength: 8)
                        if agent.id == currentID {
                            Image(systemName: "checkmark")
                                .font(.body.weight(.semibold)).foregroundStyle(Color.accentColor)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .navigationTitle("Switch agent")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            #endif
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #endif
    }
}

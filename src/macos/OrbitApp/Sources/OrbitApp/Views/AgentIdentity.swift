import SwiftUI
import OrbitKit

/// Circular agent identity mark. Claude and Codex render their official brand marks (the Anthropic
/// sunburst / OpenAI blossom, see `BrandMarks.swift`) on a brand-tinted circle so the hero reads as
/// "an official Claude/Codex agent" at a glance; other providers keep the neutral Orbit `>_` glyph.
/// The data model carries no per-agent avatar, so identity reads from the provider alone. Used as
/// the hero of the new-session empty state and in the agent switcher.
struct AgentAvatar: View {
    let provider: String?
    var size: CGFloat = 64
    /// Vendor preset to brand by, when the provider slug alone doesn't say. A configured provider
    /// can be called anything ("deepseek-2"), so the picker passes the preset it was created from;
    /// nil keeps the historical behaviour of branding by the slug itself.
    var brandKey: String? = nil

    /// What the mark and tint resolve from — the preset when one is known, else the raw slug.
    private var identity: String? { brandKey ?? provider }

    var body: some View {
        Circle()
            .fill(Self.gradient(for: identity))
            .overlay { mark }
            .overlay { Circle().strokeBorder(.white.opacity(0.16), lineWidth: 1) }
            .frame(width: size, height: size)
            .shadow(color: Self.tint(for: identity).opacity(0.35), radius: size * 0.12, y: size * 0.06)
    }

    /// The brand mark knocked out in white, or the `>_` glyph for providers without an official mark.
    @ViewBuilder private var mark: some View {
        let brand = AgentBrand.from(identity)
        if let path = brand.markPath {
            VectorMark(pathData: path)
                .fill(.white)
                .frame(width: size * brand.markScale, height: size * brand.markScale)
        } else {
            Text(">_")
                .font(.orbitAgentGlyph(size))
                .foregroundStyle(.white)
                .offset(y: -size * 0.03)
        }
    }

    /// Brand-aware circle: Claude coral, OpenAI near-black for Codex, and distinct hues for Kimi,
    /// OpenCode and DeepSeek — so a runner with several providers reads at a glance.
    static func tint(for provider: String?) -> Color {
        switch provider?.lowercased() {
        case "codex", "openai":  return Color(red: 0.11, green: 0.11, blue: 0.12)  // OpenAI near-black
        case "kimi", "moonshot": return Color(red: 0.36, green: 0.45, blue: 0.92)  // indigo
        case "opencode":         return Color(red: 0.08, green: 0.56, blue: 0.50)  // OpenCode teal
        case "deepseek":         return Color(red: 0.36, green: 0.55, blue: 0.85)  // blue
        default:                 return Color(red: 0.85, green: 0.47, blue: 0.34)  // claude coral
        }
    }

    static func gradient(for provider: String?) -> LinearGradient {
        let base = tint(for: provider)
        return LinearGradient(colors: [base, base.opacity(0.78)],
                              startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

/// Provider picker opened from the new-session hero — who runs this session, as opposed to the
/// agent switcher below (where it runs). Two sections, because engines and configured providers
/// differ in the one way a user cares about: an engine spends the subscription signed into on that
/// machine, a configured provider spends the API key you pasted. Each row previews the model it
/// would switch to, so the consequence is visible before the tap.
struct ProviderSwitchSheet: View {
    let choices: [ProviderChoice]
    let currentSlug: String
    let agentName: String
    let onSelect: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    private var engines: [ProviderChoice] { choices.filter { $0.kind == .engine } }
    private var byok: [ProviderChoice] { choices.filter { $0.kind == .byok } }

    var body: some View {
        NavigationStack {
            List {
                section("Engines", engines, footer: "Signed in on this runner.")
                if !byok.isEmpty {
                    section("Your keys", byok, footer: "Billed to the API key you configured.")
                }
                Section {
                    Text("Switching is remembered as \(agentName)'s default.")
                        .font(.orbitListSubtitle).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Who runs this?")
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

    @ViewBuilder
    private func section(_ title: String, _ rows: [ProviderChoice], footer: String) -> some View {
        Section {
            ForEach(rows) { choice in
                Button {
                    // Dismiss first, then switch — same ordering as AgentSwitchSheet, so the sheet
                    // never tears down through a view the switch has already rebuilt.
                    dismiss()
                    if choice.slug != currentSlug { onSelect(choice.slug) }
                } label: {
                    HStack(spacing: 12) {
                        AgentAvatar(provider: choice.slug, size: 28, brandKey: choice.brandKey)
                        Text(choice.label).foregroundStyle(.primary).lineLimit(1)
                        Spacer(minLength: 8)
                        Text(choice.modelLabel)
                            .font(.orbitListSubtitle).foregroundStyle(.secondary).lineLimit(1)
                        if choice.slug == currentSlug {
                            Image(systemName: "checkmark")
                                .font(.body.weight(.semibold)).foregroundStyle(Color.accentColor)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        } header: {
            Text(title)
        } footer: {
            Text(footer)
        }
    }
}

/// Agent picker opened from the new-session hero. Lists every agent (drawer order) with its runtime,
/// marks the current one, and reports a pick back to the caller — which switches the composing agent.
/// A flat list (not runner-grouped) keeps it light; the caller owns the switch so this view needs no
/// environment (which doesn't always propagate into a sheet).
struct AgentSwitchSheet: View {
    let agents: [Agent]
    let currentID: String
    let configuredProviders: [ConfiguredProvider]
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
                            Text(AgentDefaults.providerName(
                                agent.provider ?? "claude", configured: configuredProviders))
                                .font(.orbitListSubtitle).foregroundStyle(.secondary).lineLimit(1)
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

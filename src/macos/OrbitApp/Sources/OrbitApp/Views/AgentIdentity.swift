import SwiftUI
import OrbitKit

/// The provider's brand tile — the native port of web's `ProviderMark` (the same mark the
/// /providers gallery and the web new-session hero draw). A rounded square carrying the vendor's
/// official glyph knocked out in white over that vendor's gradient, with a letter monogram on the
/// neutral grey tile when a provider has no official mark (web's `NEUTRAL_BRAND`). Geometry follows
/// web: corner radius and glyph are fixed fractions of the tile, so one `size` drives the whole mark.
///
/// The data model carries no per-agent avatar, so identity reads from the provider alone. Used as
/// the hero of the new-session empty state, in the engine picker, and in the agent switcher.
struct ProviderMark: View {
    let provider: String?
    var size: CGFloat = 64
    /// Vendor preset to brand by, when the provider slug alone doesn't say. A configured provider
    /// can be called anything ("deepseek-2"), so the picker passes the preset it was created from;
    /// nil keeps the historical behaviour of branding by the slug itself.
    var brandKey: String? = nil
    /// Display name, used only for the neutral monogram — web takes the same first letter of the
    /// label when a provider has no preset. Falls back to the slug, then "?".
    var label: String? = nil

    /// What the mark and gradient resolve from — the preset when one is known, else the raw slug.
    private var identity: String? { brandKey ?? provider }
    private var brand: AgentBrand { AgentBrand.from(identity) }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
        let stops = brand.gradient
        shape
            .fill(LinearGradient(colors: [stops.from, stops.to],
                                 startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay { mark }
            .overlay { shape.strokeBorder(.white.opacity(0.16), lineWidth: 1) }
            .frame(width: size, height: size)
            // Web lifts the hero-sized tile on a shadow in its own brand colour; a small row chip
            // gets none, since at 20–28pt it only muddies the edge.
            .shadow(color: size >= 40 ? stops.to.opacity(0.34) : .clear,
                    radius: size * 0.16, y: size * 0.10)
    }

    /// The official mark knocked out in white, or the neutral monogram.
    @ViewBuilder private var mark: some View {
        if let path = brand.markPath {
            VectorMark(pathData: path)
                .fill(.white)
                .frame(width: size * brand.markScale, height: size * brand.markScale)
        } else {
            Text(monogram)
                .font(.orbitAgentGlyph(size))
                .foregroundStyle(.white)
        }
    }

    /// First letter of the label (web's `NEUTRAL_BRAND`), falling back to the slug.
    private var monogram: String {
        let source = (label?.trimmingCharacters(in: .whitespaces).isEmpty == false ? label : provider) ?? ""
        return source.first.map { String($0).uppercased() } ?? "?"
    }
}

/// Engine picker opened from the new-session hero — which CLI runs this session, as opposed to the
/// agent switcher (where it runs). One row per engine, landing on the provider of it the draft would
/// spend (`SessionProviderChoices.engines`), and saying so ("via DeepSeek") when that is not the
/// engine's own sign-in. Which provider and which account is the composer's Provider menu's
/// question, as on a session already running. Each row previews the model it would switch to, so the
/// consequence is visible before the tap (web's `NewSessionProviderHero`).
struct EngineSwitchSheet: View {
    let engines: [EngineChoice]
    let current: EngineChoice
    let agentName: String
    /// An engine was picked: the provider of it to start on (`EngineChoice.provider`).
    let onSelect: (String) -> Void
    /// Where to send a row this machine can't run: the runner whose Engines section holds its
    /// install / Sign in. Nil leaves such a row inert, which is all an unknown runner allows.
    var onFixRunner: ((String) -> Void)?
    @Environment(\.dismiss) private var dismiss

    private var displayed: [EngineChoice] {
        engines.contains { $0.slug == current.slug } ? engines : [current] + engines
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(displayed) { row($0) }
                } footer: {
                    Text("Pick the provider and account in the composer's model menu.")
                }
                Section {
                    Text("Switching is remembered as \(agentName)'s default.")
                        .font(.orbitListSubtitle).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Engine")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            #else
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            #endif
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #else
        // A macOS sheet takes its content's ideal size, and a List has none: without a frame the
        // sheet collapsed to its title and first header, and no row could be picked.
        .frame(minWidth: 420, idealWidth: 460, minHeight: 420, idealHeight: 520)
        #endif
    }

    @ViewBuilder
    private func row(_ engine: EngineChoice) -> some View {
        // A pool the server says cannot run at all is greyed out: no machine gives it an account that
        // can, so unlike a row a runner can fix it goes nowhere, and says why instead.
        let greyed = engine.unavailable != nil && engine.fixEngine == nil
        Button {
            // Dismiss first, then switch — same ordering as AgentSwitchSheet, so the sheet
            // never tears down through a view the switch has already rebuilt.
            dismiss()
            // A row this machine can't run isn't a pick — it's a request for the sign-in
            // (or install) that would make it one, so go where that lives instead.
            if engine.unavailable != nil {
                if !greyed { onFixRunner?(engine.fixEngine ?? engine.slug) }
            } else if engine.provider.slug != current.provider.slug {
                onSelect(engine.provider.slug)
            }
        } label: {
            HStack(spacing: 12) {
                Group {
                    ProviderMark(provider: engine.slug, size: 28, brandKey: engine.brandKey, label: engine.label)
                    Text(engine.label).foregroundStyle(.primary).lineLimit(1)
                    if let detail = engine.providerDetail {
                        Text(detail).font(.orbitListSubtitle).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .opacity(greyed ? 0.5 : 1)
                Spacer(minLength: 8)
                // The reason replaces the model on a row that can't run, and doubles as the row's call
                // to action, so it takes the accent the way web's does — except on a greyed row, where
                // there is nothing to do. A spent pool's note takes the model's place too, in its grey.
                Text(trailing(engine, greyed: greyed))
                    .font(.orbitListSubtitle)
                    .foregroundStyle(engine.unavailable == nil || greyed ? AnyShapeStyle(.secondary)
                                                                         : AnyShapeStyle(Color.accentColor))
                    .lineLimit(1)
                if engine.slug == current.slug {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold)).foregroundStyle(Color.accentColor)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(greyed && engine.slug != current.slug)
    }

    private func trailing(_ engine: EngineChoice, greyed: Bool) -> String {
        guard let reason = engine.unavailable else { return engine.provider.note ?? engine.provider.modelLabel }
        return greyed ? reason
            : ["antigravity", "dsh", DshRuntime.connectFix].contains(engine.fixEngine ?? "") ? "\(reason) →" : "\(reason), sign in →"
    }
}

/// Static workspace name for the iOS session list and new-session navigation bars.
/// `.fixedSize()` keeps iOS 26's leading toolbar slot from compressing even short names. The list
/// also hides this item's shared background so the drawer button keeps its own glass circle.
struct WorkspaceTitle: View {
    let name: String

    var body: some View {
        Text(name)
            .font(.headline).foregroundStyle(.primary).lineLimit(1).truncationMode(.tail)
            .fixedSize()
            .accessibilityLabel("Workspace: \(name)")
    }
}

/// Clickable title used by the iOS task list and the macOS new-session workspace picker.
///
/// `.fixedSize()` is load-bearing, not tidiness. iOS 26 hands a *custom* item in the leading slot a
/// proposal far narrower than the item's own content: measured on an iPhone 17 Pro Max simulator
/// (`.ios-probe` probe, iOS 26 — the same arrangement the shipped bar has), the label drew the name
/// at 14.7pt against an ideal of 37.7pt for `orbit`, and 14.7 against 125.3 for `wikova-develop`
/// — i.e. a two-letter "or" on a bar with ~190pt of empty space beside it. Nothing else in the bar
/// was doing it: removing the two trailing buttons, or the `.navigationBarDrawer` search field,
/// left the name at 14.7. `.fixedSize()` makes the control answer with its ideal width instead, and
/// both names then measure FULL; so does a `Menu`. `.layoutPriority(1)` on the name does not (still
/// 14.7), and neither does dropping the `Button` for a bare `Text` (31.7 of 37.7).
///
/// The one case this does not cover is a name wider than the bar itself, which would be clipped
/// rather than truncated — today's longest workspace name is 125pt against ~250pt of room.
///
/// Its sibling on the task list's bar is the item's *shared background*: iOS 26 would group this
/// control with the drawer button into one glass platter, so `TasksListView` declares the item with
/// `.sharedBackgroundVisibility(.hidden)` and the name draws on the bar instead. iOS 26 only, and
/// measured on an iPhone 17 Pro Max simulator like the widths above: with the system's shared
/// background the two share one 102pt platter, without it the name sits on the bar beside the
/// drawer button's own circle.
struct WorkspaceTitleSwitcher: View {
    let name: String
    /// What the name names, for VoiceOver ("Workspace: orbit. Switch").
    var subject = "Workspace"
    /// A cap on the name's width, past which it truncates rather than pushing the bar's trailing
    /// buttons. Nil draws the whole name; a task list's title can be a sentence.
    var maxNameWidth: CGFloat?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(name)
                    .font(.headline).foregroundStyle(.primary).lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: maxNameWidth, alignment: .leading)
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityLabel("\(subject): \(name). Switch")
    }
}

/// Agent picker opened from the macOS new-session hero. Lists agents in drawer order and reports
/// the selection to the caller, which switches the composing agent.
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
                        ProviderMark(provider: agent.defaultProvider, size: 38)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(agent.name).foregroundStyle(.primary).lineLimit(1)
                            Text(AgentDefaults.providerName(
                                agent.defaultProvider, configured: configuredProviders))
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

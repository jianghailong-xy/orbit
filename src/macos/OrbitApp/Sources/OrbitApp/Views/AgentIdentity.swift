import SwiftUI
import OrbitKit

/// The provider's brand tile — the native port of web's `ProviderMark` (the same mark the
/// /providers gallery and the web new-session hero draw). A rounded square carrying the vendor's
/// official glyph knocked out in white over that vendor's gradient, with a letter monogram on the
/// neutral grey tile when a provider has no official mark (web's `NEUTRAL_BRAND`). Geometry follows
/// web: corner radius and glyph are fixed fractions of the tile, so one `size` drives the whole mark.
///
/// The data model carries no per-agent avatar, so identity reads from the provider alone. Used as
/// the hero of the new-session empty state, in the provider picker, and in the agent switcher.
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
    /// Where to send a row this machine can't run: the runner whose Engines section holds its
    /// install / Sign in. Nil leaves such a row inert, which is all an unknown runner allows.
    var onFixRunner: (() -> Void)?
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
                    // A row this machine can't run isn't a pick — it's a request for the sign-in
                    // (or install) that would make it one, so go where that lives instead.
                    if choice.unavailable != nil, choice.slug != currentSlug {
                        onFixRunner?()
                    } else if choice.slug != currentSlug {
                        onSelect(choice.slug)
                    }
                } label: {
                    HStack(spacing: 12) {
                        ProviderMark(provider: choice.slug, size: 28, brandKey: choice.brandKey,
                                     label: choice.label)
                        Text(choice.label).foregroundStyle(.primary).lineLimit(1)
                        Spacer(minLength: 8)
                        // The reason replaces the model on a row that can't run: which model it
                        // would pick is moot until the CLI is installed or signed into. It also
                        // doubles as the row's call to action, so it takes the accent the way
                        // web's does rather than sitting in the model column's grey.
                        Text(choice.unavailable.map { "\($0), sign in →" } ?? choice.modelLabel)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(choice.unavailable == nil ? AnyShapeStyle(.secondary)
                                                                       : AnyShapeStyle(Color.accentColor))
                            .lineLimit(1)
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
/// The workspace switcher: the workspace's name and a down chevron — the navigation bar's title
/// slot on the new-session draft, and its leading edge on the session list (whose title slot cannot
/// hold a custom view once the name is long: see `AgentsView`'s toolbar).
///
/// One definition for the two screens whose title *is* a workspace — the session list (whose content
/// all belongs to it) and the new-session draft (which will send into it). They open the same
/// `AgentSwitchSheet`; what a selection means differs, and only the call site knows that: the list
/// enters the workspace (`AppModel.openAgent`), the draft composes with it.
///
/// Name and chevron only: the brand mark belongs to the new-session hero, and repeating it here in
/// miniature said nothing the screen wasn't already saying.
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
/// Its sibling on the session list's bar is the item's *shared background*: iOS 26 would group this
/// control with the drawer button into one glass platter, so `AgentsView` declares the item with
/// `.sharedBackgroundVisibility(.hidden)` and the name draws on the bar instead. iOS 26 only, and
/// measured on an iPhone 17 Pro Max simulator like the widths above: with the system's shared
/// background the two share one 102pt platter, without it the name sits on the bar beside the
/// drawer button's own circle.
struct WorkspaceTitleSwitcher: View {
    let name: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(name)
                    .font(.headline).foregroundStyle(.primary).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityLabel("Workspace: \(name). Switch")
    }
}

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

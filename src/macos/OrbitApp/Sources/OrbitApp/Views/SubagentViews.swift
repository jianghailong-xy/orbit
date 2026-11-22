import SwiftUI
import OrbitKit

// SubAgents (docs/subagent-design.md §7, board docs/mocks/subagent/05.png, its Workflows row from board
// docs/mocks/subagent-workflow part 5): an Agent's SubAgents group, the provider list it opens, and the
// Infrastructure page's Model tiers table. Words and rules are OrbitKit's `SubagentSettings`.

/// An Agent's SubAgents group. The workspace fields are the form's working copy, written by Done with the
/// rest; the blocked providers are the account's, written as each switch moves (the sheet).
struct SubagentSettingsSection: View {
    let agents: AgentsModel
    @Binding var enabled: Bool
    @Binding var workflowsEnabled: Bool
    @Binding var maxRunning: Int
    @Environment(AppModel.self) private var app
    @State private var editingProviders = false

    private var blocked: [String] { app.user?.preferences?.subagentBlockedProviders ?? [] }

    var body: some View {
        Section(SubagentSettings.groupTitle) {
            Toggle(isOn: $enabled) {
                SubagentRowLabel(title: SubagentSettings.enabledTitle, detail: SubagentSettings.enabledDetail)
            }

            // It follows SubAgents: off and not to be turned on while SubAgents is off (SubagentSettings.workflowsOn).
            Toggle(isOn: Binding(
                get: { SubagentSettings.workflowsOn(subagentsEnabled: enabled, workflowsEnabled: workflowsEnabled) },
                set: { workflowsEnabled = $0 }
            )) {
                SubagentRowLabel(title: SubagentSettings.workflowsTitle, detail: SubagentSettings.workflowsDetail)
            }
            .disabled(!enabled)
            .accessibilityIdentifier("subagents.workflows")

            HStack(spacing: 12) {
                SubagentRowLabel(title: SubagentSettings.providers, detail: SubagentSettings.providersDetail)
                Spacer(minLength: 8)
                Button {
                    editingProviders = true
                } label: {
                    Text(agents.subagentTiers.map {
                        SubagentSettings.providersButton($0.providers, blocked: blocked)
                    } ?? SubagentSettings.edit)
                    .monospacedDigit()
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("subagents.providers")
                // On the button, not the Section: a Section hands its modifiers to every row, and four
                // sheets on one binding present none.
                .sheet(isPresented: $editingProviders) {
                    SubagentProvidersSheet(agents: agents)
                }
                .task { if agents.subagentTiers == nil { await agents.loadSubagentTiers() } }
            }

            Stepper(value: $maxRunning, in: SubagentSettings.maxRunningRange) {
                HStack {
                    SubagentRowLabel(title: SubagentSettings.runningAtOnce,
                                     detail: SubagentSettings.runningAtOnceDetail)
                    Spacer(minLength: 8)
                    Text("\(maxRunning)").monospacedDigit()
                }
            }
        }
    }
}

private struct SubagentRowLabel: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
            Text(detail)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Every provider, each with a switch: on, SubAgents may use it. A switch writes the account's whole
/// blocked list at once (PATCH /users/me/preferences `subagentBlockedProviders`).
struct SubagentProvidersSheet: View {
    let agents: AgentsModel
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var blocked: [String] = []

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if let tiers = agents.subagentTiers {
                        ForEach(tiers.providers) { provider in
                            Toggle(isOn: binding(provider.slug)) {
                                HStack(spacing: 12) {
                                    ProviderMark(provider: provider.slug, size: 26, label: provider.label)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(provider.label)
                                        if provider.label != provider.slug {
                                            Text(provider.slug)
                                                .font(.orbitListSubtitle)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                }
                            }
                        }
                    } else if agents.subagentTiersFailed {
                        Text(SubagentSettings.providersLoadFailed).foregroundStyle(.secondary)
                    } else {
                        ProgressView()
                    }
                } footer: {
                    Text(SubagentSettings.providersDetail)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(SubagentSettings.providers)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear { blocked = app.user?.preferences?.subagentBlockedProviders ?? [] }
        .task { if agents.subagentTiers == nil { await agents.loadSubagentTiers() } }
    }

    private func binding(_ slug: String) -> Binding<Bool> {
        Binding(
            get: { !blocked.contains(slug) },
            set: { allowed in
                blocked = SubagentSettings.blocked(blocked, slug: slug, allowed: allowed)
                let list = blocked
                Task { await app.savePreferences(UpdatePreferencesRequest(subagentBlockedProviders: list)) }
            }
        )
    }
}

// MARK: - Model tiers

/// The Infrastructure page's Model tiers: each provider's models with the tier SubAgents route them by and
/// their output price. A model of the owner's own key with no catalogue tier takes one here.
struct InfrastructureModelTiersSection: View {
    let agents: AgentsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        let providers = SubagentSettings.tableProviders(agents.subagentTiers?.providers ?? [])
        Section {
            if agents.subagentTiers == nil {
                if agents.subagentTiersFailed {
                    Text(SubagentSettings.providersLoadFailed).foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            } else {
                columnHeads
                ForEach(providers) { provider in
                    ForEach(provider.models) { model in
                        row(provider, model)
                    }
                }
            }
        } header: {
            RunnerSectionHeader(SubagentSettings.modelTiers)
                // On the header, not the Section, which would hand it to every row.
                .task { await agents.loadSubagentTiers() }
        } footer: {
            Text(SubagentSettings.tiersFooter)
        }
    }

    #if os(macOS)
    /// Wide enough for "Older · uses claude-opus-5-5": a Mac pop-up button title cannot wrap, so it would be cut.
    private static let tierWidth: CGFloat = 230
    #else
    /// A phone wraps a longer value inside this width.
    private static let tierWidth: CGFloat = 110
    #endif

    private var columnHeads: some View {
        HStack(spacing: 10) {
            #if os(iOS)
            Text(SubagentSettings.columnProvider + " / " + SubagentSettings.columnModel)
                .frame(maxWidth: .infinity, alignment: .leading)
            #else
            Text(SubagentSettings.columnProvider).frame(width: 110, alignment: .leading)
            Text(SubagentSettings.columnModel).frame(maxWidth: .infinity, alignment: .leading)
            #endif
            Text(SubagentSettings.columnTier).frame(width: Self.tierWidth, alignment: .leading)
            Text(SubagentSettings.columnPrice).frame(width: 96, alignment: .trailing)
        }
        .font(.orbitLabel)
        .foregroundStyle(.secondary)
    }

    @ViewBuilder private func row(_ provider: ProviderTierRow, _ model: ProviderModelTier) -> some View {
        #if os(iOS)
        // A phone has no room for four columns: the model runs the row's full width under the rest.
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 10) {
                Text(provider.label).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                tierCell(provider, model).frame(width: Self.tierWidth, alignment: .leading)
                priceCell(provider, model)
            }
            Text(model.model)
                .font(.orbitListSubtitle.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        #else
        HStack(spacing: 10) {
            Text(provider.label).lineLimit(1).frame(width: 110, alignment: .leading)
            Text(model.model)
                .font(.body.monospaced())
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            tierCell(provider, model).frame(width: Self.tierWidth, alignment: .leading)
            priceCell(provider, model)
        }
        #endif
    }

    private func priceCell(_ provider: ProviderTierRow, _ model: ProviderModelTier) -> some View {
        Text(SubagentSettings.priceText(model, billing: provider.billing))
            .monospacedDigit()
            .foregroundStyle(model.outputPricePerMTok == nil ? .secondary : .primary)
            .frame(width: 96, alignment: .trailing)
    }

    @ViewBuilder private func tierCell(_ provider: ProviderTierRow, _ model: ProviderModelTier) -> some View {
        HStack(spacing: 6) {
            tierControl(provider, model)
            if SubagentSettings.showsYours(model) {
                // A tier the owner set (board 2026-11-20).
                Text(SubagentSettings.yours)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.35)))
                    .fixedSize()
            }
        }
    }

    @ViewBuilder private func tierControl(_ provider: ProviderTierRow, _ model: ProviderModelTier) -> some View {
        let text = Text(SubagentSettings.modelTierText(model))
            .foregroundStyle(SubagentSettings.tierIsOlder(model) ? Color.secondary
                : SubagentSettings.tierIsUnset(model.levels) ? Color.orange : Color.primary)
            // "Older · uses <model>" is longer than the 110-point Tier column: it wraps there.
            .multilineTextAlignment(.leading)
        if let path = SubagentSettings.tierPath(provider, model) {
            Menu {
                ForEach(SubagentSettings.tiers, id: \.self) { tier in
                    Button(tier) { write(path, model.model, tier) }
                }
                if SubagentSettings.menuOffersClear(provider, model) {
                    Button(SubagentSettings.clear, role: .destructive) { write(path, model.model, nil) }
                }
            } label: {
                HStack(spacing: 3) {
                    text
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("tier.\(provider.slug).\(model.model)")
        } else {
            text
        }
    }

    private func write(_ path: String, _ model: String, _ tier: String?) {
        Task {
            if let failure = await agents.setModelTier(path: path, model: model, tier: tier) {
                app.showToast(failure, tone: .error)
            }
        }
    }
}

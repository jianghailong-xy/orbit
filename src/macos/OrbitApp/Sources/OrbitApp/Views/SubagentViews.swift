import SwiftUI
import OrbitKit

// SubAgents (docs/subagent-design.md §7, board docs/mocks/subagent/05.png, its Workflows row from board
// docs/mocks/subagent-workflow part 5): an Agent's SubAgents group, the provider list it opens, and the Quality cell
// the Model routing page draws (`ModelRoutingViews.swift`). Words and rules are OrbitKit's `SubagentSettings`.

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

// MARK: - Quality

/// A model's Quality cell (docs/subagent-design.md §7.1, board docs/mocks/model-quality/01-board.png, owner's
/// A1·B1·C1): a SubAgents line and a Tasks line, each its figure or why there is none, or "No runs yet". Who rated
/// is the SubAgents line's tooltip on the Mac, and a popover a tap opens on the phone.
struct ModelQualityCell: View {
    let quality: ModelQuality
    @State private var showsRaters = false

    #if os(iOS)
    private static let sourceWidth: CGFloat = 80
    #else
    private static let sourceWidth: CGFloat = 70
    #endif

    var body: some View {
        let lines = SubagentSettings.qualityLines(quality)
        if lines.empty {
            Text(SubagentSettings.noRunsYet).foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 1) {
                raters(line(SubagentSettings.qualitySubagents, lines.subagents), lines.raters)
                line(SubagentSettings.qualityTasks, lines.tasks)
            }
        }
    }

    private func line(_ source: String, _ line: QualityLine) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            // One line, never "Sub-/Agents": as wide as the source word at the phone's larger label size.
            Text(source)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize()
                .frame(width: Self.sourceWidth, alignment: .leading)
            Text(line.text)
                .monospacedDigit()
                .foregroundStyle(line.muted ? .secondary : .primary)
                .lineLimit(1)
        }
    }

    @ViewBuilder private func raters(_ content: some View, _ raters: String?) -> some View {
        if let raters {
            #if os(iOS)
            content
                .contentShape(Rectangle())
                .onTapGesture { showsRaters.toggle() }
                .accessibilityHint(raters)
                .popover(isPresented: $showsRaters) {
                    Text(raters)
                        .font(.orbitListSubtitle)
                        .padding(10)
                        .presentationCompactAdaptation(.popover)
                }
            #else
            content.help(raters)
            #endif
        } else {
            content
        }
    }
}

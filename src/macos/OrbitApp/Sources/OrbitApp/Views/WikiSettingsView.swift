import SwiftUI
import OrbitKit

// Wiki settings (criterion 8, mock 20): which review mode the space runs in, whether Automatic sends
// spot checks, and the space's Wiki maintenance run — pushed from the Wiki home's gear.
//
// The app's own settings form, not a new one: inset-grouped sections, a header and a footer each
// (`SettingsSheet.swift`). The sections are `WikiModeLogic.SettingsSection` in its order, which is the
// web page's (`WikiSettingsPage.tsx`); the modes are `WikiModeLogic.modes`; every word is
// `WikiModeCopy`'s. `WikiReviewModeCopyParityTests` holds both ends to that.

/// Where a press on the settings page goes.
struct WikiSettingsActions {
    var setMode: (WikiReviewMode) -> Void = { _ in }
    var setSpotChecks: (Bool) -> Void = { _ in }
    /// Set up… when maintenance is off, Edit… when it is on: the same sheet.
    var setUp: () -> Void = {}
    var turnOff: () -> Void = {}
}

/// The settings page, drawn from the space as the server kept it.
struct WikiSettingsPage: View {
    let space: WikiSpace
    /// A workspace's name and runner, by id, when this client holds the workspace.
    var workspaceLabel: (String) -> String? = { _ in nil }
    var busy = false
    var actions = WikiSettingsActions()

    private var mode: WikiReviewMode { WikiModeLogic.mode(of: space.settings) }
    private var maintenance: WikiMaintenanceSettings { space.settings?.maintenance ?? .default }

    var body: some View {
        Form {
            Section {
                Text([space.slug, space.repoUrlNorm].compactMap { $0 }.joined(separator: " · "))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
                // The space sent itself back to a mode the owner did not choose: say when and why.
                if let fallback = WikiModeLogic.modeFallback(space.settings) {
                    fallbackBanner(fallback)
                        .listRowInsets(EdgeInsets())
                }
            }
            ForEach(WikiModeLogic.SettingsSection.allCases, id: \.self) { section in
                self.section(section)
            }
        }
        .navigationTitle(WikiModeCopy.settingsTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .disabled(busy)
    }

    @ViewBuilder
    private func section(_ section: WikiModeLogic.SettingsSection) -> some View {
        switch section {
        case .reviewMode:
            Section {
                ForEach(WikiModeLogic.modes, id: \.self) { value in modeRow(value) }
                // Automatic's own switch, in the same section, and greyed while another mode is on.
                Toggle(isOn: Binding(get: { space.settings?.automaticSpotChecks == true },
                                     set: { actions.setSpotChecks($0) })) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(WikiModeCopy.spotCheck)
                        Text(WikiModeCopy.spotCheckNote)
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .disabled(mode != .automatic)
            } header: {
                Text(section.title)
            } footer: {
                (Text(WikiModeCopy.floorsLead).bold() + Text(" " + WikiModeCopy.floorsNote))
            }
        case .maintenance:
            Section {
                if maintenance.enabled {
                    LabeledContent(WikiModeCopy.status) {
                        HStack(spacing: 5) {
                            Circle().fill(.green).frame(width: 7, height: 7)
                            Text(WikiModeCopy.on)
                        }
                    }
                    LabeledContent(WikiModeCopy.workspace,
                                   value: maintenance.workspaceId.flatMap(workspaceLabel) ?? maintenance.workspaceId ?? "—")
                    LabeledContent(WikiModeCopy.provider, value: maintenance.provider)
                    LabeledContent(WikiModeCopy.dailyLimit, value: WikiModeCopy.runsADay(maintenance.dailyRunLimit))
                    LabeledContent(WikiModeCopy.lookback, value: WikiModeCopy.lookbackLabel(maintenance.lookbackDays))
                } else {
                    LabeledContent(WikiModeCopy.maintenanceName, value: WikiModeCopy.off)
                    Button(WikiModeCopy.setUp, action: actions.setUp)
                }
            } header: {
                Text(section.title)
            } footer: {
                if !maintenance.enabled { Text(WikiModeCopy.maintenanceNote) }
            }
            if maintenance.enabled {
                Section {
                    Button(WikiModeCopy.maintenanceEdit + "…", action: actions.setUp)
                    Button(WikiModeCopy.turnOff, role: .destructive, action: actions.turnOff)
                }
            }
        }
    }

    /// One mode: its name (Tiered tagged default) and its sentence, ticked on the right when it is the
    /// space's — the system's own single-choice list.
    private func modeRow(_ value: WikiReviewMode) -> some View {
        Button {
            if value != mode { actions.setMode(value) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(WikiModeCopy.modeLabel(value)).foregroundStyle(Color.primary)
                        if value == WikiModeLogic.defaultMode {
                            Text(WikiModeCopy.modeDefault).font(.orbitLabel).foregroundStyle(.secondary)
                        }
                    }
                    Text(WikiModeCopy.modeNote(value))
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                if value == mode {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(value == mode ? .isSelected : [])
    }

    private func fallbackBanner(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(text)
                .font(.orbitLabel)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(wikiAmberWash)
    }
}

/// One choice in a Set up picker: a workspace or a provider, and the words it is listed by.
struct WikiPickerOption: Identifiable, Equatable {
    let id: String
    let label: String
}

/// What Set up / Edit writes: where the runs take place, on what, how many a day, and how far back the
/// first one reads — a pick, and the days `Last … days` reads.
struct WikiMaintenanceChoice: Equatable {
    var workspaceID: String?
    var provider: String
    var dailyRunLimit: Int
    var lookback: WikiModeLogic.LookbackChoice
    var lookbackDays: Int
}

/// Set up maintenance (mock 20 ②): the workspace, the provider it is pinned to, the daily limit and the
/// look-back — then Turn on (or Save for one already on). A sheet form: Cancel on the left, the answer on
/// the right.
struct WikiMaintenanceForm: View {
    /// The workspaces it can run in, with the label each is listed by.
    let workspaces: [WikiPickerOption]
    /// The providers the server takes: configured ones on the Claude Code runtime, with their models.
    let providers: [WikiPickerOption]
    let initial: WikiMaintenanceChoice
    let enabled: Bool
    /// The write; true when it landed and the sheet can close.
    let submit: (WikiMaintenanceChoice) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var choice: WikiMaintenanceChoice
    @State private var saving = false

    init(workspaces: [WikiPickerOption], providers: [WikiPickerOption],
         initial: WikiMaintenanceChoice, enabled: Bool, submit: @escaping (WikiMaintenanceChoice) async -> Bool) {
        self.workspaces = workspaces
        self.providers = providers
        self.initial = initial
        self.enabled = enabled
        self.submit = submit
        _choice = State(initialValue: initial)
    }

    /// The providers offered: the one the space names stays listed even when it is not configured yet.
    private var providerOptions: [WikiPickerOption] {
        providers.contains { $0.id == choice.provider }
            ? providers : [WikiPickerOption(id: choice.provider, label: choice.provider)] + providers
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker(WikiModeCopy.workspace, selection: $choice.workspaceID) {
                        if choice.workspaceID == nil { Text(WikiModeCopy.noWorkspace).tag(String?.none) }
                        ForEach(workspaces) { workspace in
                            Text(workspace.label).tag(Optional(workspace.id))
                        }
                    }
                    .pickerStyle(.menu)
                } header: {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(WikiModeCopy.maintenanceNote)
                            .font(.orbitLabel)
                            .textCase(nil)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(WikiModeCopy.workspace)
                    }
                } footer: {
                    Text(WikiModeCopy.workspaceNote)
                }
                Section {
                    Picker(WikiModeCopy.provider, selection: $choice.provider) {
                        ForEach(providerOptions) { provider in
                            Text(provider.label).tag(provider.id)
                        }
                    }
                    .pickerStyle(.menu)
                } header: {
                    Text(WikiModeCopy.provider)
                } footer: {
                    Text(WikiModeCopy.providerNote)
                }
                Section {
                    Stepper(value: $choice.dailyRunLimit, in: WikiMaintenanceSettings.dailyRunLimitRange) {
                        Text(WikiModeCopy.runsADay(choice.dailyRunLimit))
                    }
                } header: {
                    Text(WikiModeCopy.dailyLimit)
                } footer: {
                    Text(WikiModeCopy.dailyLimitNote)
                }
                Section {
                    Picker(WikiModeCopy.lookback, selection: $choice.lookback) {
                        ForEach(WikiModeLogic.LookbackChoice.allCases, id: \.self) { pick in
                            Text(WikiModeCopy.lookbackLabel(WikiModeLogic.lookbackDays(pick, days: choice.lookbackDays))).tag(pick)
                        }
                    }
                    .pickerStyle(.menu)
                    if choice.lookback == .days {
                        Stepper(value: $choice.lookbackDays, in: 1...WikiMaintenanceSettings.lookbackDaysRange.upperBound) {
                            Text(WikiModeCopy.lookbackLabel(choice.lookbackDays))
                        }
                    }
                } header: {
                    Text(WikiModeCopy.lookback)
                } footer: {
                    Text(WikiModeCopy.lookbackNote)
                }
            }
            .navigationTitle(WikiModeCopy.setUpTitle)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(WikiModeCopy.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(enabled ? WikiModeCopy.save : WikiModeCopy.turnOn) {
                        saving = true
                        let chosen = choice
                        Task {
                            let landed = await submit(chosen)
                            saving = false
                            if landed { dismiss() }
                        }
                    }
                    .disabled(saving || choice.workspaceID == nil)
                }
            }
        }
    }
}

/// The screen: the space on the Wiki home, its settings page, and the Set up sheet.
struct WikiSettingsView: View {
    @Environment(AppModel.self) private var model

    @State private var settingUp = false
    @State private var notice: String?

    var body: some View {
        if let wiki = model.wiki, let space = wiki.currentSpace {
            WikiSettingsPage(space: space, workspaceLabel: { id in workspaceLabel(id) }, busy: wiki.busy,
                             actions: actions(wiki, space))
                .task { await wiki.loadSpaces() }
                .sheet(isPresented: $settingUp) {
                    let current = space.settings?.maintenance ?? .default
                    // A space names a codebase, and so does a workspace's name more often than not: the
                    // one called what the space is called is the one first offered.
                    let named = (model.agents?.items ?? []).first { $0.name == space.slug }?.id
                    WikiMaintenanceForm(workspaces: workspaces, providers: providers,
                                        initial: WikiMaintenanceChoice(workspaceID: current.workspaceId ?? named,
                                                                       provider: current.provider,
                                                                       dailyRunLimit: current.dailyRunLimit,
                                                                       lookback: WikiModeLogic.lookbackChoice(current.lookbackDays),
                                                                       lookbackDays: WikiModeLogic.lookbackDaysOffered(current.lookbackDays)),
                                        enabled: current.enabled) { choice in
                        // `.some`: all of history is sent as null, which is a value, not a key left out.
                        let answer = await wiki.updateSpace(space, WikiSpaceUpdate(maintenance: WikiMaintenanceUpdate(
                            enabled: true, workspaceId: choice.workspaceID, provider: choice.provider,
                            dailyRunLimit: choice.dailyRunLimit,
                            lookbackDays: .some(WikiModeLogic.lookbackDays(choice.lookback, days: choice.lookbackDays)))))
                        finish(answer)
                        return answer == nil
                    }
                }
                .alert(WikiCopy.settingsSaveFailed, isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
                    Button("OK", role: .cancel) { notice = nil }
                } message: {
                    Text(notice ?? "")
                }
        } else {
            ProgressView()
        }
    }

    private func actions(_ wiki: WikiModel, _ space: WikiSpace) -> WikiSettingsActions {
        WikiSettingsActions(
            setMode: { mode in Task { finish(await wiki.updateSpace(space, WikiSpaceUpdate(reviewMode: mode))) } },
            setSpotChecks: { on in Task { finish(await wiki.updateSpace(space, WikiSpaceUpdate(automaticSpotChecks: on))) } },
            setUp: { settingUp = true },
            turnOff: {
                Task { finish(await wiki.updateSpace(space, WikiSpaceUpdate(maintenance: WikiMaintenanceUpdate(enabled: false)))) }
            })
    }

    /// The owner's workspaces as the picker lists them: the name, and the runner it lives on.
    private var workspaces: [WikiPickerOption] {
        (model.agents?.items ?? []).map { agent in
            WikiPickerOption(id: agent.id,
                             label: WikiModeLogic.workspaceLabel(name: agent.name,
                                                                 runner: agent.runnerId.flatMap { model.agents?.runnerNames[$0] }))
        }
    }

    private func workspaceLabel(_ id: String) -> String? {
        workspaces.first { PublicID.storageKey($0.id) == PublicID.storageKey(id) }?.label
    }

    /// The providers the server takes for maintenance: configured ones on the Claude Code runtime.
    private var providers: [WikiPickerOption] {
        (model.agents?.configuredProviders ?? []).filter { $0.runtime == "claude" }.map { provider in
            WikiPickerOption(id: provider.slug,
                             label: WikiModeLogic.providerLabel(provider.slug,
                                                                model: provider.defaultModel ?? provider.models.first?.value))
        }
    }

    private func finish(_ answer: String?) {
        if let answer { notice = answer } else { model.showToast(WikiCopy.settingsSaved) }
    }
}

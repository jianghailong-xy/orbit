import SwiftUI
import OrbitKit

// Wiki settings (criterion 8, mock 20): which review mode the space runs in, whether Automatic sends
// spot checks, which workspaces are in the wiki (mock 38), the space's Wiki maintenance run, and deleting the wiki
// (docs/mocks/wiki-delete) — pushed from the Wiki home's gear.
//
// The app's own settings form, not a new one: inset-grouped sections, a header and a footer each
// (`SettingsSheet.swift`). The sections are `WikiModeLogic.SettingsSection` in its order, which is the
// web page's (`WikiSettingsPage.tsx`); the modes are `WikiModeLogic.modes`; every word is
// `WikiModeCopy`'s. `WikiReviewModeCopyParityTests` holds both ends to that.
//
// The server executes the wiki (mock 35 ①②), so there is no provider to pick: the workspace is where the repository
// is read from, and while `GET /wiki/system-model`'s `executor` says the server executes the account's wiki,
// maintenance names the deployment's System model, read-only with its state, and one sentence says where the wiki's
// material goes. A read that does not say so — still loading, or a control plane from before it — draws neither.
//
// The form is shared (mock 41): Set up maintenance opens from here and from the home's setup card (`WikiSetUpSheet`),
// and Create wiki is the same form with its workspaces under their repositories (`WikiCreateSheet`).

/// Where a press on the settings page goes.
struct WikiSettingsActions {
    var setMode: (WikiReviewMode) -> Void = { _ in }
    var setSpotChecks: (Bool) -> Void = { _ in }
    /// A workspace, and whether it is to be in the wiki: a row's Toggle, and Add workspace's menu.
    var setWorkspace: (String, Bool) -> Void = { _, _ in }
    /// Set up… when maintenance is off, Edit… when it is on: the same sheet.
    var setUp: () -> Void = {}
    var turnOff: () -> Void = {}
    /// Delete wiki…, which asks first.
    var delete: () -> Void = {}
}

/// The settings page, drawn from the space as the server kept it.
struct WikiSettingsPage: View {
    let space: WikiSpace
    /// Who is in the wiki and who can be added; nil until it has been read.
    var workspaces: WikiSpaceWorkspaces? = nil
    /// A workspace's name and runner, by id, when this client holds the workspace.
    var workspaceLabel: (String) -> String? = { _ in nil }
    /// The System model while the read says the server executes the account's wiki; nil otherwise.
    var server: WikiSystemModelStatus? = nil
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
        case .workspaces:
            Section {
                if let workspaces {
                    if workspaces.workspaces.isEmpty {
                        Text(WikiModeCopy.workspacesEmpty).foregroundStyle(.secondary)
                    }
                    ForEach(workspaces.workspaces) { row in workspaceRow(row) }
                    if !workspaces.addable.isEmpty { addWorkspaceMenu(workspaces.addable) }
                }
            } header: {
                Text(section.title)
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    Text(WikiModeCopy.workspacesLead)
                    Text(space.repoUrlNorm == nil ? WikiModeCopy.workspacesJoinNoRepository : WikiModeCopy.workspacesJoin)
                }
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
                    let place = maintenance.workspaceId.flatMap(workspaceLabel) ?? maintenance.workspaceId ?? "—"
                    LabeledContent(WikiModeCopy.repoFrom, value: place)
                    if let server {
                        LabeledContent(WikiModeCopy.model) { WikiModelValue(model: server) }
                    }
                    LabeledContent(WikiModeCopy.dailyLimit, value: WikiModeCopy.runsADay(maintenance.dailyRunLimit))
                    LabeledContent(WikiModeCopy.lookback, value: WikiModeCopy.lookbackLabel(maintenance.lookbackDays))
                } else {
                    LabeledContent(WikiModeCopy.maintenanceName, value: WikiModeCopy.off)
                    Button(WikiModeCopy.setUp, action: actions.setUp)
                }
            } header: {
                Text(section.title)
            } footer: {
                if server != nil {
                    VStack(alignment: .leading, spacing: 8) {
                        if !maintenance.enabled { Text(WikiModeCopy.maintenanceNoteServer) }
                        Text(WikiModeCopy.privacyNote)
                    }
                } else if !maintenance.enabled {
                    Text(WikiModeCopy.maintenanceNoteServer)
                }
            }
            if maintenance.enabled {
                Section {
                    Button(WikiModeCopy.maintenanceEdit + "…", action: actions.setUp)
                    Button(WikiModeCopy.turnOff, role: .destructive, action: actions.turnOff)
                }
            }
        case .delete:
            Section {
                Button(WikiModeCopy.deleteOpen, role: .destructive, action: actions.delete)
            } footer: {
                Text(WikiModeCopy.deleteNote)
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

    /// One workspace: its name over its machine, and the switch that says whether it is in the wiki. One left
    /// out stays on the list, greyed, and says it will not come back by itself.
    private func workspaceRow(_ row: WikiSpaceWorkspaceRow) -> some View {
        Toggle(isOn: Binding(get: { row.inWiki }, set: { actions.setWorkspace(row.id, $0) })) {
            VStack(alignment: .leading, spacing: 3) {
                Text(row.name).foregroundStyle(row.inWiki ? Color.primary : Color.secondary)
                if let runner = row.runner {
                    Text(runner).font(.orbitLabel).foregroundStyle(.secondary)
                }
                if !row.inWiki {
                    Text(WikiModeCopy.workspaceLeftOut)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// The workspaces with no repository, in the system's menu: a press adds the one picked, at once. A Button with
    /// two Texts is how a menu row gets a grey subtitle.
    private func addWorkspaceMenu(_ addable: [WikiSpaceWorkspaceRow]) -> some View {
        Menu {
            Section(WikiModeCopy.addWorkspaceGroup) {
                ForEach(addable) { row in
                    Button {
                        actions.setWorkspace(row.id, true)
                    } label: {
                        Text(row.name)
                        if let runner = row.runner { Text(runner) }
                    }
                }
            }
        } label: {
            Text(WikiModeCopy.addWorkspace)
                #if os(iOS)
                // A menu in a form takes a press on its label alone: the label is the whole row, as a Button row is.
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                #endif
        }
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

/// The System model as the settings page names it, read-only: its name over its state in its colour.
struct WikiModelValue: View {
    let model: WikiSystemModelStatus

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(WikiRunsCopy.systemModelLabel(model.model))
            WikiModelStateText(model: model).font(.orbitLabel)
        }
    }
}

/// What the form writes: where the repository is read from, how many runs a day, and how far back the first one reads —
/// a pick, and the days `Last … days` reads. `workspaceID` is the workspace picked, nil until one is.
struct WikiMaintenanceChoice: Equatable {
    var workspaceID: String?
    var dailyRunLimit: Int
    var lookback: WikiModeLogic.LookbackChoice
    var lookbackDays: Int
}

extension WikiMaintenanceChoice {
    /// The form's fields as a space's settings hold them, with no workspace picked yet.
    init(_ settings: WikiMaintenanceSettings) {
        self.init(workspaceID: nil, dailyRunLimit: settings.dailyRunLimit,
                  lookback: WikiModeLogic.lookbackChoice(settings.lookbackDays),
                  lookbackDays: WikiModeLogic.lookbackDaysOffered(settings.lookbackDays))
    }

    /// What it sends, maintenance on. `.some`: all of history is sent as null, which is a value, not a key left out.
    var maintenance: WikiMaintenanceUpdate {
        WikiMaintenanceUpdate(enabled: true, workspaceId: workspaceID, dailyRunLimit: dailyRunLimit,
                              lookbackDays: .some(WikiModeLogic.lookbackDays(lookback, days: lookbackDays)))
    }
}

/// The form of Set up maintenance and Create wiki (mock 20 ②, 35 ②, 39): the workspace the repository is read from, the
/// System model read-only, the daily limit and the look-back — then the answer. A sheet form: Cancel on the left, the
/// answer on the right; it ends on where the wiki's material goes, and a refusal stays here and says why.
struct WikiMaintenanceForm: View {
    let title: String
    /// The sentence over the fields.
    let note: String
    /// The answer: Turn on, Save or Create.
    let submitLabel: String
    /// The workspaces offered: one group with no name, or a group a repository.
    let groups: [WikiStartLogic.WorkspaceGroup]
    /// The workspace the form stands on until one is picked (`WikiStartLogic.opensOn`), which moves as the reads come in.
    let opensOn: String?
    let initial: WikiMaintenanceChoice
    /// The System model while the read says the server executes the account's wiki; nil otherwise.
    let server: WikiSystemModelStatus?
    /// The line under the picker, for the workspace it stands on.
    let workspaceNote: (WikiStartLogic.WorkspaceChoice?) -> String
    /// The write: nil once it landed and the sheet can close, else the refusal, which stays here.
    let submit: (WikiMaintenanceChoice) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var choice: WikiMaintenanceChoice
    @State private var saving = false
    @State private var refusal: String?

    init(title: String, note: String, submitLabel: String, groups: [WikiStartLogic.WorkspaceGroup], opensOn: String?,
         initial: WikiMaintenanceChoice, server: WikiSystemModelStatus? = nil,
         workspaceNote: @escaping (WikiStartLogic.WorkspaceChoice?) -> String,
         submit: @escaping (WikiMaintenanceChoice) async -> String?) {
        self.title = title
        self.note = note
        self.submitLabel = submitLabel
        self.groups = groups
        self.opensOn = opensOn
        self.initial = initial
        self.server = server
        self.workspaceNote = workspaceNote
        self.submit = submit
        _choice = State(initialValue: initial)
    }

    /// The workspace the form stands on: the one picked, else the one it opens on.
    private var chosen: String? { choice.workspaceID ?? opensOn }

    private var chosenChoice: WikiStartLogic.WorkspaceChoice? {
        groups.flatMap(\.choices).first { $0.id == chosen }
    }

    /// A workspace a row: a menu holds one line, so `offline` is said in it.
    private func options(_ choices: [WikiStartLogic.WorkspaceChoice]) -> some View {
        ForEach(choices) { workspace in
            Text(WikiStartLogic.optionLabel(workspace)).tag(Optional(workspace.id))
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker(WikiModeCopy.repoFrom, selection: Binding(get: { chosen }, set: { choice.workspaceID = $0 })) {
                        if chosen == nil { Text(WikiModeCopy.noWorkspace).tag(String?.none) }
                        ForEach(groups) { group in
                            if let repository = group.repository {
                                Section(repository) { options(group.choices) }
                            } else {
                                options(group.choices)
                            }
                        }
                    }
                    .pickerStyle(.menu)
                } header: {
                    VStack(alignment: .leading, spacing: 12) {
                        #if os(macOS)
                        // A Mac sheet draws no navigation title.
                        Text(title)
                            .font(.headline)
                            .textCase(nil)
                        #endif
                        Text(note)
                            .font(.orbitLabel)
                            .textCase(nil)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(WikiModeCopy.repoFrom)
                    }
                } footer: {
                    Text(workspaceNote(chosenChoice))
                }
                if let server {
                    // Set by the deployment: shown, never picked, and nothing here writes a provider.
                    Section {
                        LabeledContent(WikiModeCopy.model) { WikiModelValue(model: server) }
                    } header: {
                        Text(WikiModeCopy.model)
                    } footer: {
                        Text(WikiModeCopy.modelNote)
                    }
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
                    VStack(alignment: .leading, spacing: 8) {
                        Text(WikiModeCopy.lookbackNote)
                        if server != nil { Text(WikiModeCopy.privacyNote) }
                    }
                }
                if let refusal {
                    Section { Text(refusal).foregroundStyle(.red) }
                }
            }
            // A Mac form lays its rows out in columns unless told otherwise.
            .formStyle(.grouped)
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(WikiModeCopy.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(submitLabel) {
                        saving = true
                        var answer = choice
                        answer.workspaceID = chosen
                        Task {
                            refusal = await submit(answer)
                            saving = false
                            if refusal == nil { dismiss() }
                        }
                    }
                    .disabled(saving || chosen == nil)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 560)
        #endif
    }
}

/// Set up maintenance, wherever it opens: Wiki settings' Set up… and Edit…, and the first step of the home's setup card
/// (mock 41 ⑤).
///
/// THE WORKSPACES ARE THIS WIKI'S: a wiki describes one repository, so only its own are offered — the Workspaces
/// section's read — the one the reader came from picked for them when its runner is up (`WikiStartLogic.opensOn`). The
/// plan is read again after the write: turning maintenance on is what moves the card to its second step.
struct WikiSetUpSheet: View {
    @Environment(AppModel.self) private var model
    let wiki: WikiModel
    let space: WikiSpace

    var body: some View {
        let current = space.settings?.maintenance ?? .default
        let offered = WikiStartLogic.setUpOffered(model.wikiWorkspaceChoices, members: wiki.spaceWorkspaces[space.id],
                                                  current: current.workspaceId)
        WikiMaintenanceForm(title: WikiModeCopy.setUpTitle, note: WikiModeCopy.maintenanceNoteServer,
                            submitLabel: current.enabled ? WikiModeCopy.save : WikiModeCopy.turnOn,
                            groups: [WikiStartLogic.WorkspaceGroup(repository: nil, choices: offered)],
                            opensOn: WikiStartLogic.opensOn(offered, current: current.workspaceId, from: wiki.fromWorkspaceID),
                            initial: WikiMaintenanceChoice(current), server: wiki.serverModel,
                            workspaceNote: { _ in WikiModeCopy.repoFromNote }) { choice in
            let answer = await wiki.updateSpace(space, WikiSpaceUpdate(maintenance: choice.maintenance))
            if answer == nil {
                await wiki.loadPlan()
                model.showToast(WikiCopy.settingsSaved)
            }
            return answer
        }
        .task {
            await wiki.loadSystemModel()
            await wiki.loadSpaceWorkspaces(space)
        }
    }
}

/// Create wiki (mock 41 ⑨): the same form, its workspaces under their repositories. Choosing the workspace chooses the
/// repository, so there is no second field; a workspace on no repository has nothing to describe and is not offered.
/// The server makes the space, turns maintenance on and asks for the plan's first draft in the one request, which is
/// what the home then shows.
struct WikiCreateSheet: View {
    @Environment(AppModel.self) private var model
    let wiki: WikiModel

    var body: some View {
        let groups = WikiStartLogic.repositoryGroups(model.wikiWorkspaceChoices)
        let offered = groups.flatMap(\.choices)
        WikiMaintenanceForm(title: WikiStartCopy.create, note: WikiStartCopy.createNote, submitLabel: WikiStartCopy.createAnswer,
                            groups: groups, opensOn: WikiStartLogic.opensOn(offered, current: nil, from: wiki.fromWorkspaceID),
                            initial: WikiMaintenanceChoice(.default), server: wiki.serverModel,
                            workspaceNote: WikiStartLogic.createWorkspaceNote) { choice in
            let picked = offered.first { $0.id == choice.workspaceID }
            guard let request = picked.flatMap({ WikiStartLogic.createRequest($0, maintenance: choice.maintenance) }) else { return nil }
            return await wiki.createSpace(request)
        }
        .task { await wiki.loadSystemModel() }
    }
}

/// The screen: the space on the Wiki home, its settings page, and the Set up sheet.
struct WikiSettingsView: View {
    @Environment(AppModel.self) private var model

    @State private var settingUp = false
    @State private var notice: String?
    @State private var confirmingDelete = false
    /// What the delete's question counts, read with the page; nil until then, or when the read fails.
    @State private var deleteEntries: Int?
    @State private var deleteRefusal: String?

    var body: some View {
        if let wiki = model.wiki, let space = wiki.currentSpace {
            WikiSettingsPage(space: space, workspaces: wiki.spaceWorkspaces[space.id], workspaceLabel: { id in workspaceLabel(id) },
                             server: wiki.serverModel, busy: wiki.busy, actions: actions(wiki, space))
                .task {
                    await wiki.loadSpaces()
                    await wiki.loadSystemModel()
                    await wiki.loadSpaceWorkspaces(space)
                }
                .task(id: space.id) { deleteEntries = await wiki.entryCount(space) }
                .orbitConfirmation(WikiModeCopy.deleteQuestion(name(of: space, in: wiki)), isPresented: $confirmingDelete) {
                    Button(WikiModeCopy.deleteConfirm, role: .destructive) { delete(space, from: wiki) }
                    Button(WikiModeCopy.cancel, role: .cancel) {}
                } message: {
                    Text(WikiModeCopy.deleteMessage(entries: deleteEntries, documents: space.docs?.written ?? 0,
                                                    repository: space.repoUrlNorm))
                }
                .alert(WikiModeCopy.deleteFailed, isPresented: Binding(get: { deleteRefusal != nil }, set: { if !$0 { deleteRefusal = nil } })) {
                    Button("OK", role: .cancel) { deleteRefusal = nil }
                } message: {
                    Text(deleteRefusal ?? "")
                }
                .sheet(isPresented: $settingUp) { WikiSetUpSheet(wiki: wiki, space: space) }
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
            setWorkspace: { id, inWiki in Task { finish(await wiki.setWorkspace(space, workspaceID: id, inWiki: inWiki)) } },
            setUp: { settingUp = true },
            turnOff: {
                Task { finish(await wiki.updateSpace(space, WikiSpaceUpdate(maintenance: WikiMaintenanceUpdate(enabled: false)))) }
            },
            delete: { confirmingDelete = true })
    }

    private func name(of space: WikiSpace, in wiki: WikiModel) -> String {
        WikiSpaceLogic.names(wiki.spaces)[space.id] ?? space.title ?? space.slug
    }

    /// The page goes as soon as the wiki does, back to the one the Wiki opens now, or to its empty state.
    private func delete(_ space: WikiSpace, from wiki: WikiModel) {
        let said = WikiModeCopy.deleted(name(of: space, in: wiki))
        Task {
            deleteRefusal = await wiki.deleteSpace(space) {
                model.nav.pop()
                model.showToast(said)
            }
        }
    }

    private func workspaceLabel(_ id: String) -> String? {
        model.wikiWorkspaceLabel(id)
    }

    private func finish(_ answer: String?) {
        if let answer { notice = answer } else { model.showToast(WikiCopy.settingsSaved) }
    }
}

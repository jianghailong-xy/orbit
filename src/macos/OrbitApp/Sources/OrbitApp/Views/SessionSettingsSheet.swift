import SwiftUI
import OrbitKit

// A session's Settings (docs/mocks/session-settings native.html ①–④), opened from the session's ⋯
// menu (iPhone/iPad) or the window toolbar (Mac): Session, Environment, Notifications and Info in one
// grouped form, with Done, and the Variables page pushed from Environment. Every change saves at once
// (`SessionSettingsModel`); nothing the composer already offers is here.

private enum SessionSettingsRoute: Hashable { case variables }

struct SessionSettingsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let sessionID: String
    @State private var model: SessionSettingsModel
    @State private var tagging: Session?
    @State private var confirmTurnOff = false

    init(sessionID: String, api: SessionSettingsAPI) {
        self.sessionID = sessionID
        _model = State(initialValue: SessionSettingsModel(sessionID: sessionID, api: api))
    }

    /// For a sheet whose model is already filled in (the evidence probe's fixture).
    init(model: SessionSettingsModel) {
        self.sessionID = model.sessionID
        _model = State(initialValue: model)
    }

    private var session: Session? { app.session(id: sessionID) }

    var body: some View {
        NavigationStack {
            Form {
                sessionSection
                environmentSection
                notificationsSection
                infoSection
            }
            .formStyle(.grouped)
            .navigationTitle(SessionSettingsPanel.title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(SessionSettingsPanel.done) { dismiss() }
                }
            }
            .navigationDestination(for: SessionSettingsRoute.self) { _ in
                SessionVariablesPage(model: model)
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, idealWidth: 520, minHeight: 600, idealHeight: 720)
        #endif
        .task {
            model.turnRunning = session?.isGenerating ?? false
            if model.settings == nil { await model.load() }
        }
        .onChange(of: session?.isGenerating ?? false) { _, running in model.turnRunning = running }
        .sheet(item: $tagging) { session in
            SessionTagSheet(session: session)
                .environment(app)
                .task { await app.loadSessionTags() }
        }
        .alert("Couldn't save", isPresented: Binding(get: { model.saveError != nil },
                                                      set: { if !$0 { model.saveError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.saveError ?? "")
        }
    }

    // MARK: Session

    private var sessionSection: some View {
        Section(SessionSettingsPanel.sessionGroup) {
            VStack(alignment: .leading, spacing: 8) {
                Text(SessionSettingsPanel.labels)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(session?.tags ?? []) { tag in labelChip(tag) }
                        Button {
                            tagging = session
                        } label: {
                            Label(SessionSettingsPanel.addLabel, systemImage: "plus")
                                .font(.orbitLabel)
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.4),
                                                                style: StrokeStyle(lineWidth: 1, dash: [3])))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .disabled(session == nil)
                    }
                }
            }
            Toggle(isOn: Binding(get: { model.publicLinkOn }, set: { on in
                if on { Task { await model.setPublicLink(true) } } else { confirmTurnOff = true }
            })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(SessionSettingsPanel.publicLink)
                    Text(model.publicLinkOn ? SessionSettingsPanel.publicLinkLive : SessionSettingsPanel.publicLinkOff)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(model.publicLinkOn ? Color.green : Color.secondary)
                }
            }
            .orbitConfirmation(SessionSettingsPanel.turnOffTitle, isPresented: $confirmTurnOff) {
                Button(SessionSettingsPanel.turnOff, role: .destructive) { Task { await model.setPublicLink(false) } }
                Button(SessionSettingsPanel.cancel, role: .cancel) {}
            } message: {
                Text(SessionSettingsPanel.turnOffMessage)
            }
            if model.publicLinkOn, let url = publicURL {
                HStack {
                    Text(url.absoluteString)
                        .font(.orbitMono)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button(SessionSettingsPanel.copy) { copy(url.absoluteString, toast: SessionSettingsPanel.linkCopied) }
                        .buttonStyle(.borderless)
                }
            }
        }
    }

    private func labelChip(_ tag: SessionTag) -> some View {
        HStack(spacing: 4) {
            Circle().fill(Color(tagHex: tag.color)).frame(width: 7, height: 7)
            Text(tag.name).font(.orbitLabel)
            Button {
                guard let session else { return }
                app.setSessionTags(session, tagIDs: (session.tags ?? []).map(\.id).filter { $0 != tag.id })
            } label: {
                Image(systemName: "xmark").font(.orbitMeta)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(tag.name)")
        }
        .padding(.horizontal, 10).padding(.vertical, 4)
        .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.3)))
    }

    private var publicURL: URL? {
        guard let token = model.shareLink?.token, let base = app.baseURL else { return nil }
        return base.appendingPathComponent("s").appendingPathComponent(token)
    }

    // MARK: Environment

    private var environmentSection: some View {
        Section {
            if let dir = model.detail?.workspace?.workDir, !dir.isEmpty {
                LabeledContent(SessionSettingsPanel.workingDirectory) {
                    Text(dir)
                        .font(.orbitMono)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                .contextMenu { copyButton(dir) }
            }
            if model.settings != nil {
                Picker(SessionSettingsPanel.compactAt, selection: Binding(
                    get: { model.compactAt },
                    set: { size in Task { await model.setCompactAt(size) } })) {
                    ForEach(SessionSettingsPanel.compactOptions(current: model.compactAt)) { option in
                        Text(option.label).tag(option.value)
                    }
                }
                .pickerStyle(.menu)
                NavigationLink(value: SessionSettingsRoute.variables) {
                    LabeledContent(SessionSettingsPanel.variables,
                                   value: model.settings.map(SessionSettingsPanel.variablesCount) ?? "")
                }
                if model.restartBanner != nil {
                    SessionRestartBanner(model: model)
                }
            } else if let error = model.loadError {
                Text(error).foregroundStyle(.secondary)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        } header: {
            groupHeader(SessionSettingsPanel.environmentGroup, note: SessionSettingsPanel.environmentNote)
        }
    }

    // MARK: Notifications

    @ViewBuilder private var notificationsSection: some View {
        if let settings = model.settings {
            Section {
                notifyPicker(SessionSettingsPanel.whenTurnFinishes, settings.notifyTurnFinished) { value in
                    Task { await model.setNotifyTurnFinished(value) }
                }
                notifyPicker(SessionSettingsPanel.whenItNeedsYou, settings.notifyNeedsYou) { value in
                    Task { await model.setNotifyNeedsYou(value) }
                }
                Toggle(isOn: Binding(get: { settings.muted }, set: { on in Task { await model.setMuted(on) } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(SessionSettingsPanel.mute)
                        Text(SessionSettingsPanel.muteNote)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                    }
                }
            } header: {
                groupHeader(SessionSettingsPanel.notificationsGroup, note: SessionSettingsPanel.notificationsNote)
            }
        }
    }

    private func notifyPicker(_ title: String, _ value: SessionNotifyOverride,
                              set: @escaping (SessionNotifyOverride) -> Void) -> some View {
        Picker(title, selection: Binding(get: { value }, set: set)) {
            ForEach(SessionNotifyOverride.allCases, id: \.self) { option in
                Text(SessionSettingsPanel.notifyLabel(option)).tag(option)
            }
        }
        .pickerStyle(.menu)
    }

    // MARK: Info

    private var infoSection: some View {
        Section {
            let engine = session?.engine
            if let label = SessionSettingsPanel.engineLabel(engine, version: model.detail?.engineVersion) {
                LabeledContent(SessionSettingsPanel.engine, value: label)
            }
            if let runner = model.detail?.assignedRunner?.name {
                LabeledContent(SessionSettingsPanel.runner, value: runner)
            }
            if let account = accountLabel {
                LabeledContent(SessionSettingsPanel.account, value: account)
            }
            if let branch = session?.branch, !branch.isEmpty {
                LabeledContent(SessionSettingsPanel.branch) {
                    Text(branch).font(.orbitMono).lineLimit(1).truncationMode(.tail)
                }
                .contextMenu { copyButton(branch) }
            }
            if let created = SessionSettingsPanel.created(session?.createdAt) {
                LabeledContent(SessionSettingsPanel.created, value: created)
            }
            if let usage = model.detail?.usage {
                LabeledContent {
                    Text(SessionSettingsPanel.tokensTotal(usage))
                } label: {
                    Text(SessionSettingsPanel.tokens)
                    Text(SessionSettingsPanel.tokensSplit(usage))
                }
                LabeledContent {
                    Text(SessionSettingsPanel.cost(usage))
                } label: {
                    Text(SessionSettingsPanel.cost)
                    Text(SessionSettingsPanel.turns(usage))
                }
            }
            idRow(SessionSettingsPanel.sessionID, PublicID.toPublic(sessionID))
            if let runtime = session?.runtimeSessionId, !runtime.isEmpty {
                idRow(SessionSettingsPanel.engineSession, runtime, keep: 8)
            }
        } header: {
            Text(SessionSettingsPanel.infoGroup)
        } footer: {
            Text(SessionSettingsPanel.copyHint)
        }
    }

    private var accountLabel: String? {
        guard let session else { return nil }
        let engine = session.engine
        let accountID: String? = switch engine {
        case "claude": session.claudeAccount
        case "codex": session.codexAccount
        case "kimi": session.kimiAccount
        case "antigravity": session.antigravityAccount
        case "cursor": session.cursorAccount
        default: nil
        }
        let accounts = model.detail?.assignedRunner?.engines?.first { $0.engine == engine }?.accounts
        return SessionSettingsPanel.accountLabel(engine: engine, provider: session.provider, accountID: accountID,
                                                 accounts: accounts, poolLogin: session.poolCodexLogin?.email)
    }

    private func idRow(_ title: String, _ id: String, keep: Int = 12) -> some View {
        LabeledContent(title) {
            Text(SessionSettingsPanel.shortID(id, keep: keep)).font(.orbitMono)
        }
        .contentShape(Rectangle())
        .contextMenu { copyButton(id) }
    }

    private func copyButton(_ value: String) -> some View {
        Button { copy(value, toast: SessionSettingsPanel.idCopied) } label: {
            Label(SessionSettingsPanel.copyID, systemImage: "doc.on.doc")
        }
    }

    private func copy(_ value: String, toast: String) {
        PlatformPasteboard.copyString(value)
        app.showToast(toast)
    }

    private func groupHeader(_ title: String, note: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(note).textCase(nil)
        }
    }
}

/// The yellow banner a pending restart puts under Environment and on the Variables page (③): Restart
/// on an idle engine, Restart after this turn while one runs, nothing to press once it is queued.
struct SessionRestartBanner: View {
    let model: SessionSettingsModel

    var body: some View {
        if let banner = model.restartBanner {
            VStack(alignment: .leading, spacing: 6) {
                Text(banner.title).fontWeight(.semibold)
                Text(banner.body).font(.orbitSubtext)
                if let button = banner.button {
                    Button {
                        Task { await model.restart() }
                    } label: {
                        Text(button).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.restarting)
                    .padding(.top, 4)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.yellow.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.yellow.opacity(0.45)))
        }
    }
}

/// Variables (③): the session's own, editable — tap to edit, swipe left (or right-click) to delete,
/// Add — then the restart banner, then the workspace's, grey and read-only.
struct SessionVariablesPage: View {
    let model: SessionSettingsModel
    @State private var editing: VariableEdit?

    var body: some View {
        let settings = model.settings ?? SessionSettingsValues()
        List {
            Section(SessionSettingsPanel.thisSession) {
                let rows = SessionSettingsPanel.sessionRows(settings)
                if rows.isEmpty {
                    Text(SessionSettingsPanel.noSessionVariables).foregroundStyle(.secondary)
                }
                ForEach(rows) { row in
                    Button { editing = VariableEdit(original: row.key, value: row.value) } label: {
                        variableRow(row, dim: false)
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button(role: .destructive) { Task { await model.removeVariable(row.key) } } label: {
                            Label(SessionSettingsPanel.delete, systemImage: "trash")
                        }
                    }
                }
                .onDelete { offsets in
                    let keys = offsets.map { rows[$0].key }
                    Task { for key in keys { await model.removeVariable(key) } }
                }
            }
            if model.restartBanner != nil {
                Section { SessionRestartBanner(model: model) }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            Section {
                ForEach(SessionSettingsPanel.workspaceRows(settings)) { row in
                    variableRow(row, dim: true)
                }
            } header: {
                Text(SessionSettingsPanel.fromWorkspace)
            } footer: {
                Text(SessionSettingsPanel.variablesFootnote)
            }
        }
        #if os(macOS)
        .listStyle(.inset)
        #else
        .listStyle(.insetGrouped)
        #endif
        .navigationTitle(SessionSettingsPanel.variables)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(SessionSettingsPanel.addVariable) { editing = VariableEdit(original: nil, value: "") }
            }
        }
        .sheet(item: $editing) { edit in
            SessionVariableEditor(model: model, edit: edit)
        }
    }

    private func variableRow(_ row: SessionSettingsPanel.VariableRow, dim: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.key).font(.orbitMono).foregroundStyle(dim ? .secondary : .primary)
                Text(row.replaced ? SessionSettingsPanel.replacedByThisSession : row.value)
                    .font(.orbitMonoFine)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            if !dim, model.changedKeys.contains(row.key), model.settings?.envPendingRestart == true {
                Circle().fill(Color.orange).frame(width: 7, height: 7)
                    .accessibilityLabel("Waiting for a restart")
            }
        }
        .contentShape(Rectangle())
    }
}

struct VariableEdit: Identifiable {
    /// The name being edited; nil adds a new one.
    let original: String?
    let value: String
    var id: String { original ?? "__new__" }
}

private struct SessionVariableEditor: View {
    let model: SessionSettingsModel
    let edit: VariableEdit
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var value: String

    init(model: SessionSettingsModel, edit: VariableEdit) {
        self.model = model
        self.edit = edit
        _name = State(initialValue: edit.original ?? "")
        _value = State(initialValue: edit.value)
    }

    private var problem: String? { SessionSettingsPanel.nameProblem(name) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(SessionSettingsPanel.name, text: $name)
                        .font(.orbitMono)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.characters)
                        #endif
                    TextField(SessionSettingsPanel.value, text: $value, axis: .vertical)
                        .font(.orbitMono)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                } footer: {
                    if !name.isEmpty, let problem { Text(problem).foregroundStyle(.red) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(edit.original == nil ? SessionSettingsPanel.newVariable : SessionSettingsPanel.editVariable)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(SessionSettingsPanel.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(SessionSettingsPanel.save) {
                        Task {
                            await model.setVariable(name, value: value, replacing: edit.original)
                            dismiss()
                        }
                    }
                    .disabled(problem != nil)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 380, minHeight: 220)
        #else
        .presentationDetents([.medium])
        #endif
    }
}

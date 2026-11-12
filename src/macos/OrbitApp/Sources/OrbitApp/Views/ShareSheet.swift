import SwiftUI
import OrbitKit

/// The one Share panel — a session's, a task's and a project's alike: web's `ShareModal` as the
/// contract draws it for the apps (docs/share-links-design.md §8; docs/mocks/share-links/07-mobile ③).
/// From the top: Access (Only you / Anyone with the link), the public link with Copy Link and Share
/// Link…, the layers the link includes with how much each holds, the Live line, Expires, and how
/// often it was opened. Every change is saved as it is made — Done only closes — and turning the link
/// off asks first, since whoever has it loses it at once. The same view on iOS and macOS, presented
/// as a sheet: from the session's nav bar or window toolbar, and from the task's and the project's ⋯
/// menus.
///
/// A session's panel, given where and how the agent runs a guest's message (`guests`), also carries
/// People who can reply (docs/session-guests-design.md §3): under Access, or under the link's sections
/// while one is open, as web's `ShareModal` places it.
///
/// What it says and what each press sends is `SharePanel` (OrbitKit), where it is tested; this view
/// draws it and runs the requests, with a fresh `APIClient` built from the app's baseURL + tokenStore
/// (as `ConsoleModel` does). `onChange` hands every read and save back to whoever opened it, so a
/// menu's "Live link" follows what was done here without asking the server again.
struct ShareSheet: View {
    let kind: ShareRootKind
    let rootID: String
    let baseURL: URL
    let tokenStore: TokenStore
    var onChange: (ShareLinkRead) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss

    @State private var panel: SharePanel
    @State private var busy = false
    @State private var confirmingTurnOff = false
    @State private var copied = false
    @State private var errorText: String?
    @State private var people: SessionGuestsPanel?
    @State private var removing = false

    init(kind: ShareRootKind, rootID: String, baseURL: URL, tokenStore: TokenStore,
         guests: SessionGuestContext? = nil,
         onChange: @escaping (ShareLinkRead) -> Void = { _ in }) {
        self.kind = kind
        self.rootID = rootID
        self.baseURL = baseURL
        self.tokenStore = tokenStore
        self.onChange = onChange
        _panel = State(initialValue: SharePanel(kind: kind, invitesPeople: guests != nil))
        _people = State(initialValue: kind == .session ? guests.map(SessionGuestsPanel.init(context:)) : nil)
    }

    private var api: APIClient { APIClient(baseURL: baseURL, tokenStore: tokenStore) }

    var body: some View {
        NavigationStack {
            Form {
                switch panel.phase {
                case .loading:
                    HStack { Spacer(); ProgressView(); Spacer() }
                case .failed(let reason):
                    Section {
                        Text(SharePanelCopy.couldNotLoad + " " + reason)
                        Button(SharePanelCopy.retry) { Task { await load() } }
                    }
                case .ready:
                    accessSection
                    if let url = panel.publicURL(base: baseURL) {
                        linkSection(url)
                        includesSection
                        updatesSection
                    }
                    if people != nil { peopleSection }
                }
                if let errorText {
                    Section { Text(errorText).font(.footnote).foregroundStyle(.red) }
                }
            }
            // A Mac form lays its rows out in columns unless told otherwise; grouped reads as the
            // phone's sections do (and is already the phone's default).
            .formStyle(.grouped)
            .navigationTitle(panel.title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                #if os(iOS)
                ToolbarItem(placement: .topBarTrailing) {
                    Button(SharePanelCopy.done) { dismiss() }
                }
                #else
                ToolbarItem(placement: .confirmationAction) {
                    Button(SharePanelCopy.done) { dismiss() }
                }
                #endif
            }
        }
        .task { await load() }
        .task { await loadPeople() }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 560)
        #endif
    }

    // MARK: the sections, top to bottom

    /// Choosing Only you while a link is open does not turn it off: it asks, and the picker keeps
    /// showing the link as it is until the answer is yes.
    private var accessSection: some View {
        Section {
            Picker(selection: Binding(get: { panel.access }, set: { choose($0) })) {
                ForEach(SharePanel.Access.allCases) { access in
                    Text(access.label).tag(access)
                }
            } label: {
                Label(SharePanelCopy.access, systemImage: panel.access == .onlyYou ? "lock" : "globe")
            }
            .disabled(busy)
            // On the picker that asks, so the panel opens against it rather than at the top of the
            // form.
            .orbitConfirmation(SharePanelCopy.turnOffTitle, isPresented: $confirmingTurnOff) {
                Button(SharePanelCopy.turnOff, role: .destructive) { Task { await turnOff() } }
                Button(SharePanelCopy.cancel, role: .cancel) {}
            } message: {
                Text(SharePanelCopy.turnOffDetail)
            }
        } footer: {
            Text(panel.accessDetail)
        }
    }

    private func linkSection(_ url: URL) -> some View {
        Section {
            Text(url.absoluteString)
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .textSelection(.enabled)
            Button {
                PlatformPasteboard.copyString(url.absoluteString)
                PlatformHaptics.success()
                copied = true
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    copied = false
                }
            } label: {
                Label(copied ? SharePanelCopy.copied : SharePanelCopy.copyLink,
                      systemImage: copied ? "checkmark" : "link")
            }
            ShareLink(item: url) {
                Label(SharePanelCopy.shareLink, systemImage: "square.and.arrow.up")
            }
        }
    }

    /// One switch per layer, with what it is and how much it holds. The root's own content is always
    /// on; a layer under Task pages sits indented beneath it and cannot be pressed while it is off.
    private var includesSection: some View {
        Section {
            ForEach(panel.layers) { row in
                Toggle(isOn: Binding(get: { row.isOn }, set: { on in toggle(row, on: on) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.name)
                        Text(row.detail)
                            .font(.footnote)
                            .foregroundStyle(row.warns ? Color.orange : Color.secondary)
                        if let count = row.count {
                            Text(count).font(.footnote).monospacedDigit().foregroundStyle(.secondary)
                        }
                    }
                    .padding(.leading, row.isNested ? 16 : 0)
                }
                .disabled(!row.isEditable || busy)
            }
        } header: {
            Text(SharePanelCopy.includes)
        }
    }

    /// Live, said as the fact it is (§2), then Expires; under them how long the link has left and
    /// how often it was opened.
    private var updatesSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 2) {
                Text(SharePanelCopy.updates)
                HStack(spacing: 6) {
                    Circle().fill(Color.green).frame(width: 7, height: 7)
                    Text(SharePanelCopy.live)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            Picker(SharePanelCopy.expires, selection: Binding(get: { panel.expirySelection },
                                                             set: { chooseExpiry($0) })) {
                ForEach(panel.expiryOptions) { option in
                    Text(option.label).tag(option.value)
                }
            }
            .disabled(busy)
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if let hint = panel.expiryHint { Text(hint) }
                if let views = panel.viewsLine(now: Date()) { Text(views) }
            }
        }
    }

    /// People who can reply: the email and Invite, one row per guest, then what inviting means — in
    /// amber in a mode that does not ask, with the tick the first invite there needs.
    @ViewBuilder
    private var peopleSection: some View {
        if let people {
            Section {
                HStack(spacing: 8) {
                    TextField(SessionGuestsCopy.emailPlaceholder,
                              text: Binding(get: { people.email }, set: { self.people?.editEmail($0) }))
                        .textContentType(.emailAddress)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        #endif
                        .onSubmit { Task { await invite() } }
                    Button(SessionGuestsCopy.invite) { Task { await invite() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!people.canInvite)
                }
                if let error = people.error {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
                ForEach(people.guests ?? []) { guest in
                    HStack(spacing: 10) {
                        Text(String(guest.name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.white)
                            .frame(width: 28, height: 28)
                            .background(Circle().fill(Color.accentColor))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(guest.name)
                            Text(guest.email).font(.footnote).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 6)
                        Text(SessionGuestsCopy.activity(guest))
                            .font(.footnote).monospacedDigit().foregroundStyle(.secondary)
                        Button(SessionGuestsCopy.remove) { Task { await remove(guest) } }
                            .buttonStyle(.bordered)
                            .disabled(removing)
                            .accessibilityLabel(SessionGuestsCopy.remove + " " + guest.name)
                    }
                }
                if people.needsAcknowledge {
                    Toggle(SessionGuestsCopy.acknowledge,
                           isOn: Binding(get: { people.acknowledged }, set: { self.people?.acknowledged = $0 }))
                        #if os(macOS)
                        .toggleStyle(.checkbox)
                        #endif
                }
            } header: {
                Text(SessionGuestsCopy.peopleWhoCanReply)
            } footer: {
                Text(people.consequence.text)
                    .foregroundStyle(people.consequence.warns ? Color.orange : Color.secondary)
            }
        }
    }

    // MARK: presses

    private func choose(_ access: SharePanel.Access) {
        switch panel.step(to: access) {
        case .open(let request): Task { await save(request) }
        case .confirmTurnOff: confirmingTurnOff = true
        case .nothing: break
        }
    }

    private func toggle(_ row: ShareLayerRow, on: Bool) {
        guard let layer = row.layer else { return }
        let request = panel.toggle(layer, on: on)
        Task { await save(request) }
    }

    private func chooseExpiry(_ value: String) {
        guard let request = panel.chooseExpiry(value, now: Date()) else { return }
        Task { await save(request) }
    }

    // MARK: the server

    @MainActor
    private func load() async {
        errorText = nil
        do {
            let read = try await api.shareLink(kind, rootID)
            panel.loaded(read)
            onChange(read)
        } catch {
            panel.loadFailed(APIClient.failureReason(error))
        }
    }

    @MainActor
    private func loadPeople() async {
        guard people != nil else { return }
        do {
            people?.loaded(try await api.sessionGuests(rootID))
        } catch {
            errorText = APIClient.failureReason(error)
        }
    }

    @MainActor
    private func invite() async {
        guard let email = people?.beginInvite() else { return }
        do {
            people?.invited(try await api.inviteSessionGuest(rootID, email: email))
        } catch {
            people?.inviteFailed(APIClient.failureReason(error))
        }
    }

    @MainActor
    private func remove(_ guest: SessionGuestPerson) async {
        removing = true
        errorText = nil
        do {
            people?.loaded(try await api.removeSessionGuest(rootID, userID: guest.userId))
        } catch {
            errorText = SessionGuestsCopy.couldNotRemove + ": " + APIClient.failureReason(error)
        }
        removing = false
    }

    @MainActor
    private func save(_ request: PutShareLinkRequest) async {
        busy = true
        errorText = nil
        do {
            let link = try await api.putShareLink(kind, rootID, request)
            panel.saved(link)
            onChange(ShareLinkRead(link: link, counts: panel.counts))
        } catch {
            panel.saveFailed()
            errorText = APIClient.failureReason(error)
        }
        busy = false
    }

    @MainActor
    private func turnOff() async {
        busy = true
        errorText = nil
        do {
            try await api.turnOffShareLink(kind, rootID)
            panel.turnedOff()
            copied = false
            onChange(ShareLinkRead(link: nil, counts: panel.counts))
        } catch {
            errorText = APIClient.failureReason(error)
        }
        busy = false
    }
}

extension SessionGuestContext {
    /// Where and how the agent runs a guest's message in this session, for People who can reply: the
    /// machine its page names, else its runner's or its workspace's label, and its permission mode.
    @MainActor
    static func of(_ session: Session, agents: AgentsModel?) -> SessionGuestContext {
        let workspace = session.agent?.id ?? session.agentId
        let runnerID = session.assignedRunnerId ?? workspace.flatMap { agents?.agent($0)?.runnerId }
        let name = agents?.machineName(for: session) ?? agents?.runnerLabel(runnerID) ?? runnerID ?? "Shared"
        return SessionGuestContext(runnerName: name, permissionMode: session.permissionMode)
    }
}

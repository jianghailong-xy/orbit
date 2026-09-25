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

    init(kind: ShareRootKind, rootID: String, baseURL: URL, tokenStore: TokenStore,
         onChange: @escaping (ShareLinkRead) -> Void = { _ in }) {
        self.kind = kind
        self.rootID = rootID
        self.baseURL = baseURL
        self.tokenStore = tokenStore
        self.onChange = onChange
        _panel = State(initialValue: SharePanel(kind: kind))
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
        .confirmationDialog(SharePanelCopy.turnOffTitle, isPresented: $confirmingTurnOff,
                            titleVisibility: .visible) {
            Button(SharePanelCopy.turnOff, role: .destructive) { Task { await turnOff() } }
            Button(SharePanelCopy.cancel, role: .cancel) {}
        } message: {
            Text(SharePanelCopy.turnOffDetail)
        }
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
